'use strict';

/**
 * WHERE ONE CODEX ACCOUNT LIVES — two layouts, both with one Codex binary.
 *
 *   direct    the instance has its own CODEX_HOME (one LAIN creates under
 *             <configDir>/accounts/codex/<id>/home, or one the person names).
 *             Nothing shared: its sessions are its own.
 *
 *   overlay   the instance shares a Codex home (normally ~/.codex) for
 *             everything EXCEPT who it is signed in as. A shadow home links the
 *             shared entries (sessions, archived_sessions, sqlite, skills,
 *             plugins, config.toml …) and keeps these PRIVATE, never linked,
 *             never copied:
 *
 *                auth.json          the account's own login (written by Codex's
 *                                   own login flow into THIS shadow home)
 *                models_cache.json  what THIS account may use
 *                log, memories, tmp local scratch
 *
 *             So a native Codex session started under one account is visible
 *             to the others (same shared `sessions`), and each account signs in
 *             separately. Nothing is copied from the shared home — not its auth,
 *             not its sessions.
 *
 * SESSION STORE: two instances can hand a thread to each other only when they
 * read the same session store — `codex:home:<shared or direct home>`.
 *
 * Learned from T3 Code's CodexHomeLayout (lesson, not code).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const KNOWN_SHARED = ['sessions', 'archived_sessions', 'sqlite', 'shell_snapshots', 'worktrees', 'skills', 'plugins', 'cache', 'logs'];
const PRIVATE = new Set(['auth.json', 'models_cache.json']);
const LOCAL = new Set(['log', 'memories', 'tmp', '.tmp']);
// Per-process runtime locks a shadow must not share with the live shared home.
const NEVER_LINK = new Set(['mcp-oauth-locks', 'installation_id']);

function expand(p) { return String(p || '').replace(/^~(?=$|[\\/])/, os.homedir()); }
function norm(p) { const r = path.resolve(expand(p)); return process.platform === 'win32' ? r.toLowerCase() : r; }

function instanceDir(id) {
  return path.join(require('../config').configDir(), 'accounts', 'codex', String(id).replace(/[^a-zA-Z0-9._-]/g, '_'));
}

/** The layout an instance's config asks for. Pure; touches nothing. */
function layout(id, config = {}) {
  const mode = config.home_mode === 'overlay' ? 'overlay' : 'direct';
  if (mode === 'direct') {
    const home = config.codex_home ? path.resolve(expand(config.codex_home)) : path.join(instanceDir(id), 'home');
    return { mode, home, shared: null, storeKey: `codex:home:${norm(home)}`, lainOwned: !config.codex_home };
  }
  const shared = path.resolve(expand(config.shared_home || '~/.codex'));
  const home = path.join(instanceDir(id), 'shadow');
  return { mode, home, shared, storeKey: `codex:home:${norm(shared)}`, lainOwned: true };
}

function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }

/**
 * Build (or repair) a shadow home. Directories are junctions on Windows (no
 * privilege needed); files are symlinks, or hard links where symlinks are not
 * permitted, or reported as not shared. Returns what it did, honestly.
 */
function materialize(l) {
  const report = { linked: [], unshared: [], privateFixed: [] };
  fs.mkdirSync(l.home, { recursive: true });
  if (l.mode !== 'overlay') return report;
  // THE SHARED HOME IS THE PERSON'S. Nothing is created, changed or removed in
  // it here — not even an empty directory. What it lacks is simply not shared.
  if (!fs.existsSync(l.shared)) { report.unshared.push({ name: '*', why: 'the shared home does not exist' }); return report; }
  // AN ISOLATED TEST RUN never links into the person's real Codex home.
  if (process.env.LAIN_ISOLATED === '1' && norm(l.shared) === norm(path.join(os.homedir(), '.codex'))) {
    throw new Error('refusing to overlay the real ~/.codex from an isolated test run');
  }
  let names = [];
  try { names = fs.readdirSync(l.shared); } catch { names = []; }
  const entries = new Set(KNOWN_SHARED);
  for (const n of names) if (!PRIVATE.has(n) && !LOCAL.has(n) && !NEVER_LINK.has(n)) entries.add(n);

  // AUTH MUST BE A REAL FILE OF ITS OWN. A link here would sign every
  // account in as the shared one — the exact collapse this layout prevents.
  for (const n of PRIVATE) {
    const p = path.join(l.home, n);
    const st = lstat(p);
    if (st && st.isSymbolicLink()) { fs.unlinkSync(p); report.privateFixed.push(n); }
    else if (st && st.isFile() && st.nlink > 1) { fs.unlinkSync(p); report.privateFixed.push(n); }
  }

  for (const n of entries) {
    const target = path.join(l.shared, n);
    const link = path.join(l.home, n);
    const tst = lstat(target);
    if (!tst) { if (KNOWN_SHARED.includes(n)) report.unshared.push({ name: n, why: 'not present in the shared home' }); continue; }
    const have = lstat(link);
    if (have) {
      if (have.isSymbolicLink()) {
        let to = ''; try { to = fs.readlinkSync(link); } catch { /* broken */ }
        if (norm(path.resolve(path.dirname(link), to)) === norm(target)) { report.linked.push(n); continue; }
        fs.unlinkSync(link);
      } else if (have.isFile() && tst.isFile() && have.ino && have.ino === tst.ino) { report.linked.push(n); continue; }
      else { report.unshared.push({ name: n, why: 'the shadow already has its own copy; left as it is' }); continue; }
    }
    try {
      if (tst.isDirectory()) fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      else {
        try { fs.symlinkSync(target, link, 'file'); } catch { fs.linkSync(target, link); }
      }
      report.linked.push(n);
    } catch (e) {
      report.unshared.push({ name: n, why: e.code || e.message });
    }
  }
  return report;
}

/** Is this shadow home's auth its own? (Checked by the collapse guard.) */
function authIsPrivate(l) {
  const st = lstat(path.join(l.home, 'auth.json'));
  return !st || (st.isFile() && !st.isSymbolicLink() && st.nlink === 1);
}

/**
 * Remove what LAIN created for an instance: the shadow's links and its private
 * files, or a LAIN-created direct home. A home the person named is never
 * deleted. Links are unlinked, not followed — the shared home is untouched.
 */
function removeOwned(l) {
  if (!l.lainOwned) return { removed: false, why: 'the person named this home; LAIN does not delete it' };
  const dir = path.dirname(l.home);
  if (l.mode === 'overlay') {
    let names = [];
    try { names = fs.readdirSync(l.home); } catch { names = []; }
    for (const n of names) {
      const p = path.join(l.home, n);
      const st = lstat(p);
      if (st && (st.isSymbolicLink() || (process.platform === 'win32' && st.isDirectory() && isJunction(p)))) { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { /* leave it */ } } }
      else if (st && st.isFile() && st.nlink > 1) { try { fs.unlinkSync(p); } catch { /* leave it */ } }
    }
  }
  // A LINK LEFT BEHIND IS A PATH INTO THE SHARED HOME: refuse rather than let
  // a recursive delete near it run.
  let left = [];
  try { left = fs.readdirSync(l.home).filter((n) => { const st = lstat(path.join(l.home, n)); return st && st.isSymbolicLink(); }); } catch { left = []; }
  if (left.length) return { removed: false, why: `links still in the shadow home (${left.join(', ')}); nothing deleted` };
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: true };
}

function isJunction(p) {
  try { const to = fs.readlinkSync(p); return Boolean(to); } catch { return false; }
}

module.exports = { layout, materialize, authIsPrivate, removeOwned, instanceDir, KNOWN_SHARED, PRIVATE, LOCAL };
