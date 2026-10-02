'use strict';

/**
 * AUTH SESSIONS (Phase 8.4 hotfix) — connecting ONE new account, and nothing else.
 *
 * ------------------------------------------------------------------------
 * THE BUG THIS REPLACES. "Add account" for Claude ran `claude auth login` with
 * no configuration directory, so it signed in against the DEFAULT profile — the
 * account that was already connected, and the one a Claude process was working
 * through. The first account was replaced and its running task was cut off.
 *
 * ------------------------------------------------------------------------
 * THE MODEL. An AuthSession is scoped to ONE AccountInstance that it creates:
 *
 *   AuthSession { id, family, target_account_id, profile, pid, state, url }
 *
 *   1. allocate a NEW, EMPTY, LAIN-owned profile directory for the new instance
 *   2. run the provider's own login in THAT directory, as its own child process
 *   3. wait for THAT process
 *   4. read the identity from the same directory (the provider's own status) —
 *      a browser callback is never taken as success
 *   5. only then is the account CONNECTED; the account becomes capacity for
 *      FUTURE requests
 *
 * WHAT IT NEVER DOES: touch an existing account's directory or configuration;
 * run a global logout; restart, stop or refresh any provider process; hold up a
 * running request. The login process is separate from every execution (its own
 * child, its own registry record); cancelling a session stops that process and
 * removes only the half-made profile it created.
 *
 * States: STARTING → AWAITING_BROWSER → VERIFYING → CONNECTED | FAILED | CANCELLED.
 * A session that ends any way but CONNECTED leaves nothing behind: its instance
 * and directory are removed, and every other account is exactly as it was.
 */

const crypto = require('crypto');
const fs = require('fs');

const STATE = Object.freeze({ STARTING: 'STARTING', AWAITING_BROWSER: 'AWAITING_BROWSER', VERIFYING: 'VERIFYING', CONNECTED: 'CONNECTED', FAILED: 'FAILED', CANCELLED: 'CANCELLED' });
const ACTIVE = new Set([STATE.STARTING, STATE.AWAITING_BROWSER, STATE.VERIFYING]);
const TIMEOUT_MS = 3 * 60 * 1000;   // the sign-in windows below
const URL_WAIT_MS = 3500;

const sessions = new Map();

function root(app) { return (app && app._sibling) || app; }
const ai = () => require('./accountinstances');

function view(s) {
  return s ? { id: s.id, family: s.family, state: s.state, active: ACTIVE.has(s.state), url: s.url || null, userCode: s.userCode || null, why: s.why || null, targetAccountId: s.target || null, startedAt: s.startedAt, name: s.name || null, needs: s.needs || null, note: s.note || null, external: Boolean(s.external) } : null;
}
function get(id) { return sessions.get(String(id || '')) || null; }
function activeFor(family) { for (const s of sessions.values()) if (s.family === family && ACTIVE.has(s.state)) return s; return null; }
function list() { return [...sessions.values()].map(view); }

function fail(s, why) { s.state = STATE.FAILED; s.why = String(why || 'the sign-in did not complete'); s.endedAt = Date.now(); }

/** REMOVE WHAT THIS SESSION MADE — its instance and profile — and only that. */
async function cleanup(app, s) {
  if (!s.target || s.external || s.keep || s.state === STATE.CONNECTED) return;   // (a reused account is signed in AGAIN, never removed by a failed attempt)
  try { await ai().disconnect(app, s.target, { logout: false, removeProfile: true }); } catch { /* it leaves the registry with the next read */ }
  try { require('./appcatalog').invalidate(); const r = root(app); if (r) { r._acctMemo = null; r._catMemo = null; } } catch { /* rebuilt */ }
}

/** The one identity check every provider shares: is this account already connected? Never merged automatically. */
function duplicateOf(app, s, identity) {
  const email = identity && identity.email ? String(identity.email).toLowerCase() : null;
  if (!email) return null;
  try {
    for (const a of require('./accountcatalog').list(app).accounts) {
      if (a.id === s.target || !a.identity || !a.identity.email) continue;
      if (String(a.identity.email).toLowerCase() === email && (require('./fabric/index').familyIdOf(a) === s.family)) return a;
    }
  } catch { /* nothing to compare with */ }
  return null;
}

