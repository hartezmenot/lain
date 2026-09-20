'use strict';

/**
 * THE START MENU ENTRY — how LAIN Desktop gets opened by somebody who is not
 * already in a terminal.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS PART OF INSTALLING.
 *
 * `lain` on PATH is the CLI's story and it is complete. The DESKTOP had none:
 * `LAIN.exe` was written into LAIN's own directory, where nothing points at it.
 * A Windows application you can only start by typing a path into a terminal is
 * a Windows application that is started by opening the terminal first — which
 * is the exact thing the native Harness exists to stop being necessary.
 *
 * ------------------------------------------------------------------------
 * IT IS A SHORTCUT, NOT AN INSTALL.
 *
 * The .lnk points at the `LAIN.exe` in LAIN's home directory, which itself
 * points at THIS checkout — the same single-canonical-runtime rule install.js
 * is built on. Nothing is copied, so nothing can drift, and uninstalling is
 * deleting one file.
 *
 * A .lnk is a COM shell object, so it is written through `WScript.Shell` in
 * PowerShell — the same "use what Windows already has" arrangement as the C#
 * bridges. No dependency is added.
 *
 * ------------------------------------------------------------------------
 * IT NEVER FAILS AN INSTALL. A machine with a locked-down Start Menu, a
 * roaming profile that forbids it, or no desktop at all is a machine where
 * LAIN still works completely from the CLI. The reason is reported; it is not
 * turned into an error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const NAME = 'LAIN.lnk';

/**
 * Where a per-user Start Menu entry belongs.
 *
 * It follows %APPDATA%, which is how Windows itself finds it — and is also how
 * a test redirects it, so nothing in this repository can put an entry into the
 * Start Menu of the person running the tests.
 */
function menuDir() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

function shortcutPath() { return path.join(menuDir(), NAME); }

/**
 * CREATE (or refresh) THE ENTRY, pointing at an existing LAIN.exe.
 * The caller supplies the target because building it is desktop.js's job, and
 * this file should not be able to decide there is one when there is not.
 */
function install({ target, description = 'LAIN — the native Harness' } = {}) {
  if (process.platform !== 'win32') return { ok: false, why: 'a Start Menu entry is a Windows thing' };
  if (!target) return { ok: false, why: 'no LAIN.exe to point at' };
  if (!fs.existsSync(target)) return { ok: false, why: `LAIN.exe is not at ${target}` };

  const link = shortcutPath();
  try { fs.mkdirSync(path.dirname(link), { recursive: true }); } catch (e) {
    return { ok: false, why: `the Start Menu folder could not be made: ${e.message}` };
  }

  // ARGUMENTS PASSED, NOT INTERPOLATED. The paths come from this machine, but a
  // home directory with a quote in it is not a reason to build a broken script.
  const script = [
    'param([string]$Link, [string]$Target, [string]$Desc)',
    '$s = New-Object -ComObject WScript.Shell',
    '$sc = $s.CreateShortcut($Link)',
    '$sc.TargetPath = $Target',
    '$sc.WorkingDirectory = Split-Path -Parent $Target',
    '$sc.Description = $Desc',
    '$sc.IconLocation = $Target + ",0"',
    '$sc.Save()',
  ].join('\n');
  const file = path.join(os.tmpdir(), `lain-shortcut-${process.pid}.ps1`);
  try {
    fs.writeFileSync(file, script, 'utf8');
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file,
      '-Link', link, '-Target', target, '-Desc', description],
    { stdio: 'pipe', timeout: 30_000, windowsHide: true });
  } catch (e) {
    const said = String((e && (e.stderr || e.stdout)) || (e && e.message) || '').trim().split('\n')[0];
    return { ok: false, why: `the shortcut could not be written: ${said || 'PowerShell failed'}` };
  } finally {
    try { fs.unlinkSync(file); } catch { /* temp */ }
  }
  if (!fs.existsSync(link)) return { ok: false, why: 'PowerShell reported success and produced no shortcut' };
  return { ok: true, link, target };
}

/** Remove it. Absent is a success: uninstalling something twice is not an error. */
function remove() {
  if (process.platform !== 'win32') return { ok: true, removed: false };
  const link = shortcutPath();
  if (!fs.existsSync(link)) return { ok: true, removed: false, link };
  try { fs.unlinkSync(link); } catch (e) { return { ok: false, why: `${link} could not be removed: ${e.message}` }; }
  return { ok: true, removed: true, link };
}

/** Is there one, and what does it point at? */
function status() {
  const link = shortcutPath();
  if (process.platform !== 'win32') return { exists: false, why: 'Windows only' };
  return { exists: fs.existsSync(link), link };
}

module.exports = { install, remove, status, shortcutPath, menuDir, NAME };
