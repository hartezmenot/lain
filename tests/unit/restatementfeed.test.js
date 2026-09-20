'use strict';

/**
 * A FINDING RESTATED AT EVERY STEP IS DRAWN ONCE IN THE FINISHED TURN.
 *
 * Live acceptance run, 2026-09-18: step narrations "The cart line total bug is
 * fixed.", "The cart line total bug is fixed - that test now passes.", "The
 * cart line total bug is fixed. The issue was…" and then a RESULT opening with
 * the same sentence — four copies of one finding in the permanent transcript.
 * Distinct findings still show.
 */

const assert = require('assert');
const { test } = require('../helpers');
const ts = require('../../src/ui/turnsections');

module.exports = async function () {
  await test('RESTATEMENT: repeated openings collapse; a distinct finding and the RESULT remain', () => {
    const narration = [
      { step: 1, text: 'Found the bugs. applyDiscount subtracts the percentage directly.' },
      { step: 2, text: 'The cart line total bug is fixed. The pricing calculation now correctly applies discounts.' },
      { step: 3, text: 'The cart line total bug is fixed - that test now passes. Let me check the tax bug.' },
      { step: 4, text: 'The cart line total bug is fixed. The issue was in applyDiscount.' },
      { step: 5, text: 'The cart line total bug is fixed. The test now passes: 10 items at 3.00 costs 28.50.' },
    ];
    const actions = [{ name: 'apply_patch', path: 'src/pricing.js', ok: true, added: 2, removed: 2, step: 2 },
      { name: 'run_tests', target: 'npm test', ok: false, step: 3 }];
    const kept = new Set(actions);
    const models = [];
    const feed = { pushUser() {}, pushAction() {}, pushModel: (said, text, o) => models.push({ text, last: o && o.last }) };
    const drawn = ts.pushTurn([], {}, 0, { actions, kept, narration, steers: [], settled: (t, n) => n.text, feed, ctx: { openDiff: null } });
    assert.strictEqual(drawn, true);
    const mid = models.filter((m) => !m.last).map((m) => m.text);
    assert.deepStrictEqual(mid, ['Found the bugs. applyDiscount subtracts the percentage directly.'], JSON.stringify(mid));
    assert.ok(models.some((m) => m.last && /28\.50/.test(m.text)), 'the RESULT is drawn');
  });
};
