'use strict';

/**
 * THE COMPACTION FLOOR — the reread loop, pinned.
 *
 * Observed in three saved sessions (scalpbot, crusaderengine, toradb), each at
 * ~2.4x the 180k-char budget with compaction unable to remove a single
 * character: `tool_calls[].arguments` were never shrunk, and hundreds of short
 * messages had no stub small enough to matter. So every step compacted, and the
 * working set the model had just read was stubbed before it could be used — the
 * same twenty lines were read about fifteen times.
 *
 * The shape below reproduces that state from synthetic messages: large old
 * call arguments plus many short exchanges.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const { Session } = require('../../src/session');
const msgfold = require('../../src/msgfold');
const { ContextAuthority, EVENT } = require('../../src/contextauthority');

const BUDGET = 60000;

/** A session stuck the way the observed ones were. */
function stuck(steps = 220) {
  const s = new Session({ cwd: process.cwd() });
  s.messages = [{ role: 'user', content: 'the objective' }];
  for (let i = 0; i < steps; i++) {
    if (i % 20 === 0) s.messages.push({ role: 'user', content: `instruction ${i}` });
    s.messages.push({
      role: 'assistant',
      content: `working on part ${i}`,
      tool_calls: [{
        id: `c${i}`,
        name: i % 3 === 0 ? 'plan_write' : 'run_bash',
        arguments: JSON.stringify(i % 3 === 0
          ? { objective: 'fix the bug', steps: Array.from({ length: 30 }, (_, k) => ({ text: `step ${k} of the plan` })) }
          : { command: `sed -n '${i},${i + 20}p' probot/paper_broker.py\n` + '# '.repeat(200), timeout_ms: 30000 }),
      }],
    });
    s.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `result ${i} `.repeat(30) });
  }
  return s;
}

function orphans(s) {
  const calls = new Set();
  const results = new Set();
  for (const m of s.messages) {
    for (const tc of m.tool_calls || []) calls.add(String(tc.id));
    if (m.role === 'tool') results.add(String(m.tool_call_id));
  }
  return [...results].filter((x) => !calls.has(x)).length + [...calls].filter((x) => !results.has(x)).length;
}

/** One step of the observed behaviour: read something, then fit the next request. */
function readStep(s, k) {
  const id = `fresh${k}`;
  s.messages.push({ role: 'assistant', content: 'reading', tool_calls: [{ id, name: 'run_bash', arguments: JSON.stringify({ command: `sed -n 1,30p f${k}.py` }) }] });
  s.messages.push({ role: 'tool', tool_call_id: id, content: 'y'.repeat(900) });
  return s.compact({ budgetChars: BUDGET, maxMessages: 0 });
}

