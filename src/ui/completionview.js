'use strict';

/** THE TASK-COMPLETE OVERLAY — what is shown when work finishes. */

const views = require('./views');

/** Open the overlay. */
function show(ui, verification = []) {
  ui.screen.completionVerification = verification;
  render(ui);
}

/** Compose the report and put it on the screen. */
function render(ui) {
  ui.screen.completion = views.completion({
    session: ui.app.session,
    checkpoints: ui.app.checkpoints,
    cwd: ui.app.session.cwd,
    verification: ui.screen.completionVerification || [],
    width: ui.screen.cols,
  });
  ui.refresh();
}

/** Take it away, and give the workspace its rows back. */
function dismiss(ui) {
  ui.screen.completion = null;
  ui.refresh();
}

module.exports = { show, render, dismiss };
