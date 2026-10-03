'use strict';

/** COMPUTER CONTROL ROUTES (Phase CU) — the Harness's Enable button, target picker, indicator and Stop. */

const cc = require('../computercontrol');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 409) { return { code, body: { ok: false, why: String(why || 'refused') } }; }

const ROUTES = {
  'POST /api/computer/state': async (app) => ok({ state: cc.view(app) }),
  // FROM LAIN WEB (body.from === 'web') FULL is refused without a local confirmation (computercontrol.enable).
  'POST /api/computer/enable': async (app, body = {}) => { const r = await cc.enable(app, { tier: body.tier || 'INTERACT', by: body.from === 'web' ? 'web' : 'harness' }); return r.ok ? ok({ state: r.state }) : bad(r.why); },
  'POST /api/computer/disable': async (app) => ok({ state: (await cc.disable(app, 'turned off in the Harness')).state }),
  // STOP: one button that cannot half-work — the turn in flight is interrupted, the kill switch fires, control goes off,
  // and the bridge and its authorization go with it.
  'POST /api/computer/stop': async (app) => {
    const interrupted = Boolean(app.abort && !app.abort.signal.aborted);
    if (interrupted) app.abort.abort();
    const st = await cc.stop(app, 'stopped in the Harness');
    const c = require('../computermcp').existing(app);
    if (c) c.disconnect('you stopped it from the Harness');
    return ok({ stopped: true, interrupted, state: st.state });
  },
  'POST /api/computer/windows': async (app) => {
    if (!cc.enabled(app)) return bad('computer control is off');
    const r = await require('../computermcp').forApp(app).call('window.list', {});
    if (!r.ok) return bad(r.why);
    const list = ((r.result && r.result.windows) || []).filter((w) => w.title).map((w) => ({ handle: w.handle, title: w.title, process: w.process, pid: w.pid, sensitive: cc.sensitive(w), foreground: Boolean(w.foreground) }));
    return ok({ windows: list.slice(0, 80) });
  },
  'POST /api/computer/target': async (app, body = {}) => { const r = await cc.setTarget(app, { handle: body.handle != null ? Number(body.handle) : null, window: body.window || null, raw: body.raw === true }); return r.ok ? ok({ state: r.state }) : bad(r.why); },
};

const QUIET = ['POST /api/computer/state'];

module.exports = { ROUTES, QUIET };