module.exports = async function () {
  await test('FLOOR: old call arguments are elided and stay parseable objects with their short fields', () => {
    const s = stuck(40);
    // Only the argument pass: fold nothing, so the elided calls stay inspectable.
    let elidedCalls = 0;
    for (const m of s.messages.slice(0, -10)) if (m.role === 'assistant' && msgfold.elideArguments(m) > 0) elidedCalls += 1;
    assert.ok(elidedCalls > 20, `old calls were actually elided (${elidedCalls})`);
    for (const m of s.messages.slice(0, -10)) {
      for (const tc of m.tool_calls || []) {
        const parsed = JSON.parse(tc.arguments);
        assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'provider.js parses this into a tool input');
        if (tc.argsElided && tc.name === 'run_bash') {
          assert.strictEqual(parsed.timeout_ms, 30000, 'scalars survive');
          assert.match(parsed.command, /^\[elided \d+ chars\]$/, 'the long field names its size');
        }
      }
    }
  });

  await test('FLOOR: eliding arguments is idempotent', () => {
    const s = new Session({ cwd: process.cwd() });
    const m = { role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'write_file', arguments: JSON.stringify({ path: 'a.js', content: 'x'.repeat(5000) }) }] };
    assert.ok(msgfold.elideArguments(m) > 4000);
    const once = m.tool_calls[0].arguments;
    assert.strictEqual(msgfold.elideArguments(m), 0);
    assert.strictEqual(m.tool_calls[0].arguments, once);
    assert.strictEqual(JSON.parse(once).path, 'a.js', 'the path is what stub labels and the ledger read back');
  });

  await test('FLOOR: a context stuck over the character budget gets under it, with no orphaned calls', () => {
    const s = stuck();
    const before = s.contextChars();
    assert.ok(before > BUDGET * 2, `precondition: the stuck state is well over (${before})`);
    const r = s.compact({ budgetChars: BUDGET, maxMessages: 0 });
    assert.ok(r.after <= BUDGET, `under budget after one compaction: ${r.after} <= ${BUDGET}`);
    assert.strictEqual(orphans(s), 0, 'every call keeps its result and every result its call');
    assert.strictEqual(s.messages[0].content, 'the objective', 'the objective is never folded');
    const fold = s.messages[1];
    assert.strictEqual(fold.elided, 'folded');
    assert.ok(fold.said.includes('instruction 0'), 'what the user said survives the fold verbatim');
  });

  await test('FLOOR: after compaction, the reads of the next steps are NOT stubbed (the loop)', () => {
    const s = stuck();
    s.compact({ budgetChars: BUDGET, maxMessages: 0 });
    let compactedSteps = 0;
    for (let k = 0; k < 8; k++) if (readStep(s, k).compacted) compactedSteps += 1;
    const fresh = s.messages.filter((m) => m.role === 'tool' && String(m.tool_call_id).startsWith('fresh'));
    assert.strictEqual(fresh.filter((m) => m.elided).length, 0,
      'a read the model just made must still be in front of it on the next step');
    assert.strictEqual(compactedSteps, 0, 'the fold left room, so the next steps do not compact at all');
  });

  await test('FLOOR: a folded whole-file read retracts its evidence claim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-floor-'));
    const file = path.join(dir, 'big.js');
    const body = Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`).join('\n');
    fs.writeFileSync(file, body);
    const st = fs.statSync(file);
    const s = stuck();
    s.cwd = dir;
    s.evidence.cwd = dir;
    s.messages.splice(1, 0,
      { role: 'assistant', content: '', tool_calls: [{ id: 'rf', name: 'read_file', arguments: JSON.stringify({ path: file }) }] },
      { role: 'tool', tool_call_id: 'rf', content: 'short' });
    s.evidence.observe('read_file', { path: file }, { output: body, meta: { size: st.size, mtimeMs: Math.floor(st.mtimeMs), lines: 400 } });
    assert.ok(s.evidence.check('read_file', { path: file }), 'precondition: the ledger holds the body as present');
    s.compact({ budgetChars: BUDGET, maxMessages: 0 });
    assert.strictEqual(s.evidence.check('read_file', { path: file }), null,
      'the body left the conversation, so a re-read must be served');
  });

  await test('FLOOR: the authority records a compaction that leaves the context over budget', () => {
    const s = new Session({ cwd: process.cwd() });
    // The recent working set alone is over: nothing may be folded, so it stays over.
    s.messages = [{ role: 'user', content: 'objective' }];
    for (let i = 0; i < 4; i++) s.messages.push({ role: 'user', content: 'z'.repeat(40000) });
    const a = s.contextAuthority || new ContextAuthority(s);
    const pc = { provider: 'p', model: 'm', ctx: 1000000, maxTokens: 1000 };
    a.compact(pc, { contextBudgetTokens: 8000 }, { reason: 'test' });
    const ev = a.timeline.filter((e) => e.type === EVENT.CONTEXT_REBUILT).pop();
    assert.ok(ev, 'rebuilt is noted');
    assert.strictEqual(ev.overAfter, true, 'and it says the context is still over');
    assert.ok(Number.isFinite(ev.floorChars) && ev.floorChars > 0, 'with the floor it could not get under');
  });
};
