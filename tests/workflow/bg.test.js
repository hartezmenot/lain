'use strict';

/**
 * WORKFLOW SMOKE — `/bg` (§28–31, §35), in a REAL pseudo-console.
 *
 *   a broad suite starts → `/bg` is typed → the SAME process keeps running →
 *   the foreground does independent valid work → the suite finishes →
 *   `BG COMPLETE` → the result rejoins the original session and reaches the
 *   model on its next request.
 *
 * Needs a PTY driver (LAIN_TTY_PYTHON, see tests/tty/realtty.js). Without one
 * it reports UNSUPPORTED and says why — that is not a pass.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const tty = require('../tty/realtty');

module.exports = async function () {
  const probe = tty.available();
  if (!probe.ok) {
    await test('WORKFLOW /bg: UNSUPPORTED here — no pseudo-console driver', () => {
      process.stdout.write(`    (not run: ${probe.why}; set LAIN_TTY_PYTHON to a Python with pywinpty and pyte)\n`);
    });
    return;
  }
  const cwd = tmpdir('wf-bg-');
  fs.writeFileSync(path.join(cwd, 'slow.js'), [
    "const fs = require('fs');",
    "fs.appendFileSync('pids.txt', `start ${process.pid} ${Date.now()}\\n`);",
    "setTimeout(() => { console.log('3 passed, 0 failed'); fs.appendFileSync('pids.txt', `done ${process.pid} ${Date.now()}\\n`); }, 6000);",
  ].join('\n'));
  const run = await tty.runTty({
    cols: 110, rows: 34, cwd,
    script: [
      { text: '', tool_calls: [{ name: 'run_tests', input: { command: 'node slow.js' } }] },
      { text: '', tool_calls: [{ name: 'write_file', input: { path: 'notes.txt', content: 'independent work\n' } }] },
      { text: 'Independent work done while the suite runs in the background.' },
      { text: 'Background result seen: 3/3.' },
    ],
    steps: [
      { until: 'Ask Noema', timeout: 30000 },
      { send: 'run the broad smoke suite\r' },
      { wait: 2000 },
      { send: '/bg\r' },
      { until: 'Independent work done', timeout: 30000 },
      { snap: 'foreground', settle: 300 },
      { until: 'BG COMPLETE', timeout: 30000 },
      { snap: 'complete', settle: 500 },
      { send: 'continue\r' },
      { until: 'Background result seen', timeout: 30000 },
      { snap: 'after', settle: 500 },
    ],
  });

  await test('WORKFLOW /bg: every screen the flow waits for arrived', () => {
    assert.deepStrictEqual(run.timeouts, [], run.snaps.map((s) => `--- ${s.name}\n${tty.visible(s)}`).join('\n'));
  });

  await test('WORKFLOW /bg: the SAME process kept running — started once, never restarted', () => {
    const rows = fs.readFileSync(path.join(cwd, 'pids.txt'), 'utf8').trim().split('\n').map((l) => l.split(' '));
    const starts = rows.filter((r) => r[0] === 'start');
    const dones = rows.filter((r) => r[0] === 'done');
    assert.strictEqual(starts.length, 1, 'one start');
    assert.strictEqual(dones.length, 1, 'one finish');
    assert.strictEqual(starts[0][1], dones[0][1], 'the same pid');
  });

  await test('WORKFLOW /bg: the foreground did independent work WHILE the process ran', () => {
    const done = Number(fs.readFileSync(path.join(cwd, 'pids.txt'), 'utf8').split('\n').find((l) => l.startsWith('done')).split(' ')[2]);
    const notes = fs.statSync(path.join(cwd, 'notes.txt')).mtimeMs;
    assert.ok(notes < done, `notes.txt (${notes}) was written before the suite finished (${done})`);
    assert.match(tty.visible(run.byName.foreground), /Independent work done/);
  });

  await test('WORKFLOW /bg: BG COMPLETE with the real counts, and the result rejoined the session and reached the model', () => {
    assert.match(tty.visible(run.byName.complete), /BG COMPLETE · node slow\.js · 3\/3/);
    const d = path.join(run.configDir, 'sessions');
    const file = fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => path.join(d, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = (s.bgResults || [])[0];
    assert.ok(r, 'a rejoined result is on the original session');
    assert.strictEqual(r.summary, '3/3');
    assert.strictEqual(r.delivered, true, 'delivered to the model on its next request');
    assert.ok(r.turnId, 'attached to the turn that started it');
  });
};
