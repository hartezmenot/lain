'use strict';

/**
 * FAST AUTO-BACKGROUND (bgdetach.js, 2026-09-23).
 *
 * FAST means wall-clock: a full suite still running after the threshold is
 * detached exactly as `/bg` would — same PID, the result rejoins the task, and
 * the foreground is free. NORMAL waits for it. A targeted run is never touched.
 * Real App, real child process, mock model.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const mock = require('../../src/mockprovider');
const bg = require('../../src/bgdetach');

function fixture() {
  const dir = tmpdir('fastbg-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fastbg', scripts: { test: 'node slow.js' } }));
  fs.writeFileSync(path.join(dir, 'slow.js'), "setTimeout(() => { console.log('3 passing'); }, 2500);\n");
  const sf = path.join(dir, 'script.json');
  fs.writeFileSync(sf, JSON.stringify([
    { text: 'Running the suite.', tool_calls: [{ name: 'run_bash', input: { command: 'npm test' } }] },
    { text: 'Carrying on with the docs while it runs.' },
  ]));
  return { dir, sf };
}

async function turn(profile) {
  const { dir, sf } = fixture();
  process.env.LAIN_PROVIDER = 'mock'; process.env.LAIN_MOCK_SCRIPT = sf; process.env.LAIN_AUTO_BG_MS = '400';
  mock._reset();
  try {
    const { App } = require('../../src/app');
    const a = new App({ interactive: false, cwd: dir });
    a.cfg.trustedPaths = [{ path: dir, level: 'TRUSTED' }];
    a.render.write = () => {}; a.render.notice = () => {}; a.render.turnSummary = () => {}; a.render.nl = () => {};
    a.session.save = () => {};
    require('../../src/profile').set(a.session, profile);
    const t0 = Date.now();
    await a.handle('run the tests');
    const ms = Date.now() - t0;
    const result = a.session.messages.find((m) => m.role === 'tool');
    return { a, ms, result: String(result && result.content) };
  } finally {
    delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; delete process.env.LAIN_AUTO_BG_MS; mock._reset();
  }
}

module.exports = async function () {
  await test('FAST AUTO-BG: a full suite still running after the threshold is detached — the turn goes on, the result rejoins', async () => {
    const { a, ms, result } = await turn('FAST');
    assert.match(result, /DETACHED by FAST \(auto-background: (full suite|final smoke|long build\/suite) still running/);
    assert.ok(ms < 2300, `the foreground did not wait for the suite (${ms} ms)`);
    const deadline = Date.now() + 8000;
    while (!(a.session._bgResults || []).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const r = (a.session._bgResults || [])[0];
    assert.ok(r, 'the result rejoined the task');
    assert.strictEqual(r.ok, true);
    assert.match(r.tail, /3 passing/, 'the same process finished — nothing restarted');
  });

  await test('FAST AUTO-BG: NORMAL waits in the foreground; nothing is detached', async () => {
    const { ms, result } = await turn('NORMAL');
    assert.ok(!/DETACHED/.test(result), result.slice(0, 200));
    assert.ok(ms >= 2400, `NORMAL waited (${ms} ms)`);
  });

  await test('FAST AUTO-BG: eligibility — full suites, builds and the final smoke; never a targeted run', () => {
    const e = (label, tool = 'run_bash', input = {}) => bg.longEligible({ label, tool, input, cwd: process.cwd() });
    assert.ok(e('npm test'));
    assert.ok(e('cargo build --release'));
    assert.ok(e('node tests/run.js smoke'));
    assert.strictEqual(e('npm test -- retry'), null, 'targeted');
    assert.strictEqual(e('pytest -k retry'), null, 'targeted');
    assert.strictEqual(e('node tests/unit/retry.test.js'), null, 'one file');
    assert.strictEqual(e('ls -la'), null);
  });
};
