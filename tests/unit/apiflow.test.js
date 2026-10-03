'use strict';

/**
 * `/api` — PHASE 8.3: THE TERMINAL NEVER TAKES A KEY.
 *
 * `/api`, `/api add`, `/api <provider>` and `/api <route>` open the Model
 * Dashboard at API (fabric/dashlaunch.js) — the one place a credential is
 * entered. A key pasted at the prompt anyway is refused: not stored, registered
 * with the redactor, and taken back out of the input history.
 *
 * WHAT STAYS ASSERTED from the earlier flow is what the dashboard's Add API
 * still shares: recognising a route, a provider and a credential (so a route's
 * NAME is never stored as its key), the shape a key is shown in, and the one
 * table of known endpoints.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('../helpers');

const apiMod = require('../../src/apicommand');
const providers = require('../../src/providers');

function rig({ connections = [], cfg = {} } = {}) {
  const written = [];
  const saved = [];
  const app = {
    cfg,
    connections: () => connections,
    render: { write: (s) => written.push(String(s)), notice: () => {} },
    input: { history: [], histIndex: 0, line: '' },
    ui: { enabled: false },
  };
  return { app, written, saved, out: () => written.join('') };
}

/** The dashboard launcher, observed: what was opened, and at which section. */
async function withStubbedDashboard(fn) {
  const dl = require('../../src/fabric/dashlaunch');
  const real = { open: dl.open, watch: dl.watch };
  const calls = [];
  dl.open = async (app, section) => { calls.push(section); return { ok: true, how: 'opened', section }; };
  dl.watch = () => () => {};
  try { return await fn(calls); } finally { dl.open = real.open; dl.watch = real.watch; }
}