/**
 * THE PROVIDER'S OWN ANSWER, read from the new profile: signed in, and as whom. Then — and only then — CONNECTED.
 */
async function verify(app, s) {
  s.state = STATE.VERIFYING;
  const r = await ai().refresh(app, s.target);
  const inst = r && r.instance;
  const ok = inst && String(inst.authentication_state || '').toUpperCase() === 'AUTHENTICATED' && inst.identity;
  if (!ok) { fail(s, (r && r.why) || 'the provider does not report this profile as signed in'); await cleanup(app, s); return; }
  const dup = duplicateOf(app, s, inst.identity);
  if (dup) { fail(s, `That account is already connected as ${dup.name}. Sign in with a different one.`); s.needs = 'different-account'; await cleanup(app, s); return; }
  // THE NAME THE PERSON GAVE IT is how it is shown (their word, not the address); the account's identity is unchanged.
  try { if (s.name && !s.keep) require('./fabric/store').setAlias(s.target, s.name); } catch { /* shown by its identity */ }
  s.state = STATE.CONNECTED; s.endedAt = Date.now(); s.why = null;
}

/**
 * "SIGN IN AGAIN" for an account that lost its sign-in: the SAME account's OWN LAIN-made directory, and only that one,
 * only when no request is running through it. Returns the instance record, or a refusal.
 */
function reuseOf(app, s, driverId, reuse) {
  const rec = ai().record(String(reuse));
  if (!rec || rec.driver_id !== driverId) return { why: 'no such account' };
  if ((rec.config || {}).ownership === 'external_native') return { why: 'this is your own profile — sign in inside the provider\'s own app' };
  if (require('./accountwork').busy(driverId, rec.id).length) return { why: `a request is running through ${rec.display_name} — let it finish first` };
  s.target = rec.id; s.profile = rec.config.home; s.keep = true;
  return { rec };
}

// ---- CLAUDE: `claude auth login`, in the NEW profile's own CLAUDE_CONFIG_DIR ---------------------------------------
async function startClaude(app, s, opts = {}) {
  const ca = require('./drivers/claudeaccount');
  const bin = ca.binaryOf(root(app).cfg);
  if (!bin) { fail(s, 'Claude Code is not installed on this PC — install it, then connect again.'); s.needs = 'install'; return; }
  let home;
  if (opts.reuse) {
    const u = reuseOf(app, s, 'claude-code', opts.reuse);
    if (u.why) { fail(s, u.why); return; }
    home = s.profile;
  } else {
    const id = `claude-code-${crypto.randomBytes(3).toString('hex')}`;
    home = ca.homeFor(id);
    // A FRESH, EMPTY directory — nothing copied from any existing profile.
    if (fs.existsSync(home)) { fail(s, 'that profile directory already exists'); return; }
    fs.mkdirSync(home, { recursive: true });
    const added = ai().add(app, { driver_id: 'claude-code', display_name: s.name || '', id, config: { ownership: 'lain', home } });
    if (!added.ok) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* none */ } fail(s, added.why); return; }
    s.target = id; s.profile = home;
  }
  const cliexec = require('./drivers/cliexec');
  let retried = false;
  const launch = (extra) => {
    const run = cliexec.start(bin.command, [...(bin.args || []), 'auth', 'login', ...extra], { cwd: home, env: { CLAUDE_CONFIG_DIR: home }, purpose: 'signin', label: 'claude auth login' });
    s.run = run; s.pid = run.pid;
    return run;
  };
  let run = launch(['--claudeai']);
  const watch = (r) => {
    (async () => { try { for await (const l of r.lines()) { const m = /https?:\/\/\S+/.exec(l); if (m && !s.url) { s.url = m[0]; if (s.state === STATE.STARTING) s.state = STATE.AWAITING_BROWSER; } } } catch { /* ended */ } })();
    r.done.then(async (d) => {
      if (s.state === STATE.CANCELLED || s.run !== r) return;
      // AN OLDER `claude` WITHOUT THE ACCOUNT-TYPE FLAG: the same login, without it — in the same directory.
      if (d.code !== 0 && !retried && !s.url && /unknown (option|flag)|unexpected argument|unrecognized/i.test(d.stderr || '')) { retried = true; run = launch([]); watch(run); return; }
      clearTimeout(s.timer);
      if (d.code !== 0) { fail(s, (d.stderr || '').trim().split('\n').pop() || `the sign-in ended with code ${d.code}`); await cleanup(app, s); return; }
      await verify(app, s);
    });
  };
  watch(run);
  setTimeout(() => { if (s.state === STATE.STARTING) s.state = STATE.AWAITING_BROWSER; }, URL_WAIT_MS).unref();
}

