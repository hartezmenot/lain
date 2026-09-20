'use strict';

/**
 * §18–24, §41–46, §72, §74 — capability requests execute for real, the browser
 * router, download/execute permission classes, WebApp auth and routing.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { test, tmpdir } = require('../helpers');
const { Session } = require('../../src/session');

function appWith(answers, extra = {}) {
  const asked = [];
  const session = new Session({ cwd: extra.cwd || tmpdir('cap-') });
  return {
    asked,
    app: {
      session, cfg: { trustedPaths: [{ path: session.cwd, level: 'TRUSTED' }] }, ui: { enabled: false },
      interaction: { ask: async (q) => { asked.push(q); return answers.shift(); } },
      ...extra,
    },
  };
}

module.exports = async function () {
  await test('REQUEST_BROWSER: admission → permission → a REAL inspection → evidence, and a session grant is not asked again', async () => {
    const calls = [];
    const { app, asked } = appWith(['Allow session']);
    app._browserBackends = { isolated: async ({ url }) => { calls.push(url); return { ok: true, url, title: 'Movies', dom: 'main > button "Add"', console: ['TypeError: x is undefined'] }; } };
    const tools = require('../../src/tools');
    const r1 = await tools.execute('request_browser', { reason: 'confirm the add button renders', target: 'example.com/app' }, { app, session: app.session, cwd: app.session.cwd });
    assert.ok(!r1.isError, r1.output);
    assert.match(r1.output, /BROWSER EVIDENCE · isolated/);
    assert.match(r1.output, /title: Movies/);
    assert.match(r1.output, /TypeError/);
    assert.deepStrictEqual(calls, ['https://example.com/app'], 'the backend really ran');
    assert.strictEqual(asked.length, 1);
    assert.match(asked[0].title, /REQUEST · Browser/);
    assert.deepStrictEqual(asked[0].options, ['Allow once', 'Allow session', 'Deny']);
    await tools.execute('request_browser', { reason: 'again', target: 'example.com/app' }, { app, session: app.session, cwd: app.session.cwd });
    assert.strictEqual(asked.length, 1, 'Allow session is not asked twice');
    assert.strictEqual(calls.length, 2);
  });

  await test('REQUEST_BROWSER: Deny is a real result the model can act on — never a silent no-op', async () => {
    const { app } = appWith(['Deny']);
    const r = await require('../../src/tools').execute('request_browser', { reason: 'x', target: 'a.com' }, { app, session: app.session, cwd: app.session.cwd });
    assert.ok(r.isError);
    assert.match(r.output, /DENIED: the person declined browser access/);
  });

  await test('REQUEST_COMPUTER: permission, then the real observation, then evidence', async () => {
    const { app } = appWith(['Allow once']);
    let probed = null;
    app._computerProbe = async ({ target }) => { probed = target; return { ok: true, windows: ['Calculator', 'Notepad'], tree: '{"Display":"42"}' }; };
    app.desktop = () => ({ permissions: { revoke() {} } });
    const r = await require('../../src/tools').execute('request_computer', { reason: 'verify the Calculator state', target: 'Calculator' }, { app, session: app.session, cwd: app.session.cwd });
    assert.ok(!r.isError, r.output);
    assert.strictEqual(probed, 'Calculator');
    assert.match(r.output, /COMPUTER EVIDENCE[\s\S]*Calculator[\s\S]*Display/);
  });

  await test('REQUEST: the tools are offered even with no browser or desktop transport — a request is how access starts', () => {
    const names = require('../../src/tools').schemas(null).map((s) => s.name);
    assert.ok(names.includes('request_browser') && names.includes('request_computer'));
  });

  await test('BROWSER ROUTER: the user\'s Chrome, the frontend dev server, or an isolated browser — chosen by LAIN', () => {
    const r = require('../../src/browserrouter');
    const chromeApp = { _lainChrome: { status: () => ({ connected: true, extensionSeen: true, authorizedTabs: [{ id: 1, url: 'https://mail.example.com', title: 'Mail' }] }) } };
    assert.strictEqual(r.choose(chromeApp, { target: 'current' }).backend, 'chrome');
    const devApp = { _workshop: { status: () => ({ url: 'http://localhost:5173' }) } };
    assert.strictEqual(r.choose(devApp, { target: 'localhost:5173' }).backend, 'workshop');
    assert.strictEqual(r.choose({}, { target: 'https://docs.example.com' }).backend, 'isolated');
  });

  await test('DOWNLOAD: its own permission; allowing it does not allow running it', async () => {
    const root = tmpdir('dl-');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-length': 11, 'content-disposition': 'attachment; filename="tool.exe"' });
      res.end(req.method === 'HEAD' ? undefined : 'hello bytes');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/get`;
    try {
      const { app, asked } = appWith(['Allow once', 'Deny'], { cwd: root });
      const tools = require('../../src/tools');
      const ctx = { app, session: app.session, cwd: root };
      const r = await tools.execute('download_file', { url }, ctx);
      assert.ok(!r.isError, r.output);
      assert.match(asked[0].question, /source\s+http:\/\/127\.0\.0\.1/);
      assert.match(asked[0].question, /filename\s+tool\.exe/);
      assert.match(asked[0].question, /size\s+11 B/);
      assert.match(asked[0].question, /destination\s+downloads/);
      assert.strictEqual(fs.readFileSync(path.join(root, 'downloads', 'tool.exe'), 'utf8'), 'hello bytes');
      const run = await tools.execute('run_bash', { command: 'downloads/tool.exe --version' }, ctx);
      assert.ok(run.denied && /EXECUTE_FILE/.test(run.output), run.output);
      assert.match(asked[1].title, /EXECUTE a downloaded file/);
    } finally { server.close(); }
  });

  await test('CONNECTIVITY: LAN, Tailscale and ZeroTier are told apart from the interfaces alone', () => {
    const c = require('../../src/connectivity');
    const eps = c.endpoints({ port: 7777, interfaces: {
      'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
      'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.1.1', internal: false }],
      Tailscale: [{ family: 'IPv4', address: '100.101.5.9', internal: false }],
      'ZeroTier One [abc]': [{ family: 'IPv4', address: '10.147.17.4', internal: false }],
      Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    } });
    assert.deepStrictEqual(eps.lan, ['http://192.168.1.20:7777']);
    assert.deepStrictEqual(eps.tailscale, ['http://100.101.5.9:7777']);
    assert.deepStrictEqual(eps.zerotier, ['http://10.147.17.4:7777']);
    assert.match(eps.machine, /^[0-9a-f]{16}$/);
  });

  await test('CONNECTIVITY: parallel short probes; LAN preferred when it answers, else last-working, else Tailscale, else ZeroTier, else offline', async () => {
    const c = require('../../src/connectivity');
    const eps = { lan: ['http://lan'], tailscale: ['http://ts'], zerotier: ['http://zt'] };
    const up = (set) => async (u) => set.includes(u);
    assert.strictEqual((await c.resolve(eps, { probe: up(['http://lan', 'http://ts']), lastWorking: 'http://ts' })).route, 'LAN', 'back on Wi-Fi → LAN again');
    assert.strictEqual((await c.resolve(eps, { probe: up(['http://ts', 'http://zt']) })).route, 'Tailscale');
    assert.strictEqual((await c.resolve(eps, { probe: up(['http://zt']) })).route, 'ZeroTier');
    const off = await c.resolve(eps, { probe: up([]) });
    assert.strictEqual(off.route, 'offline');
    assert.strictEqual(c.describe(off), 'OFFLINE · Bot chat only');
    const t0 = Date.now();
    await c.resolve(eps, { probe: (u, signal) => new Promise((r) => signal.addEventListener('abort', () => r(false))), timeoutMs: 200 });
    assert.ok(Date.now() - t0 < 600, 'no long blocking timeout');
  });

  await test('WEBAPP: only verified Telegram initData from an allowed user gets a token; /progress is read-only and token-gated', async () => {
    const w = require('../../src/webapp');
    const botToken = '123:ABC';
    const initFor = (userId, date = Math.floor(Date.now() / 1000)) => {
      const fields = { auth_date: String(date), query_id: 'q', user: JSON.stringify({ id: userId }) };
      const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
      const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
      const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
      return new URLSearchParams({ ...fields, hash }).toString();
    };
    assert.strictEqual(w.verifyInitData(initFor(42), botToken), '42');
    assert.strictEqual(w.verifyInitData(initFor(42).replace('42', '43'), botToken), null, 'tampered');
    assert.strictEqual(w.verifyInitData(initFor(42, 1000), botToken), null, 'stale');
    const srv = await w.start({ port: 0, host: '127.0.0.1', botToken, allowUsers: ['42'], home: tmpdir('webapp-') });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      assert.strictEqual((await fetch(`${base}/progress`)).status, 401, 'no unauthenticated data');
      assert.strictEqual((await fetch(`${base}/auth`, { method: 'POST', body: initFor(7) })).status, 401, 'not an allowed user');
      const a = await fetch(`${base}/auth`, { method: 'POST', body: initFor(42) });
      assert.strictEqual(a.status, 200);
      const { token } = await a.json();
      const p = await fetch(`${base}/progress`, { headers: { authorization: `Bearer ${token}` } });
      assert.strictEqual(p.status, 200);
      const body = await p.json();
      assert.ok(body.pc && Array.isArray(body.sessions) && Array.isArray(body.needsInput));
      for (const m of ['POST', 'PUT', 'DELETE']) assert.notStrictEqual((await fetch(`${base}/progress`, { method: m, headers: { authorization: `Bearer ${token}` } })).status, 200, `no ${m} control`);
    } finally { await srv.close(); }
  });

  await test('WEBAPP: endpoint selection is AUTHENTICATED — the page\'s own probe accepts the real LAIN and refuses an impostor answering {lain:true}', async () => {
    // Audit 2026-09-19: any server answering /ping {lain:true} was chosen and then sent the signed
    // initData — a stale LAN/VPN address held by another device could collect and replay it.
    const w = require('../../src/webapp');
    const http = require('http');
    const srv = await w.start({ port: 0, host: '127.0.0.1', botToken: '123:ABC', allowUsers: ['42'], home: tmpdir('webapp-ep-') });
    const impostor = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ lain: true, proof: 'f'.repeat(64) })); });
    await new Promise((r) => impostor.listen(0, '127.0.0.1', r));
    try {
      const real = `http://127.0.0.1:${srv.port}`;
      const fake = `http://127.0.0.1:${impostor.address().port}`;
      assert.match(srv.launch('https://x/app'), new RegExp(`&k=${srv.pingKey}$`), 'the button URL carries the ping key');
      // …and a person can GET it: it was built nowhere, so the page's endpoint list was always empty.
      assert.match(require('../../src/bot/service').describe({ state: 'running', platforms: [], webapp: { port: srv.port, url: srv.launch('https://x/app') } }), /WebApp button URL: https:\/\/x\/app\?e=.*&k=/);
      // THE PAGE'S OWN CODE, not a re-implementation: K, hex, proven and probe are lifted out of PAGE.
      const src = w.PAGE.match(/const K=[\s\S]*?async function probe[^\n]*\n/)[0];
      const probeWith = (k) => new Function('location', 'window', `${src}; return probe;`)({ search: `?k=${k}` }, { crypto: globalThis.crypto });
      const probe = probeWith(srv.pingKey);
      assert.strictEqual(await probe(real), true, 'the genuine LAIN proves itself');
      assert.strictEqual(await probe(fake), false, 'an impostor answering {lain:true} is refused');
      assert.strictEqual(await probeWith('0'.repeat(64))(real), false, 'a wrong key verifies nothing');
      assert.strictEqual(await probeWith('')(real), false, 'no key (an old button) sends initData nowhere');
      const bare = await (await fetch(`${real}/ping`)).json();
      assert.deepStrictEqual(bare, { lain: true }, 'no nonce, no proof — and the key itself is never served');
    } finally { await srv.close(); impostor.close(); }
  });
};
