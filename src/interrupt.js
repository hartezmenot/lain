'use strict';

/** THE CTRL+C POLICY — one pure decision, so the two-press exit is testable without a terminal, a child process, or a real clock. */

/** How long "press Ctrl+C again to exit" stays live. Short enough to feel immediate. */
const EXIT_CONFIRM_MS = 1500;

/** working — a model request or tool call is in flight right now armedAt — ms timestamp the confirmation was armed, or 0 when not armed @param {number}… */
function onInterrupt({ working = false, armedAt = 0 } = {}, now = Date.now()) {
  if (working) return { action: 'cancel', armedAt: 0 };
  if (armedAt && now - armedAt <= EXIT_CONFIRM_MS) return { action: 'exit', armedAt: 0 };
  return { action: 'arm', armedAt: now };
}

// side effects

/** Show the hint where the user is looking: the input frame, or plain text. */
function showHint(app, msg) {
  if (app.ui && app.ui.enabled) app.ui.setExitHint(msg);
  else if (msg) app.render.notice('warn', msg);
}

/** First idle Ctrl+C: arm the window and show the hint. */
function armExit(app) {
  app._exitArmedAt = Date.now();
  if (app._exitTimer) clearTimeout(app._exitTimer);
  app._exitTimer = setTimeout(() => {
    app._exitTimer = null;
    app._exitArmedAt = 0;
    showHint(app, '');
  }, EXIT_CONFIRM_MS);
  if (app._exitTimer.unref) app._exitTimer.unref();
  showHint(app, 'Press Ctrl+C again to exit.');
}

/** The user did something else — cancel the confirmation. No-op when unarmed. */
function disarmExit(app) {
  if (!app._exitArmedAt && !app._exitTimer) return;
  app._exitArmedAt = 0;
  if (app._exitTimer) { clearTimeout(app._exitTimer); app._exitTimer = null; }
  showHint(app, '');
}

module.exports = { onInterrupt, EXIT_CONFIRM_MS, armExit, disarmExit };
