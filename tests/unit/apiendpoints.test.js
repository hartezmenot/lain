'use strict';

/**
 * THE WIRE URL IS THE CONTRACT, NOT THE TABLE ROW.
 *
 * A provider row can look right in /api's picker and still post somewhere
 * else: the row lives in providers.js and the sender's URL is built in
 * provider.js, and nothing compared them. These tests stub `fetch` and read
 * the URL the sender ACTUALLY posts to — the same approach providercache
 * takes with request bodies — so the row and the wire cannot drift apart
 * silently.
 *
 * b.ai and z.ai are both here because both were named by the operator with a
 * full URL. The only honest proof that `/api` offers what was asked for is the
 * request the picker's choice produces on the wire.
 */

const assert = require('assert');
const { test } = require('../helpers');
const provider = require('../../src/provider');
const providers = require('../../src/providers');

/** A minimal OpenAI-chat SSE body: one content chunk, then [DONE]. */
function chatSSE() {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  let i = 0;
  const encoder = new TextEncoder();
  return {
    getReader() {
      return {
        async read() {
          if (i >= lines.length) return { done: true, value: undefined };
          return { done: false, value: encoder.encode(lines[i++]) };
        },
        async cancel() {},
      };
    },
  };
}

/**
 * Stubs global.fetch to RECORD THE URL. providercache's stub records request
 * bodies; here the URL is the whole point, so the stub keeps it.
 */
function recordingFetch() {
  const urls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, body: chatSSE() };
  };
  return { urls, restore: () => { global.fetch = original; } };
}

async function drain(gen) { const out = []; for await (const ev of gen) out.push(ev); return out; }

/** One request through the real sender, with the endpoint taken from the row /api offers. */
async function wireUrlFor(id, known = null) {
  const row = known || providers.byId(id);
  assert.ok(row, `${id} is in the table /api offers`);
  const { urls, restore } = recordingFetch();
  try {
    const pc = { protocol: row.protocol, model: 'wire-test', maxTokens: 64, baseUrl: row.baseUrl, apiKey: 'test-key' };
    await drain(provider.chat(pc, [{ role: 'user', content: 'hi' }], {}));
    return urls;
  } finally { restore(); }
}

module.exports = async function () {
  /**
   * THE ROW IS THE SINGLE SOURCE OF TRUTH FOR THE ENDPOINT.
   *
   * ------------------------------------------------------------------------
   * WHY THIS IS A DERIVATION AND NOT A FROZEN STRING, which is what it used to
   * be. Two cases were pinned by their literal URL — `https://api.z.ai/api/
   * paas/v4/chat/completions` and b.ai's — so the moment the operator
   * deliberately repointed z.ai at its CODING endpoint
   * (`/api/coding/paas/v4`, providers.js) the suite went red over a
   * configuration change that was entirely intended. A test that fails when
   * the product is deliberately reconfigured is a false alarm, and a false
   * alarm in a provider test is how a real one gets ignored.
   *
   * The property actually worth holding is the one this file was written for:
   * THE PICKER'S ROW AND THE SENDER'S URL CANNOT DRIFT APART. That is a
   * relationship, not a value — the wire URL is exactly the row's `baseUrl`
   * plus the path its protocol defines — and asserting the relationship covers
   * EVERY provider rather than the two somebody remembered to pin.
   *
   * `provider.js`: chat → `${baseUrl}/chat/completions`, anthropic →
   * `${baseUrl}/messages`.
   */
  const PATH_FOR = { chat: '/chat/completions', anthropic: '/messages' };

  await test('ENDPOINTS: every provider posts to its OWN row, path and all', async () => {
    const rows = providers.choices({}).map((p) => providers.byId(p.id)).filter(Boolean);
    assert.ok(rows.length >= 4, `the table is populated: ${rows.length}`);
    let checked = 0;
    for (const row of rows) {
      const suffix = PATH_FOR[row.protocol];
      if (!suffix || !row.baseUrl) continue;          // a row with no fixed endpoint is not a wire claim
      const urls = await wireUrlFor(row.id, row);
      assert.deepStrictEqual(urls, [`${row.baseUrl}${suffix}`],
        `${row.id} must post to the endpoint its own row names`);
      checked += 1;
    }
    assert.ok(checked >= 4, `at least the fixed-endpoint providers were checked: ${checked}`);
  });

  await test('ENDPOINTS: b.ai and z.ai reach their own hosts over the chat shape', async () => {
    // The two the operator named by hand. The HOST is the identity — posting a
    // z.ai key at b.ai is the failure worth catching — while the PATH is
    // configuration and is allowed to be changed deliberately. z.ai currently
    // points at its coding endpoint (`/api/coding/paas/v4`), set by the
    // operator; that is a setting, not a regression.
    for (const [id, host] of [['bai', 'api.b.ai'], ['zai', 'api.z.ai']]) {
      const row = providers.byId(id);
      assert.strictEqual(new URL(row.baseUrl).host, host, `${id} points at ${host}`);
      const [url] = await wireUrlFor(id);
      assert.strictEqual(new URL(url).host, host, `${id} posts to ${host}`);
      assert.ok(url.endsWith('/chat/completions'), `${id} speaks the OpenAI chat shape`);
    }
  });

  await test('ENDPOINTS: a configured baseUrl overrides the row, and nothing else moves', async () => {
    // The other half of the contract: a connection may carry its own endpoint
    // — a gateway, a proxy, a self-hosted deployment — and the sender must use
    // it verbatim. This is what makes repointing a provider a CONFIGURATION
    // act rather than a code change.
    const custom = 'https://gateway.example.test/v9';
    const { urls, restore } = recordingFetch();
    try {
      await drain(provider.chat(
        { protocol: 'chat', model: 'wire-test', maxTokens: 64, baseUrl: custom, apiKey: 'test-key' },
        [{ role: 'user', content: 'hi' }], {},
      ));
    } finally { restore(); }
    assert.deepStrictEqual(urls, [`${custom}/chat/completions`], 'the configured endpoint is used verbatim');

    // AND THE TABLE IS UNTOUCHED BY IT — one request must not repoint a provider.
    assert.strictEqual(providers.byId('zai').baseUrl, 'https://api.z.ai/api/coding/paas/v4');
    assert.strictEqual(providers.byId('bai').baseUrl, 'https://api.b.ai/v1');
  });

  await test('ENDPOINTS: the picker and the sender read the SAME row — no second table to drift', () => {
    // `choices` builds /api's provider picker; `byId` is what the wire URL is
    // resolved through here. If the picker offered a route the sender could
    // not build, the user would pick b.ai and reach whatever was left in the
    // second table.
    const offered = providers.choices({});
    const ids = offered.map((p) => p.id);
    for (const id of ['bai', 'zai']) {
      assert.ok(ids.includes(id), `${id} is offered by /api`);
    }
    // AND THE PICKER OFFERS THE ENDPOINT THE SENDER WILL ACTUALLY USE. Ids
    // matching is not enough: the drift that matters is a picker row carrying
    // one `baseUrl` while `byId` — what the wire is built from — carries
    // another, so the user picks a provider and reaches somewhere else.
    for (const row of offered) {
      const sender = providers.byId(row.id);
      if (!sender || !row.baseUrl || row.source !== 'built-in') continue;
      assert.strictEqual(row.baseUrl, sender.baseUrl,
        `${row.id}: the picker offers ${row.baseUrl} and the sender would use ${sender.baseUrl}`);
    }
  });
};
