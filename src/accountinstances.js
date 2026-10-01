'use strict';

/**
 * ACCOUNT INSTANCES — one row per account LAIN can reach, each its own thing.
 *
 * ------------------------------------------------------------------------
 * AN ACCOUNT INSTANCE IS:
 *
 *   id, driver_id, display_name          who it is to LAIN
 *   identity                             who the PROVIDER says it is (from the
 *                                        runtime/API, never typed in)
 *   source_type                          api · runtime · website
 *   runtime, config_home, shadow_home    where its runtime keeps its state
 *   credential_ref                       a NAME for its secret (credentials.js),
 *                                        or null when the runtime holds its own
 *   authentication_state, runtime_state  read from the handle
 *   models, capabilities                 what it serves, and the labels
 *   limits, reset_windows                the provider's own windows
 *   assigned_roles                       where the person put it
 *
 * ------------------------------------------------------------------------
 * WHO OWNS WHAT (nothing moves here):
 *
 *   API-key accounts    connections.js — each configured connection IS an
 *                       instance; this file projects it (credential by ref)
 *   runtime accounts    persisted here, non-secret: <configDir>/accounts.json;
 *                       live state in the driver's per-instance handle
 *   website sessions    modelsource/registry.js (projected by the window)
 *
 * NEVER MERGED. Two instances signed in as the same email, the same provider,
 * the same model or reading the same session store are two rows with two
 * usages and two sets of limits. A shared identity is flagged, not collapsed.
 *
 * NO ROTATION. Nothing here moves work to another account because one is
 * limited. A switch is the person's act (or an explicit, configured failover
 * that says so where it happens).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const drivers = require('./providerdrivers');

const live = new Map();   // instance id -> handle (this process)

function file() { return path.join(require('./config').configDir(), 'accounts.json'); }
function read() {
  try { const d = JSON.parse(fs.readFileSync(file(), 'utf8')); if (d && d.instances) return d; } catch { /* first run */ }
  return { version: 1, instances: {}, foreground: {} };
}
function write(d) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(`${file()}.tmp`, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(`${file()}.tmp`, file());
  try { require('./accountcatalog').touched(file()); } catch { /* not loaded yet */ }
}

function root(app) { return (app && app._sibling) || app; }

function handleFor(app, rec) {
  if (live.has(rec.id)) return live.get(rec.id);
  const d = drivers.get(rec.driver_id);
  if (!d || typeof d.create !== 'function') return null;
  const cfg = (root(app) && root(app).cfg) || {};
  const h = d.create({ id: rec.id, config: rec.config || {} }, { binary: d.binary ? d.binary(cfg) : null });
  live.set(rec.id, h);
  return h;
}

/** Past its reset, a window's figure is no longer the provider's current word. */
function stampWindows(limits, now = Date.now()) {
  if (!limits) return null;
  return {
    ...limits,
    windows: (limits.windows || []).map((w) => ({ ...w, expired: Boolean(w.resetsAt && now >= w.resetsAt), resetConfirmed: false })),
  };
}

/**
 * WHAT A REFRESH LEARNED IS KEPT (Phase 8.2) — the account's models and whether
 * it is signed in — so its route (runtime:codex:<id>) exists with no process
 * running. Once per refresh: the person's, or the one Codex's sign-in triggers.
 * Non-secret: model ids and a flag.
 */
function remember(app, rec, snap) {
  if (!snap || !snap.refreshedAt || (rec.seenAt || 0) >= snap.refreshedAt) return;
  try {
    const d = read();
    const r = d.instances[rec.id];
    if (!r) return;
    const wasSignedIn = Boolean(r.signedIn);
    r.models = (snap.models || []).slice(0, 80); r.signedIn = Boolean(snap.identity); r.seenAt = snap.refreshedAt;
    rec.seenAt = snap.refreshedAt;
    write(d);
    // A NEW GENERATION OF THIS PROVIDER'S CATALOG, if its listing moved (modelcatalog.js): NEW / no longer reported.
    if (r.signedIn && r.models.length) { try { const fam = { 'claude-code': 'claude', codex: 'codex', antigravity: 'antigravity' }[rec.driver_id]; if (fam) require('./modelcatalog').observeFamily(app, fam); } catch { /* recorded on the next refresh */ } }
    require('./appcatalog').invalidate();
    const ro = root(app); if (ro) ro._acctMemo = null;
    // A SIGN-IN JUST COMPLETED (Phase 8.3): the safe completion event a waiting CLI reads, and an
    // imported account waiting for exactly this sign-in is now migrated (fabric/migrate.js).
    if (!wasSignedIn && r.signedIn) {
      try { require('./fabric/store').stampSeen(rec.id); } catch { /* ordered by name until the next sign-in */ }
      try { require('./fabric/store').event('source-added', { kind: 'oauth', id: rec.id, family: rec.driver_id, name: rec.display_name, capabilities: { models: r.models.length } }); } catch { /* reported on the next read */ }
      setImmediate(() => { try { require('./fabric/migrate').reconcile(app); require('./fabric/tray').changed(app); } catch { /* the next read reconciles */ } });
    }
    // WHAT THE ACCOUNT REPORTED about its windows is kept for every surface and the tray.
    if (snap.limits && Array.isArray(snap.limits.windows)) { try { require('./fabric/store').recordQuota(rec.id, { windows: snap.limits.windows, source: snap.limits.basis || snap.limits.reportedBy || rec.driver_id }); } catch { /* reported on the next read */ } }
  } catch { /* the registry stays as it was */ }
}

