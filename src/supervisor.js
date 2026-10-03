'use strict';

/** THE CLIENT FOR THE PROCESS THAT OUTLIVES THIS ONE. */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/** A supervisor call is local and should be instant; hanging is the failure. */
const TIMEOUT_MS = 5000;
/** How long to wait for a freshly spawned supervisor to announce its port. */
const START_TIMEOUT_MS = 8000;

function home() {
  if (process.env.LAIN_HOME) return process.env.LAIN_HOME;
  // A run with its OWN home (LAIN_CONFIG_DIR — a test, a bench, a second identity) has its own sessions, so it must never report them to the person's…
  return require('./home').resolve();
}

function stateDir(root = home()) { return path.join(root, 'supervisor'); }
function endpointFile(root = home()) { return path.join(stateDir(root), 'endpoint.json'); }

/** Where the built binary is. */
/** DISCOVERY IS CACHED. */
const BINARY_TTL_MS = 5000;
let binaryMemo = null;
function binary() {
  const now = Date.now();
  const key = process.env.LAIN_SUPERVISOR_BIN || '';
  if (binaryMemo && binaryMemo.key === key && now - binaryMemo.at < BINARY_TTL_MS) return binaryMemo.value;
  const value = findBinary();
  binaryMemo = { key, at: now, value };
  return value;
}

function findBinary() {
  // THE OVERRIDE IS CHECKED LIKE ANY OTHER PATH.
  const forced = process.env.LAIN_SUPERVISOR_BIN;
  if (forced) {
    try { return fs.statSync(forced).isFile() ? forced : null; } catch { return null; }
  }
  // AN INSTALLED LAIN ships the supervisor prebuilt as native/prebuilt/lain-supervisor.exe (distribution/release.js); a development checkout builds…
  const names = process.platform === 'win32' ? ['lain-supervisor.exe', 'noema-supervisor.exe'] : ['lain-supervisor', 'noema-supervisor'];
  for (const exe of names) {
    const shipped = path.join(__dirname, '..', 'native', 'prebuilt', exe);
    try { if (fs.statSync(shipped).isFile()) return shipped; } catch { /* a development checkout */ }
  }
  const root = path.join(__dirname, '..', 'rust', 'lain-supervisor', 'target');
  // THE NEWEST BUILD WINS, not a fixed preference for `release`.
  let best = null;
  for (const p of ['release', 'debug'].flatMap((profile) => names.map((exe) => path.join(root, profile, exe)))) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { path: p, mtimeMs: st.mtimeMs };
    } catch { /* not built in this profile */ }
  }
  return best ? best.path : null;
}

/** Is this process alive? The pid is the truth; the file is a hint. */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** The endpoint a live supervisor is serving on, or null. */
const endpointMemo = new Map();   // file → { mtimeMs, size, value, checkedAt }
const ENDPOINT_STAT_MS = 250;
function endpoint(root = home()) {
  const file = endpointFile(root);
  const now = Date.now();
  const memo = endpointMemo.get(file);
  // Within ENDPOINT_STAT_MS the cached record is trusted as long as its pid lives (signal 0, no file I/O).
  if (memo && now - memo.checkedAt < ENDPOINT_STAT_MS) return memo.value && alive(memo.value.pid) ? memo.value : null;
  let st;
  try { st = fs.statSync(file); } catch { endpointMemo.set(file, { mtimeMs: 0, size: 0, value: null, checkedAt: now }); return null; }
  if (memo && memo.mtimeMs === st.mtimeMs && memo.size === st.size) {
    memo.checkedAt = now;
    return memo.value && alive(memo.value.pid) ? memo.value : null;
  }
  let value = null;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && v.pid && v.port) value = { pid: v.pid, port: v.port, version: v.version || null };
  } catch { value = null; }
  endpointMemo.set(file, { mtimeMs: st.mtimeMs, size: st.size, value, checkedAt: now });
  return value && alive(value.pid) ? value : null;
}

/** Forget cached discovery (tests that start/stop supervisors, and a refused connection). */
function invalidate() { endpointMemo.clear(); binaryMemo = null; }

/** WHAT IS ACTUALLY POSSIBLE RIGHT NOW — one answer, never an exception. */
function probe() {
  const bin = binary();
  const ep = endpoint();
  if (ep) return { available: true, running: true, endpoint: ep, binary: bin, why: '' };
  if (!bin) {
    return {
      available: false, running: false, endpoint: null, binary: null,
      why: 'the supervisor binary is not built — run `cargo build --release` in rust/lain-supervisor',
    };
  }
  return { available: true, running: false, endpoint: null, binary: bin, why: 'no supervisor is running' };
}

