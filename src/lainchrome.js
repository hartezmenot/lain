'use strict';

/** LAIN FOR CHROME — the local, authenticated bridge to the user's REAL Chrome session. */

const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = 8934;
const POLL_TIMEOUT_MS = 25_000;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2_000_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, body, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // CORS: only ever echoes the ONE origin this session pinned, never `*`.
    ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}),
  });
  res.end(JSON.stringify(body));
}

class LainChrome {
  constructor(app) {
    this.app = app;
    this.server = null;
    this.port = null;
    this.token = null;
    this.pinnedOrigin = null;       // set on the first successful /register
    this.connected = false;
    this.extensionSeen = false;     // has the extension actually registered
    this.authorizedTabs = new Map(); // tabId -> { url, title }, reported by the extension
    this.pendingCommands = [];      // [{id, op, params}]
    this.waitingPolls = [];         // resolve functions for long-polling GETs
    this.inFlight = new Map();      // commandId -> {resolve, reject, timer}
    this._seq = 0;
  }

  /** Everything a Settings surface or `/chrome status` needs, and nothing more. */
  status() {
    return {
      connected: this.connected,
      port: this.port,
      extensionSeen: this.extensionSeen,
      authorizedTabs: [...this.authorizedTabs.entries()].map(([id, t]) => ({ id, ...t })),
    };
  }

