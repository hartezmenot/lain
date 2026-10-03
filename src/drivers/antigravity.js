'use strict';

/** ANTIGRAVITY ACCOUNTS — one AccountInstance per Google sign-in, each with its OWN profile (Phase 8.4 hotfix). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ID = 'antigravity';

/** Pinned: what Google's release address serves for this platform, and its hash. */
const RELEASES = Object.freeze({
  'win32-x64': { version: '1.1.1', url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip', sha256: '47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8', archiveBytes: 468238392, exe: 'agy_acp_server.exe' },
});
/** Credentials from LAIN's own environment must never reach an account's server. */
const SCRUB = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'GEMINI_CLI_HOME'];

const norm = (p) => { const r = path.resolve(String(p || '')); return process.platform === 'win32' ? r.toLowerCase() : r; };
function inside(child, parent) { const c = norm(child); const p = norm(parent); return c === p || c.startsWith(p + path.sep); }
function configDir() { return require('../config').configDir(); }
function accountsRoot() { return path.join(configDir(), 'accounts', 'antigravity'); }
function homeFor(id) { return path.join(accountsRoot(), String(id)); }
function toolsDir() { return path.join(configDir(), 'tools', 'antigravity-acp'); }
const platformKey = () => `${process.platform}-${process.arch}`;

function settings(cfg) { return ((cfg && cfg.runtimes) || {})[ID] || {}; }
/** The ACP server: a configured path, else the one LAIN installed. Never PATH, never another program's copy. */
function binaryOf(cfg) {
  const s = settings(cfg);
  if (s.acpBinary) return fs.existsSync(s.acpBinary) ? { command: s.acpBinary, args: [...(s.acpArgs || [])] } : null;
  const rel = RELEASES[platformKey()];
  const exe = path.join(toolsDir(), rel ? rel.exe : 'agy_acp_server');
  return fs.existsSync(exe) ? { command: exe, args: [] } : null;
}

/** The environment of ONE account's server: its profile, file credential storage, a browser shim — nothing ambient. */
function envFor(home) {
  const shim = writeBrowserShim(home);
  const env = { GEMINI_HOME: home, AGY_ACP_FORCE_FILE_STORAGE: '1', BROWSER: shim.cmd, PYTHONUNBUFFERED: '1', LAIN_AUTH_URL_FILE: shim.file };
  for (const k of SCRUB) env[k] = undefined;
  return env;
}
/** A tiny program that records the sign-in URL the server asks a browser to open (the page opens it for the person). */
function writeBrowserShim(home) {
  const dir = path.join(home, '.lain');
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, 'browser.js'); const cmd = path.join(dir, process.platform === 'win32' ? 'browser.cmd' : 'browser.sh'); const file = path.join(dir, 'auth-url.txt');
  fs.writeFileSync(js, "require('fs').writeFileSync(process.env.LAIN_AUTH_URL_FILE || process.argv[3], String(process.argv[2] || ''));\n");
  if (process.platform === 'win32') fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %1 "${file}"\r\n`);
  else { fs.writeFileSync(cmd, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$1" "${file}"\n`); try { fs.chmodSync(cmd, 0o755); } catch { /* best effort */ } }
  return { cmd, js, file };
}
/** WHO the profile is: the active address of ITS OWN google_accounts.json, and whether ITS sign-in file exists. */
function identityOf(home) {
  let active = null;
  try { const j = JSON.parse(fs.readFileSync(path.join(home, 'google_accounts.json'), 'utf8')); if (j && typeof j.active === 'string') active = j.active; } catch { /* not signed in */ }
  const creds = fs.existsSync(path.join(home, 'oauth_creds.json'));
  return creds && active ? { email: active, planType: null, method: 'google', providerAccountId: null } : null;
}

