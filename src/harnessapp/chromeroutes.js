'use strict';

/** THE CHROME VIEW'S ROUTES — LAIN for Chrome's connection state, for the Settings -> Connections panel. */

const lainChrome = require('../lainchrome');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400) { return { code, body: { ok: false, why: String(why || 'refused') } }; }

const ROUTES = {
  'POST /api/chrome/status': async (app) => {
    const c = lainChrome.existing(app);
    return ok({ chrome: c ? c.status() : { connected: false, extensionSeen: false, authorizedTabs: [] } });
  },

  'POST /api/chrome/connect': async (app) => {
    try {
      const r = await lainChrome.forApp(app).connect();
      return ok({ token: r.token, port: r.port });
    } catch (e) { return bad(e.message, 500); }
  },

  'POST /api/chrome/disconnect': async (app) => {
    const c = lainChrome.existing(app);
    if (!c) return ok({ chrome: { connected: false } });
    await c.disconnect('disconnected from Settings');
    return ok({ chrome: c.status() });
  },
};

module.exports = { ROUTES };
