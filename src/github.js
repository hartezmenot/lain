'use strict';

/**
 * GITHUB AS A PROJECT SOURCE — repositories become LAIN projects through a real
 * local working tree. LAIN never edits GitHub file objects over the API.
 *
 *   GitHub repo ─▶ clone ─▶ LAIN project (index, state) ─▶ Chat · Coding Agent · IDE
 *
 * AUTHENTICATION — whoever owns it, never a borrowed one:
 *   gh       GitHub's own CLI, signed in by the person (`gh auth login`). LAIN
 *            runs it; the token stays in gh's own store. Preferred.
 *   device   OAuth device flow with a CLIENT ID THE PERSON REGISTERED for LAIN
 *            (cfg.github.clientId) — never another application's. The token is
 *            kept in the OS secret store (DPAPI), never in config or a prompt.
 *   token    a FINE-GRAINED, repository-scoped token the person created, kept
 *            in DPAPI. Offered last; broad classic tokens are not asked for.
 * Secrets never reach a model, a log, the DOM or usage: they are registered with
 * redact.js and handed only to the git/gh process that needs them.
 *
 * VISIBILITY is whatever the identity/app can see — private repositories appear
 * only when they were authorized to it.
 *
 * SEVERAL IDENTITIES, EACH ITS OWN (2026-09-30):
 *   gh:<login>      an account GitHub CLI holds (gh keeps several per host). To act
 *                   as it, LAIN asks gh for THAT account's token and hands it to
 *                   the one git/gh process by environment — never on a command
 *                   line — and never switches gh's own active account.
 *   oauth:<login>   GitHub's device flow with the person's own OAuth App client id;
 *                   scopes chosen explicitly (read-only unless they ask for write).
 *   pat:<login>     a fine-grained token the person created.
 * oauth / pat tokens live in DPAPI under their own names; adding one never touches
 * another. LAIN's ACTIVE account is LAIN's choice alone (cfg.github.active). A
 * repository remembers the account it was opened with (cfg.github.bindings) and
 * what GitHub said that account may do there; a write it may not make is refused
 * with the reason — never retried silently as someone else.
 *
 * WRITES ARE EXPLICIT. Pull, branch, commit, push, pull request and issue each
 * need an explicit action from the person (the route passes `confirm`); none is
 * a model tool, and none happens because the Agent edited files. Normal git
 * semantics stay primary: git does the work; GitHub is asked only for what is
 * GitHub's (repositories, pull requests, issues).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// THE ONE CREDENTIAL BOUNDARY (credentials.js): a reference everywhere, the secret only where a request is built.
const CRED = () => require('./credentials').ref('github', 'oauth_token');
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function root(app) { return (app && app._sibling) || app; }
function cfgOf(app) { const c = (root(app) && root(app).cfg) || {}; return c.github || {}; }

function which(name) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const line = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return r.status === 0 && line ? line : null;
}
/** gh, from config first; never from PATH under test isolation. */
function ghBin(app) {
  const c = cfgOf(app);
  if (c.ghBin) return c.ghBin;
  if (process.env.LAIN_GH_BIN) return process.env.LAIN_GH_BIN;
  return process.env.LAIN_ISOLATED === '1' ? null : which('gh');
}

function run(cmd, args, { cwd = process.cwd(), env = null, input = null, timeout = 60000 } = {}) {
  const sh = require('./drivers/cliexec').resolveShim(cmd);
  const r = spawnSync(sh.command, [...sh.prefix, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout, env: env || process.env, input: input == null ? undefined : input });
  return { code: r.status == null ? -1 : r.status, stdout: String(r.stdout || ''), stderr: require('./redact').text(String(r.stderr || '')).trim(), error: r.error ? r.error.message : null };
}
function git(args, cwd, opts = {}) { return run('git', args, { cwd, ...opts }); }

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** One DPAPI entry per LAIN-held account — adding B never writes A's. */
function credOf(login) { return require('./credentials').ref(`github.${String(login).toLowerCase()}`, 'oauth_token'); }
function secret(ref) { try { return require('./credentials').resolve(ref) || null; } catch { return null; } }
function saveCfg(app) { try { require('./config').save(root(app).cfg); } catch { /* in memory */ } }
function gcfg(app) { const c = root(app).cfg; c.github = c.github || {}; return c.github; }

// ------------------------------------------------------------ accounts --

/**
 * THE ACCOUNTS GITHUB CLI HOLDS for github.com — `gh auth status` lists each with whether it is gh's own active one.
 * (gh prints tokens there masked; only the logins and scopes are read.) Cached briefly: status is asked often.
 */
