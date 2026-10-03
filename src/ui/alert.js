'use strict';

/** A STALE ALERT IS NOT THE NEWS — what an amber or red resting state means, and what a new submission does to it. */

const { FAILURE } = require('./failure');

/** What a new submission does to the clock. */
const ATTEMPT = Object.freeze({
  /** A different task. Zero the clock — see workclock.start. */
  FRESH: 'fresh',
  /** The same attempt carrying on after a pause or a block. Resume banked work. */
  CONTINUE: 'continue',
  /** The same task, but the previous attempt is over. A new attempt from zero. */
  RESTART: 'restart',
});

/** FAILURE KINDS THAT LEAVE THE ATTEMPT INTACT. */
const BLOCKED_KINDS = new Set(['RATE_LIMITED', 'AUTH', 'CONTEXT_LIMIT']);

/** IS THIS FAILURE RECOVERABLE WITHOUT STARTING OVER? */
function blocked(failed) {
  if (!failed || typeof failed !== 'object') return false;
  const kind = String(failed.kind || '');
  return BLOCKED_KINDS.has(kind) && Object.prototype.hasOwnProperty.call(FAILURE, kind);
}

/** THE RESTING ALERT, IF THERE IS ONE — a reading, not the state itself. */
function resting(ui, now = Date.now()) {
  const none = { level: null, word: '', resumable: false, terminal: false };
  if (!ui) return none;
  if (ui.waitingUntil && ui.waitingUntil > now) {
    return { level: 'amber', word: 'WAITING FOR LIMIT RESET', resumable: true, terminal: false };
  }
  if (ui.interrupting) return { level: 'amber', word: 'INTERRUPTING', resumable: true, terminal: false };
  if (ui.retryCancelled) return { level: 'amber', word: 'RETRY CANCELLED', resumable: true, terminal: false };
  if (ui.interrupted) return { level: 'amber', word: 'INTERRUPTED', resumable: true, terminal: false };
  if (ui.failed) {
    const soft = blocked(ui.failed);
    return { level: 'red', word: soft ? 'BLOCKED' : 'ERROR', resumable: soft, terminal: !soft };
  }
  return none;
}

/** WHAT THIS SUBMISSION SHOULD DO TO THE CLOCK. */
function attemptFor(ui, verdict, now = Date.now()) {
  if (!verdict || !verdict.sameTask) return ATTEMPT.FRESH;
  // ONLY A PAUSED OR BLOCKED ATTEMPT CARRIES ON.
  const paused = Boolean(ui && ui.clock && ui.clock.state === 'PAUSED');
  const r = resting(ui, now);
  const held = r.word === 'WAITING FOR LIMIT RESET' || r.word === 'BLOCKED';
  if (paused || held) return ATTEMPT.CONTINUE;
  if (r.resumable && verdict.kind === require('../task').KIND.CONTINUATION) return ATTEMPT.CONTINUE;
  return ATTEMPT.RESTART;
}

/** THE SUBMISSION WAS ACCEPTED — every stale alert stops being the resting state. */
function clearResting(ui) {
  if (!ui) return { cleared: [] };
  const cleared = [];
  const r = resting(ui);
  if (r.level) cleared.push(r.word);

  ui.waitingUntil = 0;
  ui.waitingLabel = '';
  ui.interrupted = false;
  ui.interrupting = false;
  ui.retryCancelled = false;
  ui.failed = false;
  return { cleared };
}

/** END A PENDING PROVIDER WAIT, ON THE CONTROLLER IT IS ACTUALLY LISTENING TO. */
function cancelPendingWait(app) {
  const ui = app && app.ui;
  if (!ui || !ui.waitingUntil) return { cancelled: false };
  try {
    if (app.abort && !app.abort.signal.aborted) {
      app.abort.abort();
      return { cancelled: true };
    }
  } catch { /* no controller: the field clearing in clearResting still applies */ }
  return { cancelled: false };
}

module.exports = { ATTEMPT, resting, attemptFor, clearResting, cancelPendingWait, blocked, BLOCKED_KINDS };
