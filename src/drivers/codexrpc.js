'use strict';

/**
 * ONE `codex app-server`, spoken to over stdio — newline-delimited JSON-RPC
 * (`{id, method, params}` → `{id, result|error}`; notifications have no id).
 *
 * ONE PROCESS PER ACCOUNT INSTANCE, started with that instance's CODEX_HOME and
 * nothing else changed. There is one Codex binary on the machine; eight
 * accounts are eight processes of it with eight homes, not eight installs.
 *
 * SPAWNED WITHOUT A SHELL, so the PID we hold is Codex's own and `close()`
 * stops exactly the process this client started — never one found by name.
 * (A `shell: true` spawn leaves the real child behind when the shell dies.)
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

/** Where the one Codex binary is: config, then PATH. `.exe` first on Windows. */
function resolveBinary(configured) {
  if (configured && configured.command) return { command: configured.command, args: configured.args || [] };
  if (typeof configured === 'string' && configured) return { command: configured, args: [] };
  const exts = process.platform === 'win32' ? ['.exe', '.cmd'] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, `codex${ext}`);
      try { if (fs.statSync(p).isFile()) return ext === '.cmd' ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', p], viaCmd: true } : { command: p, args: [] }; } catch { /* next */ }
    }
  }
  return null;
}

class CodexRpc extends EventEmitter {
  constructor({ binary, home, extraEnv = {}, clientName = 'lain', version = '1' } = {}) {
    super();
    this.binary = binary; this.home = home; this.extraEnv = extraEnv; this.clientName = clientName; this.version = version;
    this.child = null; this.pending = new Map(); this.nextId = 1; this.buf = ''; this.ready = null; this.closed = false;
    this.stderr = '';
  }
  start() {
    if (this.ready) return this.ready;
    if (!this.binary) return (this.ready = Promise.reject(new Error('Codex is not installed (no codex on PATH)')));
    const env = { ...process.env, ...this.extraEnv, CODEX_HOME: this.home };
    this.child = spawn(this.binary.command, [...(this.binary.args || []), 'app-server'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pid = this.child.pid;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.child.stdin.on('error', () => { /* the process went away; pending requests fail below */ });
    this.child.on('exit', (code) => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error(`codex app-server exited (${code})`)); }
      this.pending.clear();
      this.emit('exit', code);
    });
    this.child.on('error', (e) => { this.closed = true; this.emit('exit', -1); for (const { reject } of this.pending.values()) reject(e); this.pending.clear(); });
    this.ready = this.request('initialize', { clientInfo: { name: this.clientName, version: this.version } }, 20000)
      .then((r) => { this.notify('initialized'); this.info = r; return r; });
    return this.ready;
  }
  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(Object.assign(new Error(String(m.error.message || 'codex error')), { code: m.error.code })); else p.resolve(m.result);
      } else if (m.method && m.id !== undefined) {
        // A server REQUEST (approval, user input). This client answers none of
        // them yet; refusing is honest and keeps the server from waiting.
        this.write({ id: m.id, error: { code: -32601, message: 'not handled by LAIN account client' } });
      } else if (m.method) {
        this.emit('notification', m.method, m.params || {});
        this.emit(m.method, m.params || {});
      }
    }
  }
  write(m) { if (this.child && !this.closed) { try { this.child.stdin.write(`${JSON.stringify(m)}\n`); } catch { /* exited */ } } }
  notify(method, params) { this.write(params === undefined ? { method } : { method, params }); }
  request(method, params = {}, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new Error('codex app-server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`codex ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  async call(method, params, timeoutMs) { await this.start(); return this.request(method, params, timeoutMs); }
  /** Stop the process THIS client started — by the handle, never by name. */
  async close() {
    if (!this.child || this.closed) { this.closed = true; return; }
    const child = this.child;
    const gone = new Promise((r) => child.once('exit', r));
    try { child.stdin.end(); } catch { /* already closed */ }
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 1500);
    await require('../deadline').race(gone, 4000);
    clearTimeout(t);
    this.closed = true;
  }
}

module.exports = { CodexRpc, resolveBinary };