let ghMemo = null;
function ghAccounts(app) {
  const gh = ghBin(app);
  if (!gh) return { gh: null, accounts: [], why: null };
  if (ghMemo && ghMemo.bin === gh && Date.now() - ghMemo.at < 30000) return ghMemo.value;
  const r = run(gh, ['auth', 'status', '--hostname', 'github.com'], { timeout: 15000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const accounts = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(line);
    if (m) { cur = { login: m[1], ghActive: false, scopes: null }; accounts.push(cur); continue; }
    if (!cur) continue;
    const a = /Active account:\s*(true|false)/i.exec(line);
    if (a) cur.ghActive = a[1].toLowerCase() === 'true';
    const s = /Token scopes:\s*(.*)$/i.exec(line);
    if (s) cur.scopes = s[1].replace(/'/g, '').split(',').map((x) => x.trim()).filter(Boolean);
  }
  // An older gh names one account and no "Active account" line: that one is its active account.
  if (accounts.length === 1 && !/Active account/i.test(text)) accounts[0].ghActive = true;
  const why = accounts.length ? null : /auth login|not logged/i.test(text) ? 'GitHub CLI is installed but not signed in — run `gh auth login`' : (r.error || null);
  const value = { gh, accounts, why };
  ghMemo = { bin: gh, at: Date.now(), value };
  return value;
}
function forgetGhMemo() { ghMemo = null; }

/** The accounts LAIN holds itself (device flow, fine-grained token) — and a token from before accounts, kept where it is. */
function heldAccounts(app) {
  const c = cfgOf(app);
  const out = Object.values(c.accounts || {}).filter((a) => a && a.id && LOGIN_RE.test(String(a.login || '')));
  if (c.user && !out.some((a) => a.login.toLowerCase() === String(c.user).toLowerCase()) && secret(CRED())) {
    out.push({ id: `${c.via === 'device' ? 'oauth' : 'pat'}:${c.user}`, login: c.user, via: c.via === 'device' ? 'oauth' : 'pat', legacy: true });
  }
  return out;
}

const VIA_LABEL = Object.freeze({ gh: 'GitHub CLI', oauth: 'Signed in with GitHub', pat: 'Fine-grained token' });

/** Every GitHub identity LAIN may act as, and which one is active — never a secret. */
function accounts(app) {
  const c = cfgOf(app);
  const hidden = c.hidden || {};
  const G = ghAccounts(app);
  const list = [];
  for (const a of G.accounts) {
    const id = `gh:${a.login}`;
    if (hidden[id]) continue;
    list.push({ id, login: a.login, via: 'gh', ghActive: a.ghActive, scopes: a.scopes });
  }
  for (const a of heldAccounts(app)) if (!list.some((x) => x.id === a.id)) list.push({ id: a.id, login: a.login, via: a.via, scopes: a.scopes || null, legacy: Boolean(a.legacy) });
  const names = c.names || {};
  const want = c.active && list.some((x) => x.id === c.active) ? c.active : ((list.find((x) => x.ghActive) || list[0] || {}).id || null);
  return list.map((a) => ({ ...a, name: names[a.id] || (c.accounts && c.accounts[a.id] && c.accounts[a.id].name) || null, viaLabel: VIA_LABEL[a.via], active: a.id === want, avatar: avatarOf(a.login) }));
}
function find(app, id) { return accounts(app).find((a) => a.id === id) || null; }
function activeAccount(app) { return accounts(app).find((a) => a.active) || null; }

/** THE TOKEN FOR ONE ACCOUNT, only where a request is built. gh is asked for that account's own. */
function tokenOf(app, a) {
  if (!a) return null;
  if (a.via === 'gh') {
    const gh = ghBin(app);
    if (!gh) return null;
    const r = run(gh, ['auth', 'token', '--hostname', 'github.com', '--user', a.login], { timeout: 15000 });
    const t = r.code === 0 ? r.stdout.trim() : '';
    if (t) { require('./redact').register(t); return t; }
    return null;
  }
  const t = secret(a.legacy ? CRED() : credOf(a.login));
  if (t) require('./redact').register(t);
  return t;
}
/** gh as ONE account: its own active one as is; another through GH_TOKEN in the child's environment only. */
function ghEnvFor(app, a) {
  if (!a || (a.via === 'gh' && a.ghActive)) return null;
  const t = tokenOf(app, a);
  return t ? { ...process.env, GH_TOKEN: t } : null;
}
/** git as ONE account: an HTTP header in git's own config channel — never on a command line, never in a remote URL. */
function gitEnvFor(app, a) {
  if (!a || (a.via === 'gh' && a.ghActive)) return null;
  const t = tokenOf(app, a);
  if (!t) return null;
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${t}`).toString('base64')}` };
}

/** LAIN's active account — LAIN's choice only; gh's own active account and the other accounts are untouched. */
function switchAccount(app, id) {
  const a = find(app, String(id || ''));
  if (!a) return { ok: false, why: 'no such GitHub account in Noema' };
  gcfg(app).active = a.id;
  saveCfg(app);
  return { ok: true, status: status(app) };
}
function rename(app, id, name) {
  const a = find(app, String(id || ''));
  if (!a) return { ok: false, why: 'no such GitHub account in Noema' };
  const g = gcfg(app);
  g.names = { ...(g.names || {}) };
  const n = String(name || '').trim().slice(0, 60);
  if (n) g.names[a.id] = n; else delete g.names[a.id];
  saveCfg(app);
  return { ok: true, status: status(app) };
}

// ------------------------------------------------------------ avatars (cached locally) --

function avatarFile(login) { return path.join(require('./config').configDir(), 'github', 'avatars', `${String(login).toLowerCase()}.png`); }
function avatarOf(login) {
  try { const b = fs.readFileSync(avatarFile(login)); return b.length && b.length < 200000 ? `data:image/png;base64,${b.toString('base64')}` : null; } catch { return null; }
}
/** Fetched once from GitHub's avatar host when an account is added; the page shows the local copy. */
async function cacheAvatar(url, login) {
  if (process.env.LAIN_ISOLATED === '1' || !url || !/^https:\/\/avatars\.githubusercontent\.com\//.test(url)) return false;
  try {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}s=96`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return false;
    const b = Buffer.from(await res.arrayBuffer());
    if (!b.length || b.length > 200000) return false;
    fs.mkdirSync(path.dirname(avatarFile(login)), { recursive: true });
    fs.writeFileSync(avatarFile(login), b);
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------ connection --

/** Who LAIN talks to GitHub as, and how — never the secret itself. */
function status(app) {
  const G = ghAccounts(app);
  const list = accounts(app);
  const a = list.find((x) => x.active) || null;
  if (a) {
    return { connected: true, via: a.via === 'gh' ? 'gh' : a.via === 'oauth' ? 'device' : 'token', user: a.login, name: a.name, avatar: a.avatar, active: a.id, gh: Boolean(G.gh),
      accounts: list, deviceFlow: Boolean(cfgOf(app).clientId), install: 'https://cli.github.com',
      note: a.via === 'gh' ? 'GitHub CLI holds the sign-in' : 'token kept in the Windows secret store (DPAPI)' };
  }
  return { connected: false, via: null, gh: Boolean(G.gh), accounts: [], why: G.why || (G.gh ? 'not signed in' : 'GitHub CLI is not installed — install it and run `gh auth login`, or sign in with GitHub, or add a fine-grained token'),
    deviceFlow: Boolean(cfgOf(app).clientId), install: 'https://cli.github.com' };
}

/** GitHub REST as one account (the active one unless named): through gh for a gh account, else with its token. */
async function api(app, route, { method = 'GET', body = null, account = null } = {}) {
  const a = account || activeAccount(app);
  if (!a) throw new Error('GitHub is not connected');
  const gh = ghBin(app);
  if (gh && a.via === 'gh') {
    const args = ['api', route, '--method', method];
    if (body) args.push('--input', '-');
    const r = run(gh, args, { input: body ? JSON.stringify(body) : null, env: ghEnvFor(app, a) });
    if (r.code !== 0) throw new Error(r.stderr || 'gh api failed');
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  }
  const t = tokenOf(app, a);
  if (!t) throw new Error(`the sign-in for @${a.login} is gone — connect it again`);
  const res = await fetch(`https://api.github.com/${String(route).replace(/^\//, '')}`, {
    method, headers: { authorization: `Bearer ${t}`, accept: 'application/vnd.github+json', 'user-agent': 'Noema', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${require('./redact').text(txt).slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}

/** A NEW LAIN-HELD ACCOUNT: its own DPAPI entry, its own record; it becomes LAIN's active account. Others are untouched. */
async function keep(app, t, via, me, scopes) {
  if (!me || !LOGIN_RE.test(String(me.login || ''))) return { ok: false, why: 'GitHub did not say who this is' };
  const st = require('./credentials').store(credOf(me.login), t, { kind: 'oauth_token' });
  if (st && st.ok === false) return { ok: false, why: st.why };
  const g = gcfg(app);
  const id = `${via}:${me.login}`;
  g.accounts = { ...(g.accounts || {}), [id]: { id, login: me.login, via, name: me.name || null, scopes: scopes || null, addedAt: Date.now() } };
  g.active = id;
  saveCfg(app);
  await cacheAvatar(me.avatar_url, me.login);
  return { ok: true, id, status: status(app) };
}

/** Store a fine-grained token the person pasted — DPAPI only, verified first. */
async function connectToken(app, tok) {
  const t = String(tok || '').trim();
  if (!/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test(t)) return { ok: false, why: 'that does not look like a GitHub token' };
  if (/^ghp_/.test(t)) return { ok: false, why: 'Noema does not take classic personal tokens (they reach every repository) — create a fine-grained token scoped to the repositories you choose' };
  require('./redact').register(t);
  const res = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${t}`, 'user-agent': 'Noema' }, signal: AbortSignal.timeout(20000) }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  if (!res.ok) return { ok: false, why: `GitHub refused the token (${res.status})` };
  return keep(app, t, 'pat', await res.json(), null);
}

// ------------------------------------------------------------ device flow (the person's own OAuth App) --

/**
 * SCOPES ARE CHOSEN, NEVER ASSUMED: read-only by default; write to public repositories, or to private ones, only
 * when the person picks it. (GitHub's OAuth scopes are coarse: `repo` reaches every private repository the person
 * can reach — said so where it is chosen.)
 */
const DEVICE_SCOPES = Object.freeze({ read: 'read:user', public: 'read:user public_repo', private: 'read:user repo' });
const devices = new Map();   // handle -> { deviceCode, clientId, interval, expires }
async function deviceStart(app, { access = 'read' } = {}) {
  const clientId = cfgOf(app).clientId;
  if (!clientId) return { ok: false, why: 'Signing in with GitHub needs the client id of an OAuth App you registered for Noema (Settings › GitHub) — Noema never borrows another application\'s' };
  const scope = DEVICE_SCOPES[access] || DEVICE_SCOPES.read;
  const res = await fetch('https://github.com/login/device/code', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Noema' }, body: JSON.stringify({ client_id: clientId, scope }), signal: AbortSignal.timeout(20000) })
    .catch((e) => ({ ok: false, status: 0, json: async () => ({ error_description: e.message }) }));
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.device_code) return { ok: false, why: `GitHub did not start the sign-in (${j.error_description || j.error || res.status})` };
  const handle = require('crypto').randomBytes(12).toString('hex');
  devices.set(handle, { deviceCode: j.device_code, clientId, interval: Math.max(5, Number(j.interval) || 5), expires: Date.now() + (Number(j.expires_in) || 900) * 1000, scope });
  return { ok: true, handle, userCode: j.user_code, verificationUri: j.verification_uri, interval: Math.max(5, Number(j.interval) || 5), expiresIn: Number(j.expires_in) || 900, scope };
}
async function devicePoll(app, handle) {
  const d = devices.get(String(handle || ''));
  if (!d) return { ok: false, why: 'that sign-in is no longer waiting' };
  if (Date.now() > d.expires) { devices.delete(handle); return { ok: false, why: 'the code expired — start again' }; }
  const res = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Noema' },
    body: JSON.stringify({ client_id: d.clientId, device_code: d.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }), signal: AbortSignal.timeout(20000) }).catch(() => null);
  const j = res ? await res.json().catch(() => ({})) : {};
  if (j.error === 'authorization_pending') return { ok: true, pending: true, interval: d.interval };
  if (j.error === 'slow_down') { d.interval += 5; return { ok: true, pending: true, interval: d.interval }; }
  if (!j.access_token) { devices.delete(handle); return { ok: false, why: j.error === 'access_denied' ? 'the sign-in was declined on GitHub' : `GitHub did not finish the sign-in (${j.error || 'no answer'})` }; }
  devices.delete(handle);
  const t = String(j.access_token);
  require('./redact').register(t);
  const me = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${t}`, 'user-agent': 'Noema' }, signal: AbortSignal.timeout(20000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return keep(app, t, 'oauth', me, String(j.scope || d.scope).split(/[\s,]+/).filter(Boolean));
}

/**
 * FORGET ONE ACCOUNT in LAIN. A LAIN-held token is deleted from DPAPI; a GitHub CLI account is only hidden from
 * LAIN — gh keeps its own sign-in (`gh auth logout` is the person's). No other account is touched.
 */
function disconnect(app, id = null) {
  const a = id ? find(app, String(id)) : activeAccount(app);
  if (!a) return { ok: false, why: 'no such GitHub account in Noema', status: status(app) };
  const g = gcfg(app);
  let note = null;
  if (a.via === 'gh') {
    g.hidden = { ...(g.hidden || {}), [a.id]: true };
    note = 'GitHub CLI keeps its own sign-in — `gh auth logout` signs it out';
  } else {
    try { require('./credentials').remove(a.legacy ? CRED() : credOf(a.login)); } catch { /* none */ }
    if (g.accounts) { g.accounts = { ...g.accounts }; delete g.accounts[a.id]; }
    if (a.legacy) { delete g.user; delete g.via; }
    try { fs.unlinkSync(avatarFile(a.login)); } catch { /* none */ }
  }
  if (g.active === a.id) delete g.active;
  if (g.bindings) for (const [repo, acc] of Object.entries(g.bindings)) if (acc === a.id) delete g.bindings[repo];
  saveCfg(app);
  return { ok: true, status: status(app), note };
}
/**
 * THE PERSON'S OWN OAUTH APP for the device flow — a public client id (the device flow takes no secret, and none is
 * asked for). GitHub's ids are 20 characters: hex for older apps, `Ov23…` / `Iv1.…` for newer ones.
 */
function setClientId(app, id) {
  const v = String(id || '').trim();
  if (v && !/^(Ov23[A-Za-z0-9]{16}|Iv1\.[a-f0-9]{16}|Iv23[A-Za-z0-9]{16}|[a-f0-9]{20})$/.test(v)) return { ok: false, why: 'that does not look like a GitHub OAuth App client id' };
  const g = gcfg(app);
  if (v) g.clientId = v; else delete g.clientId;
  saveCfg(app);
  return { ok: true, status: status(app) };
}

/** Show a hidden GitHub CLI account in LAIN again. */
function restore(app, id) {
  const g = gcfg(app);
  if (!g.hidden || !g.hidden[id]) return { ok: false, why: 'that account is not hidden' };
  g.hidden = { ...g.hidden }; delete g.hidden[id];
  saveCfg(app);
  return { ok: true, status: status(app) };
}

// ------------------------------------------------------------ per-repository account and permissions --

/** What GitHub said an account may do in a repository — kept for the session, per account. */
const perms = new Map();   // `${accountId}|${owner/repo}` -> { push, admin, pull, at }
function permOf(accountId, fullName) { return perms.get(`${accountId}|${String(fullName).toLowerCase()}`) || null; }
/** The account a repository belongs to in LAIN: the one it was opened with, else the active one. */
function accountFor(app, fullName) {
  const b = cfgOf(app).bindings || {};
  const id = fullName ? b[String(fullName).toLowerCase()] : null;
  if (id) return { account: find(app, id), bound: id };
  return { account: activeAccount(app), bound: null };
}
function bind(app, fullName, id) {
  if (!REPO_RE.test(String(fullName || ''))) return { ok: false, why: 'name the repository as owner/repo' };
  const a = id ? find(app, id) : activeAccount(app);
  if (!a) return { ok: false, why: 'no GitHub account to use' };
  const g = gcfg(app);
  g.bindings = { ...(g.bindings || {}), [String(fullName).toLowerCase()]: a.id };
  saveCfg(app);
  return { ok: true, fullName, account: { id: a.id, login: a.login } };
}

// ------------------------------------------------------------ repositories --

function remoteOf(dir) {
  const r = git(['remote', 'get-url', 'origin'], dir, { timeout: 8000 });
  if (r.code !== 0) return null;
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(r.stdout.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Local clones LAIN knows: registered ones, then projects it has sessions in. */
function localClones(app) {
  const out = new Map();
  for (const [name, dir] of Object.entries(cfgOf(app).clones || {})) if (fs.existsSync(dir)) out.set(name.toLowerCase(), dir);
  let rows = [];
  try { rows = require('./sessionindex').summaries({ limit: 200 }) || []; } catch { rows = []; }
  for (const d of [...new Set(rows.map((r) => r.cwd).filter(Boolean))].slice(0, 60)) {
    if (!fs.existsSync(path.join(d, '.git'))) continue;
    const n = remoteOf(d);
    if (n && !out.has(n.toLowerCase())) out.set(n.toLowerCase(), d);
  }
  return out;
}

/** Repositories the ACTIVE account may see, each with its local state and what that account may do there. */
async function repos(app, { limit = 100 } = {}) {
  const st = status(app);
  if (!st.connected) return { ok: false, why: st.why, status: st };
  const a = activeAccount(app);
  const rows = await api(app, `user/repos?per_page=${Math.min(100, limit)}&sort=updated&affiliation=owner,collaborator,organization_member`, { account: a });
  const clones = localClones(app);
  const bindings = cfgOf(app).bindings || {};
  return { ok: true, status: st, account: { id: a.id, login: a.login }, repos: (rows || []).map((r) => {
    const dir = clones.get(String(r.full_name).toLowerCase()) || null;
    const p = r.permissions ? { push: Boolean(r.permissions.push), admin: Boolean(r.permissions.admin), pull: r.permissions.pull !== false, at: Date.now() } : null;
    if (p) perms.set(`${a.id}|${String(r.full_name).toLowerCase()}`, p);
    const bound = bindings[String(r.full_name).toLowerCase()] || null;
    return { fullName: r.full_name, private: Boolean(r.private), defaultBranch: r.default_branch || 'main', url: r.html_url, updatedAt: r.updated_at || null, local: dir, state: dir ? projectStatus(dir) : { label: 'Not downloaded' },
      access: p ? (p.admin ? 'admin' : p.push ? 'write' : 'read') : null, boundTo: bound && bound !== a.id ? bound : null };
  }) };
}

/** Local working-tree state: branch, clean / modified, unpushed commits. */
function projectStatus(dir) {
  const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, { timeout: 8000 });
  if (b.code !== 0) return { label: 'Not a git working tree', ok: false };
  const branch = b.stdout.trim();
  // NOEMA'S OWN STATE (.noema/, or LAIN's .lain/) is not the person's change.
  const s = git(['status', '--porcelain', '--', '.', ':(exclude).noema', ':(exclude).lain'], dir, { timeout: 15000 });
  const modified = s.stdout.split(/\r?\n/).filter(Boolean).length;
  const ahead = git(['rev-list', '--count', '@{u}..HEAD'], dir, { timeout: 8000 });
  const behind = git(['rev-list', '--count', 'HEAD..@{u}'], dir, { timeout: 8000 });
  const unpushed = ahead.code === 0 ? Number(ahead.stdout.trim()) || 0 : null;
  const behindN = behind.code === 0 ? Number(behind.stdout.trim()) || 0 : null;
  // A MERGE LEFT FOR THE PERSON TO RESOLVE (Sync never resolves one for them).
  const u = git(['diff', '--name-only', '--diff-filter=U'], dir, { timeout: 8000 });
  const conflicts = u.code === 0 ? u.stdout.split(/\r?\n/).filter(Boolean) : [];
  const merging = fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'));
  const state = conflicts.length || merging ? 'CONFLICT' : modified ? 'LOCAL_CHANGES' : behindN && unpushed ? 'DIVERGED' : behindN ? 'BEHIND' : unpushed ? 'AHEAD' : ahead.code === 0 ? 'UP_TO_DATE' : 'NO_UPSTREAM';
  const label = { CONFLICT: 'Conflict', LOCAL_CHANGES: 'Local changes', DIVERGED: `${unpushed} ahead, ${behindN} behind`, BEHIND: `${behindN} commit${behindN === 1 ? '' : 's'} behind`, AHEAD: `${unpushed} commit${unpushed === 1 ? '' : 's'} ahead`, UP_TO_DATE: 'Up to date', NO_UPSTREAM: 'No upstream branch' }[state];
  return { ok: true, branch, clean: modified === 0, modified, unpushed, behind: behindN, upstream: ahead.code === 0, remote: remoteOf(dir), label, state, conflicts, merging,
    summary: `${branch} · ${modified ? `${modified} modified` : 'clean'}${unpushed ? ` · ${unpushed} unpushed commit${unpushed === 1 ? '' : 's'}` : ''}` };
}

function defaultCloneDir(app, fullName) {
  const base = cfgOf(app).cloneRoot || path.join(require('os').homedir(), 'Noema Projects');
  return path.join(base, fullName.split('/')[1]);
}

/** Clone a repository into a real working tree and register it. Explicit action. */
function clone(app, fullName, { dir = null } = {}) {
  if (!REPO_RE.test(String(fullName || ''))) return { ok: false, why: 'name the repository as owner/repo' };
  const target = path.resolve(dir || defaultCloneDir(app, fullName));
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    const r = remoteOf(target);
    if (r && r.toLowerCase() === fullName.toLowerCase()) return register(app, fullName, target, { existing: true });
    return { ok: false, why: `${target} already exists and is not a clone of ${fullName}` };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const gh = ghBin(app);
  // AS THE REPOSITORY'S ACCOUNT (the one it is bound to, else the active one).
  const a = accountFor(app, fullName).account;
  let r;
  if (gh && a && a.via === 'gh') r = run(gh, ['repo', 'clone', fullName, target], { timeout: 15 * 60000, env: ghEnvFor(app, a) });
  else {
    // THE TOKEN GOES TO GIT ONLY, as an HTTP header in git's own config channel — never on a command line.
    const env = gitEnvFor(app, a) || { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    r = git(['clone', `https://github.com/${fullName}.git`, target], path.dirname(target), { env, timeout: 15 * 60000 });
  }
  if (r.code !== 0) return { ok: false, why: `clone failed: ${r.stderr.split('\n').slice(-2).join(' ') || r.error || 'unknown'}` };
  return register(app, fullName, target, { existing: false });
}

function register(app, fullName, dir, { existing }) {
  const c = root(app).cfg;
  c.github = { ...(c.github || {}), clones: { ...((c.github && c.github.clones) || {}), [fullName]: dir } };
  // THE REPOSITORY REMEMBERS WHO OPENED IT — its writes go out as that account, not whichever is active later.
  const a = activeAccount(app);
  if (a && !(c.github.bindings && c.github.bindings[fullName.toLowerCase()])) c.github.bindings = { ...(c.github.bindings || {}), [fullName.toLowerCase()]: a.id };
  try { require('./config').save(c); } catch { /* in memory */ }
  return { ok: true, fullName, dir, existing, state: projectStatus(dir), account: a ? { id: a.id, login: a.login } : null };
}

// ------------------------------------------------------------ explicit actions --

const ACTIONS = Object.freeze(['fetch', 'sync', 'merge-abort', 'pull', 'branch', 'commit', 'push', 'pr-create', 'pr-view', 'issue-view', 'issue-create']);
const WRITES = new Set(['sync', 'merge-abort', 'pull', 'branch', 'commit', 'push', 'pr-create', 'issue-create']);

/**
 * ONE EXPLICIT ACTION on a local clone. Writes need `confirm: true` — the
 * person's own button press — and are never taken because the Agent edited.
 */
async function action(app, dir, kind, args = {}, { confirm = false } = {}) {
  if (!ACTIONS.includes(kind)) return { ok: false, why: `action is one of ${ACTIONS.join(', ')}` };
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return { ok: false, why: 'this project is not a git working tree' };
  if (WRITES.has(kind) && confirm !== true) return { ok: false, needsConfirm: true, why: `${kind} changes the repository — confirm it explicitly` };
  const full = remoteOf(dir);
  // AS THE REPOSITORY'S OWN ACCOUNT — and only what GitHub said that account may do there. Never retried as another.
  const who = full ? accountFor(app, full) : { account: activeAccount(app), bound: null };
  if (who.bound && !who.account && ['push', 'pr-create', 'issue-create'].includes(kind)) {
    return { ok: false, kind, needsAccount: true, why: `${full} was opened with @${who.bound.replace(/^\w+:/, '')}, which is no longer connected to Noema — choose the account for this repository first` };
  }
  const p = who.account && full ? permOf(who.account.id, full) : null;
  if (p && !p.push && (kind === 'push' || kind === 'pr-create')) return { ok: false, kind, readOnly: true, why: `@${who.account.login} can read ${full} but cannot write to it — use an account with write access` };
  const netEnv = gitEnvFor(app, who.account);
  const as = who.account ? who.account.login : null;
  const ok = (extra) => ({ ok: true, kind, as, state: projectStatus(dir), ...extra });
  const fail = (r) => ({ ok: false, kind, why: r.stderr || r.error || `${kind} failed` });
  if (kind === 'pull') { const r = git(['pull', '--ff-only'], dir, { timeout: 5 * 60000, env: netEnv }); return r.code === 0 ? ok({ out: r.stdout.trim().slice(-400) }) : fail(r); }
  // FETCH: learn where the remote is — changes nothing in the working tree.
  if (kind === 'fetch') {
    const r = git(['fetch', '--prune'], dir, { timeout: 5 * 60000, env: netEnv });
    return r.code === 0 ? ok({ out: 'fetched' }) : { ok: false, kind, offline: true, why: `Offline or the remote refused: ${(r.stderr || r.error || '').trim().split('\n').pop()}`, state: { ...projectStatus(dir), state: 'OFFLINE', label: 'Offline' } };
  }
  // SYNC: fetch, then bring the remote's commits in the SAFE way — never a reset, never a discard.
  //   behind only        fast-forward
  //   ahead and behind   a merge commit; a conflict is LEFT for the person (Abort merge offered)
  //   local changes      git itself refuses if an incoming change would overwrite them — said so
  //   ahead only         nothing to bring in; Push is the next step
  if (kind === 'sync') {
    const f = git(['fetch', '--prune'], dir, { timeout: 5 * 60000, env: netEnv });
    if (f.code !== 0) return { ok: false, kind, offline: true, why: `Offline or the remote refused: ${(f.stderr || f.error || '').trim().split('\n').pop()}`, state: { ...projectStatus(dir), state: 'OFFLINE', label: 'Offline' } };
    const st = projectStatus(dir);
    if (st.state === 'CONFLICT') return { ok: false, kind, why: 'a merge is waiting for you to resolve its conflicts — resolve and commit, or Abort merge', state: st };
    if (!st.upstream) return { ok: false, kind, why: 'this branch has no upstream on the remote — Push it first', state: st };
    if (!st.behind) return ok({ out: st.unpushed ? `nothing to bring in; ${st.unpushed} local commit(s) to push` : 'already up to date', synced: 'nothing' });
    const m = st.unpushed ? git(['merge', '--no-edit', '@{u}'], dir, { timeout: 5 * 60000 }) : git(['merge', '--ff-only', '@{u}'], dir, { timeout: 5 * 60000 });
    const after = projectStatus(dir);
    if (m.code === 0) return ok({ out: st.unpushed ? 'merged the remote commits' : `fast-forwarded ${st.behind} commit(s)`, synced: st.unpushed ? 'merge' : 'fast-forward', state: after });
    const text = `${m.stdout || ''}\n${m.stderr || ''}`;
    if (after.state === 'CONFLICT') return { ok: false, kind, conflict: true, why: `the merge has conflicts in ${after.conflicts.length} file(s) — resolve them and commit, or Abort merge. Nothing was discarded.`, state: after };
    if (/would be overwritten/i.test(text)) return { ok: false, kind, localChanges: true, why: 'the remote changes touch files you have modified — commit (or stash) them first. Nothing was changed.', state: after };
    return { ok: false, kind, why: text.trim().split('\n').pop() || 'the merge did not complete', state: after };
  }
  if (kind === 'merge-abort') {
    if (!fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))) return { ok: false, why: 'no merge is in progress' };
    const r = git(['merge', '--abort'], dir); return r.code === 0 ? ok({ out: 'merge aborted — back to your commits' }) : fail(r);
  }
  if (kind === 'branch') {
    const name = String(args.name || '').trim();
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(name) || name.includes('..')) return { ok: false, why: 'a branch name is letters, digits, . _ / -' };
    const r = git(['switch', '-c', name], dir); return r.code === 0 ? ok({ branch: name }) : fail(r);
  }
  if (kind === 'commit') {
    const msg = String(args.message || '').trim();
    if (!msg) return { ok: false, why: 'write a commit message' };
    const add = git(['add', '-A'], dir); if (add.code !== 0) return fail(add);
    const r = git(['commit', '-m', msg], dir); return r.code === 0 ? ok({ out: r.stdout.trim().split('\n')[0] }) : fail(r);
  }
  if (kind === 'push') { const r = git(['push', '-u', 'origin', 'HEAD'], dir, { timeout: 5 * 60000, env: netEnv }); return r.code === 0 ? ok({ out: (r.stderr || r.stdout).trim().slice(-300) }) : fail(r); }
  if (!full) return { ok: false, why: 'this working tree has no GitHub origin' };
  const account = who.account;
  if (kind === 'pr-create') {
    const st = projectStatus(dir);
    const body = { title: String(args.title || '').trim() || `Changes from ${st.branch}`, head: st.branch, base: String(args.base || 'main'), body: String(args.body || '') };
    const pr = await api(app, `repos/${full}/pulls`, { method: 'POST', body, account });
    return ok({ pr: { number: pr.number, url: pr.html_url, title: pr.title } });
  }
  if (kind === 'pr-view') {
    const prs = await api(app, `repos/${full}/pulls?state=open&per_page=20`, { account });
    return ok({ prs: (prs || []).map((x) => ({ number: x.number, title: x.title, url: x.html_url, head: x.head && x.head.ref })) });
  }
  if (kind === 'issue-view') {
    const is = await api(app, `repos/${full}/issues?state=open&per_page=20`, { account });
    return ok({ issues: (is || []).filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, url: i.html_url })) });
  }
  const iss = await api(app, `repos/${full}/issues`, { method: 'POST', body: { title: String(args.title || '').trim(), body: String(args.body || '') }, account });
  return ok({ issue: { number: iss.number, url: iss.html_url } });
}

module.exports = {
  status, api, repos, clone, projectStatus, localClones, action, connectToken, disconnect, restore, remoteOf, ghBin,
  accounts, activeAccount, switchAccount, rename, bind, accountFor, permOf, deviceStart, devicePoll, setClientId, forgetGhMemo, DEVICE_SCOPES,
  ACTIONS, WRITES, REPO_RE,
};
