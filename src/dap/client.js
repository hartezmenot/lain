'use strict';

/**
 * ONE DEBUG ADAPTER, SPOKEN TO OVER THE DEBUG ADAPTER PROTOCOL.
 *
 * Content-Length framed JSON over stdio — the same transport as LSP, with the
 * DAP message shapes: `request` (seq, command, arguments) → `response`
 * (request_seq, success, body | message), and `event` (event, body). Nothing
 * here knows a language; the manager (manager.js) decides which adapter runs.
 *
 * A DYING ADAPTER NEVER TAKES LAIN WITH IT: a broken pipe is reported through
 * `onExit`, pending requests are rejected, and nothing throws out of an event.
 */

const { spawn } = require('child_process');

const REQUEST_TIMEOUT_MS = 20_000;

class DapClient {
  constructor({ id, command, args = [], cwd, env = process.env, onEvent = null, onExit = null, onLog = null, onReverse = null }) {
    this.id = id;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.onEvent = onEvent;
    this.onExit = onExit;
    this.onLog = onLog;
    this.onReverse = onReverse;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.child = null;
    this.exited = false;
    this.capabilities = {};
  }

  start() {
    const shim = require('../lsp/client').nodeShim(this.command);
    const cmd = shim ? process.execPath : this.command;
    const args = shim ? [shim, ...this.args] : this.args;
    this.child = spawn(cmd, args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.on('error', (e) => { this.exited = true; this._failAll(e); if (this.onExit) this.onExit({ error: e.message }); });
    this.child.on('exit', (code, signal) => { this.exited = true; this._failAll(new Error(`${this.id} adapter exited (${code == null ? signal : code})`)); if (this.onExit) this.onExit({ code, signal }); });
    this.child.stdin.on('error', (e) => { if (this.onLog) this.onLog(`stdin: ${e.message}`); });
    this.child.stdout.on('error', () => { /* the exit handler reports it */ });
    this.child.stdout.on('data', (d) => this._read(d));
    this.child.stderr.on('data', (d) => { if (this.onLog) this.onLog(String(d)); });
    return this.child;
  }

  _failAll(e) { for (const [, p] of this.pending) p.reject(e); this.pending.clear(); }

  _read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const head = this.buffer.indexOf('\r\n\r\n');
      if (head < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buffer.slice(0, head).toString('ascii'));
      if (!m) { this.buffer = this.buffer.slice(head + 4); continue; }
      const len = Number(m[1]);
      if (this.buffer.length < head + 4 + len) return;
      const body = this.buffer.slice(head + 4, head + 4 + len).toString('utf8');
      this.buffer = this.buffer.slice(head + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      try { this._dispatch(msg); } catch (e) { if (this.onLog) this.onLog(`dispatch: ${e.message}`); }
    }
  }

  _dispatch(msg) {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body || {});
      else p.reject(Object.assign(new Error(msg.message || (msg.body && msg.body.error && msg.body.error.format) || `${p.command} failed`), { dap: true }));
      return;
    }
    if (msg.type === 'event') { if (this.onEvent) this.onEvent(msg.event, msg.body || {}); return; }
    // REVERSE REQUESTS (runInTerminal, startDebugging): answered, never left hanging.
    if (msg.type === 'request') {
      const answer = this.onReverse ? this.onReverse(msg.command, msg.arguments || {}) : null;
      this._write({ seq: ++this.seq, type: 'response', request_seq: msg.seq, command: msg.command, success: Boolean(answer && answer.success), message: answer && answer.message, body: (answer && answer.body) || {} });
    }
  }

  _write(obj) {
    if (!this.child || this.exited || !this.child.stdin || this.child.stdin.destroyed) return;
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request(command, args = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.exited) return Promise.reject(new Error(`${this.id} adapter is not running`));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(seq); reject(Object.assign(new Error(`${this.id} did not answer ${command} in ${Math.round(timeoutMs / 1000)}s`), { code: 'DAP_TIMEOUT' })); }, timeoutMs);
      this.pending.set(seq, { command, resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this._write({ seq, type: 'request', command, arguments: args });
    });
  }

  async initialize() {
    this.capabilities = await this.request('initialize', {
      clientID: 'lain', clientName: 'Noema', adapterID: this.id, locale: 'en',
      linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path',
      supportsVariableType: true, supportsVariablePaging: false, supportsRunInTerminalRequest: false,
      supportsProgressReporting: false, supportsInvalidatedEvent: false, supportsMemoryReferences: false,
    });
    return this.capabilities || {};
  }

  kill() { try { if (this.child && !this.exited) this.child.kill(); } catch { /* gone */ } }
}

module.exports = { DapClient, REQUEST_TIMEOUT_MS };
