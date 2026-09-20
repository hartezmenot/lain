'use strict';

/**
 * §52-57 — MODEL CATALOG CLEANUP.
 *
 * `9router` names nothing in this codebase (checked: no such string exists).
 * `omniroute`/`custom` were already correctly retired; `tokenrouter` was not
 * — it sat in providers.js's NEEDS_ENDPOINT list as a still-offerable
 * "needs an endpoint" provider, on the user's own word that it should be
 * retired the same way. catalog.js's model/connection/effort deduplication
 * (one row per model, routes as sub-rows) was already comprehensive — this
 * pins that, plus the new opt-in FREE/PAID tier grouping, which is never
 * guessed from `auth` and only appears when the user's own config sets it.
 */

const assert = require('assert');
const { test } = require('../helpers');

const providers = require('../../src/providers');
const catalog = require('../../src/catalog');

module.exports = async function () {
  await test('CATALOG: tokenrouter is retired — never offered, from any list', () => {
    const list = providers.choices({});
    assert.ok(!list.some((p) => p.id === 'tokenrouter'), 'tokenrouter must not appear in the picker');
    assert.ok(providers.RETIRED.has('tokenrouter'));
  });

  await test('CATALOG: a retired name arriving from the user\'s own V1 config is still filtered', () => {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-v1cfg-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ providers: { tokenrouter: { baseUrl: 'https://example.invalid' } } }));
    const prevEnv = process.env.LAIN_V1_CONFIG;
    process.env.LAIN_V1_CONFIG = file;
    try {
      const list = providers.choices({});
      assert.ok(!list.some((p) => p.id === 'tokenrouter'), 'a V1-config tokenrouter entry must still be filtered');
    } finally {
      if (prevEnv === undefined) delete process.env.LAIN_V1_CONFIG; else process.env.LAIN_V1_CONFIG = prevEnv;
    }
  });

  // The earlier premise — "9router names nothing" — was wrong: the user's live
  // config held it as a bridge on its default port under the name `omniroute`.
  // See retired.js and tests/unit/retired.test.js for the enforcement.
  await test('CATALOG: 9router is SUPPORTED — a local route on its port (:20128) is never hidden', () => {
    const r = require('../../src/retired');
    assert.strictEqual(r.connectionSystem('lain:localhost', { provider: 'localhost', baseUrl: 'http://localhost:20128/v1' }), null);
    assert.strictEqual(r.connectionSystem('9router', { via: 'bridge', baseUrl: 'http://127.0.0.1:20128/v1' }), null);
  });

  await test('CATALOG: multiple connections for one model still collapse to ONE row (deduplication already correct)', () => {
    const cat = catalog.build([
      { id: 'ag', provider: 'ag', via: 'bridge', auth: 'none', models: [{ id: 'gemini-3.8-flash' }] },
      { id: 'bai', provider: 'b.ai', via: 'bridge', auth: 'none', models: [{ id: 'gemini-3.8-flash' }] },
      { id: 'google', provider: 'google', via: 'native', auth: 'api_key', models: [{ id: 'gemini-3.8-flash' }] },
    ]);
    const rows = cat.models.filter((m) => m.id === 'gemini-3.8-flash' || m.aliases?.includes('gemini-3.8-flash'));
    assert.strictEqual(rows.length, 1, 'one model, not one row per connection');
    assert.strictEqual(rows[0].connections.length, 3, 'all three routes are sub-rows of the one model');
  });

  await test('CATALOG: tier is opt-in and never guessed from `auth`', () => {
    const cat = catalog.build([
      { id: 'ag', provider: 'ag', via: 'bridge', auth: 'none', models: [{ id: 'm' }] },
      { id: 'google', provider: 'google', via: 'native', auth: 'api_key', models: [{ id: 'm' }] },
    ]);
    const m = cat.byId.get('m');
    assert.ok(m.connections.every((c) => c.tier === null), 'no tier field set anywhere means no tier is invented from auth alone');
  });

  await test('CATALOG: tier grouping reflects the user\'s own config when they set it', () => {
    const cat = catalog.build([
      { id: 'ag', provider: 'ag', via: 'bridge', auth: 'none', tier: 'free', models: [{ id: 'm' }] },
      { id: 'bai', provider: 'b.ai', via: 'bridge', auth: 'none', tier: 'free', models: [{ id: 'm' }] },
      { id: 'google', provider: 'google', via: 'native', auth: 'api_key', tier: 'paid', models: [{ id: 'm' }] },
    ]);
    const m = cat.byId.get('m');
    assert.strictEqual(m.connections.filter((c) => c.tier === 'free').length, 2);
    assert.strictEqual(m.connections.filter((c) => c.tier === 'paid').length, 1);
  });
};
