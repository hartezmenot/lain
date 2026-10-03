'use strict';

/**
 * ACCEPTANCE (2026-09-29): A LONG TASK RUNS WITHOUT BABYSITTING — through the real App.
 *
 *   §57 / §44  one request, a four-phase plan. Along the way the Agent hits,
 *              in sequence: a missing temp file, a stale evidence id, an invalid
 *              delegate role, PowerShell sent through run_bash, and a browser
 *              that is not there. Every phase ends at a model turn boundary.
 *              The person types ONE message; the task finishes; nothing asks
 *              for `continue`, and nothing is marked failed.
 *
 *   §43        an eight-phase task whose process dies after several tool reads.
 *              The session survives on disk. A new host adopts it and the task
 *              RESUMES BY ITSELF — same session, same task, same phase — with
 *              the lost call repaired, not replayed, and no `continue` typed.
 *
 * Only the network is a double (mockprovider.js); every module is the real one.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

function script(steps) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lain-auto-')), 'script.json');
  fs.writeFileSync(p, JSON.stringify(steps));
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = p;
  require('../../src/mockprovider')._reset();
}
function newApp(cwd, extra = {}) {
  const { App } = require('../../src/app');
  return new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd, ...extra });
}
function sandbox() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lain-auto-cwd-')); }
function cleanup(dir) {
  for (let i = 0; i < 40; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { const until = Date.now() + 100; while (Date.now() < until) { /* a git prefetch letting go */ } }
  }
}
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const write = (p, c) => ({ name: 'write_file', input: { path: p, content: c } });
const done = (n) => ({ name: 'plan_step_done', input: { n, note: `step ${n}` } });

