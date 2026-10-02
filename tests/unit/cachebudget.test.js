'use strict';

/**
 * WARM UNCACHED INPUT: the budgeter and the ledger (2026-09-24).
 *
 *   uncached_ratio = uncached / total      target ≤ 5 %, normal ceiling ≤ 8 %
 *
 * These pin the arithmetic (per protocol, "not reported" is never zero), the
 * warm / cold / epoch-reset classification, the epoch advancing only when the
 * stable prefix really changed, deterministic reduction of the actual owners
 * over 8 %, an explicit exception for required evidence, and bounded tool
 * results that keep the raw output recoverable.
 */

const assert = require('assert');
const fs = require('fs');
const { test, tmpdir } = require('../helpers');

process.env.LAIN_CONFIG_DIR = process.env.LAIN_CONFIG_DIR || tmpdir('lain-cache-home-');
const cb = require('../../src/cachebudget');
const cl = require('../../src/cacheledger');
const tb = require('../../src/toolbudget');

const PC = { model: 'm', connectionId: 'c', protocol: 'responses' };
const TOOLS = [{ name: 'read_file', description: 'read a file', parameters: { type: 'object' } }, { name: 'grep', description: 'search', parameters: { type: 'object' } }];
const SYS = `You are LAIN.\n\n# This project\n${'stable project knowledge. '.repeat(800)}`;
const live = (extra = '') => ({ role: 'user', content: `<lain-context>\n# This request\nguidance\n\n# Grounding\nexisting project${extra}\n</lain-context>`, _live: true });
function wire(msgs, tail = '') { return [{ role: 'system', content: SYS }, ...msgs, live(tail)]; }