/** The safe projection of a runtime instance. No secret can be in it: none is held. */
function viewRuntime(app, rec) {
  const d = drivers.get(rec.driver_id);
  const h = handleFor(app, rec);
  const snap = h ? h.current() : null;
  remember(app, rec, snap);
  const limits = stampWindows(snap && snap.limits);
  return {
    id: rec.id,
    driver_id: rec.driver_id,
    display_name: rec.display_name,
    provider: d ? d.provider : null,
    source_type: d ? d.sourceType : 'runtime',
    connection: d ? d.connection : null,
    identity: snap ? snap.identity : null,
    runtime: snap ? { kind: rec.driver_id, pid: snap.pid, home_mode: snap.layout.mode, session_store: snap.layout.storeKey, unshared: snap.layout.unshared } : null,
    config_home: snap ? (snap.layout.shared || snap.layout.home) : null,
    shadow_home: snap && snap.layout.mode === 'overlay' ? snap.layout.home : null,
    credential_ref: null,
    credential: { held_by: 'runtime', note: 'the runtime keeps its own sign-in in this account\'s home; Noema holds no secret for it' },
    authentication_state: snap ? snap.authentication_state : 'UNKNOWN',
    runtime_state: snap ? snap.runtime_state : 'NOT_INSTALLED',
    login: snap ? snap.login : null,
    models: (snap && snap.models && snap.models.length ? snap.models : (rec.models || [])),
    // A REAL EXECUTION HAS SUCCEEDED through this account (a request, or its test message) — what a capability is advertised on.
    verified_at: rec.verified_at || null, verified_by: rec.verified_by || null,
    version: (snap && snap.version) || null,
    signed_in_providers: (snap && snap.signedInProviders) || null,
    capabilities: d ? [...d.capabilities] : [],
    usage: null,
    limits,
    limits_error: snap ? snap.limitsError : null,
    reset_windows: [
      ...(limits ? limits.windows.filter((w) => w.resetsAt).map((w) => ({ id: w.id, label: w.label, resetsAt: w.resetsAt, expired: w.expired, confirmed: false, basis: 'reported window' })) : []),
      // A DOCUMENTED reset the runtime does not report: expected, never confirmed.
      ...((snap && snap.expectedResets) || []).map((w) => ({ ...w, expired: Boolean(w.resetsAt && Date.now() >= w.resetsAt), confirmed: false })),
    ],
    assigned_roles: rec.assigned_roles || [],
    // WHOSE DIRECTORY IT IS: `lain` (LAIN made it and may sign it out and delete it) or `external_native` (the person's own).
    ownership: (rec.config && rec.config.ownership) || (snap && snap.layout && snap.layout.lainOwned === false ? 'external_native' : 'lain'),
    sessions: snap ? { held: snap.threads } : { held: [] },
    refreshed_at: snap ? snap.refreshedAt : null,
    created_at: rec.created_at,
    install: d && (!snap || snap.runtime_state === 'NOT_INSTALLED') ? d.install : null,
  };
}