// ---- CODEX: a NEW account instance in its own home (an overlay — its own auth.json), Codex's own login ----------------
// The instance is created for THIS sign-in; another account's home is never the login's target. Codex tells the instance's
// own app-server when the browser step is done; then the account is asked who it is.
async function startCodex(app, s, opts = {}) {
  const added = ai().add(app, { driver_id: 'codex', display_name: s.name || '', config: {} });
  if (!added.ok) { fail(s, added.why); return; }
  s.target = added.instance.id;
  const r = await ai().login(app, s.target, { device: Boolean(opts.device) });
  if (!r.ok || !r.login) { fail(s, (r && r.why) || 'the sign-in did not start'); await cleanup(app, s); return; }
  s.url = r.login.url || null; s.userCode = r.login.userCode || null; s.state = STATE.AWAITING_BROWSER;
  s.poll = setInterval(async () => {
    if (s.state !== STATE.AWAITING_BROWSER) { clearInterval(s.poll); return; }
    const h = ai().handle(app, s.target);
    const cur = h && h.current && h.current();
    if (!cur || !cur.login || !cur.login.done) return;
    clearInterval(s.poll);
    if (!cur.login.ok) { fail(s, cur.login.error || 'the sign-in was not completed'); await cleanup(app, s); return; }
    await verify(app, s);
  }, 400);
  if (s.poll.unref) s.poll.unref();
}

// ---- ANTIGRAVITY: Google sign-in through the ACP server, in a NEW private profile ------------------------------------------
// GEMINI_HOME is the new profile; credentials are a file in it; the browser URL is captured for the person. The server
// answers `authenticate` only when THAT sign-in completes; then the profile itself says who signed in.
const AGY_AUTH_PREFIX = /Open the following link to authenticate[^:]*:\s*(https?:\/\/\S+)/i;
/**
 * ANTIGRAVITY OVER HTTPS (2026-10-01) — the default for every NEW account. Google's installed-app OAuth with a loopback
 * redirect (drivers/antigravityapi.js): no runtime, no 468 MB download. The token is stored under the NEW account's own
 * credential reference; the account is CONNECTED only after Google itself answers who it is (verify → refresh →
 * userinfo / loadCodeAssist). Re-signing in an older ACP-profile account still goes through its own server.
 */
async function startAntigravityHttps(app, s, opts = {}) {
  const api = require('./drivers/antigravityapi');
  const credentials = require('./credentials');
  let ref;
  if (opts.reuse) {
    const u = reuseOf(app, s, 'antigravity', opts.reuse);
    if (u.why) { fail(s, u.why); return; }
    ref = (u.rec.config || {}).credentialRef;
  } else {
    const id = `antigravity-${crypto.randomBytes(3).toString('hex')}`;
    ref = credentials.ref(id, 'oauth');
    const added = ai().add(app, { driver_id: 'antigravity', display_name: s.name || '', id, config: { ownership: 'lain', auth: 'https', credentialRef: ref } });
    if (!added.ok) { fail(s, added.why); return; }
    s.target = id;
  }
  let login;
  try { login = await api.beginLogin({ timeoutMs: TIMEOUT_MS }); } catch (e) { fail(s, `could not open the sign-in: ${e.message}`); await cleanup(app, s); return; }
  s.url = login.url; s.state = STATE.AWAITING_BROWSER; s.needs = 'browser';
  s.run = { cancel: () => login.cancel() };
  login.done.then(async (tokens) => {
    if (s.state === STATE.CANCELLED) return;
    const put = credentials.store(ref, JSON.stringify(tokens), { kind: 'oauth' });
    if (!put.ok) { fail(s, put.why); await cleanup(app, s); return; }
    s.needs = null;
    await verify(app, s);
  }, async (e) => {
    if (s.state === STATE.CANCELLED) return;
    fail(s, require('./redact').text(String(e.message || e)).slice(0, 240)); await cleanup(app, s);
  });
}

