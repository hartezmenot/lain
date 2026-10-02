'use strict';

/**
 * Z.AI IS API-ONLY IN LAIN (2026-09-29) — a LAIN product decision.
 *
 *   - "Connect account" for Z.ai launches nothing: it answers that LAIN integrates
 *     Z.ai through its API, and where to add the key. No ZCode window, no
 *     AuthSession, no AccountInstance.
 *   - ZCode being installed and signed in creates no account family and no route.
 *   - "Z.ai API" is an API source. Without a key it is listed (so it can be fixed)
 *     but it is NEVER routable — a lane that chose it resolves to "Select model",
 *     never "Z.ai API · GLM 5.3 Flash" with nothing behind it.
 *   - With a key it routes like any API source.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const { App } = require('../../src/app');
  const A = require('../../src/authsession');
  const F = require('../../src/fabric/index');
  const si = require('../../src/sessionintel');
  const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };
  const fresh = (app) => { require('../../src/appcatalog').invalidate(); app._acctMemo = null; app._catMemo = null; app._fabricMemo = null; };
  const zaiConn = (extra = {}) => ({ provider: 'zai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', models: ['glm-5.3-flash', 'glm-5.2'], ...extra });

  await test('Z.AI: "Connect account" launches nothing and points at MODEL › API — no ZCode, no sign-in session, no instance', async () => {
    const app = new App({ out, interactive: false, cwd: tmpdir('zai-') });
    const before = require('../../src/accountinstances').records().length;
    const r = await A.start(app, 'zai');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.apiOnly, true);
    assert.match(r.why, /through its API/);
    assert.match(r.why, /MODEL › API/);
    assert.strictEqual(A.activeFor('zai'), null, 'no sign-in session was opened');
    assert.strictEqual(require('../../src/accountinstances').records().length, before, 'no account instance was created');
    assert.ok(!('zai' in A.STRATEGIES), 'there is no Z.ai sign-in strategy at all');
  });

  await test('Z.AI: there is no Z.ai ACCOUNT family — ZCode on this PC creates no account and no route', async () => {
    const app = new App({ out, interactive: false, cwd: tmpdir('zai-fam-') });
    fresh(app);
    const fams = F.families ? F.families(app) : F.index(app).families;
    assert.ok(!fams.some((f) => f.id === 'zai'), `families: ${fams.map((f) => f.id).join(', ')}`);
    assert.ok(!require('../../src/runtimeconnections').connections(app).some((c) => c.runtime === 'zcode'), 'no ZCode runtime route');
    assert.ok(!require('../../src/fabric/migrate').reauthOf('zai').supported, 'migration never sends Z.ai to a ZCode sign-in');
  });

  await test('Z.AI API WITHOUT A KEY: listed with "Key needed", never routable — the lane shows Select model, not a half route', async () => {
    const app = new App({ out, interactive: false, cwd: tmpdir('zai-nokey-') });
    delete process.env.ZAI_API_KEY_LAIN_TEST;
    app.cfg.connections = { ...(app.cfg.connections || {}), 'lain:zai': zaiConn({ envKey: 'ZAI_API_KEY_LAIN_TEST' }) };
    fresh(app);
    const acct = require('../../src/accountcatalog').list(app).accounts.find((a) => a.base === 'lain:zai');
    assert.ok(acct, 'the source is listed');
    assert.strictEqual(acct.name, 'Z.ai API');
    assert.deepStrictEqual([acct.state, acct.usable], ['KEY_NEEDED', false]);
    assert.match(acct.why, /no API key/);
    await si.choose(app, app.session, { lane: 'coding', family: F.familyIdOf(acct), model: 'glm-5.3-flash' }).catch(() => null);
    const lane = si.lane(app, app.session, 'coding');
    assert.strictEqual(lane.ok, false, 'no route through a keyless API');
    assert.strictEqual(lane.resolved, false);
    assert.strictEqual(lane.display.text, 'Select model', `shown as: ${JSON.stringify(lane.display)}`);
  });

  await test('Z.AI API QUOTA: read from Z.ai\'s monitor with the key LAIN holds — no model call — and stated as what remains', async () => {
    const http = require('http');
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url !== '/api/monitor/usage/quota/limit') { res.end('{"code":404}'); return; }
      res.end(JSON.stringify({ code: 200, data: { limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 800, currentValue: 208, remaining: 592, percentage: 26, nextResetTime: Date.now() + 2 * 3600e3 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 4000, currentValue: 1920, remaining: 2080, percentage: 48, nextResetTime: Date.now() + 3 * 86400e3 },
        { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 100, remaining: 900, percentage: 10, nextResetTime: Date.now() + 20 * 86400e3 },
      ] } }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const app = new App({ out, interactive: false, cwd: tmpdir('zai-quota-') });
    process.env.ZAI_API_KEY_LAIN_TEST = 'zai-test-key-not-real';
    try {
      app.cfg.connections = { ...(app.cfg.connections || {}), 'lain:zai': zaiConn({ envKey: 'ZAI_API_KEY_LAIN_TEST', baseUrl: `http://127.0.0.1:${server.address().port}/api/coding/paas/v4` }) };
      fresh(app);
      const r = await require('../../src/fabric/quotaread').refreshApi(app);
      assert.deepStrictEqual(r.map((x) => [x.id, x.ok, x.windows]), [['lain:zai', true, 3]]);
      assert.strictEqual(seen[0].url, '/api/monitor/usage/quota/limit', 'the monitor at the ORIGIN — never appended to /api/coding/paas/v4');
      assert.strictEqual(seen[0].auth, 'zai-test-key-not-real', 'the raw key, as the monitor takes it');
      fresh(app);
      const acct = require('../../src/accountcatalog').list(app).accounts.find((a) => a.base === 'lain:zai');
      const fam = F.family(app, F.familyIdOf(acct));
      const q = Object.fromEntries(fam.accounts[0].quota.map((w) => [w.label, w.remainingPercent]));
      assert.deepStrictEqual(q, { '5-hour': 74, weekly: 52, 'monthly (MCP)': 90 });
    } finally { delete process.env.ZAI_API_KEY_LAIN_TEST; server.close(); }
  });

  await test('Z.AI API WITH A KEY: routable like any API source', async () => {
    const app = new App({ out, interactive: false, cwd: tmpdir('zai-key-') });
    process.env.ZAI_API_KEY_LAIN_TEST = 'zai-test-key-not-real';
    try {
      app.cfg.connections = { ...(app.cfg.connections || {}), 'lain:zai': zaiConn({ envKey: 'ZAI_API_KEY_LAIN_TEST' }) };
      fresh(app);
      const acct = require('../../src/accountcatalog').list(app).accounts.find((a) => a.base === 'lain:zai');
      assert.deepStrictEqual([acct.state, acct.usable], ['READY', true]);
      const r = await si.choose(app, app.session, { lane: 'coding', family: F.familyIdOf(acct), model: 'glm-5.3-flash' });
      assert.ok(r && r.ok !== false, JSON.stringify(r).slice(0, 200));
      const lane = si.lane(app, app.session, 'coding');
      assert.strictEqual(lane.resolved, true, lane.why);
      assert.match(lane.display.text, /^Z\.ai API · /);
    } finally { delete process.env.ZAI_API_KEY_LAIN_TEST; }
  });
};
