'use strict';

/** THE TASK STATE MACHINE — eight states, and the legal moves between them. */

const STATE = Object.freeze({
  PLANNED: 'PLANNED',
  RUNNING: 'RUNNING',
  BLOCKED: 'BLOCKED',
  VERIFYING: 'VERIFYING',
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  INCONCLUSIVE: 'INCONCLUSIVE',
  CANCELLED: 'CANCELLED',
});

const NAMES = Object.freeze(Object.values(STATE));

/** States in which the task is over and its record will not change again. */
const TERMINAL = Object.freeze(new Set([
  STATE.PASSED, STATE.FAILED, STATE.INCONCLUSIVE, STATE.CANCELLED,
]));

/** The task reached a verdict about the work itself, rather than being stopped. */
const VERDICT = Object.freeze(new Set([STATE.PASSED, STATE.FAILED, STATE.INCONCLUSIVE]));

/** THE LEGAL MOVES. Anything not listed is refused, with the reason named. */
const MOVES = Object.freeze({
  [STATE.PLANNED]: Object.freeze([STATE.RUNNING, STATE.BLOCKED, STATE.CANCELLED]),
  [STATE.RUNNING]: Object.freeze([STATE.BLOCKED, STATE.VERIFYING, STATE.CANCELLED, STATE.FAILED]),
  [STATE.BLOCKED]: Object.freeze([STATE.RUNNING, STATE.CANCELLED, STATE.FAILED]),
  [STATE.VERIFYING]: Object.freeze([
    STATE.PASSED, STATE.FAILED, STATE.INCONCLUSIVE, STATE.RUNNING, STATE.CANCELLED,
  ]),
  // Terminal. Named explicitly rather than left undefined, so `moves()` can answer "nothing" without the caller having to know the difference between "no…
  [STATE.PASSED]: Object.freeze([]),
  [STATE.FAILED]: Object.freeze([]),
  [STATE.INCONCLUSIVE]: Object.freeze([]),
  [STATE.CANCELLED]: Object.freeze([]),
});

/** VERIFYING -> RUNNING is deliberate and is the recovery seam. */

function isState(s) { return NAMES.includes(String(s)); }

function moves(from) {
  return MOVES[String(from)] || [];
}

/** May the task go from `from` to `to`? */
function transition(from, to) {
  if (!isState(from)) return { ok: false, why: `"${from}" is not a task state` };
  if (!isState(to)) return { ok: false, why: `"${to}" is not a task state` };
  if (from === to) return { ok: true, why: 'already there' };
  if (TERMINAL.has(from)) {
    return { ok: false, why: `the task is already ${from}, and a terminal state is never rewritten` };
  }
  if (!moves(from).includes(to)) {
    return {
      ok: false,
      why: `${from} cannot become ${to} — a task reaches ${to} only from ${
        NAMES.filter((s) => moves(s).includes(to)).join(' or ') || 'nowhere'}`,
    };
  }
  return { ok: true, why: '' };
}

/** THE VERDICT MAP — a verification result becomes a task state, and this is the only place that conversion happens. */
function fromVerdict(verdict) {
  const v = String(verdict || '').toUpperCase();
  if (v === 'PASSED') return STATE.PASSED;
  if (v === 'FAILED') return STATE.FAILED;
  if (v === 'INCONCLUSIVE') return STATE.INCONCLUSIVE;
  return null;
}

/** THE ONE BRIDGE FROM lifecycle.js, and it is a READ. */
function fromLifecycle(lifecycleState) {
  switch (String(lifecycleState || '')) {
    case 'DONE': return STATE.VERIFYING;
    case 'BLOCKED': return STATE.BLOCKED;
    case 'NEEDS_USER': return STATE.BLOCKED;
    case 'NEEDS_AUTH': return STATE.BLOCKED;
    case 'FAILED': return STATE.FAILED;
    default: return null;
  }
}

/** A one-word colour for a surface that draws states. Not a judgement, a hue. */
const TONE = Object.freeze({
  [STATE.PLANNED]: 'idle',
  [STATE.RUNNING]: 'busy',
  [STATE.BLOCKED]: 'warn',
  [STATE.VERIFYING]: 'busy',
  [STATE.PASSED]: 'good',
  [STATE.FAILED]: 'bad',
  [STATE.INCONCLUSIVE]: 'warn',
  [STATE.CANCELLED]: 'idle',
});

module.exports = { STATE, NAMES, TERMINAL, VERDICT, MOVES, TONE, isState, moves, transition, fromVerdict, fromLifecycle };
