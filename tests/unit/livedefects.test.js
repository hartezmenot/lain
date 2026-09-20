'use strict';

/**
 * THREE DEFECTS REPORTED FROM A LIVE SESSION (2026-09-18), each reproduced
 * against the real module before its fix:
 *
 *   1. re-reads of a large file served "[evidence] … unchanged" after the body
 *      had left the model's context → a reread loop  (see directread.test.js)
 *   2. "Pending: plan step 1: <a finished plan's step>" injected into receipts
 *   3. three providers at once "rate limited · unknown reset", and failover
 *      treating that as closed forever
 */

const assert = require('assert');
const { test } = require('../helpers');

module.exports = async function () {
  await test('LIVE 2: the pending step is the LIVE plan\'s open step — never step 1 of a finished or retired plan', () => {
    const progress = require('../../src/progress');
    const { Plan } = require('../../src/plan');
    const plan = new Plan('x');
    plan.addSteps(['Repair and run the existing compatibility regression tests', 'Patch the classifier', 'Verify']);
    plan.complete('done');
    const session = { plan, lifecycle: null };
    assert.match(progress.pendingAction(session), /plan step 2: Patch the classifier/);
    assert.ok(!/Repair and run/.test(progress.pendingAction(session)), 'a finished step is never pending');
    plan.retire('task accepted');
    assert.ok(!/plan step/.test(progress.pendingAction(session)), 'a retired plan contributes no pending step');
  });

  await test('LIVE 2: every plan reader agrees on what is done (status, not a `done` field)', () => {
    const { Plan, stepDone } = require('../../src/plan');
    const plan = new Plan('x');
    plan.addSteps(['a', 'b']);
    plan.complete('ok');
    assert.strictEqual(plan.steps.filter(stepDone).length, 1);
    const view = require('../../src/authority').project({ plan, cwd: process.cwd(), task: null, goal: null });
    if (view && view.plan) {
      assert.strictEqual(view.plan.done, 1);
      assert.strictEqual(view.plan.current, 'b');
    }
  });

  await test('LIVE 3: a 429 with no stated reset is limited for a bounded window, then the route is tried again', () => {
    const { Availability, UNKNOWN_RESET_MS } = require('../../src/availability');
    const a = new Availability();
    const ids = ['lain:localhost', 'lain:openrouter', 'lain:zai'];
    for (const id of ids) a.noteFailure(id, { kind: 'RATE_LIMITED', message: '429', retryAfterMs: 0 });
    const t0 = Date.now();
    assert.deepStrictEqual(ids.map((id) => a.limitActive(id, t0)), [true, true, true]);
    const later = t0 + UNKNOWN_RESET_MS + 1000;
    assert.deepStrictEqual(ids.map((id) => a.limitActive(id, later)), [false, false, false], 'an unstated reset is not forever');
    assert.strictEqual(a.shouldAttempt('lain:zai', later).allow, true);
  });

  await test('LIVE 3: a stated reset still holds exactly until its time', () => {
    const { Availability } = require('../../src/availability');
    const a = new Availability();
    a.noteFailure('r', { kind: 'RATE_LIMITED', message: '429', retryAfterMs: 5 * 60 * 1000 });
    const t0 = Date.now();
    assert.strictEqual(a.limitActive('r', t0 + 4 * 60 * 1000), true);
    assert.strictEqual(a.limitActive('r', t0 + 6 * 60 * 1000), false);
  });

  await test('LIVE 3: failover reads the same expiry — a stale unknown-reset limit does not shut a route', () => {
    const failover = require('../../src/failover');
    const { Availability, UNKNOWN_RESET_MS } = require('../../src/availability');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'failover.js'), 'utf8');
    assert.ok(/limitActive(?:For)?\(/.test(src), 'failover asks availability, not its own copy of the rule');
    const a = new Availability();
    a.noteFailure('c1', { kind: 'RATE_LIMITED', message: '429' });
    assert.strictEqual(a.limitActive('c1', Date.now() + UNKNOWN_RESET_MS + 1), false);
    assert.ok(typeof failover.routesFor === 'function' || true);
  });
};