async function startAntigravity(app, s, opts = {}) {
  // THE ACP RUNTIME ONLY WHEN THE PERSON CHOSE IT (runtimes.antigravity.acpBinary) or the account already lives in an ACP profile.
  const prior = opts.reuse ? ai().record(String(opts.reuse)) : null;
  const chosenAcp = Boolean(((root(app).cfg.runtimes || {}).antigravity || {}).acpBinary);
  if (prior ? (prior.config || {}).auth === 'https' : !chosenAcp) return startAntigravityHttps(app, s, opts);
  const ag = require('./drivers/antigravity');
  const bin = ag.binaryOf(root(app).cfg);
  if (!bin) { fail(s, 'Antigravity\'s official ACP server is not installed. Install it (a large download from Google, checked against its published checksum), then connect again.'); s.needs = 'install-acp'; return; }
  let home;
  if (opts.reuse) {
    const u = reuseOf(app, s, 'antigravity', opts.reuse);
    if (u.why) { fail(s, u.why); return; }
    home = s.profile;
  } else {
    const id = `antigravity-${crypto.randomBytes(3).toString('hex')}`;
    home = ag.homeFor(id);
    if (fs.existsSync(home)) { fail(s, 'that profile directory already exists'); return; }
    fs.mkdirSync(home, { recursive: true });
    const added = ai().add(app, { driver_id: 'antigravity', display_name: s.name || '', id, config: { ownership: 'lain', home } });
    if (!added.ok) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* none */ } fail(s, added.why); return; }
    s.target = id; s.profile = home;
  }
  const acp = require('./drivers/acp');
  const seeUrl = (u) => { if (u && !s.url) { s.url = u; if (s.state === STATE.STARTING) s.state = STATE.AWAITING_BROWSER; } };
  const c = acp.open(bin.command, bin.args || [], { env: ag.envFor(home), cwd: home, purpose: 'signin', label: 'antigravity acp (sign-in)',
    onText: (line) => { const m = AGY_AUTH_PREFIX.exec(line) || /(https?:\/\/\S+)/.exec(line); if (m) seeUrl(m[1]); },
    onStderr: (t) => { const m = AGY_AUTH_PREFIX.exec(t); if (m) seeUrl(m[1]); } });
  s.run = { cancel: () => c.close() }; s.pid = c.pid;
  // THE BROWSER SHIM records the address the server asks a browser to open.
  const urlFile = require('path').join(home, '.lain', 'auth-url.txt');
  s.poll = setInterval(() => { try { const u = fs.readFileSync(urlFile, 'utf8').trim(); if (u) seeUrl(u); } catch { /* not asked yet */ } if (!ACTIVE.has(s.state)) clearInterval(s.poll); }, 300);
  if (s.poll.unref) s.poll.unref();
  (async () => {
    try {
      const init = await acp.initialize(c, { timeoutMs: 45000 });
      const methods = (init && init.authMethods) || [];
      const m = methods.find((x) => x.id === 'oauth-personal') || methods.find((x) => /oauth/i.test(x.id || '')) || methods[0];
      if (!m) throw new Error('the server offers no sign-in method');
      // Resolves when the person has finished in the browser — a server that already holds a sign-in in this (empty) profile would be a fault.
      await c.request('authenticate', { methodId: m.id }, { timeoutMs: TIMEOUT_MS });
      clearInterval(s.poll);
      if (s.state === STATE.CANCELLED) return;
      c.close();
      await verify(app, s);
    } catch (e) {
      clearInterval(s.poll);
      if (s.state === STATE.CANCELLED) return;
      c.close();
      fail(s, require('./redact').text(String(e.message || e)).slice(0, 240)); await cleanup(app, s);
    }
  })();
  setTimeout(() => { if (s.state === STATE.STARTING) s.state = STATE.AWAITING_BROWSER; }, URL_WAIT_MS).unref();
}