const driver = Object.freeze({
  id: ID, displayName: 'Antigravity', provider: 'google', sourceType: 'runtime', supportsMultipleInstances: true,
  capabilities: Object.freeze(['EXTERNAL AGENT', 'RUNTIME ONLY']),
  connection: 'Google sign-in through Antigravity’s own ACP server — one private profile per account',
  install: { docs: 'https://antigravity.google', how: 'MODEL › Connect account › Antigravity can install the official ACP server for you' },
  defaultConfig: () => ({ ownership: 'lain' }),
  validate(config = {}) {
    // AN HTTPS ACCOUNT (antigravityapi.js) is a token under its own credential reference — no directory at all.
    if (config.auth === 'https') return require('../credentials').isRef(config.credentialRef) ? null : 'an Antigravity account needs its own credential reference';
    if (!config.home || typeof config.home !== 'string') return 'an Antigravity account needs its own profile directory';
    if (!inside(config.home, accountsRoot()) || norm(config.home) === norm(accountsRoot())) return 'an Antigravity account lives in its own directory under LAIN\'s accounts folder';
    if (inside(config.home, path.join(os.homedir(), '.gemini'))) return 'a new account is never signed in inside ~/.gemini — that is another program\'s shared credential';
    return null;
  },
  binary: binaryOf,
  locate() { const b = binaryOf({}); return b ? b.command : null; },

  create(instance, { binary } = {}) {
    if ((instance.config || {}).auth === 'https') return httpsHandle(instance);
    const home = (instance.config || {}).home;
    const storeKey = `${ID}:home:${norm(home)}`;
    const s = { runtime_state: binary ? 'INSTALLED' : 'NOT_INSTALLED', authentication_state: 'UNKNOWN', identity: null, models: [], refreshedAt: null, error: null };

    async function refresh() {
      s.identity = identityOf(home);
      s.authentication_state = s.identity ? 'AUTHENTICATED' : 'LOGIN_REQUIRED';
      if (!binary) { s.runtime_state = 'NOT_INSTALLED'; s.refreshedAt = Date.now(); return current(); }
      s.runtime_state = 'INSTALLED';
      if (s.identity) {
        // ASK THE SERVER, in THIS profile, what it offers: a session is opened and closed. No prompt — no quota is spent.
        const acp = require('./acp');
        let c = null;
        try {
          fs.mkdirSync(home, { recursive: true });
          c = acp.open(binary.command, binary.args || [], { env: envFor(home), cwd: home, purpose: 'runtime-probe', label: 'antigravity acp (status)' });
          await acp.initialize(c, { timeoutMs: 30000 });
          const ses = await c.request('session/new', { cwd: home, mcpServers: [] }, { timeoutMs: 45000 });
          const list = ses && ses.models && Array.isArray(ses.models.availableModels) ? ses.models.availableModels : [];
          s.models = list.map((m) => ({ id: String(m.modelId || m.id), label: String(m.name || m.modelId || m.id), efforts: [], defaultEffort: null })).filter((m) => m.id);
          s.error = null;
        } catch (e) {
          s.error = require('../redact').text(String(e.message || e)).slice(0, 160);
          if (e.code === -32000 || /auth/i.test(e.message || '')) { s.authentication_state = 'LOGIN_REQUIRED'; s.identity = null; }
        } finally { if (c) c.close(); }
      } else s.models = [];
      s.refreshedAt = Date.now();
      return current();
    }
    function current() {
      return {
        runtime_state: s.runtime_state, authentication_state: s.authentication_state, identity: s.identity,
        limits: null, limitsError: 'Antigravity does not report quota to other programs', refreshedAt: s.refreshedAt, error: s.error,
        login: null, threads: [], pid: null, version: null, models: s.authentication_state === 'AUTHENTICATED' ? s.models : [],
        signedInProviders: null, expectedResets: [],
        layout: { mode: 'direct', home, shared: null, storeKey, unshared: [], lainOwned: true },
      };
    }
    return {
      driver: ID, layout: { mode: 'direct', home, lainOwned: true }, storeKey, env: () => envFor(home), refresh, current, stop: async () => {},
      // SIGN OUT: remove THIS profile's own sign-in files, nothing else and nowhere else.
      async logout() { for (const f of ['oauth_creds.json', 'google_accounts.json']) { try { fs.unlinkSync(path.join(home, f)); } catch { /* not there */ } } },
      removeOwned() {
        if (!inside(home, accountsRoot()) || norm(home) === norm(accountsRoot())) return { removed: false, why: 'not one of LAIN\'s account directories' };
        try { fs.rmSync(home, { recursive: true, force: true }); return { removed: true }; } catch (e) { return { removed: false, why: e.message }; }
      },
    };
  },
});