/** Send one request and read one reply. */
function send(port, msg, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const sock = net.connect({ port, host: '127.0.0.1' });
    let buf = '';
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* gone */ } done({ ok: false, error: 'supervisor timed out' }); }, timeoutMs);
    sock.on('connect', () => { sock.write(`${JSON.stringify(msg)}\n`); });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      const line = buf.slice(0, nl);
      try { sock.end(); } catch { /* already closing */ }
      let parsed;
      try { parsed = JSON.parse(line); } catch { parsed = { ok: false, error: 'unreadable reply' }; }
      done(parsed);
    });
    sock.on('error', (e) => { clearTimeout(timer); if (e && e.code === 'ECONNREFUSED') invalidate(); done({ ok: false, error: `supervisor unreachable: ${e.message}` }); });
    sock.on('close', () => { clearTimeout(timer); done({ ok: false, error: 'supervisor closed the connection' }); });
  });
}

/** SEVERAL REQUESTS, ONE CONNECTION. */
function sendMany(port, msgs, { timeoutMs = TIMEOUT_MS } = {}) {
  if (!msgs.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    const replies = [];
    let settled = false;
    const done = (fail) => {
      if (settled) return; settled = true;
      while (replies.length < msgs.length) replies.push(fail || { ok: false, error: 'supervisor closed the connection' });
      resolve(replies);
    };
    const sock = net.connect({ port, host: '127.0.0.1' });
    let buf = '';
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* gone */ } done({ ok: false, error: 'supervisor timed out' }); }, timeoutMs);
    sock.on('connect', () => { sock.write(msgs.map((m) => `${JSON.stringify(m)}\n`).join('')); });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try { replies.push(JSON.parse(line)); } catch { replies.push({ ok: false, error: 'unreadable reply' }); }
      }
      if (replies.length >= msgs.length) { clearTimeout(timer); try { sock.end(); } catch { /* closing */ } done(); }
    });
    sock.on('error', (e) => { clearTimeout(timer); if (e && e.code === 'ECONNREFUSED') invalidate(); done({ ok: false, error: `supervisor unreachable: ${e.message}` }); });
    sock.on('close', () => { clearTimeout(timer); done(); });
  });
}

/** Several calls to a supervisor that is already there, over one connection. Never starts one. */
async function callManyIfRunning(msgs, opts = {}) {
  const ep = endpoint();
  if (!ep) return msgs.map(() => ({ ok: false, error: 'no supervisor is running' }));
  return sendMany(ep.port, msgs, opts);
}

/** Make sure one is running, and return the endpoint. */
const starting = new Map();
const owned = new Map();

function ensure(opts = {}) {
  const root = path.resolve(home());
  if (starting.has(root)) return starting.get(root);
  const pending = start(root, opts).finally(() => starting.delete(root));
  starting.set(root, pending);
  return pending;
}

async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  const deadline = Date.now() + 3000;
  while (alive(child.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (alive(child.pid)) throw new Error(`owned supervisor ${child.pid} did not stop`);
}

/** Only processes spawned by this client, never one discovered in another home. */
async function cleanupOwned() {
  await Promise.all([...starting.values()]);
  const results = await Promise.allSettled([...owned.values()].map(stopChild));
  for (const [pid, child] of owned) if (!alive(pid) || child.exitCode !== null) owned.delete(pid);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

async function start(root, { startTimeoutMs = START_TIMEOUT_MS, signal = null } = {}) {
  if (signal && signal.aborted) return { available: true, running: false, why: 'supervisor startup cancelled' };
  const first = probe();
  if (first.running) return first;
  if (!first.available) return first;

  try { fs.mkdirSync(stateDir(root), { recursive: true }); } catch { /* reported by readiness */ }
  let child;
  let spawnError = null;
  try {
    child = spawn(first.binary, ['serve', '--home', root], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, LAIN_HOME: root },
    });
    // A SPAWN FAILURE ARRIVES LATE, AND UNHANDLED IT IS FATAL.
    child.on('error', (e) => { spawnError = e; });
    if (child.pid) {
      owned.set(child.pid, child);
      child.once('exit', () => owned.delete(child.pid));
      // DURABLE OWNERSHIP (runtimeregistry.js): a person's supervisor outlives
      // LAIN on purpose; a test's is stopped when its run ends or dies.
      require('./runtimeregistry').register(child, {
        purpose: 'supervisor', label: `supervisor · ${root}`,
        policy: { onOwnerExit: process.env.LAIN_SUPERVISOR_ON_OWNER_EXIT === 'stop' ? 'stop' : 'keep' },
      });
    }
    child.unref();
  } catch (e) {
    return { available: false, running: false, endpoint: null, binary: first.binary, why: `could not start the supervisor: ${e.message}` };
  }

  // It announces by writing the endpoint file. Poll briefly for it rather than
  // holding a pipe, because holding a pipe is the thing we just avoided.
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError || (signal && signal.aborted)) break;
    const ep = endpoint(root);
    if (ep) {
      const pong = await send(ep.port, { op: 'ping' }, { timeoutMs: Math.max(1, Math.min(500, deadline - Date.now())) });
      // A cancel that landed while the ping was in flight still wins: the
      // caller asked for no supervisor, so the one just started is stopped.
      if (signal && signal.aborted) break;
      if (pong && pong.ok) return { available: true, running: true, endpoint: ep, binary: first.binary, why: '' };
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  await stopChild(child);
  if (signal && signal.aborted) return { available: true, running: false, endpoint: null, why: 'supervisor startup cancelled' };
  return { available: true, running: false, endpoint: null, binary: first.binary, why: 'the supervisor did not announce a port in time' };
}

