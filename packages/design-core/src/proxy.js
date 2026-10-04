'use strict';

/**
 * THE DESIGN PROXY (D9) — the one instrumentation path. Every app Design shows, whatever its framework, is the real
 * running app served through this loopback reverse proxy on its OWN origin: HTTP and the HMR websocket pass through;
 * every HTML response gets the Design runtime (hover, select, measure, the virtual cursor, recording) — and, where a
 * transform is given (plain HTML files), data-lain-id. The app's files and config are never touched.
 *
 * SECURITY: it listens on 127.0.0.1 only and answers only requests whose Host is this loopback origin (a DNS-rebinding
 * page cannot use it); it forwards only to the one target it was started for, on loopback; it serves nothing of Core —
 * no /api, no Design route — only /__lain/runtime.js and /__lain/events (reload pings, no data).
 */

const http = require('http');
const net = require('net');
const zlib = require('zlib');
const runtime = require('./runtime');

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/i;

function hostOk(hostHeader, port) {
  const h = String(hostHeader || '').toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

function decode(buf, enc) {
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch { /* not what it said */ }
  return buf;
}

/** Inject the runtime into an HTML document (before </body>, else </html>, else at the end). */
function inject(html) {
  if (html.includes('data-lain-runtime')) return html;
  const tag = '<script src="/__lain/runtime.js" data-lain-runtime="1"></script>';
  const at = html.lastIndexOf('</body>');
  if (at >= 0) return html.slice(0, at) + tag + html.slice(at);
  const ah = html.lastIndexOf('</html>');
  return ah >= 0 ? html.slice(0, ah) + tag + html.slice(ah) : html + tag;
}

/**
 * Start the proxy for `target` (an http://127.0.0.1|localhost:port URL). `transformHtml(pathname, html)` may rewrite a
 * page before the runtime is injected. Returns { url, port, reload(), close(), stats }.
 */
function start(target, { transformHtml = null, port = 0 } = {}) {
  const t = new URL(target);
  if (!LOOPBACK.test(t.hostname)) return Promise.reject(new Error(`the Design proxy only forwards to this machine (${t.hostname} is not loopback)`));
  const tPort = Number(t.port) || 80;
  const clients = new Set();
  const stats = { requests: 0, refusedHost: 0, html: 0, upgrades: 0 };
  let self = 0;

  const server = http.createServer((req, res) => {
    stats.requests += 1;
    if (!LOOPBACK.test(String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')) || !hostOk(req.headers.host, self)) {
      stats.refusedHost += 1;
      res.writeHead(403, { 'content-type': 'text/plain' }); res.end('LAIN Design preview answers only on this machine\'s loopback address'); return;
    }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__lain/runtime.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); res.end(runtime.source()); return; }
    if (url.pathname === '/__lain/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': lain\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    const headers = { ...req.headers, host: `${t.hostname}:${tPort}`, 'accept-encoding': 'identity' };
    if (headers.origin) headers.origin = `${t.protocol}//${t.hostname}:${tPort}`;
    if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, `${t.protocol}//${t.hostname}:${tPort}`);
    const up = http.request({ host: t.hostname, port: tPort, method: req.method, path: req.url, headers }, (r) => {
      const h = { ...r.headers };
      if (h.location) h.location = String(h.location).replace(new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${tPort}`), `http://127.0.0.1:${self}`);
      const isHtml = /text\/html/i.test(String(h['content-type'] || '')) && req.method === 'GET';
      if (!isHtml) { res.writeHead(r.statusCode, r.statusMessage, h); r.pipe(res); return; }
      const parts = [];
      r.on('data', (d) => parts.push(d));
      r.on('end', () => {
        stats.html += 1;
        let body = decode(Buffer.concat(parts), String(h['content-encoding'] || '')).toString('utf8');
        if (transformHtml) { try { body = transformHtml(url.pathname, body) || body; } catch { /* the page as served */ } }
        body = inject(body);
        delete h['content-encoding']; delete h['content-length']; delete h['transfer-encoding'];
        h['content-length'] = Buffer.byteLength(body);
        h['cache-control'] = 'no-store';
        res.writeHead(r.statusCode, r.statusMessage, h); res.end(body);
      });
    });
    up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`the app at ${target} did not answer: ${e.message}`); } else res.destroy(); });
    req.pipe(up);
  });

  // THE HMR WEBSOCKET (Vite, Next, webpack-dev-server): the upgrade is forwarded byte for byte.
  server.on('upgrade', (req, socket, head) => {
    if (!hostOk(req.headers.host, self)) { stats.refusedHost += 1; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    stats.upgrades += 1;
    const up = net.connect(tPort, t.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]; let v = req.rawHeaders[i + 1];
        if (/^host$/i.test(k)) v = `${t.hostname}:${tPort}`;
        if (/^origin$/i.test(k)) v = `${t.protocol}//${t.hostname}:${tPort}`;
        lines.push(`${k}: ${v}`);
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    const end = () => { try { up.destroy(); } catch { /* gone */ } try { socket.destroy(); } catch { /* gone */ } };
    up.on('error', end); socket.on('error', end); up.on('close', end); socket.on('close', end);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      self = server.address().port;
      resolve({
        url: `http://127.0.0.1:${self}`, port: self, target, stats,
        reload() { for (const c of clients) { try { c.write('data: reload\n\n'); } catch { /* gone */ } } return clients.size; },
        close() { for (const c of clients) { try { c.end(); } catch { /* gone */ } } return new Promise((r) => { server.close(() => r()); server.closeAllConnections && server.closeAllConnections(); }); },
      });
    });
  });
}

module.exports = { start, inject, hostOk, LOOPBACK };
