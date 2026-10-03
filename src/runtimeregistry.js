'use strict';

/** THE RUNTIME REGISTRY — every long-running process LAIN starts, with an owner. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const DEFAULT_POLICY = Object.freeze({ onOwnerExit: 'stop', onProjectClose: false, onTaskEnd: false, restartOnCrash: false });

function dir() {
  if (process.env.LAIN_RUNTIME_DIR) return process.env.LAIN_RUNTIME_DIR;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'LAIN', 'runtime');
  return path.join(os.homedir(), '.cache', 'lain', 'runtime');
}

/** Who this process is, as an owner. Tests set LAIN_RUN_OWNER. */
function defaultOwner() { return process.env.LAIN_RUN_OWNER || `lain:${process.pid}`; }
function keyOf(owner) { return String(owner).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120); }
function leaseFile(owner) { return path.join(dir(), `${keyOf(owner)}.json`); }

// ---- process identity --------------------------------------------------------------

/** START TIMES for a set of pids: { pid: 'identity' | null }. */
// THIS process's own identity never changes while it runs: asked once, not on
// every lease check (each Windows answer is a PowerShell start, ~250 ms). Phase 8.1.
/** THE SPAWN CLOCK (2026-10-01). */
const SPAWN_TOLERANCE_MS = 3000;
const TICKS_AT_EPOCH = 621355968000000000n;
function clockIdentity(ms) { return `s${Math.round(ms)}`; }
function msOf(identity) {
  const v = String(identity || '');
  if (v[0] === 's') return Number(v.slice(1));
  if (v[0] === 'w') { try { return Number((BigInt(v.slice(1)) - TICKS_AT_EPOCH) / 10000n); } catch { return NaN; } }
  return NaN;
}
let ownStart = process.platform === 'win32' ? clockIdentity(Date.now() - process.uptime() * 1000) : null;
function startTimes(pids) {
  let want = [...new Set((pids || []).map(Number).filter((p) => Number.isInteger(p) && p > 0))];
  const out = {};
  for (const p of want) out[p] = null;
  if (ownStart && want.includes(process.pid)) { out[process.pid] = ownStart; want = want.filter((p) => p !== process.pid); }
  if (!want.length) return out;
  const got = startTimesUncached(want);
  Object.assign(out, got);
  if (got[process.pid]) ownStart = got[process.pid];
  return out;
}
function startTimesUncached(want) {
  const out = {};
  for (const p of want) out[p] = null;
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='SilentlyContinue'; foreach ($i in @(${want.join(',')})) { $p = Get-Process -Id $i; if ($p -and $p.StartTime) { "$i $($p.StartTime.ToUniversalTime().Ticks)" } }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+) (\d+)$/);
      if (m) out[Number(m[1])] = `w${m[2]}`;
    }
    return out;
  }
  for (const p of want) {
    try {
      const stat = fs.readFileSync(`/proc/${p}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      out[p] = `l${fields[19]}`;
    } catch {
      const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(p)], { encoding: 'utf8' });
      const t = String(r.stdout || '').trim();
      out[p] = t ? `p${t}` : null;
    }
  }
  return out;
}

/** The same, without blocking the caller: resolves { pid: identity | null }. */
function startTimesAsync(pids) {
  const want = [...new Set((pids || []).map(Number).filter((p) => Number.isInteger(p) && p > 0))];
  if (process.platform !== 'win32' || !want.length) return Promise.resolve(startTimes(want));
  return new Promise((resolve) => {
    const out = {};
    for (const p of want) out[p] = null;
    const script = `$ErrorActionPreference='SilentlyContinue'; foreach ($i in @(${want.join(',')})) { $p = Get-Process -Id $i; if ($p -and $p.StartTime) { "$i $($p.StartTime.ToUniversalTime().Ticks)" } }`;
    let text = '';
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    ps.stdout.on('data', (d) => { text += d; });
    ps.on('error', () => resolve(out));
    ps.on('close', () => {
      for (const line of text.split(/\r?\n/)) { const m = line.trim().match(/^(\d+) (\d+)$/); if (m) out[Number(m[1])] = `w${m[2]}`; }
      if (out[process.pid]) ownStart = out[process.pid];   // this process's identity, asked once — now known to startTimes()
      resolve(out);
    });
  });
}

/** Is the process with this pid still the one we recorded? true / false / null (cannot tell). */
function same(pid, identity, known = null) {
  if (!identity) return null;
  const now = known ? known[pid] : startTimes([pid])[pid];
  if (now == null) {
    // Gone, or unreadable. Gone is `false` only when the pid does not exist.
    try { process.kill(pid, 0); return null; } catch (e) { return e.code === 'ESRCH' ? false : null; }
  }
  if (now === identity) return true;
  // A SPAWN-CLOCK identity on either side is compared by time, within the tolerance (see THE SPAWN CLOCK).
  if (String(identity)[0] === 's' || String(now)[0] === 's') {
    const a = msOf(identity); const b = msOf(now);
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) <= SPAWN_TOLERANCE_MS;
  }
  return false;
}

let selfIdentity = null;
function lease() {
  if (!selfIdentity) selfIdentity = ownStart || startTimes([process.pid])[process.pid];
  return { pid: process.pid, start: selfIdentity };
}

// ---- the files ----------------------------------------------------------------------

function readFile(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeFile(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, f);
}
function mutate(owner, fn) {
  const f = leaseFile(owner);
  const cur = readFile(f) || { owner, lease: { pid: process.pid, start: selfIdentity }, processes: [] };
  const next = fn(cur) || cur;
  if (!next.processes.length) { try { fs.unlinkSync(f); } catch { /* already gone */ } return next; }
  writeFile(f, next);
  return next;
}

const live = new Map();   // id -> child, for processes this process started

/** RECORD A PROCESS WE STARTED. */
function register(child, { purpose, label = null, owner = defaultOwner(), session = null, project = null, command = null, policy = {}, spawnedAt = null } = {}) {
  try {
    const pid = child && child.pid;
    if (!pid) return null;
    const id = `R${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    // A ChildProcess was spawned a moment ago: on Windows its identity is the spawn clock, no OS call.
    const fresh = process.platform === 'win32' && typeof child.once === 'function';
    const rec = {
      id, pid, start: fresh ? clockIdentity(spawnedAt || child.spawnedAt || Date.now()) : null, owner: String(owner), purpose: String(purpose || 'process'),
      label: label ? String(label).slice(0, 120) : null, session, project,
      command: command ? String(command).slice(0, 300) : null,
      policy: { ...DEFAULT_POLICY, ...policy }, at: Date.now(),
    };
    // RECORDED AT ONCE, IDENTIFIED A MOMENT LATER: reading a start time costs an OS call, and the caller (a terminal opening, a server starting) must not…
    if (fresh && !selfIdentity) selfIdentity = ownStart;
    mutate(owner, (cur) => { cur.lease = cur.lease && cur.lease.start ? cur.lease : { pid: process.pid, start: selfIdentity }; cur.processes = cur.processes.filter((p) => p.pid !== pid).concat(rec); return cur; });
    if (!fresh) startTimesAsync([pid, process.pid]).then((t) => {
      if (!selfIdentity && t[process.pid]) selfIdentity = t[process.pid];
      try {
        mutate(owner, (cur) => {
          cur.lease = { pid: process.pid, start: selfIdentity };
          for (const p of cur.processes) if (p.id === id) p.start = t[pid] || null;
          return cur;
        });
      } catch { /* best effort */ }
    }, () => {});
    if (typeof child.once === 'function') {
      live.set(id, child);
      child.once('exit', () => { live.delete(id); forget(id, owner); });
    }
    return id;
  } catch { return null; }
}

function forget(id, owner = defaultOwner()) {
  try { mutate(owner, (cur) => { cur.processes = cur.processes.filter((p) => p.id !== id); return cur; }); } catch { /* best effort */ }
}

function allLeases() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.map((n) => ({ file: path.join(dir(), n), data: readFile(path.join(dir(), n)) })).filter((x) => x.data && Array.isArray(x.data.processes));
}

/** WHAT IS RUNNING. Every record, with whether it is still the same process (`alive`), whether its owner is alive, and whether it is ours. */
function list({ owner = null, ownerPrefix = null, project = null } = {}) {
  const leases = allLeases().filter((l) => (!owner || l.data.owner === owner) && (!ownerPrefix || String(l.data.owner).startsWith(ownerPrefix)));
  const pids = [];
  for (const l of leases) { if (l.data.lease) pids.push(l.data.lease.pid); for (const p of l.data.processes) pids.push(p.pid); }
  const known = startTimes(pids);
  const me = defaultOwner();
  const out = [];
  for (const l of leases) {
    const ownerAlive = l.data.lease ? same(l.data.lease.pid, l.data.lease.start, known) : null;
    for (const p of l.data.processes) {
      if (project && p.project !== project) continue;
      out.push({ ...p, alive: same(p.pid, p.start, known), ownerAlive, mine: l.data.owner === me });
    }
  }
  return out;
}

function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  }
}