// ---- EXECUTION: one prompt through ONE account's server ------------------------------------------------------------
function instanceOf(pc) { const m = /^runtime:antigravity:(.+)$/.exec(String((pc && (pc.instanceId || pc.connectionId)) || '')); return m ? m[1] : (pc && pc.instanceId) || null; }

async function* chat(pc, messages, opts = {}) {
  const app = opts.app || null;
  const id = instanceOf(pc);
  const ai = require('../accountinstances');
  const rec = id ? ai.record(id) : null;
  if (!rec || rec.driver_id !== ID) { const e = new Error(`no Antigravity account "${id}"`); e.status = 404; throw e; }
  const h = ai.handle(app, id);
  if (h && h.https) { yield* httpsChat(app, id, h, pc, messages, opts); return; }
  const r = (app && app._sibling) || app;
  const bin = binaryOf((r && r.cfg) || {});
  if (!bin) { const e = new Error('the Antigravity ACP server is not installed — MODEL › Connect account › Antigravity'); e.status = 503; throw e; }
  const acp = require('./acp');
  const { system, prompt } = require('./runtimechat').flatten(messages);
  const text = system ? `${system}\n\n${prompt}` : prompt;
  const c = acp.open(bin.command, bin.args || [], { env: h.env(), cwd: h.layout.home, purpose: 'runtime:antigravity', label: `antigravity acp (${rec.display_name})` });
  const work = require('../accountwork').begin(ID, id, { kind: 'chat', pid: c.pid });
  const chunks = []; let wake = null;
  c.on('session/update', (p) => {
    const u = p && p.update;
    if (u && u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text' && u.content.text) { chunks.push(String(u.content.text)); if (wake) { const w = wake; wake = null; w(); } }
  });
  const signal = opts.signal || null;
  const stop = () => c.close();
  if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); }
  let ended = false; let failure = null; let stopReason = null; let answered = false;
  try {
    await acp.initialize(c, { timeoutMs: 30000 });
    const ses = await c.request('session/new', { cwd: h.layout.home, mcpServers: [] }, { timeoutMs: 45000 });
    const sid = ses && ses.sessionId;
    if (!sid) throw new Error('the server opened no session');
    if (pc.model) { try { await c.request('session/set_model', { sessionId: sid, modelId: String(pc.model) }, { timeoutMs: 15000 }); } catch { /* the server's own default */ } }
    const turn = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] }, { timeoutMs: 0 }).then((res) => { stopReason = res && res.stopReason; }, (e) => { failure = e; }).finally(() => { ended = true; if (wake) { const w = wake; wake = null; w(); } });
    for (;;) {
      while (chunks.length) { answered = true; yield { type: 'text', chunk: chunks.shift() }; }
      if (ended) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => { wake = res; });
    }
    await turn;
    while (chunks.length) { answered = true; yield { type: 'text', chunk: chunks.shift() }; }
    if (signal && signal.aborted) { const e = new Error('cancelled'); e.status = 499; e.cancelled = true; throw e; }
    if (failure) { const e = new Error(`Antigravity: ${require('../redact').text(String(failure.message || failure)).slice(0, 240)}`); e.status = failure.code === -32000 ? 401 : 502; throw e; }
    // THE ACCOUNT ANSWERED: a real execution — its capabilities may now be advertised.
    if (id && answered) { try { ai.markVerified(app, id, opts.verifying ? 'test' : 'request'); } catch { /* verification is bookkeeping */ } }
    yield { type: 'finish', reason: stopReason === 'max_tokens' ? 'length' : 'stop', raw: stopReason || null };
    yield { type: 'usage', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheReported: false, runtime: { id: ID, model: pc.model || null } };
  } finally {
    require('../accountwork').end(work);
    c.close();
  }
}

