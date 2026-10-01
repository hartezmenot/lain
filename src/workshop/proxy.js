'use strict';

/**
 * THE PREVIEW PROXY AND CAPABILITY BROKER (2026-09-30).
 *
 * ------------------------------------------------------------------------
 * REAL FRONTEND, BACKEND DORMANT. The window renders the project's actual
 * frontend in an iframe — natively, not streamed. Between that iframe and the
 * project's dev server sits this proxy, on its own loopback port:
 *
 *     preview iframe ──▶ proxy (127.0.0.1:P) ──▶ dev server (the project's)
 *                          │  ├ documents: + <script src="/__lain/bridge.js">
 *                          │  ├ WebSocket upgrades (HMR) passed straight through
 *                          │  └ CAPABILITY BROKER: requests that belong to a
 *                          │     backend capability are answered by its mode
 *
 * THE CAPABILITIES are the project's backend, named by what they do —
 * playback, authentication, filesystem, database-read, database-write,
 * search-live, scanner, download, sync, network — and mapped to request paths
 * in .lain/preview.json:
 *
 *     "capabilities": {
 *       "playback":      { "match": ["/api/stream/"], "mode": "live", "target": "http://127.0.0.1:7001" },
 *       "database-read": { "match": ["/api/library"], "mode": "adapter", "adapter": ".lain/preview-data" },
 *       "scanner":       { "match": ["/api/scan"],    "mode": "off" }
 *     }
 *
 *   off       answered 503 with a JSON body that says so — the page sees a
 *             dormant backend, never a hang
 *   adapter   answered from preview data in the project (a JSON file per path)
 *   live      forwarded to that capability's real backend — only when turned on
 *
 * A live capability may name the COMMAND that serves it instead of a target
 * ("command": "node server.js"): nothing runs until the first request it claims,
 * which wakes it (capability.js) — the person pressing Play, not the preview opening.
 *
 * A capability's DEFAULT is off (or its adapter, when it has one); turning one
 * on is the person's choice for this preview, and nothing else wakes with it.
 * The MOST SPECIFIC match claims a request (/api/library/scan beats /api/library).
 * Requests no capability claims go to the dev server, which is the frontend.
 *
 * LOOPBACK ONLY, and it forwards to the addresses it was given — never to one a
 * request names. It holds no credentials and adds none.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const CAPABILITIES = Object.freeze(['playback', 'authentication', 'filesystem', 'database-read', 'database-write', 'search-live', 'scanner', 'download', 'sync', 'network']);
const MODES = Object.freeze(['off', 'adapter', 'live']);
const MAX_DOC = 8 * 1024 * 1024;

function readConfig(root) {
  try { return JSON.parse(fs.readFileSync(require('../projectmeta').file(root, 'preview.json'), 'utf8')) || {}; } catch { return {}; }
}

/** The project's capability rules, each normalised: { name, match[], mode, target, adapter }. */
function rulesFor(root, overrides = {}) {
  const cfg = readConfig(root);
  const caps = (cfg && typeof cfg.capabilities === 'object' && cfg.capabilities) || {};
  const out = [];
  for (const name of Object.keys(caps)) {
    const c = caps[name] || {};
    const match = (Array.isArray(c.match) ? c.match : [c.match]).filter((m) => typeof m === 'string' && m.startsWith('/')).slice(0, 20);
    if (!match.length) continue;
    const adapter = typeof c.adapter === 'string' ? path.resolve(root, c.adapter) : null;
    // THE ADAPTER STAYS INSIDE THE PROJECT: a path that climbs out of it is not used.
    const safeAdapter = adapter && (adapter + path.sep).toLowerCase().startsWith((path.resolve(root) + path.sep).toLowerCase()) ? adapter : null;
    let target = null;
    try { const u = new URL(String(c.target || '')); if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) && u.protocol === 'http:') target = u; } catch { target = null; }
    const configured = MODES.includes(c.mode) ? c.mode : (safeAdapter ? 'adapter' : 'off');
    const mode = MODES.includes(overrides[name]) ? overrides[name] : configured;
    // THE COMMAND THAT SERVES IT, when no running target is named: woken on first use (capability.js).
    const command = !target && typeof c.command === 'string' && c.command.trim() ? c.command.trim().slice(0, 400) : null;
    const port = Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : null;
    out.push({ name, known: CAPABILITIES.includes(name), match, mode, configured, target, command, port, adapter: safeAdapter, label: typeof c.label === 'string' ? c.label.slice(0, 80) : null });
  }
  return out;
}

