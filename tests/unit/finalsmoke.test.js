'use strict';

/**
 * THE FINAL SMOKE IS THE TERMINAL EXECUTION STEP (finalsmoke.js).
 *
 *   TARGETED TEST != FINAL SMOKE; RESPONSE_ENDED != TASK_COMPLETE.
 *   A changed tree is DONE only after the final suite ran and passed after the
 *   last change. A failing final smoke reopens the step that owns the failure,
 *   leaves the other completed steps done, and waits to be run again. A /bg
 *   final smoke keeps the task open until it rejoins, then settles on its own.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const fsm = require('../../src/finalsmoke');
const { Lifecycle } = require('../../src/lifecycle');
const { Plan } = require('../../src/plan');
const status = require('../../src/ui/status');

function project() {
  const root = tmpdir('finalsmoke-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node test.js', smoke: 'node smoke.js' } }));
  fs.mkdirSync(path.join(root, 'src'));
  fsm._cache.clear();
  return root;
}

const run = (life, command, ok, extra = {}) => life.observeTool({ name: 'run_bash', input: { command }, output: ok ? 'ok' : 'FAIL', isError: !ok, exitCode: ok ? 0 : 1, ...extra });
const write = (life, file) => life.observeTool({ name: 'edit_file', input: { path: file }, output: 'ok', mutated: [file] });

module.exports = async function () {
  await test('FINAL SMOKE: the project smoke suite is the final suite; the primary suite stands in when there is none', () => {
    const root = project();
    assert.deepStrictEqual(fsm.suite(root), { command: 'npm run smoke', kind: 'SMOKE' });
    assert.ok(fsm.isFinal(root, 'run_tests', { which: 'smoke' }));
    assert.ok(fsm.isFinal(root, 'run_bash', { command: 'npm  run smoke' }));
    assert.ok(!fsm.isFinal(root, 'run_tests', { which: 'project' }), 'a targeted/project run is not the final smoke');
    const plain = tmpdir('finalsmoke-plain-');
    fs.writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ name: 'q', scripts: { test: 'node t.js' } }));
    fsm._cache.clear();
    assert.strictEqual(fsm.suite(plain).command, 'npm test');
    assert.strictEqual(fsm.suite(tmpdir('finalsmoke-none-')), null, 'no suite, no invented requirement');
  });

  await test('FINAL SMOKE: DONE needs a passing final run AFTER the last change — targeted tests do not count, a later change reopens it', () => {
    const root = project();
    const life = new Lifecycle('fix two bugs');
    assert.strictEqual(fsm.state(life, root), 'NOT_REQUIRED', 'a diagnostic that changed nothing needs no smoke');
    write(life, 'src/a.js');
    run(life, 'npm test', true);                                   // targeted
    assert.strictEqual(fsm.state(life, root), 'MISSING');
    assert.match(life.complete({ cwd: root }).why, /final smoke has not run/);
    run(life, 'npm run smoke', true, { finalSmoke: true });
    assert.strictEqual(fsm.state(life, root), 'PASSED');
    write(life, 'src/b.js');                                       // a change AFTER the smoke
    assert.strictEqual(fsm.state(life, root), 'MISSING', 'nothing may change after the final smoke and still count');
    run(life, 'npm run smoke', false, { finalSmoke: true });
    assert.strictEqual(fsm.state(life, root), 'FAILED');
    run(life, 'npm run smoke', true, { finalSmoke: true });
    assert.strictEqual(life.complete({ cwd: root }).ok, true);
  });

  await test('FINAL SMOKE: the plan ends on the smoke step, even when revised; a passing run mid-plan does not tick it', () => {
    const root = project();
    const plan = new Plan('fix'); plan.addSteps(['Fix A', 'Test A', 'Fix B', 'Test B', 'Integration']);
    fsm.ensureTerminal(plan, root);
    assert.strictEqual(plan.steps[plan.steps.length - 1].origin, fsm.ORIGIN);
    assert.strictEqual(plan.steps.length, 6);
    plan.steer('revised', { append: ['Update docs'] });
    fsm.ensureTerminal(plan, root);
    assert.strictEqual(plan.steps[plan.steps.length - 1].origin, fsm.ORIGIN, 'still last after a revision');
    assert.strictEqual(plan.steps.filter((s) => s.origin === fsm.ORIGIN).length, 1, 'and only once');
  });

  await test('FINAL SMOKE: a failure REOPENS the owning step only — B stays done, the smoke waits, nothing resets', () => {
    const root = project();
    const plan = new Plan('fix'); plan.addSteps(['Fix provider selection', 'Test provider selection', 'Fix quota refresh', 'Test quota refresh']);
    fsm.ensureTerminal(plan, root);
    fsm.noteMutation(plan, [path.join(root, 'src', 'provider.js')]); plan.complete('fixed'); plan.complete('tested');
    fsm.noteMutation(plan, [path.join(root, 'src', 'quota.js')]); plan.complete('fixed'); plan.complete('tested');
    const smoke = plan.current();
    assert.strictEqual(smoke.origin, fsm.ORIGIN);
    const stack = `Error: expected route "b" got "a"\n    at pick (${path.join(root, 'src', 'provider.js')}:42:9)\n    at smoke.js:10`;
    const said = fsm.reopen(plan, stack);
    assert.match(said, /reopened step 1 "Fix provider selection"/);
    assert.strictEqual(plan.steps[0].status, 'active', 'A reopened');
    assert.strictEqual(plan.steps[2].status, 'done', 'B stays completed');
    assert.strictEqual(plan.steps[3].status, 'done');
    assert.strictEqual(smoke.status, 'todo', 'the smoke waits to run again, last');
    assert.strictEqual(plan.current(), plan.steps[0]);
    // Ambiguous evidence reopens nothing and says so.
    const plan2 = new Plan('x'); plan2.addSteps(['Fix a']); fsm.noteMutation(plan2, ['src/a.js']);
    assert.match(fsm.reopen(plan2, 'segfault somewhere'), /owner is not clear/);
  });

  await test('FINAL SMOKE: /bg keeps the task open; the rejoined result settles it without a "continue"', async () => {
    const root = project();
    const session = { cwd: root, lifecycle: new Lifecycle('fix'), plan: new Plan('fix') };
    session.plan.addSteps(['Fix A']); fsm.ensureTerminal(session.plan, root);
    write(session.lifecycle, 'src/a.js'); session.plan.complete('fixed');
    session.lifecycle.observeTool({ name: 'run_tests', input: { which: 'smoke' }, output: 'DETACHED', finalSmoke: true, detached: true });
    assert.strictEqual(fsm.state(session.lifecycle, root), 'RUNNING');
    assert.match(session.lifecycle.complete({ cwd: root }).why, /still running in the background/, 'not DONE while it runs');
    let completed = 0;
    const app = { session, abort: null, render: { notice() {}, write() {}, nl() {} }, ui: { enabled: false }, submit: () => Promise.resolve() };
    const orig = require('../../src/completion').maybeComplete;
    require('../../src/completion').maybeComplete = () => { completed += 1; return true; };
    try {
      const r = fsm.settleBackground(app, session, { kind: 'process', label: 'npm run smoke', ok: true, summary: 'exit 0', tail: 'smoke PASSED' });
      assert.deepStrictEqual(r, { passed: true });
      assert.strictEqual(fsm.state(session.lifecycle, root), 'PASSED');
      assert.strictEqual(session.plan.steps[1].status, 'done', 'the smoke step is ticked');
      assert.strictEqual(completed, 1, 'and the completion validator ran without being asked');
    } finally { require('../../src/completion').maybeComplete = orig; }

    // FAIL: reopen + a self-started continuation carrying the evidence.
    const s2 = { cwd: root, lifecycle: new Lifecycle('fix'), plan: new Plan('fix') };
    s2.plan.addSteps(['Fix A']); fsm.ensureTerminal(s2.plan, root);
    fsm.noteMutation(s2.plan, ['src/alpha.js']); write(s2.lifecycle, 'src/alpha.js'); s2.plan.complete('fixed');
    s2.lifecycle.observeTool({ name: 'run_tests', input: { which: 'smoke' }, output: 'DETACHED', finalSmoke: true, detached: true });
    const sent = [];
    const app2 = { session: s2, abort: null, submit: (t, o) => { sent.push([t, o]); return Promise.resolve(); } };
    const f = fsm.settleBackground(app2, s2, { kind: 'process', label: 'npm run smoke', ok: false, summary: 'exit 1', tail: 'at src/alpha.js:3 assertion failed' });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(f.failed);
    assert.strictEqual(s2.plan.steps[0].status, 'active', 'the owning step reopened');
    assert.strictEqual(sent.length, 1, 'a continuation started on its own');
    assert.match(sent[0][0], /FAILED[\s\S]*reopened step 1/);
    assert.strictEqual(sent[0][1].sameTask, true);
  });

  await test('FINAL SMOKE: the strip never says DONE over a changed tree whose final smoke has not passed', () => {
    const base = { lastTurn: { stopReason: 'end', toolCalls: 3, filesChanged: 1 } };
    const missing = status.liveState({ ...base, finalSmoke: { state: 'MISSING', why: 'final smoke has not run since the last change: npm run smoke' } }, Date.now());
    assert.strictEqual(missing.word, 'NOT VERIFIED');
    const running = status.liveState({ ...base, finalSmoke: { state: 'RUNNING', why: 'final smoke is still running in the background' } }, Date.now());
    assert.strictEqual(running.word, 'VERIFYING');
    const passed = status.liveState({ ...base, finalSmoke: { state: 'PASSED', why: '' } }, Date.now());
    assert.strictEqual(passed.word, 'DONE');
  });
};
