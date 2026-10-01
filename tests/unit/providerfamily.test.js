'use strict';

/**
 * THE PROVIDER FAMILY (§61, §68): one brand, reached several ways — a subscription (Codex), an API key (OpenAI API)
 * — shown together for people, never merged: each source keeps its own accounts, models and limits, so a
 * subscription's windows never appear on an API key and API billing never reads as subscription quota.
 */

const assert = require('assert');
const { test } = require('../helpers');

module.exports = async function () {
  const F = require('../../src/fabric/index');
  const cat = require('../../src/accountcatalog');

  await test('PROVIDER FAMILY: a brand from the family, or from an API endpoint\'s host — anything else is a custom endpoint', () => {
    assert.strictEqual(F.brandOf('codex'), 'openai');
    assert.strictEqual(F.brandOf('claude'), 'anthropic');
    assert.strictEqual(F.brandOf('antigravity'), 'google');
    assert.strictEqual(F.brandOf('zai'), 'zai');
    assert.strictEqual(F.brandOf('api:lain:openai', 'https://api.openai.com/v1'), 'openai');
    assert.strictEqual(F.brandOf('api:lain:anthropic', 'https://api.anthropic.com'), 'anthropic');
    assert.strictEqual(F.brandOf('api:lain:glm', 'https://open.bigmodel.cn/api/paas/v4'), 'zai');
    assert.strictEqual(F.brandOf('api:lain:gem', 'https://generativelanguage.googleapis.com/v1beta/openai'), 'google');
    assert.strictEqual(F.brandOf('api:lain:local', 'http://127.0.0.1:8080/v1'), 'custom');
    assert.strictEqual(F.brandOf('api:lain:evil', 'https://api.openai.com.example.net/v1'), 'custom', 'a look-alike host is not the provider');
    assert.strictEqual(F.brandOf('api:lain:bad', 'not a url'), 'custom');
    assert.deepStrictEqual(['oauth', 'api', 'local', 'runtime'].map(F.sourceOf), ['subscription', 'api', 'local', 'runtime']);
  });

  await test('PROVIDER FAMILY: Codex and an OpenAI key sit under OpenAI as two sources — quota stays with the subscription', () => {
    const list0 = cat.list;
    const now = Date.now();
    const accounts = [
      { id: 'codex:personal', kind: 'runtime', family: 'codex', name: 'Personal', state: 'READY', routes: [], identity: { email: 'p@example.com' },
        quota: [{ label: '5h', usedPercent: 26, resetsAt: now + 3600e3 }] },
      { id: 'lain:openai', kind: 'api', family: 'api', name: 'OpenAI API', base: 'lain:openai', endpoint: 'https://api.openai.com/v1', state: 'READY', routes: [], quota: null },
      { id: 'lain:custom', kind: 'api', family: 'api', name: 'My endpoint', base: 'lain:custom', endpoint: 'http://127.0.0.1:9000/v1', state: 'READY', routes: [], quota: null },
    ];
    cat.list = () => ({ accounts, byId: new Map(accounts.map((a) => [a.id, a])) });
    try {
      const app = { catalog: () => ({ models: [], byId: new Map() }) };
      const groups = F.providerFamilies(app);
      const openai = groups.find((g) => g.id === 'openai');
      assert.ok(openai, 'OpenAI appears once');
      assert.strictEqual(openai.label, 'OpenAI');
      assert.deepStrictEqual(openai.subscription, ['codex']);
      assert.deepStrictEqual(openai.api, ['api:lain:openai']);
      assert.strictEqual(groups.filter((g) => g.id === 'openai').length, 1);
      assert.deepStrictEqual(groups.find((g) => g.id === 'custom').api, ['api:lain:custom']);
      // NEVER MERGED: the API source carries none of the subscription's windows, and each says what it is.
      const codex = F.family(app, 'codex');
      const key = F.family(app, 'api:lain:openai');
      assert.strictEqual(codex.source, 'subscription');
      assert.strictEqual(key.source, 'api');
      assert.strictEqual(codex.accounts[0].quota.length, 1);
      assert.strictEqual(key.accounts[0].quota.length, 0, 'no subscription quota on the API key');
      const v = F.familyView(key);
      assert.strictEqual(v.brand, 'openai');
      assert.strictEqual(v.brandLabel, 'OpenAI');
      assert.strictEqual(v.source, 'api');
    } finally { cat.list = list0; }
  });
};