/**
 * The rule whose match is MOST SPECIFIC for this path — never whichever the file happens to list first:
 * a match naming the path exactly beats every prefix, and a longer prefix beats a shorter one
 * (GET /api/v1/favorites is "/api/v1/favorites", not "/api/v1/favorites/" — a different endpoint).
 */
function matchRule(rules, url) {
  const p = String(url || '/').split('?')[0];
  let best = null; let score = -1;
  for (const r of rules) {
    for (const m of r.match) {
      const s = p === m ? 100000 + m.length : (p.startsWith(m.endsWith('/') ? m : `${m}/`) || p === m.replace(/\/$/, '') ? m.length : -1);
      if (s > score) { best = r; score = s; }
    }
  }
  return best;
}

/** A document the iframe navigates to (the only responses the bridge goes into). */
function isDocument(req) {
  const dest = String(req.headers['sec-fetch-dest'] || '');
  if (dest) return dest === 'iframe' || dest === 'document';
  return /text\/html/.test(String(req.headers.accept || '')) && req.method === 'GET';
}

function inject(html) {
  const tag = '<script src="/__lain/bridge.js"></script>';
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  const b = /<html[^>]*>/i.exec(html);
  if (b) return html.slice(0, b.index + b[0].length) + tag + html.slice(b.index + b[0].length);
  return tag + html;
}

class PreviewProxy {
  /**
   * @param {object} o
   * @param {string} o.target  the dev server's own URL (http://127.0.0.1:5173/)
   * @param {string} o.root    the project folder (for .lain/preview.json and adapters)
   * @param {function} [o.waker]  (rule) → Promise<{ok, url, processId, alive()}>: starts a capability's command
   */
  constructor({ target, root, waker = null }) {
    this.target = new URL(target);
    this.root = root;
    this.waker = typeof waker === 'function' ? waker : null;
    this.overrides = {};
    this.server = null;
    this.port = null;
    this.sockets = new Set();
    /** name → the record `waker` returned, while that capability's backend is up; name → the wake in flight. */
    this.awake = new Map();
    this.waking = new Map();
    this.stats = { requests: 0, documents: 0, brokered: {}, last: {}, upgrades: 0, errors: 0, startedAt: null };
  }

  get url() { return this.port ? `http://127.0.0.1:${this.port}${this.target.pathname || '/'}` : null; }

  rules() { return rulesFor(this.root, this.overrides); }

  setMode(name, mode) {
    if (mode !== null && !MODES.includes(mode)) return { ok: false, why: `a capability is ${MODES.join(', ')}` };
    if (!this.rules().some((r) => r.name === name)) return { ok: false, why: `this project maps no "${name}" capability in .lain/preview.json` };
    if (mode === null) delete this.overrides[name]; else this.overrides[name] = mode;
    return { ok: true, capabilities: this.view() };
  }

  /** The woken backend of a capability no longer live — handed to the caller to stop (the proxy owns no process). */
  release(name) {
    const r = this.awake.get(name);
    this.awake.delete(name);
    return r || null;
  }

  view() {
    return this.rules().map((r) => {
      const a = this.awake.get(r.name);
      return {
        name: r.name, mode: r.mode, configured: r.configured, match: r.match, live: Boolean(r.target || r.command), adapter: Boolean(r.adapter), label: r.label,
        wakes: Boolean(r.command), command: r.command, awake: Boolean(a), pid: a ? a.pid || null : null, waking: this.waking.has(r.name),
        served: this.stats.brokered[r.name] || 0, lastPath: this.stats.last[r.name] || null,
      };
    });
  }

