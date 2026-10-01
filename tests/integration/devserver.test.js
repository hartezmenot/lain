'use strict';

/**
 * THE PROJECT'S DEV SERVER — REAL PROCESSES, REAL PORTS.
 *
 * Built from a reproduction against a real Vite project (toradb, 2026-09-16):
 *   · Vite ignores PORT and lands wherever it can, announcing the URL — a
 *     start that waited only on the forced port waited forever
 *   · Vite on Node 24 binds `::1`, so IPv4-only probes never saw it
 *   · a failed start left its server running for hours
 *   · an 8.3 short cwd crashed Vite's file watcher (libuv `win/fs-event.c`)
 *   · a Vite `/api` proxy with its backend down answers HTTP 500
 *
 * And the permanent regression the product asked for: THE DEV SERVER RUNS IN
 * THE PROJECT ROOT — never LAIN's folder, Core's cwd or the host's directory.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const devserver = require('../../src/workshop/devserver');
const { DevServers } = require('../../src/workshop/devstate');
const { ProcessManager } = require('../../src/harness/processes');

/** A project whose dev script is a tiny server with a chosen behaviour. */
function project(files) {
  const dir = tmpdir('devsrv-');
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

const SERVER = (mode) => [
  'const http = require("http"); const fs = require("fs");',
  'fs.writeFileSync("cwd.txt", process.cwd());',
  `const mode = ${JSON.stringify(mode)};`,
  'const srv = http.createServer((q, s) => {',
  '  if (mode === "500" && q.url.startsWith("/api")) { console.error("proxy error: ECONNREFUSED " + q.url); s.writeHead(500); return s.end("Internal Server Error"); }',
  '  s.writeHead(200, {"content-type": "text/html"}); s.end("<h1>ok</h1>");',
  '});',
  'if (mode === "announce") { srv.listen(0, "::1", () => console.log("  Local:   http://localhost:" + srv.address().port + "/")); }',
  'else if (mode === "exit") { console.error("boom: cannot start"); process.exit(3); }',
  'else { srv.listen(Number(process.env.PORT), "127.0.0.1"); }',
].join('\n');

function pkg(extra = {}) {
  return JSON.stringify({ name: 'fixture', private: true, scripts: { dev: 'node server.js' }, ...extra });
}

async function withServers(fn) {
  const pm = new ProcessManager({});
  const ds = new DevServers({ processes: () => pm });
  try { return await fn(ds, pm); } finally {
    for (const p of pm.list()) { try { await pm.stop(p.processId); } catch { /* gone */ } }
  }
}

module.exports = async function () {
  await test('DEVSERVER: it runs in the PROJECT ROOT — not Core\'s cwd, not Noema\'s folder', async () => {
    const dir = project({ 'package.json': pkg(), 'server.js': SERVER('port') });
    assert.notStrictEqual(path.resolve(process.cwd()).toLowerCase(), path.resolve(dir).toLowerCase(), 'the test itself runs elsewhere');
    await withServers(async (ds, pm) => {
      const r = await ds.start(dir, { timeoutMs: 30000 });
      assert.strictEqual(r.ok, true, r.why);
      const rec = r.devServer;
      assert.strictEqual(rec.status, 'RUNNING');
      assert.strictEqual(rec.cwd.toLowerCase(), fs.realpathSync.native(dir).toLowerCase());
      const reported = fs.readFileSync(path.join(dir, 'cwd.txt'), 'utf8');
      assert.strictEqual(fs.realpathSync.native(reported).toLowerCase(), fs.realpathSync.native(dir).toLowerCase(), `the process saw its cwd as ${reported}`);
      assert.ok(!reported.toLowerCase().startsWith(path.join(__dirname, '..', '..').toLowerCase()), 'never Noema\'s own folder');
      assert.strictEqual(pm.list()[0].cwd.toLowerCase(), fs.realpathSync.native(dir).toLowerCase(), 'the ProcessManager was given the root');
      assert.ok(rec.pid, 'a PID is recorded');
      assert.strictEqual(rec.command, 'npm run dev');
      assert.strictEqual(rec.packageManager, 'npm');
      const stopped = await ds.stop(dir);
      assert.strictEqual(stopped.devServer.status, 'STOPPED');
      assert.strictEqual(pm.list().filter((p) => p.alive).length, 0);
    });
  });

  await test('DEVSERVER: a short 8.3 path is started as its canonical long form', () => {
    const dir = tmpdir('canon-');
    assert.strictEqual(devserver.canonical(dir), fs.realpathSync.native(dir));
    assert.ok(!/~\d/.test(devserver.canonical(dir)), 'no 8.3 segment survives');
  });

  await test('DEVSERVER: the lockfile names the package manager; the project declares the port', () => {
    const pnpm = project({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }), 'pnpm-lock.yaml': '', 'vite.config.ts': 'export default { server: { port: 5180, proxy: {} } }' });
    const d = devserver.detect(pnpm);
    assert.strictEqual(d.packageManager, 'pnpm');
    assert.strictEqual(d.command, 'pnpm run dev');
    assert.strictEqual(d.declaredPort, 5180);
    assert.strictEqual(d.declaredBy, 'vite.config.ts');
    const concurrently = project({ 'package.json': JSON.stringify({ scripts: { dev: 'concurrently "npm:dev:server" "npm:dev:web"', 'dev:server': 'cross-env PORT=4100 tsx watch server/index.ts', 'dev:web': 'vite' } }), 'vite.config.ts': 'export default defineConfig({ server: { port: 5180 } })' });
    assert.strictEqual(devserver.detect(concurrently).declaredPort, 5180, 'the page\'s port, not the API\'s PORT=4100');
    const yarn = project({ 'package.json': JSON.stringify({ packageManager: 'yarn@4.1.0', scripts: { start: 'next dev -p 3100' } }) });
    const y = devserver.detect(yarn);
    assert.strictEqual(y.command, 'yarn run start');
    assert.strictEqual(y.declaredPort, 3100);
  });

  await test('DEVSERVER: an announced URL on ::1 is found — the Vite shape that ignored PORT', async () => {
    assert.deepStrictEqual(devserver.announced('\x1b[32mVITE\x1b[0m ready\n  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5183\x1b[22m/\x1b[39m\n'), { port: 5183, url: 'http://localhost:5183/' });
    const dir = project({ 'package.json': pkg(), 'server.js': SERVER('announce') });
    await withServers(async (ds) => {
      const r = await ds.start(dir, { timeoutMs: 30000 });
      assert.strictEqual(r.ok, true, r.why);
      assert.match(r.devServer.url, /^http:\/\/localhost:\d+\/$/);
      assert.match(r.why, /announced/);
      const p = await ds.probe(dir);
      assert.strictEqual(p.preview.httpStatus, 200, 'and it answers over IPv6 loopback');
    });
  });

  await test('DEVSERVER: a start that fails is FAILED with its logs — and leaves no process behind', async () => {
    const dir = project({ 'package.json': pkg(), 'server.js': SERVER('exit') });
    await withServers(async (ds, pm) => {
      const r = await ds.start(dir, { timeoutMs: 20000 });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.devServer.status, 'FAILED');
      assert.match(r.devServer.lastError.why, /exited/);
      assert.match(r.devServer.lastError.log, /boom: cannot start/);
      assert.strictEqual(pm.list().filter((p) => p.alive).length, 0, 'nothing leaked');
    });
  });

  await test('DEVSERVER: HTTP 500 is structured evidence — request, server state, logs — and nothing restarts', async () => {
    const dir = project({ 'package.json': pkg(), 'server.js': SERVER('500') });
    await withServers(async (ds, pm) => {
      const r = await ds.start(dir, { timeoutMs: 30000 });
      assert.strictEqual(r.ok, true, r.why);
      const pid = r.devServer.pid;
      const p = await ds.probe(dir, { path: '/api/downloads' });
      assert.strictEqual(p.ok, true, 'a 500 is a result, not an error');
      const pv = p.preview;
      assert.strictEqual(pv.httpStatus, 500);
      assert.strictEqual(pv.ok, false);
      assert.deepStrictEqual(pv.request.method, 'GET');
      assert.match(pv.url, /\/api\/downloads$/);
      assert.strictEqual(pv.server.status, 'RUNNING');
      assert.strictEqual(pv.server.pid, pid);
      assert.match(pv.logs, /proxy error: ECONNREFUSED/, 'the server output that explains it');
      await ds.probe(dir, { path: '/api/downloads' });
      assert.strictEqual(pm.list().length, 1, 'no restart was attempted');
      assert.strictEqual(ds.get(dir).status, 'RUNNING', 'the server that answered 500 is still the one running');
      assert.strictEqual(ds.get(dir).pid, pid);
    });
  });

  await test('DEVSERVER ROUTES: no attached project is refused; start/probe/stop go through the session\'s Workshop', async () => {
    const routes = require('../../src/harnessapp/routes');
    const { App } = require('../../src/app');
    const lain = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: path.join(__dirname, '..', '..') });
    const refused = await routes.dispatch(lain, 'POST', '/api/devserver/start', {});
    assert.strictEqual(refused.code, 409);
    assert.strictEqual(refused.body.projectRequired, true);
    const dir = project({ 'package.json': pkg(), 'server.js': SERVER('500') });
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: dir });
    try {
      const st = await routes.dispatch(app, 'POST', '/api/devserver/start', {});
      assert.strictEqual(st.body.ok, true, st.body.why);
      assert.strictEqual(st.body.devServer.status, 'RUNNING');
      const state = (await routes.dispatch(app, 'GET', '/api/state', {})).body.state;
      assert.strictEqual(state.workshop.devServer.status, 'RUNNING', 'the read model carries the record');
      const pr = await routes.dispatch(app, 'POST', '/api/devserver/probe', { path: '/api/x' });
      assert.strictEqual(pr.body.preview.httpStatus, 500);
      const sp = await routes.dispatch(app, 'POST', '/api/devserver/stop', {});
      assert.strictEqual(sp.body.devServer.status, 'STOPPED');
    } finally {
      await require('../../src/harnesslink').shutdown(app);
    }
  });

  await test('PREVIEW CAPABILITY WAKE (Gate 4, CineFlex): the frontend alone; Play wakes ONLY playback, owned; off stops it; close stops all', async () => {
    const http = require('http');
    const get = (port, p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c).toString('utf8') })); }).on('error', reject));
    const routes = require('../../src/harnessapp/routes');
    const { App } = require('../../src/app');
    // A MONOLITH like CineFlex: `start` runs the whole backend; the frontend is files beside it.
    const dir = project({
      'package.json': JSON.stringify({ name: 'media', private: true, scripts: { start: 'node backend.js' } }),
      'backend.js': "require('http').createServer((q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify({ from: 'backend', url: q.url, host: process.env.HOST })); }).listen(Number(process.env.PORT), process.env.HOST);\n",
    });
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<!doctype html><title>Media</title><h1>Library</h1>');
    fs.mkdirSync(path.join(dir, '.lain', 'preview-data', 'api'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.lain', 'preview-data', 'api', 'library.json'), JSON.stringify({ items: [{ id: 'ep1' }] }));
    fs.writeFileSync(path.join(dir, '.lain', 'preview.json'), JSON.stringify({ static: 'public', capabilities: {
      'database-read': { match: ['/api/library'], adapter: '.lain/preview-data' },
      playback: { match: ['/api/stream/'], mode: 'live', command: `"${process.execPath}" backend.js` },
      scanner: { match: ['/api/scan'] },
    } }));
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: dir });
    const caps = () => require('../../src/harnesslink').harnessFor(app).processes.list().filter((p) => /^cap:/.test(p.name));
    try {
      const st = await routes.dispatch(app, 'POST', '/api/preview/start', {});
      assert.strictEqual(st.body.ok, true, st.body.why);
      const port = st.body.preview.port;
      assert.match((await get(port, '/')).body, /<h1>Library/, 'the frontend is served by Noema; the backend never started');
      assert.strictEqual(JSON.parse((await get(port, '/api/library')).body).items[0].id, 'ep1', 'preview data answers the library');
      assert.strictEqual((await get(port, '/api/scan/all')).status, 503, 'the scanner stays dormant');
      assert.strictEqual(caps().length, 0, 'nothing woke to draw the page');
      const play = await get(port, '/api/stream/ep1?token=t');
      assert.strictEqual(play.headers['x-lain-preview'], 'live:playback');
      assert.deepStrictEqual(JSON.parse(play.body), { from: 'backend', url: '/api/stream/ep1?token=t', host: '127.0.0.1' }, 'Play woke the backend, on loopback');
      assert.strictEqual(caps().filter((p) => p.alive).length, 1, 'exactly one capability process, owned by the ProcessManager');
      const view = (await routes.dispatch(app, 'POST', '/api/preview/state', {})).body.preview.capabilities;
      assert.deepStrictEqual(view.filter((c) => c.awake).map((c) => c.name), ['playback'], 'only playback is awake');
      const off = await routes.dispatch(app, 'POST', '/api/preview/capability', { name: 'playback', mode: 'off' });
      assert.strictEqual(off.body.ok, true);
      for (let i = 0; i < 40 && caps().some((p) => p.alive); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(!caps().some((p) => p.alive), 'turned off: the woken backend is stopped');
      assert.strictEqual((await get(port, '/api/stream/ep1')).status, 503);
      await routes.dispatch(app, 'POST', '/api/preview/capability', { name: 'playback', mode: 'default' });
      assert.strictEqual(JSON.parse((await get(port, '/api/stream/ep2')).body).from, 'backend', 'back to its configured mode: wakes again on use');
      await routes.dispatch(app, 'POST', '/api/preview/stop', {});
      assert.ok(!caps().some((p) => p.alive), 'closing the preview stops what it woke');
    } finally {
      try { await routes.dispatch(app, 'POST', '/api/preview/stop', {}); } catch { /* stopped */ }
      await require('../../src/harnesslink').shutdown(app);
    }
  });
};