module.exports = async function () {
  await test('API: a subcommand is never mistaken for a credential', () => {
    for (const s of ['refresh', 'status', 'REFRESH', 'help']) {
      assert.strictEqual(apiMod.looksLikeCredential(s), false, `${s} is a subcommand`);
    }
  });

  await test('API: a credential is anything that is not one — not a key-shaped regex', () => {
    // A shape pattern written today refuses the provider that appears tomorrow,
    // which is the hardcoded-provider-list failure one level down.
    for (const s of ['sk-abc123456789', 'sk-proj-AAAA', 'tr_live_9f2a4b8c', 'ghp_XXXXXXXXXXXX']) {
      assert.strictEqual(apiMod.looksLikeCredential(s), true, `${s} is a credential`);
    }
    // Something with spaces is a mistyped command, not a key.
    assert.strictEqual(apiMod.looksLikeCredential('my key here'), false);
    assert.strictEqual(apiMod.looksLikeCredential('x'), false);
  });

  await test('API: a PROVIDER NAME is never mistaken for a key', () => {
    // `/api openrouter` is somebody asking about a route. It is ten characters
    // with no spaces, so the length test alone stored the WORD as the
    // credential and reported success — after which the route fails to
    // authenticate for a reason nothing on screen explains.
    const cfg = { connections: { 'lain:myrouter': { provider: 'myrouter', baseUrl: 'https://r.example/v1' } } };
    for (const name of ['openrouter', 'anthropic', 'openai', 'ollama', 'myrouter']) {
      assert.strictEqual(apiMod.looksLikeCredential(name, cfg), false,
        `${name} is a route, not a key`);
    }
    // And the exclusion comes from the SAME list the picker is built from, so
    // it cannot drift out of step with what is offered.
    for (const p of providers.choices(cfg)) {
      assert.strictEqual(apiMod.looksLikeCredential(p.id, cfg), false, p.id);
    }
    // A real credential still gets through.
    assert.strictEqual(apiMod.looksLikeCredential('sk-abc123456789', cfg), true);
  });

  await test('API: the credential is never echoed — only its shape', () => {
    const s = apiMod.shapeOf('sk-proj-abcdefghijklmnop9f2a');
    assert.ok(!s.includes('abcdefgh'), `the middle is gone: ${s}`);
    assert.ok(s.startsWith('sk-') && s.endsWith('9f2a'), `recognisable at both ends: ${s}`);
  });

  // ------------------------------------------------------------- registry ---

  await test('PROVIDERS: every known endpoint is a real absolute https URL', () => {
    // These are hosts a credential is POSTed to. A typo here is a secret sent
    // to whoever owns the name.
    for (const p of providers.KNOWN) {
      assert.ok(/^https:\/\/[a-z0-9.-]+\//i.test(p.baseUrl), `${p.id}: ${p.baseUrl}`);
      assert.ok(p.protocol === 'chat' || p.protocol === 'anthropic', `${p.id} protocol`);
      assert.ok(p.label && p.envKey, `${p.id} is named and has an env route`);
    }
  });

  await test('PROVIDERS: connections.js and the picker read ONE table', () => {
    // The env routes used to be written out in connections.js and again in
    // provider.js, so "where does an OpenAI key go" had two answers that were
    // equal only by coincidence — and neither was reachable from `/api`.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'connections.js'), 'utf8');
    assert.match(src, /require\('\.\/providers'\)\.envRoutes\(\)/,
      'connections.js takes its endpoints from the table');
    assert.ok(!/api\.openai\.com/.test(src), 'and keeps no private copy of them');
  });

  await test('PROVIDERS: a configured route is offered; a BRIDGE route never is', () => {
    // A bridge authenticates upstream itself, so LAIN has no use for a key —
    // offering it would invite storing a secret for nothing.
    const list = providers.choices({
      connections: {
        'lain:myrouter': { provider: 'myrouter', baseUrl: 'https://r.example/v1' },
        'bridge:omniroute': { provider: 'omniroute', via: 'bridge', baseUrl: 'http://localhost:1/v1' },
      },
    });
    const ids = list.map((p) => p.id);
    assert.ok(ids.includes('myrouter'), 'the user\'s own route is offered');
    assert.ok(!ids.includes('omniroute'), 'the bridge route is not');
    // And it carries the user's OWN endpoint, not one LAIN made up.
    assert.strictEqual(list.find((p) => p.id === 'myrouter').baseUrl, 'https://r.example/v1');
  });

  await test('PROVIDERS: the temp home is untouched by any of this', () => {
    // These tests write no config of their own; `config.save` is stubbed. This
    // pins that, because a flow whose whole job is writing credentials is the
    // last one that should be able to reach the real store by accident.
    const home = process.env.LAIN_CONFIG_DIR;
    assert.ok(home && path.resolve(home) !== path.resolve(path.join(os.homedir(), '.lain-v2')));
  });

  // ---- PHASE 8.3: THE DASHBOARD, NEVER A TERMINAL PROMPT ----------------------

  await test('API (8.3): bare /api and /api add open the Model Dashboard at API — no key is asked for here', async () => {
    const { REGISTRY } = require('../../src/commands');
    const r = rig();
    await withStubbedDashboard(async (calls) => {
      await REGISTRY.get('/api').run(r.app, { args: [] });
      await REGISTRY.get('/api').run(r.app, { args: ['add'] });
      await REGISTRY.get('/api').run(r.app, { args: ['deepseek'] });
      assert.deepStrictEqual(calls, ['api', 'api', 'api'], 'each opens the dashboard at API');
    });
    assert.match(r.out(), /Opened the Model Dashboard at API/);
    assert.ok(!/paste|api key or token/i.test(r.out()), `nothing asks for a key: ${r.out()}`);
  });

  await test('API (8.3): a route NAME opens the dashboard to replace its key — it is never stored as a credential', async () => {
    const { REGISTRY } = require('../../src/commands');
    const conn = { id: 'lain:custom', provider: 'freetokenfaucet.com', via: 'native', auth: 'api_key', protocol: 'chat', baseUrl: 'https://freetokenfaucet.com/v1', apiKey: 'old', models: [] };
    const r = rig({ connections: [conn], cfg: { connections: { 'lain:custom': { provider: 'freetokenfaucet.com', baseUrl: conn.baseUrl, apiKey: 'old' } } } });
    await withStubbedDashboard(async (calls) => {
      await REGISTRY.get('/api').run(r.app, { args: ['lain:custom'] });
      assert.deepStrictEqual(calls, ['api']);
    });
    assert.strictEqual(r.app.cfg.connections['lain:custom'].apiKey, 'old', 'nothing was written');
  });

  await test('API (8.3): a key pasted at the prompt is refused, never stored, and taken out of the input history', async () => {
    const { REGISTRY } = require('../../src/commands');
    const r = rig();
    const key = 'sk-pasted-by-mistake-9f2a41';
    r.app.input.history = ['/model', `/api ${key}`];
    const configMod = require('../../src/config');
    const realSave = configMod.save;
    let saves = 0;
    configMod.save = () => { saves += 1; };
    try {
      await withStubbedDashboard(async (calls) => {
        await REGISTRY.get('/api').run(r.app, { args: [key] });
        assert.deepStrictEqual(calls, [], 'no dashboard for a pasted key — the person is told where keys go');
      });
    } finally { configMod.save = realSave; }
    assert.strictEqual(saves, 0, 'no configuration was written');
    assert.ok(!r.app.input.history.some((h) => h.includes(key)), 'the up-arrow cannot bring it back');
    assert.ok(!r.out().includes(key), 'and it is never echoed');
    assert.match(r.out(), /never takes a key in the terminal/);
    assert.match(require('../../src/redact').text(`x ${key} y`), /^x (?!sk-pasted)/, 'every display surface redacts it from now on');
  });

  await test('API (8.3): the terminal key-entry flows are gone from Core', () => {
    for (const k of ['credentialFlow', 'rekeyFlow', 'providerAdapter']) assert.strictEqual(apiMod[k], undefined, `${k} no longer exists`);
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routecommands.js'), 'utf8');
    assert.ok(!/secret:\s*true/.test(src), 'no masked secret prompt in the terminal commands');
  });

  await test('API: a route answers to its id, its bare name, and its provider', () => {
    const conns = [{ id: 'lain:custom', provider: 'freetokenfaucet.com', via: 'native', baseUrl: 'https://freetokenfaucet.com/v1' }, { id: 'omniroute', provider: 'omniroute', via: 'bridge', baseUrl: 'http://127.0.0.1:20128/v1' }];
    const r = rig({ connections: conns });
    const find = (n) => apiMod.connectionByName(r.app, n);
    assert.strictEqual(find('lain:custom'), conns[0]);
    assert.strictEqual(find('custom'), conns[0]);
    assert.strictEqual(find('LAIN:CUSTOM'), conns[0]);
    assert.strictEqual(find('freetokenfaucet.com'), conns[0]);
    assert.strictEqual(find(''), null);
    assert.strictEqual(find('no-such-route'), null);
  });
};
