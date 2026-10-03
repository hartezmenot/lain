'use strict';

/** HOW FAR ALONG THE WORK IS — the one answer, and the one bar that draws it. */

/** THE PLAN THE CURRENT WORK IS FOLLOWING, or null. */
function livePlan(session) {
  const plan = session && session.plan;
  // WHILE THE PLAN IS BEING DISCUSSED THERE IS NO EXECUTION PROGRESS (§12):
  // PLAN mode shows `PLAN · discussing`, never `3/8`. See ui/headerstate.js.
  if (require('../execmode').of(session) === 'PLAN') return null;
  return plan && plan.isLive !== false ? plan : null;
}

/** PROGRESS FROM COMPLETED WORK, never from the active step's index. */
function progressOf(plan) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
    return { known: false, completed: 0, total: 0, current: 0, percent: null };
  }
  const steps = plan.steps.filter((s) => s.status !== 'dropped');
  const total = steps.length;
  const completed = steps.filter((s) => s.status === 'done').length;
  const activeIdx = steps.findIndex((s) => s.status === 'active');
  const current = activeIdx >= 0 ? activeIdx + 1 : Math.min(completed + 1, total);
  return {
    known: true,
    completed,
    total,
    current: completed >= total ? total : current,
    percent: Math.round((completed / total) * 100),
  };
}

function bar(percent, width = 22) {
  if (percent == null) return '─'.repeat(width);
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** `STEP 3/5  ████████░░░░  40%` — the whole progress state on one line. */
function progressCompact(p, width) {
  // NEVER THE WORD "DONE" HERE.
  const left = `STEP ${p.current}/${p.total}`;
  const right = `${p.percent}%`;
  const barW = Math.max(4, Math.min(18, width - left.length - right.length - 4));
  return `${left}  ${bar(p.percent, barW)}  ${right}`;
}

module.exports = { livePlan, progressOf, bar, progressCompact };
