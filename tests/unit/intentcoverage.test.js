'use strict';

/**
 * 2026-09-18 steer — execution hygiene, reproduced before fixing:
 *
 *   §21  repeated requests after rate limits / model switches become ONE
 *        current intent (+ the new constraint, + a correction wins); history kept
 *   §22  a large whole read that cannot fit (or was elided) is NARROWED, the
 *        next read is targeted, no giant-read loop, coverage recorded
 *   §23  the recoverable blockage is reported once, and work continues
 *   §12  zero files searched is not "does not exist"
 *   §16  working narration never becomes handover state
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');
const intent = require('../../src/intent');
const { Session } = require('../../src/session');

const HISTORY = [
  'Fix two router bugs: 1. cross-provider rate-limit bleed 2. slow refresh-all. Do not touch LAIN.',
  'continue',
  'fix the router rate limit bug and the slow refresh all, do not touch lain',
  'continue the two bugs',
  'continue and if there is blockage or reproduction, tell me where it comes from',
];

module.exports = async function () {
  await test('§21 INTENT: five near-identical asks become ONE intent plus the one new constraint', () => {
    const e = intent.effective(HISTORY[0], HISTORY.slice(1));
    const r = intent.render(e);
    assert.strictEqual(e.constraints.length, 1, r);
    assert.match(e.constraints[0], /blockage or reproduction, tell me where it comes from/);
    assert.strictEqual(e.collapsed, 3);
    assert.strictEqual((r.match(/rate.limit/gi) || []).length, 1, 'the request appears once, not five times');
  });

  await test('§21 INTENT: a correction is never collapsed, and the later one wins', () => {
    const e = intent.effective(HISTORY[0], [...HISTORY.slice(1), 'actually, do touch lain if the bug is in lain']);
    assert.match(e.constraints[e.constraints.length - 1], /do touch lain.*correction/);
    assert.match(intent.render(e), /later one wins/);
  });

  await test('§21 HANDOVER: a model switch after rate limits hands over ONE current intent; history stays intact', () => {
    const root = tmpdir('intent-ho-');
    const s = new Session({ cwd: root });
    s.task = new (require('../../src/task').Task)(HISTORY[0]);
    s.turns = HISTORY.map((u, i) => ({ userInput: u, stopReason: i < 4 ? 'rate-limited' : 'end', text: '', actions: [], narration: [], model: i % 2 ? 'glm-5' : 'gpt-5.5' }));
    for (const u of HISTORY) s.messages.push({ role: 'user', content: u });
    const packet = require('../../src/handover').build(s, { cwd: root, toModel: 'qwen3', runtime: { reason: 'HANDOVER_PENDING' } }) || '';
    const fromIntent = require('../../src/intent').render(require('../../src/intent').effective(HISTORY[0], HISTORY.slice(1)));
    assert.ok(fromIntent.includes('CURRENT INTENT'));
    if (packet) {
      assert.ok(!/The user has since said/.test(packet), 'no verbatim stack of instructions');
      assert.ok((packet.match(/slow refresh.all/gi) || []).length <= 1, packet);
    }
    const wire = require('../../src/intent').foldRepeats(s.messages);
    assert.strictEqual(wire[0].content, HISTORY[0], 'the objective is never touched');
    assert.strictEqual(wire[wire.length - 1].content, HISTORY[4], 'the latest request is never touched');
    assert.ok(/<lain-context>/.test(wire[2].content), 'an earlier repeat is sent as a framed pointer');
    assert.strictEqual(s.messages[2].content, HISTORY[2], 'history itself is unchanged');
  });

  await test('§16 HANDOVER: working narration is not durable state', () => {
    assert.strictEqual(intent.durable('The steer is clear. Back on the two router bugs.'), '');
    assert.strictEqual(intent.durable('One last read of the region. Locks are scoped by provider_id + quota_family.'), 'Locks are scoped by provider_id + quota_family.');
  });

  await test('§22/§23 READ: a whole read that cannot fit is NARROWED to outline + window; blockage once; the targeted read then succeeds; ranges are recorded', async () => {
    const root = tmpdir('cover-');
    const big = [];
    for (let i = 0; i < 6000; i++) big.push(i % 400 === 0 ? `export function handler${i}(req, res) { return route(req, res, ${i}); }` : `const pad${i} = '${'x'.repeat(40)}';`);
    fs.writeFileSync(path.join(root, 'server.ts'), big.join('\n'));
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('cov-s-'), [
      { text: '', tool_calls: [{ name: 'read_file', input: { path: 'server.ts' } }] },
      { text: '', tool_calls: [{ name: 'read_file', input: { path: 'server.ts' } }] },
      { text: '', tool_calls: [{ name: 'read_file', input: { path: 'server.ts', offset: 1200, limit: 60 } }] },
      { text: 'Found handler1200 at server.ts:1201.' },
    ]);
    const mock = require('../../src/mockprovider'); mock._reset();
    const s = new Session({ cwd: root });
    const said = [];
    const app = { cfg: {}, session: s, transient: (lvl, m) => said.push(m) };
    const events = [];
    try {
      for await (const ev of require('../../src/turn').runTurn(s, 'find the handler at line 1200', { cfg: {}, app, systemPrompt: 's', live: '', evidence: s.evidence, lifecycle: s.lifecycle })) events.push(ev);
    } finally { delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; mock._reset(); }
    const results = events.filter((e) => e.type === 'tool_result').map((e) => String(e.output));
    assert.match(results[0], /^BLOCKAGE · server\.ts: a whole read \(6000 lines/);
    assert.match(results[0], /ADAPTED · narrowed to its outline and lines 1–\d+/);
    assert.match(results[0], /OUTLINE[\s\S]*handler1200/, 'the outline names the declaration to target');
    assert.ok(results[0].length < 40000, 'bounded, not the whole file');
    assert.match(results[1], /^NARROWED · server\.ts/, 'the repeat is narrowed again, and the blockage is not repeated');
    assert.match(results[2], /1201\s+export function handler1200/, 'the targeted range is real content');
    assert.strictEqual(said.filter((m) => /BLOCKAGE/.test(m)).length, 1, 'shown once on the CLI');
    const ranges = s.evidence.confirmedRanges();
    assert.ok(ranges.some((r) => r === 'server.ts:1200-1259'), ranges.join(','));
    assert.match(s.evidence.digest(), /CONFIRMED READ[\s\S]*server\.ts:1200-1259/, 'a handover names exactly what is established');
    assert.ok(!s.evidence.byPath.size || ![...s.evidence.byPath.values()].some((e) => e.lines === 6000 && e.bodyPresent), 'a narrowed read is never recorded as whole-file evidence');
  });

  await test('§22 READ: a whole read that compaction elided is narrowed next time, not repeated', async () => {
    const root = tmpdir('cover-el-');
    fs.writeFileSync(path.join(root, 'mid.js'), Array.from({ length: 400 }, (_, i) => `// ${i} ${'y'.repeat(60)}`).join('\n'));
    const s = new Session({ cwd: root });
    s.messages.push({ role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'read_file', arguments: JSON.stringify({ path: 'mid.js' }) }] },
      { role: 'tool', tool_call_id: 't1', content: fs.readFileSync(path.join(root, 'mid.js'), 'utf8') });
    for (let i = 0; i < 12; i++) s.messages.push({ role: 'assistant', content: `step ${i}` });
    s.compact({ budgetChars: 3000, force: true });
    const stub = s.messages[2].content;
    assert.match(stub, /only the part you need[\s\S]*repeating the whole read is elided again/, 'the stub no longer invites the same oversized read');
    const g = require('../../src/readcoverage').guard(s, { name: 'read_file', input: { path: 'mid.js' } }, { cwd: root });
    assert.ok(g && g.narrowed, 'the repeat is narrowed');
    assert.match(g.output, /was elided to fit the context window/);
  });

  await test('§12 SEARCH: zero files in scope is NOT "does not exist"; a skipped large file makes a no-match inconclusive', async () => {
    const root = tmpdir('zero-');
    fs.writeFileSync(path.join(root, 'a.js'), 'const x = 1;\n');
    const tools = require('../../src/tools');
    const none = await tools.execute('grep', { pattern: 'x', include: '*.py' }, { cwd: root });
    assert.match(none.output, /^NO FILES IN SCOPE/);
    assert.match(none.output, /says NOTHING about whether it exists/);
    assert.strictEqual(none.meta.searchState, 'NO_FILES_IN_SCOPE');
    const miss = await tools.execute('grep', { pattern: 'nothere' }, { cwd: root });
    assert.strictEqual(miss.meta.searchState, 'SEARCHED_FILES_NO_MATCH');
    const sym = await tools.execute('symbols', { name: 'nothere', include: '*.py' }, { cwd: root });
    assert.match(sym.output, /^NO FILES IN SCOPE/);
  });
};