module.exports = async function run() {
  await test('LEDGER: the ratio per protocol — anthropic input excludes cache, responses/chat include it; unreported is null, not zero', () => {
    const a = cl.normalize({ inputTokens: 300, cacheReadTokens: 9000, cacheCreationTokens: 200, outputTokens: 50, cacheReported: true }, 'anthropic');
    assert.deepStrictEqual([a.total, a.cached, a.uncached], [9500, 9000, 500]);
    const o = cl.normalize({ inputTokens: 9500, cacheReadTokens: 9000, outputTokens: 50, cacheReported: true }, 'responses');
    assert.deepStrictEqual([o.total, o.cached, o.uncached], [9500, 9000, 500]);
    assert.strictEqual(+cl.ratio(o).toFixed(4), 0.0526);
    const u = cl.normalize({ inputTokens: 9500, outputTokens: 50 }, 'chat');
    assert.deepStrictEqual([u.reported, u.cached, u.uncached], [false, null, null], 'a receipt with no cache field is NOT REPORTED');
    assert.strictEqual(cl.ratio(u), null);
  });

  await test('BUDGETER: the first request is COLD, never a warm failure; an appended step is WARM with ratio = new bytes / total', () => {
    const session = {};
    const w1 = wire([{ role: 'user', content: 'what does fixButton return?' }]);
    const p1 = cb.plan(session, PC, w1, TOOLS);
    assert.strictEqual(p1.warmth, 'COLD'); assert.match(p1.epochReason, /first request/);
    cb.commit(session, p1);
    const w2 = wire([{ role: 'user', content: 'what does fixButton return?' }, { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 't1', name: 'read_file', arguments: '{"path":"a.js"}' }] }, { role: 'tool', tool_call_id: 't1', content: 'function fixButton() { return 1; }' }]);
    const p2 = cb.plan(session, PC, w2, TOOLS);
    assert.strictEqual(p2.warmth, 'WARM');
    assert.strictEqual(p2.epoch, p1.epoch, 'same epoch');
    const { s: a } = cb.serialize(w1, TOOLS); const { s: b } = cb.serialize(w2, TOOLS);
    const shared = cb.lcp(a, b);
    assert.strictEqual(p2.cachedChars, shared);
    assert.strictEqual(p2.ratio, +((b.length - shared) / b.length).toFixed(4));
    assert.ok(p2.ratio < 0.05, `a small step on a ~20k-char prefix is under target: ${p2.ratio}`);
    assert.strictEqual(p2.status, 'SEND');
    assert.deepStrictEqual(p2.owners.map((o) => o.owner).sort(), ['assistant', 'live', 'live:# Grounding', 'live:# This request', 'tool:read_file'].sort());
    // The ledger keeps cold apart from warm.
    const rows = [cl.settle({}, p1, { inputTokens: 5000, cacheReadTokens: 0, cacheReported: true }, PC), cl.settle({}, p2, { inputTokens: 5100, cacheReadTokens: 4900, cacheReported: true }, PC)];
    const s = cl.summary(rows);
    assert.deepStrictEqual([s.cold, s.warm], [1, 1]);
    assert.strictEqual(+s.median.toFixed(4), +(200 / 5100).toFixed(4));
  });

  await test('EPOCH: unchanged across ordinary turns; advances once, with the reason, on a tool-surface change or a history rewrite; then stable again', () => {
    const session = {};
    const msgs = [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }];
    let p = cb.plan(session, PC, wire(msgs), TOOLS); cb.commit(session, p);
    const e0 = p.epoch;
    msgs.push({ role: 'user', content: 'q2' });
    p = cb.plan(session, PC, wire(msgs), TOOLS); cb.commit(session, p);
    assert.deepStrictEqual([p.warmth, p.epoch], ['WARM', e0], 'an ordinary turn stays in the epoch');
    const more = [...TOOLS, { name: 'migration_plan', description: 'plan a migration', parameters: { type: 'object' } }];
    p = cb.plan(session, PC, wire(msgs), more); cb.commit(session, p);
    assert.deepStrictEqual([p.warmth, p.epoch], ['EPOCH_RESET', e0 + 1]);
    assert.match(p.epochReason, /tool surface changed \+migration_plan/);
    p = cb.plan(session, PC, wire(msgs), more); cb.commit(session, p);
    assert.deepStrictEqual([p.warmth, p.epoch], ['WARM', e0 + 1], 'then stable again');
    msgs[1] = { role: 'assistant', content: '[compacted]' };
    p = cb.plan(session, PC, wire(msgs), more); cb.commit(session, p);
    assert.deepStrictEqual([p.warmth, p.epoch], ['EPOCH_RESET', e0 + 2]);
    assert.match(p.epochReason, /history rewritten/);
    const sysChanged = [{ role: 'system', content: `${SYS}\n\n# Goal\nnew goal` }, ...msgs, live()];
    p = cb.plan(session, PC, sysChanged, more); cb.commit(session, p);
    assert.match(p.epochReason, /system prompt changed/);
    // The volatile tail changing is NOT an epoch change.
    p = cb.plan(session, PC, [{ role: 'system', content: `${SYS}\n\n# Goal\nnew goal` }, ...msgs, live('\nsomething new')], more);
    assert.strictEqual(p.warmth, 'WARM');
  });

  await test('CACHE-AWARE FOLD: a repeat already sent in this lineage is never rewritten (that would reset the epoch); a cold lineage still folds it', () => {
    const { foldRepeats } = require('../../src/intent');
    const msgs = [{ role: 'user', content: 'what does SearchBar do in this project?' }, { role: 'assistant', content: 'a' },
      { role: 'user', content: 'again: what does SearchBar do in this project?' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'which file calls fetchResults?' }];
    assert.match(foldRepeats(msgs)[2].content, /^<lain-context>/, 'cold: the repeat is folded for a new reader');
    const sent = new WeakSet(msgs.slice(0, 4));
    assert.strictEqual(foldRepeats(msgs, { frozen: sent })[2], msgs[2], 'warm: the bytes already sent stay exactly as sent');
  });

  await test('OVER 8 %: Core cuts the OPTIONAL owners (git status, the IDE snapshot) to their floors; required guidance is untouched', () => {
    const session = {};
    const msgs = [{ role: 'user', content: 'q1' }];
    cb.commit(session, cb.plan(session, PC, wire(msgs), TOOLS));
    const git = `\n\n# Working tree (git)\n${'M src/file.js\n'.repeat(900)}`;
    const text = `# This request\nguidance that must stay\n\n# Grounding\nexisting${git}`;
    const w = [{ role: 'system', content: SYS }, ...msgs, { role: 'user', content: `<lain-context>\n${text}\n</lain-context>`, _live: true }];
    const p = cb.plan(session, PC, w, TOOLS);
    assert.strictEqual(p.status, 'OVER', `${p.ratio}`);
    assert.strictEqual(p.owners[0].owner, 'live:# Working tree (git)', 'the owner is named');
    const r = cb.reduceLive(text, p);
    assert.deepStrictEqual(r.reductions.map((x) => x.owner), ['# Working tree (git)']);
    assert.match(r.live, /guidance that must stay/);
    assert.match(r.live, /held back by Core's context budget .* run git status for the rest/);
    const w2 = [{ role: 'system', content: SYS }, ...msgs, { role: 'user', content: `<lain-context>\n${r.live}\n</lain-context>`, _live: true }];
    const p2 = cb.plan(session, PC, w2, TOOLS);
    assert.ok(p2.ratio <= 0.08, `reduced under the ceiling: ${p2.ratio}`);
  });

  await test('REQUIRED EVIDENCE MAY EXCEED THE BUDGET: nothing optional to cut → an explicit exception naming the owner', () => {
    const session = {};
    const msgs = [{ role: 'user', content: 'read the big file' }];
    cb.commit(session, cb.plan(session, PC, wire(msgs), TOOLS));
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 't', name: 'read_file', arguments: '{}' }] }, { role: 'tool', tool_call_id: 't', content: 'x'.repeat(20000) });
    const p = cb.plan(session, PC, wire(msgs), TOOLS);
    assert.strictEqual(p.status, 'OVER');
    const r = cb.reduceLive('# This request\nguidance', p);
    assert.strictEqual(r.reductions.length, 0, 'tool evidence and required guidance are never cut here');
    const e = cb.exception(p);
    assert.match(e.reason, /new evidence the task requires/);
    assert.strictEqual(e.owners[0].owner, 'tool:read_file');
    const row = cl.settle({}, { ...p, exception: e }, { inputTokens: 9000, cacheReadTokens: 4000, cacheReported: true }, PC);
    const s = cl.summary([row]);
    assert.strictEqual(s.exceptions.length, 1);
    assert.strictEqual(s.worstNormal, null, 'a justified exception is not a normal request');
  });

  await test('TOOL OUTPUT BUDGET: a whole-file read over the ceiling keeps its head and says how to page; an explicit range and an error are kept; raw output is recoverable', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const out = tb.bound('read_file', { path: 'big.js' }, { output: big });
    assert.ok(out.length < 26000, `${out.length}`);
    assert.match(out, /LAIN context budget: \d+ of \d+ chars shown · read_file with offset:\d+ and limit for the next part · full output kept as tr_[0-9a-f]{10}/);
    const id = /tr_[0-9a-f]{10}/.exec(out)[0];
    assert.strictEqual(fs.readFileSync(require('path').join(tb.dir(), `${id}.txt`), 'utf8'), big, 'the raw evidence is recoverable byte for byte');
    const range = big.slice(0, 60000);
    assert.strictEqual(tb.bound('read_file', { path: 'big.js', offset: 1, limit: 2100 }, { output: range }), range, 'an explicit range is what the model asked for (under the hard cap)');
    assert.match(tb.bound('read_file', { path: 'big.js', offset: 1, limit: 3000 }, { output: big }), /LAIN context budget/, 'above the hard cap even a range is bounded');
    assert.strictEqual(tb.bound('run_tests', {}, { output: big, isError: true }), big, 'a failure is never cut');
    const shell = tb.bound('run_bash', {}, { output: `${big}\nFINAL SUMMARY: 3 failed` });
    assert.match(shell, /FINAL SUMMARY: 3 failed/, 'the tail (where summaries live) is kept');
    assert.strictEqual(tb.bound('grep', {}, { output: 'a\nb' }), 'a\nb', 'small results are untouched');
  });
};