module.exports = () => require('../helpers').legacyOnly(async () => {   // LEGACY path only (Simplify S10 deletes)
  await test('STALL (§57, §44): four phases, five recoverable failures, ONE message — the task finishes without a single `continue`', async () => {
    const cwd = sandbox();
    script([
      { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { objective: 'build the inspector', steps: ['tree view', 'preview pane', 'inspector', 'timeline'] } }] },
      { text: 'Checking the last log.', tool_calls: [{ name: 'file_info', input: { path: '/tmp/lain-accept-missing-p45.log' } }] },
      { text: 'Tree view.', tool_calls: [write('tree.txt', 'tree'), done(1)] },
      { text: 'Checkpoint: the tree view is in.' },
      { text: 'Recalling the earlier result.', tool_calls: [{ name: 'recall_evidence', input: { id: 'R274' } }] },
      { text: 'Preview pane.', tool_calls: [write('preview.txt', 'preview'), done(2)] },
      { text: 'Checkpoint: the preview pane is in.' },
      { text: 'Splitting the work.', tool_calls: [{ name: 'delegate', input: { agents: [{ role: 'EXPLORER', objective: 'map it', readScope: ['*.txt'], expectedOutput: 'a map', verification: 'none', completion: 'mapped' }] } }] },
      { text: 'Listing.', tool_calls: [{ name: 'run_bash', input: { command: 'Get-ChildItem -Name' } }] },
      { text: 'Inspector.', tool_calls: [write('inspector.txt', 'inspector'), done(3)] },
      { text: 'Checkpoint: the inspector is in.' },
      { text: 'Looking at the UI.', tool_calls: [{ name: 'request_browser', input: { reason: 'check the timeline renders', target: 'http://localhost:5999' } }] },
      { text: 'Timeline.', tool_calls: [write('timeline.txt', 'timeline'), done(4)] },
      { text: 'All four phases are done.' },
    ]);
    const app = newApp(cwd);
    app._browserBackends = { isolated: async () => ({ ok: false, why: 'nothing is listening on :5999' }) };
    try {
      await app.prepare();
      await app.submit('build the inspector');   // THE ONLY MESSAGE THE PERSON SENDS
      const plan = app.session.plan;
      assert.ok(plan && plan.steps.length === 4, 'the plan was written');
      assert.deepStrictEqual(plan.steps.map((s) => s.status), ['done', 'done', 'done', 'done'], 'every phase finished');
      for (const f of ['tree.txt', 'preview.txt', 'inspector.txt', 'timeline.txt']) assert.ok(fs.existsSync(path.join(cwd, f)), `${f} landed`);
      const turns = app.session.turns || [];
      const typed = turns.filter((t) => !t.from);
      assert.strictEqual(typed.length, 1, 'the person spoke once');
      assert.ok(turns.filter((t) => t.from === 'phase-continue').length >= 3, `the model boundaries were crossed by LAIN: ${turns.map((t) => t.from).join(',')}`);
      const w = require('../../src/workbench').of(app.session);
      const reviews = w.offers.filter((o) => o.kind === 'PHASE_REVIEW' && o.state === 'OPEN');
      assert.ok(reviews.every((o) => /plan is complete/.test(o.text)), `no pause asked for continue: ${reviews.map((o) => o.text).join(' | ')}`);
      const recovered = w.phases.flatMap((p) => p.recovered || []).join('\n');
      for (const want of [/no such file: \/tmp\/lain-accept-missing-p45\.log/, /EVIDENCE_NOT_FOUND/, /INVALID_ARGUMENT role "EXPLORER"|SUBAGENTS_OFF|DENIED/, /BROWSER UNAVAILABLE/]) {
        assert.match(recovered, want, 'the failure was recorded as recovered, not as a failed phase');
      }
      assert.ok(!w.phases.some((p) => (p.failed || []).length), 'no phase is marked failed');
      const ps = turns.flatMap((t) => t.actions || []).find((a) => a.name === 'run_bash');
      assert.ok(ps && ps.ok, 'PowerShell sent through run_bash ran in PowerShell and succeeded');
      assert.strictEqual(require('../../src/supervision').statusLine(app), 'Plan complete');
    } finally {
      cleanup(cwd);
      delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT;
    }
  });

  await test('CRASH RECOVERY (§43): the process dies after three reads in phase 4 of 8 — a new host resumes the SAME task by itself', async () => {
    const cwd = sandbox();
    for (const f of ['a.rs', 'b.rs', 'c.rs']) fs.writeFileSync(path.join(cwd, f), `// ${f}\n`);
    script([]);
    const first = newApp(cwd);
    let id;
    try {
      await first.prepare();
      const s = first.session;
      require('../../src/plan').seedFromCore(s, { objective: 'Game Decoder inspector', remaining: ['crate', 'tree', 'preview', 'inspector', 'timeline', 'tests', 'report', 'smoke'] });
      for (let i = 0; i < 3; i++) s.plan.complete(`phase ${i + 1}`);
      // THE TURN IN FLIGHT when the process died: three reads asked for, two answered, one lost.
      s.messages.push({ role: 'user', content: 'continue the inspector', ts: new Date().toISOString() });
      s.messages.push({ role: 'assistant', content: 'Reading the three files.', tool_calls: [
        { id: 'r1', name: 'read_file', arguments: '{"path":"a.rs"}' }, { id: 'r2', name: 'read_file', arguments: '{"path":"b.rs"}' }, { id: 'r3', name: 'read_file', arguments: '{"path":"c.rs"}' }] });
      s.messages.push({ role: 'tool', tool_call_id: 'r1', content: '// a.rs' });
      s.messages.push({ role: 'tool', tool_call_id: 'r2', content: '// b.rs' });
      s.inflight = { turnId: 'dead-turn', pid: 999999, from: 'phase-continue', userInput: 'continue the inspector', startedAt: new Date().toISOString(), step: 1,
        tool: { id: 'r3', name: 'read_file', target: 'c.rs', kind: 'READ', state: 'STARTED', at: Date.now() },
        ledger: [{ id: 'r1', name: 'read_file', target: 'a.rs', kind: 'READ', state: 'COMPLETED' }, { id: 'r2', name: 'read_file', target: 'b.rs', kind: 'READ', state: 'COMPLETED' }], touchedAt: Date.now() };
      s.save();
      id = s.id;
    } finally { require('../../src/pty').closeAll(first); }

    // A NEW HOST. It loads the session (inflight.recover repairs the lost call) and the task resumes by itself.
    script([
      { text: 'Picking up phase 4.', tool_calls: [{ name: 'read_file', input: { path: 'c.rs' } }] },
      { text: 'Inspector.', tool_calls: [write('inspector.txt', 'ok'), done(4)] },
      { text: 'Phase 4 is done.' },
      { text: 'Timeline.', tool_calls: [write('timeline.txt', 'ok'), done(5)] },
      { text: 'Phase 5 is done.' },
      { text: 'Tests.', tool_calls: [done(6)] }, { text: 'Phase 6 is done.' },
      { text: 'Report.', tool_calls: [done(7)] }, { text: 'Phase 7 is done.' },
      { text: 'Smoke.', tool_calls: [done(8)] }, { text: 'All eight phases are done.' },
    ]);
    const second = newApp(cwd, { resume: id });
    try {
      assert.strictEqual(second.session.id, id, 'the same session');
      const rec = second.session.recovered;
      assert.ok(rec && rec.lost.some((v) => v.id === 'r3'), 'the lost read was repaired, not replayed');
      const lost = second.session.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'r3');
      assert.match(String(lost && lost.content), /RECOVERED/);
      const finished = await until(() => second.session.plan && second.session.plan.steps.every((x) => x.status === 'done') && !second.abort, 30000);
      assert.ok(finished, `the task resumed and finished by itself — plan: ${second.session.plan.steps.map((x) => x.status).join(',')}`);
      const turns = second.session.turns || [];
      assert.ok(turns.some((t) => t.from === 'auto-resume'), `the resumption was LAIN's own: ${turns.map((t) => `${t.from}:${t.stopReason}`).join(' ')}`);
      assert.ok(!turns.some((t) => t.from == null && t.turnId !== 'dead-turn' && /continue/i.test(String(t.userInput || ''))), 'nobody typed continue');
      assert.ok(fs.existsSync(path.join(cwd, 'inspector.txt')) && fs.existsSync(path.join(cwd, 'timeline.txt')));
      const resumed = turns.find((t) => t.from === 'auto-resume');
      assert.match(String(resumed.userInput), /phase 4/, 'it resumed at phase 4, not from the beginning');
    } finally {
      require('../../src/pty').closeAll(second);
      cleanup(cwd);
      delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT;
    }
  });
  await test('GOAL LOOP: a question or a stated blocker ends the turn for the person — never auto-continued', async () => {
    const cwd = sandbox();
    script([
      { text: 'I found two configs. Next I could merge them — should I keep the YAML one?', tool_calls: [write('notes.txt', 'two configs')] },
    ]);
    const app = newApp(cwd);
    try {
      await app.prepare();
      await app.submit('clean up the config');
      const turns = app.session.turns || [];
      assert.strictEqual(turns.length, 1, `the question stops it: ${turns.map((t) => t.from || 'person').join(',')}`);
    } finally {
      cleanup(cwd);
      delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT;
    }
  });
});
