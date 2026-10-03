'use strict';

/**
 * THE FRAME PREVIEW'S PROXY AND CAPABILITY BROKER (workshop/proxy.js) and its bridge (workshop/bridge.js).
 * A fake dev server on loopback; nothing leaves the machine.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const vm = require('vm');
const { test } = require('../helpers');

function devServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' }); res.end('<!doctype html><html><head><title>App</title></head><body><h1>Hi</h1></body></html>'); return; }
      if (req.url === '/redirect') { res.writeHead(302, { location: `http://127.0.0.1:${s.address().port}/` }); res.end(); return; }
      if (req.url.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ from: 'dev', url: req.url })); return; }
      res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('console.log(1)');
    });
    s.on('upgrade', (req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); socket.on('data', (d) => socket.write(d)); });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c).toString('utf8') })); }).on('error', reject);
  });
}

module.exports = async function () {
  await test('PREVIEW PROXY: documents get the bridge, framing is allowed, the rest streams untouched', async () => {
    const dev = await devServer();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-pp-'));
    const { PreviewProxy } = require('../../src/workshop/proxy');
    const p = new PreviewProxy({ target: `http://127.0.0.1:${dev.address().port}/`, root });
    try {
      const up = await p.start();
      assert.ok(up.ok && up.port, 'the proxy listens on loopback');
      const doc = await get(up.port, '/', { 'sec-fetch-dest': 'iframe', accept: 'text/html' });
      assert.strictEqual(doc.status, 200);
      assert.match(doc.body, /<head><script src="\/__lain\/bridge\.js"><\/script><title>App/, 'the bridge goes first in <head>');
      assert.ok(!doc.headers['x-frame-options'], 'the page may be framed in its own preview');
      const js = await get(up.port, '/main.js', { 'sec-fetch-dest': 'script' });
      assert.strictEqual(js.body, 'console.log(1)', 'a script is passed through untouched');
      const br = await get(up.port, '/__lain/bridge.js');
      assert.strictEqual(br.status, 200);
      new vm.Script(br.body);
      assert.match(br.body, /var DESCRIBE = function/, 'the bridge carries the Workshop\'s own element reader');
      const rd = await get(up.port, '/redirect');
      assert.strictEqual(rd.headers.location, `http://127.0.0.1:${up.port}/`, 'a redirect on the dev server stays in the preview');
      const api = await get(up.port, '/api/series');
      assert.strictEqual(JSON.parse(api.body).from, 'dev', 'no capability claims it: the dev server answers');
    } finally { p.stop(); dev.close(); }
  });

  await test('PREVIEW PROXY: the capability broker — off by default, adapter data, turned live only when asked', async () => {
    const dev = await devServer();
    const live = await devServer();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-pp-'));
    fs.mkdirSync(path.join(root, '.lain', 'preview-data', 'api'), { recursive: true });
    fs.writeFileSync(path.join(root, '.lain', 'preview-data', 'api', 'library.json'), JSON.stringify({ items: [{ id: 1, title: 'Fixture' }] }));
    fs.writeFileSync(path.join(root, '.lain', 'preview.json'), JSON.stringify({ capabilities: {
      scanner: { match: ['/api/scan'] },
      'database-read': { match: ['/api/library'], adapter: '.lain/preview-data' },
      playback: { match: ['/api/stream/'], mode: 'off', target: `http://127.0.0.1:${live.address().port}` },
      escape: { match: ['/api/x'], adapter: '../../etc' },
    } }));
    const { PreviewProxy } = require('../../src/workshop/proxy');
    const p = new PreviewProxy({ target: `http://127.0.0.1:${dev.address().port}/`, root });
    try {
      const up = await p.start();
      const off = await get(up.port, '/api/scan/run');
      assert.strictEqual(off.status, 503, 'a capability with no mode is dormant');
      assert.strictEqual(JSON.parse(off.body).capability, 'scanner');
      const ad = await get(up.port, '/api/library');
      assert.deepStrictEqual(JSON.parse(ad.body).items[0], { id: 1, title: 'Fixture' }, 'adapter data answers the frontend');
      assert.strictEqual(ad.headers['x-lain-preview'], 'adapter:database-read');
      const pb = await get(up.port, '/api/stream/ep1');
      assert.strictEqual(pb.status, 503, 'playback stays off until the person turns it on');
      assert.ok(p.setMode('playback', 'live').ok);
      const pl = await get(up.port, '/api/stream/ep1');
      assert.strictEqual(JSON.parse(pl.body).from, 'dev', 'live: forwarded to that capability\'s own backend');
      assert.strictEqual(pl.headers['x-lain-preview'], 'live:playback', 'and labelled with who answered');
      assert.strictEqual(p.setMode('nope', 'live').ok, false, 'an unmapped capability cannot be turned on');
      const esc = p.rules().find((r) => r.name === 'escape');
      assert.strictEqual(esc.adapter, null, 'an adapter folder outside the project is never used');
      assert.strictEqual(p.view().find((c) => c.name === 'scanner').served, 1, 'what the broker answered is counted');
    } finally { p.stop(); dev.close(); live.close(); }
  });

  await test('PREVIEW PROXY: WebSocket upgrades (hot reload) pass straight through', async () => {
    const dev = await devServer();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-pp-'));
    const { PreviewProxy } = require('../../src/workshop/proxy');
    const p = new PreviewProxy({ target: `http://127.0.0.1:${dev.address().port}/`, root });
    try {
      const up = await p.start();
      const echoed = await new Promise((resolve, reject) => {
        const s = net.connect(up.port, '127.0.0.1', () => s.write('GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
        let buf = '';
        s.on('data', (d) => { buf += d.toString(); if (/101 Switching/.test(buf) && !buf.includes('ping')) s.write('ping'); if (buf.includes('ping')) { s.destroy(); resolve(buf); } });
        s.on('error', reject);
        setTimeout(() => reject(new Error('no upgrade')), 4000);
      });
      assert.match(echoed, /101 Switching Protocols/);
      assert.match(echoed, /ping/, 'frames flow both ways');
    } finally { p.stop(); dev.close(); }
  });

  await test('PREVIEW PROXY: a live capability with a command WAKES on its first request — once, shared — and nothing else does', async () => {
    const dev = await devServer();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-pp-'));
    fs.mkdirSync(path.join(root, '.lain', 'preview-data', 'api'), { recursive: true });
    fs.writeFileSync(path.join(root, '.lain', 'preview-data', 'api', 'library.json'), JSON.stringify({ items: [] }));
    fs.writeFileSync(path.join(root, '.lain', 'preview.json'), JSON.stringify({ capabilities: {
      'database-read': { match: ['/api/library'], adapter: '.lain/preview-data' },
      scanner: { match: ['/api/library/scan'] },
      playback: { match: ['/api/stream/'], mode: 'live', command: 'node server.js' },
    } }));
    const { PreviewProxy } = require('../../src/workshop/proxy');
    const woken = [];
    let backend = null;
    const waker = async (rule) => { woken.push(rule.name); await new Promise((r) => setTimeout(r, 150)); backend = await devServer(); return { ok: true, url: `http://127.0.0.1:${backend.address().port}/`, processId: 'p-cap', pid: 4242, alive: () => true }; };
    const p = new PreviewProxy({ target: `http://127.0.0.1:${dev.address().port}/`, root, waker });
    try {
      const up = await p.start();
      const before = p.view().find((c) => c.name === 'playback');
      assert.ok(before.wakes && !before.awake, 'named, not started');
      assert.strictEqual((await get(up.port, '/api/library')).headers['x-lain-preview'], 'adapter:database-read', 'the frontend reads preview data');
      assert.strictEqual((await get(up.port, '/api/library/scan/all')).status, 503, 'the MOST SPECIFIC match claims it: the scanner stays off');
      const { matchRule } = require('../../src/workshop/proxy');
      const favs = [{ name: 'read', match: ['/api/v1/favorites'] }, { name: 'write', match: ['/api/v1/favorites/'] }];
      assert.strictEqual(matchRule(favs, '/api/v1/favorites?x=1').name, 'read', 'the rule naming the path exactly wins');
      assert.strictEqual(matchRule(favs, '/api/v1/favorites/42').name, 'write', 'the longer prefix wins below it');
      assert.strictEqual(woken.length, 0, 'loading and browsing wake nothing');
      const [a, b] = await Promise.all([get(up.port, '/api/stream/ep1?token=s3cret'), get(up.port, '/api/stream/ep1/sub')]);
      assert.strictEqual(JSON.parse(a.body).from, 'dev');
      assert.strictEqual(a.headers['x-lain-preview'], 'live:playback');
      assert.strictEqual(JSON.parse(b.body).url, '/api/stream/ep1/sub', 'both requests reach the woken backend');
      assert.deepStrictEqual(woken, ['playback'], 'ONE wake for concurrent first requests');
      const now = p.view().find((c) => c.name === 'playback');
      assert.ok(now.awake && now.pid === 4242, 'the view says it is awake, and which process');
      assert.ok(/^\/api\/stream\/ep1/.test(now.lastPath) && !/s3cret/.test(JSON.stringify(p.view())), 'the path is kept, never the query');
      assert.strictEqual(p.view().find((c) => c.name === 'scanner').awake, false);
      assert.strictEqual(p.release('playback').processId, 'p-cap', 'released for the caller to stop');
      assert.strictEqual(p.view().find((c) => c.name === 'playback').awake, false);
    } finally { p.stop(); if (backend) backend.close(); }

    const q = new PreviewProxy({ target: `http://127.0.0.1:${dev.address().port}/`, root, waker: async () => ({ ok: false, why: 'the port was taken' }) });
    try {
      const up = await q.start();
      const r = await get(up.port, '/api/stream/ep2');
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.headers['x-lain-preview'], 'wake-failed:playback');
      assert.match(JSON.parse(r.body).error, /could not wake: the port was taken/, 'a failed wake says why — never a hang');
    } finally { q.stop(); dev.close(); }
  });

  await test('PREVIEW CAPABILITY: wake starts the command OWNED on loopback; sleep stops it; an exit says so', async () => {
    const { ProcessManager } = require('../../src/harness/processes');
    const cap = require('../../src/workshop/capability');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-cap-'));
    fs.writeFileSync(path.join(root, 'cap.js'), "require('http').createServer((q, s) => s.end(JSON.stringify({ from: 'cap', host: process.env.HOST }))).listen(Number(process.env.PORT), process.env.HOST);\n");
    fs.writeFileSync(path.join(root, 'dies.js'), 'process.exit(3);\n');
    const pm = new ProcessManager();
    try {
      const r = await cap.wake(root, { name: 'playback', command: `"${process.execPath}" cap.js`, port: null }, { processes: pm, timeoutMs: 20000 });
      assert.ok(r.ok, r.why);
      const said = JSON.parse((await get(r.port, '/x')).body);
      assert.deepStrictEqual(said, { from: 'cap', host: '127.0.0.1' }, 'told PORT and HOST=127.0.0.1');
      assert.ok(pm.list().some((x) => x.name === 'cap:playback' && x.alive), 'tracked by the ProcessManager, apart from the dev server');
      await cap.sleep(r, { processes: pm });
      assert.ok(!pm.list().find((x) => x.name === 'cap:playback').alive, 'stopped');
      const bad = await cap.wake(root, { name: 'playback', command: `"${process.execPath}" dies.js`, port: null }, { processes: pm, timeoutMs: 10000 });
      assert.strictEqual(bad.ok, false);
      assert.match(bad.why, /exited/);
      assert.strictEqual((await cap.wake(root, { name: 'x', command: null }, { processes: pm })).ok, false, 'no command, no wake');
    } finally { await pm.cleanup(); }
  });

  await test('PREVIEW STATIC FRONTEND: "static" + "mount" serve the frontend alone, inside the project only', async () => {
    const devserver = require('../../src/workshop/devserver');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-static-'));
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'lib', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(root, '.lain'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
    fs.writeFileSync(path.join(root, 'public', 'index.html'), '<!doctype html><title>Front</title>');
    fs.writeFileSync(path.join(root, 'node_modules', 'lib', 'dist', 'lib.js'), 'window.LIB=1');
    fs.writeFileSync(path.join(root, 'secret.txt'), 'not served');
    fs.writeFileSync(path.join(root, '.lain', 'preview.json'), JSON.stringify({ static: 'public', mount: { '/vendor/lib.js': 'node_modules/lib/dist/lib.js', '/lib/': 'node_modules/lib/', '/escape.js': '../../outside.js' } }));
    const found = devserver.detect(root);
    assert.ok(found.ok && found.static && found.configured, 'the static frontend outranks the start script (the backend)');
    const mounts = JSON.parse(found.env.LAIN_STATIC_MOUNT);
    assert.deepStrictEqual(Object.keys(mounts).sort(), ['/lib/', '/vendor/lib.js'], 'a mount outside the project is dropped');
    const child = require('child_process').spawn(process.execPath, [require.resolve('../../src/workshop/staticserve'), path.join(root, 'public')], { env: { ...process.env, PORT: '0', ...found.env }, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const port = await new Promise((resolve, reject) => { let out = ''; child.stdout.on('data', (d) => { out += d; const m = /127\.0\.0\.1:(\d+)/.exec(out); if (m) resolve(Number(m[1])); }); setTimeout(() => reject(new Error('no port')), 8000); });
      assert.match((await get(port, '/')).body, /<title>Front/);
      assert.strictEqual((await get(port, '/vendor/lib.js')).body, 'window.LIB=1', 'a mounted file');
      assert.strictEqual((await get(port, '/lib/dist/lib.js')).body, 'window.LIB=1', 'a mounted folder');
      assert.strictEqual((await get(port, '/lib/../../secret.txt')).status, 403, 'a mounted folder cannot be climbed out of');
      assert.strictEqual((await get(port, '/../secret.txt')).status, 403, 'nor can the served folder');
    } finally { child.kill(); }
    fs.writeFileSync(path.join(root, '.lain', 'preview.json'), JSON.stringify({ static: '../' }));
    assert.strictEqual(devserver.detect(root).ok, false, 'a static folder outside the project is refused');
  });
};
