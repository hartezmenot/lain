'use strict';

/**
 * RUNTIME DRIVERS WITHOUT A SESSION PROTOCOL (yet) — Claude Code, OpenCode,
 * ZCode, Cursor Agent. Each is what its runtime can honestly say:
 *
 *   installed?   its binary on PATH, and `--version`
 *   where        its config home (a path; its files are NOT read)
 *   signed in?   only through the runtime's own status command where one is
 *                documented (`opencode auth list` names providers, never keys).
 *                Otherwise UNKNOWN — the runtime keeps its sign-in.
 *   models       only where the runtime lists them (`opencode models`)
 *   limits       only where the runtime reports them — never estimated.
 *
 * NOTHING HERE extracts a credential, calls a runtime's private backend, or
 * uses a runtime-bound free model outside that runtime.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function which(names) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) for (const ext of exts) {
      const p = path.join(dir, n + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

/** Run a runtime's own documented command, bounded, without a shell. */
function run(bin, args, { timeoutMs = 8000, env = {} } = {}) {
  return new Promise((resolve) => {
    if (!bin) { resolve({ ok: false, out: '', why: 'not installed' }); return; }
    const viaCmd = /\.cmd$/i.test(bin);
    let child;
    try {
      child = viaCmd
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', bin, ...args], { windowsHide: true, env: { ...process.env, ...env } })
        : spawn(bin, args, { windowsHide: true, env: { ...process.env, ...env } });
    } catch (e) { resolve({ ok: false, out: '', why: e.message }); return; }
    let out = ''; let err = '';
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ ok: false, out, why: 'timed out' }); }, timeoutMs);
    child.stdout.on('data', (d) => { out = (out + d).slice(-200000); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, out, why: e.message }); });
    child.on('exit', (code) => { clearTimeout(t); resolve({ ok: code === 0, out: require('../redact').text(out), why: code === 0 ? '' : require('../redact').text(err).trim().split('\n')[0] || `exit ${code}` }); });
  });
}

const home = (...p) => path.join(os.homedir(), ...p);

function nextLocalMidnight(now = Date.now()) { const d = new Date(now); d.setHours(24, 0, 0, 0); return d.getTime(); }

/** One runtime driver value. `spec` is data; `create` makes a per-instance handle. */
function runtimeDriver(spec) {
  return Object.freeze({
    id: spec.id, displayName: spec.displayName, provider: spec.provider, sourceType: 'runtime',
    supportsMultipleInstances: spec.multi !== false, capabilities: Object.freeze(spec.capabilities), connection: spec.connection,
    install: spec.install, homeEnv: spec.homeEnv || null, defaultHome: spec.defaultHome || null,
    defaultConfig: () => ({}),
    validate(config = {}) { if (config.home && typeof config.home !== 'string') return 'home is a path'; return null; },
    binary() { const p = which(spec.bin); return p ? { command: p, args: [] } : null; },
    locate() { return which(spec.bin); },
    create(instance, { binary } = {}) {
      const cfgHome = (instance.config && instance.config.home) || (spec.defaultHome ? spec.defaultHome() : null);
      const env = spec.homeEnv && instance.config && instance.config.home ? { [spec.homeEnv]: instance.config.home } : {};
      const s = { runtime_state: binary ? 'INSTALLED' : 'NOT_INSTALLED', authentication_state: 'UNKNOWN', version: null, models: [], signedInProviders: null, limits: null, limitsError: null, refreshedAt: null, error: null };
      async function refresh() {
        if (!binary) { s.runtime_state = 'NOT_INSTALLED'; return current(); }
        const v = await run(binary.command, spec.versionArgs || ['--version'], { env });
        s.version = v.ok ? (v.out.trim().split('\n')[0] || '').slice(0, 80) : null;
        s.runtime_state = v.ok ? 'INSTALLED' : 'ERROR';
        s.error = v.ok ? null : v.why;
        if (spec.authStatus) {
          const a = await spec.authStatus(binary, env);
          s.authentication_state = a.state; s.signedInProviders = a.providers || null;
        }
        if (spec.listModels) { const m = await spec.listModels(binary, env); s.models = m; }
        s.limits = null;
        s.limitsError = spec.limitsNote || 'this runtime does not report usage limits to other programs';
        s.refreshedAt = Date.now();
        return current();
      }
      function current() {
        return {
          runtime_state: s.runtime_state, authentication_state: s.authentication_state, identity: null,
          limits: s.limits, limitsError: s.limitsError, refreshedAt: s.refreshedAt, error: s.error, login: null, threads: [], pid: null,
          version: s.version, models: s.models, signedInProviders: s.signedInProviders,
          expectedResets: spec.expectedReset ? [spec.expectedReset()] : [],
          layout: { mode: 'direct', home: cfgHome, shared: null, storeKey: `${spec.id}:home:${String(cfgHome || '').toLowerCase()}`, unshared: [] },
        };
      }
      return {
        driver: spec.id, layout: { mode: 'direct', home: cfgHome, lainOwned: false }, storeKey: `${spec.id}:home:${String(cfgHome || '').toLowerCase()}`,
        env: () => env, refresh, current, stop: async () => {}, logout: async () => { throw new Error(`sign out inside ${spec.displayName}`); },
        removeOwned: () => ({ removed: false, why: 'Noema did not create this home' }),
      };
    },
  });
}