/** An API connection, as an instance. The key stays a reference. */
function viewApi(app, c) {
  const creds = require('./credentials');
  const ref = c.credentialRef || null;
  const cred = ref ? creds.describe(ref)
    : c.envKey && process.env[c.envKey] ? { ref: `env:${c.envKey}`, present: true, masked: creds.mask(process.env[c.envKey]), kind: 'api_key' }
      : c.apiKey ? { ref: null, present: true, masked: creds.mask(c.apiKey), kind: 'api_key', plaintext: true }
        : { ref: null, present: c.via === 'bridge', masked: null, kind: c.via === 'bridge' ? 'bridge' : null };
  const uw = (() => { try { return require('./usagewindows').forConnection(c.id); } catch { return null; } })();
  return {
    id: c.id,
    driver_id: `api:${c.provider}`,
    display_name: (root(app).cfg.accounts && root(app).cfg.accounts.names && root(app).cfg.accounts.names[c.id]) || c.id,
    provider: c.provider,
    source_type: 'api',
    connection: c.via === 'bridge' ? 'bridge (the bridge holds the sign-in)' : `${c.provider} API`,
    identity: null,
    runtime: null, config_home: null, shadow_home: null,
    credential_ref: ref || (c.envKey && process.env[c.envKey] ? `env:${c.envKey}` : null),
    credential: { masked: cred.masked, present: cred.present, plaintext: Boolean(cred.plaintext), storedAt: cred.storedAt || null },
    authentication_state: c.readiness,
    runtime_state: null,
    models: (c.models || []).map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name)) || '')).filter(Boolean).slice(0, 200),
    capabilities: ['BOT', 'CHAT', 'AGENT', 'AUX'],
    usage: null,
    limits: uw ? { source: 'provider', reportedBy: 'response headers', windows: uw.windows || [], observedAt: uw.at || null } : null,
    reset_windows: [],
    assigned_roles: (root(app).cfg.accounts && root(app).cfg.accounts.roles && root(app).cfg.accounts.roles[c.id]) || [],
    sessions: null,
  };
}

/** Every instance: runtime ones from the registry, API ones from connections. */
function list(app) {
  const d = read();
  const out = Object.values(d.instances).map((rec) => viewRuntime(app, rec));
  let conns = [];
  try { conns = root(app).connections ? root(app).connections() : []; } catch { conns = []; }
  // LOCAL AND RUNTIME ROUTES are not accounts (no credential, no provider account) — MODEL › Local / › Runtimes show them.
  for (const c of conns) if (c.protocol !== 'runtime') out.push(viewApi(app, c));
  // SAME IDENTITY, TWO ROWS — flagged, never merged.
  const seen = new Map();
  for (const v of out) {
    const k = v.identity && (v.identity.providerAccountId || v.identity.email) ? `${v.driver_id}|${v.identity.providerAccountId || v.identity.email}|${v.identity.planType || ''}` : null;
    if (!k) continue;
    if (seen.has(k)) { v.sameIdentityAs = seen.get(k); } else seen.set(k, v.id);
  }
  return out;
}

function get(app, id) { return list(app).find((v) => v.id === String(id)) || null; }

function add(app, { driver_id, display_name = '', config = {}, id: wanted = null } = {}) {
  const drv = drivers.get(driver_id);
  if (!drv) return { ok: false, why: 'unknown account kind' };
  if (drv.sourceType === 'api') return { ok: false, why: 'API accounts are added with a key (MODEL › Add account › API key)' };
  // A CONFIGURED DEFAULT (cfg.accounts.<driver>) — e.g. which Codex home new overlay accounts share.
  const rootCfg = ((root(app) && root(app).cfg && root(app).cfg.accounts) || {})[driver_id] || {};
  const cfg = { ...(drv.defaultConfig ? drv.defaultConfig() : {}), ...(rootCfg.shared_home ? { shared_home: rootCfg.shared_home } : {}), ...config };
  const bad = drv.validate ? drv.validate(cfg) : null;
  if (bad) return { ok: false, why: bad };
  const d = read();
  const existing = Object.values(d.instances).filter((r) => r.driver_id === driver_id);
  if (drv.supportsMultipleInstances === false && existing.length) return { ok: false, why: `${drv.displayName} supports one account` };
  // ONE INSTANCE, ONE CONFIG HOME. Two instances on one home would be one
  // sign-in with two names — the collapse this registry exists to prevent.
  const homeOf = (c) => { const h = c.codex_home || c.home; return h ? path.resolve(String(h).replace(/^~(?=$|[\\/])/, require('os').homedir())).toLowerCase() : null; };
  const want = cfg.home_mode === 'overlay' ? null : homeOf(cfg);
  if (want) {
    const clash = existing.find((r) => (r.config || {}).home_mode !== 'overlay' && homeOf(r.config || {}) === want);
    if (clash) return { ok: false, why: `${clash.display_name} already uses that home; each account needs its own` };
  }
  // A CALLER THAT MUST KNOW THE ID BEFORE THE ACCOUNT EXISTS (an auth session allocating its own directory) may name it.
  const id = wanted && /^[a-z][a-z0-9-]{3,40}$/.test(String(wanted)) && !d.instances[wanted] ? String(wanted) : `${driver_id}-${crypto.randomBytes(3).toString('hex')}`;
  const name = String(display_name || '').trim().slice(0, 60) || `${drv.displayName} ${existing.length + 1}`;
  d.instances[id] = { id, driver_id, display_name: name, config: cfg, assigned_roles: [], created_at: new Date().toISOString() };
  write(d);
  return { ok: true, instance: viewRuntime(app, d.instances[id]) };
}

