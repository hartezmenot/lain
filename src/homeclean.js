'use strict';

/**
 * HOME CLEAN (2026-10-06) — `lain home`, `lain home clean [sessions] [--yes]`.
 *
 * ~/.lain is the person's DATA: settings, accounts and their sign-ins, credentials (DPAPI), skills, model and usage
 * records. Over many builds it also collected what no current LAIN reads — window programs copied into the home, an
 * old window profile, preview profiles, accounts that were removed, test leftovers, old config copies — and the
 * history of every session. This module lists all of it as a MANIFEST (path, class, size, reason, action) and removes
 * only rows whose action is `delete`. Nothing is removed without --yes; sessions only with the word `sessions`.
 *
 *   CLASSES   CONFIG · AUTH · DATA (kept) · SESSION (removed only by a session reset) · OBSOLETE · CACHE (removed)
 *             UNKNOWN (kept, reported — a name LAIN does not recognise is never removed because it is in the home)
 *   LINKS     account homes hold junctions and symlinks into the runtimes' own folders (~/.codex …): a link is
 *             unlinked, never followed — what it points at is never touched.
 *   BACKUP    before a removal, one archive of what a person cannot recreate (settings, account identities,
 *             credential references and DPAPI blobs, sign-in files, skills) — never of the history being removed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KEEP = 'keep'; const DELETE = 'delete';

function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function ls(d) { try { return fs.readdirSync(d); } catch { return []; } }
/** Bytes and files under p, links counted as links (never followed). */
function sizeOf(p) {
  const st = lstat(p); if (!st) return { bytes: 0, files: 0 };
  if (st.isSymbolicLink() || !st.isDirectory()) return { bytes: st.isSymbolicLink() ? 0 : st.size, files: 1 };
  let bytes = 0; let files = 0;
  for (const e of ls(p)) { const s = sizeOf(path.join(p, e)); bytes += s.bytes; files += s.files; }
  return { bytes, files };
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

/** The account homes LAIN still uses: the instances accounts.json lists. */
function registeredAccounts(home) {
  const a = readJson(path.join(home, 'accounts.json'));
  return new Set(Object.keys((a && a.instances) || {}));
}

/** Top-level names and what they are. A function gets the row and may split it into sub-rows. */
const TOP = {
  // CONFIG — the person's settings and LAIN's records of them
  'config.json': ['CONFIG', 'settings'], 'accounts.json': ['CONFIG', 'account identities'], 'credentials.json': ['CONFIG', 'credential references (the secrets are DPAPI blobs in secrets/)'],
  'fabric.json': ['CONFIG', 'account families, aliases and quota'], 'schema-version.json': ['CONFIG', 'home schema'], 'projects.json': ['CONFIG', 'known projects'],
  'desktop-window.json': ['CONFIG', 'window size and place'], 'desktop-window-preview.json': ['CONFIG', 'Preview window size and place'], 'desktop-window-dashboard.json': ['CONFIG', 'dashboard window size and place'],
  'model-catalog.json': ['DATA', 'model catalog'], 'new-models.json': ['DATA', 'models already announced'], 'route-health.json': ['DATA', 'route health'],
  models: ['CONFIG', 'model profiles'], local: ['CONFIG', 'local model folders'], runtimes: ['CONFIG', 'connected runtimes'], skills: ['CONFIG', 'Skills'], bot: ['CONFIG', 'Bot settings'],
  control: ['CONFIG', 'control window state'], harness: ['AUTH', 'the window\'s local session key'], extensions: ['CONFIG', 'extensions'], mcp: ['CONFIG', 'MCP servers'], hooks: ['CONFIG', 'hooks'],
  catalog: ['DATA', 'model catalog cache'], usage: ['DATA', 'usage records'], projects: ['DATA', 'per-project memory'], backups: ['DATA', 'project snapshots and clean-up archives'],
  secrets: ['AUTH', 'credentials (DPAPI, CurrentUser)'], browser: ['AUTH', 'browser-tool profiles and their sign-ins'], webmodels: ['AUTH', 'web-model sign-ins'],
  chromium: ['DATA', 'the browser tool\'s Chromium (reusable download)'], tools: ['DATA', 'runtime downloads (reusable)'],
  update: ['DATA', 'update state (what is current, available, staged)'], 'hooks.json': ['CONFIG', 'hooks'], 'plugins.json': ['CONFIG', 'plugins'], plugins: ['CONFIG', 'plugins'],
  'editor.json': ['CONFIG', 'editor settings'], 'transport.json': ['CONFIG', 'transport settings'], 'mcp-catalog.json': ['DATA', 'MCP catalog'], github: ['AUTH', 'GitHub connection'],
  avatars: ['DATA', 'account pictures'], memory: ['DATA', 'memory'], 'extension-storage': ['DATA', 'extension storage'], packages: ['DATA', 'installed packages'],
  'core.json': ['DATA', 'the running Core\'s record'], design: ['DATA', 'Design settings'], 'window-snapshots.json': ['DATA', 'window layout'], 'agentverify.json': ['DATA', 'agent verification record'],
  observations: ['SESSION', 'session observations'], 'focus.jsonl': ['SESSION', 'focus log'], toolresults: ['SESSION', 'stored tool results'], screenshots: ['SESSION', 'session screenshots'],
  'no-session': ['SESSION', 'state of work outside a session'], feedback: ['SESSION', 'feedback drafts'],
  // SESSION — history; removed only by a session reset
  sessions: ['SESSION', 'conversations, their journal and leases'], checkpoints: ['SESSION', 'task checkpoints'], evidence: ['SESSION', 'session evidence'], provenance: ['SESSION', 'edit provenance'],
  candidates: ['SESSION', 'candidate workspaces'], concerns: ['SESSION', 'session concerns'], attention: ['SESSION', 'attention queue'], assistant: ['SESSION', 'assistant tasks and activity'],
  'no-project': ['SESSION', 'state of sessions outside a project'], workspaces: ['SESSION', 'temporary-workspace records'], instances: ['SESSION', 'records of LAIN processes (all ended)'],
  metrics: ['SESSION', 'session metrics'], workerhost: ['SESSION', 'worker log'], reqtrace: ['SESSION', 'provider request traces'], visual: ['SESSION', 'visual snapshots of old sessions'],
  // OBSOLETE / CACHE — no current LAIN reads them
  harnessapp: ['OBSOLETE', 'the pre-2026-09-30 window profile (the window now uses desktop/EBWebView)'],
  workshop: ['CACHE', 'Preview browser profiles, one per previewed project (recreated on use)'],
};

function row(p, cls, reason, action, extra = {}) { const s = sizeOf(p); return { path: p, class: cls, bytes: s.bytes, files: s.files, reason, action, ...extra }; }

/** THE MANIFEST. `sessions`: a session reset was asked for (SESSION rows become deletes). Pure: reads only. */
function plan({ home = require('./home').resolve(), sessions = false } = {}) {
  const rows = [];
  const accounts = registeredAccounts(home);
  for (const name of ls(home).sort()) {
    const p = path.join(home, name);
    const st = lstat(p); if (!st) continue;
    if (st.isSymbolicLink()) { rows.push(row(p, 'UNKNOWN', 'a link inside the home (not followed)', KEEP)); continue; }
    if (/^config\.json\./.test(name)) { rows.push(row(p, 'OBSOLETE', 'an old copy of config.json (the current one is kept and backed up)', DELETE)); continue; }
    if (name === 'desktop') { rows.push(...desktopRows(p)); continue; }
    if (name === 'accounts') { rows.push(...accountRows(p, accounts)); continue; }
    if (name === 'supervisor') { rows.push(...supervisorRows(p, sessions)); continue; }
    if (name === 'decisions') { for (const f of ls(p)) rows.push(f.startsWith('.') ? row(path.join(p, f), 'CONFIG', 'remote-decision identity', KEEP) : row(path.join(p, f), 'SESSION', 'a decision taken in an old session', sessions ? DELETE : KEEP)); continue; }
    if (name === 'migrations') { for (const f of ls(p)) rows.push(/^home-from-|-notice$/.test(f) ? row(path.join(p, f), 'CONFIG', 'record of a home move / a notice shown', KEEP) : row(path.join(p, f), 'SESSION', 'an old code-migration task', sessions ? DELETE : KEEP)); continue; }
    if (name === 'computermcp' || name === 'pty') { rows.push(...newestOnly(p, name === 'pty' ? /^(?:lain|noema)-pty-[0-9a-f]+\.exe$/ : /^([a-z]+)-[0-9a-f]+\.exe$/)); continue; }
    if (name === 'browser' || name === 'webmodels') { rows.push(row(p, 'AUTH', TOP[name][1], KEEP)); continue; }
    const t = TOP[name];
    if (!t) { rows.push(row(p, 'UNKNOWN', 'not a name LAIN writes — kept', KEEP)); continue; }
    const [cls, reason] = t;
    const action = cls === 'OBSOLETE' || cls === 'CACHE' ? DELETE : cls === 'SESSION' ? (sessions ? DELETE : KEEP) : KEEP;
    rows.push(row(p, cls, reason, action));
  }
  return { home, sessions, rows };
}

/** desktop/: the window's own data stays (EBWebView, its profile); every program copied into the home goes. */
function desktopRows(dir) {
  return ls(dir).map((f) => {
    const p = path.join(dir, f);
    if (f === 'EBWebView') return row(p, 'DATA', 'the window\'s WebView2 profile (its settings and storage)', KEEP);
    if (/\.exe$|\.dll$/i.test(f)) return row(p, 'OBSOLETE', 'a window program copied into the home (the installed one runs from Programs\\LAIN)', DELETE);
    if (f === 'launch.json') return row(p, 'OBSOLETE', 'the old home launcher\'s indirection (no launcher lives in the home)', DELETE);
    if (f === 'assets') return row(p, 'OBSOLETE', 'a copy of the page (the installed one ships it)', DELETE);
    if (f === 'dev') return row(p, 'CACHE', 'a development window profile', DELETE);
    return row(p, 'UNKNOWN', 'not a name LAIN writes — kept', KEEP);
  });
}

/** accounts/<runtime>/<id>: an account LAIN still lists stays whole; one it no longer lists is removed (links unlinked). */
function accountRows(dir, registered) {
  const out = [];
  for (const rt of ls(dir)) {
    const rdir = path.join(dir, rt);
    const st = lstat(rdir); if (!st || !st.isDirectory()) { out.push(row(rdir, 'UNKNOWN', 'not a name LAIN writes — kept', KEEP)); continue; }
    for (const id of ls(rdir)) {
      const p = path.join(rdir, id);
      if (registered.has(id)) { out.push(row(p, 'AUTH', `${rt} account ${id} (listed in accounts.json)`, KEEP)); continue; }
      const fake = fs.existsSync(path.join(p, 'fake-login.json'));
      out.push(row(p, 'OBSOLETE', fake ? 'a test runtime\'s sign-in (fake-login.json) — never a real account' : `${rt} account home no longer listed in accounts.json (removed or replaced)`, DELETE));
    }
  }
  return out;
}

/** supervisor/: the running supervisor's endpoint stays; its old records are session history. */
function supervisorRows(dir, sessions) {
  return ls(dir).map((f) => {
    const p = path.join(dir, f);
    if (f === 'providers') return row(p, 'DATA', 'provider health mirror', KEEP);
    if (f === 'remote') return row(p, 'AUTH', 'the Bot\'s remote connection (Telegram) and its authorised chats', KEEP);
    if (['endpoint.json', 'serve.lock'].includes(f)) return row(p, 'DATA', 'the supervisor\'s endpoint (rewritten when it starts)', KEEP);
    return row(p, 'SESSION', 'supervisor records of old sessions and jobs', sessions ? DELETE : KEEP);
  });
}

/** Folders of built helper programs: the newest of each kind stays, older builds go. */
function newestOnly(dir, re) {
  const files = ls(dir).map((f) => ({ f, p: path.join(dir, f), m: (lstat(path.join(dir, f)) || {}).mtimeMs || 0 }));
  const newest = new Map();
  for (const x of files) { const k = (re.exec(x.f) || [])[1] || x.f.replace(/-[0-9a-f]+\.exe$/, ''); const cur = newest.get(k); if (!cur || x.m > cur.m) newest.set(k, x); }
  return files.map((x) => {
    // A NOEMA-ERA BUILD is never the current one: LAIN builds lain-* (it rebuilds the helper when it next needs it).
    if (/^noema-/i.test(x.f)) return row(x.p, 'OBSOLETE', 'a Noema-era build of a helper program', DELETE);
    return re.test(x.f) && [...newest.values()].includes(x) === false
      ? row(x.p, 'OBSOLETE', 'an older build of a helper program (the newest is kept)', DELETE)
      : row(x.p, 'DATA', 'the current helper program', KEEP);
  });
}

/** ONE ARCHIVE of what cannot be recreated, before anything is removed. Never the history being removed. */
function backup(home, { now = Date.now() } = {}) {
  const items = ['config.json', 'accounts.json', 'credentials.json', 'fabric.json', 'projects.json', 'schema-version.json', 'desktop-window.json', 'secrets', 'skills', 'runtimes', 'models', 'local', 'bot', 'control', 'harness', 'extensions', 'mcp', 'hooks']
    .filter((f) => fs.existsSync(path.join(home, f)));
  // SIGN-IN FILES of listed accounts (not their caches or links).
  for (const id of registeredAccounts(home)) {
    const rt = id.replace(/-[0-9a-f]+$/, '').replace(/-code$/, '');
    for (const base of [path.join('accounts', rt, id), path.join('accounts', `${rt}-code`, id), path.join('accounts', rt === 'claude' ? 'claude' : rt, id)]) {
      for (const f of ['auth.json', path.join('shadow', 'auth.json'), '.credentials.json', '.claude.json', 'oauth_creds.json', 'google_accounts.json']) {
        const rel = path.join(base, f); const st = lstat(path.join(home, rel));
        if (st && st.isFile() && !items.includes(rel)) items.push(rel);
      }
    }
  }
  const dir = path.join(home, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pre-clean-${new Date(now).toISOString().replace(/[:.]/g, '-')}.tar`);
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const r = spawnSync(fs.existsSync(tar) ? tar : 'tar', ['-cf', file, '-C', home, ...items], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(file)) return { ok: false, why: `the backup archive could not be written: ${(r.stderr || r.error || '').toString().trim().split('\n')[0]}` };
  return { ok: true, file, items, bytes: fs.statSync(file).size };
}

/** Remove one path: a link is unlinked (never followed); a folder is removed with its links unlinked, not followed. */
function removePath(p) {
  const st = lstat(p); if (!st) return { ok: true, gone: true };
  try {
    if (st.isSymbolicLink()) fs.unlinkSync(p);
    else fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return { ok: !lstat(p) };
  } catch (e) { return { ok: false, why: e.code || e.message }; }
}

/** APPLY: back up, then remove the `delete` rows. Returns the manifest with each row's outcome. */
function apply(m, { backupFirst = true } = {}) {
  const todo = m.rows.filter((r) => r.action === DELETE);
  let b = null;
  if (backupFirst && todo.length) { b = backup(m.home); if (!b.ok) return { ok: false, why: b.why, rows: m.rows }; }
  let freed = 0;
  for (const r of todo) {
    const out = removePath(r.path);
    r.done = out.ok; r.why = out.why || null;
    if (out.ok) freed += r.bytes;
  }
  return { ok: todo.every((r) => r.done), backup: b, freed, rows: m.rows };
}

const MB = (n) => `${(n / 1048576).toFixed(1)} MB`;
function print(m, out = process.stdout) {
  const home = m.home;
  for (const r of m.rows) out.write(`${r.action === DELETE ? (r.done === false ? 'FAILED' : r.done ? 'removed' : 'remove ') : 'keep   '}  ${r.class.padEnd(8)} ${MB(r.bytes).padStart(10)}  ${path.relative(home, r.path)} — ${r.reason}${r.why ? ` (${r.why})` : ''}\n`);
  const del = m.rows.filter((r) => r.action === DELETE);
  out.write(`\n${del.length} to remove, ${MB(del.reduce((a, r) => a + r.bytes, 0))}; ${m.rows.length - del.length} kept.${m.sessions ? '' : ' Session history is kept (`lain home clean sessions` resets it).'}\n`);
}

async function cli(args = []) {
  const sessions = args.includes('sessions');
  const yes = args.includes('--yes');
  const sub = args[0] || 'inspect';
  if (!['inspect', 'clean'].includes(sub)) { process.stdout.write('lain home              list what is in ~/.lain and why\nlain home clean [sessions] [--yes]   remove what no current LAIN reads (and, with `sessions`, all session history)\n'); return 0; }
  if (require('./home').override()) process.stdout.write(`(home: ${require('./home').resolve()})\n`);
  const m = plan({ sessions });
  if (sub === 'inspect' || !yes) { print(m); if (sub === 'clean') process.stdout.write('Nothing was removed. Add --yes to remove the rows marked "remove".\n'); return 0; }
  if (sessions && require('./supervisor').endpoint && require('./supervisor').endpoint()) process.stdout.write('note: the job supervisor is running; it is stopped first.\n');
  if (sessions) { try { await require('./supervisor').shutdownIn(m.home, { timeoutMs: 4000 }); } catch { /* none */ } }
  const r = apply(m);
  print({ ...m, rows: r.rows });
  if (r.backup) process.stdout.write(`backup: ${r.backup.file} (${MB(r.backup.bytes)}: ${r.backup.items.length} items — settings, accounts, credentials, skills)\n`);
  process.stdout.write(r.ok ? `freed ${MB(r.freed)}\n` : `some rows could not be removed (in use?) — run it again when LAIN is closed. ${r.why || ''}\n`);
  return r.ok ? 0 : 1;
}

module.exports = { plan, apply, backup, removePath, cli, sizeOf, KEEP, DELETE };
