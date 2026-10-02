'use strict';

/**
 * LEGACY TEST SUPERVISORS — a one-time diagnostic for the processes that leaked
 * before the runtime registry existed (2026-09-25).
 *
 * Test runs before runtimeregistry.js started `lain-supervisor serve --home
 * <temp home>` and some never stopped them. Nothing recorded who owned them, so
 * nothing may clean them up by rule: a process is never stopped because of its
 * name, its title, a temp-looking path or "it looks like LAIN's".
 *
 * THIS ONLY LOOKS, AND REPORTS EVIDENCE. For each candidate:
 *
 *   pid · start time · command line · temp home · port (from the home's own
 *   endpoint file) · parent (and whether it is alive) · whether current LAIN
 *   state references it (the runtime registry by pid AND start time, the
 *   supervisor endpoint of this LAIN's own home)
 *
 * and a classification:
 *
 *   VERIFIED_ORPHAN  every one of: its home is inside the OS temp folder and is
 *                    not this LAIN's home; nothing in the runtime registry owns
 *                    it; its parent is gone; and its home is gone, or the home's
 *                    endpoint names a different process (another run reused it)
 *   POSSIBLY_ACTIVE  referenced by current state, or its parent is alive, or its
 *                    home is live and still names it
 *   UNKNOWN          anything the evidence does not settle (a home outside temp,
 *                    an unreadable command line)
 *
 * STOPPING IS A SEPARATE, EXPLICIT ACT (`stop`): the person selects ids from a
 * scan; each is re-checked at that moment — same pid, same start time, still
 * VERIFIED_ORPHAN — and only then is that one process tree stopped. Anything
 * else is refused and said why. Future cleanup is the registry's alone.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLASS = Object.freeze({ VERIFIED_ORPHAN: 'VERIFIED_ORPHAN', POSSIBLY_ACTIVE: 'POSSIBLY_ACTIVE', UNKNOWN: 'UNKNOWN' });
const IMAGE = 'lain-supervisor.exe';

function norm(p) {
  if (!p) return '';
  let r = path.resolve(String(p));
  try { r = fs.realpathSync.native(r); } catch { /* gone: compare as written */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
function inside(child, parent) { const rel = path.relative(parent, child); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); }

/** The processes, read once from the OS (Windows: CIM). Never used to decide alone. */
function processes() {
  if (process.platform !== 'win32') {
    const r = spawnSync('ps', ['-eo', 'pid=,ppid=,lstart=,args='], { encoding: 'utf8' });
    return String(r.stdout || '').split('\n').filter((l) => /lain-supervisor/.test(l)).map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(l);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), start: new Date(m[3]).toISOString(), cmd: m[4] } : null;
    }).filter(Boolean);
  }
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${IMAGE}'" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; start = $_.CreationDate.ToUniversalTime().ToString('o'); cmd = $_.CommandLine } } | ConvertTo-Json -Compress`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const out = String(r.stdout || '').trim();
  if (!out) return [];
  let rows = [];
  try { rows = JSON.parse(out); } catch { return []; }
  return (Array.isArray(rows) ? rows : [rows]).map((x) => ({ pid: Number(x.pid), ppid: Number(x.ppid), start: x.start || null, cmd: x.cmd || '' }));
}

function aliveSet() {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | ForEach-Object { $_.Id }'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return new Set(String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number));
}
function alive(pid, set) {
  if (set) return set.has(pid);
  try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); }
}

function homeOf(cmd) {
  const m = /--home\s+("([^"]+)"|(\S+))/.exec(String(cmd || ''));
  return m ? (m[2] || m[3]) : null;
}
function endpointOf(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'supervisor', 'endpoint.json'), 'utf8')); } catch { /* none */ }
  try { return JSON.parse(fs.readFileSync(path.join(home, 'endpoint.json'), 'utf8')); } catch { return null; }
}

/**
 * Scan: every candidate with its evidence and classification. Changes nothing.
 * `facts` replaces what is read from the OS (tests: rows, alive, registered, ownHome, tmp).
 */
