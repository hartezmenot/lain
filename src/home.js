'use strict';

/** WHERE LAIN KEEPS ITS DATA — one answer, and the moves that led here. */

const fs = require('fs');
const os = require('os');
const path = require('path');

function canonical() { return path.join(os.homedir(), '.lain'); }
/** The homes LAIN has had, newest first. */
function legacyHomes() { return [path.join(os.homedir(), '.noema'), path.join(os.homedir(), '.lain-v2')]; }
function legacy() { return legacyHomes()[0]; }

function isJunction(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function realDir(p) { return isDir(p) && !isJunction(p); }

function override(env = process.env) { return env.LAIN_CONFIG_DIR || env.LAIN_HOME || env.NOEMA_CONFIG_DIR || env.NOEMA_HOME || null; }

/** The home this process uses. Pure: never moves anything. */
function resolve() {
  const o = override();
  if (o) return o;
  return userHome();
}

/** The person's own home, ignoring overrides (the supervisor's default: it outlives any one session's settings). */
function userHome() {
  const c = canonical();
  if (isDir(c) && !looksHistorical(c)) return c;
  // NOT YET MOVED: the newest real legacy home stays the one home until the move succeeds.
  for (const l of legacyHomes()) if (realDir(l)) return l;
  return c;
}

/** A ~/.lain THAT IS NOT THIS LAIN'S: a real folder left by a much older LAIN, sitting beside a real Noema-era home. */
function looksHistorical(c) {
  if (!realDir(c)) return false;
  if (fs.existsSync(path.join(c, 'migrations', 'home-from-noema.json')) || fs.existsSync(path.join(c, 'migrations', 'home-from-lain-v2.json'))) return false;
  return legacyHomes().some((l) => realDir(l) && (fs.existsSync(path.join(l, 'config.json')) || isDir(path.join(l, 'sessions'))));
}

function record(c, name, body) {
  try {
    fs.mkdirSync(path.join(c, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(c, 'migrations', `home-from-${name}.json`), JSON.stringify(body, null, 2));
  } catch { /* the move itself is the fact */ }
}

function realLower(p) { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return null; } }

/**
 * THE OLD NAMES ARE RETIRED, NOT KEPT (2026-10-06): a junction an earlier LAIN left at ~/.noema or ~/.lain-v2 is
 * removed when it leads to this home (or nowhere). Only a link is ever removed — a REAL folder there is data, and stays.
 */
function retireLinks(c = canonical()) {
  const home = realLower(c);
  const out = [];
  for (const l of legacyHomes()) {
    if (!isJunction(l)) continue;
    const to = realLower(l);
    if (to && to !== home) continue;               // somebody else's link: not LAIN's to remove
    try { fs.unlinkSync(l); out.push(l); } catch { /* in use; retried on the next start */ }
  }
  return out;
}

/** The legacy home a move would take, or null (no override, no real ~/.lain yet). Pure. */
function pendingMove() {
  if (override()) return null;
  const c = canonical();
  if (realDir(c) && !looksHistorical(c)) return null;
  return legacyHomes().find((l) => realDir(l)) || null;
}

/** MOVE THE CURRENT HOME TO ~/.lain, once. */
function migrate({ now = Date.now(), version = null } = {}) {
  if (override()) return { state: 'overridden' };
  const c = canonical();
  let archived = null;
  if (looksHistorical(c)) {
    // AN OLDER LAIN'S FOLDER, not this one's: set aside (renamed, never deleted) so the current home can move in.
    const aside = path.join(os.homedir(), `.lain-archived-${new Date(now).toISOString().replace(/[:.]/g, '-')}`);
    try { fs.renameSync(c, aside); archived = aside; } catch (e) {
      return { state: 'deferred', why: `a historical ~/.lain folder is in the way and could not be set aside (${e.code || e.message}) — LAIN keeps using your current home` };
    }
  }
  if (realDir(c)) {
    // ALREADY MOVED. Nothing points back: the old names are not recreated, and a link left by an older build goes.
    return { state: 'done', retired: retireLinks(c) };
  }
  const from = legacyHomes().find((l) => realDir(l));
  if (!from) return { state: 'none' };
  // A STALE JUNCTION AT ~/.lain (pointing somewhere gone) would block the rename; only a junction is ever removed.
  if (isJunction(c)) { try { fs.unlinkSync(c); } catch { /* the rename reports it */ } }
  try {
    fs.renameSync(from, c);
  } catch (e) {
    return { state: 'deferred', why: `your data at ${from} could not be moved to ${c} yet (${e.code || e.message}) — LAIN keeps using it and will move it when it is not in use` };
  }
  const name = path.basename(from).replace(/^\./, '');
  // NO LINK IS LEFT AT THE OLD NAME: ~/.lain is the one home, and a link to the older one that led here goes too.
  const retired = retireLinks(c);
  record(c, name, { from, to: c, at: new Date(now).toISOString(), by: version, junction: false, retired, archivedHistorical: archived });
  return { state: 'moved', from, to: c, junction: false, verified: isDir(c) && !fs.existsSync(from), retired, archived };
}

module.exports = { canonical, legacy, legacyHomes, resolve, userHome, migrate, pendingMove, isJunction, override, retireLinks };
