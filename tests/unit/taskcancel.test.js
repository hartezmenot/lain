'use strict';

/**
 * P0 — A CANCELLED TASK CANNOT RESURRECT.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT. task.js had no notion of cancellation at all: "cancel the
 * current task, do X instead" fell through every rule to STEER — "new
 * instruction while a task is active — adjusts it, does not replace it" —
 * and identify.js then appended it as a CORRECTION to the very task the user
 * had just asked to stop. The old plan, the old goal reasoning and the old
 * objective all survived, fully in force, contradicting the instruction that
 * was supposed to end them.
 *
 * Regression scenario from the report: Task A exists. User says "Cancel A.
 * Execute B." Expected: A is superseded, B starts clean, and A cannot
 * reappear through handoff, `/resume`, compaction, recovery or a session
 * restart.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

const taskId = require('../../src/task');
const { identify } = require('../../src/identify');
const { Session } = require('../../src/session');

function appWith(session) {
  return {
    session,
    ui: { enabled: false, clearExtras() {} },
    projectIsEmpty() { return false; },
    cfg: {},
  };
}

module.exports = async function () {
  await test('CANCEL: an explicit cancellation classifies as NEW, never STEER', () => {
    const active = { objective: 'wire up the login form' };
    const v = taskId.classify('Cancel the current task. Diagnose Calculator using Computer MCP.', { activeTask: active });
    assert.strictEqual(v.kind, taskId.KIND.NEW);
    assert.strictEqual(v.sameTask, false);
    assert.strictEqual(v.cancelled, true);
  });

  await test('CANCEL: the cancel clause is stripped from the new task\'s own text', () => {
    const active = { objective: 'wire up the login form' };
    const v = taskId.classify('Cancel the current task. Diagnose Calculator using Computer MCP.', { activeTask: active });
    assert.strictEqual(v.newText, 'Diagnose Calculator using Computer MCP.');
  });

  await test('CANCEL: a bare "cancel it" with nothing after falls back to the raw text', () => {
    // stripCancelClause on its own correctly reports '' — there is nothing
    // left once the cancel clause is removed. classify() then falls back to
    // the RAW text for `newText`, precisely so a new task is never created
    // with a blank objective (see the comment on stripCancelClause).
    assert.strictEqual(taskId.stripCancelClause('cancel it'), '');
    const active = { objective: 'wire up the login form' };
    const v = taskId.classify('cancel it', { activeTask: active });
    assert.strictEqual(v.cancelled, true);
    assert.strictEqual(v.newText, 'cancel it', 'falls back to the raw text rather than an empty objective');
  });

  await test('CANCEL: does NOT fire on ordinary mentions of the word', () => {
    // A real project sentence that happens to contain "cancel" as a business
    // term must stay a normal STEER/restatement, not a false cancellation.
    const active = { objective: 'build the checkout flow' };
    const v1 = taskId.classify('add a cancel button to the checkout form', { activeTask: active });
    assert.notStrictEqual(v1.cancelled, true, 'a feature request naming "cancel" is not a cancellation');
    const v2 = taskId.classify('the upload was cancelled by the server, investigate why', { activeTask: active });
    assert.notStrictEqual(v2.cancelled, true, 'reporting a fact that used the word is not an instruction to cancel');
  });

  await test('CANCEL: with no active task, cancellation language is just a new task', () => {
    const v = taskId.classify('cancel that, build something else', { activeTask: null });
    assert.strictEqual(v.kind, taskId.KIND.NEW);
    assert.strictEqual(v.sameTask, false);
  });

  await test('CANCEL: identify() supersedes the old task, clears its plan, and starts the new one clean', () => {
    const dir = tmpdir('taskcancel-');
    const session = new Session({ cwd: dir });
    session.task = new taskId.Task('wire up the login form');
    const { Plan } = require('../../src/plan');
    session.plan = new Plan('wire up the login form');
    session.plan.addSteps(['find the form component', 'add the submit handler']);
    const oldTaskId = session.task.id;

    const app = appWith(session);
    identify(app, 'Cancel the current task. Diagnose Calculator using Computer MCP.', false, null, false);

    assert.notStrictEqual(app.session.task.id, oldTaskId, 'a genuinely new task object');
    assert.strictEqual(app.session.task.objective, 'Diagnose Calculator using Computer MCP.');
    assert.strictEqual(app.session.plan, null, 'the old plan does not survive into the new task');
    assert.ok(Array.isArray(app._retiredTasks) && app._retiredTasks.length === 1, 'the old task is recorded as retired, for diagnostics');
    assert.strictEqual(app._retiredTasks[0].id, oldTaskId);
  });

  await test('CANCEL: the superseded task is marked SUPERSEDED before it is dropped', () => {
    const dir = tmpdir('taskcancel-');
    const session = new Session({ cwd: dir });
    session.task = new taskId.Task('old work');
    const outgoing = session.task;
    const app = appWith(session);
    identify(app, 'cancel it, do something completely different now', false, null, false);
    assert.strictEqual(outgoing.state, taskId.STATE.SUPERSEDED, 'the object Noema held a reference to is marked, not merely dropped');
  });

  await test('CANCEL: A cannot reappear through a save/resume round trip', () => {
    const dir = tmpdir('taskcancel-resume-');
    const session = new Session({ cwd: dir });
    session.task = new taskId.Task('task A: the login work');
    const { Plan } = require('../../src/plan');
    session.plan = new Plan('task A: the login work');
    session.plan.addSteps(['step one']);
    const app = appWith(session);
    identify(app, 'Cancel the current task. Task B: diagnose Calculator using Computer MCP.', false, null, false);
    app.session.save();

    const resumed = Session.resume(app.session.id);
    assert.match(resumed.task.objective, /Task B/, 'the resumed session carries B');
    assert.ok(!/task A/i.test(resumed.task.objective), 'A is not the resumed objective');
    assert.strictEqual(resumed.plan, null, 'A\'s plan did not survive the round trip either');
  });

  await test('CANCEL: only real, typed cancellation retires the task — Noema\'s own machinery cannot', () => {
    // sameTask=true is asserted only by LAIN's own machinery (a Continue
    // button, a relay). Even if that path's text happened to contain
    // cancel-shaped words, the machinery's OWN assertion of sameTask must
    // still be honoured for genuine continuations — task.classify never even
    // runs "cancelled" logic against sameTask=true callers because identify.js
    // consults the classifier's own verdict, and the classifier only ever
    // returns cancelled against typed text through the normal path.
    const dir = tmpdir('taskcancel-machinery-');
    const session = new Session({ cwd: dir });
    session.task = new taskId.Task('ongoing work');
    const outgoing = session.task;
    const app = appWith(session);
    identify(app, 'continue working on the same thing', false, null, true);
    assert.strictEqual(app.session.task, outgoing, 'machinery-asserted continuation keeps the same task');
    assert.strictEqual(outgoing.state, taskId.STATE.ACTIVE);
  });
};
