'use strict';

/**
 * THE EDITOR PROFILE, VS CODE / CURSOR IMPORT, EXTENSIONS AND LAIN PLUGINS —
 * the window's routes onto their owners:
 *
 *   editorprofile.js   what the IDE editor applies (settings, keys, snippets)
 *   vscodeimport.js    reading VS Code / Cursor, never writing them
 *   extensions.js      .vsix / folder / URL / Open VSX, code never run
 *   plugins.js         LAIN plugins, permissions enforced in tools/index.js
 */

const sv = require('../sessionviews');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function reply(r) { return r && r.ok ? ok(r) : { code: 200, body: { ok: false, ...(r || {}), why: String((r && r.why) || 'refused') } }; }
function project(app) {
  try { return !app.session.cowork && sv.project(app.session).attached ? app.session.cwd : null; } catch { return null; }
}
function scopeOf(body) { return body.scope === 'workspace' ? 'workspace' : 'global'; }

const ROUTES = {
  // ---- the editor profile ----------------------------------------------------
  'POST /api/editor/profile': (app) => {
    const p = require('../editorprofile').read();
    let ext = {};
    try { ext = require('../extensions').snippets({ project: project(app) }); } catch { ext = {}; }
    return ok({ profile: p, extensionSnippets: ext });
  },
  'POST /api/editor/profile/clear': () => ok({ profile: require('../editorprofile').clear() }),

  // ---- VS Code / Cursor --------------------------------------------------------
  'POST /api/import/detect': () => ok({ editors: require('../vscodeimport').detect() }),
  'POST /api/import/preview': (app, body = {}) => {
    const r = require('../vscodeimport').preview(String(body.product || ''));
    if (!r.ok) return reply(r);
    const { _apply, ...shown } = r;
    return ok(shown);
  },
  'POST /api/import/apply': (app, body = {}) => reply(require('../vscodeimport').apply(String(body.product || ''), {
    settings: body.settings !== false, keybindings: body.keybindings !== false, snippets: body.snippets !== false,
  })),

  // ---- extensions --------------------------------------------------------------
  'POST /api/extensions/list': (app) => ok({ extensions: require('../extensions').list({ project: project(app) }), workspace: Boolean(project(app)) }),
  'POST /api/extensions/search': async (app, body = {}) => reply(await require('../extensions').search(body.query)),
  'POST /api/extensions/install': async (app, body = {}) => {
    const s = body.source && typeof body.source === 'object' ? body.source : {};
    const src = s.vsix ? { vsix: String(s.vsix) } : s.folder ? { folder: String(s.folder) } : s.git ? { git: String(s.git), ref: s.ref ? String(s.ref) : null } : s.url ? { url: String(s.url) } : s.openvsx ? { openvsx: String(s.openvsx), version: s.version ? String(s.version) : null } : {};
    return reply(await require('../extensions').install(src, { scope: scopeOf(body), project: project(app) }));
  },
  'POST /api/extensions/enable': (app, body = {}) => reply(require('../extensions').setEnabled(String(body.id || ''), body.enabled !== false, { scope: scopeOf(body), project: project(app) })),
  'POST /api/extensions/uninstall': (app, body = {}) => reply(require('../extensions').uninstall(String(body.id || ''), { scope: scopeOf(body), project: project(app) })),
  // VS CODE / CURSOR EXTENSIONS ON THIS MACHINE (extpackages.js): found read-only,
  // reused by one verified copy in LAIN's content-addressed store.
  'POST /api/extensions/discover': () => ok({ found: require('../extpackages').discover() }),
  /** UPDATES, checked — nothing installed: Open VSX's latest, and the editors' newer copies of reused packages. */
  'POST /api/extensions/updates': async (app) => {
    const ext = require('../extensions');
    const rows = [];
    for (const e of ext.list({ project: project(app) })) {
      if (e.source && e.source.kind === 'openvsx') {
        const info = await ext.openvsxInfo(e.id).catch(() => null);
        if (info && info.ok && info.version && info.version !== e.version) rows.push({ id: e.id, scope: e.scope, name: e.name, from: e.version, to: info.version, via: 'openvsx' });
      }
    }
    for (const f of require('../extpackages').discover()) {
      if (f.reused && !f.reused.sameVersion) rows.push({ id: f.id, scope: 'global', name: f.name, from: f.reused.version, to: f.version, via: 'reuse', product: f.product });
    }
    return ok({ updates: rows });
  },
  'POST /api/extensions/reuse': (app, body = {}) => reply(require('../extpackages').reuse({ product: String(body.product || ''), id: String(body.id || '') })),
  'POST /api/extensions/update': async (app, body = {}) => reply(await require('../extensions').update(String(body.id || ''), { scope: scopeOf(body), project: project(app) })),

  // ---- LAIN plugins ------------------------------------------------------------
  'POST /api/plugins/list': () => ok({ plugins: require('../plugins').list(), permissions: require('../plugins').PERMISSIONS }),
  'POST /api/plugins/install': (app, body = {}) => reply(require('../plugins').install(String(body.folder || ''))),
  'POST /api/plugins/enable': (app, body = {}) => reply(require('../plugins').enable(String(body.id || ''), { grant: Array.isArray(body.grant) ? body.grant : [] })),
  'POST /api/plugins/disable': (app, body = {}) => reply(require('../plugins').disable(String(body.id || ''))),
  'POST /api/plugins/uninstall': (app, body = {}) => reply(require('../plugins').uninstall(String(body.id || ''))),
  /** Run a plugin command as a Coding Agent turn in the IDE, carrying its grant. */
  'POST /api/plugins/run': (app, body = {}) => {
    if (!project(app)) return reply({ ok: false, why: 'open a project in the IDE first', projectRequired: true });
    const p = require('../plugins').prepare(String(body.id || ''), String(body.command || ''), { ide: app.session._ide || null });
    if (!p.ok) return reply(p);
    const br = require('./botroute');
    return br.start(app, p.text, { role: 'agent', reason: `plugin ${p.grant.name}`, grant: p.grant });
  },
};

/** Reads that must not wake the window (see routes.js QUIET_READS). */
const QUIET = ['/api/extensions/discover', '/api/editor/profile', '/api/import/detect', '/api/import/preview', '/api/extensions/list', '/api/extensions/search', '/api/plugins/list'];

module.exports = { ROUTES, QUIET };
