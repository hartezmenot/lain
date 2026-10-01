'use strict';

/**
 * BOUNDED WAITS LEAVE NO TIMERS (Phase 8.2, src/deadline.js). A finished
 * operation must not keep its 30–120 s deadline armed: under the Preview's
 * stream that was hundreds of live timers, and a process that could not exit.
 */

const assert = require('assert');
const { test } = require('../helpers');

module.exports = async function () {
  const d = require('../../src/deadline');
  const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;

  await test('DEADLINE: the work\'s answer, at once — and its long deadline is gone with it', async () => {
    const before = timers();
    assert.strictEqual(await d.race(Promise.resolve(7), 120000), 7);
    assert.strictEqual(timers(), before, 'no 120 s timer left behind');
  });

  await test('DEADLINE: work that never answers gets the fallback, or the throw, when the bound passes', async () => {
    assert.deepStrictEqual(await d.race(new Promise(() => {}), 15, () => ({ ok: false, why: 'late' })), { ok: false, why: 'late' });
    assert.strictEqual(await d.race(new Promise(() => {}), 15), undefined);
    await assert.rejects(d.race(new Promise(() => {}), 15, () => { throw new Error('never ready'); }), /never ready/);
  });

  await test('DEADLINE: a hundred finished calls leave nothing armed (the Preview stream\'s shape)', async () => {
    const before = timers();
    for (let i = 0; i < 100; i++) await d.race(Promise.resolve(i), 30000, () => ({ ok: false }));
    assert.strictEqual(timers(), before);
    assert.ok(!require('fs').readFileSync(require.resolve('../../src/harnessapp/previewroutes'), 'utf8').includes('Promise.race([p, new Promise((r) => setTimeout('), 'the preview routes use it');
  });
};
