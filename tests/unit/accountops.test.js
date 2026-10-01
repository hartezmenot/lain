'use strict';

/**
 * ADD API KEY FROM THE WINDOW — against a real HTTP endpoint, not a stub.
 *
 * The rules under test are the ones the window depends on:
 *   - the key is proven before it is kept, and a refused key leaves nothing;
 *   - no answer ever carries the key, only its shape;
 *   - a route cannot be removed by naming it: a fresh, single-use,
 *     id-bound confirmation is required.
 */

const assert = require('assert');
const http = require('http');
const { test } = require('../helpers');

const accountops = require('../../src/harnessapp/accountops');
const connections = require('../../src/connections');
const config = require('../../src/config');

const GOOD = 'sk-good-key-1234567890';

module.exports = async function () {
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/models') && req.headers.authorization === `Bearer ${GOOD}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm-one' }, { id: 'm-two' }] }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const realSave = config.save;
  const saved = [];
  config.save = (c) => { saved.push(JSON.parse(JSON.stringify(c))); };
  const writeCache = connections.writeCache;
  connections.writeCache = () => {};
  const cfg = { connections: {} };
  const app = { cfg, connections: () => connections.fromConfig(cfg), ensureCatalog: async () => {} };

  try {
    await test('ACCOUNTS: a refused key is not kept, and says why in the provider\'s words', async () => {
      const r = await accountops.addKey(app, { provider: 'deepseek', key: 'sk-wrong-key-000000', baseUrl: base });
      assert.ok(!r.ok && /did not accept/.test(r.why), JSON.stringify(r));
      assert.ok(!cfg.connections['lain:deepseek'], 'nothing is left behind a row that looks configured');
      assert.ok(!JSON.stringify(r).includes('sk-wrong-key-000000'), 'the key never comes back');
    });

    await test('ACCOUNTS: a working key is stored, proven, and only its shape returns', async () => {
      const r = await accountops.addKey(app, { provider: 'deepseek', key: GOOD, baseUrl: base });
      assert.ok(r.ok, r.why);
      assert.strictEqual(r.models, 2);
      assert.strictEqual(r.key, 'sk-…7890');
      assert.ok(!JSON.stringify(r).includes(GOOD));
      assert.strictEqual(require('../../src/credentials').resolve(cfg.connections['lain:deepseek'].credentialRef), GOOD, 'stored under a reference in the existing connection model');
      assert.ok(!cfg.connections['lain:deepseek'].apiKey, 'no plaintext key in config');
      assert.ok(saved.length > 0, 'and saved through the one config owner');
      assert.ok((await accountops.test(app, { id: 'lain:deepseek' })).ok);
    });

    await test('ACCOUNTS: a provider without a known endpoint needs a base URL, and a key has no spaces', async () => {
      assert.ok(!(await accountops.addKey(app, { provider: 'deepseek', key: GOOD })).ok);
      assert.ok(!(await accountops.addKey(app, { provider: 'deepseek', key: 'sk has spaces', baseUrl: base })).ok);
      assert.ok(!(await accountops.addKey(app, { provider: 'no-such-provider', key: GOOD, baseUrl: base })).ok);
    });

    await test('ACCOUNTS: removal needs a fresh confirmation bound to that route', async () => {
      const first = accountops.remove(app, { id: 'lain:deepseek' });
      assert.ok(first.ok && first.confirm && first.token, 'the first call only asks');
      assert.strictEqual(first.impact.models, 2, 'and says what would go');
      assert.ok(cfg.connections['lain:deepseek'], 'nothing is removed by naming it');
      assert.ok(!accountops.remove(app, { id: 'lain:deepseek', token: 'guessed' }).ok, 'a guessed token is refused');
      const second = accountops.remove(app, { id: 'lain:deepseek' });
      assert.ok(accountops.remove(app, { id: 'lain:deepseek', token: second.token }).ok);
      assert.ok(!cfg.connections['lain:deepseek']);
      assert.ok(!accountops.remove(app, { id: 'lain:deepseek', token: second.token }).ok, 'and the token is single-use');
    });
  } finally {
    config.save = realSave;
    connections.writeCache = writeCache;
    server.close();
  }
};
