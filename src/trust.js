'use strict';

/** WHICH DIRECTORIES LAIN MAY WORK IN. */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LEVEL = Object.freeze({
  TRUSTED: 'TRUSTED',
  READ_ONLY: 'READ_ONLY',
  UNTRUSTED: 'UNTRUSTED',
});

/** HOW THE GATE BEHAVES when a path is not already decided about. */
const MODE = Object.freeze({
  ASK: 'ASK',
  AUTO: 'AUTO',
  DENY: 'DENY',
});

/** The gate's behaviour, from configuration. */
function modeOf(cfg = {}) {
  const raw = String((cfg && cfg.permissionMode) || '').toUpperCase();
  if (MODE[raw]) return MODE[raw];
  if (cfg && cfg.autoOutsideProject === false) return MODE.ASK;
  return MODE.AUTO;
}

/** What each mode means, in one sentence, for every screen that shows it. */
const MODE_MEANS = Object.freeze({
  [MODE.ASK]: 'anything outside this project asks you first',
  [MODE.AUTO]: 'ordinary paths outside the project pass; system and credential ones still ask',
  [MODE.DENY]: 'anything outside this project is refused without asking',
});

/** PLACES THAT ARE NEVER AUTO-APPROVED, however the mode is set. */
const NEVER_AUTO = [
  /^[A-Za-z]:[\\/]?$/,                       // C:\  — the bare drive
  /^[\\/]$/,                                 // /    — the bare root
  /^[A-Za-z]:[\\/]Windows([\\/]|$)/i,
  /^[A-Za-z]:[\\/]Program Files( \(x86\))?([\\/]|$)/i,
  /^[\\/](etc|bin|sbin|usr|boot|dev|proc|sys|var)([\\/]|$)/i,
  /[\\/]\.ssh([\\/]|$)/i,
  /[\\/]\.aws([\\/]|$)/i,
  /[\\/]\.gnupg([\\/]|$)/i,
  /[\\/]\.config[\\/]gh([\\/]|$)/i,
  /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/]Crypto([\\/]|$)/i,
];

/** Normalise for comparison: absolute, real case-insensitive on Windows. */
function norm(p) {
  let s = path.resolve(String(p || ''));
  // AN 8.3 SHORT NAME (C:\Users\HARTEZ~1\…) is the same folder as its long name; a folder trusted under one must be trusted under the other
  if (process.platform === 'win32' && s.includes('~')) {
    const rest = [];
    let head = s;
    for (let i = 0; i < 64; i++) {
      try { s = path.join(fs.realpathSync.native(head), ...rest.reverse()); break; } catch { /* not there yet */ }
      const up = path.dirname(head);
      if (up === head) break;
      rest.push(path.basename(head)); head = up;
    }
  }
  return process.platform === 'win32' ? s.replace(/[\\/]+$/, '').toLowerCase() : s.replace(/\/+$/, '');
}

/** Is `child` the same as, or inside, `root`? */
function within(child, root) {
  const c = norm(child);
  const r = norm(root);
  if (!c || !r) return false;
  if (c === r) return true;
  return c.startsWith(r + path.sep) || c.startsWith(`${r}/`);
}

/** Is this a path where a mistake is unrecoverable? */
function sensitive(p) {
  const raw = path.resolve(String(p || ''));
  let real = raw;
  try { real = fs.realpathSync.native ? fs.realpathSync.native(raw) : fs.realpathSync(raw); } catch { real = raw; }
  const home = norm(os.homedir());
  for (const candidate of [raw, real]) {
    if (NEVER_AUTO.some((re) => re.test(candidate))) return true;
    // THE HOME DIRECTORY ITSELF, but not the things inside it. Writing to
    // `~/project` is ordinary; writing to `~` is a different kind of act.
    if (norm(candidate) === home) return true;
  }
  return false;
}

/** What the config records about one directory. */
function entryFor(cfg, dir) {
  const list = (cfg && cfg.trustedPaths) || [];
  const target = norm(dir);
  // THE LONGEST MATCH WINS, so trusting `~/code` and then marking
  // `~/code/vendor` read-only means the more specific answer is the one used.
  let best = null;
  for (const e of list) {
    if (!e || !e.path) continue;
    if (!within(target, e.path)) continue;
    if (!best || norm(e.path).length > norm(best.path).length) best = e;
  }
  return best;
}

/** The level LAIN currently has for a directory. UNTRUSTED until decided. */
function levelOf(cfg, dir) {
  const e = entryFor(cfg, dir);
  return e && LEVEL[e.level] ? e.level : LEVEL.UNTRUSTED;
}

/** Has this directory been decided about at all? */
function decided(cfg, dir) {
  return Boolean(entryFor(cfg, dir));
}

/** Record a decision. Returns the new list, for the caller to save. */
function remember(cfg, dir, level) {
  const list = ((cfg && cfg.trustedPaths) || []).filter((e) => e && e.path && norm(e.path) !== norm(dir));
  if (LEVEL[level] && level !== LEVEL.UNTRUSTED) {
    list.push({ path: path.resolve(dir), level, at: new Date().toISOString() });
  }
  return list;
}

/** May LAIN touch this path, given the project root and the trust level? */
function check({ cfg, root, target, write = false, autoOutside = false, mode = null } = {}) {
  // THE MODE IS THE AUTHORITY, and it is resolved here so a caller that forgets to pass it still gets the configured behaviour rather than a default that…
  const m = (mode && MODE[mode]) ? MODE[mode]
    : (cfg && MODE[String(cfg.permissionMode || '').toUpperCase()]) ? MODE[String(cfg.permissionMode).toUpperCase()]
      : (autoOutside ? MODE.AUTO : MODE.ASK);
  const inside = within(target, root);

  // WHICH DECISION COVERS THIS PATH
  const own = entryFor(cfg, target);
  const level = own && LEVEL[own.level] ? own.level : (inside ? levelOf(cfg, root) : LEVEL.UNTRUSTED);
  const named = own ? path.basename(own.path) || own.path : path.basename(root);

  if (inside || own) {
    if (level === LEVEL.TRUSTED) return { ok: true };
    if (level === LEVEL.READ_ONLY) {
      return write
        ? { ok: false, ask: true, why: `${named} is open read-only` }
        : { ok: true };
    }
    return { ok: false, ask: true, why: `nothing has been decided about ${named} yet` };
  }

  // ---- OUTSIDE THE PROJECT ------------------------------------------------
  if (sensitive(target)) {
    // NEVER AUTOMATIC. Not a refusal — the user may genuinely mean it — but it
    // is always their call, in every mode.
    return { ok: false, ask: true, outside: true, why: 'that is a system or credential location' };
  }
  if (m === MODE.AUTO) return { ok: true, outside: true };
  // DENY REFUSES WITHOUT ASKING, and says so — `ask: false` is what stops the gate putting a prompt on a screen nobody is watching and then waiting for…
  if (m === MODE.DENY) {
    return { ok: false, ask: false, outside: true, why: 'that is outside this project, and permissions are set to DENY' };
  }
  return { ok: false, ask: true, outside: true, why: 'that is outside this project' };
}

module.exports = {
  LEVEL, MODE, MODE_MEANS, modeOf,
  levelOf, decided, remember, check, within, sensitive, norm, NEVER_AUTO,
};
