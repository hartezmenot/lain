'use strict';

/** TURNING A TYPED LINE INTO PLAN STEPS — and the ONE owner that does it. */

/** How a typed plan line is broken into steps. Arrows and explicit separators. */
const SEPARATORS = /\s*(?:→|->|;|\n|\s\|\s)\s*/;

/** A plan is a strategy, not a specification. */
const MAX_STEPS = 40;

/** Split a typed line into step texts. Pure, deterministic, no model call. */
function split(line) {
  return String(line == null ? '' : line)
    .split(SEPARATORS)
    .map((s) => s.trim())
    // A leading list marker is punctuation people type, not part of the step.
    .map((s) => s.replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_STEPS);
}

/** THE CURRENT PLAN AS A LINE, for the composer to prefill with. */
function asLine(plan) {
  if (!plan || !plan.steps || !plan.steps.length) return '';
  return plan.remaining.map((s) => s.text).join(' → ');
}

/** COMMIT A COMPOSED PLAN LINE. */
function commit(app, mode, line) {
  const { Plan } = require('./plan');
  const session = app && app.session;
  if (!session) return null;
  const steps = split(line);
  if (!steps.length) return null;

  // NEW: the plan in hand MOVES to `planHistory`, unmutated — its completed steps are evidence about work that happened, and a new strategy must not…
  if (mode === 'new' && session.plan) {
    session.planHistory = (session.planHistory || []).concat(session.plan).slice(-5);   // moved, NOT retired: superseded is not completed (goalplan guard)
    session.plan = null;
  }
  if (!session.plan) {
    session.plan = new Plan(session.task ? session.task.objective : 'session plan');
  }
  const plan = session.plan;

  if (mode === 'replace') {
    // REPLACE MEANS THE STRATEGY, NOT THE HISTORY
    const drop = plan.remaining.map((s) => s.n);
    plan.steer(`plan replaced by the user: ${line}`.slice(0, 200), { drop });
    plan.addSteps(steps, { origin: 'user' });
  } else {
    plan.addSteps(steps, { origin: 'user' });
  }
  // NO RECEIPT: the plan is state, not news — `/plan` shows it on its shelf. It IS a checkpoint: committed now.
  try { require('./taskcheckpoint').commit(session, mode === 'replace' ? 'plan replaced by the person' : 'steps added by the person'); } catch { /* the plan stands */ }
  return plan;
}

module.exports = { split, asLine, commit, SEPARATORS, MAX_STEPS };
