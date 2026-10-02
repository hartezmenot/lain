'use strict';

/**
 * START LAIN HARNESS WHEN THE PERSON SIGNS IN — a per-user Startup-folder shortcut, no administrator.
 *
 * THE SETTING IS CANONICAL, THE SHORTCUT IS ITS PROJECTION. `config.json` → `startup` holds the person's choice:
 *
 *     harness           start LAIN Harness at sign-in        default OFF — never opted in silently
 *     minimized         start it minimized                     default OFF
 *     restoreWorkspace  reopen the last session and project    default ON
 *
 * The Settings page and `lain settings startup …` both change THIS setting and then `sync()` makes Windows match
 * it. The shortcut points at the VERSION-INDEPENDENT launcher (`<install>\LAIN Harness.exe --startup`), so it
 * survives every update and rollback without being rewritten; the launcher applies a staged update before anything
 * starts (distribution/launcher.cs), and a LAIN already running (a CLI's Core) is attached to, never duplicated
 * (desktoprun.js). Setup re-syncs after install/repair/add-Harness and removes the shortcut when the Harness is
 * removed or LAIN is uninstalled — no dead entry is ever left behind.
 *
 * OLDER ENTRIES ARE REPLACED: the obsolete pre-cleanup `Startup\LAIN.lnk` (→ LAIN.exe) and the Noema-era
 * `Startup\Noema Harness.lnk`. The person chose to start the program at sign-in, so the choice carries over once
 * and the old shortcut is removed. (The current entry is `LAIN Harness.lnk` — a different name, never confused.)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LINK_NAME = 'LAIN Harness.lnk';
/** Obsolete pre-cleanup LAIN, then the Noema era (2026-09-29 … 2026-10-02). */
const LEGACY_LINKS = Object.freeze(['LAIN.lnk', 'Noema Harness.lnk']);
const DEFAULTS = Object.freeze({ harness: false, minimized: false, restoreWorkspace: true });

function startupDir() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function linkPath() { return path.join(startupDir(), LINK_NAME); }
function legacyLinkPaths() { return LEGACY_LINKS.map((n) => path.join(startupDir(), n)); }
/** The first older shortcut still present (or the obsolete LAIN.lnk path when none is). */
function legacyLinkPath() { return legacyLinkPaths().find((p) => fs.existsSync(p)) || legacyLinkPaths()[0]; }

/** The person's choice, with defaults. */
function setting(cfg) { return { ...DEFAULTS, ...((cfg && cfg.startup && typeof cfg.startup === 'object') ? cfg.startup : {}) }; }

/**
 * WHAT TO START: the installed, version-independent Harness launcher; in a development checkout the launcher
 * `lain --desktop` installed into the home (desktop.js). Null when the Harness is not installed at all.
 */
function launcher() {
  const root = process.env.LAIN_INSTALL_ROOT;
  if (root) { const p = path.join(root, 'LAIN Harness.exe'); return fs.existsSync(p) ? p : null; }
  if (!require('./components').harness()) return null;
  try { const p = require('./desktop').launcherPath(); return p && fs.existsSync(p) ? p : null; } catch { return null; }
}

/** One file, however it is spelled (8.3 short names, case). */
function realOf(p) { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(String(p || '')).toLowerCase(); } }
function samePath(a, b) { return realOf(a) === realOf(b); }

function enabled() { return process.platform === 'win32' && fs.existsSync(linkPath()); }

function readLink(link) {
  if (process.platform !== 'win32' || !fs.existsSync(link)) return null;
  try {
    // THE PATH GOES IN THE ENVIRONMENT: `-Command` does not hand trailing arguments to `$args`, and quoting a path
    // into the script text is how a `'` in a user name would break it.
    const out = execFileSync('powershell', ['-NoProfile', '-Command', '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LAIN_STARTUP_LINK); $s.TargetPath + "|" + $s.Arguments'], { encoding: 'utf8', windowsHide: true, timeout: 20_000, env: { ...process.env, LAIN_STARTUP_LINK: link } }).trim();
    const [target, args] = out.split('|');
    return { target, args: args || '' };
  } catch { return null; }
}

function writeLink(target, args) {
  const link = linkPath();
  try { fs.mkdirSync(path.dirname(link), { recursive: true }); } catch (e) { return { ok: false, why: `the Startup folder could not be made: ${e.message}` }; }
  const script = [
    'param([string]$Link, [string]$Target, [string]$Arguments)',
    '$s = New-Object -ComObject WScript.Shell',
    '$sc = $s.CreateShortcut($Link)',
    '$sc.TargetPath = $Target',
    '$sc.Arguments = $Arguments',
    '$sc.WorkingDirectory = [Environment]::GetFolderPath("UserProfile")',
    '$sc.IconLocation = $Target + ",0"',
    '$sc.Description = "LAIN Harness"',
    '$sc.Save()',
  ].join('\n');
  const file = path.join(os.tmpdir(), `lain-startup-${process.pid}.ps1`);
  try {
    fs.writeFileSync(file, script, 'utf8');
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-Link', link, '-Target', target, '-Arguments', args], { stdio: 'pipe', timeout: 30_000, windowsHide: true });
  } catch (e) {
    const said = String((e && (e.stderr || e.stdout)) || (e && e.message) || '').trim().split('\n')[0];
    return { ok: false, why: `the shortcut could not be written: ${said || 'PowerShell failed'}` };
  } finally { try { fs.unlinkSync(file); } catch { /* temp */ } }
  return fs.existsSync(link) ? { ok: true, link } : { ok: false, why: 'PowerShell reported success and produced no shortcut' };
}