function scan(facts = {}) {
  // BOTH SPELLINGS of the temp folder: Windows hands out 8.3 short names
  // (C:\Users\ABCDEF~1\…) that a vanished home can no longer be resolved from.
  const tmpdir = facts.tmp || os.tmpdir();
  const tmps = [...new Set([norm(tmpdir), process.platform === 'win32' ? path.resolve(tmpdir).toLowerCase() : path.resolve(tmpdir)])];
  let ownHome = null;
  try { ownHome = norm(facts.ownHome || require('./supervisor').home()); } catch { ownHome = null; }
  let registered = [];
  try { registered = facts.registered ? facts.registered.map((pid) => ({ pid })) : require('./runtimeregistry').list().filter((p) => p.alive); } catch { registered = []; }
  const regPids = new Set(registered.map((p) => p.pid));
  const live = facts.alive ? new Set(facts.alive) : aliveSet();
  const out = [];
  for (const p of facts.rows || processes()) {
    const home = homeOf(p.cmd);
    const h = home ? norm(home) : '';
    const hRaw = home ? (process.platform === 'win32' ? path.resolve(home).toLowerCase() : path.resolve(home)) : '';
    const homeExists = Boolean(home && fs.existsSync(home));
    const ep = homeExists ? endpointOf(home) : null;
    const epPid = ep && (ep.pid || ep.processId) ? Number(ep.pid || ep.processId) : null;
    const parentAlive = p.ppid ? alive(p.ppid, live) : false;
    const refs = [];
    if (regPids.has(p.pid)) refs.push('runtime registry');
    if (ownHome && h && h === ownHome) refs.push("this LAIN's own supervisor home");
    const tempHome = Boolean(h && tmps.some((t) => inside(h, t) || inside(hRaw, t)));
    let cls;
    const why = [];
    if (!p.cmd) { cls = CLASS.UNKNOWN; why.push('command line not readable'); }
    else if (refs.length) { cls = CLASS.POSSIBLY_ACTIVE; why.push(`referenced by ${refs.join(', ')}`); }
    else if (!tempHome) { cls = CLASS.UNKNOWN; why.push(home ? 'its home is not a temporary test home' : 'no --home on the command line'); }
    else if (parentAlive) { cls = CLASS.POSSIBLY_ACTIVE; why.push(`its parent ${p.ppid} is still running`); }
    else if (homeExists && epPid === p.pid) { cls = CLASS.POSSIBLY_ACTIVE; why.push('its home still exists and names it'); }
    else {
      cls = CLASS.VERIFIED_ORPHAN;
      why.push('temporary test home', 'owned by nothing in the runtime registry', `parent ${p.ppid || '?'} is gone`,
        homeExists ? `its home names ${epPid ? `process ${epPid}` : 'no process'}, not this one` : 'its home no longer exists');
    }
    out.push({
      id: `${p.pid}@${p.start || '?'}`, pid: p.pid, start: p.start, command: p.cmd, home, homeExists, tempHome,
      port: ep && (ep.port || ep.endpoint) ? (ep.port || ep.endpoint) : null, parent: p.ppid || null, parentAlive,
      referencedBy: refs, class: cls, why,
    });
  }
  const counts = {};
  for (const c of out) counts[c.class] = (counts[c.class] || 0) + 1;
  return { at: Date.now(), image: IMAGE, candidates: out, counts };
}

/**
 * STOP THE SELECTED VERIFIED ORPHANS — ids from a scan (`pid@start`). Each is
 * re-scanned now; one that is no longer the same process or no longer a verified
 * orphan is refused. Only that pid's tree is stopped.
 */
function stop(ids = []) {
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (!want.size) return { ok: false, why: 'select the processes to stop' };
  const now = new Map(scan().candidates.map((c) => [c.id, c]));
  const results = [];
  for (const id of want) {
    const c = now.get(id);
    if (!c) { results.push({ id, stopped: false, why: 'no longer running as that process (pid and start time)' }); continue; }
    if (c.class !== CLASS.VERIFIED_ORPHAN) { results.push({ id, stopped: false, why: `now ${c.class}: ${c.why.join('; ')}` }); continue; }
    let r;
    if (process.platform === 'win32') r = spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    else { try { process.kill(c.pid, 'SIGTERM'); r = { status: 0 }; } catch (e) { r = { status: 1, stderr: e.message }; } }
    results.push({ id, pid: c.pid, stopped: r.status === 0, why: r.status === 0 ? '' : String(r.stderr || r.stdout || '').trim().slice(0, 200) });
  }
  return { ok: results.every((x) => x.stopped), results };
}

module.exports = { scan, stop, CLASS, homeOf, IMAGE };
