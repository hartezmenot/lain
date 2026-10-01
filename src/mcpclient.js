'use strict';

/**
 * A MODEL CONTEXT PROTOCOL CLIENT (Phase 8.1) — JSON-RPC 2.0, two transports:
 *
 *   stdio   a local program; one JSON-RPC message per line on stdin/stdout
 *           (MCP's stdio transport). The process is LAIN's: registered with
 *           runtimeregistry (stopped with its owner) and killed on close.
 *   http    Streamable HTTP: each request is a POST whose answer is JSON or an
 *           SSE stream carrying it; the server's Mcp-Session-Id is echoed back.
 *
 *   connect()        initialize → notifications/initialized → list tools,
 *                    resources and prompts the server says it has
 *   call(tool, args) tools/call
 *   close()
 *
 * NOTHING IS INHERITED BY DEFAULT: a stdio server gets PATH/SYSTEMROOT-level
 * basics and the env its configuration names, never LAIN's whole environment
 * (tokens included). Secrets named by reference are resolved here, immediately
 * before the process starts or the request is sent, and never logged.
 */

const { spawn } = require('child_process');

const PROTOCOL_VERSION = '2025-03-26';
const TIMEOUT_MS = 20000;
const BASE_ENV = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'NODE_OPTIONS_UNSET'];

class McpClient {
  /**
   * @param {object} spec { id, transport: 'stdio'|'http', command: [..], cwd, env: {k: v|{ref}}, url, headers: {k: v|{ref}} }
   */
  constructor(spec, { resolve = null } = {}) {
    this.spec = spec;
    this.resolve = resolve || ((ref) => require('./credentials').resolve(ref));
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.buf = '';
    this.sessionId = null;
    this.server = null;
    this.capabilities = {};
    this.tools = []; this.resources = []; this.prompts = [];
    this.state = 'DISCONNECTED';
    this.why = '';
    this.stderr = '';
  }

  value(v) { return v && typeof v === 'object' && v.ref ? (this.resolve(v.ref) || '') : String(v == null ? '' : v); }

  async connect() {
    this.state = 'CONNECTING';
    try {
      if (this.spec.transport === 'http') { if (!/^https?:\/\//i.test(String(this.spec.url || ''))) throw new Error('an HTTP MCP server needs an http(s) URL'); }
      else this.start();
      const init = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Noema', version: '1' } });
      this.server = init && init.serverInfo ? init.serverInfo : null;
      this.capabilities = (init && init.capabilities) || {};
      await this.notify('notifications/initialized', {});
      this.tools = this.capabilities.tools ? ((await this.request('tools/list', {})).tools || []) : [];
      this.resources = this.capabilities.resources ? ((await this.request('resources/list', {}).catch(() => ({ resources: [] }))).resources || []) : [];
      this.prompts = this.capabilities.prompts ? ((await this.request('prompts/list', {}).catch(() => ({ prompts: [] }))).prompts || []) : [];
      this.state = 'CONNECTED'; this.why = '';
      return { ok: true };
    } catch (e) {
      this.state = 'FAILED';
      this.why = String(e.message || e).slice(0, 300) + (this.stderr ? ` — ${this.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200)}` : '');
      this.close();
      this.state = 'FAILED';
      return { ok: false, why: this.why };
    }
  }

  start() {
    const cmd = (this.spec.command || []).map(String);
    if (!cmd.length) throw new Error('a stdio MCP server needs a command');
    const env = {};
    for (const k of BASE_ENV) if (process.env[k] != null) env[k] = process.env[k];
    for (const [k, v] of Object.entries(this.spec.env || {})) env[k] = this.value(v);
    const sh = require('./drivers/cliexec').resolveShim(cmd[0]);
    this.child = spawn(sh.command, [...sh.prefix, ...cmd.slice(1)], { cwd: this.spec.cwd || undefined, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    try { require('./runtimeregistry').register(this.child, { purpose: 'mcp', label: `MCP ${this.spec.id}`, command: cmd[0], policy: { onOwnerExit: 'stop' } }); } catch { /* bookkeeping */ }
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000); });
    this.child.on('error', (e) => this.failAll(e.message));
    this.child.on('exit', (code) => { this.failAll(`the server exited (${code})`); if (this.state === 'CONNECTED') { this.state = 'DISCONNECTED'; this.why = `the server exited (${code})`; } this.child = null; });
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      this.onMessage(m);
    }
  }

  onMessage(m) {
    if (m && m.id != null && this.pending.has(m.id) && (m.result !== undefined || m.error)) {
      const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || 'MCP error')); else p.resolve(m.result);
    } else if (m && m.id != null && m.method) {
      // A request FROM the server (sampling, roots…): LAIN offers none of these; say so politely.
      this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Noema does not offer this to MCP servers' } });
    }
  }

  failAll(why) { for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)); this.pending.delete(id); } }

  write(msg) { if (this.child && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(msg)}\n`); }

  async request(method, params, timeoutMs = TIMEOUT_MS) {
    const id = ++this.seq;
    const msg = { jsonrpc: '2.0', id, method, params };
    if (this.spec.transport === 'http') return this.post(msg, timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: no answer within ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(msg);
    });
  }

  async notify(method, params) {
    const msg = { jsonrpc: '2.0', method, params };
    if (this.spec.transport === 'http') { await this.post(msg, TIMEOUT_MS, true).catch(() => {}); return; }
    this.write(msg);
  }

  async post(msg, timeoutMs, isNotification = false) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    for (const [k, v] of Object.entries(this.spec.headers || {})) headers[k.toLowerCase()] = this.value(v);
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(this.spec.url, { method: 'POST', headers, body: JSON.stringify(msg), signal: ctl.signal });
      const sid = r.headers.get('mcp-session-id'); if (sid) this.sessionId = sid;
      if (isNotification) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const type = r.headers.get('content-type') || '';
      const text = await r.text();
      let m = null;
      if (/event-stream/.test(type)) {
        for (const block of text.split(/\r?\n\r?\n/)) {
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          try { const x = JSON.parse(data); if (x && x.id === msg.id) { m = x; break; } } catch { /* next */ }
        }
      } else m = JSON.parse(text);
      if (!m) throw new Error('the server did not answer this request');
      if (m.error) throw new Error(m.error.message || 'MCP error');
      return m.result;
    } finally { clearTimeout(t); }
  }

  async call(name, args) {
    if (this.state !== 'CONNECTED') throw new Error(`${this.spec.id} is not connected`);
    return this.request('tools/call', { name, arguments: args || {} }, 120000);
  }

  close() {
    this.failAll('closed');
    if (this.child) { try { this.child.stdin.end(); } catch { /* gone */ } try { this.child.kill(); } catch { /* gone */ } this.child = null; }
    if (this.state === 'CONNECTED' || this.state === 'CONNECTING') this.state = 'DISCONNECTED';
  }
}

module.exports = { McpClient, PROTOCOL_VERSION };
