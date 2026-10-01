'use strict';

/**
 * THE INTELLIGENCE FABRIC, FOR EVERY WINDOW (Phase 8.3) — the Model Dashboard,
 * the composer's pickers, the tray and a dashboard opened from the CLI all read
 * and write the ONE Core registry through these routes. The CLI and Telegram
 * call the same modules directly. Nothing here sends a request to a model.
 *
 *   POST /api/intel/families   provider families (backing accounts, policy, quota) + this session's lanes
 *   POST /api/intel/family     { id } — one family, with its models and recent events
 *   POST /api/intel/search     { query, family, kind, capability, effort, available, lane } — the model index
 *   POST /api/intel/policy     { family, policy: auto|pinned|ask, pinned? }
 *   POST /api/intel/order      { family, order: [accountId…] } — fallback priority
 *   POST /api/intel/alias      { id, name } — "Personal", "Work"; identity is never changed
 *   POST /api/intel/effort     { lane, effort } — a level the lane's model declares
 *   POST /api/intel/decide     { choice: switch|wait|choose-model, account? } — the pending account question
 *   POST /api/intel/roles      the role defaults (Chat, Assistant, Coding, Research, Vision, Auxiliary)
 *   POST /api/intel/role       { role, family, model, effort, execution, policy, pinned }
 *   POST /api/intel/tray       the tray summary (what the host is sent)
 *   POST /api/intel/refresh    { family? } — ask the runtimes for their reported windows again
 *   POST /api/intel/events     { since, type } — fallbacks, sources added/removed, migrations
 *   POST /api/intel/discovered { force? } — native provider homes found on this PC (existence only)
 *   POST /api/intel/detach       { id, mode: detach|sign-out|remove-profile, confirm? } — ONE account, any kind; never under a running request
 *   POST /api/intel/detach-all   { family, signOut?, confirm } — every account of a provider (in-use ones are skipped and named)
 *   POST /api/intel/verify       { id } — one short real message through an Antigravity account; capabilities are advertised only after it answers
 *   POST /api/intel/auth/start   { family, name? } — connect ONE new account: an AuthSession, its own process, its own new profile
 *   POST /api/intel/auth/status  { id? , family? } — where that sign-in stands (STARTING · AWAITING_BROWSER · VERIFYING · CONNECTED · FAILED · CANCELLED)
 *   POST /api/intel/auth/cancel  { id } — stop THAT sign-in only; every other account and run is untouched
 *   POST /api/intel/use        { key } — "Use in LAIN": register a discovered home, ask the runtime who it is
 *   POST /api/migrate/discover { exportFile? } → the plan (keys never leave Core) + a token
 *   POST /api/migrate/apply    { token, decisions }
 *   POST /api/migrate/finish   { id } — a discovered account the person has dealt with
 */

const ok = (b = {}) => ({ code: 200, body: { ok: true, ...b } });
const bad = (why, code = 400, extra = {}) => ({ code, body: { ok: false, why: String(why), ...extra } });

const F = () => require('../fabric/index');
/** A provider as the window reads it, with what is WORKING through each account right now (observed only). */
function viewLive(f, o) {
  const v = F().familyView(f, o);
  const D = require('../fabric/detach');
  for (const a of v.accounts) { const w = D.inUse(a.id); a.inUse = w.length ? { by: D.usedBy(w), count: w.length } : null; }
  return v;
}
const S = () => require('../fabric/store');
function save(app) { try { app.session.save(); } catch { /* the next save persists it */ } }
function tray(app) { try { require('../fabric/tray').changed(app); } catch { /* presentation only */ } }
function lanes(app) {
  const si = require('../sessionintel');
  return { chat: si.lane(app, app.session, 'chat'), coding: si.lane(app, app.session, 'coding') };
}

// THE MIGRATION'S DISCOVERED ACCOUNTS stay in Core — an export's API key never reaches the page.
const pendingImports = new Map();   // token -> { found, at }

