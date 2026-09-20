'use strict';

/**
 * THE FIGURES ON THE LIVE ROW.
 *
 * Two defects are kept fixed here, and both of them were visible on screen:
 *
 *   `1000K`   the compact formatter rounded 999,600 up to four significant
 *             figures inside a three-figure unit, and printed a unit nobody
 *             writes. Past a thousand thousand you say `1.0M`.
 *
 *   A TABLE   the row carried input, cache reads, output and the open
 *             request's input side — four numbers in a corner, scanned by
 *             nobody, led by the one least connected to what the model was
 *             doing. The row states OUTPUT; `/token` states the rest with its
 *             provenance.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { tok, tokens } = require('../../src/ui/telemetry');

module.exports = async function () {
  await test('TOK: three significant figures, exactly as specified', () => {
    assert.strictEqual(tok(847), '847');
    assert.strictEqual(tok(1_000), '1.0K');
    assert.strictEqual(tok(12_400), '12.4K');
    assert.strictEqual(tok(999_000), '999K');
    assert.strictEqual(tok(1_000_000), '1.0M');
    assert.strictEqual(tok(12_400_000), '12.4M');
  });

  await test('TOK: the rounding never carries out of its own unit', () => {
    // THE REPORTED DEFECT. `999,600 / 1000` is `999.6`, which rounds to `1000`
    // — so the K branch printed `1000K`. The unit has to be chosen from the
    // ROUNDED value, not from the one before rounding.
    assert.strictEqual(tok(999_500), '1.0M');
    assert.strictEqual(tok(999_999), '1.0M');
    assert.strictEqual(tok(999_499), '999K', 'and just below the carry it stays in K');
    assert.strictEqual(tok(99_960), '100K', 'the same carry one decimal place down');
    for (let v = 0; v < 2_000_000_000; v = Math.floor(v * 1.37) + 7) {
      assert.doesNotMatch(tok(v), /^1000/, `tok(${v}) = ${tok(v)} — a four-digit mantissa`);
    }
  });

  await test('TOK: is total, and never negative', () => {
    assert.strictEqual(tok(0), '0');
    assert.strictEqual(tok(null), '0');
    assert.strictEqual(tok(-5), '0');
    assert.strictEqual(tok('not a number'), '0');
  });

  await test('HEADER: the row states OUTPUT and nothing else', () => {
    const row = tokens({
      usage: { inputTokens: 59_243_462, outputTokens: 202_310, cacheReadTokens: 38_000_000 },
    });
    assert.strictEqual(row, '↓202K');
    // The three suppressed quantities must not appear in any form. This is the
    // whole point of the change: input is the largest figure in the session and
    // it is not what the row is for.
    assert.ok(!row.includes('↑'), 'no input figure');
    assert.ok(!row.includes('⚡'), 'no cache figure');
    assert.ok(!/59|38/.test(row), 'no input or cache magnitude leaks in');
  });

  await test('HEADER: an open request is marked, never invented', () => {
    // No provider LAIN speaks to states output mid-stream, so the marker is a
    // bare `+`. A rising number here would be a figure nobody measured.
    assert.strictEqual(tokens({ usage: { outputTokens: 2_100 }, requestOpen: true }), '↓2.1K +');
    assert.strictEqual(tokens({ requestOpen: true }), '↓…',
      'the first request of a session has no total to qualify');
  });

  await test('HEADER: a session that has not spoken shows nothing at all', () => {
    // Not `↓0`. Zero is a measurement, and nobody made it.
    assert.strictEqual(tokens({}), '');
    assert.strictEqual(tokens(null), '');
    assert.strictEqual(tokens({ usage: { inputTokens: 5_000, outputTokens: 0 } }), '',
      'input alone does not put a figure on the row');
  });
};
