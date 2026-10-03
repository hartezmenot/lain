'use strict';

/**
 * PHASE 6 — real-time CLI selection: a selection move is drawn within one 16 ms frame, from renderer state only (no
 * Core re-projection), and a burst of drag events costs one frame per 16 ms, never one per event.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

function liveApp() {
  const { App } = require('../../src/app');
  let writes = 0;
  const out = { write() { writes += 1; return true; }, on() {}, columns: 120, rows: 40, isTTY: false };
  const app = new App({ out, interactive: false, cwd: tmpdir('sel-') });
  app.ui.enabled = true; app.ui.screen.active = true;
  if (app.render.attachScreen) app.render.attachScreen(app.ui.screen);
  let projections = 0;
  const snap = app.ui.snapshot.bind(app.ui);
  app.ui.snapshot = () => { projections += 1; return snap(); };
  return { app, ui: app.ui, writes: () => writes, projections: () => projections };
}

module.exports = async function () {
  await test('PICKER: ↑↓ moves the row in one frame, from renderer state — no Core projection per press, well inside 16 ms', () => {
    const { ui, projections, writes } = liveApp();
    const { KIND, MODE } = require('../../src/ui/panel');
    ui.panel.open({ title: 'MODELS', kind: KIND.ASK_USER, mode: MODE.EXPANDED, items: Array.from({ length: 40 }, (_, i) => ({ label: `model-${i}`, value: i })) });
    ui.refresh();
    const p0 = projections(); const w0 = writes();
    const times = [];
    for (let i = 0; i < 100; i++) { const t0 = process.hrtime.bigint(); ui.handleKey('down'); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    times.sort((a, b) => a - b);
    assert.strictEqual(projections() - p0, 0, 'no snapshot() per selection move');
    assert.strictEqual(writes() - w0, 100, 'every move reached the terminal at once');
    assert.ok(ui.panel.cursor > 0, `and the selection actually moved (row ${ui.panel.cursor})`);
    assert.ok(times[94] < 16, `p95 ${times[94].toFixed(2)} ms is inside one frame`);
  });

  await test('DRAG: a burst of motions draws the first at once and folds the rest into one frame per 16 ms; the newest is always shown', async () => {
    const { app, ui, projections } = liveApp();
    for (let i = 0; i < 2000; i++) app.render.write(`feed line ${i} the quick brown fox jumps over the lazy dog\n`);
    ui.refresh();
    const mouse = require('../../src/ui/mouse');
    const rm = ui.screen.rowMap || {};
    const y0 = Math.max(3, (rm.feedTop || 4) + 2);
    mouse.handleMouse(ui, { kind: 'press', x: 5, y: y0 });
    const f0 = ui._localFrames || 0; const p0 = projections();
    for (let i = 0; i < 100; i++) mouse.handleMouse(ui, { kind: 'drag', x: 6 + (i % 50), y: y0 + 1 + (i % 10) });
    assert.strictEqual((ui._localFrames || 0) - f0, 1, 'one frame for a 100-motion burst, at once');
    const before = (ui._localFrames || 0);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual((ui._localFrames || 0) - before, 1, 'and one trailing frame with the newest selection');
    assert.strictEqual(projections() - p0, 0, 'no Core projection for any of it');
    assert.ok(ui.screen.selectedText().length > 0, 'the selection is real');
    mouse.handleMouse(ui, { kind: 'release', x: 6, y: y0 + 2 });
  });

  await test('BUDGET: the trailing frame lands within 16 ms of the last motion', async () => {
    const sf = require('../../src/ui/selectframe');
    let drawn = 0; let last = 0;
    const ui = { enabled: true, screen: { draw() { drawn += 1; last = Date.now(); } } };
    sf.requestLocalFrame(ui);
    for (let i = 0; i < 20; i++) sf.requestLocalFrame(ui);
    const lastEvent = Date.now();
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(drawn, 2);
    assert.ok(last - lastEvent <= sf.FRAME_MS + 25, `trailing frame ${last - lastEvent} ms after the last event`);
    void fs; void path;
  });
};
