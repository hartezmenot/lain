'use strict';

/**
 * CONTINUE MEANS CONTINUE.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT: every action shelf had a button called `Continue`, and on the
 * Goal shelf it meant `goal.activate` and nothing else. So
 *
 *     Finish native LAIN Harness   [Continue] [Edit] [New] [Delete]
 *
 * selected the goal and then waited for the person to type the word "continue"
 * at it. The Plan shelf's Continue was worse: it fell through to no branch at
 * all, so the button did exactly what Escape did.
 *
 * ------------------------------------------------------------------------
 * WHAT IS PINNED HERE:
 *
 *   Continue STARTS WORK, and resumes at the first UNFINISHED step
 *   it does NOT send the word "continue" to the model
 *   a completed goal is not silently re-run, and reopening keeps the evidence
 *   a busy session QUEUES rather than refusing — and the queue really runs
 *   /resume is navigation and starts nothing, which is the point of naming
 *   the three actions separately
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

const cont = require('../../src/continueactions');
const goal = require('../../src/goal');
const { Plan, STATUS } = require('../../src/plan');
const { Session } = require('../../src/session');

/** An app whose only job is to record what was submitted. */
function appWith(session, { running = false } = {}) {
  const submitted = [];
  return {
    session,
    abort: running ? new AbortController() : null,
    submitted,
    submit(text, opts) { submitted.push({ text, opts }); return 'submitted'; },
  };
}

function sessionWithGoal(text = 'Finish native Noema Harness') {
  const s = new Session({ cwd: tmpdir('cont-') });
  goal.create(s, text);
  return s;
}

function planOf(session, steps, doneCount = 0) {
  session.plan = new Plan('finish the harness');
  session.plan.addSteps(steps);
  for (let i = 0; i < doneCount; i++) session.plan.complete('done');
  return session.plan;
}

