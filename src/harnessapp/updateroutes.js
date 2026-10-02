'use strict';

/**
 * UPDATES AND EXIT, FOR THE HARNESS (packaging pass §J, §K). The same updater and lifecycle the CLI uses.
 *   POST /api/update/check     { force }            → the state (cached unless forced)
 *   POST /api/update/download                       → stage the available update (verify, unpack; nothing restarts)
 *   POST /api/update/restart   { when: now|checkpoint|task }
 *   POST /api/update/later                          → cancel a scheduled restart (the download stays)
 *   POST /api/app/exit         { mode: now|checkpoint|stop }
 */

const ok = (body = {}) => ({ code: 200, body: { ok: true, ...body } });
const bad = (why, code = 400, extra = {}) => ({ code, body: { ok: false, why, ...extra } });
const U = () => require('../update/updater');
const LC = () => require('../update/lifecycle');

/** What the window draws (state.js: `update`). Cheap — reads the cached state file, never the network. */
/** THE ONE VIEW (update/ux.js) — the same words and state the CLI reads. */
function view(app) { return require('../update/ux').view(app, { fresh: true }); }

const ROUTES = {
  'POST /api/update/download': async (app) => {
    if (!U().installRoot()) return bad('updates apply to an installed LAIN — this is a development checkout', 409);
    const r = await U().stage({ cfg: app.cfg }).catch((e) => ({ ok: false, why: e.message }));
    return r.ok ? ok({ update: view(app), said: require('../update/ux').INSTALLED }) : bad(r.why, 409);
  },
  'POST /api/update/restart': async (app, body = {}) => {
    const when = ['now', 'checkpoint', 'task'].includes(body.when) ? body.when : 'task';
    if (U().status().state !== 'staged') return bad('no update is downloaded yet', 409);
    if (when === 'now' && LC().busy(app)) return bad('the Coding Agent is working — restart after the current checkpoint or after the task', 409);
    const r = LC().arm(app, 'update', when);
    return r.ok ? ok({ update: view(app), said: when === 'now' || r.when === 'now' ? 'Restarting LAIN…' : when === 'checkpoint' ? 'LAIN restarts at the next committed checkpoint' : 'LAIN restarts when the task is done' }) : bad(r.why);
  },
  'POST /api/update/later': async (app) => { LC().cancel(app, 'update'); return ok({ update: view(app), said: 'Later — the update stays downloaded' }); },
  'POST /api/app/exit': async (app, body = {}) => {
    const mode = ['now', 'checkpoint', 'stop'].includes(body.mode) ? body.mode : 'now';
    if (mode === 'now' && LC().busy(app)) return bad('the Coding Agent is working — choose how to exit', 409, { busy: true });
    if (mode === 'stop') { setImmediate(() => LC().perform(app, 'exit', { stopTurn: true }).catch(() => null)); return ok({ said: 'Stopping the task and exiting…' }); }
    const r = LC().arm(app, 'exit', mode);
    return r.ok ? ok({ said: r.when === 'now' ? 'Exiting LAIN…' : 'LAIN exits at the next committed checkpoint' }) : bad(r.why);
  },
};

module.exports = { ROUTES, view };
