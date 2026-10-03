'use strict';

/**
 * THE STANDALONE ACCOUNT PAGE (fabric/standalone.js, §76) — a CLI-only LAIN manages accounts and keys without the
 * Harness and without a secret ever typed into the terminal. Loopback only; a single-use launch door; the key in a
 * fragment and a header, never in a URL a server sees; Host and Origin checked; a fixed allow-list of Core routes.
 * No browser is opened here (LAIN_STANDALONE_NO_BROWSER).
 */

const assert = require('assert');
const http = require('http');
const { test, tmpdir } = require('../helpers');

function req(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString('utf8') }));
    });
    r.on('error', reject);
    if (body != null) r.end(typeof body === 'string' ? body : JSON.stringify(body)); else r.end();
  });
}

module.exports = async function () {
  const sa = require('../../src/fabric/standalone');
  const dl = require('../../src/fabric/dashlaunch');
  const { App } = require('../../src/app');
  const mk = () => new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('sa-') });
  process.env.LAIN_STANDALONE_NO_BROWSER = '1';

  await test('STANDALONE: the launch door is single-use and hands the key over in a fragment only', async () => {
    const app = mk();
    const s = await sa.open(app, { section: 'api' });
    try {
      assert.strictEqual(s.ok, true);
      assert.strictEqual(s.opened, false, 'no browser under test');
      assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/open\/[a-f0-9]{32}$/);
      const path = new URL(s.url).pathname;
      const first = await req(s.port, { path });
      assert.strictEqual(first.code, 303);
      const m = /^\/#k=([a-f0-9]{64})&s=api$/.exec(first.headers.location);
      assert.ok(m, `the key travels in a fragment: ${first.headers.location}`);
      assert.strictEqual(first.headers['cache-control'], 'no-store');
      assert.strictEqual(first.headers['referrer-policy'], 'no-referrer');
      const again = await req(s.port, { path });
      assert.strictEqual(again.code, 410, 'a used door stays shut');
      // THE PAGE: served without the key in it, under a strict CSP.
      const pg = await req(s.port, { path: '/' });
      assert.strictEqual(pg.code, 200);
      assert.ok(!pg.text.includes(m[1]), 'the key is not in the page');
      assert.match(pg.headers['content-security-policy'], /default-src 'none'; script-src 'nonce-[^']+'/);
      assert.match(pg.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.match(pg.text, /history\.replaceState\(null, '', '\/'\)/, 'the page scrubs the fragment at once');
    } finally { sa.stop(); }
  });

  await test('STANDALONE: every call needs the key, this Host and this Origin — and only the allow-listed routes answer', async () => {
    const app = mk();
    const s = await sa.open(app, {});
    try {
      const key = /#k=([a-f0-9]{64})/.exec((await req(s.port, { path: new URL(s.url).pathname })).headers.location)[1];
      const post = (path, headers = {}, body = {}) => req(s.port, { method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body });
      assert.strictEqual((await post('/api/intel/families')).code, 403, 'no key');
      assert.strictEqual((await post('/api/intel/families', { 'x-lain-key': 'f'.repeat(64) })).code, 403, 'wrong key');
      assert.strictEqual((await post('/api/intel/families', { 'x-lain-key': key, host: 'evil.example:80' })).code, 403, 'DNS rebinding: wrong Host');
      assert.strictEqual((await post('/api/intel/families', { 'x-lain-key': key, origin: 'https://evil.example' })).code, 403, 'another origin');
      const ok = await post('/api/intel/families', { 'x-lain-key': key, origin: `http://127.0.0.1:${s.port}` });
      assert.strictEqual(ok.code, 200, ok.text);
      assert.ok(Array.isArray(JSON.parse(ok.text).families));
      for (const p of ['/api/github/status', '/api/session/new', '/api/project/attach', '/api/terminal/run']) {
        assert.strictEqual((await post(p, { 'x-lain-key': key })).code, 404, `${p} is not reachable here`);
      }
      assert.ok(sa.ROUTES_ALLOWED.every((r) => /^\/api\/(intel|accounts)\//.test(r)), 'accounts and keys only');
      const bad = await post('/api/accounts/addkey', { 'x-lain-key': key }, '{not json');
      assert.strictEqual(bad.code, 400);
      // DONE closes it.
      const bye = await post('/api/_close', { 'x-lain-key': key });
      assert.strictEqual(bye.code, 200);
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(sa.status().running, false);
    } finally { sa.stop(); }
  });

  await test('STANDALONE: with no Harness, /account add and /api add fall back to it; the terminal gets no link and no key (§11)', async () => {
    const app = mk();
    const hl = require('../../src/harnesslocation');
    const cl = require('../../src/corelock');
    const load0 = hl.load;
    const read0 = cl.read;
    const nd = process.env.LAIN_NO_DESKTOP;
    hl.load = () => ({ ok: false, why: 'LAIN Harness is not installed' });
    cl.read = () => null;
    delete process.env.LAIN_NO_DESKTOP;
    try {
      const r = await dl.open(app, 'api');
      assert.strictEqual(r.ok, true, r.why);
      assert.strictEqual(r.how, 'standalone');
      const line = dl.said(r, 'API');
      assert.match(line, /LAIN Harness is not installed — no browser could be opened for LAIN's account page/);
      // NOTHING TO COPY (§11): neither the page key nor the one-time launch nonce reaches terminal output.
      assert.ok(!/#k=|\/open\/|[a-f0-9]{32}|127\.0\.0\.1/.test(line), line);
      assert.match(dl.said({ ok: true, how: 'standalone', opened: true }, 'API'), /opened LAIN's account page in your browser\. It is served on this computer only/);
      assert.match(dl.said({ ok: true, how: 'navigated' }, 'API'), /Opened the Model Dashboard at API/);
    } finally { hl.load = load0; cl.read = read0; if (nd != null) process.env.LAIN_NO_DESKTOP = nd; sa.stop(); }
  });

  delete process.env.LAIN_STANDALONE_NO_BROWSER;
};
