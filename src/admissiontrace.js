'use strict';

/** THE ADMISSION TRACE — where a typed line went, decision by decision. */

const fs = require('fs');

function stateOf(app) {
  try {
    const panel = app && app.ui && app.ui.panel;
    const primary = app && app.jobs && typeof app.jobs.primary === 'function' ? app.jobs.primary() : null;
    return {
      abort: app && app.abort ? (app.abort.signal.aborted ? 'aborted' : 'live') : null,
      dispatching: app ? app.dispatching || 0 : null,
      primary: primary ? { id: primary.id, state: primary.state } : null,
      panel: panel && panel.visible ? String(panel.kind) : null,
      busy: Boolean(app && app.ui && app.ui.busy),
      steers: app && Array.isArray(app.steerQueue) ? app.steerQueue.length : 0,
      composing: Boolean(app && app.composing),
      turns: app && app.session && Array.isArray(app.session.turns) ? app.session.turns.length : null,
    };
  } catch { return {}; }
}

function note(app, event, detail = {}) {
  const file = process.env.LAIN_TRACE_ADMISSION;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), event, ...detail, state: stateOf(app) })}\n`);
  } catch { /* the trace never costs the line */ }
}

module.exports = { note, stateOf };
