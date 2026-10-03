'use strict';

/** CONTINUING SOMETHING — and three different things are meant by it. */

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

/** IS A GOAL FINISHED? Only a PERSON can say so. */
function isCompleted(g) { return Boolean(g && g.completedAt); }

function findGoal(session, goalId) {
  const all = goal.list(session);
  return all.find((g) => g.id === goalId) || null;
}

/** The step a plan should carry on at: the first that is not finished. */
function pendingStep(plan) {
  if (!plan || !Array.isArray(plan.steps)) return null;
  const { STATUS } = require('./plan');
  const active = plan.steps.find((s) => s.status === STATUS.ACTIVE);
  if (active) return active;
  return plan.steps.find((s) => s.status !== STATUS.DONE && s.status !== STATUS.DROPPED) || null;
}

/** THE INSTRUCTION, BUILT FROM WHAT IS ALREADY KNOWN. */
function instruction({ goalText = '', step = null, plan = null }) {
  const lines = [];
  if (goalText) lines.push(`Continue working toward this goal: ${goalText}`);
  else lines.push('Continue the work in hand.');

  if (step && plan) {
    // THE COMMITTED POSITION, counted the one way every surface counts (plan.position): "step 3 of 5".
    const pos = typeof plan.position === 'function' ? plan.position(step) : { index: step.n, total: plan.steps.length };
    lines.push(`Resume at plan step ${pos.index} of ${pos.total}: ${step.text}`);
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

/** GOAL_CONTINUE — make the goal active and RESUME THE WORK. */
async function goalContinue(app, goalId, { reopen = false } = {}) {
  const session = app && app.session;
  const target = session ? findGoal(session, goalId) : null;
  if (!target) return { action: ACTION.GOAL_CONTINUE, outcome: OUTCOME.UNKNOWN, why: 'that goal is not in this session' };

  // A FINISHED GOAL IS NOT SILENTLY RE-RUN
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

/** PLAN_CONTINUE — resume executing the plan at its first unfinished step. */
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

/** START THE TURN — or say it is QUEUED, which is a different sentence from "stop it or let it finish". */
async function start(app, action, text, extra = {}) {
  const running = Boolean(app && app.abort);
  if (running) {
    app._queuedContinue = { action, text, at: Date.now(), ...extra };
    return { action, outcome: OUTCOME.QUEUED, why: 'a turn is running in this session; this is queued behind it', ...extra };
  }
  // `from` names the origin so the admission trail says a shelf started this, not a person typing.
  const submitted = app.submit(text, { from: 'continue', sameTask: true });
  if (submitted && typeof submitted.catch === 'function') {
    submitted.catch((e) => {
      const why = (e && e.message) || String(e);
      try { app.render.write(`  continuing failed: ${why}\n`); } catch { /* no surface */ }
    });
  }
  return { action, outcome: OUTCOME.STARTED, text, submitted, ...extra };
}

/** SESSION_RESUME — open a session. */
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
