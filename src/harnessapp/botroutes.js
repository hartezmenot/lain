'use strict';

/**
 * THE BOT VIEW'S ROUTES — connection state and the Telegram setup flow.
 *
 * All of it is src/botconnect.js, which is a projection and a flow over the
 * supervisor's credential authority and Astra's gateway. Every route is a POST:
 * reading connection state may start LAIN's runtime (the supervisor holds the
 * Telegram credential), and a poll must never do that.
 *
 * THE TOKEN IS IN ONE REQUEST BODY AND NOWHERE ELSE. It is not echoed, not put
 * in any response, not stored by this file, and `connectTelegram` registers it
 * with redact.js before it goes anywhere.
 */

const bc = require('../botconnect');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400, extra = {}) { return { code, body: { ok: false, why: String(why || 'refused'), ...extra } }; }

const ROUTES = {
  'POST /api/bot/connections': async (app, body = {}) => ok(await bc.connections(app, { check: Boolean(body.check) })),

  'POST /api/bot/service': async (app, body = {}) => {
    const action = String(body.action || '');
    if (action === 'start') { const r = await bc.startService(app); return r.ok ? ok(r) : bad(r.why, 409); }
    if (action === 'stop') { const r = await bc.stopService(app); return r.ok ? ok(r) : bad(r.why, 409); }
    if (action === 'restart') {
      const s = await bc.stopService(app);
      if (!s.ok) return bad(s.why, 409);
      const r = await bc.startService(app);
      return r.ok ? ok(r) : bad(r.why, 409);
    }
    return bad('action must be start, stop or restart');
  },

  'POST /api/bot/telegram/connect': async (app, body = {}) => {
    const r = await bc.connectTelegram(app, body.token);
    return r.ok ? ok({ telegram: r.telegram, started: r.started }) : bad(r.why, 400);
  },

  'POST /api/bot/telegram/check': async (app) => ok({ telegram: await bc.telegram(app, { check: true }) }),

  'POST /api/bot/telegram/candidates': async (app) => ok({ candidates: bc.candidates(app, 'telegram') }),

  'POST /api/bot/telegram/approve': async (app, body = {}) => {
    const r = bc.approveTelegram(app, body.senderId);
    return r.ok ? ok({ allowedUsers: r.allowedUsers }) : bad(r.why, 409);
  },

  'POST /api/bot/telegram/revoke': async (app, body = {}) => {
    const r = bc.revokeTelegram(app, body.senderId);
    return r.ok ? ok({ allowedUsers: r.allowedUsers }) : bad(r.why, 409);
  },

  'POST /api/bot/telegram/disconnect': async (app) => {
    const r = await bc.disconnectTelegram(app);
    return r.ok ? ok({ removed: r.removed, telegram: r.telegram }) : bad(r.why, 409);
  },
};

module.exports = { ROUTES };
