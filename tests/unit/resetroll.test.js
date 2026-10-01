'use strict';

/**
 * THE RESET BOUNDARY ROLLS NOEMA'S OWN BUCKET (2026-10-01).
 *
 * A provider window whose reset has passed, with no new reading yet: Noema's observed bucket starts again in the
 * next window (end projected from the reported reset + the window length), the window that closed becomes
 * "previous" with the % last seen before the reset, and the provider's current % is "not reported" — never the stale
 * figure, and never a claim that Noema reset anything upstream. API connections (Z.ai's monitor) take part too.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const H = 3600 * 1000;

module.exports = async function () {
  const saved = process.env.LAIN_CONFIG_DIR;
  let rows0 = null;
  process.env.LAIN_CONFIG_DIR = tmpdir('resetroll-');
  try {
    await test('RESET ROLL: past the provider reset the observed bucket starts again; the closed window is kept as previous', () => {
      const cfg = process.env.LAIN_CONFIG_DIR;
      const now = Date.now();
      const oldReset = now - 1 * H;          // the 5-hour window ended an hour ago
      void cfg; void fs; void path;
      // THE ONE PROJECTION (fabric/quotaview.js): the default Claude profile's 5-hour window, ended an hour ago.
      const qv = require('../../src/fabric/quotaview');
      rows0 = qv.rows;
      qv.rows = () => [{ id: 'claude-code', family: 'claude', name: 'Claude', instanceId: null, base: null, identity: null, quotaSource: 'reported by Claude Code',
        windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 80, remainingPercent: 20, resetsAt: oldReset, mins: 300 }] }];
      const usage = require('../../src/usage');
      const mk = (id, at, input) => usage.record({ id, at, ok: true, runtime: 'claude-code', transport: 'runtime', model: 'claude', receipt: { inputTokens: input, outputTokens: 10 } });
      mk('before', oldReset - 2 * H, 1000);   // inside the window that closed
      mk('after', now - 0.5 * H, 300);        // inside the new one
      const rw = require('../../src/resetwindows');
      // A reading taken while the old window was live records its last % (the snapshot history keeps it).
      const live = rw.windows(null, { now: oldReset - 10 * 60 * 1000 }).find((w) => w.source === 'claude-code');
      assert.strictEqual(live.usedPercent, 80);
      assert.strictEqual(live.rolled, false);
      const w = rw.windows(null, { now }).find((x) => x.source === 'claude-code');
      assert.strictEqual(w.rolled, true, 'the window in force is the NEXT one');
      assert.strictEqual(w.resetsAt, oldReset + 5 * H, 'its end is the reported reset plus one window');
      assert.strictEqual(w.usedPercent, null, 'the provider has not reported it yet — no stale 80%');
      assert.match(w.pending, /not reported this window since it reset/);
      assert.strictEqual(w.observed.input, 300, 'only use after the boundary counts');
      assert.strictEqual(w.previous.observed.input, 1000, 'the closed window is kept');
      assert.strictEqual(w.previous.usedPercent, 80, 'with the % last seen before it reset');
      assert.ok(!JSON.stringify(w).match(/reset (?:the )?provider|quota was reset/i), 'nothing claims an upstream reset');
    });

    await test('RESET ROLL: an API connection\'s recorded windows (Z.ai monitor) keep their id and length and are bounded', () => {
      const store = require('../../src/fabric/store');
      store.recordQuota('acct-zai', { windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 26, resetsAt: Date.now() + 2 * H }, { id: 'seven_day', label: 'weekly', usedPercent: 39, resetsAt: Date.now() + 50 * H }], source: 'Z.ai (monitor)' });
      const q = store.read().quota['acct-zai'];
      assert.deepStrictEqual(q.windows.map((x) => [x.id, x.label]), [['five_hour', '5-hour'], ['seven_day', 'weekly']]);
    });
  } finally {
    if (rows0) require('../../src/fabric/quotaview').rows = rows0;
    if (saved === undefined) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = saved;
  }
};
