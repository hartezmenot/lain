'use strict';

/**
 * NO TEST LEAVES A SUPERVISOR BEHIND (S5.2). The runner lists supervisors serving a temporary home when it starts and
 * again when it ends; any new one was started by this run, is stopped (matched by its exact command line), and fails
 * the run. A supervisor serving a real home is never touched.
 */

const os = require('os');
const { spawnSync } = require('child_process');

function list() {
  if (process.platform !== 'win32') {
    const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return String(r.stdout || '').split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), cmd: m[2] })).filter((p) => /(noema|lain)-supervisor/.test(p.cmd) && temp(p.cmd));
  }
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='noema-supervisor.exe' OR Name='lain-supervisor.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return String(r.stdout || '').split(/\r?\n/).map((l) => l.split('\t')).filter((x) => x.length === 2 && temp(x[1])).map(([pid, cmd]) => ({ pid: Number(pid), cmd }));
}

/** Only a supervisor whose --home is under the temp folder is a test's. */
function temp(cmd) {
  const m = /serve --home\s+(\S+)/.exec(String(cmd));
  if (!m) return false;
  const h = m[1].toLowerCase();
  const roots = [os.tmpdir(), process.env.TEMP || '', 'C:\\Users\\HARTEZ~1\\AppData\\Local\\Temp'].filter(Boolean).map((r) => r.toLowerCase());
  return roots.some((r) => h.startsWith(r));
}

function snapshot() { try { return new Set(list().map((p) => p.cmd)); } catch { return new Set(); } }

/** The supervisors this run started and left; each is stopped. */
function leftovers(before) {
  let now = [];
  try { now = list(); } catch { return []; }
  const left = now.filter((p) => !before.has(p.cmd));
  for (const p of left) { try { process.kill(p.pid); } catch { /* already gone */ } }
  return left;
}

module.exports = { snapshot, leftovers, temp };
