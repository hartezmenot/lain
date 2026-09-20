'use strict';

/**
 * §19/§20 — RUNTIME PROVENANCE DIAGNOSTICS.
 *
 * §8's defect (Computer MCP ran fine while LAIN's own governance said "No
 * implementation target was specified") was invisible because nothing
 * surfaced the classification a turn had actually made. This pins that
 * /provenance reports the task class, context sources and tool dispatch a
 * real turn left behind, and that it never throws on a bare-bones session.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

const provenance = require('../../src/provenance');
const taskclass = require('../../src/taskclass');
const { Session } = require('../../src/session');
const { Task } = require('../../src/task');

function appWith(session, extra = {}) {
  return { session, _clarify: null, _retiredTasks: [], ...extra };
}

module.exports = async function () {
  await test('PROVENANCE: never throws on a bare session with no task, plan or turns', () => {
    const session = new Session({ cwd: tmpdir('provenance-') });
    const app = appWith(session);
    const r = provenance.report(app);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.goal, null);
    assert.strictEqual(r.plan, null);
    assert.ok(provenance.rows(app).length > 0);
  });

  await test('PROVENANCE: §56\'s exact diagnostic status line is what taskClass reports for a live diagnostic', () => {
    const session = new Session({ cwd: tmpdir('provenance-') });
    session.taskClassVerdict = taskclass.classify('Diagnose the Windows Calculator app using Computer MCP.', {});
    const app = appWith(session);
    const r = provenance.report(app);
    assert.match(r.turn.taskClass, /LIVE_EXTERNAL_DIAGNOSTIC/);
    assert.match(r.turn.taskClass, /NOT REQUIRED/, 'project source must read NOT REQUIRED for a live diagnostic');
  });

  await test('PROVENANCE: the goal and plan sections reflect the real Task/Plan objects', () => {
    const session = new Session({ cwd: tmpdir('provenance-') });
    session.task = new Task('wire up the login form');
    const { Plan } = require('../../src/plan');
    session.plan = new Plan('wire up the login form');
    session.plan.addSteps(['find the component', 'add the handler']);
    session.plan.steps[0].status = 'done';
    const app = appWith(session);
    const r = provenance.report(app);
    assert.strictEqual(r.goal.objective, 'wire up the login form');
    assert.strictEqual(r.plan.total, 2);
    assert.strictEqual(r.plan.done, 1);
    assert.strictEqual(r.plan.currentStep, 'add the handler');
  });

  await test('PROVENANCE: retired tasks (from an explicit cancellation) are visible in the report', () => {
    const session = new Session({ cwd: tmpdir('provenance-') });
    const app = appWith(session, { _retiredTasks: [{ id: 'T1', objective: 'old work', supersededAt: 'now', reason: 'cancelled' }] });
    const r = provenance.report(app);
    assert.strictEqual(r.retiredTasks.length, 1);
    assert.strictEqual(r.retiredTasks[0].objective, 'old work');
  });

  await test('PROVENANCE: tool dispatch reports what is EXPOSED, honestly leaves REQUESTED/ADMITTED/REFUSED/BLOCKED as not tracked', () => {
    const session = new Session({ cwd: tmpdir('provenance-') });
    const app = appWith(session);
    const r = provenance.report(app);
    assert.ok(r.toolDispatch.exposedCount > 0);
    assert.deepStrictEqual(r.toolDispatch.notTracked, ['REQUESTED', 'ADMITTED', 'REFUSED', 'BLOCKED']);
  });
};
