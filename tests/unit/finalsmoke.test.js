'use strict';

/**
 * THE FINAL SMOKE IS ONE EXECUTOR OF THE VERIFICATION CONTRACT (finalsmoke.js, verifycontract.js).
 *
 *   It is required only where the contract asks for broad proof (PROJECT / RELEASE): then a changed tree is DONE
 *   only after the final suite ran and passed after the last change. A targeted change is proved by targeted
 *   evidence — the final smoke is NOT a universal ritual. A failing final smoke reopens the step that owns the failure,
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

  await test('FINAL SMOKE: proportional — a targeted change is not held to it; a PROJECT-level change needs it AFTER the last change', () => {
    const targeted = project();
    const small = new Lifecycle('fix one bug');
    write(small, path.join(targeted, 'src', 'a.js'));
    run(small, 'node src/a.js', true);                              // exercises the change
    assert.strictEqual(fsm.state(small, targeted), 'NOT_REQUIRED', 'a one-file fix nothing imports: the contract asks for targeted proof only');
    assert.strictEqual(small.complete({ cwd: targeted }).ok, true, 'and targeted evidence completes it');

    const root = project();
    const life = new Lifecycle('fix two bugs');
    assert.strictEqual(fsm.state(life, root), 'NOT_REQUIRED', 'a diagnostic that changed nothing needs no smoke');
    write(life, path.join(root, 'package.json'));                   // project-wide: the contract asks for broad proof
    run(life, 'npm test', true);
    assert.strictEqual(fsm.state(life, root), 'MISSING');
    assert.match(life.complete({ cwd: root }).why, /final smoke has not run/);
    run(life, 'npm run smoke', true, { finalSmoke: true });
    assert.strictEqual(fsm.state(life, root), 'PASSED');
    write(life, path.join(root, 'src', 'b.js'));                   // a change AFTER the smoke
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
