'use strict';

/**
 * WHERE NOEMA KEEPS ITS DATA — one answer, and the move from LAIN.
 *
 *   %USERPROFILE%\.noema          canonical (sessions, settings, account references, usage, caches, logs)
 *   %USERPROFILE%\.lain-v2        LAIN's home. Moved, never copied: one same-volume rename (a 10 GB home moves in
 *                                 milliseconds), then a DIRECTORY JUNCTION is left at the old path so an older
 *                                 LAIN build — or a LAIN process still running — reaches the same files and can never
 *                                 grow a second, independently written home.
 *
 * Overrides, most specific first: NOEMA_CONFIG_DIR, NOEMA_HOME, LAIN_CONFIG_DIR (tests and older tooling).
 * The move is made once, before anything reads the home (bin/noema.js), and is recorded in
 * <home>/migrations/home-from-lain.json. When it cannot be made (LAIN's home is locked), Noema keeps using the old
 * home for that run — it never splits the data — and tries again next start.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function canonical() { return path.join(os.homedir(), '.noema'); }
function legacy() { return path.join(os.homedir(), '.lain-v2'); }

function isJunction(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** The home this process uses. Pure: never moves anything. */
function resolve() {
  const o = process.env.NOEMA_CONFIG_DIR || process.env.NOEMA_HOME || process.env.LAIN_CONFIG_DIR;
  if (o) return o;
  return userHome();
}

/** The person's own home, ignoring overrides (the supervisor's default: it outlives any one session's settings). */
function userHome() {
  const c = canonical();
  if (isDir(c)) return c;
  const l = legacy();
  if (isDir(l) && !isJunction(l)) return l;   // not yet moved: LAIN's home stays the one home
  return c;
}

/**
 * MOVE LAIN'S HOME TO NOEMA'S, once. { state: 'none'|'done'|'moved'|'deferred'|'overridden', why? }
 */
function migrate({ now = Date.now(), version = null } = {}) {
  if (process.env.NOEMA_CONFIG_DIR || process.env.NOEMA_HOME || process.env.LAIN_CONFIG_DIR) return { state: 'overridden' };
  const c = canonical(); const l = legacy();
  if (isDir(c)) {
    // Already moved. Put the junction back if something removed it — an older LAIN would otherwise start a fresh home.
    if (!fs.existsSync(l)) { try { fs.symlinkSync(c, l, 'junction'); } catch { /* best effort */ } }
    return { state: 'done' };
  }
  if (!isDir(l) || isJunction(l)) return { state: 'none' };
  try {
    fs.renameSync(l, c);
  } catch (e) {
    return { state: 'deferred', why: `LAIN's data at ${l} could not be moved yet (${e.code || e.message}) — Noema keeps using it and will move it when it is not in use` };
  }
  let junction = false;
  try { fs.symlinkSync(c, l, 'junction'); junction = true; } catch { junction = false; }
  try {
    fs.mkdirSync(path.join(c, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(c, 'migrations', 'home-from-lain.json'), JSON.stringify({ from: l, to: c, at: new Date(now).toISOString(), by: version, junction }, null, 2));
  } catch { /* the move itself is the fact */ }
  // VERIFIED: the data is at the new path, and the old path (when a junction could be made) leads to the same place.
  let verified = isDir(c);
  if (verified && junction) { try { verified = fs.realpathSync.native(l).toLowerCase() === fs.realpathSync.native(c).toLowerCase(); } catch { verified = false; } }
  return { state: 'moved', from: l, to: c, junction, verified };
}

module.exports = { canonical, legacy, resolve, userHome, migrate, isJunction };
