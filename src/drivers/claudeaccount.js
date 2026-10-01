'use strict';

/**
 * CLAUDE ACCOUNTS — one AccountInstance per Claude sign-in, each with its OWN
 * configuration directory (Phase 8.4 hotfix).
 *
 * ------------------------------------------------------------------------
 * THE INVARIANT this file exists to keep:
 *
 *   Adding or authenticating another account NEVER mutates the configuration or
 *   authentication of an account that is already connected, and NEVER touches a
 *   process that is doing work.
 *
 * Claude Code keeps its sign-in in ITS CONFIG DIRECTORY (`CLAUDE_CONFIG_DIR`,
 * else `~/.claude`). So an account is exactly a directory:
 *
 *   external_native   the person's own normal profile (the default directory).
 *                     LAIN may RUN Claude through it; it is never moved, copied,
 *                     signed out, or written to by "Add account", and "Detach"
 *                     removes LAIN's reference only.
 *   lain              a directory LAIN allocated under <config>/accounts/claude/<id>.
 *                     The SAME directory is used for `claude auth login`, for
 *                     `claude auth status`, and for every run. LAIN may sign it
 *                     out and delete it — it made it.
 *
 * A LAIN-owned account can never be pointed at the default profile (validate),
 * and no directory is shared: two accounts on one directory would be one sign-in
 * with two names. HOME is never used as a substitute, and no existing profile is
 * copied into a new one — a new account starts from an empty directory.
 *
 * Nothing here holds a process. Login is an AuthSession (authsession.js), run
 * separately from every execution; status is a short read-only command.
 */

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

/** When Anthropic's usage read gives nothing, the windows arrive with the account's first response (see refreshQuota). */
const QUOTA_NOTE = 'Quota appears after the first Claude response through this account';
/** The person's own profile: LAIN never reads its sign-in, so its windows come with the first response through LAIN. */
const OWN_PROFILE_NOTE = 'Quota appears after the first Claude response through Noema — this is your own Claude profile, whose sign-in Noema does not read';

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
      if (!inside(config.home, accountsRoot()) || norm(config.home) === norm(accountsRoot())) return 'a LAIN-owned Claude account lives in its own directory under Noema\'s accounts folder';
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
    function limits() { try { const t = require('../runtimeadapters').cachedTelemetry(telemetryId); return t && t.limits ? t.limits : null; } catch { return null; } }
    /**
     * THIS ACCOUNT'S QUOTA, NOW — without a model request (2026-09-29 audit).
     *
     * Claude Code 2.1.x has no non-interactive quota command (`claude auth status` is identity and plan; `/usage` needs
     * an interactive session). Anthropic's own management endpoint does answer it (fabric/quotaread.js — the contract
     * the person's router verified live), with the account's OAuth token:
     *   · a LAIN-OWNED profile: LAIN reads that token from the profile it made, and asks the endpoint — so the windows
     *     are there before the first response, and fresh on every Refresh;
     *   · the person's OWN profile: its store is Claude Code's, never read by LAIN — its windows come from the receipt
     *     (`rate_limit_event`) of the first response LAIN gets through it.
     * No process is started either way, so a running Claude is never touched, and nothing is spent.
     */
    async function refreshQuota({ fetchImpl } = {}) {
      if (lainOwned) {
        const r = await require('../fabric/quotaread').claudeUsage(home, { fetchImpl, version: s.version ? String(s.version).split(' ')[0] : null });
        if (r.ok && r.limits.windows.length) {
          try { const ra = require('../runtimeadapters'); ra.saveTelemetry(telemetryId, { ...(ra.cachedTelemetry(telemetryId) || {}), limits: r.limits }); } catch { /* the answer below still stands */ }
          return { ok: true, limits: require('../accountinstances').stampWindows(r.limits), observedAt: r.limits.at, basis: r.limits.basis, live: true };
        }
        const l0 = limits();
        if (l0) return { ok: true, limits: require('../accountinstances').stampWindows(l0), observedAt: l0.at || null, basis: l0.basis || null, note: r.ok ? null : `live read unavailable: ${r.why}` };
        return { ok: true, limits: null, note: r.ok ? QUOTA_NOTE : `${QUOTA_NOTE} (${r.why})` };
      }
      const l = limits();
      if (!l) return { ok: true, limits: null, note: OWN_PROFILE_NOTE };
      return { ok: true, limits: require('../accountinstances').stampWindows(l), observedAt: l.at || null, basis: l.basis || null };
    }
    function current() {
      const models = s.authentication_state === 'AUTHENTICATED'
        ? ALIASES.map((a) => ({ id: `${ID}/${a}`, label: `Claude ${a[0].toUpperCase()}${a.slice(1)} · Claude Code`, efforts: [], defaultEffort: null }))
        : [];
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
      env: () => env, refresh, current, refreshQuota,
      // NOTHING LONG-LIVED belongs to an account handle: stopping it stops nothing that is working.
      stop: async () => {},
      // SIGN OUT, in THIS account's directory — and only where LAIN made it.
      async logout() {
        if (!lainOwned) throw new Error('this is your own Claude profile — sign out inside Claude Code');
        if (!binary) throw new Error('Claude Code is not installed');
        await require('./cliexec').collect(binary.command, ['auth', 'logout'], { timeoutMs: 20000, env, purpose: 'runtime-probe', label: 'claude auth logout' });
      },
      removeOwned() {
        if (!lainOwned) return { removed: false, why: 'Noema did not create this profile' };
        if (!inside(home, accountsRoot()) || norm(home) === norm(accountsRoot())) return { removed: false, why: 'not one of Noema\'s account directories' };
        try { fs.rmSync(home, { recursive: true, force: true }); return { removed: true }; } catch (e) { return { removed: false, why: e.message }; }
      },
    };
  },
});

module.exports = { driver, ID, ALIASES, accountsRoot, homeFor, defaultHome, inside, norm, binaryOf, QUOTA_NOTE };
