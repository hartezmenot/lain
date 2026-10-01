'use strict';

/**
 * ROUTER SERVER ROUTES (Phase 8.1) — Settings › Router Server, over serve.js.
 *
 *   /api/server/status     running? where? how many requests? the token (masked only)
 *   /api/server/start      /api/server/stop
 *   /api/server/configure  { port, host, allowRemote, startWithLain, expose }
 *   /api/server/token      { reveal: true } the LOCAL LAIN token, to paste into a client — never a provider key
 *   /api/server/regenerate a new local token (the old one stops working)
 */

const serve = require('../serve');
const ok = (b = {}) => ({ code: 200, body: { ok: true, ...b } });
const bad = (why, code = 400) => ({ code, body: { ok: false, why: String(why) } });

const ROUTES = {
  'POST /api/server/status': async (app) => ok({ server: serve.status(app), aliases: serve.aliases(app).length }),
  'POST /api/server/start': async (app) => { const r = await serve.start(app); return r.ok ? ok({ server: serve.status(app) }) : bad(r.why, 409); },
  'POST /api/server/stop': async (app) => { await serve.stop(); return ok({ server: serve.status(app) }); },
  'POST /api/server/configure': async (app, body = {}) => { const r = serve.configure(app, body); return r.ok ? ok({ server: serve.status(app) }) : bad(r.why); },
  'POST /api/server/token': async (app, body = {}) => (body.reveal === true ? ok({ token: serve.token({ create: true }) }) : ok({ token: null, info: serve.tokenInfo() })),
  'POST /api/server/regenerate': async () => ok({ token: serve.regenerate() }),
};

module.exports = { ROUTES };

// ---- CONNECTED BOTS (connectedbots.js) — Settings › Bots & Channels ----
const bots = require('../connectedbots');
Object.assign(ROUTES, {
  'POST /api/bots/list': async (app) => ok({ bots: bots.list(app), permissions: bots.PERMS }),
  'POST /api/bots/connect': async (app, body = {}) => { const r = bots.connect(app, body); return r.ok ? ok(r) : bad(r.why); },
  'POST /api/bots/status': async (app, body = {}) => { const r = await bots.status(app, String(body.id || '')); return r.ok ? ok(r) : bad(r.why, 404); },
  'POST /api/bots/migrate': async (app, body = {}) => { const r = await bots.migrate(app, String(body.id || '')); return r.ok ? ok(r) : bad(r.why, 409); },
  'POST /api/bots/permissions': async (app, body = {}) => { const r = bots.setPermissions(app, String(body.id || ''), body.permissions || {}); return r.ok ? ok(r) : bad(r.why, 404); },
  'POST /api/bots/remove': async (app, body = {}) => { const r = bots.remove(app, String(body.id || '')); return r.ok ? ok(r) : bad(r.why, 404); },
});
