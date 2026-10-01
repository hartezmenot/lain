'use strict';

/**
 * ACCOUNT INSTANCES, FOR THE WINDOW — accountinstances.js over POST.
 *
 * Nothing here returns a secret, because nothing here can reach one: runtime
 * accounts keep their sign-in in their own home, and API accounts are
 * projected by credential REFERENCE (credentials.js `describe`). The routes
 * that take a key are accountops' (`/api/accounts/addkey`), unchanged.
 */

const ai = require('../accountinstances');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400, extra = {}) { return { code, body: { ok: false, why: String(why || 'refused'), ...extra } }; }
function reply(r) { return r && r.ok ? ok(r) : bad(r && r.why, 409, r || {}); }

/**
 * SOURCES THAT ARE NOT MODEL ROUTES, kept apart by what they are:
 *   ChatGPT Website   a signed-in chatgpt.com page — CHAT only. Not the Codex
 *                     subscription, not the OpenAI API, and not "free".
 *   ChatGPT identity  Sign in with ChatGPT — who you are. No model access.
 */
async function otherSources(app) {
  const out = [];
  try {
    const v = await require('../modelsource/registry').overview(app);
    for (const s of v.sources || []) {
      if (s.source === 'lain') continue;
      out.push({
        id: `website:${s.source}`, driver_id: `website:${s.source}`, display_name: `${s.label} (website)`, provider: s.source === 'chatgpt-web' ? 'openai' : s.source === 'gemini-web' ? 'google' : s.source,
        source_type: 'website', connection: `${s.label} website session — chat only; not a subscription route and not the API`,
        identity: null, credential_ref: null, credential: { held_by: 'browser profile', note: 'the site keeps its own sign-in in Noema’s browser profile' },
        authentication_state: s.state === 'READY' ? 'AUTHENTICATED' : s.state, runtime_state: null, models: s.selected ? [s.selected] : [],
        capabilities: ['CHAT'], limits: null, limits_error: 'the website does not report limits to Noema', reset_windows: [], assigned_roles: [],
      });
    }
  } catch { /* no website sources in this build */ }
  try {
    const c = require('../chatgptauth').status(app);
    if (c && c.state === 'CONNECTED') {
      out.push({ id: 'identity:chatgpt', driver_id: 'identity:chatgpt', display_name: 'ChatGPT identity', provider: 'openai', source_type: 'identity',
        connection: 'Sign in with ChatGPT — identity only (name, email). Grants no model access.', identity: c.identity ? { email: c.identity.email || null, kind: 'identity' } : null,
        credential_ref: 'os:chatgpt-oauth', credential: { held_by: 'the OS secret store' }, authentication_state: 'AUTHENTICATED', runtime_state: null, models: [], capabilities: [],
        limits: null, reset_windows: [], assigned_roles: [] });
    }
  } catch { /* identity sign-in not configured */ }
  return out;
}

const ROUTES = {
  'POST /api/instances': async (app) => ok({
    drivers: require('../providerdrivers').list().map(require('../providerdrivers').describe),
    instances: [...ai.list(app), ...(await otherSources(app))],
    writers: require('../threadwriters').list(),
  }),
  'POST /api/instances/add': async (app, body = {}) => reply(ai.add(app, { driver_id: body.driver_id, display_name: body.display_name, config: body.config || {} })),
  'POST /api/instances/rename': async (app, body = {}) => reply(ai.rename(app, String(body.id || ''), body.name)),
  'POST /api/instances/refresh': async (app, body = {}) => reply(await ai.refresh(app, String(body.id || ''))),
  'POST /api/instances/login': async (app, body = {}) => reply(await ai.login(app, String(body.id || ''), { device: Boolean(body.device) })),
  'POST /api/instances/disconnect': async (app, body = {}) => reply(await ai.disconnect(app, String(body.id || ''), { logout: typeof body.logout === 'boolean' ? body.logout : undefined })),
  'POST /api/instances/foreground': async (app, body = {}) => reply(ai.setForeground(app, String(body.id || ''))),
  'POST /api/instances/threads': async (app, body = {}) => {
    const h = ai.handle(app, String(body.id || ''));
    if (!h || !h.threads) return bad('no such runtime account', 404);
    try { const r = await h.threads({ limit: Math.min(200, Number(body.limit) || 50) }); return ok({ threads: (r && r.data) || [] }); }
    catch (e) { return bad(require('../redact').text(String(e.message || e)).slice(0, 200), 409); }
  },
  'POST /api/instances/handoff': async (app, body = {}) => {
    const mk = (id) => { const h = ai.handle(app, String(id || '')); return h ? { id: String(id), driver: h.driver, storeKey: h.storeKey, handle: h } : null; };
    const from = mk(body.from); const to = mk(body.to);
    if (!from || !to) return bad('both accounts must be runtime accounts', 404);
    return reply(await require('../threadwriters').handoff(String(body.threadId || ''), from, to));
  },
  /** WHAT IS INSTALLED, AND WHICH HOMES EXIST — found, never taken (runtimediscovery.js). */
  'POST /api/instances/discover': async (app, body = {}) => ok({ runtimes: require('../runtimediscovery').discover(app, { force: Boolean(body.force) }) }),
  'POST /api/instances/adopt': async (app, body = {}) => reply(require('../runtimediscovery').adopt(app, { driver: String(body.driver || ''), home: String(body.home || ''), name: body.name })),
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
  /** The CLI's `/account add` minted this; the window redeems it once. */
  'POST /api/instances/intent': async (app, body = {}) => {
    const v = require('../accountintent').redeem(body.token);
    return v ? ok({ intent: v }) : bad('that link has expired or was already used', 410);
  },
};

module.exports = { ROUTES };