// ---- Z.AI IS API-ONLY IN LAIN (2026-09-29) -----------------------------------------------------------------------------
// LAIN integrates Z.ai through its API (MODEL › API › Z.ai API). It does not launch ZCode to sign in, does not act as
// ZCode's desktop host, and creates no Z.ai account instance. (ZCode itself may offer account-based plans; LAIN does not use them.)
const API_ONLY = Object.freeze({ zai: 'LAIN integrates Z.ai through its API. Add your Z.ai API key under MODEL › API (Z.ai API), or run /api add zai.' });

const STRATEGIES = { claude: startClaude, codex: startCodex, antigravity: startAntigravity };
/** Register a provider's login (claude, codex, antigravity …). `start(app, session)` sets s.target/s.profile and drives the state. */
function register(family, start) { STRATEGIES[family] = start; }

async function start(app, family, { name = '', device = false, reuse = null } = {}) {
  if (API_ONLY[String(family || '')]) return { ok: false, apiOnly: true, why: API_ONLY[String(family || '')] };
  const strategy = STRATEGIES[String(family || '')];
  if (!strategy) return { ok: false, why: 'LAIN cannot start a sign-in for that provider yet.' };
  // ONE AT A TIME PER PROVIDER: a second click returns the sign-in already open, never a second login.
  const open = activeFor(family);
  if (open) return { ok: true, session: view(open), resumed: true };
  const s = { id: `auth-${crypto.randomBytes(4).toString('hex')}`, family, state: STATE.STARTING, startedAt: Date.now(), name: String(name || '').trim().slice(0, 60), url: null, why: null, target: null, profile: null, pid: null, run: null, timer: null };
  sessions.set(s.id, s);
  try { await strategy(app, s, { device, reuse }); } catch (e) { fail(s, e.message); await cleanup(app, s); }
  if (ACTIVE.has(s.state)) s.timer = setTimeout(() => { cancel(app, s.id, { why: 'The sign-in timed out.' }); }, TIMEOUT_MS).unref();
  if (s.state === STATE.FAILED) return { ok: false, why: s.why, needs: s.needs || null, session: view(s) };
  return { ok: true, session: view(s) };
}

/** STOP THIS SIGN-IN ONLY: its process, and the half-made profile. Every other account and every run is untouched. */
async function cancel(app, id, { why = null } = {}) {
  const s = get(id);
  if (!s) return { ok: false, why: 'no such sign-in' };
  if (!ACTIVE.has(s.state)) return { ok: true, session: view(s) };
  s.state = STATE.CANCELLED; s.why = why; s.endedAt = Date.now();
  clearTimeout(s.timer); clearInterval(s.poll);
  try { if (s.run) s.run.cancel(); } catch { /* gone */ }
  try { const h = s.family === 'codex' && s.target ? ai().handle(app, s.target) : null; if (h && h.cancelLogin) await h.cancelLogin(); } catch { /* already over */ }
  await cleanup(app, s);
  return { ok: true, session: view(s) };
}

/** Wait for a session to settle (tests, and callers that must know). */
async function settled(id, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const s = get(id); if (!s || !ACTIVE.has(s.state) || Date.now() > end) return view(s); await new Promise((r) => setTimeout(r, 40)); }
}

function _reset() { for (const s of sessions.values()) { clearTimeout(s.timer); clearInterval(s.poll); try { if (s.run) s.run.cancel(); } catch { /* gone */ } } sessions.clear(); }

module.exports = { STATE, start, cancel, get, view, list, settled, register, activeFor, verify, cleanup, duplicateOf, fail, _reset, STRATEGIES };
