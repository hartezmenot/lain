'use strict';

/**
 * CONTINUING SOMETHING — and three different things are meant by it.
 *
 * ------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL.
 *
 * Every action shelf had a button called `Continue`, and each one did whatever
 * `continue` happened to mean in that menu. On the Goal shelf it meant "make
 * this the active goal" — so clicking Continue on
 *
 *     Finish native LAIN Harness   [Continue] [Edit] [New] [Delete]
 *
 * selected the goal and then sat there waiting for the person to type the word
 * "continue" at it. That is not what the button says.
 *
 * The fix is not a smarter `continue()`. A single function whose meaning
 * depends on which menu invoked it is the same ambiguity with a stack frame
 * around it. So there are three named actions, and a caller has to say which
 * one it means:
 *
 *   GOAL_CONTINUE     resume work toward a goal. STARTS A TURN.
 *   PLAN_CONTINUE     resume execution of a plan. STARTS A TURN.
 *   SESSION_RESUME    open a conversation. STARTS NOTHING.
 *
 * The third is deliberately not like the other two. `/resume` is navigation —
 * you are asking to look at a session, and a button that silently submitted
 * work because you opened a transcript would be the same defect in the other
 * direction.
 *
 * ------------------------------------------------------------------------
 * IT DOES NOT SEND THE WORD "CONTINUE" TO THE MODEL.
 *
 * That was the obvious implementation and it is the one that recreates the
 * problem: "continue" is a sentence with no referent, so the model re-reads the
 * project to work out what it was doing — which is the same-state loop the
 * findings record and the non-progress gate exist to stop.
 *
 * What is sent instead is resolved from DURABLE STATE that Core already holds:
 * the goal's words, the plan's position, the step's settled findings, what the
 * mutation ledger says actually landed, and what remains. The plan digest is
 * already on every prompt (promptparts.js); this adds the instruction that
 * names the next legitimate step and says not to re-derive what is listed.
 */

const goal = require('./goal');

/** The three, named. A caller passes one of these, never a string it invented. */
const ACTION = Object.freeze({
  GOAL_CONTINUE: 'GOAL_CONTINUE',
  PLAN_CONTINUE: 'PLAN_CONTINUE',
  SESSION_RESUME: 'SESSION_RESUME',
});

/** Why a continuation did not start work. Each is a fact, not a failure. */
const OUTCOME = Object.freeze({
  STARTED: 'STARTED',
  QUEUED: 'QUEUED',
  COMPLETED: 'COMPLETED',
  NOTHING_TO_DO: 'NOTHING_TO_DO',
  UNKNOWN: 'UNKNOWN',
});

/**
 * IS A GOAL FINISHED? Only a PERSON can say so.
 *
 * `goal.js` deliberately had no completion state, for a reason worth keeping:
 * "nothing here can observe that a goal was achieved, and a state no code sets
 * is a promise, not a fact." That reasoning rules out LAIN inferring
 * completion. It does not rule out the person declaring it — a person saying
 * "this is done" IS an observation, and it is the only one available.
 *
 * So completion is recorded on the goal record, set from the shelf, and never
 * inferred from anything.
 */
function isCompleted(g) { return Boolean(g && g.completedAt); }

function findGoal(session, goalId) {
  const all = goal.list(session);
  return all.find((g) => g.id === goalId) || null;
}

/**
 * The step a plan should carry on at: the first that is not finished.
 *
 * THE STATUS VALUES ARE PLAN.JS'S, imported rather than spelled. Written as
 * 'ACTIVE'/'DONE' this silently matched nothing — plan.js uses lower case — and
 * a continuation would have restarted at step 1 every time, which is precisely
 * the behaviour this whole file exists to prevent.
 */
function pendingStep(plan) {
  if (!plan || !Array.isArray(plan.steps)) return null;
  const { STATUS } = require('./plan');
  const active = plan.steps.find((s) => s.status === STATUS.ACTIVE);
  if (active) return active;
  return plan.steps.find((s) => s.status !== STATUS.DONE && s.status !== STATUS.DROPPED) || null;
}

/**
 * THE INSTRUCTION, BUILT FROM WHAT IS ALREADY KNOWN.
 *
 * Deliberately short. The plan, its findings and the derived LANDED list are
 * already on the prompt every turn — repeating them here would be a second copy
 * of the same truth, free to drift. What this adds is the thing the prompt does
 * NOT carry: which of the remaining steps to pick up, and an explicit
 * instruction not to rediscover what the record already states.
 */
function instruction({ goalText = '', step = null, plan = null }) {
  const lines = [];
  if (goalText) lines.push(`Continue working toward this goal: ${goalText}`);
  else lines.push('Continue the work in hand.');

  if (step && plan) {
    lines.push(`Resume at plan step ${step.n} of ${plan.steps.length}: ${step.text}`);
  } else if (plan) {
    lines.push('Every step of the plan is finished — verify the goal is met, or say what remains.');
  } else {
    lines.push('There is no plan yet. Make a bounded one if the work needs it, otherwise do the work.');
  }

  // THE ANTI-REDISCOVERY CLAUSE, which is the whole point of continuing from
  // state rather than from the word "continue".
  lines.push('The plan section above records what is already settled and what has already landed. '
    + 'Do not re-read files to re-establish any of it. Start from the first thing that is actually unfinished.');
  return lines.join('\n');
}