/**
 * REMOVE THE ENTRY. `owned`: only when it points into THIS installation (LAIN_INSTALL_ROOT) — what uninstall uses, so
 * removing one LAIN install never takes away the sign-in entry another install (or a checkout) registered.
 */
function remove({ owned = false } = {}) {
  const link = linkPath();
  if (!fs.existsSync(link)) return { ok: true, removed: false };
  const root = process.env.LAIN_INSTALL_ROOT;
  if (owned && root) {
    const cur = readLink(link);
    const inside = cur && cur.target && path.relative(realOf(root), realOf(cur.target)).split(path.sep)[0] !== '..';
    if (!inside) return { ok: true, removed: false, why: 'the Startup entry belongs to another LAIN' };
  }
  try { fs.unlinkSync(link); } catch (e) { return { ok: false, why: `${link} could not be removed: ${e.message}` }; }
  return { ok: true, removed: true };
}

/**
 * MAKE WINDOWS MATCH THE SETTING. Idempotent; safe to run at every install, repair, update and Harness change.
 *   owned   (setup) take away only an entry that points into THIS install — never another install's or a checkout's
 *   legacy  carry LAIN's Startup shortcut over (false for a portable/unregistered install: that is not the machine's)
 * @returns {{ ok, registered, why?, migrated? }}
 */
function sync(cfg, { save = null, owned = false, legacy = true } = {}) {
  if (process.platform !== 'win32') return { ok: true, registered: false, why: 'Windows only' };
  let migrated = false;
  // THE OLDER CHOICE CARRIES OVER ONCE, then its shortcut goes.
  for (const old of legacy ? legacyLinkPaths().filter((p) => fs.existsSync(p)) : []) {
    if (cfg && !(cfg.startup && Object.prototype.hasOwnProperty.call(cfg.startup, 'harness'))) { cfg.startup = { ...setting(cfg), harness: true }; migrated = true; if (save) save(); }
    try { fs.unlinkSync(old); } catch { /* reported by status() as legacyLink */ }
  }
  const s = setting(cfg);
  const exe = launcher();
  if (!s.harness || !exe) { const r = remove({ owned }); return { ok: r.ok, registered: false, migrated, why: !s.harness ? '' : 'LAIN Harness is not installed' }; }
  const cur = readLink(linkPath());
  if (cur && samePath(cur.target, exe) && cur.args.trim() === '--startup') return { ok: true, registered: true, migrated };
  const w = writeLink(exe, '--startup');
  return { ok: w.ok, registered: w.ok, migrated, why: w.why || '' };
}

/** The setting and what Windows actually has — for Settings, `lain settings startup status`, and tests. */
function status(cfg) {
  const s = setting(cfg);
  const link = readLink(linkPath());
  const exe = launcher();
  return {
    ...s,
    registered: Boolean(link),
    target: link ? link.target : null,
    launcher: exe,
    consistent: s.harness && exe ? Boolean(link && samePath(link.target, exe)) : !link,
    legacyLink: legacyLinkPaths().some((p) => fs.existsSync(p)),
  };
}

/**
 * `lain settings startup status | harness on|off | minimized on|off | restore on|off | sync | remove` — the same
 * setting. Setup runs `sync --owned [--no-legacy]` after install/repair/Harness changes and `remove --owned` at
 * uninstall.
 */
function cli(args, { out = process.stdout } = {}) {
  const config = require('./config');
  const cfg = config.load();
  const [what, value] = args;
  const KEYS = { harness: 'harness', minimized: 'minimized', restore: 'restoreWorkspace', 'restore-workspace': 'restoreWorkspace' };
  if (what === 'remove') {
    const r = remove({ owned: args.includes('--owned') });
    out.write(!r.ok ? `startup: ${r.why}\n` : r.why ? `Left the Startup entry in place: ${r.why}.\n` : 'LAIN Harness no longer starts with Windows (the setting is kept).\n');
    return r.ok ? 0 : 1;
  }
  if (what && KEYS[what]) {
    if (!['on', 'off'].includes(value)) { out.write(`usage: lain settings startup ${what} on|off\n`); return 2; }
    cfg.startup = { ...setting(cfg), [KEYS[what]]: value === 'on' };
    config.save(cfg);
    const r = sync(cfg);
    if (!r.ok) { out.write(`Saved, but Windows was not updated: ${r.why}\n`); return 1; }
  } else if (what && what !== 'status' && what !== 'sync') { out.write('usage: lain settings startup status | harness on|off | minimized on|off | restore on|off | sync\n'); return 2; }
  if (what === 'sync') {
    const r = sync(cfg, { save: () => config.save(cfg), owned: args.includes('--owned'), legacy: !args.includes('--no-legacy') });
    if (!r.ok) { out.write(`startup: ${r.why}\n`); return 1; }
  }
  const st = status(cfg);
  out.write(`Start LAIN Harness with Windows: ${st.harness ? 'ON' : 'off'}${st.harness && !st.launcher ? ' (LAIN Harness is not installed — nothing is registered)' : ''}\n`);
  out.write(`  Start minimized: ${st.minimized ? 'on' : 'off'} · Restore previous workspace: ${st.restoreWorkspace ? 'on' : 'off'}\n`);
  out.write(`  Windows: ${st.registered ? `registered → ${st.target} --startup` : 'not registered'}${st.consistent ? '' : ' (out of step — run: lain settings startup sync)'}\n`);
  return 0;
}

module.exports = { setting, sync, status, cli, remove, launcher, enabled, linkPath, legacyLinkPath, legacyLinkPaths, startupDir, DEFAULTS, LINK_NAME };