const ROUTES = {
  'POST /api/intel/families': async (app, body = {}) => {
    try { await app.ensureCatalog({ announce: false }); } catch { /* cached catalog */ }
    try { require('../fabric/migrate').reconcile(app); } catch { /* reconciled on the next read */ }
    const I = F().index(app);
    return ok({ families: I.families.map((f) => viewLive(f, { models: Boolean(body.models) })), groups: F().providerFamilies(app), lanes: lanes(app), modelCount: I.modelCount, buildMs: I.buildMs, policies: S().POLICY_LABEL });
  },
  'POST /api/intel/family': async (app, body = {}) => {
    const f = F().family(app, String(body.id || ''));
    if (!f) return bad('no such provider', 404);
    return ok({ family: viewLive(f, { models: true }), events: S().events({ since: Date.now() - 7 * 86400000 }).filter((e) => e.family === f.id).slice(-20), lanes: lanes(app) });
  },
  'POST /api/intel/search': async (app, body = {}) => {
    const t0 = process.hrtime.bigint();
    const r = F().search(app, {
      query: body.query || '', family: body.family || null, kind: body.kind || null, capability: body.capability || null,
      effort: Boolean(body.effort), available: Boolean(body.available), lane: body.lane || null, limit: Math.max(1, Math.min(500, Number(body.limit) || 200)),
    });
    return ok({ ...r, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
  },
  'POST /api/intel/policy': async (app, body = {}) => {
    const f = F().family(app, String(body.family || ''));
    if (!f) return bad('no such provider', 404);
    const policy = String(body.policy || '');
    let pinned = body.pinned === undefined ? undefined : (body.pinned || null);
    if (policy === 'pinned') {
      pinned = pinned || f.pinned || (lanes(app).coding.family === f.id ? lanes(app).coding.account : null) || (f.accounts[0] && f.accounts[0].id);
      if (!f.accounts.some((a) => a.id === pinned)) return bad('choose one of this provider\'s accounts');
    }
    const r = S().setPolicy(f.id, policy, pinned);
    if (!r.ok) return bad(r.why);
    // A LANE ON THIS FAMILY follows a new pin at once — nothing else about it changes.
    if (policy === 'pinned') { const si = require('../sessionintel'); for (const L of ['chat', 'coding']) { const l = si.lane(app, app.session, L); if (l.family === f.id && l.account !== pinned) si.switchBacking(app, app.session, L, pinned); } save(app); }
    tray(app);
    return ok({ family: F().familyView(F().family(app, f.id)), lanes: lanes(app) });
  },
  'POST /api/intel/order': async (app, body = {}) => {
    const f = F().family(app, String(body.family || ''));
    if (!f) return bad('no such provider', 404);
    const order = (Array.isArray(body.order) ? body.order : []).map(String).filter((id) => f.accounts.some((a) => a.id === id));
    S().setOrder(f.id, order);
    return ok({ family: F().familyView(F().family(app, f.id)) });
  },
  /**
   * ENABLE / DISABLE AN ACCOUNT (2026-10-02). Core state (fabric/store): automatic fallback, the model picker and every
   * lane read it. Disabling an account a request is working through never interrupts that request — it is excluded from
   * the NEXT choice, and the answer says so (`afterCurrent`).
   */
  'POST /api/intel/enable': async (app, body = {}) => {
    const id = String(body.id || '');
    const known = F().families(app).some((f) => f.accounts.some((a) => a.id === id));
    if (!known) return bad('no such account', 404);
    const enabled = body.enabled !== false;
    let busy = [];
    try { busy = require('../accountwork').busyAccount(id); } catch { busy = []; }
    S().setEnabled(id, enabled);
    try { require('../appcatalog').invalidate(); const r = app._sibling || app; r._acctMemo = null; r._catMemo = null; } catch { /* rebuilt on the next read */ }
    tray(app);
    return ok({ id, enabled, afterCurrent: !enabled && busy.length > 0, usedBy: busy.length ? (busy[0].kind === 'agent' ? 'Coding Agent' : 'Chat') : null });
  },
  'POST /api/intel/alias': async (app, body = {}) => {
    const id = String(body.id || '');
    const known = F().families(app).some((f) => f.accounts.some((a) => a.id === id) || f.setup.some((p) => p.id === id));
    if (!known) return bad('no such account', 404);
    S().setAlias(id, body.name);
    tray(app);
    return ok({});
  },
  'POST /api/intel/effort': async (app, body = {}) => {
    const lane = body.lane === 'chat' ? 'chat' : 'coding';
    const r = await require('../sessionintel').choose(app, app.session, { lane, effort: body.effort == null ? 'auto' : String(body.effort) });
    if (!r.ok) return bad(r.why, 409, { code: r.code || null });
    save(app);
    return ok({ lane: r.lane, lanes: lanes(app) });
  },
  'POST /api/intel/decide': async (app, body = {}) => {
    const pendingLane = app.session && app.session.intel && app.session.intel.pending ? app.session.intel.pending.lane : null;
    const r = require('../fabric/fallback').decide(app, app.session, { choice: String(body.choice || ''), account: body.account || null });
    if (!r.ok) return bad(r.why, 409);
    // A SWITCH RESUMES THE SAME TASK where a limit paused it — re-checked, the plan and phase untouched.
    let resumed = null;
    if (r.resume) {
      try {
        const w = require('../workbench').of(app.session);
        if (w.quota && w.quota.state === 'QUOTA_PAUSED') resumed = await require('../quotapause').resume(app);
      } catch (e) { resumed = { ok: false, why: e.message }; }
      // A CHAT question has no paused task to re-check: the same conversation carries on through the new account.
      if (!resumed && pendingLane === 'chat') {
        try { require('./botroute').start(app, require('../ratelimit').RESUME_PROMPT, { role: 'bot', via: 'ide', reason: 'account-switch' }); resumed = { ok: true, how: 'chat continued' }; } catch (e) { resumed = { ok: false, why: e.message }; }
      }
    }
    return ok({ ...r, resumed, lanes: lanes(app) });
  },
  'POST /api/intel/roles': async (app) => {
    const out = {};
    for (const role of S().ROLES) out[role] = S().roleDefault(role);
    return ok({ roles: out, families: F().families(app).map((f) => ({ id: f.id, label: f.label, kind: f.kind })) });
  },
  'POST /api/intel/role': async (app, body = {}) => {
    const role = String(body.role || '');
    if (!S().ROLES.includes(role)) return bad(`role is one of ${S().ROLES.join(', ')}`);
    if (body.clear) { S().setRoleDefault(role, null); return ok({}); }
    const f = F().family(app, String(body.family || ''));
    if (!f) return bad('choose a provider');
    const m = body.model ? f.byModel.get(String(body.model)) : null;
    if (body.model && !m) return bad(`${f.label} does not offer ${body.model}`);
    const caps = require('../fabric/effortcaps');
    const effort = body.effort && body.effort !== 'auto' ? caps.norm(body.effort) : null;
    if (effort && !(m && m.efforts.includes(effort))) return bad(`${m ? m.label : 'that model'} ${m && m.efforts.length ? `offers ${m.efforts.map(caps.label).join(', ')}` : 'has no configurable effort'}`);
    const execution = require('../profile').normalize(body.execution) || null;
    const policy = ['auto', 'pinned', 'ask'].includes(body.policy) ? body.policy : null;
    // A BACKING ACCOUNT BELONGS IN A DEFAULT ONLY WHEN IT IS PINNED.
    const pinned = policy === 'pinned' ? (f.accounts.some((a) => a.id === body.pinned) ? body.pinned : null) : null;
    if (policy === 'pinned' && !pinned) return bad('a pinned default names one of the provider\'s accounts');
    S().setRoleDefault(role, { family: f.id, model: m ? m.id : null, effort, execution, policy, pinned });
    // THE CODING DEFAULT'S EXECUTION is what a new session starts with.
    if (role === 'coding' && execution) { const cfg = ((app && app._sibling) || app).cfg; cfg.executionProfile = execution; try { require('../config').save(cfg); } catch { /* in memory */ } }
    return ok({ role, value: S().roleDefault(role) });
  },
  /**
   * REFRESH MODELS (2026-10-02) — the provider's own listing, as a new catalog generation (modelcatalog.js). All
   * providers, or one (`family`: codex · claude · antigravity · api · api:<connection>). Distinct from Refresh account.
   * Nothing is selected for anyone: a new model only becomes available.
   */
  'POST /api/models/refresh': async (app, body = {}) => {
    const MC = require('../modelcatalog');
    const r = await MC.refresh(app, { family: body.family ? String(body.family) : null });
    tray(app);
    return ok({ ...r, summaries: r.diffs.map((d) => MC.summarize(d)).filter(Boolean) });
  },
  /** What the last generations changed, for a subtle "2 new models" — no refresh is run. */
  'POST /api/models/updates': async (app, body = {}) => {
    const MC = require('../modelcatalog');
    const since = Number(body.since) || 0;
    return ok({ newCount: MC.newCount(), diffs: MC.diffs({ since }), summaries: MC.diffs({ since }).map((d) => MC.summarize(d)).filter(Boolean) });
  },
  /**
   * REFRESH ACCOUNT — identity, health and quota (2026-10-02). One account (`id`), one provider (`family`), or all.
   * `force` asks the provider even when the last reading is younger than its TTL (the person pressed Refresh); without
   * it a fresh reading is served from the cache. A DISABLED account is skipped: nothing polls an account nothing uses.
   * Models are a different act — `/api/models/refresh`.
   */
  'POST /api/intel/refresh': async (app, body = {}) => {
    const fam = body.family ? String(body.family) : null;
    const only = body.id ? String(body.id) : null;
    const force = body.force !== false;
    const notes = [];
    const ai = require('../accountinstances');
    const FAM = { 'claude-code': 'claude', codex: 'codex', antigravity: 'antigravity' };
    const accts = (() => { try { return F().families(app).flatMap((f) => f.accounts); } catch { return []; } })();
    const enabledInst = (instId) => { const a = accts.find((x) => x.instanceId === instId || x.id === instId); return !a || a.enabled !== false; };
    if ((!fam || fam === 'claude') && !only) {
      try { await require('../runtimeadapters').report(app, 'claude-code', { refresh: true }); notes.push('Claude Code'); } catch (e) { notes.push(`Claude Code: ${e.message}`); }
    }
    for (const v of ai.list(app)) {
      const vf = FAM[v.driver_id];
      if (!vf || (fam && fam !== vf) || (only && only !== v.id && !accts.some((a) => a.id === only && a.instanceId === v.id))) continue;
      if (!enabledInst(v.id)) { notes.push(`${v.display_name}: disabled — not refreshed`); continue; }
      // eslint-disable-next-line no-await-in-loop -- one account at a time, each in its own directory
      try { await ai.refreshQuota(app, v.id, { force }); notes.push(v.display_name); } catch (e) { notes.push(`${v.display_name}: ${e.message}`); }
    }
    // API SOURCES WHOSE PROVIDER REPORTS QUOTA WITHOUT A MODEL CALL (Z.ai's monitor — fabric/quotaread.js).
    if (!fam || fam.startsWith('api:')) {
      try { for (const r of await require('../fabric/quotaread').refreshApi(app)) notes.push(r.ok ? `${r.id}: ${r.windows} window(s)` : `${r.id}: ${r.why}`); } catch (e) { notes.push(`API quota: ${e.message}`); }
    }
    try { require('../appcatalog').invalidate(); } catch { /* not loaded */ }
    tray(app);
    return ok({ refreshed: notes });
  },
  // DISCOVER (Phase 8.4): what already exists on this PC. Existence only; cached briefly; no model, no quota.
  'POST /api/intel/discovered': async (app, body = {}) => ok({ discovered: require('../fabric/discover').discovered(app, { force: Boolean(body.force) }) }),
  // CONNECT ACCOUNT (Phase 8.4 hotfix): an AuthSession scoped to ONE new account. It never touches an existing account's
  // directory or any running provider process (authsession.js).
  // REMOVE ONE ACCOUNT — any kind (a connected instance, the default runtime profile, a setup entry). Detach never signs out.
  'POST /api/intel/detach': async (app, body = {}) => {
    const id = String(body.id || ''); const mode = ['detach', 'sign-out', 'remove-profile'].includes(body.mode) ? body.mode : 'detach';
    if (mode !== 'detach' && body.confirm !== true) return bad('confirm signing out', 428, { needsConfirm: true });
    const D = require('../fabric/detach');
    const f = F().families(app).find((x) => x.accounts.some((a) => a.id === id) || x.setup.some((p) => p.id === id));
    if (!f) return bad('no such account', 404);
    const a = f.accounts.find((x) => x.id === id);
    const r = a ? await D.one(app, { id: a.id, instanceId: a.instanceId, ownership: a.ownership, name: a.name, family: f.id }, mode) : await D.setupEntry(app, f.setup.find((p) => p.id === id));
    if (r.ok) tray(app);
    return r.ok ? ok({ result: r, steps: r.steps || [] }) : bad(r.why, 409, { busy: Boolean(r.busy), usedBy: r.usedBy || null });
  },
  'POST /api/intel/detach-all': async (app, body = {}) => {
    if (body.confirm !== true) return bad('confirm removing every account of this provider', 428, { needsConfirm: true });
    const r = await require('../fabric/detach').all(app, String(body.family || ''), { signOut: body.signOut === true });
    if (!r.ok) return bad(r.why, 404);
    tray(app);
    return ok(r);
  },
  // THE TEST MESSAGE — a real execution through one Antigravity account. Only its answer makes Chat and Assistant available for it.
  'POST /api/intel/verify': async (app, body = {}) => {
    const id = String(body.id || '');
    const a = F().families(app).flatMap((f) => f.accounts).find((x) => x.id === id);
    if (!a || !a.instanceId) return bad('no such account', 404);
    if (a.verified === null) return bad('that account needs no test', 400);
    const r = await require('../drivers/antigravity').verify(app, a.instanceId);
    tray(app);
    return r.ok ? ok({ verified: true, text: r.text }) : bad(r.why, r.busy ? 409 : 502, { busy: Boolean(r.busy) });
  },
  'POST /api/intel/auth/start': async (app, body = {}) => {
    const r = await require('../authsession').start(app, String(body.family || ''), { name: body.name, device: Boolean(body.device), reuse: body.reuse ? String(body.reuse) : null });
    return r.ok ? ok({ session: r.session, resumed: Boolean(r.resumed) }) : bad(r.why, 409, { needs: r.needs || null, session: r.session || null });
  },
  // THE OFFICIAL ANTIGRAVITY SERVER: installed only when the person says so, after being told the size and the source.
  'POST /api/intel/antigravity/install': async (app, body = {}) => {
    const ag = require('../drivers/antigravity');
    const r = await ag.installServer(app, { confirm: body.confirm === true });
    return r.ok ? ok({ ...r, status: ag.installStatus(app) }) : bad(r.why, r.why === 'confirm the download first' ? 428 : 409);
  },
  'POST /api/intel/antigravity/status': async (app) => ok({ status: require('../drivers/antigravity').installStatus(app) }),
  'POST /api/intel/auth/status': async (app, body = {}) => {
    const A = require('../authsession');
    const s = body.id ? A.get(String(body.id)) : (A.activeFor(String(body.family || '')) || null);
    return ok({ session: A.view(s), sessions: body.id || body.family ? undefined : A.list() });
  },
  'POST /api/intel/auth/cancel': async (app, body = {}) => {
    const r = await require('../authsession').cancel(app, String(body.id || ''));
    if (r.ok) { try { require('../appcatalog').invalidate(); const root = app._sibling || app; root._acctMemo = null; root._catMemo = null; } catch { /* rebuilt on the next read */ } }
    return r.ok ? ok({ session: r.session }) : bad(r.why, 404);
  },
  'POST /api/intel/use': async (app, body = {}) => {
    const r = await require('../fabric/discover').use(app, String(body.key || ''), { force: true });
    if (!r.ok) return bad(r.why, 409);
    try { require('../appcatalog').invalidate(); const root = app._sibling || app; root._acctMemo = null; root._catMemo = null; } catch { /* the next read rebuilds */ }
    tray(app);
    return ok({ id: r.id, family: r.family, refreshed: r.refreshed });
  },
  'POST /api/migrate/discover': async (app, body = {}) => {
    const m = require('../fabric/migrate');
    const d = m.discover(app, { exportFile: body.exportFile || null, routers: body.routers !== false });
    const token = require('crypto').randomBytes(12).toString('hex');
    for (const [k, v] of pendingImports) if (Date.now() - v.at > 30 * 60 * 1000) pendingImports.delete(k);
    // THE CREDENTIALS STAY HERE, in Core's memory behind a one-time token; the window receives only the plan.
    pendingImports.set(token, { found: d.found, at: Date.now() });
    return ok({ token, plan: d.plan, exportError: d.exportError, routers: d.routers, placeholders: Object.keys(S().placeholders()).length });
  },
  'POST /api/migrate/apply': async (app, body = {}) => {
    const p = pendingImports.get(String(body.token || ''));
    if (!p) return bad('discover again — that list has expired', 410);
    const keys = Array.isArray(body.keys) ? body.keys.map(String) : null;
    const found = keys ? p.found.filter((x) => keys.includes(x.key)) : p.found;
    const r = await require('../fabric/migrate').apply(app, found, body.decisions && typeof body.decisions === 'object' ? body.decisions : {});
    return ok(r);
  },
  // A WINDOW OPENED FOR THE MODEL DASHBOARD (fabric/dashlaunch.js) asks once where to start.
  'POST /api/desktop/startnav': async () => ok({ nav: require('./ipc').takeNavigation() }),
};

module.exports = { ROUTES };
