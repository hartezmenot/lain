'use strict';

/** THE PROJECT'S DEV SERVER, AS ROUTES. */

const sv = require('../sessionviews');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400, extra = {}) { return { code, body: { ok: false, why: String(why || 'refused'), ...extra } }; }

function rootOf(app) {
  const p = sv.project(app.session);
  return p.attached && !p.missing ? p.root : null;
}

function servers(app) { return require('../workshop').forApp(app).devServers; }

const ROUTES = {
  'POST /api/devserver/status': async (app) => {
    const root = rootOf(app);
    if (!root) return ok({ devServer: null, projectRequired: true });
    return ok({ devServer: servers(app).get(root) });
  },

  'POST /api/devserver/start': async (app, body = {}) => {
    const root = rootOf(app);
    if (!root) return bad('attach a project first — a dev server runs in the project root', 409, { projectRequired: true });
    const timeoutMs = Math.max(5_000, Math.min(180_000, Number(body.timeoutMs) || 60_000));
    const r = await servers(app).start(root, { timeoutMs });
    if (!r.ok) return { code: 200, body: { ok: false, why: r.why, devServer: r.devServer } };
    const probed = body.probe === false ? null : await servers(app).probe(root);
    return ok({ devServer: probed ? probed.devServer : r.devServer, preview: probed ? probed.preview : null, why: r.why || '' });
  },

  'POST /api/devserver/stop': async (app) => {
    const root = rootOf(app);
    if (!root) return bad('no project is attached', 409, { projectRequired: true });
    const r = await servers(app).stop(root);
    return r.ok ? ok({ devServer: r.devServer }) : bad(r.why, 500, { devServer: r.devServer });
  },

  'POST /api/devserver/restart': async (app, body = {}) => {
    const root = rootOf(app);
    if (!root) return bad('no project is attached', 409, { projectRequired: true });
    const r = await servers(app).restart(root, { timeoutMs: Math.max(5_000, Math.min(180_000, Number(body.timeoutMs) || 60_000)) });
    return { code: 200, body: { ok: Boolean(r.ok), why: r.why || '', devServer: r.devServer } };
  },

  /** Request the page once. A 5xx comes back as `preview` evidence, with ok:true. */
  'POST /api/devserver/probe': async (app, body = {}) => {
    const root = rootOf(app);
    if (!root) return bad('no project is attached', 409, { projectRequired: true });
    const r = await servers(app).probe(root, { path: body.path || '/' });
    if (!r.ok) return bad(r.why, 409, { devServer: r.devServer });
    return ok({ preview: r.preview, devServer: r.devServer });
  },
};

module.exports = { ROUTES };