/** THE TEST MESSAGE: one short REAL request through THIS account (its own server, its own profile). */
async function verify(app, id) {
  const ai = require('../accountinstances');
  const rec = ai.record(id);
  if (!rec || rec.driver_id !== ID) return { ok: false, why: 'no such Antigravity account' };
  if (require('../accountwork').isBusy(ID, id)) return { ok: false, busy: true, why: `a request is running through ${rec.display_name} — let it finish first` };
  const model = (rec.models || []).map((m) => m.id).filter(Boolean)[0] || null;
  let text = '';
  try {
    for await (const ev of chat({ instanceId: id, model }, [{ role: 'user', content: 'Reply with the single word: ok' }], { app, verifying: true, signal: AbortSignal.timeout(90000) })) if (ev.type === 'text') text += ev.chunk;
  } catch (e) { return { ok: false, why: require('../redact').text(String((e && e.message) || e)).slice(0, 200) }; }
  if (!text.trim()) return { ok: false, why: 'the account did not answer' };
  const v = ai.record(id);
  return { ok: Boolean(v && v.verified_at), why: v && v.verified_at ? '' : 'the answer could not be recorded', text: text.trim().slice(0, 80) };
}

// ---- THE OFFICIAL ACP SERVER: downloaded on the person's request, verified, then unpacked --------------------------
const install = { state: 'idle', bytes: 0, total: 0, why: null, at: 0 };

/** WHAT IS ALREADY INSTALLED, AND WHY IT IS NOT ENOUGH (audit, 2026-09-29). */
function installedCli() {
  if (process.env.LAIN_ISOLATED === '1') return null;
  const p = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
  return process.platform === 'win32' && fs.existsSync(p) ? { path: p, perAccountProfiles: false } : null;
}
const NEED_WHY = 'LAIN keeps each Antigravity account in its own private profile, and only Google\'s Antigravity ACP server can run an account that way.';

function installStatus(app) {
  const r = (app && app._sibling) || app;
  const rel = RELEASES[platformKey()];
  const cli = installedCli();
  return {
    ...install, installed: Boolean(binaryOf((r && r.cfg) || {})), release: rel ? { version: rel.version, bytes: rel.archiveBytes, source: 'dl.google.com' } : null,
    // BEFORE THE DOWNLOAD, the person reads the size AND the reason — never a silent download (installServer needs confirm).
    need: NEED_WHY, installedCli: cli ? { path: cli.path, perAccountProfiles: false, note: 'Google\'s Antigravity CLI is installed, but it runs only the account it is signed in to — it cannot keep accounts apart' } : null,
  };
}

