'use strict';

/** THE CHROME DEVTOOLS PROTOCOL TRANSPORT — the wire, and nothing above it. */

const http = require('http');

/** A call that has not answered by now is not going to. */
const CALL_TIMEOUT_MS = 15000;
/** Connecting to a socket that is not there should fail fast. */
const CONNECT_TIMEOUT_MS = 5000;
/** How many protocol events are kept per connection. Bounded, like everything. */
const MAX_EVENTS = 500;

/** IS A CDP CLIENT POSSIBLE ON THIS RUNTIME AT ALL? */
function clientAvailable() {
  if (typeof globalThis.WebSocket !== 'function') {
    return {
      ok: false,
      why: `this Node (${process.version}) has no global WebSocket, and LAIN ships no dependencies — `
        + 'browser observation needs Node 22 or newer',
    };
  }
  return { ok: true, why: '' };
}

/** GET a JSON document from a DevTools HTTP endpoint. Never throws. */
function getJson(url, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let req;
    try {
      req = http.get(url, { timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try { resolve({ ok: true, body: JSON.parse(body) }); } catch { resolve({ ok: false, why: 'the endpoint did not answer with JSON' }); }
        });
      });
    } catch (e) { resolve({ ok: false, why: String((e && e.message) || e) }); return; }
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, why: `no answer in ${timeoutMs}ms` }); });
    req.on('error', (e) => resolve({ ok: false, why: String((e && e.message) || e) }));
  });
}

/** WHAT IS LISTENING ON THIS DEBUG PORT? */
async function endpoint(port = 9222, host = '127.0.0.1') {
  const base = `http://${host}:${port}`;
  const version = await getJson(`${base}/json/version`);
  if (!version.ok) return { ok: false, why: `nothing DevTools-shaped on ${host}:${port} — ${version.why}` };
  const list = await getJson(`${base}/json/list`);
  const targets = list.ok && Array.isArray(list.body) ? list.body : [];
  return {
    ok: true,
    base,
    browser: (version.body && version.body.Browser) || 'unknown',
    protocol: (version.body && version.body['Protocol-Version']) || '',
    browserSocket: (version.body && version.body.webSocketDebuggerUrl) || null,
    targets: targets.filter((t) => t.type === 'page'),
  };
}

/** Ask the endpoint to open a fresh tab, so an existing one is never hijacked. */
async function newTab(base, url = 'about:blank') {
  const r = await getJson(`${base}/json/new?${encodeURIComponent(url)}`);
  if (r.ok && r.body && r.body.webSocketDebuggerUrl) return { ok: true, target: r.body };
  // Newer Chrome requires PUT on /json/new.
  const put = await new Promise((resolve) => {
    const target = new URL(`${base}/json/new?${encodeURIComponent(url)}`);
    const req = http.request(target, { method: 'PUT', timeout: CONNECT_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
  if (put && put.webSocketDebuggerUrl) return { ok: true, target: put };
  return { ok: false, why: r.why || 'the endpoint refused to open a tab' };
}

/** ONE CONNECTION TO ONE TARGET. */
class Connection {
  constructor(socketUrl) {
    this.socketUrl = String(socketUrl);
    this.ws = null;
    this.open = false;
    this.closedWhy = '';
    this._id = 0;
    this._pending = new Map();
    this._handlers = [];
    this.events = [];
  }

  connect(timeoutMs = CONNECT_TIMEOUT_MS) {
    const client = clientAvailable();
    if (!client.ok) return Promise.resolve({ ok: false, why: client.why });
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      let ws;
      try { ws = new globalThis.WebSocket(this.socketUrl); } catch (e) { done({ ok: false, why: String((e && e.message) || e) }); return; }
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* already gone */ }
        done({ ok: false, why: `the debugger socket did not open in ${timeoutMs}ms` });
      }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); this.open = true; done({ ok: true }); });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        this.open = false;
        this.closedWhy = 'the debugger socket errored';
        done({ ok: false, why: this.closedWhy });
      });
      ws.addEventListener('close', () => {
        this.open = false;
        this.closedWhy = this.closedWhy || 'the debugger socket closed';
        // EVERY PENDING CALL IS SETTLED, NOT LEAKED.
        for (const [, p] of this._pending) p.reject(new Error(this.closedWhy));
        this._pending.clear();
      });
      ws.addEventListener('message', (m) => this._receive(m));
    });
  }

  _receive(m) {
    let msg;
    try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
    if (msg.id != null && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'the browser refused the call'));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method) {
      this.events.push({ method: msg.method, params: msg.params || {}, at: Date.now() });
      if (this.events.length > MAX_EVENTS) this.events.shift();
      for (const fn of [...this._handlers]) {
        // A LISTENER THAT THROWS MUST NOT KILL THE CONNECTION, for the same
        // reason an event-bus subscriber may not kill a turn.
        try { fn(msg.method, msg.params || {}, msg.sessionId || null); } catch { /* dropped */ }
      }
    }
  }

  on(fn) {
    if (typeof fn !== 'function') return () => {};
    this._handlers.push(fn);
    return () => {
      const i = this._handlers.indexOf(fn);
      if (i >= 0) this._handlers.splice(i, 1);
    };
  }

  /** Every event of one method since the connection opened. */
  since(method) { return this.events.filter((e) => e.method === method); }

  send(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) { return this.sendTo(null, method, params, timeoutMs); }

  /** A CALL TO AN ATTACHED TARGET (flattened sessions: Target.setAutoAttach { flatten: true }) — an out-of-process frame, such as the Preview's page… */
  sendTo(sessionId, method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    if (!this.open) return Promise.reject(new Error(this.closedWhy || 'the debugger socket is not open'));
    this._id += 1;
    const id = this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method} did not answer in ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify(sessionId ? { id, sessionId, method, params } : { id, method, params })); } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  close(why = 'closed by the harness') {
    this.closedWhy = why;
    try { if (this.ws) this.ws.close(); } catch { /* already gone */ }
    this.open = false;
  }
}

module.exports = { Connection, endpoint, newTab, getJson, clientAvailable, CALL_TIMEOUT_MS, CONNECT_TIMEOUT_MS, MAX_EVENTS };
