'use strict';

/** A PREVIEW ON SCREEN — the Harness's, or a standalone Preview window for a CLI (packaging pass §M, §N). */

const WAIT_MS = 25000;

function projectRoot(app) {
  try { const p = require('../sessionviews').project(app.session); return p.attached && !p.missing ? p.root : null; } catch { return null; }
}

/** Is a Preview surface showing the frame and asking for input? */
function showing(app) { return require('./previewinput').attached(app); }

async function ensure(app, { reason = null, timeoutMs = WAIT_MS } = {}) {
  const root = projectRoot(app);
  if (!root) return { ok: false, why: 'open a project first — the Preview shows the project\'s own frontend' };
  const ws = require('./index').forApp(app);
  if (!ws.frameState(root)) {
    const r = await ws.frameOpen(root, {});
    if (!r.ok) return { ok: false, why: r.why };
  }
  if (showing(app)) return { ok: true, via: 'open' };
  // THE HARNESS IS OPEN: ask it to show the Preview (state flag the page reads on its next poll).
  const ipc = require('../harnessapp/ipc');
  const harnessOpen = ipc.status().clients > 0 && app._surfaceMode !== 'dashboard';
  app._previewWanted = { at: Date.now(), reason };
  if (!harnessOpen) {
    // NO HARNESS: the standalone Preview window, the same page in preview-only mode.
    const r = await require('../desktop').open(app, { mode: 'preview' }).catch((e) => ({ ok: false, why: e.message }));
    if (!r.ok) return { ok: false, why: `the Preview window could not open: ${r.why}` };
  }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (showing(app)) return { ok: true, via: harnessOpen ? 'harness' : 'window' };
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: false, why: 'the Preview did not come up in time' };
}

module.exports = { ensure, showing, projectRoot };
