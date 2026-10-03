'use strict';

/** A MINIMAL AGENT CLIENT PROTOCOL (ACP) CLIENT — JSON-RPC 2.0 over a child's stdio, newline-delimited. */

const { spawn } = require('child_process');

const PROTOCOL_VERSION = 1;

function open(command, args = [], { env = {}, cwd = process.cwd(), purpose = 'runtime:acp', label = null, onText = null, onStderr = null } = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let reg = null;
  try { reg = require('../runtimeregistry').register(child, { purpose, label: label || command, command: `${command} ${args.join(' ')}`.trim() }); } catch { /* unregistered */ }
  let nextId = 1; let closed = false; let buf = '';
  const pending = new Map();
  const handlers = new Map();
  let stderr = '';
  const send = (obj) => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`); } catch { /* closed */ } };

  function onLine(line) {
    let m; try { m = JSON.parse(line); } catch { if (onText) onText(line); return; }
    if (!m || typeof m !== 'object') return;
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) { const e = new Error(String(m.error.message || 'the server refused')); e.code = m.error.code; e.data = m.error.data; p.reject(e); } else p.resolve(m.result);
      return;
    }
    if (m.method) {
      const h = handlers.get(m.method);
      if (m.id !== undefined) {
        // A REQUEST FROM THE SERVER: LAIN grants nothing.
        if (m.method === 'session/request_permission') { send({ id: m.id, result: { outcome: { outcome: 'cancelled' } } }); return; }
        send({ id: m.id, error: { code: -32601, message: 'not supported by this client' } });
        return;
      }
      if (h) h(m.params || {});
    }
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, '').trim(); buf = buf.slice(i + 1); if (l) onLine(l); } });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-6000); if (onStderr) onStderr(String(d)); });
  child.stdin.on('error', () => { /* it exited */ });
  const done = new Promise((resolve) => child.on('close', (code) => {
    closed = true;
    for (const p of pending.values()) { clearTimeout(p.timer); const e = new Error(`the server ended (${code === null ? 'stopped' : `code ${code}`})${stderr.trim() ? `: ${require('../redact').text(stderr).trim().split('\n').pop()}` : ''}`); e.ended = true; p.reject(e); }
    pending.clear();
    resolve(code);
  }));
  child.on('error', (e) => { stderr += `\n${e.message}`; });

  function request(method, params = {}, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      if (closed) { reject(new Error('the server is not running')); return; }
      const id = nextId++;
      const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`${method} timed out`), { timedOut: true })); }, timeoutMs) : null;
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  const on = (method, fn) => { handlers.set(method, fn); };
  const notify = (method, params = {}) => send({ method, params });
  function close() {
    if (closed) return;
    try { child.stdin.end(); } catch { /* gone */ }
    try { if (reg) require('../runtimeregistry').stop(reg); else child.kill(); } catch { try { child.kill(); } catch { /* gone */ } }
  }
  return { child, pid: child.pid, request, on, notify, close, done, get closed() { return closed; }, stderr: () => stderr };
}

/** initialize → { authMethods, agentCapabilities }. */
function initialize(client, opts) { return client.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'lain', title: 'LAIN', version: '1' } }, opts); }

module.exports = { open, initialize, PROTOCOL_VERSION };
