'use strict';

/**
 * LEGACY TEST SUPERVISORS — the diagnostic classifies from evidence and never
 * stops anything by itself. Every case here uses INJECTED facts (rows, liveness,
 * registry, homes): no test reads, let alone stops, a real process.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');
const isolation = require('../harness/isolation');

module.exports = async function () {
  const lp = require('../../src/legacyprocs');
  const tmp = isolation.tmp('legacy-');
  const own = path.join(tmp, 'not-temp-own-home');
  const liveHome = path.join(tmp, 'lain-run-live', 'home', 'supervisor-home');
  fs.mkdirSync(path.join(liveHome, 'supervisor'), { recursive: true });
  fs.writeFileSync(path.join(liveHome, 'supervisor', 'endpoint.json'), JSON.stringify({ pid: 303, port: 5555 }));
  const bin = 'D:\\lain\\rust\\lain-supervisor\\target\\release\\lain-supervisor.exe serve --home ';
  const rows = [
    { pid: 101, ppid: 9001, start: '2026-09-24T10:00:00Z', cmd: bin + path.join(tmp, 'lain-run-gone', 'home', 'supervisor-home') },
    { pid: 202, ppid: 9002, start: '2026-09-24T10:00:00Z', cmd: bin + path.join(tmp, 'lain-run-parent', 'home') },
    { pid: 303, ppid: 9003, start: '2026-09-24T10:00:00Z', cmd: bin + liveHome },
    { pid: 404, ppid: 9004, start: '2026-09-24T10:00:00Z', cmd: bin + path.join(tmp, 'lain-run-reg', 'home') },
    { pid: 505, ppid: 9005, start: '2026-09-24T10:00:00Z', cmd: bin + 'C:\\Users\\someone\\.lain-v2' },
    { pid: 606, ppid: 9006, start: '2026-09-24T10:00:00Z', cmd: '' },
  ];
  const facts = { rows, tmp, alive: [9002], registered: [404], ownHome: own };

  await test('LEGACY: each candidate is classified from its evidence, not its name', () => {
    const r = lp.scan(facts);
    const by = Object.fromEntries(r.candidates.map((c) => [c.pid, c]));
    assert.strictEqual(by[101].class, lp.CLASS.VERIFIED_ORPHAN, by[101].why.join('; '));
    assert.ok(by[101].why.includes('its home no longer exists'));
    assert.strictEqual(by[202].class, lp.CLASS.POSSIBLY_ACTIVE, 'a live parent may still own it');
    assert.strictEqual(by[303].class, lp.CLASS.POSSIBLY_ACTIVE, 'its home still names it');
    assert.strictEqual(by[303].port, 5555);
    assert.strictEqual(by[404].class, lp.CLASS.POSSIBLY_ACTIVE, 'the runtime registry owns it');
    assert.strictEqual(by[505].class, lp.CLASS.UNKNOWN, 'a home outside temp is never an orphan by inference');
    assert.strictEqual(by[606].class, lp.CLASS.UNKNOWN, 'no command line, no conclusion');
    assert.ok(r.candidates.every((c) => c.id === `${c.pid}@${c.start}`));
  });

  await test("LEGACY: this LAIN's own home is referenced state, even when it looks temporary", () => {
    const home = path.join(tmp, 'lain-run-mine', 'home');
    const r = lp.scan({ ...facts, rows: [{ pid: 707, ppid: 1, start: 'x', cmd: bin + home }], ownHome: home });
    assert.strictEqual(r.candidates[0].class, lp.CLASS.POSSIBLY_ACTIVE);
  });

  await test('LEGACY: stop needs a selection and re-verifies each id; an unknown id stops nothing', () => {
    assert.strictEqual(lp.stop([]).ok, false);
    const r = lp.stop(['999999999@1970-01-01T00:00:00Z']);
    assert.strictEqual(r.ok, false);
    assert.ok(/no longer running/.test(r.results[0].why));
  });
};
