'use strict';

/**
 * THE FUNNEL IS CACHE-STABLE (prompt audit F3): the tool list — part of the
 * cached prompt prefix — never changes between two steps of one turn, only
 * grows across turns, and never narrows after the whole registry was sent.
 */

const assert = require('assert');
const { test } = require('../helpers');

module.exports = async function () {
  const tf = require('../../src/toolfunnel');
  const names = Object.values(tf.FAMILIES).flat();

  await test('FUNNEL F3: a miss is counted and does NOT widen the turn it happened in', () => {
    const s = {};
    tf.open(s, 'explain');
    const before = tf.filter(s, names);
    assert.ok(tf.miss(s, 'run_tests'));
    assert.deepStrictEqual(tf.filter(s, names), before, 'same list for the next step of this turn');
    assert.strictEqual(tf.view(s).misses.length, 1);
    tf.close(s);
    tf.open(s, 'explain');
    assert.ok(tf.shows(s, 'run_tests'), 'the missed family joins from the next turn');
  });

  await test('FUNNEL F3: a session’s list only grows — another shape adds, nothing is taken away', () => {
    const s = {};
    tf.open(s, 'rename');
    const renameSet = tf.filter(s, names);
    tf.close(s);
    tf.open(s, 'explain');
    const after = tf.filter(s, names);
    for (const n of renameSet) assert.ok(after.includes(n), `${n} stayed`);
    assert.ok(after.includes('lain_workspace'), 'explain added its own');
    assert.deepStrictEqual(after, names.filter((n) => after.includes(n)), 'registry order, whatever order families joined');
  });

  await test('FUNNEL F3: after the whole registry was sent, a focused turn does not narrow it', () => {
    const s = {};
    tf.open(s, null);
    assert.strictEqual(s._funnelSticky, 'all');
    assert.strictEqual(tf.open(s, 'explain'), null, 'no funnel: the whole registry, again');
    assert.strictEqual(tf.filter(s, names).length, names.length);
  });
};
