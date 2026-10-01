'use strict';

/**
 * ONE LANGUAGE SERVER, SPOKEN TO OVER THE LANGUAGE SERVER PROTOCOL.
 *
 * JSON-RPC 2.0 over stdio with Content-Length framing — the transport every
 * server speaks — and nothing language-specific. The manager (manager.js)
 * decides which server a file belongs to; this only talks to one.
 *
 * Positions here are the protocol's: zero-based lines and UTF-16 columns.
 */

const { spawn } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');

const REQUEST_TIMEOUT_MS = 20_000;

function uriOf(p) { return pathToFileURL(p).href; }

/** The script an npm `.cmd` shim runs ("%dp0%\..\pkg\cli.js"), or null. */
function nodeShim(command) {
  if (process.platform !== 'win32' || !/\.cmd$/i.test(String(command))) return null;
  try {
    const text = require('fs').readFileSync(command, 'utf8');
    const m = /"%dp0%\\([^"]+\.(?:c|m)?js)"/i.exec(text);
    if (!m) return null;
    const script = require('path').join(require('path').dirname(command), m[1]);
    return require('fs').existsSync(script) ? script : null;
  } catch { return null; }
}
function pathOf(uri) { try { return fileURLToPath(uri); } catch { return uri; } }

class LspClient {
  constructor({ id, command, args = [], cwd, env = process.env, onDiagnostics = null, onExit = null, onLog = null }) {
    this.id = id;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.onDiagnostics = onDiagnostics;
    this.onExit = onExit;
    this.onLog = onLog;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.capabilities = null;
    this.child = null;
    this.open = new Map();     // uri -> version
    this.exited = false;
  }

  start() {
    // AN NPM SHIM (`node_modules/.bin/x.cmd`) IS A NODE SCRIPT: run the script
    // with this Node, with the arguments as an array — no shell, nothing re-parsed.
    const shim = nodeShim(this.command);
    const cmd = shim ? process.execPath : this.command;
    const args = shim ? [shim, ...this.args] : this.args;
    const shell = !shim && process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.command);
    this.child = spawn(cmd, args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell });
    this.child.on('error', (e) => { this.exited = true; this._failAll(e); if (this.onExit) this.onExit({ error: e.message }); });
    this.child.on('exit', (code, signal) => { this.exited = true; this._failAll(new Error(`${this.id} exited (${code == null ? signal : code})`)); if (this.onExit) this.onExit({ code, signal }); });
    // A SERVER THAT DIES MID-WRITE must not take LAIN with it: a broken pipe on
    // its stdin is the server's failure, reported through `exit`, never thrown.
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
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id != null && (msg.result !== undefined || msg.error) && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'language server error'), { code: msg.error.code }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics' && this.onDiagnostics) {
      this.onDiagnostics(pathOf(msg.params.uri), msg.params.diagnostics || []);
      return;
    }
    if (msg.method === 'window/logMessage' || msg.method === 'window/showMessage') { if (this.onLog) this.onLog(String(msg.params && msg.params.message)); return; }
    // Requests FROM the server that need an answer.
    if (msg.id != null && msg.method) {
      let result = null;
      if (msg.method === 'workspace/configuration') result = (msg.params.items || []).map(() => null);
      else if (msg.method === 'workspace/workspaceFolders') result = [{ uri: uriOf(this.cwd), name: 'workspace' }];
      this._write({ jsonrpc: '2.0', id: msg.id, result });
    }
  }

  _write(obj) {
    if (!this.child || this.exited || !this.child.stdin || this.child.stdin.destroyed) return;
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.exited) return Promise.reject(new Error(`${this.id} is not running`));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`${this.id} did not answer ${method} in ${Math.round(timeoutMs / 1000)}s`), { code: 'LSP_TIMEOUT' })); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this._write({ jsonrpc: '2.0', method, params }); }

  async initialize(root, initializationOptions = undefined) {
    const res = await this.request('initialize', {
      processId: process.pid,
      ...(initializationOptions ? { initializationOptions } : {}),
      rootUri: uriOf(root),
      workspaceFolders: [{ uri: uriOf(root), name: 'workspace' }],
      clientInfo: { name: 'Noema', version: '1' },
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          definition: { linkSupport: false }, declaration: { linkSupport: false }, references: {}, implementation: {},
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] } },
          rename: { prepareSupport: true }, documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          signatureHelp: {}, codeAction: {}, formatting: {}, publishDiagnostics: { relatedInformation: false },
          semanticTokens: { requests: { full: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'] },
        },
        workspace: { workspaceFolders: true, symbol: {}, configuration: true, applyEdit: false, workspaceEdit: { documentChanges: true } },
      },
    }, 60_000);
    this.capabilities = (res && res.capabilities) || {};
    this.notify('initialized', {});
    return this.capabilities;
  }

  didOpen(path, text, languageId) {
    const uri = uriOf(path);
    if (this.open.has(uri)) return this.didChange(path, text);
    this.open.set(uri, 1);
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    return undefined;
  }

  didChange(path, text) {
    const uri = uriOf(path);
    const v = (this.open.get(uri) || 0) + 1;
    this.open.set(uri, v);
    this.notify('textDocument/didChange', { textDocument: { uri, version: v }, contentChanges: [{ text }] });
  }

  didSave(path) { this.notify('textDocument/didSave', { textDocument: { uri: uriOf(path) } }); }

  didClose(path) {
    const uri = uriOf(path);
    if (!this.open.has(uri)) return;
    this.open.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  async shutdown() {
    if (this.exited) return;
    try { await this.request('shutdown', null, 3000); } catch { /* going anyway */ }
    this.notify('exit', null);
    const c = this.child;
    setTimeout(() => { if (c && c.exitCode === null) { try { c.kill(); } catch { /* gone */ } } }, 1500).unref();
  }
}

module.exports = { LspClient, uriOf, pathOf, nodeShim, REQUEST_TIMEOUT_MS };
