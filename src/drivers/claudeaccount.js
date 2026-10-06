'use strict';

/** CLAUDE ACCOUNTS — one AccountInstance per Claude sign-in, each with its OWN configuration directory (Phase 8.4 hotfix). */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = 'claude-code';
const ALIASES = Object.freeze(['opus', 'sonnet', 'haiku', 'fable']);

function accountsRoot() { return path.join(require('../config').configDir(), 'accounts', 'claude'); }
function homeFor(instanceId) { return path.join(accountsRoot(), String(instanceId)); }
/** The default Claude Code profile: what `claude` uses when nothing says otherwise. */
function defaultHome() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }

const norm = (p) => { const r = path.resolve(String(p || '')); return process.platform === 'win32' ? r.toLowerCase() : r; };
function inside(child, parent) { const c = norm(child); const p = norm(parent); return c === p || c.startsWith(p + path.sep); }

/** The binary from a config (accountinstances calls `binary(cfg)`), never PATH under an isolated test run. */
function binaryOf(cfg) {
  const s = ((cfg && cfg.runtimes) || {})[ID] || {};
  if (s.binary) return fs.existsSync(s.binary) ? { command: s.binary, args: [] } : null;
  if (process.env.LAIN_ISOLATED === '1') return null;
  const p = require('../pathlookup').find('claude', process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']);
  return p ? { command: p, args: [] } : null;
}

function statusOf(text) { try { return JSON.parse(text); } catch { return null; } }

/** When Claude Code could not be asked (not installed, an older version), the windows arrive with the account's first response. */
const QUOTA_NOTE = 'Quota appears after the first Claude response through this account';
/** How old a quota reading may be before a visible Accounts page asks Claude Code again (claudecontrol.js). */
const QUOTA_TTL_MS = 5 * 60_000;

const driver = Object.freeze({
  id: ID, displayName: 'Claude', provider: 'anthropic', sourceType: 'runtime',
  supportsMultipleInstances: true, capabilities: Object.freeze(['EXTERNAL AGENT', 'RUNTIME ONLY']),
  connection: 'Claude subscription, signed in by Claude Code itself — one configuration directory per account',
  install: { docs: 'https://docs.anthropic.com/en/docs/claude-code/setup', how: 'npm install -g @anthropic-ai/claude-code' },
  homeEnv: 'CLAUDE_CONFIG_DIR', defaultHome,
  defaultConfig: () => ({ ownership: 'lain' }),
  validate(config = {}) {
    if (config.ownership && !['lain', 'external_native'].includes(config.ownership)) return 'ownership is lain or external_native';
    if (!config.home || typeof config.home !== 'string') return 'a Claude account needs its own configuration directory';
    if ((config.ownership || 'lain') === 'lain') {
      if (!inside(config.home, accountsRoot()) || norm(config.home) === norm(accountsRoot())) return 'a LAIN-owned Claude account lives in its own directory under LAIN\'s accounts folder';
      if (norm(config.home) === norm(defaultHome())) return 'a new account is never signed in against the default Claude profile';
    }
    return null;
  },
  binary: binaryOf,
  locate() { const b = binaryOf({}); return b ? b.command : null; },

  create(instance, { binary } = {}) {
    const cfg = instance.config || {};
    const home = cfg.home;
    const lainOwned = (cfg.ownership || 'lain') === 'lain';
    const env = { CLAUDE_CONFIG_DIR: home };
    const storeKey = `${ID}:home:${norm(home)}`;
    const telemetryId = `${ID}--${instance.id}`;
    const s = { runtime_state: binary ? 'INSTALLED' : 'NOT_INSTALLED', authentication_state: 'UNKNOWN', identity: null, version: null, refreshedAt: null, error: null };

    async function refresh() {
      if (!binary) { s.runtime_state = 'NOT_INSTALLED'; return current(); }
      const cliexec = require('./cliexec');
      // READ-ONLY, in THIS account's directory and no other.
      try { fs.mkdirSync(home, { recursive: true }); } catch { /* the command reports it */ }
      const v = await cliexec.collect(binary.command, ['--version'], { timeoutMs: 20000, env, purpose: 'runtime-probe', label: 'claude --version' }).catch((e) => ({ ok: false, lines: [], stderr: e.message }));
      s.version = v.ok ? (v.lines[0] || '').trim().slice(0, 80) : null;
      s.runtime_state = v.ok ? 'INSTALLED' : 'ERROR';
      // ASKED, NOT RUN (claudecontrol.js): identity, the account's live model catalog and its quota windows from one
      // short status session in THIS account's directory — no prompt, no inference, no token read by LAIN.
      const asked = await ask({ usage: true });
      if (asked.ok) {
        s.authentication_state = asked.signedIn ? 'AUTHENTICATED' : 'LOGIN_REQUIRED';
        s.identity = asked.signedIn ? { email: asked.account.email || null, planType: asked.account.plan || null, method: asked.account.apiProvider || null, providerAccountId: null } : null;
        s.error = null;
        s.refreshedAt = Date.now();
        return current();
      }
      // AN OLDER CLAUDE CODE (no control protocol): its own `auth status`, identity only.
      const r = await cliexec.collect(binary.command, ['auth', 'status'], { timeoutMs: 20000, env, purpose: 'runtime-probe', label: 'claude auth status' }).catch((e) => ({ ok: false, lines: [], stderr: e.message }));
      const st = statusOf((r.lines || []).join('\n'));
      if (st && st.loggedIn) {
        s.authentication_state = 'AUTHENTICATED';
        s.identity = { email: st.email || null, planType: st.subscriptionType || null, method: st.authMethod || null, providerAccountId: null };
      } else {
        s.authentication_state = st ? 'LOGIN_REQUIRED' : 'UNKNOWN';
        s.identity = null;
      }
      s.error = st ? null : 'claude auth status gave no readable answer';
      s.refreshedAt = Date.now();
      return current();
    }
    /** One status session; what it learned (models, limits) is kept with the account's telemetry. */
    async function ask({ usage = true } = {}) {
      if (!binary) return { ok: false, why: 'Claude Code is not installed' };
      const a = await require('./claudecontrol').ask(binary, env, { usage });
      if (a.ok) {
        try {
          const ra = require('../runtimeadapters');
          const prev = ra.cachedTelemetry(telemetryId) || {};
          ra.saveTelemetry(telemetryId, { ...prev, models: a.models && a.models.length ? a.models : prev.models || null, modelsAt: a.models && a.models.length ? Date.now() : prev.modelsAt || null, ...(a.limits && a.limits.windows.length ? { limits: a.limits } : {}), quotaAskedAt: Date.now(), ...(a.limits && !a.limits.windows.length ? { quotaNote: 'Claude Code reported no plan windows for this account' } : {}) });
        } catch { /* the answer below still stands */ }
      }
      return a;
    }
    function limits() { try { const t = require('../runtimeadapters').cachedTelemetry(telemetryId); return t && t.limits ? t.limits : null; } catch { return null; } }
    /** THIS ACCOUNT'S QUOTA, NOW — without a model request (2026-10-02). */
    async function refreshQuota({ force = false } = {}) {
      const cached = limits();
      const t = (() => { try { return require('../runtimeadapters').cachedTelemetry(telemetryId) || {}; } catch { return {}; } })();
      if (!force && cached && Date.now() - (t.quotaAskedAt || cached.at || 0) < QUOTA_TTL_MS) {
        return { ok: true, limits: require('../accountinstances').stampWindows(cached), observedAt: cached.at || null, basis: cached.basis || null, cached: true };
      }
      const a = await ask({ usage: true });
      if (a.ok && a.limits && a.limits.windows.length) return { ok: true, limits: require('../accountinstances').stampWindows(a.limits), observedAt: a.limits.at, basis: a.limits.basis, live: true };
      if (cached) return { ok: true, limits: require('../accountinstances').stampWindows(cached), observedAt: cached.at || null, basis: cached.basis || null, note: a.ok ? (a.usageWhy || null) : `live read unavailable: ${a.why}` };
      return { ok: true, limits: null, note: a.ok ? (a.rateLimitsAvailable === false ? 'Claude Code reports no plan limits for this sign-in (API key or third-party provider)' : (a.usageWhy || QUOTA_NOTE)) : `${QUOTA_NOTE} (${a.why})` };
    }
    /** The models THIS account's Claude Code lists (claudecontrol.js), else the stable aliases. */
    function discovered() {
      try { const t = require('../runtimeadapters').cachedTelemetry(telemetryId); return t && Array.isArray(t.models) && t.models.length ? t.models : null; } catch { return null; }
    }
    function current() {
      const found = discovered();
      const models = s.authentication_state !== 'AUTHENTICATED' ? []
        : found ? found.map((m) => ({ id: `${ID}/${m.id}`, label: m.label, efforts: m.efforts || [], defaultEffort: null, capabilities: m.capabilities || null, description: m.description || '' }))
          : ALIASES.map((a) => ({ id: `${ID}/${a}`, label: `Claude ${a[0].toUpperCase()}${a.slice(1)} · Claude Code`, efforts: [], defaultEffort: null }));
      return {
        runtime_state: s.runtime_state, authentication_state: s.authentication_state, identity: s.identity,
        limits: limits(), limitsError: limits() ? null : QUOTA_NOTE,
        refreshedAt: s.refreshedAt, error: s.error, login: null, threads: [], pid: null, version: s.version, models,
        signedInProviders: null, expectedResets: [],
        layout: { mode: 'direct', home, shared: null, storeKey, unshared: [], lainOwned },
      };
    }
    return {
      driver: ID, layout: { mode: 'direct', home, lainOwned }, storeKey, telemetryId,
      env: () => env, refresh, current, refreshQuota, discoverModels: async () => { const a = await ask({ usage: false }); return a.ok ? { ok: true, models: a.models } : { ok: false, why: a.why }; },
      // NOTHING LONG-LIVED belongs to an account handle: stopping it stops nothing that is working.
      stop: async () => {},
      // SIGN OUT, in THIS account's directory — and only where LAIN made it.
      async logout() {
        if (!lainOwned) throw new Error('this is your own Claude profile — sign out inside Claude Code');
        if (!binary) throw new Error('Claude Code is not installed');
        await require('./cliexec').collect(binary.command, ['auth', 'logout'], { timeoutMs: 20000, env, purpose: 'runtime-probe', label: 'claude auth logout' });
      },
      removeOwned() {
        if (!lainOwned) return { removed: false, why: 'LAIN did not create this profile' };
        if (!inside(home, accountsRoot()) || norm(home) === norm(accountsRoot())) return { removed: false, why: 'not one of LAIN\'s account directories' };
        const r = require('../safedelete').removeTree(home, { within: accountsRoot() });
        return r.ok ? { removed: true } : { removed: false, why: r.why };
      },
    };
  },
});

module.exports = { driver, ID, ALIASES, accountsRoot, homeFor, defaultHome, inside, norm, binaryOf, QUOTA_NOTE };