  start() {
    if (this.server) return Promise.resolve({ ok: true, port: this.port, url: this.url });
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
      server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
      server.on('error', (e) => resolve({ ok: false, why: `the preview proxy could not listen: ${e.message}` }));
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        this.stats.startedAt = Date.now();
        resolve({ ok: true, port: this.port, url: this.url });
      });
    });
  }

  stop() {
    if (!this.server) return;
    for (const s of this.sockets) { try { s.destroy(); } catch { /* gone */ } }
    try { this.server.close(); } catch { /* closed */ }
    this.server = null;
    this.port = null;
  }

  handle(req, res) {
    this.stats.requests++;
    if (req.url === '/__lain/bridge.js') {
      const body = require('./bridge').script();
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const rule = matchRule(this.rules(), req.url);
    if (rule) return this.broker(rule, req, res);
    this.forward(req, res, this.target, isDocument(req));
  }

  /** A REQUEST THAT BELONGS TO A BACKEND CAPABILITY — answered by that capability's mode, and counted. */
  broker(rule, req, res) {
    this.stats.brokered[rule.name] = (this.stats.brokered[rule.name] || 0) + 1;
    // THE PATH ONLY: a query may carry the page's own token.
    this.stats.last[rule.name] = String(req.url || '/').split('?')[0].slice(0, 200);
    if (rule.mode === 'live' && rule.target) return this.forward(req, res, rule.target, false, `live:${rule.name}`);
    if (rule.mode === 'live' && rule.command) return this.wakeThen(rule, req, res);
    if (rule.mode === 'adapter' && rule.adapter) {
      const rel = String(req.url || '/').split('?')[0].replace(/^\/+/, '').replace(/[^A-Za-z0-9._/-]/g, '_');
      const candidates = [path.join(rule.adapter, `${rel}.json`), path.join(rule.adapter, rel, 'index.json'), path.join(rule.adapter, rel)];
      for (const f of candidates) {
        const full = path.resolve(f);
        if (!(full + path.sep).toLowerCase().startsWith((rule.adapter + path.sep).toLowerCase()) && full.toLowerCase() !== rule.adapter.toLowerCase()) continue;
        try {
          if (fs.statSync(full).isFile()) {
            const body = fs.readFileSync(full);
            res.writeHead(200, { 'content-type': /\.json$/i.test(full) ? 'application/json; charset=utf-8' : 'application/octet-stream', 'x-lain-preview': `adapter:${rule.name}`, 'content-length': body.length });
            res.end(body);
            return;
          }
        } catch { /* next candidate */ }
      }
      const body = JSON.stringify({ lainPreview: true, capability: rule.name, mode: 'adapter', error: 'no preview data for this request', path: req.url });
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-lain-preview': `adapter:${rule.name}`, 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const body = JSON.stringify({ lainPreview: true, capability: rule.name, mode: 'off', error: `${rule.name} is dormant in this preview — turn it on in the Preview's backend strip to use it` });
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'x-lain-preview': `off:${rule.name}`, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  /** A LIVE CAPABILITY THAT WAKES ON FIRST USE: the first request starts its backend (once, shared), then all are forwarded. */
  async wakeThen(rule, req, res) {
    let rec = this.awake.get(rule.name);
    if (rec && typeof rec.alive === 'function' && !rec.alive()) { this.awake.delete(rule.name); rec = null; }
    if (!rec) {
      if (!this.waking.has(rule.name)) {
        const w = Promise.resolve()
          .then(() => (this.waker ? this.waker(rule) : { ok: false, why: 'nothing here can start a capability backend' }))
          .then((r) => { if (r && r.ok && this.server) this.awake.set(rule.name, r); return r; }, (e) => ({ ok: false, why: (e && e.message) || String(e) }))
          .finally(() => this.waking.delete(rule.name));
        this.waking.set(rule.name, w);
      }
      rec = await this.waking.get(rule.name);
    }
    if (!rec || !rec.ok) {
      const body = JSON.stringify({ lainPreview: true, capability: rule.name, mode: 'live', error: `${rule.name} could not wake: ${(rec && rec.why) || 'no answer'}` });
      if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'x-lain-preview': `wake-failed:${rule.name}`, 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    this.forward(req, res, new URL(rec.url), false, `live:${rule.name}`);
  }

  /** `served` labels a capability's live answer (x-lain-preview: live:playback), as the broker's own answers are. */
  forward(req, res, target, doc, served = null) {
    const headers = { ...req.headers, host: target.host };
    // A DOCUMENT IS READ WHOLE, uncompressed, so the bridge can go in; everything else streams untouched.
    if (doc) headers['accept-encoding'] = 'identity';
    const up = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: req.url, headers }, (r) => {
      const h = { ...r.headers };
      if (served) h['x-lain-preview'] = served;
      // REDIRECTS STAY IN THE PREVIEW: a Location on the dev server's own origin is rewritten to this proxy.
      if (h.location && this.port) { try { const loc = new URL(h.location, target); if (loc.host === target.host) h.location = `http://127.0.0.1:${this.port}${loc.pathname}${loc.search}${loc.hash}`; } catch { /* left as sent */ } }
      const html = doc && /text\/html/i.test(String(h['content-type'] || '')) && !h['content-encoding'];
      if (!html) { res.writeHead(r.statusCode || 502, h); r.pipe(res); return; }
      const chunks = []; let size = 0; let over = false;
      r.on('data', (c) => { size += c.length; if (size > MAX_DOC) { over = true; } else chunks.push(c); });
      r.on('end', () => {
        this.stats.documents++;
        if (over) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('the page is larger than the preview reads'); return; }
        const out = inject(Buffer.concat(chunks).toString('utf8'));
        delete h['content-length']; delete h['transfer-encoding'];
        // A PAGE THAT FORBIDS FRAMING is the project's own choice for production; in its own preview it is shown.
        delete h['x-frame-options'];
        if (h['content-security-policy']) h['content-security-policy'] = String(h['content-security-policy']).replace(/frame-ancestors[^;]*;?/gi, '');
        res.writeHead(r.statusCode || 200, { ...h, 'content-length': Buffer.byteLength(out) });
        res.end(out);
      });
      r.on('error', () => { this.stats.errors++; try { res.destroy(); } catch { /* gone */ } });
    });
    up.on('error', (e) => {
      this.stats.errors++;
      if (res.headersSent) { try { res.destroy(); } catch { /* gone */ } return; }
      const body = `The preview's dev server did not answer (${e.code || e.message}).`;
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
    req.pipe(up);
  }

  /** WEBSOCKETS (the dev server's hot reload): the upgrade is replayed to the dev server and the two sockets joined. */
  upgrade(req, socket, head) {
    this.stats.upgrades++;
    const rule = matchRule(this.rules(), req.url);
    const woke = rule && rule.mode === 'live' && !rule.target ? this.awake.get(rule.name) : null;
    const target = rule && rule.mode === 'live' && rule.target ? rule.target : (woke ? new URL(woke.url) : (rule ? null : this.target));
    if (!target) { socket.destroy(); return; }
    const up = net.connect(Number(target.port || 80), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]; const v = req.rawHeaders[i + 1];
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? target.host : v}`);
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    // THE UPSTREAM SOCKET IS OURS TOO: tracked so close() ends it, and either side closing ends the other — an
    // orphaned dev-server connection would otherwise outlive the Preview (and keep this process alive).
    this.sockets.add(up);
    const end = () => { try { socket.destroy(); } catch { /* gone */ } try { up.destroy(); } catch { /* gone */ } };
    up.on('error', end); socket.on('error', end);
    up.on('close', () => { this.sockets.delete(up); end(); }); socket.on('close', end);
  }
}

module.exports = { PreviewProxy, rulesFor, matchRule, inject, isDocument, CAPABILITIES, MODES };