/**
 * GOAL_CONTINUE — make the goal active and RESUME THE WORK.
 *
 * @returns {{action, outcome, why, goalId, submitted}}
 */
async function goalContinue(app, goalId, { reopen = false } = {}) {
  const session = app && app.session;
  const target = session ? findGoal(session, goalId) : null;
  if (!target) return { action: ACTION.GOAL_CONTINUE, outcome: OUTCOME.UNKNOWN, why: 'that goal is not in this session' };

  // ---- A FINISHED GOAL IS NOT SILENTLY RE-RUN -------------------------
  //
  // Re-executing work somebody already declared done — and writing over the
  // evidence that it was done — is the worst thing this button could do.
  const record = (session.goal && session.goal.id === goalId)
    ? session.goal
    : (session.pausedGoals || []).find((p) => p.id === goalId);
  if (isCompleted(record) && !reopen) {
    return {
      action: ACTION.GOAL_CONTINUE, outcome: OUTCOME.COMPLETED, goalId,
      why: 'that goal is already completed', text: target.text,
    };
  }
  if (isCompleted(record) && reopen) {
    // REOPENING KEEPS THE EVIDENCE. `completedAt` moves to `reopenedFrom` so
    // the fact that it was once finished is still on the record.
    record.reopenedFrom = record.completedAt;
    record.completedAt = null;
  }

  if (target.state !== goal.STATE.ACTIVE) goal.activate(session, goalId);
  try { session.save(); } catch { /* the change still holds for this run */ }

  const plan = session.plan && session.plan.steps && session.plan.steps.length ? session.plan : null;
  const step = pendingStep(plan);
  const text = instruction({ goalText: target.text, step, plan });
  return start(app, ACTION.GOAL_CONTINUE, text, { goalId });
}

/**
 * PLAN_CONTINUE — resume executing the plan at its first unfinished step.
 *
 * Same semantics as GOAL_CONTINUE and for the same reason: the button says
 * Continue, so it continues. A plan with nothing left says so rather than
 * starting a turn to discover that.
 */
async function planContinue(app) {
  const session = app && app.session;
  const plan = session && session.plan && session.plan.steps && session.plan.steps.length ? session.plan : null;
  if (!plan) return { action: ACTION.PLAN_CONTINUE, outcome: OUTCOME.NOTHING_TO_DO, why: 'there is no plan in this session' };
  const step = pendingStep(plan);
  if (!step) {
    return { action: ACTION.PLAN_CONTINUE, outcome: OUTCOME.NOTHING_TO_DO, why: 'every step of this plan is finished' };
  }
  const text = instruction({ goalText: goal.text(session), step, plan });
  return start(app, ACTION.PLAN_CONTINUE, text, { step: step.n });
}

/**
 * START THE TURN — or say it is QUEUED, which is a different sentence from
 * "stop it or let it finish".
 *
 * A turn already running in THIS session is a real constraint: one conversation
 * has one turn at a time. But it is a scheduling fact, not a refusal, and the
 * person asked for the work rather than for permission. See sessionpool.js for
 * why navigation was separated from execution in the first place.
 */
async function start(app, action, text, extra = {}) {
  const running = Boolean(app && app.abort);
  if (running) {
    app._queuedContinue = { action, text, at: Date.now(), ...extra };
    return { action, outcome: OUTCOME.QUEUED, why: 'a turn is running in this session; this is queued behind it', ...extra };
  }
  // `from` names the origin so the admission trail says a shelf started this,
  // not a person typing. The text is the model's instruction, not a UI label.
  //
  // NOT AWAITED, ON PURPOSE: the shelf must close now and the turn runs for as
  // long as it runs — §17. But a promise nobody holds is a promise whose
  // rejection takes the process down, so the failure is caught and reported
  // where a person can see it rather than becoming an unhandled rejection.
  const submitted = app.submit(text, { from: 'continue', sameTask: true });
  if (submitted && typeof submitted.catch === 'function') {
    submitted.catch((e) => {
      const why = (e && e.message) || String(e);
      try { app.render.write(`  continuing failed: ${why}\n`); } catch { /* no surface */ }
    });
  }
  return { action, outcome: OUTCOME.STARTED, text, submitted, ...extra };
}

/**
 * SESSION_RESUME — open a session. It starts nothing, ON PURPOSE.
 *
 * `/resume` is navigation. The one exception this leaves room for is a session
 * with an explicitly resumable interrupted operation, which is a fact about
 * that session rather than a default for all of them.
 */
function sessionResume(app, sessionId) {
  return { action: ACTION.SESSION_RESUME, outcome: OUTCOME.NOTHING_TO_DO, sessionId,
    why: 'opening a session does not start work — ask for something, or continue its goal or plan' };
}

/** Mark a goal finished, by a person's say-so and nothing else. */
function complete(session, goalId) {
  const record = (session.goal && session.goal.id === goalId)
    ? session.goal
    : (session.pausedGoals || []).find((p) => p.id === goalId);
  if (!record) return null;
  record.completedAt = new Date().toISOString();
  return record;
}

module.exports = {
  ACTION, OUTCOME, goalContinue, planContinue, sessionResume,
  complete, isCompleted, pendingStep, instruction,
};
