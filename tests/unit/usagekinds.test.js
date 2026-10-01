'use strict';

/**
 * A PERCENTAGE SAYS WHAT IT IS A PERCENTAGE OF.
 *
 * "63%" of a 5-hour subscription window and "63%" of this minute's request
 * limit are different facts. Every window carries its kind, an unnamed
 * x-ratelimit window is never passed off as "requests", and a route that
 * stated nothing has no reading at all (never 0%).
 */

const assert = require('assert');
const { test } = require('../helpers');
const uw = require('../../src/usagewindows');

module.exports = async function () {
  await test('QUOTA KIND: subscription, request, token and unnamed windows stay distinct', () => {
    const w = uw.parse({
      'anthropic-ratelimit-unified-5h-utilization': '0.63',
      'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '40',
      'x-ratelimit-limit-tokens': '1000', 'x-ratelimit-remaining-tokens': '900',
      'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '5',
    });
    const by = Object.fromEntries(w.map((x) => [x.name, x]));
    assert.strictEqual(by['5h'].kind, uw.KIND.SUBSCRIPTION);
    assert.strictEqual(Math.round(by['5h'].percent), 63);
    assert.strictEqual(by.requests.kind, uw.KIND.REQUEST_WINDOW);
    assert.strictEqual(Math.round(by.requests.percent), 60, 'the unnamed window did not merge into it');
    assert.strictEqual(by.tokens.kind, uw.KIND.TOKEN_WINDOW);
    assert.strictEqual(by.rate.kind, uw.KIND.RATE_LIMIT, 'a window with no unit does not claim one');
    assert.strictEqual(uw.headline(w).kind, uw.KIND.SUBSCRIPTION, 'the plan window is the headline');
  });

  await test('QUOTA KIND: anthropic token windows are token windows; nothing stated is no reading', () => {
    const w = uw.parse({ 'anthropic-ratelimit-input-tokens-limit': '400000', 'anthropic-ratelimit-input-tokens-remaining': '100000' });
    assert.strictEqual(w[0].kind, uw.KIND.TOKEN_WINDOW);
    assert.deepStrictEqual(uw.parse({ 'content-type': 'application/json' }), [], 'no usage stated is no usage claimed');
  });
};
