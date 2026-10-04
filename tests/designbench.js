'use strict';

/**
 * THE DESIGN BENCH — the Design surface (lain-harness design/) in a headless Chromium against Core's real
 * /api/design routes, with no native host. The page gets the same deps the Harness entry gives it (api, hostCall,
 * icon, openInIde); the API is a loopback bridge to `routes.dispatch`. Mouse and keyboard are CDP input into this
 * headless page only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const HARNESS = process.env.LAIN_HARNESS_DIR || path.join(__dirname, '..', '..', 'lain-harness');

function harnessDesignDir() {
  const d = path.join(HARNESS, 'design');
  return fs.existsSync(path.join(d, 'design.js')) ? d : null;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name); const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

/** A project copy in a temp dir. */
function project(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-design-fx-'));
  copyDir(path.join(__dirname, 'fixtures', 'design', fixture), dir);
  return dir;
}

/** A minimal Core app for the routes: one real Session on the project. */
function appFor(root) {
  const { Session } = require('../src/session');
  const session = new Session({ cwd: root });
  return { session, cfg: { permissionMode: 'AUTO' }, cwd: root };
}

const PAGE = `<!doctype html><html lang="en" data-mode="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="/design/design.css">
<style>:root{--canvas:#121216;--surface:#1a1a20;--surface-raised:#22222a;--text-primary:#eee;--text-secondary:#bbb;--text-muted:#888;--separator:#2a2a33;--border-subtle:#333;--accent-primary:#9B8AFB;--mono:ui-monospace,monospace}
html,body{height:100%;margin:0;background:#121216;font-family:system-ui,sans-serif} #v{height:100vh}</style></head>
<body><section id="v"></section>
<script>
window.LAIN = {};
window.__api = [];
async function api(p, b) { window.__api.push(p); const r = await fetch('/bridge' + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lain-window': '__SECRET__' }, body: JSON.stringify(b || {}) }); return r.json(); }
</script>
<script src="/design/design.js"></script>
<script>
LAIN.designUI.mount(document.getElementById('v'), {
  api, hostCall: async function (verb) { return verb === 'pickFile' ? { ok: true, path: window.__pick || null } : null; },
  notice: function () {}, toast: function () {},
  icon: function (n) { var s = document.createElement('span'); s.className = 'ic-' + n; s.textContent = n === 'plus' ? '+' : ''; return s; },
  openInIde: function (f, l) { window.__opened = [f, l]; }, status: {} });
LAIN.designUI.show();
</script></body></html>`;

/** Start the bench: { url, page (Headless), app, root, eval, close, ... }. */
async function start({ fixture = 'chat-messenger', root: given = null, width = 1440, height = 900, onBridge = null } = {}) {
  const designDir = harnessDesignDir();
  if (!designDir) throw new Error(`no lain-harness design/ at ${HARNESS}`);
  const root = given || project(fixture);
  // THE WINDOW'S CHANNEL, AS CORE'S IS: only the window holds the secret (the real Harness talks over an authenticated
  // named pipe; no page can reach it). A request without it is counted and refused.
  const secret = require('crypto').randomBytes(16).toString('hex');
  const app = appFor(root);
  const routes = require('../src/harnessapp/routes');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE.replace('__SECRET__', secret)); return; }
    if (url.pathname.startsWith('/design/')) {
      const f = path.join(designDir, path.basename(url.pathname));
      if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(fs.readFileSync(f)); return;
    }
    if (url.pathname.startsWith('/bridge/')) {
      const trusted = req.headers['x-lain-window'] === secret;
      if (onBridge) onBridge({ path: url.pathname, trusted, origin: req.headers.origin || null });
      if (!trusted) { res.writeHead(403); res.end(); return; }
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        let b = {}; try { b = JSON.parse(body || '{}'); } catch { b = {}; }
        const r = await routes.dispatch(app, 'POST', url.pathname.slice('/bridge'.length), b);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { Headless } = require(path.join(require('../src/design').installed().dir, 'src', 'headless.js'));
  const h = await new Headless().launch({ width, height, dpr: 1, mobile: false });
  // EVERY FRAME'S MAIN WORLD, so a test can read what the app's own script saw.
  const contexts = new Map();
  h.handlers.push((m) => { if (m.method === 'Runtime.executionContextCreated') { const c = m.params.context; if (c.auxData && c.auxData.isDefault) contexts.set(c.auxData.frameId, c.id); } });
  await h.goto(url);
  const ev = (expr) => h.page.eval(expr);
  const bench = {
    root, app, url, h, eval: ev,
    async until(expr, ms = 15000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { try { const v = await ev(expr); if (v) return v; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 100)); }
      throw new Error(`timed out waiting for ${expr}`);
    },
    mouse(type, x, y, extra = {}) { return h.page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1, ...extra }); },
    async click(x, y) { await bench.mouse('mouseMoved', x, y); await bench.mouse('mousePressed', x, y); await bench.mouse('mouseReleased', x, y); },
    async drag(x0, y0, x1, y1, steps = 12) {
      await bench.mouse('mouseMoved', x0, y0); await bench.mouse('mousePressed', x0, y0);
      for (let i = 1; i <= steps; i++) await bench.mouse('mouseMoved', Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps), { buttons: 1 });
      await bench.mouse('mouseReleased', x1, y1);
    },
    /** Page coordinates of an element inside a frame (by selector in the frame's document). */
    async inFrame(screen, selector) {
      return ev(`(async () => {
        const f = LAIN.designUI._state.frames.get(${JSON.stringify(screen)}); if (!f) return null;
        const id = await new Promise((res) => { const seq = Math.random(); const on = (e) => { if (e.data && e.data.lainDesign && e.data.type === 'measured' && e.data.seq === seq) { window.removeEventListener('message', on); res(e.data.nodes); } }; window.addEventListener('message', on); f.iframe.contentWindow.postMessage({ lainDesign: 1, type: 'measure', seq }, '*'); });
        return id;
      })()`);
    },
    /** The page rectangle of the iframe's viewport and the canvas zoom. */
    async frameBox(screen) {
      return ev(`(() => { const f = LAIN.designUI._state.frames.get(${JSON.stringify(screen)}); const r = f.iframe.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, zoom: LAIN.designUI._state.zoom }; })()`);
    },
    /** Evaluate in the app's own page inside a canvas frame (its main world). */
    async evalInFrame(screen, expr) {
      const url = await ev(`LAIN.designUI._state.frames.get(${JSON.stringify(screen)}).iframe.src`);
      const tree = await h.page.send('Page.getFrameTree');
      const all = []; (function walk(n) { all.push(n.frame); (n.childFrames || []).forEach(walk); }(tree.frameTree));
      const fr = all.find((f) => f.url.split('#')[0] === url || f.url.startsWith(url));
      if (!fr) throw new Error(`no frame for ${url}`);
      const r = await h.page.send('Runtime.evaluate', { expression: expr, contextId: contexts.get(fr.id), awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    },
    async shot(file) { fs.writeFileSync(file, await h.screenshot()); return file; },
    async close() {
      try { h.close(); } catch { /* gone */ }
      await new Promise((r) => server.close(() => r()));
      try { await require('../src/design').closeAll(); } catch { /* closing */ }
      if (!given) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the browser may hold it */ } }
    },
  };
  return bench;
}

module.exports = { start, project, appFor, harnessDesignDir, copyDir };
