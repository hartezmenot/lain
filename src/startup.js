'use strict';

/**
 * START LAIN WHEN THE PERSON SIGNS IN — a per-user Startup-folder shortcut to
 * LAIN.exe. This is how Windows itself starts a program at sign-in for one user:
 * no registry key, no administrator, removable by deleting one file.
 *
 * DELIBERATELY NOT distribution/shortcut.js. Nothing in src/ may reach the
 * installer (tests/distribution/install.test.js BOUNDARY), so the running
 * application owns this one shortcut itself. The shortcut is written the same
 * way — a WScript.Shell call with the paths passed as arguments, never
 * interpolated into the script.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function startupDir() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function linkPath() { return path.join(startupDir(), 'LAIN.lnk'); }

function enabled() { return process.platform === 'win32' && fs.existsSync(linkPath()); }

function enable(target) {
  if (process.platform !== 'win32') return { ok: false, why: 'Windows only' };
  if (!target || !fs.existsSync(target)) return { ok: false, why: 'LAIN.exe is not installed' };
  const link = linkPath();
  try { fs.mkdirSync(path.dirname(link), { recursive: true }); } catch (e) { return { ok: false, why: `the Startup folder could not be made: ${e.message}` }; }
  const script = [
    'param([string]$Link, [string]$Target)',
    '$s = New-Object -ComObject WScript.Shell',
    '$sc = $s.CreateShortcut($Link)',
    '$sc.TargetPath = $Target',
    '$sc.WorkingDirectory = Split-Path -Parent $Target',
    '$sc.Description = "LAIN"',
    '$sc.Save()',
  ].join('\n');
  const file = path.join(os.tmpdir(), `lain-startup-${process.pid}.ps1`);
  try {
    fs.writeFileSync(file, script, 'utf8');
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-Link', link, '-Target', target],
      { stdio: 'pipe', timeout: 30_000, windowsHide: true });
  } catch (e) {
    const said = String((e && (e.stderr || e.stdout)) || (e && e.message) || '').trim().split('\n')[0];
    return { ok: false, why: `the shortcut could not be written: ${said || 'PowerShell failed'}` };
  } finally {
    try { fs.unlinkSync(file); } catch { /* temp */ }
  }
  return fs.existsSync(link) ? { ok: true, link } : { ok: false, why: 'PowerShell reported success and produced no shortcut' };
}

function disable() {
  const link = linkPath();
  if (!fs.existsSync(link)) return { ok: true, removed: false };
  try { fs.unlinkSync(link); } catch (e) { return { ok: false, why: `${link} could not be removed: ${e.message}` }; }
  return { ok: true, removed: true };
}

module.exports = { enabled, enable, disable, linkPath, startupDir };
