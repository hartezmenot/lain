'use strict';

/** §47 — auto-compaction is silent maintenance; one tip, suppressed until usage grows. */

const assert = require('assert');
const { test } = require('../helpers');
const tip = require('../../src/compacttip');

function fakeApp() {
  const said = [];
  const app = {
    ui: { enabled: true, noteSystem: (m, l) => said.push({ m, l }) },
    render: { openSurface: () => said.push({ surface: true }) },
    _opRows: [],
  };
  return { app, said };
}

module.exports = async function () {
  await test('COMPACT: a routine auto-compaction notice opens no surface and writes nothing', () => {
    const { app, said } = fakeApp();
    const handled = tip.onNotice(app, { type: 'notice', level: 'info', surface: 'COMPACT', message: 'Context compacted · 296k → 294k' });
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(said, []);
    assert.match(app._lastCompaction.message, /296k/, 'kept for /token, not drawn');
  });

  await test('COMPACT: a stuck compaction is still said once, as a warning', () => {
    const { app, said } = fakeApp();
    tip.onNotice(app, { type: 'notice', level: 'warn', surface: 'COMPACT', message: 'still 900 messages against an 800-message limit' });
    assert.strictEqual(said.length, 1);
    assert.strictEqual(said[0].l, 'warn');
  });

  await test('COMPACT: other surfaces are not taken', () => {
    const { app } = fakeApp();
    assert.strictEqual(tip.onNotice(app, { surface: 'PROVIDER', message: 'x' }), false);
  });

  await test('COMPACT: the tip shows once when usage is high, then waits for a material rise', () => {
    let d = tip.decide(0.5, 0);
    assert.strictEqual(d.show, false);
    d = tip.decide(0.72, 0);
    assert.strictEqual(d.show, true);
    const at = d.level;
    assert.strictEqual(tip.decide(0.75, at).show, false, 'no repeat for a small rise');
    assert.strictEqual(tip.decide(0.8, at).show, false);
    assert.strictEqual(tip.decide(0.9, at).show, true, 'shown again once materially higher');
    assert.strictEqual(tip.decide(0.3, at).level, 0, 'a large drop (after /compact) re-arms it');
  });

  await test('COMPACT: the tip text points at /compact and nothing else', () => {
    assert.strictEqual(tip.TIP, 'TIP · /compact can reduce context usage.');
  });
};
