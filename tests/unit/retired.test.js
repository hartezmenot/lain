'use strict';

/**
 * §52–53 — removed routing systems disappear from config, discovery, caches
 * and resolution, and a stale selection is UNAVAILABLE rather than rerouted.
 * The fixture is the shape of the user's real config on 2026-09-18.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');
const retired = require('../../src/retired');

const REAL_SHAPE = {
  model: 'glm-5',
  connection: 'omniroute',
  connections: {
    omniroute: { provider: 'omniroute', via: 'bridge', baseUrl: 'http://127.0.0.1:20128/v1' },
    'lain:zai': { provider: 'zai', via: 'native', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'k1' },
    'lain:custom': { provider: 'custom', via: 'native', baseUrl: 'https://freetokenfaucet.com/v1', apiKey: 'k2' },
    'lain:tokenrouter': { provider: 'tokenrouter', via: 'native', baseUrl: 'https://api.tokenrouter.com/v1', apiKey: 'k3' },
    'lain:api.tokenrouter.com': { provider: 'api.tokenrouter.com', via: 'native', baseUrl: 'https://api.tokenrouter.com/v1', apiKey: 'k4' },
    renamed: { provider: 'renamed', via: 'bridge', baseUrl: 'http://localhost:20128/v1' },
  },
};

module.exports = async function () {
  await test('RETIRED: omniroute and tokenrouter are pruned; 9router (:20128) and other routes survive', () => {
    const cfg = retired.prune(JSON.parse(JSON.stringify(REAL_SHAPE)));
    assert.deepStrictEqual(Object.keys(cfg.connections).sort(), ['lain:custom', 'lain:zai', 'renamed']);
    assert.deepStrictEqual(cfg._retired.map((r) => r.system).sort(), ['omniroute', 'tokenrouter', 'tokenrouter']);
    assert.ok(!Object.keys(cfg).includes('_retired'), 'the pruned list is never written back by config.save');
  });

  await test('RETIRED: discovery never builds a connection for a removed system', () => {
    const conns = require('../../src/connections').fromConfig(REAL_SHAPE, {});
    const ids = conns.map((c) => c.id);
    assert.ok(!ids.some((id) => /omniroute|tokenrouter/.test(id)), ids.join(','));
    assert.ok(ids.includes('renamed'), '9router on :20128 is a supported route');
    assert.ok(ids.includes('lain:zai'));
  });

  await test('RETIRED: a stale selection is Unavailable · provider removed, never silently rerouted', () => {
    const provider = require('../../src/provider');
    const cfg = { ...retired.prune(JSON.parse(JSON.stringify(REAL_SHAPE))) };   // spread drops _retired
    const pc = provider.resolve(cfg);
    assert.strictEqual(pc.protocol, null, 'nothing is sent');
    assert.ok(pc.unavailable);
    assert.match(provider.credentialHint(pc, cfg), /^Unavailable · provider removed/);
    assert.match(provider.credentialHint(pc, cfg), /\/model/);
  });

  await test('RETIRED: a model id namespaced by a removed router is unavailable too', () => {
    assert.strictEqual(retired.modelSystem('omniroute:openrouter/x'), 'omniroute');
    assert.strictEqual(retired.modelSystem('9router/glm-5'), null, '9router is supported');
    assert.strictEqual(retired.modelSystem('anthropic/claude-opus-5'), null);
    assert.strictEqual(retired.modelSystem('glm-5'), null);
  });

  await test('RETIRED: catalog caches written for removed routes are deleted, others kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-catcache-'));
    for (const n of ['omniroute.json', 'lain_tokenrouter.json', 'lain_api.tokenrouter.com.json', 'lain_zai.json']) fs.writeFileSync(path.join(dir, n), '{}');
    assert.strictEqual(retired.purgeCaches(dir), 3);
    assert.deepStrictEqual(fs.readdirSync(dir), ['lain_zai.json']);
  });

  await test('RETIRED: "freetokenfaucet" and "custom" are not mistaken for tokenrouter', () => {
    assert.strictEqual(retired.connectionSystem('lain:custom', REAL_SHAPE.connections['lain:custom']), null);
  });

  await test('RETIRED: the catalog lists nothing selection would refuse — and keeps what only ROUTES through the prefix', () => {
    // Live audit, 2026-09-18: a live local endpoint (FreeBuff on :4570) served
    // 16 `tokenrouter/…` ids; the picker listed them, retired.selection refused
    // them. Upstream ids like `tokenrouter/anthropic/x` fold to `anthropic/x`
    // and were — and stay — selectable.
    const catalog = require('../../src/catalog');
    const conns = [{ id: 'lain:127.0.0.1', provider: '127.0.0.1', via: 'native', auth: 'api_key', baseUrl: 'http://127.0.0.1:4570/v1',
      models: ['tokenrouter/kling-v3', 'kimi-k3', 'anthropic/claude-opus-5-fast'], readiness: 'REQUEST_READY' }];
    const cat = catalog.build(conns);
    for (const m of cat.models) {
      assert.strictEqual(retired.modelSystem(m.id), null, `listed but unselectable: ${m.id}`);
      assert.strictEqual(retired.selection({ model: m.id, connection: m.connections[0].connectionId, connections: {} }), null, m.id);
    }
    assert.ok(cat.byId.has('kimi-k3'), 'the endpoint\'s other models stay');
  });
};