/** INSTALL THE SERVER. Explicit only (the caller passes `confirm: true` after telling the person the size and the source): one https download from the… */
async function installServer(app, { confirm = false } = {}) {
  if (!confirm) return { ok: false, why: 'confirm the download first' };
  if (install.state === 'downloading' || install.state === 'unpacking') return { ok: true, started: false, why: 'already installing' };
  const r = (app && app._sibling) || app;
  const s = settings((r && r.cfg) || {});
  const rel = s.install && s.install.url && s.install.sha256 ? { version: s.install.version || 'configured', url: s.install.url, sha256: String(s.install.sha256).toLowerCase(), archiveBytes: 0, exe: s.install.exe || (RELEASES[platformKey()] || {}).exe || 'agy_acp_server' } : RELEASES[platformKey()];
  if (!rel) return { ok: false, why: `there is no official Antigravity ACP server for ${platformKey()}` };
  Object.assign(install, { state: 'downloading', bytes: 0, total: rel.archiveBytes || 0, why: null, at: Date.now() });
  const dir = toolsDir(); fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, 'download.zip.part');
  (async () => {
    try {
      await download(rel.url, part, (n, total) => { install.bytes = n; if (total) install.total = total; }, rel.sha256);
      install.state = 'unpacking';
      const stage = path.join(dir, `unpack-${Date.now()}`); fs.mkdirSync(stage, { recursive: true });
      const tar = await new Promise((res) => require('child_process').execFile(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xf', part, '-C', stage], { windowsHide: true, timeout: 600000 }, (err, so, se) => res({ err, se })));
      if (tar.err) throw new Error(`could not unpack it: ${String(tar.se || tar.err.message).trim().split('\n')[0]}`);
      const found = findFile(stage, rel.exe);
      if (!found) throw new Error(`the archive did not contain ${rel.exe}`);
      // ONE FLAT FOLDER: the server and whatever sits beside it (its harness).
      const from = path.dirname(found);
      for (const name of fs.readdirSync(from)) { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); fs.renameSync(path.join(from, name), path.join(dir, name)); }
      fs.rmSync(stage, { recursive: true, force: true }); fs.rmSync(part, { force: true });
      try { fs.chmodSync(path.join(dir, rel.exe), 0o755); } catch { /* windows */ }
      install.state = 'installed';
      try { require('./../appcatalog').invalidate(); } catch { /* rebuilt */ }
    } catch (e) {
      try { fs.rmSync(part, { force: true }); } catch { /* gone */ }
      Object.assign(install, { state: 'failed', why: String(e.message || e).slice(0, 240) });
    }
  })();
  return { ok: true, started: true, release: { version: rel.version, bytes: rel.archiveBytes, url: rel.url } };
}
function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; } else if (e.name.toLowerCase() === name.toLowerCase()) return p;
  }
  return null;
}
/** https (or the configured http mirror for tests), redirects followed, hashed as it streams; a wrong hash deletes the file. */
function download(url, file, onProgress, sha256, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) { reject(new Error('too many redirects')); return; }
    const lib = /^https:/i.test(url) ? require('https') : /^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(url) ? require('http') : null;
    if (!lib) { reject(new Error('the download address must be https')); return; }
    lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); download(new URL(res.headers.location, url).toString(), file, onProgress, sha256, hops + 1).then(resolve, reject); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`the download failed (HTTP ${res.statusCode})`)); return; }
      const total = Number(res.headers['content-length']) || 0;
      const hash = crypto.createHash('sha256'); let n = 0;
      const out = fs.createWriteStream(file);
      res.on('data', (d) => { hash.update(d); n += d.length; onProgress(n, total); });
      res.pipe(out);
      out.on('finish', () => {
        const got = hash.digest('hex');
        if (got !== String(sha256).toLowerCase()) { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } reject(new Error('the download does not match the published checksum — it was deleted and nothing was installed')); return; }
        resolve();
      });
      out.on('error', reject); res.on('error', reject);
    }).on('error', reject);
  });
}