/** STOP ONE RECORDED PROCESS, after proving it is still that process. */
function stop(id, { by = defaultOwner(), explicit = false } = {}) {
  const rec = list().find((r) => r.id === id);
  if (!rec) return { ok: false, why: 'no such process record' };
  if (rec.owner !== by && !explicit) return { ok: false, why: `owned by ${rec.owner}; only its owner stops it automatically` };
  if (rec.alive === false) { forget(id, rec.owner); return { ok: true, already: true }; }
  const child = live.get(id);
  // A CHILD THIS PROCESS STILL HOLDS is ours beyond doubt — Node has not reaped it,
  // so its pid cannot have been reused — even before its start time was recorded.
  if (rec.alive !== true && child && child.exitCode === null && child.signalCode === null && rec.owner === by) {
    killTree(child.pid); live.delete(id); forget(id, rec.owner); return { ok: true, pid: child.pid, via: 'handle' };
  }
  if (rec.alive !== true) return { ok: false, why: 'cannot verify that this pid is still the process LAIN started — not stopping it' };
  killTree(rec.pid);
  if (child) live.delete(id);
  forget(id, rec.owner);
  return { ok: true, pid: rec.pid };
}

/** Stop everything this owner started (its own teardown). */
function stopOwned(owner = defaultOwner()) {
  const mine = list({ owner });
  const res = mine.map((r) => (r.alive === true ? stop(r.id, { by: owner }) : (forget(r.id, owner), { ok: true, already: true })));
  return { stopped: res.filter((r) => r.ok && !r.already).length, records: mine.length };
}

