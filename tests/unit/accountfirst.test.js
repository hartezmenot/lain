'use strict';

/**
 * ACCOUNT FIRST (Phase 8.2) — a request goes through the ACCOUNT the lane chose,
 * then the model that account offers. Fixture accounts only: a fake 9Router
 * (declared `provider: '9router'`, a local HTTP server — never the real one)
 * holding a Codex pool and an Antigravity pool, and an OpenAI API key.
 *
 *   ACCOUNTS    9Router pools per provider prefix (agcc joins Antigravity,
 *               access tiers fold), an API account per key; a pool says
 *               9Router chooses inside it
 *   LANES       a model offered by two accounts is never resolved by name alone
 *   CHOOSE      account change keeps a model it offers, else its declared
 *               default, else waits for a model; never another account's route
 *   ROUTE       the wire carries the chosen account's upstream id; the receipt
 *               names the requested and the actual account — and they match
 *   STALE       a global default on another account never leaks into a session
 *   CLI = WINDOW  /account and /model write the same session state the window reads
 */

const assert = require('assert');
const http = require('http');
const { test, tmpdir } = require('../helpers');

function fakeRouter() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(body || '{}'); } catch { /* none */ }
      seen.push({ url: req.url, model: j.model || null, auth: req.headers.authorization || '' });
      if (/\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
      if (j.stream) {   // as the real 9Router answers a streamed request
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}/v1` })));
}

module.exports = async function () {
  const fs = require('fs');
  const { App } = require('../../src/app');
  const A = require('../../src/accountcatalog');
  const si = require('../../src/sessionintel');
  const sv = require('../../src/sessionviews');
  // THE SHARED TEST HOME'S CONFIG, put back afterwards: setDefaultModel saves the whole config, and this
  // file's fixture default (OpenAI API) then became every later test's global default account.
  const cfgFile = require('path').join(require('../../src/config').configDir(), 'config.json');
  let cfgBefore = null;
  try { cfgBefore = fs.readFileSync(cfgFile, 'utf8'); } catch { cfgBefore = null; }
  const router = await fakeRouter();
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('acct-') });
  app.cfg.connections = {
    'lain:9r': {
      baseUrl: router.url, provider: '9router', apiKey: 'router-key',
      models: [
        { id: 'cx/gpt-6-sol', owned_by: 'cx' }, { id: 'cx/gpt-5.5', owned_by: 'cx' },
        { id: 'ag/gemini-3.8-flash', owned_by: 'ag' }, { id: 'agcc/claude-sonnet-5', owned_by: 'agcc' },
        { id: 'orca/openai/gpt-6-sol', owned_by: 'orca' },
      ],
    },
    'lain:oai': { baseUrl: router.url, provider: 'openai', apiKey: 'sk-test', models: ['gpt-6-sol', 'gpt-5.5'] },
    'lain:alt': { baseUrl: 'http://127.0.0.1:9/v1', provider: 'deepseek', apiKey: 'sk-alt', models: ['alt-model'] },
  };
  app.cfg.ninerouter = { adopted: { cx: { at: 'x' }, agcc: { at: 'x' } } };
  app.cfg.model = 'gpt-6-sol';
  app.cfg.connection = 'lain:oai';
  app.cfg.defaultChat = { source: 'lain', model: null };
  const saved = process.env.LAIN_PROVIDER;
  delete process.env.LAIN_PROVIDER;
  // ONE REAL CODEX ACCOUNT (8.4: an imported pool is metadata, never capacity) — GPT-6 Sol and GPT-5.5, run by the fake Codex.
  const fx = require('../harness/fabricfixtures');
  await fx.reset();
  const M = (id, name, dflt) => ({ id, model: id, displayName: name, hidden: false, isDefault: dflt, supportedReasoningEfforts: [] });
  const [CX] = await fx.codexAccounts(app, [{ name: 'Personal', email: 'personal@example.com', models: [M('gpt-6-sol', 'GPT-6 Sol', true), M('codex-mini', 'Codex Mini', false)] }]);

  try {
    await test('ACCOUNTS: 9Router pools by provider (Antigravity serves Gemini and Claude), an API account per key, and a pool says 9Router chooses', () => {
      const L = A.list(app);
      const ids = L.accounts.map((a) => a.id).sort();
      assert.deepStrictEqual(ids, ['lain:9r:ag', 'lain:9r:cx', 'lain:9r:orca', 'lain:alt', 'lain:oai', CX.id].sort(), JSON.stringify(ids));
      const cx = A.find(app, 'lain:9r:cx');
      assert.strictEqual(cx.kind, 'oauth'); assert.strictEqual(cx.family, 'codex'); assert.strictEqual(cx.pinned, false);
      assert.match(cx.note, /9Router .*chooses/);
      assert.strictEqual(cx.adopted, true);
      const ag = A.find(app, 'lain:9r:ag');
      assert.deepStrictEqual(A.models(app, ag.id).map((m) => m.id).sort(), ['ag/gemini-3.8-flash', 'agcc/claude-sonnet-5']);
      assert.strictEqual(ag.adopted, true, 'adopting Claude (Antigravity) adopts the Antigravity sign-in');
      assert.strictEqual(A.find(app, 'lain:9r:orca').adopted, false, 'a provider 9Router carries is listed, not adopted');
      const oai = A.find(app, 'lain:oai');
      assert.strictEqual(oai.kind, 'api'); assert.strictEqual(oai.name, 'OpenAI API'); assert.strictEqual(oai.pinned, true);
      assert.strictEqual(A.accountIdForRoute('lain:9r:orca#free', { id: 'lain:9r', provider: '9router' }), 'lain:9r:orca', 'an access tier is the same account');
      assert.strictEqual(A.models(app, cx.id).find((m) => m.id === 'cx/gpt-6-sol').label, 'GPT 6 Sol', 'the router namespace is the account, not part of the model name');
    });

    await test('LANES (8.3): a model two PROVIDERS offer is never resolved by its name — the lane waits for a provider and sends nothing', async () => {
      // Two API keys are two API sources; the same model id through both is two providers.
      app.cfg.connections['lain:oai2'] = { baseUrl: 'http://127.0.0.1:9/v1', provider: 'openai', apiKey: 'sk-2', models: ['gpt-5.5'] };
      app.session.sourceSelections = { lain: 'gpt-5.5' };
      app.session.accountSelections = {};
      const l = si.lane(app, app.session, 'chat');
      assert.strictEqual(l.ok, false); assert.strictEqual(l.needs, 'family');
      assert.match(l.why, /choose which provider runs gpt-5\.5/);
      app.session.thread = 'chat';   // the turn now running is a Chat turn
      const cfg = sv.turnCfg(app, app.session);
      const pc = require('../../src/provider').resolve(cfg);
      assert.ok(pc.unavailable && pc.unavailable.kind === 'account', 'refused before inference');
      assert.match(require('../../src/provider').credentialHint(pc, cfg), /choose which provider/);
      delete app.cfg.connections['lain:oai2'];
    });

    await test('CHOOSE (8.3): a family keeps the LOGICAL model it offers, else its declared default', async () => {
      let r = await si.choose(app, app.session, { lane: 'chat', account: 'lain:oai', model: 'gpt-6-sol' });
      assert.ok(r.ok, r.why);
      assert.strictEqual(r.lane.account, 'lain:oai'); assert.strictEqual(r.lane.route, 'lain:oai');
      assert.strictEqual(r.lane.family, 'api:lain:oai');
      // CODEX OFFERS GPT-6 SOL: the logical model is kept when the family is chosen.
      r = await si.choose(app, app.session, { lane: 'chat', family: 'codex' });
      assert.ok(r.ok, r.why);
      assert.strictEqual(r.lane.family, 'codex'); assert.strictEqual(r.lane.familyLabel, 'Codex');
      assert.strictEqual(r.lane.model, 'gpt-6-sol', 'the logical id');
      assert.strictEqual(r.lane.account, CX.id, 'the backing account the policy chose');
      assert.strictEqual(r.lane.backing.name, 'Personal');
      // A DECLARED DEFAULT is what choosing the family selects when the model is not offered.
      assert.ok(A.setDefaultModel(app, CX.id, 'codex-mini').ok);
      const globalModel = app.cfg.model;
      app.cfg.model = null;   // no global model to fall back to
      await si.choose(app, app.session, { lane: 'chat', model: null });
      r = await si.choose(app, app.session, { lane: 'chat', family: 'codex' });
      app.cfg.model = globalModel;
      assert.strictEqual(r.lane.model, 'codex-mini', 'the account\'s declared default, as a logical model');
      const refused = await si.choose(app, app.session, { lane: 'chat', model: 'orca/openai/gpt-6-sol' });
      assert.strictEqual(refused.ok, false, 'a model only a router pool nobody imported carries is not LAIN\'s to use');
      assert.strictEqual(si.lane(app, app.session, 'chat').family, 'codex', 'the refusal changed nothing');
      const unknown = await si.choose(app, app.session, { lane: 'chat', account: 'nope' });
      assert.strictEqual(unknown.ok, false);
    });

    await test('ROUTE: the wire carries the chosen account\'s upstream id; the receipt names the requested and the actual account, and they match', async () => {
      await si.choose(app, app.session, { lane: 'coding', account: 'lain:oai', model: 'gpt-6-sol' });
      delete app.session.thread;   // a terminal turn is Coding
      const cfg = sv.turnCfg(app, app.session);
      assert.strictEqual(cfg.connection, 'lain:oai');
      const provider = require('../../src/provider');
      const pc = provider.resolve(cfg);
      assert.strictEqual(pc.routeId, 'lain:oai'); assert.strictEqual(pc.accountId, 'lain:oai'); assert.strictEqual(pc.requestedAccount, 'lain:oai');
      assert.strictEqual(pc.model, 'gpt-6-sol');
      router.seen.length = 0;
      let text = '';
      for await (const ev of provider.chat(pc, [{ role: 'user', content: 'hi' }], { trace: { reason: 'turn' } })) if (ev.type === 'text') text += ev.chunk;
      const hit = router.seen.find((x) => /chat\/completions$/.test(x.url));
      assert.ok(hit, 'the request reached the fake endpoint');
      assert.strictEqual(hit.model, 'gpt-6-sol', 'the account\'s upstream id went on the wire');
      assert.strictEqual(text, 'ok', 'the answer came back');
      const rows = require('../../src/usage').read({ from: Date.now() - 60000 });
      const last = rows[rows.length - 1];
      assert.strictEqual(last.account, 'lain:oai'); assert.strictEqual(last.requestedAccount, 'lain:oai'); assert.strictEqual(last.route, 'lain:oai');
    });

    await test('STALE: a global default on another account never leaks into a session that chose its own', async () => {
      app.cfg.model = 'gpt-6-sol'; app.cfg.connection = 'lain:oai';
      await si.choose(app, app.session, { lane: 'coding', account: 'lain:alt', model: 'alt-model' });
      const pc = require('../../src/provider').resolve(sv.turnCfg(app, app.session));
      assert.strictEqual(pc.accountId, 'lain:alt'); assert.strictEqual(pc.routeId, 'lain:alt'); assert.strictEqual(pc.model, 'alt-model');
      assert.strictEqual(app.cfg.connection, 'lain:oai', 'the process default was not written');
    });

    await test('CLI = WINDOW: /account use and /model write the session state the window reads', async () => {
      const commands = require('../../src/commands');
      const out = [];
      app.render = { write: (s) => out.push(String(s)), openSurface() {}, doneSurface() {}, notice() {} };
      delete app.session.thread;
      await commands.run(app, '/account use openai');
      const lanes = await require('../../src/harnessapp/intelroutes').ROUTES['POST /api/intel/lanes'](app, {});
      assert.strictEqual(lanes.body.lanes.coding.account, 'lain:oai', out.join(''));
      await commands.run(app, '/model gpt-5.5');
      const after = await require('../../src/harnessapp/intelroutes').ROUTES['POST /api/intel/lanes'](app, {});
      assert.strictEqual(after.body.lanes.coding.model, 'gpt-5.5', out.join(''));
      assert.strictEqual(after.body.lanes.coding.route, 'lain:oai');
      assert.strictEqual(app.cfg.model, 'gpt-6-sol', '/model chooses for the session; the default is /model default');
      const chosen = await require('../../src/harnessapp/intelroutes').ROUTES['POST /api/intel/choose'](app, { lane: 'chat', account: CX.id });
      assert.strictEqual(chosen.code, 200);
      app.session.thread = 'chat';
      out.length = 0;
      await commands.run(app, '/account');
      // PHASE 8.3: the provider family, its policy, and the backing account marked — numbered for pin/reorder.
      assert.match(out.join(''), /\n {2}Codex\n {2}Policy: Automatic fallback/, out.join(''));
      assert.match(out.join(''), /◀ {2}1\. Personal/, 'the terminal marks the backing account the window chose');
    });
  } finally {
    if (saved !== undefined) process.env.LAIN_PROVIDER = saved;
    try { if (cfgBefore === null) fs.unlinkSync(cfgFile); else fs.writeFileSync(cfgFile, cfgBefore); } catch { /* nothing was written */ }
    router.srv.close();
    await fx.reset();
  }
};
