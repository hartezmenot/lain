'use strict';

/** THE SHALLOW VIEW OF THIS SESSION'S PROJECT, COMPUTED ONCE. */

/** The shallow scan: manifests, top-level tree, the things that say what this repository IS. */
function scan(app) {
  if (app._scan === undefined) {
    try { app._scan = require('./project').scan(app.session.cwd); } catch { app._scan = null; }
  }
  return app._scan;
}

/** Is there a recognisable project here? */
function isEmpty(app) {
  const s = scan(app);
  if (!s) return true;
  // SOURCE FILES AT THE TOP LEVEL ARE A PROJECT TOO: a folder holding index.html (or app.py) with no manifest and no
  // src/ was called EMPTY, and every turn was told "no source here yet" while working on that file (2026-10-01).
  const flatSource = (s.entries || []).some((e) => /\.(html?|css|m?[jt]sx?|py|go|rs|java|rb|cs|php|vue|svelte|c|cpp|h)$/i.test(e));
  return !(s.manifests || []).length && !(s.tree || []).length && !flatSource;
}

/** The file tree the FILES view draws. Same cache, same lifetime. */
function tree(app) {
  if (app._tree === undefined) {
    try { app._tree = require('./ui/panes').scanTree(app.session.cwd); } catch { app._tree = []; }
  }
  return app._tree;
}

/** WHAT KIND OF PROJECT THIS IS — from evidence, never from LAIN's own records. */
function state(app) {
  if (isEmpty(app)) return 'EMPTY';
  const store = require('./lainstore');
  const root = app.session.cwd;
  const holds = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.values(v).some(holds) : v != null && v !== '' && v !== 0 && v !== false);
  const recorded = ['architecture', 'wiring', 'concepts'].some((slot) => {
    const body = store.read(root, slot, null);
    if (!body || typeof body !== 'object') return false;
    const { updatedAt: _u, version: _v, ...rest } = body;
    return holds(rest);
  });
  return recorded ? 'EXISTING_INDEXED' : 'EXISTING_UNINDEXED';
}

const STATE_LINE = {
  EMPTY: 'Project state: EMPTY — no source or project structure here yet.',
  EXISTING_UNINDEXED: 'Project state: EXISTING_UNINDEXED — real source is present and LAIN has recorded no architecture, vocabulary or wiring for it. '
    + 'No DECLARED architecture is not no architecture: derive what is OBSERVED from the source itself.',
  EXISTING_INDEXED: 'Project state: EXISTING_INDEXED — real source plus recorded LAIN architecture/vocabulary/wiring; the source stays the authority when they disagree.',
};
function stateLine(app) {
  try { return STATE_LINE[state(app)] || ''; } catch { return ''; }
}

module.exports = { scan, isEmpty, tree, state, stateLine };
