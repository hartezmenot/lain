'use strict';

/** WAITING ON A PROVIDER, AND GETTING OUT OF IT. */

/** Hold the UI in a visible wait until `resumeAt`, or until the user escapes it. */
function waitForReset(ui, resumeAt, { provider = '', label = '' } = {}) {
  const until = Number(resumeAt) || 0;
  if (!ui.enabled || until <= Date.now()) return Promise.resolve(true);
  ui.waitingUntil = until;
  ui.waitingLabel = label || `waiting for ${provider || 'the provider'} to reset`;
  ui._syncTicker();
  ui.refresh();

  return new Promise((resolve) => {
    const signal = ui.app.abort && ui.app.abort.signal;
    const done = (ok) => {
      if (ui._waitTimer) { clearTimeout(ui._waitTimer); ui._waitTimer = null; }
      if (signal) signal.removeEventListener('abort', onAbort);
      ui.waitingUntil = 0;
      ui.waitingLabel = '';
      ui._syncTicker();
      ui.refresh();
      resolve(ok);
    };
    const onAbort = () => done(false);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    ui._waitTimer = setTimeout(() => done(true), Math.max(0, until - Date.now()));
    if (ui._waitTimer.unref) ui._waitTimer.unref();
  });
}

/** ESCAPE OUT OF A RETRY. */
function cancelRetry(ui) {
  if (!ui.phase || ui.phase.phase !== 'RETRYING') return false;
  ui.retryCancelled = true;
  ui.interrupted = false;
  if (ui.app.abort && !ui.app.abort.signal.aborted) ui.app.abort.abort();
  // NO TRANSCRIPT NOTICE.
  ui.refresh();
  return true;
}

/** ESCAPE OUT OF A LONG RATE-LIMIT WAIT — `waitForReset`'s sibling to `cancelRetry`, and the same mechanism. */
function cancelWait(ui) {
  if (!ui.waitingUntil) return false;
  if (ui.app.abort && !ui.app.abort.signal.aborted) ui.app.abort.abort();
  return true;
}

module.exports = { waitForReset, cancelRetry, cancelWait };