function rename(app, id, name) {
  const n = String(name || '').trim().slice(0, 60);
  if (!n) return { ok: false, why: 'a name is needed' };
  const d = read();
  if (d.instances[id]) { d.instances[id].display_name = n; write(d); return { ok: true }; }
  const r = root(app);
  const conn = (r.connections ? r.connections() : []).find((c) => c.id === id);
  if (!conn) return { ok: false, why: 'no such account' };
  r.cfg.accounts = r.cfg.accounts || {}; r.cfg.accounts.names = r.cfg.accounts.names || {};
  r.cfg.accounts.names[id] = n;
  require('./config').save(r.cfg);
  return { ok: true };
}

function record(id) { return read().instances[String(id)] || null; }
function handle(app, id) { const rec = record(id); return rec ? handleFor(app, rec) : null; }

async function refresh(app, id) {
  const h = handle(app, id);
  if (!h) return { ok: false, why: 'no such runtime account' };
  try {
    await h.refresh();
    remember(app, record(id) || {}, h.current());
    return { ok: true, instance: get(app, id) };
  }
  catch (e) { return { ok: false, why: require('./redact').text(String(e.message || e)).slice(0, 200), instance: get(app, id) }; }
}

/**
 * THIS ACCOUNT'S QUOTA — the provider's own windows, never a model request. A driver with its own quota read
 * uses it (Claude: Anthropic's usage read, or this account's last receipt — no process started); the rest refresh
 * their status, which for Codex is `account/rateLimits/read` through its app-server. An API source whose provider
 * answers quota on request (Z.ai's monitor — fabric/quotaread.js) is read with the key this module already projects;
 * the key goes to that one read and nowhere else (tests/unit/credentialguard.test.js).
 */
async function refreshQuota(app, id, opts = {}) {
  const h = handle(app, id);
  if (!h) return refreshApiQuota(app, id);
  if (typeof h.refreshQuota === 'function') {
    try {
      const r = await h.refreshQuota(opts);
      // THE ONE QUOTA STORE (fabric/store): every surface — Accounts, Usage, the tray, the CLI — reads these windows.
      if (r && r.ok && r.limits && Array.isArray(r.limits.windows) && r.limits.windows.length) {
        try { require('./fabric/store').recordQuota(String(id), { windows: r.limits.windows, source: r.basis || r.limits.basis || null }); } catch { /* reported on the next read */ }
      }
      return { ...r, instance: get(app, id) };
    } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 200) }; }
  }
  return refresh(app, id);
}

async function refreshApiQuota(app, id) {
  const r = root(app);
  let conn = null;
  try { conn = (r && r.connections ? r.connections() : []).find((c) => c.id === String(id)) || null; } catch { conn = null; }
  if (!conn) return { ok: false, why: 'no such account' };
  const qr = require('./fabric/quotaread');
  if (!qr.isZai(conn.baseUrl, conn.provider)) return { ok: true, windows: null, note: 'this provider reports its limits on a response, not on request' };
  const key = conn.apiKey || '';
  if (!key) return { ok: false, why: 'no API key' };
  const q = await qr.zaiQuota(conn.baseUrl, key);
  if (!q.ok) return q;
  let acct = null;
  try { acct = require('./accountcatalog').list(app).accounts.find((a) => a.base === conn.id) || null; } catch { acct = null; }
  if (acct) require('./fabric/store').recordQuota(acct.id, { windows: q.windows, source: q.basis });
  return { ok: true, windows: q.windows, basis: q.basis };
}

async function login(app, id, { device = false } = {}) {
  const h = handle(app, id);
  if (!h || !h.login) return { ok: false, why: 'this account signs in elsewhere' };
  try { return { ok: true, login: await h.login({ device }) }; }
  catch (e) { return { ok: false, why: require('./redact').text(String(e.message || e)).slice(0, 200) }; }
}

