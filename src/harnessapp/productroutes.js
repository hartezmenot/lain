'use strict';

/**
 * PRODUCT ROUTES (Phase 8) — appearance, Agent Instructions (AGENTS.md),
 * feedback, the session controls, surface handoff and reset-window usage.
 *
 *   /api/appearance               get / set (appearance.js)
 *   /api/agents/read|save|preview-reset|reset|effective
 *   /api/feedback/preview|submit  (feedback.js — explicit attachments only)
 *   /api/controls/list|run        slash controls over canonical state (remotecontrols.js)
 *   /api/surface/handoff|takeback Continue in CLI / take it back (surfacehandoff.js)
 *   /api/usage/windows            provider reset windows with LAIN-observed usage (resetwindows.js)
 *   /api/themes/list|read         installed extensions' colour themes, as data (exttheme.js)
 */

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400, extra = {}) { return { code, body: { ok: false, why: String(why || 'refused'), ...extra } }; }

function projectRoot(app) {
  const p = require('../sessionviews').project(app.session);
  return p.attached && !p.missing ? p.root : null;
}

const ROUTES = {
  'POST /api/appearance': async (app, body = {}) => {
    const a = require('../appearance');
    if (!body.set) return ok({ ui: a.get(app), options: { modes: a.MODES, palettes: a.PALETTES, zooms: a.ZOOMS, sizes: a.SIZES, themes: a.THEMES, keymaps: a.KEYMAPS, navs: a.NAVS, custom: a.CUSTOM_KEYS } });
    const r = a.set(app, body.set);
    return r.ok ? ok({ ui: r.ui }) : bad(r.why);
  },

  // ---- AGENTS.md ------------------------------------------------------------
  'POST /api/agents/read': async (app, body = {}) => {
    const md = require('../agentsmd');
    const scope = body.scope === 'project' ? 'project' : 'global';
    const r = md.read(scope, projectRoot(app));
    return r.ok ? ok({ file: r, default: { text: md.defaultText(), version: md.defaultVersion() } }) : bad(r.why, 409);
  },
  'POST /api/agents/save': async (app, body = {}) => {
    const md = require('../agentsmd');
    const r = md.write(body.scope === 'project' ? 'project' : 'global', projectRoot(app), body.text);
    return r.ok ? ok({ file: r }) : bad(r.why, 409);
  },
  'POST /api/agents/preview-reset': async (app, body = {}) => {
    const r = require('../agentsmd').resetPreview(body.scope === 'project' ? 'project' : 'global', projectRoot(app));
    return r.ok ? ok(r) : bad(r.why, 409);
  },
  'POST /api/agents/reset': async (app, body = {}) => {
    const r = require('../agentsmd').reset(body.scope === 'project' ? 'project' : 'global', projectRoot(app), { confirm: body.confirm === true });
    return r.ok ? ok({ file: r, backup: r.backup || null }) : bad(r.why, r.needsConfirm ? 428 : 409, { needsConfirm: Boolean(r.needsConfirm) });
  },
  'POST /api/agents/effective': async (app) => ok(require('../agentsmd').effective(projectRoot(app))),

  // ---- feedback -------------------------------------------------------------
  'POST /api/feedback/preview': async (app, body = {}) => {
    const r = await require('../feedback').build(app, body);
    return r.ok ? ok({ preview: r.preview, never: r.never, types: require('../feedback').TYPES }) : bad(r.why);
  },
  'POST /api/feedback/submit': async (app, body = {}) => {
    const r = await require('../feedback').submit(app, body);
    return r.ok ? ok({ saved: r.saved, id: r.report.id, issue: r.issue, why: r.why || null }) : bad(r.why);
  },

  // ---- controls -------------------------------------------------------------
  'POST /api/controls/list': async () => ok({ controls: require('../remotecontrols').LIST.map(([name, desc]) => ({ name, desc })) }),
  'POST /api/controls/run': async (app, body = {}) => {
    const rc = require('../remotecontrols');
    if (!rc.known(body.text)) return bad('not a LAIN control — /help lists them', 404);
    const r = await rc.run(app, body.text, { surface: 'harness' });
    return ok({ result: r, workbench: require('../supervision').state(app) });
  },

  // ---- surface handoff -------------------------------------------------------
  'POST /api/surface/handoff': async (app, body = {}) => {
    const r = require('../surfacehandoff').handoff(app, body.to || 'cli');
    return r.ok ? ok(r) : bad(r.why, 409);
  },
  'POST /api/surface/takeback': async (app) => {
    const r = require('../surfacehandoff').takeBack(app);
    // A LIVE host is asked, not displaced: 202 — it hands the session over at its next idle moment.
    if (!r.ok && r.pending) return { code: 202, body: { ok: false, pending: true, why: r.why } };
    return r.ok ? ok(r) : bad(r.why, 409);
  },

  // ---- extension colour themes (the "imported" preset) --------------------------
  'POST /api/themes/list': async (app) => ok({ themes: require('../exttheme').list(app) }),
  'POST /api/themes/read': async (app, body = {}) => {
    const r = require('../exttheme').read(app, body.id);
    return r.ok ? ok({ theme: r }) : bad(r.why, 404);
  },

  // ---- usage by provider reset window ----------------------------------------
  'POST /api/usage/windows': async (app, body = {}) => {
    const by = ['project', 'session', 'model', 'account'].includes(body.by) ? body.by : 'project';
    return ok({ at: Date.now(), windows: require('../resetwindows').windows(app, { by }) });
  },
};

// MCP & Skills (Phase 8.1) ride with the product routes — integrationroutes.js.
module.exports = { ROUTES: { ...ROUTES, ...require('./integrationroutes').ROUTES, ...require('./sourcesroutes').ROUTES, ...require('./serveroutes').ROUTES, ...require('./previewroutes').ROUTES, ...require('./intelroutes').ROUTES, ...require('./fabricintelroutes').ROUTES } };