/** ONE CALL TO A SUPERVISOR THAT IS ALREADY THERE — and never one that is not. */
async function callIfRunning(msg, opts = {}) {
  const ep = endpoint();
  if (!ep) return { ok: false, error: 'no supervisor is running' };
  return send(ep.port, msg, opts);
}

/** One call, with discovery in front of it. Returns the supervisor's reply. */
async function call(msg, opts = {}) {
  const ep = endpoint();
  if (!ep) {
    const started = await ensure(opts);
    if (!started.running) return { ok: false, error: started.why || 'no supervisor' };
    return send(started.endpoint.port, msg, opts);
  }
  return send(ep.port, msg, opts);
}

/** Start work that must outlive this process. */
async function submit({ command, shell = '', cwd = '', session = '', requestId = '', deadlineSecs = 0 }, opts = {}) {
  if (!command) return { ok: false, error: 'submit needs a command' };
  const request_id = requestId || `${session || 'nosession'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  // THE WINDOW BELONGS TO THE JOB. Passed once, at submission, and then owned by
  // the supervisor — no later turn, model or provider can quietly move it.
  const deadline_secs = Math.max(0, Math.floor(Number(deadlineSecs) || 0));
  return call({ op: 'submit', command, shell, cwd, session, request_id, deadline_secs }, opts);
}

/** EXECUTION EVENTS SINCE `after` — what happened while nobody was reasoning. */
async function events({ after = 0, limit = 50 } = {}, opts = {}) {
  return call({ op: 'events', after, limit }, opts);
}

async function status(jobId, opts = {}) { return call({ op: 'status', job_id: jobId }, opts); }
async function cancel(jobId, opts = {}) { return call({ op: 'cancel', job_id: jobId }, opts); }

/** Every job the supervisor knows about, optionally for one session. */
async function list({ session = '' } = {}, opts = {}) { return call({ op: 'list', session }, opts); }

/** Stop the supervisor. Running workers are NOT killed — this process stops. */
async function shutdown(opts = {}) {
  const ep = endpoint();
  if (!ep) return { ok: true, note: 'nothing running' };
  return send(ep.port, { op: 'shutdown' }, opts);
}

/** Test/installer teardown for an explicit home. Verify the wire's PID first. */
async function shutdownIn(root, { timeoutMs = 3000 } = {}) {
  const ep = endpoint(root);
  if (!ep) return;
  const pong = await send(ep.port, { op: 'ping' }, { timeoutMs });
  if (!pong.ok || pong.pid !== ep.pid) throw new Error(`cannot verify supervisor identity in ${root}`);
  await send(ep.port, { op: 'shutdown' }, { timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (alive(ep.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (alive(ep.pid)) throw new Error(`supervisor ${ep.pid} remained after teardown in ${root}`);
}

/** Build the binary. Only ever called deliberately — never on a normal start, because a coding CLI that shells out to a compiler at launch is a coding… */
function build({ release = true } = {}) {
  const dir = path.join(__dirname, '..', 'rust', 'lain-supervisor');
  const args = ['build', '--offline'];
  if (release) args.push('--release');
  const r = spawnSync('cargo', args, { cwd: dir, encoding: 'utf8' });
  return {
    ok: r.status === 0,
    status: r.status,
    output: `${r.stdout || ''}${r.stderr || ''}`.slice(-4000),
  };
}

module.exports = {
  probe, ensure, submit, status, cancel, list, events, shutdown, shutdownIn, build, home,
  call, callIfRunning, callManyIfRunning, sendMany, invalidate,
  endpoint, binary, alive, stateDir, endpointFile, TIMEOUT_MS, cleanupOwned,
};
