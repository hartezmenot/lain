'use strict';

/** A STATIC PREVIEW SERVER for a project that is plain files (Phase 8.2) — an index.html and no package.json. */

const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || process.cwd());
const port = Number(process.env.PORT) || 0;
/** MOUNTS (Gate 4): "/url/path" → a file (or, for a key ending in "/", a folder) inside the project, resolved by devserver.detect. */
let mounts = {};
try { mounts = JSON.parse(process.env.LAIN_STATIC_MOUNT || '{}') || {}; } catch { mounts = {}; }

function mounted(rel) {
  if (Object.prototype.hasOwnProperty.call(mounts, rel)) return path.resolve(mounts[rel]);
  for (const k of Object.keys(mounts)) {
    if (!k.endsWith('/') || !rel.startsWith(k)) continue;
    const base = path.resolve(mounts[k]);
    const full = path.resolve(base, `.${rel.slice(k.length - 1)}`);
    return full === base || full.startsWith(base + path.sep) ? full : false;
  }
  return null;
}
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(String(req.url || '/').split('?')[0].split('#')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const m = mounted(rel);
  if (m === false) { res.writeHead(403); res.end('outside the mount'); return; }
  const file = m || path.resolve(root, `.${rel}`);
  if (!m && file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end('outside the project'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`  Local:   http://127.0.0.1:${server.address().port}/\n`);
});
