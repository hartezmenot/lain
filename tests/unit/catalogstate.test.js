'use strict';

/**
 * `/model` WARNING SPAM — a broken catalog source is STATE, not a WARN block.
 *
 * Measured against a real local HTTP server, counting the requests it gets:
 *
 *   lain:custom    TokenFaucet, 401 "Invalid TokenFaucet API key." — a
 *                  rejected credential; asking again with it cannot succeed
 *   lain:api.b.ai  base URL entered as the full chat endpoint, so discovery
 *                  asked `…/chat/completions/models` and got 405 "Use POST"
 *
 * 401 ≠ 405 ≠ 429. Neither broken source blocks a healthy one; neither is
 * asked again next launch with the same URL and key; one concise line on the
 * change; the raw response kept for diagnostics.
 */

const assert = require('assert');
const http = require('http');
const { test } = require('../helpers');

const connections = require('../../src/connections');
const cs = require('../../src/catalogstate');

let seq = 0;
const uid = (tag) => `t${process.pid}-${Date.now()}-${seq++}:${tag}`;

function server() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/auth/')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"UNAUTHORIZED","message":"Invalid TokenFaucet API key."}'); }
    if (req.url.includes('/chat/completions')) { res.writeHead(405, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Method not allowed for this endpoint. Use POST."}}'); }
    if (req.url.startsWith('/busy/')) { res.writeHead(429); return res.end('slow down'); }
    if (req.url.startsWith('/ok/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"model-a"},{"id":"model-b"}]}'); }
    res.writeHead(404); return res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

const conn = (id, baseUrl, apiKey = 'k') => ({ id, baseUrl: connections.apiRoot(baseUrl), apiKey, protocol: 'chat' });

module.exports = async function () {
  await test('MODEL SOURCE: 401 is auth, 405 is catalog capability, 429 is rate — three different verdicts', () => {
    assert.strictEqual(cs.classify(401), cs.STATE.AUTH_REQUIRED);
    assert.strictEqual(cs.classify(403), cs.STATE.AUTH_REQUIRED);
    assert.strictEqual(cs.classify(405), cs.STATE.CATALOG_UNAVAILABLE);
    assert.strictEqual(cs.classify(404), cs.STATE.CATALOG_UNAVAILABLE);
    assert.strictEqual(cs.classify(429), cs.STATE.RATE_LIMITED);
    assert.strictEqual(cs.classify(500), cs.STATE.UNREACHABLE);
  });

  await test('MODEL SOURCE: a base URL entered as the full endpoint is read as its API root — for discovery AND chat', () => {
    assert.strictEqual(connections.apiRoot('https://api.b.ai/v1/chat/completions'), 'https://api.b.ai/v1');
    assert.strictEqual(connections.apiRoot('https://x.test/v1/models/'), 'https://x.test/v1');
    assert.strictEqual(connections.apiRoot('https://x.test/v1'), 'https://x.test/v1', 'a correct root is untouched');
    const [c] = connections.fromConfig({ connections: { 'lain:api.b.ai': { baseUrl: 'https://api.b.ai/v1/chat/completions', apiKey: 'k' } } });
    assert.strictEqual(c.baseUrl, 'https://api.b.ai/v1', 'the provider builds `${baseUrl}/chat/completions` from this — not …/chat/completions/chat/completions');
  });

  await test('MODEL SOURCE: a 401 source is marked AUTH_REQUIRED, asked ONCE, and not re-asked next launch with the same key', async () => {
    const { srv, hits, base } = await server();
    try {
      const c = conn(uid('custom'), `${base}/auth/v1`);
      const first = await connections.discoverAll([c], { done: new Set() });
      assert.strictEqual(first[0].state, cs.STATE.AUTH_REQUIRED);
      assert.strictEqual(first[0].changed, true, 'the transition is reported once');
      const again = await connections.discoverAll([c], { done: new Set() });   // a fresh launch
      assert.strictEqual(again.length, 0, 'a known-rejected credential is not retried');
      assert.strictEqual(hits.length, 1, `requests made: ${hits.length}`);
      assert.match(cs.of(c).raw, /Invalid TokenFaucet API key/, 'the raw response is kept for diagnostics');
      const forced = await connections.discoverAll([c], { force: true, done: new Set() });
      assert.strictEqual(forced.length, 1, '/model refresh always asks');
      assert.strictEqual(forced[0].changed, false, 'and does not re-announce an unchanged state');
      const rekeyed = await connections.discoverAll([conn(c.id, `${base}/auth/v1`, 'a-new-key')], { done: new Set() });
      assert.strictEqual(rekeyed.length, 1, 'a NEW credential is a different source and is asked at once');
    } finally { srv.close(); }
  });

  await test('MODEL SOURCE: an endpoint that does not enumerate models is CATALOG_UNAVAILABLE and the invalid GET is not repeated', async () => {
    const { srv, hits, base } = await server();
    try {
      // The raw, un-normalised shape, to show what the old URL did.
      const c = { id: uid('bai'), baseUrl: `${base}/v1/chat/completions`, apiKey: 'k', protocol: 'chat' };
      const r = await connections.discoverAll([c], { done: new Set() });
      assert.strictEqual(r[0].state, cs.STATE.CATALOG_UNAVAILABLE);
      await connections.discoverAll([c], { done: new Set() });
      assert.strictEqual(hits.length, 1, 'a known-invalid GET is issued once, not per launch');
    } finally { srv.close(); }
  });

  await test('MODEL SOURCE: broken sources do not block a healthy one, which is unaffected', async () => {
    const { srv, base } = await server();
    try {
      const bad = conn(uid('custom'), `${base}/auth/v1`);
      const good = conn(uid('good'), `${base}/ok/v1`);
      const r = await connections.discoverAll([bad, good], { done: new Set() });
      const ok = r.find((x) => x.id === good.id);
      assert.strictEqual(ok.ok, true);
      assert.strictEqual(ok.count, 2);
      assert.strictEqual(ok.state, cs.STATE.OK);
    } finally { srv.close(); }
  });

  await test('MODEL SOURCE: a 429 is retried after a short wait — it is never recorded as an auth or catalog verdict', async () => {
    const { srv, base } = await server();
    try {
      const c = conn(uid('busy'), `${base}/busy/v1`);
      const r = await connections.discoverAll([c], { done: new Set() });
      assert.strictEqual(r[0].state, cs.STATE.RATE_LIMITED);
      assert.ok(cs.suppressed(c), 'not hammered immediately');
      assert.ok(!cs.suppressed(c, Date.now() + cs.RETRY_MS + 1000), 'but asked again after the wait');
    } finally { srv.close(); }
  });

  await test('MODEL SOURCE: opening /model twice across launches prints ONE concise line, no raw JSON, and then nothing', async () => {
    const { srv, base } = await server();
    try {
      const id = uid('custom');
      const said = [];
      const mkApp = () => ({
        cfg: { connections: { [id]: { baseUrl: `${base}/auth/v1`, apiKey: 'k' } } },
        connectionEvidence: {}, abort: null,
        transient: (level, msg) => said.push({ level, msg }),
      });
      const appcatalog = require('../../src/appcatalog');
      await appcatalog.ensureCatalog(mkApp());
      await appcatalog.ensureCatalog(mkApp());
      const warns = said.filter((s) => s.level === 'warn');
      assert.strictEqual(warns.length, 1, JSON.stringify(said));
      assert.strictEqual(warns[0].msg, `MODEL SOURCE · ${id} · auth required`);
      assert.ok(!said.some((s) => /UNAUTHORIZED|\{/.test(s.msg)), 'the raw provider body never reaches the transcript');
    } finally { srv.close(); }
  });

  await test('MODEL SOURCE: the picker still opens and names each broken source in restrained form', () => {
    const { modelsAdapter } = require('../../src/ui/adapters');
    const catalog = require('../../src/catalog').build([{ id: 'good', provider: 'good', models: [{ id: 'm1' }] }]);
    const a = modelsAdapter({ catalog, sourceIssues: [{ id: 'lain:custom', label: 'auth required' }, { id: 'lain:api.b.ai', label: 'catalog unavailable' }] });
    assert.ok(a.items.some((i) => i.value === 'm1'), 'healthy models stay selectable');
    assert.match(a.title, /lain:custom auth required · lain:api\.b\.ai catalog unavailable/);
    assert.doesNotMatch(a.title, /WARN|\{/);
  });
};
