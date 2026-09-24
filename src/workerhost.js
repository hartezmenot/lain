'use strict';

/**
 * THE CLIENT FOR THE WORKER HOST (workerhostmain.js) — the only thing in LAIN
 * that talks to it.
 *
 * Same conventions as supervisor.js, on purpose: one connection per request,
 * every function answers with a STATE and never throws, and nothing on a hot
 * path ever waits for the host to boot. `ensure` starts it DETACHED so a LAIN
 * that exits, or crashes, leaves the model hot for the next one.
 *
 * Where it lives: `LAIN_WORKERHOST_DIR`, else `<LAIN home>/workerhost`. The
 * pipe name is derived from that directory, so two homes never share a host
 * and one home never has two.
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const TIMEOUT_MS = 3000;

function dir() {
  if (process.env.LAIN_WORKERHOST_DIR) return path.resolve(process.env.LAIN_WORKERHOST_DIR);
  return path.join(require('./supervisor').stateDir(), '..', 'workerhost');
}

/** A named pipe on Windows, a unix socket elsewhere — never a TCP port. */
function pipeName(d = dir()) {
  const h = crypto.createHash('sha1').update(path.resolve(d).toLowerCase()).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\lain-workerhost-${h}` : path.join(d, 'host.sock');
}

function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** The live host's record, or null. The pid is the truth; the file is a hint. */
function endpoint(d = dir()) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(d, 'endpoint.json'), 'utf8'));
    return v && v.pid && alive(v.pid) ? v : null;
  } catch { return null; }
}

/** One request, one reply. `{ok:false, error}` when nothing answers — never an exception. */
function send(msg, { timeoutMs = TIMEOUT_MS, d = dir() } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const sock = net.connect(pipeName(d));
    let buf = '';
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* gone */ } done({ ok: false, error: 'worker host timed out' }); }, timeoutMs);
    if (timer.unref) timer.unref();
    sock.on('connect', () => sock.write(JSON.stringify({ client: process.pid, ...msg }) + '\n'));
    sock.on('data', (x) => {
      buf += x.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let v; try { v = JSON.parse(buf.slice(0, nl)); } catch { v = { ok: false, error: 'unreadable reply' }; }
      try { sock.end(); } catch { /* closing */ }
      done(v);
    });
    sock.on('error', (e) => done({ ok: false, error: `worker host unreachable: ${e.code || e.message}` }));
    sock.on('close', () => done({ ok: false, error: 'worker host closed the connection' }));
  });
}

/**
 * MAKE SURE A HOST IS RUNNING. Returns at once with a promise for readiness —
 * a caller on the hot path never awaits it. Concurrent starts in one process
 * share one promise; concurrent starts across processes are settled by the
 * pipe itself (the second host cannot listen and exits).
 */
const starting = new Map();
function ensure({ d = dir(), startTimeoutMs = 8000 } = {}) {
  if (starting.has(d)) return starting.get(d);
  const p = (async () => {
    const first = await send({ op: 'ping' }, { d, timeoutMs: 800 });
    if (first.ok) return { running: true, pid: first.pid, started: false };
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* reported below */ }
    let child;
    try {
      child = spawn(process.execPath, [require.resolve('./workerhostmain'), '--dir', d], {
        detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, LAIN_WORKERHOST_DIR: d },
      });
      child.on('error', () => { /* reported by the readiness poll */ });
      child.unref();
    } catch (e) { return { running: false, why: `could not start the worker host: ${e.message}` }; }
    const until = Date.now() + startTimeoutMs;
    while (Date.now() < until) {
      const pong = await send({ op: 'ping' }, { d, timeoutMs: 500 });
      if (pong.ok) return { running: true, pid: pong.pid, started: true };
      await new Promise((r) => setTimeout(r, 60));
    }
    return { running: false, why: 'the worker host did not answer in time' };
  })().finally(() => starting.delete(d));
  starting.set(d, p);
  return p;
}

/** Start a worker's load in the host; resolves when the host has ACCEPTED it, not when it is hot. */
async function load(id, spec, opts = {}) {
  const up = await ensure();
  if (!up.running) return { ok: false, state: 'UNAVAILABLE', why: up.why };
  return send({ op: 'load', id, spec, ...opts });
}

/** Block until a worker is hot. For benchmarks and diagnostics — never from a turn. */
function wait(id, timeoutMs = 10 * 60 * 1000) { return send({ op: 'wait', id, timeoutMs }, { timeoutMs: timeoutMs + 5000 }); }

/**
 * ONE BOUNDED REQUEST to a worker. The host applies the availability rule
 * (`availableWithinMs`) and the request's own timeout; this adds a little
 * slack for the pipe so the host's answer, not ours, decides.
 */
function call(id, req, { timeoutMs = 20000, availableWithinMs = 0 } = {}) {
  return send({ op: 'call', id, req, timeoutMs, availableWithinMs }, { timeoutMs: timeoutMs + availableWithinMs + 2000 });
}

function status({ measure = false } = {}) { return send({ op: 'status', measure }, { timeoutMs: measure ? 30000 : TIMEOUT_MS }); }
function unload(id, why = 'requested') { return send({ op: 'unload', id, why }); }
function shutdown(why = 'requested') { return send({ op: 'shutdown', why }); }

/** Every start this process has in flight — for teardown, which must not race a host that is still booting. */
function pending() { return Promise.all([...starting.values()]); }

module.exports = { dir, pipeName, endpoint, send, ensure, load, wait, call, status, unload, shutdown, alive, pending };
