'use strict';

/**
 * A BACKEND CAPABILITY THAT WAKES ON FIRST USE (Gate 4, found by the CineFlex run).
 *
 * The capability broker (proxy.js) could forward a live capability only to a
 * backend already running — so "press Play and only playback wakes" needed the
 * person to start the backend by hand. `.lain/preview.json` may now name the
 * command that serves a live capability:
 *
 *     "playback": { "match": ["/api/stream/"], "mode": "live", "command": "node server.js", "port": 7011 }
 *
 * NOTHING RUNS UNTIL THE PREVIEW ASKS. The first request the capability claims
 * (the person pressing Play) starts that command through the ProcessManager —
 * owned, named `cap:<name>`, tracked apart from the frontend's dev server — the
 * request waits for it (bounded), then is forwarded. It stops with the preview,
 * or when the person turns the capability off. Nothing else wakes with it.
 *
 * LOOPBACK: the process is told PORT and HOST=127.0.0.1, and the port must be
 * served by the process tree LAIN started (portowner) before a request is sent.
 */

const devserver = require('./devserver');

const WAKE_MS = 90_000;

/**
 * Start one capability's backend. Resolves { ok, url, port, processId, pid, alive() } or { ok:false, why, log }.
 * @param {string} root  the project folder (the command's cwd)
 * @param {{name:string, command:string, port:?number}} rule
 */
async function wake(root, rule, { processes = null, taskId = null, timeoutMs = WAKE_MS } = {}) {
  if (!rule || !rule.command) return { ok: false, why: `${rule ? rule.name : 'this capability'} names no command to start` };
  if (!processes) return { ok: false, why: 'no process manager, so a capability backend cannot be owned or stopped' };
  const port = rule.port || await devserver.pickPort();
  if (!port) return { ok: false, why: 'no free loopback port for the capability backend' };
  if (await devserver.listening(port)) return { ok: false, why: `:${port} is already served by another process — LAIN starts a capability backend only on a port it can prove is its own` };
  const proc = processes.start({ taskId, name: `cap:${rule.name}`, command: rule.command, cwd: root, env: { PORT: String(port), HOST: '127.0.0.1' }, port });
  const stop = async () => { try { if (proc.alive) await processes.stop(proc.processId); } catch { /* the manager reports its own failures */ } };
  const tail = () => (typeof proc.tail === 'function' ? proc.tail(40) : '');
  const end = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < end) {
    if (!proc.alive) return { ok: false, why: `${rule.name}'s backend exited: ${proc.healthWhy || `exit code ${proc.exitCode}`}`, log: tail() };
    // eslint-disable-next-line no-await-in-loop -- polling a port a separate process is opening
    const host = await devserver.listening(port);
    if (host) {
      // eslint-disable-next-line no-await-in-loop -- once, when the port first answers
      const own = await require('./portowner').verify(proc.pid || proc.commandPid, port);
      if (own.ok === false) { await stop(); return { ok: false, why: own.why }; }
      proc.port = port;
      return { ok: true, url: `http://${host}:${port}/`, port, processId: proc.processId, pid: proc.commandPid || proc.pid || null, at: Date.now(), alive: () => Boolean(proc.alive) };
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  const log = tail();
  await stop();
  return { ok: false, why: `${rule.name}'s backend (${rule.command}) did not open :${port} within ${Math.round(timeoutMs / 1000)}s`, log };
}

/** Stop a capability backend LAIN woke. Only a record `wake` returned is ever stopped. */
async function sleep(record, { processes = null } = {}) {
  if (!record || !record.processId || !processes) return { ok: true };
  try { await processes.stop(record.processId); return { ok: true }; } catch (e) { return { ok: false, why: (e && e.message) || String(e) }; }
}

module.exports = { wake, sleep, WAKE_MS };