  /** Start the bridge and mint a fresh token. Idempotent — a second call restarts it clean. */
  async connect({ port = DEFAULT_PORT } = {}) {
    if (this.connected) await this.disconnect('reconnecting');
    this.token = crypto.randomBytes(24).toString('hex');
    this.pinnedOrigin = null;
    this.extensionSeen = false;
    this.authorizedTabs.clear();
    await new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', reject);
      this.server.listen(port, '127.0.0.1', () => { this.port = this.server.address().port; resolve(); });
    });
    this.connected = true;
    return { ok: true, token: this.token, port: this.port };
  }

  async disconnect(why = 'disconnected') {
    this.connected = false;
    for (const [, p] of this.inFlight) { clearTimeout(p.timer); p.reject(new Error(why)); }
    this.inFlight.clear();
    // Entries are { resolve } (see the poll handler).
    for (const w of this.waitingPolls) (typeof w === 'function' ? w : w.resolve)(null);
    this.waitingPolls = [];
    this.pendingCommands = [];
    this.authorizedTabs.clear();
    this.token = null;
    this.pinnedOrigin = null;
    if (this.server) { await new Promise((r) => this.server.close(r)); this.server = null; }
    return { ok: true };
  }

  _authOk(token, origin) {
    if (!this.connected || !this.token) return false;
    if (token !== this.token) return false;
    if (this.pinnedOrigin && origin && origin !== this.pinnedOrigin) return false;
    return true;
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = req.headers.origin || null;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin || '',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
      });
      return res.end();
    }
    try {
      if (url.pathname === '/lain-chrome/register' && req.method === 'POST') return this._onRegister(req, res, origin);
      if (url.pathname === '/lain-chrome/poll' && req.method === 'GET') return this._onPoll(req, res, url, origin);
      if (url.pathname === '/lain-chrome/result' && req.method === 'POST') return this._onResult(req, res, origin);
      if (url.pathname === '/lain-chrome/tabs' && req.method === 'POST') return this._onTabsReport(req, res, origin);
      if (url.pathname === '/lain-chrome/disconnect' && req.method === 'POST') return this._onExtensionDisconnect(req, res, origin);
      return json(res, 404, { ok: false, error: 'no such endpoint' }, origin);
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message }, origin);
    }
  }

  async _onRegister(req, res, origin) {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!this.connected || body.token !== this.token) return json(res, 401, { ok: false, error: 'bad token' }, origin);
    // PIN THE ORIGIN, ONCE.
    if (this.pinnedOrigin && origin !== this.pinnedOrigin) {
      return json(res, 403, { ok: false, error: 'this token is already bound to a different extension origin' }, origin);
    }
    this.pinnedOrigin = origin || this.pinnedOrigin;
    this.extensionSeen = true;
    return json(res, 200, { ok: true, sessionId: this.token.slice(0, 8) }, origin);
  }

  async _onTabsReport(req, res, origin) {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!this._authOk(body.token, origin)) return json(res, 401, { ok: false, error: 'bad token or origin' }, origin);
    // THE EXTENSION DECIDES WHAT IS AUTHORIZED, never this bridge. This just
    // records what the person has already agreed to expose in the popup.
    this.authorizedTabs.clear();
    for (const t of Array.isArray(body.tabs) ? body.tabs : []) {
      if (t && typeof t.id === 'number') this.authorizedTabs.set(t.id, { url: String(t.url || ''), title: String(t.title || '') });
    }
    return json(res, 200, { ok: true }, origin);
  }

  async _onExtensionDisconnect(req, res, origin) {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!this._authOk(body.token, origin)) return json(res, 401, { ok: false, error: 'bad token or origin' }, origin);
    this.authorizedTabs.clear();
    return json(res, 200, { ok: true }, origin);
  }

  async _onPoll(req, res, url, origin) {
    const token = url.searchParams.get('token');
    if (!this._authOk(token, origin)) return json(res, 401, { ok: false, error: 'bad token or origin' }, origin);
    if (this.pendingCommands.length) {
      const cmd = this.pendingCommands.shift();
      return json(res, 200, { command: cmd }, origin);
    }
    // LONG POLL, bounded — never an open-ended hang, so a dropped extension
    // does not leak a request forever.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.waitingPolls = this.waitingPolls.filter((w) => w.resolve !== resolveFn);
      json(res, 200, { command: null }, origin);
    }, POLL_TIMEOUT_MS);
    const resolveFn = (cmd) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      json(res, 200, { command: cmd }, origin);
    };
    this.waitingPolls.push({ resolve: resolveFn });
  }

  async _onResult(req, res, origin) {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!this._authOk(body.token, origin)) return json(res, 401, { ok: false, error: 'bad token or origin' }, origin);
    const p = this.inFlight.get(body.id);
    if (p) {
      clearTimeout(p.timer);
      this.inFlight.delete(body.id);
      // A CONTENT SCRIPT CANNOT WRITE FILES — a screenshot comes back as a data URL and LAIN (which can) turns it into the same kind of artifact path…
      p.resolve(this._materializeDataUrl(body.result));
    }
    return json(res, 200, { ok: true }, origin);
  }

  _materializeDataUrl(result) {
    if (!result || typeof result.dataUrl !== 'string' || !result.dataUrl.startsWith('data:image/')) return result;
    try {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const b64 = result.dataUrl.slice(result.dataUrl.indexOf(',') + 1);
      const ext = result.dataUrl.slice(11, result.dataUrl.indexOf(';'));
      const file = path.join(os.tmpdir(), `lain-chrome-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      const { dataUrl, ...rest } = result;
      return { ...rest, path: file };
    } catch (e) {
      return { ...result, dataUrlError: e.message };
    }
  }

  /** SEND ONE COMMAND, AND WAIT FOR THE EXTENSION'S ANSWER. */
  request(op, params = {}, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    if (!this.connected) return Promise.resolve({ ok: false, error: 'Chrome bridge is not connected — run /chrome connect' });
    if (!this.extensionSeen) return Promise.resolve({ ok: false, error: 'the extension has not registered yet — open its popup and paste the token' });
    const id = `c${++this._seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.inFlight.delete(id);
        resolve({ ok: false, error: `no answer from the extension within ${timeoutMs}ms — is the tab still open?` });
      }, timeoutMs);
      this.inFlight.set(id, { resolve, reject: () => {}, timer });
      const cmd = { id, op, params };
      const waiter = this.waitingPolls.shift();
      if (waiter) waiter.resolve(cmd);
      else this.pendingCommands.push(cmd);
    });
  }
}

function forApp(app) {
  if (!app) return null;
  if (!app._lainChrome) app._lainChrome = new LainChrome(app);
  return app._lainChrome;
}

function existing(app) { return (app && app._lainChrome) || null; }

module.exports = { LainChrome, forApp, existing, DEFAULT_PORT };
