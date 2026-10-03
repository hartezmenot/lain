'use strict';

/** THE CODEX DRIVER — a plain value. */

const codexhome = require('./codexhome');
const { CodexRpc, resolveBinary } = require('./codexrpc');

const IDLE_MS = 5 * 60 * 1000;

function windowLabel(mins, fallback) {
  if (mins === 300) return '5h';
  if (mins === 10080) return 'weekly';
  if (mins >= 40000 && mins <= 45000) return 'monthly';
  if (mins && mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins && mins % 60 === 0) return `${mins / 60}h`;
  return mins ? `${mins}m` : fallback;
}

function mapWindow(w, id) {
  if (!w || typeof w !== 'object') return null;
  const mins = Number(w.windowDurationMins) || null;
  return {
    id, label: windowLabel(mins, id),
    usedPercent: Number.isFinite(Number(w.usedPercent)) ? Number(w.usedPercent) : null,
    resetsAt: Number(w.resetsAt) ? Number(w.resetsAt) * 1000 : null,
    windowMins: mins,
  };
}

/** Codex's rate-limit snapshot → LAIN's provider-limits shape. Nothing inferred. */
function mapLimits(r) {
  const rl = (r && (r.rateLimits || r)) || {};
  const byId = (r && r.rateLimitsByLimitId) || null;
  const pick = (byId && byId.codex) || rl;
  const windows = [mapWindow(pick.primary, 'primary'), mapWindow(pick.secondary, 'secondary')].filter(Boolean);
  return {
    source: 'provider', reportedBy: 'codex app-server', observedAt: Date.now(),
    planType: pick.planType || rl.planType || null,
    limitId: pick.limitId || rl.limitId || null,
    providerAccountId: (r && r.accountId) || null,
    windows,
    resetCredits: r && r.rateLimitResetCredits && Number.isFinite(Number(r.rateLimitResetCredits.available)) ? Number(r.rateLimitResetCredits.available) : null,
  };
}

/** Codex's model/list → [{ id, label, efforts }]. Whatever the account is entitled to, as Codex says it. */
function mapModels(r) {
  const rows = ((r && (r.data || r.models || r.items)) || []).filter((m) => !(m && m.hidden));   // hidden presets stay hidden, as in Codex's own picker
  return rows.map((m) => (typeof m === 'string' ? { id: m, label: m, efforts: [] } : {
    id: String(m.model || m.id || m.slug || ''),
    label: String(m.displayName || m.display_name || m.model || m.id || ''),
    efforts: (m.supportedReasoningEfforts || m.reasoningEfforts || []).map((e) => (typeof e === 'string' ? e : e.reasoningEffort || e.effort)).filter(Boolean),
    isDefault: Boolean(m.isDefault || m.is_default),
    // THE LEVEL CODEX USES WHEN NONE IS PINNED (Phase 8.3) — shown as the model's default, never invented.
    defaultEffort: (m.defaultReasoningEffort && (typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : m.defaultReasoningEffort.reasoningEffort)) || null,
  })).filter((m) => m.id).slice(0, 80);
}

function mapIdentity(read) {
  const a = read && read.account;
  if (!a) return null;
  if (a.type === 'chatgpt') return { kind: 'chatgpt', email: a.email || null, planType: a.planType || null };
  if (a.type === 'apiKey') return { kind: 'api_key', email: null, planType: null };
  return { kind: String(a.type || 'unknown'), email: a.email || null, planType: a.planType || null };
}