module.exports = async function () {
  await test('GOAL_CONTINUE: it STARTS WORK rather than selecting a goal and waiting', async () => {
    const s = sessionWithGoal();
    planOf(s, ['PTY', 'Workshop', 'packaging']);
    const app = appWith(s);

    const r = await cont.goalContinue(app, goal.id(s));
    assert.strictEqual(r.action, cont.ACTION.GOAL_CONTINUE, 'the action is NAMED, not generic');
    assert.strictEqual(r.outcome, cont.OUTCOME.STARTED);
    assert.strictEqual(app.submitted.length, 1, 'a turn was actually started');
    assert.strictEqual(app.submitted[0].opts.from, 'continue', 'and the origin says a shelf started it');
  });

  await test('GOAL_CONTINUE: it does NOT send the word "continue" to the model', async () => {
    // "continue" is a sentence with no referent: the model re-reads the project
    // to work out what it was doing, which is the same-state loop the findings
    // record exists to stop.
    const s = sessionWithGoal();
    planOf(s, ['PTY', 'Workshop', 'packaging']);
    const app = appWith(s);
    await cont.goalContinue(app, goal.id(s));
    const text = app.submitted[0].text;

    assert.notStrictEqual(text.trim().toLowerCase(), 'continue');
    assert.match(text, /Finish native Noema Harness/, 'the goal is named');
    assert.match(text, /step 1 of 3/, 'and the position in the plan');
    assert.match(text, /Do not re-read files/, 'and it says not to rediscover what is recorded');
  });

  await test('GOAL_CONTINUE: it resumes at the first UNFINISHED step, never at step 1', async () => {
    // §12. Restarting a plan from the top is the loop, not the fix for it.
    const s = sessionWithGoal();
    planOf(s, ['PTY', 'Workshop', 'packaging'], 2);
    const app = appWith(s);
    await cont.goalContinue(app, goal.id(s));

    assert.match(app.submitted[0].text, /Resume at plan step 3 of 3: packaging/);
    assert.ok(!/step 1 of 3/.test(app.submitted[0].text), 'it does not go back to the beginning');
  });

  await test('GOAL_CONTINUE: with no plan it still begins work', async () => {
    // §13. Requiring another user message because a plan is absent is the same
    // defect wearing a different excuse.
    const s = sessionWithGoal('Finish fixture frontend');
    const app = appWith(s);
    const r = await cont.goalContinue(app, goal.id(s));
    assert.strictEqual(r.outcome, cont.OUTCOME.STARTED);
    assert.match(app.submitted[0].text, /no plan yet/i);
    assert.match(app.submitted[0].text, /Finish fixture frontend/);
  });

  await test('GOAL_CONTINUE: a PAUSED goal is activated and then worked on', async () => {
    const s = sessionWithGoal('first goal');
    const firstId = goal.id(s);
    goal.create(s, 'second goal');          // pauses the first
    assert.notStrictEqual(goal.id(s), firstId);

    const app = appWith(s);
    const r = await cont.goalContinue(app, firstId);
    assert.strictEqual(r.outcome, cont.OUTCOME.STARTED);
    assert.strictEqual(goal.id(s), firstId, 'it became the active goal');
    assert.match(app.submitted[0].text, /first goal/);
  });

  await test('COMPLETED: a finished goal is not silently re-run', async () => {
    // §14. Re-executing work somebody declared done, and writing over the
    // evidence that it was done, is the worst thing this button could do.
    const s = sessionWithGoal();
    const id = goal.id(s);
    cont.complete(s, id);
    const app = appWith(s);

    const r = await cont.goalContinue(app, id);
    assert.strictEqual(r.outcome, cont.OUTCOME.COMPLETED);
    assert.strictEqual(app.submitted.length, 0, 'and nothing was executed');
  });

  await test('COMPLETED: reopening starts work AND keeps the completion evidence', async () => {
    const s = sessionWithGoal();
    const id = goal.id(s);
    const record = cont.complete(s, id);
    const finishedAt = record.completedAt;
    const app = appWith(s);

    const r = await cont.goalContinue(app, id, { reopen: true });
    assert.strictEqual(r.outcome, cont.OUTCOME.STARTED);
    assert.strictEqual(s.goal.completedAt, null, 'it is active again');
    assert.strictEqual(s.goal.reopenedFrom, finishedAt,
      'and the fact that it was once finished is still on the record');
  });

  await test('COMPLETED: only a PERSON can set it — nothing infers it', () => {
    // goal.js deliberately had no completion state: "a state no code sets is a
    // promise, not a fact". A person saying so IS an observation; LAIN deciding
    // it is not, and nothing here does.
    const s = sessionWithGoal();
    planOf(s, ['one'], 1);                     // every step finished
    assert.strictEqual(cont.isCompleted(s.goal), false,
      'a finished plan does not mark the goal complete');
    cont.complete(s, goal.id(s));
    assert.strictEqual(cont.isCompleted(s.goal), true);
  });

  await test('QUEUED: a busy session queues the work instead of refusing it', async () => {
    // §16. "a turn is running — stop it or let it finish" is a refusal. The
    // person asked for the work, not for permission.
    const s = sessionWithGoal();
    planOf(s, ['PTY', 'Workshop']);
    const app = appWith(s, { running: true });

    const r = await cont.goalContinue(app, goal.id(s));
    assert.strictEqual(r.outcome, cont.OUTCOME.QUEUED);
    assert.match(r.why, /queued/i);
    assert.ok(!/stop it or let it finish/i.test(r.why), 'it is not the old refusal');
    assert.strictEqual(app.submitted.length, 0, 'nothing ran yet');
    assert.ok(app._queuedContinue, 'and it is remembered');
  });

  await test('QUEUED: it really runs when the turn ahead of it finishes', async () => {
    // QUEUED has to mean it runs, or it is the refusal with a nicer word on it.
    const close = require('../../src/submitclose');
    const s = sessionWithGoal();
    planOf(s, ['PTY', 'Workshop']);
    const app = appWith(s, { running: true });
    app.wantExit = false;
    app.drainSteers = () => [];
    app.ui = { enabled: false };
    app.events = { emit() {} };
    await cont.goalContinue(app, goal.id(s));

    await close.after(app, { text: 'the turn before it finished', stopReason: 'end' }, 'x');
    assert.strictEqual(app.submitted.length, 1, 'the queued continuation ran');
    assert.match(app.submitted[0].text, /Finish native Noema Harness/);
    assert.strictEqual(app._queuedContinue, null, 'and it is not run twice');
  });

  await test('QUEUED: a CANCELLED turn drops it — Ctrl+C means stop', async () => {
    const close = require('../../src/submitclose');
    const s = sessionWithGoal();
    const app = appWith(s, { running: true });
    app.wantExit = false;
    app.drainSteers = () => [];
    app.ui = { enabled: false };
    app.events = { emit() {} };
    await cont.goalContinue(app, goal.id(s));

    await close.after(app, null, 'x');         // null record = interrupted
    assert.strictEqual(app.submitted.length, 0, 'starting fresh work out of Ctrl+C is the opposite of stopping');
    assert.strictEqual(app._queuedContinue, null);
  });

  await test('PLAN_CONTINUE: it resumes the plan, and says so when there is nothing left', async () => {
    // §18. This button used to fall through to no branch at all.
    const s = sessionWithGoal();
    planOf(s, ['PTY', 'Workshop', 'packaging'], 1);
    const app = appWith(s);

    const r = await cont.planContinue(app);
    assert.strictEqual(r.action, cont.ACTION.PLAN_CONTINUE);
    assert.strictEqual(r.outcome, cont.OUTCOME.STARTED);
    assert.strictEqual(r.step, 2);
    assert.match(app.submitted[0].text, /Resume at plan step 2 of 3: Workshop/);

    const done = sessionWithGoal();
    planOf(done, ['only'], 1);
    const app2 = appWith(done);
    const r2 = await cont.planContinue(app2);
    assert.strictEqual(r2.outcome, cont.OUTCOME.NOTHING_TO_DO);
    assert.strictEqual(app2.submitted.length, 0, 'it does not start a turn to discover there is nothing to do');

    const noPlan = appWith(sessionWithGoal());
    assert.strictEqual((await cont.planContinue(noPlan)).outcome, cont.OUTCOME.NOTHING_TO_DO);
  });

  await test('SESSION_RESUME: opening a session starts NOTHING, on purpose', () => {
    // §19. A button named Continue that submitted work because you opened a
    // transcript is the same defect in the other direction.
    const s = sessionWithGoal();
    const app = appWith(s);
    const r = cont.sessionResume(app, 'abc123');
    assert.strictEqual(r.action, cont.ACTION.SESSION_RESUME);
    assert.strictEqual(r.outcome, cont.OUTCOME.NOTHING_TO_DO);
    assert.strictEqual(app.submitted.length, 0);
  });

  await test('CONTRACT: the three actions are NAMED, not one generic continue()', () => {
    // §20. A single function whose meaning depends on which menu invoked it is
    // the same ambiguity with a stack frame around it.
    assert.deepStrictEqual(Object.keys(cont.ACTION).sort(),
      ['GOAL_CONTINUE', 'PLAN_CONTINUE', 'SESSION_RESUME']);
    assert.strictEqual(typeof cont.continue, 'undefined', 'there is no generic continue()');
    for (const name of ['goalContinue', 'planContinue', 'sessionResume']) {
      assert.strictEqual(typeof cont[name], 'function', `${name} is its own entry point`);
    }
  });

  await test('IDENTITY: continuing a plan that has no task yet does NOT discard the plan', () => {
    // FOUND IN A REAL TERMINAL, missed by every case above: their fake submit
    // never reached identify. `/goal` and `/plan` are commands, not turns, so a
    // plan can exist with no task object — and the continuation was classified
    // as a NEW task, which set plan = null. The button wiped what it continued.
    process.env.LAIN_PROVIDER = 'mock';
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('contid-') });
    planOf(app.session, ['change heading', 'verify mobile', 'capture evidence']);
    assert.strictEqual(app.session.task, null, 'the precondition: no task has been classified yet');
    const plan = app.session.plan;

    app.identify('Continue working toward this goal: Finish fixture frontend', false, null, true);
    assert.strictEqual(app.session.plan, plan, 'the machinery said it continues this plan, so it is kept');

    // AND TYPED INPUT CANNOT ASSERT IT: an ordinary new request still starts clean.
    const other = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('contid2-') });
    planOf(other.session, ['a', 'b']);
    other.identify('build me a completely different thing', false, null, false);
    assert.strictEqual(other.session.plan, null, 'a genuinely new task does not inherit the plan');
  });

  await test('STATE: the step is found using plan.js\'s OWN status values', () => {
    // Written as 'ACTIVE'/'DONE' this matched nothing — plan.js uses lower case
    // — and every continuation would have restarted at step 1, which is the
    // exact behaviour this file exists to prevent.
    const s = sessionWithGoal();
    const plan = planOf(s, ['a', 'b', 'c'], 2);
    const step = cont.pendingStep(plan);
    assert.strictEqual(step.n, 3);
    assert.strictEqual(step.status, STATUS.ACTIVE);
  });
};