// ---- ANTIGRAVITY OVER HTTPS (antigravityapi.js) — no runtime, no download -------------------------------------------
/** ONE ACCOUNT, ONE TOKEN, ITS OWN CREDENTIAL REFERENCE. */
function httpsHandle(instance) {
  const cfgI = instance.config || {};
  const ref = cfgI.credentialRef;
  const api = require('./antigravityapi');
  const cred = () => require('../credentials');
  const s = { runtime_state: 'NOT_REQUIRED', authentication_state: 'UNKNOWN', identity: null, models: [], limits: null, limitsError: null, project: cfgI.project || null, refreshedAt: null, error: null };
  async function token() {
    await cred().ensure(ref);
    let rec = null;
    try { rec = JSON.parse(cred().resolve(ref) || 'null'); } catch { rec = null; }
    const f = await api.fresh(rec);
    if (f.refreshed) cred().store(ref, JSON.stringify(f.rec), { kind: 'oauth' });
    return f.token;
  }
  const windowsOf = (q) => (q && q.ok ? { at: Date.now(), source: 'antigravity', windows: q.windows.map((w) => ({ id: `${w.family.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${w.window}`, label: w.label, usedPercent: w.usedPercent, remainingPercent: w.remainingPercent, reported: 'remaining', resetsAt: w.resetAt, windowMins: { week: 10080, '5h': 300, day: 1440, month: 43200 }[w.window] || null })) } : null);
  function loggedOut(e) { return e && (e.status === 401 || e.code === 'LOGIN_REQUIRED' || e.code === 'invalid_grant'); }
  async function refresh() {
    try {
      const d = await api.describeAccount(await token());
      s.identity = { email: d.identity.email, planType: d.plan || null, method: 'google', providerAccountId: d.identity.id || null };
      s.project = d.project; s.authentication_state = 'AUTHENTICATED'; s.error = null;
      s.models = d.models.map((m) => ({ id: m.id, label: m.label, efforts: [], defaultEffort: null }));
      s.limits = windowsOf(d.quota); s.limitsError = d.quota.ok ? null : (d.quota.why || 'quota not reported');
    } catch (e) {
      s.error = require('../redact').text(String(e.message || e)).slice(0, 160);
      if (loggedOut(e)) { s.authentication_state = 'LOGIN_REQUIRED'; s.identity = null; }
    }
    s.refreshedAt = Date.now();
    return current();
  }
  function current() {
    return {
      runtime_state: s.runtime_state, authentication_state: s.authentication_state, identity: s.identity,
      limits: s.limits, limitsError: s.limitsError, refreshedAt: s.refreshedAt, error: s.error,
      login: null, threads: [], pid: null, version: null, models: s.authentication_state === 'AUTHENTICATED' ? s.models : [],
      signedInProviders: null, expectedResets: [],
      layout: { mode: 'https', home: null, shared: null, storeKey: `${ID}:https:${instance.id}`, unshared: [], lainOwned: true },
    };
  }
  return {
    driver: ID, https: true, layout: { mode: 'https', home: null, lainOwned: true }, storeKey: `${ID}:https:${instance.id}`, env: () => ({}),
    refresh, current, token, project: () => s.project, stop: async () => {},
    // QUOTA ONLY — the provider's own windows (retrieveUserQuotaSummary), no model request.
    async refreshQuota() {
      try {
        if (!s.project) await refresh();
        const q = await api.quota(await token(), s.project);
        s.limits = windowsOf(q) || s.limits; s.limitsError = q.ok ? null : q.why;
        if (q.ok) { try { require('../fabric/store').recordQuota(instance.id, { windows: s.limits.windows, source: 'antigravity' }); } catch { /* shown next read */ } }
        return { ok: q.ok, windows: s.limits ? s.limits.windows : null, why: q.ok ? null : q.why };
      } catch (e) { return { ok: false, why: require('../redact').text(String(e.message || e)).slice(0, 160) }; }
    },
    // SIGN OUT: forget THIS account's token (and ask Google to revoke it); nothing else, nowhere else.
    async logout() {
      let rec = null;
      try { await cred().ensure(ref); rec = JSON.parse(cred().resolve(ref) || 'null'); } catch { rec = null; }
      if (rec && rec.refresh_token && !process.env.LAIN_ANTIGRAVITY_BASE) { try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(rec.refresh_token)}`, { method: 'POST', signal: AbortSignal.timeout(8000) }); } catch { /* the local copy goes regardless */ } }
      cred().remove(ref);
    },
    removeOwned() { cred().remove(ref); return { removed: true }; },
  };
}

async function* httpsChat(app, id, h, pc, messages, opts) {
  const ai = require('../accountinstances');
  const work = require('../accountwork').begin(ID, id, { kind: 'chat' });
  let answered = false;
  try {
    const token = await h.token();
    let project = h.project();
    if (!project) { await h.refresh(); project = h.project(); }
    if (!project) { const e = new Error('this Antigravity account has no Cloud Code project yet — finish onboarding in the official Antigravity app, then Refresh'); e.status = 403; throw e; }
    for await (const ev of require('./antigravityapi').chat({ token, project, model: pc.model, effort: pc.reasoningEffort || null }, messages, { tools: opts.tools || [], signal: opts.signal || null })) {
      if (ev.type === 'text' || ev.type === 'tool_calls') answered = true;
      yield ev;
    }
    if (id && answered) { try { ai.markVerified(app, id, opts.verifying ? 'test' : 'request'); } catch { /* bookkeeping */ } }
  } finally { require('../accountwork').end(work); }
}

module.exports = { driver, ID, chat, verify, httpsHandle, instanceOf, accountsRoot, homeFor, toolsDir, binaryOf, envFor, identityOf, inside, norm, installServer, installStatus, RELEASES, SCRUB, download };