/** REAP WHAT DEAD OWNERS ASKED TO HAVE STOPPED. */
function reapStale({ ownerPrefix = null } = {}) {
  const report = { reaped: [], kept: [], leases: 0 };
  for (const l of allLeases()) {
    if (ownerPrefix && !String(l.data.owner).startsWith(ownerPrefix)) continue;
    if (l.data.owner === defaultOwner()) continue;
    const holder = l.data.lease;
    const known = startTimes([holder && holder.pid, ...l.data.processes.map((p) => p.pid)].filter(Boolean));
    const ownerAlive = holder ? same(holder.pid, holder.start, known) : null;
    if (ownerAlive !== false) continue;           // alive, or cannot tell: not ours to judge
    report.leases++;
    const remaining = [];
    for (const p of l.data.processes) {
      const alive = same(p.pid, p.start, known);
      if (alive === false) continue;               // already gone
      if (alive === true && p.policy && p.policy.onOwnerExit === 'stop') { killTree(p.pid); report.reaped.push({ pid: p.pid, purpose: p.purpose, owner: l.data.owner }); continue; }
      remaining.push(p);
      report.kept.push({ pid: p.pid, purpose: p.purpose, owner: l.data.owner, why: alive === true ? 'its policy keeps it after its owner exits' : 'identity cannot be verified' });
    }
    try { if (remaining.length) writeFile(l.file, { ...l.data, processes: remaining }); else fs.unlinkSync(l.file); } catch { /* best effort */ }
  }
  return report;
}

/** Start a child and register it in one step — the one spawn helper for owned tooling. */
function spawnRegistered(command, args, options = {}, meta = {}) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  child.on('error', () => {});
  register(child, { command: [command, ...(args || [])].join(' '), ...meta });
  return child;
}

module.exports = {
  DEFAULT_POLICY, dir, defaultOwner, startTimes, startTimesAsync, same, lease, register, forget, list, stop, stopOwned, reapStale, spawnRegistered, killTree,
};