const DRIVERS = [
  runtimeDriver({
    id: 'claude-code', displayName: 'Claude Code', provider: 'anthropic', bin: ['claude'],
    capabilities: ['EXTERNAL AGENT', 'RUNTIME ONLY'], connection: 'Claude subscription or key, inside Claude Code',
    homeEnv: 'CLAUDE_CONFIG_DIR', defaultHome: () => process.env.CLAUDE_CONFIG_DIR || home('.claude'),
    install: { docs: 'https://docs.anthropic.com/en/docs/claude-code/setup', how: 'npm install -g @anthropic-ai/claude-code' },
  }),
  runtimeDriver({
    id: 'opencode', displayName: 'OpenCode', provider: 'opencode', bin: ['opencode'],
    capabilities: ['EXTERNAL AGENT', 'RUNTIME ONLY'], connection: 'OpenCode runtime (its free models are served only inside OpenCode)',
    defaultHome: () => home('.local', 'share', 'opencode'),
    install: { docs: 'https://opencode.ai/docs', how: 'npm install -g opencode-ai' },
    // DOCUMENTED COMMANDS ONLY: provider names from `auth list`, model ids from `models`.
    async authStatus(bin, env) {
      const r = await run(bin.command, ['auth', 'list'], { env });
      if (!r.ok) return { state: 'UNKNOWN' };
      const names = [...new Set((r.out.match(/^[\s●○•*-]*([A-Za-z][\w .-]{1,40}?)\s+(?:oauth|api|wellknown|env)\b/gmi) || []).map((l) => l.replace(/^[\s●○•*-]*/, '').split(/\s+(?:oauth|api|wellknown|env)\b/i)[0].trim()))];
      return { state: names.length ? 'AUTHENTICATED' : 'LOGIN_REQUIRED', providers: names.slice(0, 40) };
    },
    async listModels(bin, env) {
      const r = await run(bin.command, ['models'], { env, timeoutMs: 15000 });
      return r.ok ? r.out.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:-]+$/.test(l)).slice(0, 400) : [];
    },
  }),
  runtimeDriver({
    id: 'zcode', displayName: 'ZCode', provider: 'zai', bin: ['zcode'],
    capabilities: ['EXTERNAL AGENT', 'RUNTIME ONLY'], connection: 'ZCode runtime (the Z.AI Coding Plan API is the native route: MODEL › Add account › API key › Z.AI)',
    install: { docs: 'https://docs.z.ai', how: 'see Z.AI’s ZCode instructions' },
  }),
  runtimeDriver({
    id: 'cursor-agent', displayName: 'Cursor Agent', provider: 'cursor', bin: ['cursor-agent'],
    capabilities: ['EXTERNAL AGENT', 'RUNTIME ONLY'], connection: 'Cursor subscription, inside Cursor Agent',
    defaultHome: () => home('.cursor'),
    install: { docs: 'https://docs.cursor.com', how: 'see Cursor’s CLI instructions' },
  }),
];

module.exports = { DRIVERS, runtimeDriver, run, which, nextLocalMidnight };
