'use strict';

/** LAIN'S OWN WINDOWS (S5.2) — never a Computer Control target: the Harness host, and the terminal that hosts this CLI */

const { spawnSync } = require('child_process');

const OWN_PROCESSES = /^(lain|lainhost|lain harness|lain-harness|lain-desktop-[0-9a-f]+)$/i;
let cached = null;

/** { pids:Set<number>, consoles:Set<number> } — this process's ancestors and its console window handle(s). */
function scan() {
  if (cached) return cached;
  const out = { pids: new Set([process.pid]), consoles: new Set() };
  if (process.platform === 'win32') {
    const ps = `$p=${process.pid}; $seen=@{}; while($p -and -not $seen[$p]){ $seen[$p]=1; "pid $p"; $q=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue; if(-not $q){break}; $p=$q.ParentProcessId }; `
      + 'Add-Type -Name W -Namespace S -MemberDefinition \'[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();\' -ErrorAction SilentlyContinue; "console $([S.W]::GetConsoleWindow().ToInt64())"';
    try {
      // IN A TERMINAL the child shares this console (windowsHide off), so GetConsoleWindow names it; headless, no window.
      const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: !process.stdout.isTTY, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        const m = /^(pid|console) (\d+)$/.exec(line.trim());
        if (m && Number(m[2])) out[m[1] === 'pid' ? 'pids' : 'consoles'].add(Number(m[2]));
      }
    } catch { /* the process names still apply */ }
  }
  cached = out;
  return out;
}

/** Is this window one of LAIN's own? */
function own(w) {
  if (!w) return false;
  const name = String(w.process || '').replace(/\.exe$/i, '');
  if (OWN_PROCESSES.test(name) || /^LAIN\b/.test(String(w.title || ''))) return true;
  const s = scan();
  return s.pids.has(Number(w.pid)) || s.consoles.has(Number(w.handle));
}

module.exports = { own, scan };
