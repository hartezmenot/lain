'use strict';

/**
 * §26–27, §75 — the hidden wake-up, through the REAL turn loop and the scripted
 * provider; §28–31 — `/bg` detaching the SAME running process.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');
const { runTurn } = require('../../src/turn');
const { Session } = require('../../src/session');
const wakeup = require('../../src/wakeup');

async function drive(session, steps, { requiresExecution = true } = {}) {
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('wake-'), steps);
  const mock = require('../../src/mockprovider');
  mock._reset();
  const real = mock.chat;
  const wire = [];
  mock.chat = function patched(pc, messages, opts) { wire.push(messages.map((m) => ({ role: m.role, content: String(m.content || '') }))); return real.call(this, pc, messages, opts); };
  const events = [];
  try {
    for await (const ev of runTurn(session, 'fix the retry delay bug', { cfg: {}, systemPrompt: 'sys', live: '', evidence: session.evidence, lifecycle: session.lifecycle, requiresExecution })) events.push(ev);
  } finally {
    delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT;
    mock.chat = real; mock._reset();
  }
  return { wire, events, record: events.find((e) => e.type === 'done').record };
}

module.exports = async function () {
  await test('WAKEUP: an execution turn that answers in prose gets ONE hidden wake-up, then acts — same turn', async () => {
    const root = tmpdir('wake-act-');
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    const session = new Session({ cwd: root });
    const { wire, events, record } = await drive(session, [
      { text: 'I will look into the retry delay.' },
      // The asked-for CHANGE, not merely a read: a fix request that only reads
      // is not done either (see the READING IS NOT FIXING test below).
      { text: '', tool_calls: [{ name: 'write_file', input: { path: 'retry.txt', content: 'fixed' } }] },
      { text: 'Done: fixed it.' },
    ]);
    assert.strictEqual(record.wakeups, 1);
    assert.strictEqual(record.toolCalls, 1, 'the tool call happened after the wake-up');
    assert.strictEqual(record.stopReason, 'end', JSON.stringify({ muts: record.mutations, actions: record.actions.map((a) => [a.name, a.ok, a.note]) }));
    const second = wire[1];
    const tail = second[second.length - 1];
    assert.match(tail.content, /<lain-context>[\s\S]*current task is still pending/, 'the note rides the FRAMED tail');
    const userTurns = second.filter((m) => m.role === 'user' && /still pending/.test(m.content) && !/<lain-context>/.test(m.content));
    assert.deepStrictEqual(userTurns, [], 'never an unframed user-role message');
    assert.ok(!session.messages.some((m) => /still pending/.test(String(m.content || ''))), 'nothing in the transcript');
    assert.ok(!events.some((e) => e.type === 'notice' && /still pending|wake/i.test(e.message || '')), 'nothing drawn');
  });

  await test('WAKEUP: bounded — a second idle reply ends the turn as no-progress (BLOCKED), no loop', async () => {
    const session = new Session({ cwd: tmpdir('wake-block-') });
    const { wire, record } = await drive(session, [{ text: 'Thinking about it.' }, { text: 'Still thinking.' }, { text: 'never reached' }]);
    assert.strictEqual(wire.length, 2, 'exactly one extra request');
    assert.strictEqual(record.stopReason, 'no-progress');
  });

  await test('WAKEUP: a question, a stated blocker, or a non-execution task is never woken', async () => {
    const r = { toolCalls: 0, mutations: [] };
    assert.strictEqual(wakeup.decide(r, 'Should I change the public API or keep it?', { required: true }), null);
    assert.strictEqual(wakeup.decide(r, 'I cannot proceed without a credential for the staging API.', { required: true }), null);
    assert.strictEqual(wakeup.decide(r, 'Here is the explanation.', { required: false }), null);
    assert.strictEqual(wakeup.decide({ toolCalls: 3, mutations: [] }, 'All done.', { required: true }), null);
    assert.strictEqual(wakeup.requiresExecution({ taskClass: 'CONVERSATIONAL' }), false);
    assert.strictEqual(wakeup.requiresExecution({ taskClass: 'PROJECT_IMPLEMENTATION', execMode: 'PLAN' }), false);
    assert.strictEqual(wakeup.requiresExecution({ taskClass: 'DIRECT_TOOL_TASK' }), true);
  });
  await test('/bg: a running foreground command is detached — the tool returns at once, the SAME pid keeps running, and its result rejoins', async () => {
    const { AgentJobs } = require('../../src/agentjob');
    const root = tmpdir('bg-');
    const session = new Session({ cwd: root });
    const notices = [];
    const app = { session, jobs: new AgentJobs(), render: { notice: (l, m) => notices.push(m) }, ui: { enabled: false } };
    const shell = require('../../src/tools/shell');
    const script = path.join(root, 'suite.js');
    fs.writeFileSync(script, "setTimeout(() => { console.log('565 passed, 0 failed'); }, 900);\n");
    const t0 = Date.now();
    const pending = shell.run(`node "${script}"`, { shell: process.platform === 'win32' ? 'powershell' : 'bash', cwd: root, detach: { app, label: 'CLI smoke', tool: 'run_tests' } });
    await new Promise((r) => setTimeout(r, 250));
    const bg = require('../../src/bgdetach');
    assert.strictEqual(bg.running(app).length, 1, 'the foreground process registered itself');
    const pid = bg.running(app)[0].pid;
    const job = bg.detachProcess(app);
    const r = await pending;
    assert.ok(r.detached, 'the waiting tool call returned');
    assert.ok(Date.now() - t0 < 800, 'without waiting for the command');
    assert.strictEqual(job.pid, pid, 'same process — nothing restarted');
    assert.strictEqual(job.kind, 'process');
    await job.wait();
    assert.strictEqual(job.state, 'SUCCEEDED');
    assert.strictEqual(job.resultSummary, '565/565');
    assert.ok(notices.some((n) => /^BG COMPLETE · CLI smoke · 565\/565/.test(n)), notices.join('\n'));
    const ctx = bg.takeContext(session);
    assert.match(ctx, /Background results \(rejoined\)[\s\S]*CLI smoke · OK · 565\/565/);
    assert.strictEqual(bg.takeContext(session), '', 'delivered once');
    assert.strictEqual(job.summary().word, 'DONE');
  });

  await test('WAKE: a negated constraint is not an action request — its prose answer is not woken', () => {
    // Live, 2026-09-18: "Do not modify the test file. do not change test/run.js
    // please" matched `change`/`test`; the correct answer was woken and the
    // model asked "What feature should I add?".
    const w = require('../../src/wakeup');
    const said = 'Do not modify the test file.\ndo not change test/run.js please';
    assert.strictEqual(w.asksForAction(said), false);
    assert.strictEqual(w.requiresExecution({ taskClass: 'PROJECT_IMPLEMENTATION', request: said }), false);
    const record = { userInput: said, toolCalls: 0, mutations: [] };
    assert.strictEqual(w.decide(record, "I haven't modified test/run.js.", { required: true, cls: 'PROJECT_IMPLEMENTATION' }), null);
    // The positive half is untouched: an action with a negated side-constraint still asks for action.
    assert.strictEqual(w.asksForAction('Fix the cart total without touching the tests'), true);
    assert.strictEqual(w.asksForAction("Don't refactor anything, just fix the bug"), true);
  });

  await test('WAKE: an EMPTY closing reply on a change request is woken once even after a passing check — then BLOCKED', () => {
    // Live, 2026-09-23 (gpt-oss:120b): the untouched project's tests pass at
    // step 5, fifteen reads, then a reasoning-only last step with no text and
    // no tool call — which ended as a success with nothing changed.
    const w = require('../../src/wakeup');
    const rec = () => ({ userInput: 'TeamDesk has a batch of reported problems. Fix all of them.', toolCalls: 20, mutations: [],
      actions: [{ name: 'run_tests', ok: true }, { name: 'read_file', ok: true }] });
    const r = rec();
    assert.strictEqual(w.decide(r, '', { required: true, cls: 'PROJECT_IMPLEMENTATION' }), 'wake');
    assert.match(w.noteFor(r), /no answer and no tool call/);
    assert.strictEqual(w.decide(rec(), '   ', { required: true, cls: 'PROJECT_IMPLEMENTATION', wakeups: 1 }), 'no-progress', 'a second empty reply is BLOCKED, never DONE');
    // Still ends: the same turn saying why no change is needed, or having changed something.
    assert.strictEqual(w.decide(rec(), 'No change needed: the tests pass and the reported behaviour is already correct.', { required: true, cls: 'PROJECT_IMPLEMENTATION' }), null);
    assert.strictEqual(w.decide({ ...rec(), mutations: ['src/api.js'] }, '', { required: true, cls: 'PROJECT_IMPLEMENTATION' }), null);
  });

  await test('WAKE: a fix request that only READ and then stopped is not done — reads do not excuse the missing change', () => {
    // Live acceptance, 2026-09-18: "Find and fix these bugs" → 5 reads → "Found
    // both bugs: …" → finish stop → ✓ DONE with nothing changed.
    const w = require('../../src/wakeup');
    const ask = 'Cart totals are wrong. Find and fix these bugs and run the tests.';
    const reads = [{ name: 'read_file', ok: true }, { name: 'read_symbol', ok: true }];
    const rec = (extra = {}) => ({ userInput: ask, toolCalls: 5, mutations: [], actions: reads, ...extra });
    const found = 'Found both bugs:\n1. applyDiscount subtracts the number.\n2. computeTax adds 0.01.';
    assert.strictEqual(w.decide(rec(), found, { required: true, cls: 'PROJECT_IMPLEMENTATION' }), 'wake');
    assert.match(w.noteFor(rec()), /changed no file/, 'and the note says what is actually missing');
    assert.strictEqual(w.decide(rec(), found, { required: true, cls: 'PROJECT_IMPLEMENTATION', wakeups: 1 }), 'no-progress', 'a second idle is BLOCKED, never DONE');
    // What still ends it: a change, a passing check, a question, a stated blocker.
    assert.strictEqual(w.decide(rec({ mutations: ['src/pricing.js'] }), found, { required: true, cls: 'PROJECT_IMPLEMENTATION' }), null);
    assert.strictEqual(w.decide(rec({ actions: [...reads, { name: 'run_tests', ok: true }] }), 'Already correct; tests pass.', { required: true, cls: 'PROJECT_IMPLEMENTATION' }), null);
    // …and a passing TEST COMMAND through the shell (live ECO run, 2026-09-19: read → `npm test` via
    // run_bash, pass → "no bug to fix" was ended BLOCKED no-progress). A failing one, or a non-test command, is not.
    assert.strictEqual(w.decide(rec({ actions: [...reads, { name: 'run_bash', target: 'npm test', ok: true }] }), 'No bug to fix; npm test passes.', { required: true, cls: 'PROJECT_IMPLEMENTATION' }), null);
    assert.strictEqual(w.decide(rec({ actions: [...reads, { name: 'run_bash', target: 'npm test', ok: false }] }), found, { required: true, cls: 'PROJECT_IMPLEMENTATION' }), 'wake');
    assert.strictEqual(w.decide(rec({ actions: [...reads, { name: 'run_bash', target: 'ls src', ok: true }] }), found, { required: true, cls: 'PROJECT_IMPLEMENTATION' }), 'wake');
    assert.strictEqual(w.decide(rec(), 'Should I also change the tax table?', { required: true, cls: 'PROJECT_IMPLEMENTATION' }), null);
    assert.strictEqual(w.decide(rec(), 'Blocked: I cannot access the pricing service.', { required: true, cls: 'PROJECT_IMPLEMENTATION' }), null);
    // A produced artifact IS the change (harness real-UI: cowork_spreadsheet_create → clean.xlsx).
    const art = require('../../src/describe').actionRecord({ name: 'cowork_spreadsheet_create', input: {} }, { output: 'Done', artifact: { ref: 'a1' } });
    assert.strictEqual(art.artifact, true);
    assert.strictEqual(w.decide(rec({ actions: [art] }), 'Done: clean.xlsx has the deduplicated rows.', { required: true, cls: 'PROJECT_IMPLEMENTATION' }), null);
    // The person decided in this turn: "change the export style" → ask_user → "keep CommonJS" needs no change.
    assert.strictEqual(w.decide(rec({ actions: [{ name: 'ask_user', ok: true }] }), 'Keeping CommonJS as you chose.', { required: true, cls: 'PROJECT_IMPLEMENTATION' }), null);
    // A STATED BLOCKER is not DONE — strip and remote attention (live real-Chrome run, 2026-09-19).
    const said = 'The extension is not responding.\n\nBlocker: LAIN for Chrome extension is not communicating.';
    assert.strictEqual(w.statesBlocker(said), true);
    assert.strictEqual(w.statesBlocker('All 8 tests pass; the unblocker module is untouched.'), false);
    const st = require('../../src/ui/status').liveState({ lastTurn: { stopReason: 'end', toolCalls: 3, blocker: true } }, Date.now());
    assert.strictEqual(st.word, 'BLOCKED');
    assert.strictEqual(require('../../src/notify').attentionKind({ session: {} }, { stopReason: 'end', text: said }), 'BLOCKED');
    // …and it is judged on the WHOLE answer: the persisted turn keeps only its
    // first 1200 chars, and "which is blocked by permission requirements" came last.
    const { Session } = require('../../src/session');
    const sess = new Session({ cwd: require('../helpers').tmpdir('blk-') });
    const long = `${'Step done. '.repeat(160)}Everything else passed except the screenshot, which is blocked by permission requirements.`;
    const tr = require('../../src/turnrecord').newRecord(sess.id, 'drive the tab', 'm');
    tr.text = long; tr.stopReason = 'end';
    require('../../src/turnclose').close(sess, null, tr);
    assert.strictEqual(sess.turns[sess.turns.length - 1].blocker, true);
    // A diagnostic's reads ARE the work.
    assert.strictEqual(w.decide({ userInput: 'Investigate why totals are wrong', toolCalls: 3, mutations: [], actions: reads }, found, { required: true, cls: 'PROJECT_DIAGNOSTIC' }), null);
  });
};
