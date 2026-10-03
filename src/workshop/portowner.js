'use strict';

/** WHO IS LISTENING ON THIS PORT — AND IS IT THE PROCESS LAIN STARTED? */

const { execFile } = require('child_process');

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || '') });
    });
  });
}

/** The pid listening on `port` (IPv4 or IPv6), or null. */
async function ownerOf(port) {
  const want = Number(port);
  if (!want) return null;
  if (process.platform === 'win32') {
    const r = await run('netstat', ['-ano']);
    if (!r.ok) return null;
    for (const line of r.out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      // TCP  0.0.0.0:5300  0.0.0.0:0  LISTENING  30620   ·   TCP  [::]:5300  [::]:0  LISTENING  30620
      if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
      const local = cols[1];
      const at = local.lastIndexOf(':');
      if (at < 0 || Number(local.slice(at + 1)) !== want) continue;
      const pid = Number(cols[4]);
      if (pid) return { pid };
    }
    return null;
  }
  const r = await run('lsof', ['-nP', `-iTCP:${want}`, '-sTCP:LISTEN', '-Fp']);
  if (!r.ok) return null;
  const m = /^p(\d+)/m.exec(r.out);
  return m ? { pid: Number(m[1]) } : null;
}

/** Every process id descended from `rootPid`, itself included. Null when it cannot be read. */
async function tree(rootPid) {
  const root = Number(rootPid);
  if (!root) return null;
  let pairs = [];
  if (process.platform === 'win32') {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], 15000);
    if (!r.ok) return null;
    pairs = r.out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((x) => x.length === 2 && x[0]);
  } else {
    const r = await run('ps', ['-Ao', 'pid=,ppid=']);
    if (!r.ok) return null;
    pairs = r.out.split(/\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((x) => x.length === 2 && x[0]);
  }
  const kids = new Map();
  for (const [pid, ppid] of pairs) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
  const out = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const p = queue.shift();
    for (const c of kids.get(p) || []) if (!out.has(c)) { out.add(c); queue.push(c); }
  }
  return out;
}

/** DOES THE PROCESS LISTENING ON `port` BELONG TO THE TREE LAIN STARTED AT `rootPid`? */
async function verify(rootPid, port) {
  const owner = await ownerOf(port);
  if (!owner) return { ok: null, why: 'the operating system did not name the listener' };
  const pids = await tree(rootPid);
  if (!pids) return { ok: null, owner, why: 'the process tree could not be read' };
  if (pids.has(owner.pid)) return { ok: true, owner };
  return { ok: false, owner, why: `:${port} is served by process ${owner.pid}, which is not the dev server LAIN started for this project (pid ${rootPid}) — another application holds that port` };
}

module.exports = { ownerOf, tree, verify };
