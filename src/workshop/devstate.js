'use strict';

/**
 * THE DEV SERVER AS A FIRST-CLASS OBJECT.
 *
 *     devServer { projectRoot, packageManager, script, command, cwd, pid, port,
 *                 status, startedAt, url, lastError, adopted, processId }
 *
 *     STOPPED ──start──► STARTING ──ready──► RUNNING
 *                           │                  │
 *                           └──fails──► FAILED ◄┘ (the process exited)
 *     RUNNING ──restart──► RESTARTING ──► STARTING …
 *
 * ------------------------------------------------------------------------
 * THE STATUS IS NOT INFERRED FROM THE PREVIEW. A preview can fail to load over
 * a healthy server (a 500 from its API proxy) and a preview can be absent over
 * a running one. So the record is moved only by what the process authority
 * reported: the manager started a process, the port answered or the URL was
 * announced, the process exited.
 *
 * ------------------------------------------------------------------------
 * A PREVIEW THAT ANSWERS 500 IS EVIDENCE, NOT A RESTART TRIGGER.
 *
 * `probe` asks the URL once and records the answer as a structured object —
 * the status, the exact request, the server process's state and its recent
 * output — for the window to show. Nothing here restarts on a 500: a server
 * answering 500 is a server that is up and telling you something is wrong
 * behind it, and restarting it in a loop would erase the logs that say what.
 */

const devserver = require('./devserver');

const STATUS = Object.freeze({
  STOPPED: 'STOPPED', STARTING: 'STARTING', RUNNING: 'RUNNING', FAILED: 'FAILED', RESTARTING: 'RESTARTING',
});

const LOG_LINES = 40;

/** A project's dev server before anything has started it: what it would run. */
function blank(root) {
  const key = devserver.canonical(root);
  const d = devserver.detect(key);
  return {
    projectRoot: key,
    cwd: key,
    packageManager: d.packageManager || null,
    script: d.script || null,
    command: d.command || null,
    declaredPort: d.declaredPort || null,
    declaredBy: d.declaredBy || null,
    detectable: Boolean(d.ok),
    why: d.ok ? '' : d.why,
    pid: null,
    processId: null,
    port: null,
    url: null,
    status: STATUS.STOPPED,
    startedAt: null,
    stoppedAt: null,
    adopted: false,
    lastError: null,
    preview: null,
  };
}

class DevServers {
  constructor({ processes = () => null } = {}) {
    this._processes = processes;
    /** project root (resolved) → record */
    this._rec = new Map();
    this._starting = new Map();
  }

  get processes() { return this._processes(); }

  _key(root) { return devserver.canonical(root); }

  _blank(root) { return blank(root); }

  /** The record, reconciled with the process it names. Cheap; launches nothing. */
  get(root) {
    const key = this._key(root);
    let r = this._rec.get(key);
    if (!r) return this._blank(key);
    const pm = this.processes;
    if (r.processId && pm && (r.status === STATUS.RUNNING || r.status === STATUS.STARTING)) {
      const p = pm.list().find((x) => x.processId === r.processId);
      if (p && !p.alive) {
        r.status = STATUS.FAILED;
        r.stoppedAt = r.stoppedAt || Date.now();
        r.lastError = r.lastError || { at: Date.now(), why: `the dev server exited (${p.exitCode == null ? p.status : `exit ${p.exitCode}`})`, log: tail(p) };
      }
      if (p) r.pid = p.commandPid || p.pid || r.pid;
    }
    return { ...r, log: this.log(key) };
  }

  log(root) {
    const r = this._rec.get(this._key(root));
    const pm = this.processes;
    if (!r || !r.processId || !pm) return (r && r.lastError && r.lastError.log) || '';
    const p = pm.list().find((x) => x.processId === r.processId);
    return p ? tail(p) : ((r.lastError && r.lastError.log) || '');
  }