/**
 * DISCONNECT one account, touching no other:
 *   · its runtime stops (the process this handle started)
 *   · the runtime's own sign-out removes its sign-in — by default only in a home
 *     LAIN created; an adopted home keeps it unless `logout: true` is asked for
 *   · an overlay shadow home LAIN made is removed (links unlinked, never followed)
 *   · a direct home is KEPT — its native sessions are the person's history
 *   · it leaves the registry and every role
 */
async function disconnect(app, id, { logout, removeProfile = false } = {}) {
  const d = read();
  const rec = d.instances[id];
  if (!rec) return { ok: false, why: 'no such runtime account (API keys are removed with Remove key)' };
  // NEVER UNDER A RUNNING REQUEST: work in flight through this account is not interrupted by a detach or a sign-out.
  // (The person's Stop ends a run; this only refuses to do it for them.)
  const working = require('./accountwork').busy(rec.driver_id, id);
  if (working.length) return { ok: false, busy: true, why: `a request is running through ${rec.display_name} — let it finish, or stop it first` };
  const h = handleFor(app, rec);
  const held = require('./threadwriters').list().filter((t) => t.instanceId === id && !t.stale);
  if (held.length) return { ok: false, why: `it is writing to ${held.length} thread(s); hand them over or finish first` };
  const steps = [];
  // SIGN OUT ONLY WHERE LAIN MADE THE HOME. An adopted home (the person's own
  // ~/.codex) keeps its sign-in unless signing out there is asked for explicitly.
  if (logout === undefined) logout = Boolean(h && h.layout && h.layout.lainOwned);
  if (h && logout) { try { await h.logout(); steps.push('signed out through the runtime'); } catch (e) { steps.push(`sign-out skipped: ${String(e.message || e).slice(0, 80)}`); } }
  if (h) { await h.stop(); steps.push('runtime stopped'); }
  live.delete(id);
  if (removeProfile && h && h.layout && h.layout.lainOwned) { const r = h.removeOwned(); steps.push(r.removed ? 'LAIN-owned profile removed' : `profile kept: ${r.why}`); }
  else if (h && h.layout && h.layout.mode === 'overlay') { const r = h.removeOwned(); steps.push(r.removed ? 'shadow home removed' : `shadow home kept: ${r.why}`); }
  else if (h && h.layout) steps.push(`home kept at ${h.layout.home} (its native sessions are yours)`);
  delete d.instances[id];
  for (const k of Object.keys(d.foreground || {})) if (d.foreground[k] === id) delete d.foreground[k];
  write(d);
  return { ok: true, steps };
}

/**
 * A REAL EXECUTION SUCCEEDED THROUGH THIS ACCOUNT. Capabilities that need an execution to be believed (Antigravity's Chat and
 * Assistant) are advertised only from here on — never from a sign-in alone, never from a fake. `how`: 'request' | 'test'.
 */
function markVerified(app, id, how = 'request') {
  const d = read();
  const rec = d.instances[id];
  if (!rec) return { ok: false, why: 'no such runtime account' };
  const first = !rec.verified_at;
  rec.verified_at = Date.now(); rec.verified_by = how === 'test' ? 'test' : 'request';
  write(d);
  if (first) {
    try { require('./appcatalog').invalidate(); const r = root(app); if (r) { r._acctMemo = null; r._catMemo = null; } } catch { /* rebuilt on the next read */ }
    try { require('./fabric/tray').changed(app); } catch { /* presentation only */ }
  }
  return { ok: true, first };
}

/** The person's choice of which account is in front, per driver. Not a rotation. */
function setForeground(app, id) {
  const d = read();
  const rec = d.instances[id];
  if (!rec) return { ok: false, why: 'no such runtime account' };
  d.foreground = d.foreground || {};
  d.foreground[rec.driver_id] = id;
  write(d);
  return { ok: true };
}
function foreground(driverId) { const d = read(); return (d.foreground || {})[driverId] || null; }

async function stopAll() {
  const hs = [...live.values()];
  live.clear();
  await Promise.allSettled(hs.map((h) => h.stop()));
}

/** Every registered runtime instance record (non-secret), without starting anything. */
function records() { return Object.values(read().instances); }

module.exports = { list, get, add, rename, refresh, refreshQuota, login, disconnect, markVerified, setForeground, foreground, handle, record, records, stopAll, stampWindows, file };
