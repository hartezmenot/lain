'use strict';

/**
 * ESTIMATED EFFECTIVE CAPACITY (resetwindows.js) — from paired readings of the provider's % and the tokens LAIN
 * observed in the same window. An estimate only, with its confidence; "Insufficient data" until there is enough;
 * use outside LAIN (the % moved, LAIN saw nothing) is excluded and lowers the confidence.
 */

const assert = require('assert');
const { test } = require('../helpers');

module.exports = async function () {
  const rw = require('../../src/resetwindows');
  const H = 3600e3;
  const inst = (resetsAt, pts) => ({ source: 's', window: 'primary', resetsAt, series: pts.map(([u, t], i) => [resetsAt - 5 * H + i * 60e3, u, t]) });

  await test('CAPACITY: nothing to go on says "Insufficient data" — never a number', () => {
    assert.strictEqual(rw.capacity([]).confidence, 'Insufficient data');
    assert.strictEqual(rw.capacity([]).tokens, null);
    const one = rw.capacity([inst(1e12, [[10, 100000], [14, 180000]])]);
    assert.strictEqual(one.tokens, null, 'one step is not an estimate');
    assert.strictEqual(one.readings, 1);
    assert.match(one.basis, /not enough/);
  });

  await test('CAPACITY: agreeing readings give "~N equivalent tokens" — High only with many readings over a long span', () => {
    const pts = [[0, 0]];
    for (let i = 1; i <= 8; i++) pts.push([i * 4, i * 80000]);       // 4 points of % per 80K tokens → 2M per 100%
    const c = rw.capacity([inst(1e12, pts)]);
    assert.strictEqual(c.tokens, 2000000);
    assert.strictEqual(c.confidence, 'High');
    assert.strictEqual(c.label, 'Estimated effective capacity');
    assert.strictEqual(c.unit, 'equivalent tokens');
    const few = rw.capacity([inst(1e12, pts.slice(0, 4))]);
    assert.strictEqual(few.tokens, 2000000);
    assert.strictEqual(few.confidence, 'Low', 'three readings over 12 points is only Low');
  });

  await test('CAPACITY: whole-percent readings carry tokens into the next rise; a reset starts over', () => {
    // 10% → 10% (tokens still flow) → 12%: one step of 2 points for all 60K tokens.
    const c = rw.capacity([inst(1e12, [[10, 0], [10, 30000], [12, 60000], [14, 120000], [2, 5000], [6, 125000]])]);
    // steps: (2pt, 60K), (2pt, 60K), fall → anchor, (4pt, 120K)  → 240K over 8 points = 3M per 100%
    assert.strictEqual(c.readings, 3);
    assert.strictEqual(c.span, 8);
    assert.strictEqual(c.tokens, 3000000);
  });

  await test('CAPACITY: use outside Noema is excluded and lowers the confidence', () => {
    const pts = [[0, 0]];
    for (let i = 1; i <= 8; i++) pts.push([i * 4, i * 80000]);
    pts.push([40, 640000]);                                          // the % moved, LAIN saw nothing
    const c = rw.capacity([inst(1e12, pts)]);
    assert.strictEqual(c.outside, 1);
    assert.strictEqual(c.tokens, 2000000, 'the outside step does not skew the estimate');
    assert.notStrictEqual(c.confidence, 'High');
    assert.match(c.basis, /moved with no Noema use/);
  });

  await test('CAPACITY: only the most recent window instances count (a plan change ages out)', () => {
    const old = [];
    for (let k = 0; k < 6; k++) old.push(inst(1e12 + k * 5 * H, [[0, 0], [10, 100000], [20, 200000]]));   // 1M per 100%
    const fresh = inst(1e12 + 40 * 5 * H, [[0, 0], [10, 400000], [20, 800000]]);                              // 4M per 100%
    const c = rw.capacity(old.concat([fresh]));
    assert.ok(c.tokens > 1000000 && c.tokens < 4000000, `blends at most six instances (${c.tokens})`);
    assert.strictEqual(c.readings, 12, 'six instances of two steps — the oldest dropped');
  });

  await test('CAPACITY: a live window records paired readings as the provider\'s % moves, and carries the estimate', () => {
    const ai = require('../../src/accountinstances');
    const usage = require('../../src/usage');
    const list0 = ai.list;
    const read0 = usage.read;
    const t0 = Date.now();
    const resetsAt = t0 + 2 * H;
    let used = 10;
    let rows = [];
    ai.list = () => [{ id: 'codex:cap1', driver_id: 'codex', display_name: 'Cap', identity: { email: 'cap@example.com' },
      limits: { reportedBy: 'provider', windows: [{ id: 'primary', label: '5h', usedPercent: used, resetsAt, windowMins: 300 }] } }];
    usage.read = () => rows;
    const row = (n, tokens) => ({ id: `r${n}`, at: t0 - H + n * 1000, account: 'codex:cap1', input: tokens, output: 0 });
    try {
      rows = [row(1, 100000)];
      let w = rw.windows({}, { now: t0 + 1 }).find((x) => x.source === 'codex:cap1');
      assert.strictEqual(w.capacity.confidence, 'Insufficient data');
      used = 14; rows = rows.concat([row(2, 80000)]);
      rw.windows({}, { now: t0 + 2 });
      used = 18; rows = rows.concat([row(3, 80000)]);
      w = rw.windows({}, { now: t0 + 3 }).find((x) => x.source === 'codex:cap1');
      assert.strictEqual(w.observed.tokens, 260000);
      assert.strictEqual(w.capacity.readings, 2);
      assert.strictEqual(w.capacity.tokens, 2000000, '160K tokens moved the % by 8 points');
      assert.strictEqual(w.capacity.confidence, 'Low');
    } finally { ai.list = list0; usage.read = read0; }
  });
};
