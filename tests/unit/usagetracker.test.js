'use strict';

/**
 * THE USAGE TRACKER'S NUMBERS (usagetracker.js) — Core computes them once; the Harness's ring and dropdown only
 * render them. The ring is what REMAINS of the tightest window the active route's account reported, per lane;
 * nothing is invented when nothing was reported, and unrelated providers' windows are never combined.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

module.exports = async function () {
  const t = require('../../src/usagetracker');
  const si = require('../../src/sessionintel');
  const fabric = require('../../src/fabric/index');

  const now = Date.now();
  const ROUTES = {
    coding: { display: { resolved: true, text: 'Codex · GPT-6 Sol · High' }, family: 'codex', familyLabel: 'Codex', policyLabel: 'Automatic fallback', backing: { id: 'codex:a', name: 'Personal' } },
    chat: { display: { resolved: false, problem: 'no model chosen' }, family: null },
  };
  const FAMILIES = {
    codex: { accounts: [
      { id: 'codex:a', name: 'Personal', quota: [
        { label: '5h', usedPercent: 26, resetsAt: now + 2 * 3600e3 },
        { label: 'weekly', remainingPercent: 52, resetsAt: now + 3 * 864e5 },
        { label: 'monthly', usedPercent: 99, resetsAt: now - 1000, expired: true },
      ] },
      { id: 'codex:b', name: 'Work', quota: [], limited: { until: now + 3600e3 } },
      { id: 'codex:c', name: 'Spare', quota: [] },
    ] },
  };
  async function withRoutes(routes, fn) {
    const lane0 = si.lane;
    const fam0 = fabric.family;
    si.lane = (app, session, lane) => routes[lane] || null;
    fabric.family = (app, id) => FAMILIES[id] || null;
    try { return await fn(); } finally { si.lane = lane0; fabric.family = fam0; }
  }
  const app = { session: {}, cfg: {} };

  await test('USAGE TRACKER: the ring is what remains of the tightest live window — an expired one never counts', () => withRoutes(ROUTES, () => {
    const v = t.laneView(app, 'coding');
    assert.strictEqual(v.route.resolved, true);
    assert.strictEqual(v.account.name, 'Personal');
    assert.deepStrictEqual(v.windows.map((w) => [w.label, w.remainingPercent, w.expired]), [['5h', 74, false], ['weekly', 52, false], ['monthly', 1, true]]);
    assert.strictEqual(v.ring.remainingPercent, 52, 'weekly (52% left) runs out before the 5-hour window (74% left)');
    assert.strictEqual(v.ring.label, 'weekly');
    assert.strictEqual(v.ring.tone, 'ok');
    assert.strictEqual(v.windows[2].tone, 'bad');
  }));

  await test('USAGE TRACKER: nothing reported means no number — and an unresolved route says "Select model"', () => withRoutes({
    coding: { ...ROUTES.coding, backing: { id: 'codex:c', name: 'Spare' } },
    chat: ROUTES.chat,
  }, () => {
    const v = t.laneView(app, 'coding');
    assert.strictEqual(v.ring, null);
    assert.strictEqual(v.windows.length, 0);
    assert.match(v.note, /has not reported quota/);
    const c = t.laneView(app, 'chat');
    assert.strictEqual(c.route.resolved, false);
    assert.strictEqual(c.route.text, 'Select model');
    assert.strictEqual(c.ring, null);
    assert.strictEqual(c.account, null);
  }));

  await test('USAGE TRACKER: a limited account with no windows reads 0% left until the provider lifts it', () => withRoutes({
    coding: { ...ROUTES.coding, backing: { id: 'codex:b', name: 'Work' } },
  }, () => {
    const v = t.laneView(app, 'coding');
    assert.strictEqual(v.ring.remainingPercent, 0);
    assert.strictEqual(v.ring.label, 'limited');
    assert.strictEqual(v.ring.tone, 'bad');
  }));

  await test('USAGE TRACKER: each lane has its own ring — Chat and the Coding Agent are never merged', () => withRoutes(ROUTES, () => {
    const both = t.lanes(app);
    assert.ok(both.coding.ring && both.coding.ring.remainingPercent === 52);
    assert.strictEqual(both.chat.ring, null);
  }));

  await test('USAGE TRACKER: the Harness renders Core\'s values — no quota arithmetic of its own', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'lain-harness', 'page', 'shell', 'tracker.js'), 'utf8');
    assert.match(src, /S\.tracker/, 'the pill reads the snapshot\'s tracker');
    assert.match(src, /\/api\/usage\/tracker/, 'the dropdown reads Core\'s tracker route');
    for (const banned of [/\.quota\b/, /remainingOf\(/, /\/api\/usage\/windows/, /usedPercent/]) assert.doesNotMatch(src, banned, `tracker.js must not compute: ${banned}`);
  });

  await test('USAGE TRACKER: receipts\' model ids are named for people — unknown ones say so', () => {
    assert.strictEqual(t.modelName(app, 'unknown'), 'Unattributed');
    assert.strictEqual(t.modelName(app, '(none)'), 'Unattributed');
    assert.strictEqual(t.modelName(app, 'gpt-6-mini'), 'GPT 6 Mini');
  });
};
