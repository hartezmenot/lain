'use strict';

/** ACCOUNT INSTANCES, FOR THE WINDOW — accountinstances.js over POST. */

const ai = require('../accountinstances');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400, extra = {}) { return { code, body: { ok: false, why: String(why || 'refused'), ...extra } }; }
function reply(r) { return r && r.ok ? ok(r) : bad(r && r.why, 409, r || {}); }

/** SOURCES THAT ARE NOT MODEL ROUTES, kept apart by what they are: ChatGPT Website a signed-in chatgpt.com page — CHAT only. */
async function otherSources(app) {
  const out = [];
  try {
    const v = await require('../modelsource/registry').overview(app);
    for (const s of v.sources || []) {
      if (s.source === 'lain') continue;
      out.push({
        id: `website:${s.source}`, driver_id: `website:${s.source}`, display_name: `${s.label} (website)`, provider: s.source === 'chatgpt-web' ? 'openai' : s.source === 'gemini-web' ? 'google' : s.source,
        source_type: 'website', connection: `${s.label} website session — chat only; not a subscription route and not the API`,
        identity: null, credential_ref: null, credential: { held_by: 'browser profile', note: 'the site keeps its own sign-in in LAIN’s browser profile' },
        authentication_state: s.state === 'READY' ? 'AUTHENTICATED' : s.state, runtime_state: null, models: s.selected ? [s.selected] : [],
        capabilities: ['CHAT'], limits: null, limits_error: 'the website does not report limits to LAIN', reset_windows: [], assigned_roles: [],
      });
    }
  } catch { /* no website sources in this build */ }
  return out;
}

const ROUTES = {
  'POST /api/instances': async (app) => ok({
    drivers: require('../providerdrivers').list().map(require('../providerdrivers').describe),
    instances: [...ai.list(app), ...(await otherSources(app))],
    writers: require('../threadwriters').list(),
  }),
  'POST /api/instances/login': async (app, body = {}) => reply(await ai.login(app, String(body.id || ''), { device: Boolean(body.device) })),
  /** NATIVE SESSIONS OTHER RUNTIMES OWN (externalsessions.js): listed, resumed there, or continued as a new LAIN session. */
  'POST /api/external/sessions': async (app, body = {}) => ok(await require('../externalsessions').list(app, { limit: Math.min(200, Number(body.limit) || 50) })),
  'POST /api/external/resume': async (app, body = {}) => reply(require('../externalsessions').resumeOriginal(app, { origin: body.origin, account: body.account, cwd: body.cwd || null })),
  'POST /api/external/continue': async (app, body = {}) => reply(await require('../externalsessions').continueInLain(app, { origin: body.origin, account: body.account, cwd: body.cwd || null })),
  /** THE COMPOSER GEAR: this session's BOT / Coding Agent / reasoning, and where each came from. */
  'POST /api/session/intel': async (app) => {
    const si = require('../sessionintel');
    const r = si.resolve(app, app.session);
    return ok({ intel: r, codingAccounts: si.accountsFor(app, r.coding.model), efforts: si.EFFORTS });
  },
  'POST /api/session/intel/set': async (app, body = {}) => reply(await require('../sessionintel').set(app, app.session, {
    lane: String(body.lane || ''), field: String(body.field || 'model'), value: body.value == null ? null : String(body.value), scope: String(body.scope || 'session'),
  })),
};

module.exports = { ROUTES };