  /** START (or adopt). Concurrent callers share one start. */
  start(root, { taskId = null, timeoutMs = 60_000, restarting = false } = {}) {
    const key = this._key(root);
    const held = this._rec.get(key);
    if (held && held.status === STATUS.RUNNING && !restarting) return Promise.resolve({ ok: true, devServer: this.get(key), reused: true });
    if (this._starting.has(key)) return this._starting.get(key);
    const rec = held && restarting ? held : this._blank(key);
    rec.status = restarting ? STATUS.RESTARTING : STATUS.STARTING;
    rec.lastError = null;
    rec.preview = null;
    rec.startedAt = Date.now();
    this._rec.set(key, rec);
    const work = (async () => {
      rec.status = STATUS.STARTING;
      const r = await devserver.ensure(key, {
        processes: this.processes,
        taskId,
        timeoutMs,
        onStart: (proc, found, port) => {
          rec.processId = proc.processId;
          rec.pid = proc.commandPid || proc.pid || null;
          rec.port = port || null;
          rec.command = found.command;
        },
      });
      if (!r.ok) {
        rec.status = STATUS.FAILED;
        rec.stoppedAt = Date.now();
        rec.lastError = { at: Date.now(), why: r.why, log: r.log || '' };
        return { ok: false, why: r.why, devServer: this.get(key) };
      }
      Object.assign(rec, {
        status: STATUS.RUNNING, url: r.url, port: r.port, processId: r.processId || null,
        pid: r.pid || rec.pid, adopted: Boolean(r.adopted), cwd: r.cwd || key, command: r.command || rec.command,
      });
      return { ok: true, devServer: this.get(key), why: r.why };
    })().finally(() => this._starting.delete(key));
    this._starting.set(key, work);
    return work;
  }

  /** STOP. An adopted server is not ours to stop and is only forgotten. */
  async stop(root) {
    const key = this._key(root);
    const rec = this._rec.get(key);
    if (!rec) return { ok: true, devServer: this.get(key) };
    if (!rec.adopted && rec.processId && this.processes) {
      try { await this.processes.stop(rec.processId); } catch (e) { return { ok: false, why: (e && e.message) || String(e), devServer: this.get(key) }; }
    }
    rec.status = STATUS.STOPPED;
    rec.stoppedAt = Date.now();
    rec.url = null;
    rec.preview = null;
    return { ok: true, devServer: this.get(key) };
  }

  async restart(root, opts = {}) {
    const key = this._key(root);
    const rec = this._rec.get(key);
    if (rec && rec.adopted) return { ok: false, why: 'this dev server was already running when LAIN found it — restart it where it was started', devServer: this.get(key) };
    if (rec) {
      rec.status = STATUS.RESTARTING;
      if (rec.processId && this.processes) { try { await this.processes.stop(rec.processId); } catch { /* the start below reports */ } }
    }
    return this.start(key, { ...opts, restarting: true });
  }

  /**
   * ASK THE URL ONCE and record what it said. A 5xx is structured evidence.
   * Never restarts anything.
   */
  async probe(root, { path: reqPath = '/', timeoutMs = 8000 } = {}) {
    const key = this._key(root);
    const rec = this._rec.get(key);
    if (!rec || !rec.url) return { ok: false, why: 'no dev server URL to request', devServer: this.get(key) };
    const url = new URL(String(reqPath || '/'), rec.url).href;
    const got = await request(url, timeoutMs);
    const current = this.get(key);
    const preview = {
      at: Date.now(),
      ok: Boolean(got.status) && got.status < 500,
      httpStatus: got.status || null,
      error: got.error || null,
      url,
      request: { method: 'GET', url, headers: { accept: 'text/html,*/*' } },
      response: got.status ? { status: got.status, contentType: got.contentType || null, bodyExcerpt: got.body || '' } : null,
      server: { status: current.status, pid: current.pid, port: current.port, processId: current.processId, adopted: current.adopted },
      logs: got.status >= 500 || got.error ? current.log : '',
    };
    rec.preview = preview;
    return { ok: true, preview, devServer: this.get(key) };
  }
}

/** The recent output, as text a window can show — colour codes removed. */
function tail(p) {
  // eslint-disable-next-line no-control-regex -- ANSI escapes are what is being removed
  try { return String(p.tail(LOG_LINES) || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); } catch { return ''; }
}

function request(url, timeoutMs) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { resolve({ error: 'not a URL' }); return; }
    const mod = target.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(target, { method: 'GET', timeout: timeoutMs, headers: { accept: 'text/html,*/*' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 2000) body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, contentType: res.headers['content-type'] || null, body: body.slice(0, 2000) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: `no answer within ${timeoutMs}ms` }); });
    req.on('error', (e) => resolve({ error: (e && e.message) || String(e) }));
    req.end();
  });
}

module.exports = { DevServers, STATUS, request, blank };
