'use strict';

/** WHEN TO TRY AGAIN — the retry schedule, and nothing else. */

/** HOW MANY TIMES ONE OPERATION IS RETRIED. */
const MAX_RETRIES = 10;

/** HOW LONG TO WAIT BEFORE EACH ATTEMPT, in milliseconds. */
const BACKOFF_MS = [
  10_000, 15_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000, 300_000, 300_000,
];

/** NO JITTER, AND THAT IS A REVERSAL WORTH STATING. */
const JITTER = 0;

/** THE SCHEDULE A TEST RUNS AGAINST, when one asks. */
function scheduleTable() {
  const raw = process.env.LAIN_BACKOFF_MS;
  if (!raw) return BACKOFF_MS;
  const parsed = String(raw).split(',')
    .map((n) => Number(String(n).trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : BACKOFF_MS;
}

/** The scheduled delay for `attempt` (1-based), exact. */
function scheduleFor(attempt) {
  const table = scheduleTable();
  const i = Math.min(Math.max(1, Math.floor(Number(attempt) || 1)) - 1, table.length - 1);
  return table[i];
}

/** THE DELAY ACTUALLY USED — the schedule, or the provider's instruction, whichever is LONGER. */
const MAX_TRUSTED_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

function effectiveDelay(attempt, retryAfterMs = null) {
  const scheduled = scheduleFor(attempt);
  const hinted = Number(retryAfterMs);
  const trustworthy = Number.isFinite(hinted) && hinted > 0 && hinted <= MAX_TRUSTED_RETRY_AFTER_MS;
  return trustworthy ? Math.max(scheduled, Math.round(hinted)) : scheduled;
}

/** The delay before `attempt` (1-based). */
function backoffFor(attempt, retryAfterMs = null) {
  return effectiveDelay(attempt, retryAfterMs);
}

/** The whole schedule as seconds, for a status surface or a test. */
function scheduleSeconds() {
  return scheduleTable().map((ms) => Math.round(ms / 1000));
}

/** AN ABORTABLE WAIT — `await sleep(ms, signal)`. */
function sleep(ms, signal, timers = null) {
  const setT = timers && timers.setTimeout ? timers.setTimeout : setTimeout;
  const clearT = timers && timers.clearTimeout ? timers.clearTimeout : clearTimeout;
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setT(done, ms);
    function done() {
      clearT(t);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

module.exports = {
  MAX_RETRIES, BACKOFF_MS, JITTER, MAX_TRUSTED_RETRY_AFTER_MS,
  backoffFor, scheduleFor, effectiveDelay, scheduleSeconds, scheduleTable, sleep,
};
