'use strict';

/**
 * THE DESIGN PREVIEW SERVER for a plain-files web project: the project's files as they are, with every HTML page
 * INSTRUMENTED on the way out (data-lain-id on each element, the Design runtime) — the files on disk are never touched.
 * Loopback only, inside the project only (realpath), and a reload channel the edit engine pings after each commit.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const html = require('./html');
const runtime = require('./runtime');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
};

function inside(root, p) {
  let real;
  try { real = fs.realpathSync(p); } catch { return null; }
  const r = fs.realpathSync(root);
  const a = process.platform === 'win32' ? real.toLowerCase() : real; const b = process.platform === 'win32' ? r.toLowerCase() : r;
  return a === b || a.startsWith(b + path.sep) ? real : null;
}

function start(root, { port = 0, host = '127.0.0.1', raw = false } = {}) {
  const clients = new Set();
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); res.end(); return; }
    if (!raw && url.pathname === '/__lain/runtime.js') { res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' }); res.end(runtime.source()); return; }
    if (!raw && url.pathname === '/__lain/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': lain\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = inside(root, path.join(root, rel));
    if (!file || !fs.statSync(file).isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    if (!raw && (ext === '.html' || ext === '.htm')) {
      const src = fs.readFileSync(file, 'utf8');
      let out;
      try { out = html.instrument(src, path.relative(root, file).replace(/\\/g, '/')); } catch { out = src; }
      res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'no-store' }); res.end(out); return;
    }
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${server.address().port}`;
      resolve({
        url, port: server.address().port,
        /** Every open page reloads (after a commit). */
        reload() { for (const c of clients) { try { c.write('data: reload\n\n'); } catch { /* gone */ } } return clients.size; },
        close() { for (const c of clients) { try { c.end(); } catch { /* gone */ } } return new Promise((r) => server.close(() => r())); },
      });
    });
  });
}

module.exports = { start, inside, MIME };