const driver = Object.freeze({
  id: 'codex',
  displayName: 'Codex',
  provider: 'openai',
  sourceType: 'runtime',
  supportsMultipleInstances: true,
  capabilities: Object.freeze(['EXTERNAL AGENT', 'RUNTIME ONLY']),
  connection: 'Codex subscription (ChatGPT sign-in through Codex)',
  install: { docs: 'https://developers.openai.com/codex/cli', how: 'npm install -g @openai/codex  — or the Codex app' },
  defaultConfig: () => ({ home_mode: 'overlay', shared_home: '~/.codex' }),
  validate(config = {}) {
    if (config.home_mode && !['direct', 'overlay'].includes(config.home_mode)) return 'home_mode is direct or overlay';
    if (config.codex_home && typeof config.codex_home !== 'string') return 'codex_home is a path';
    if (config.shared_home && typeof config.shared_home !== 'string') return 'shared_home is a path';
    return null;
  },
  binary(cfg) { return resolveBinary(cfg && cfg.accounts && cfg.accounts.codex && cfg.accounts.codex.binary); },

  create(instance, { binary } = {}) {
    const l = codexhome.layout(instance.id, instance.config || {});
    let rpc = null; let idle = null;
    const s = {
      runtime_state: binary ? 'STOPPED' : 'NOT_INSTALLED',
      authentication_state: 'UNKNOWN', identity: null, limits: null, limitsError: null,
      login: null, error: null, threads: new Set(), linkReport: null, refreshedAt: null, models: [],
    };
    function bump() {
      clearTimeout(idle);
      idle = setTimeout(() => { if (!s.threads.size && !s.login) stop().catch(() => {}); }, IDLE_MS);
      if (idle.unref) idle.unref();
    }
    async function client() {
      if (rpc && !rpc.closed) { bump(); return rpc; }
      if (!binary) throw new Error('Codex is not installed');
      s.linkReport = codexhome.materialize(l);
      rpc = new CodexRpc({ binary, home: l.home });
      rpc.on('account/rateLimits/updated', (p) => { s.limits = mapLimits(p); });
      rpc.on('account/updated', () => { s.refreshedAt = null; });
      rpc.on('account/login/completed', (p) => {
        s.login = s.login ? { ...s.login, done: true, ok: Boolean(p.success), error: p.error || null } : null;
        if (p.success) refresh().catch(() => {});
      });
      rpc.on('thread/closed', (p) => { if (p && p.threadId) s.threads.delete(p.threadId); });
      rpc.on('exit', () => { s.runtime_state = 'STOPPED'; s.threads.clear(); });
      s.runtime_state = 'STARTING';
      try { await rpc.start(); } catch (e) { s.runtime_state = 'ERROR'; s.error = String(e.message || e); throw e; }
      s.runtime_state = 'RUNNING'; s.error = null;
      bump();
      return rpc;
    }
    async function refresh() {
      const c = await client();
      const read = await c.request('account/read', {});
      s.identity = mapIdentity(read);
      s.authentication_state = s.identity ? 'AUTHENTICATED' : (read && read.requiresOpenaiAuth ? 'LOGIN_REQUIRED' : 'UNKNOWN');
      if (s.identity) {
        try { s.limits = mapLimits(await c.request('account/rateLimits/read', {})); s.limitsError = null; }
        catch (e) { s.limitsError = String(e.message || e).slice(0, 200); }
        // WHAT THIS ACCOUNT CAN RUN (Phase 8.2), in Codex's own words — so "Codex Account 3 › GPT-6 Sol" is a real route.
        try { s.models = mapModels(await c.request('model/list', {})); } catch { /* an older Codex: no list, no route */ }
      } else { s.limits = null; s.models = []; }
      s.refreshedAt = Date.now();
      return current();
    }
    function current() {
      return {
        runtime_state: s.runtime_state, authentication_state: s.authentication_state,
        identity: s.identity ? { ...s.identity, providerAccountId: (s.limits && s.limits.providerAccountId) || null } : null,
        limits: s.limits, limitsError: s.limitsError, refreshedAt: s.refreshedAt, error: s.error,
        login: s.login ? { loginId: s.login.loginId, kind: s.login.kind, url: s.login.url || null, userCode: s.login.userCode || null, done: Boolean(s.login.done), ok: s.login.ok ?? null, error: s.login.error || null } : null,
        threads: [...s.threads], pid: rpc && !rpc.closed ? rpc.pid : null, models: s.models || [],
        layout: { mode: l.mode, home: l.home, shared: l.shared, storeKey: l.storeKey, unshared: s.linkReport ? s.linkReport.unshared : [] },
      };
    }
    async function login({ device = false } = {}) {
      const c = await client();
      const r = await c.request('account/login/start', { type: device ? 'chatgptDeviceCode' : 'chatgpt' }, 30000);
      s.login = { loginId: r.loginId, kind: r.type, url: r.authUrl || r.verificationUrl || null, userCode: r.userCode || null, startedAt: Date.now() };
      return current().login;
    }
    async function cancelLogin() {
      if (!s.login || !rpc || rpc.closed) { s.login = null; return; }
      try { await rpc.request('account/login/cancel', { loginId: s.login.loginId }); } catch { /* already over */ }
      s.login = null;
    }
    async function logout() {
      const c = await client();
      await c.request('account/logout', {});
      s.identity = null; s.limits = null; s.authentication_state = 'LOGIN_REQUIRED';
    }
    async function threads({ limit = 50 } = {}) { const c = await client(); return c.request('thread/list', { limit }); }
    /** Read-only: the thread with its turns (Continue in LAIN imports this; nothing is written back). */
    async function readThread(threadId) { const c = await client(); return c.request('thread/read', { threadId, includeTurns: true }, 30000); }
    async function loaded() { const c = await client(); const r = await c.request('thread/loaded/list', {}); return (r && r.data) || []; }
    async function attachThread(threadId) { const c = await client(); const r = await c.request('thread/resume', { threadId }, 30000); s.threads.add(threadId); return r; }
    async function detachThread(threadId) {
      if (!rpc || rpc.closed) { s.threads.delete(threadId); return { status: 'notLoaded' }; }
      const r = await rpc.request('thread/unsubscribe', { threadId });
      s.threads.delete(threadId);
      return r;
    }
    async function stop() { clearTimeout(idle); if (rpc) await rpc.close(); rpc = null; s.runtime_state = binary ? 'STOPPED' : 'NOT_INSTALLED'; s.threads.clear(); }
    return {
      driver: 'codex', layout: l, storeKey: l.storeKey,
      env: () => ({ CODEX_HOME: l.home }),
      binary: () => binary,   // the program this account runs — codexexec.js runs the same one
      refresh, current, login, cancelLogin, logout, threads, readThread, loaded, attachThread, detachThread, stop,
      authIsPrivate: () => codexhome.authIsPrivate(l),
      removeOwned: () => codexhome.removeOwned(l),
    };
  },
});

module.exports = { driver, mapLimits, mapIdentity, mapModels, windowLabel };
