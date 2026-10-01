'use strict';

/**
 * REAL TERMINAL — LAIN in a Windows pseudo-console, read back cell by cell.
 *
 * Evidence tier: REAL_TTY_VERIFIED (see tests/tty/realtty.js). SKIPS, and says
 * so, when no PTY driver is configured — that is not a pass.
 *
 *   B  Ctrl+PgDn from far up the transcript lands on the newest output, and a
 *      turn streaming after the jump stays attached to the bottom
 *   A  a typed `continue` is on screen once, as the user
 *      header tokens: output only, 12.4K, then the carry to 1.0M
 *      work timer: HH:MM:SS on the live row while a turn works
 *   K  resize 160 → 80 → 60 → 120 → 160 and a 232-column desktop width, during
 *      streaming, with CJK provider error text, /diff /lain /jobs open:
 *      no cell left or right of the content frame, nothing duplicated,
 *      nothing lost, and Ctrl+PgDn still reaches the newest output
 */

const assert = require('assert');
const { test } = require('../helpers');
const tty = require('../tty/realtty');

const CJK = '鉴权服务请求失败';

function assertInFrame(snap) {
  const bad = tty.escapes(snap);
  assert.deepStrictEqual(bad, [], `${snap.name} at ${snap.cols}x${snap.rows}: cells outside the content frame`);
}

const count = (snap, re) => (tty.visible(snap).match(re) || []).length;

module.exports = async function () {
  const probe = tty.available();
  if (!probe.ok) {
    await test('REAL TTY: skipped — no pseudo-console driver', () => {
      process.stdout.write(`    (skipped: ${probe.why}; set LAIN_TTY_PYTHON to a Python with pywinpty and pyte)\n`);
    });
    return;
  }

  const report = Array.from({ length: 120 }, (_, i) => `report line ${i + 1}`).join('\n');
  const first = await tty.runTty({
    cols: 100, rows: 30,
    script: [
      { text: `${report}\nEND-OF-REPORT-ONE`, outputTokens: 12400 },
      // The header is the output of the response in front of you: 999,600 is
      // the value that must carry to 1.0M rather than print 1000K.
      { text: 'SECOND-TURN-MARKER', delayMs: 3000, outputTokens: 999600 },
    ],
    steps: [
      { until: 'Ask Noema', timeout: 30000 },
      { send: 'print the long report\r' },
      { until: 'END-OF-REPORT-ONE', timeout: 30000 },
      { snap: 'afterReport', settle: 600 },
      { key: 'pageup' }, { key: 'pageup' }, { key: 'pageup' }, { key: 'pageup' },
      { snap: 'scrolled', settle: 400 },
      { key: 'ctrl-pagedown' },
      { snap: 'jumped', settle: 400 },
      { send: 'continue\r' },
      { wait: 1200 },
      { key: 'pageup' }, { key: 'pageup' },
      { key: 'ctrl-pagedown' },
      { snap: 'working', settle: 300 },
      { until: 'SECOND-TURN-MARKER', timeout: 30000 },
      { snap: 'streamedAfterJump', settle: 700 },
    ],
  });

  await test('REAL TTY: the driver reached every screen it waited for', () => {
    assert.deepStrictEqual(first.timeouts, []);
  });

  await test('REAL TTY B: Ctrl+PgDn jumps from far up the transcript straight to the newest output', () => {
    const { scrolled, jumped } = first.byName;
    assert.ok(!/END-OF-REPORT-ONE/.test(tty.visible(scrolled)), 'precondition: scrolled away from the end');
    assert.match(tty.visible(scrolled), /report line \d+/);
    assert.match(tty.visible(jumped), /END-OF-REPORT-ONE/, 'one key back to the newest row');
    assert.ok(!/\[6;5~|6;5~/.test(tty.visible(jumped)), 'nothing leaked into the composer');
    assert.match(tty.visible(jumped), /Ask Noema/, 'the composer is intact and empty');
  });

  await test('REAL TTY B: after the jump, a turn that streams keeps the view attached to the bottom', () => {
    assert.match(tty.visible(first.byName.streamedAfterJump), /SECOND-TURN-MARKER/,
      'new output arrived on screen with no further key');
  });

  await test('REAL TTY A: the typed `continue` is on screen once, as the user', () => {
    assert.strictEqual(count(first.byName.streamedAfterJump, /USER[A-Z ]* · continue\b/g), 1);
  });

  await test('REAL TTY: the header shows OUTPUT tokens at three figures — 12.4K, then the carry to 1.0M', () => {
    const header = (s) => s.text[0];
    assert.match(header(first.byName.afterReport), /12\.4K\s*$/, header(first.byName.afterReport));
    assert.match(header(first.byName.streamedAfterJump), /1\.0M\s*$/, header(first.byName.streamedAfterJump));
    assert.ok(!/999\.6K|1000K/.test(header(first.byName.streamedAfterJump)));
  });

  await test('REAL TTY: the work timer is on the live row while the turn works', () => {
    assert.match(tty.visible(first.byName.working), /\b\d\d:\d\d:\d\d\b/);
  });

  for (const s of first.snaps) {
    await test(`REAL TTY: ${s.name} stays inside the frame`, () => assertInFrame(s));
  }

  const json = JSON.stringify({ error: { type: 'authentication_error', message: `${CJK} ${CJK} upstream refused the key for route cc/claude ${'x'.repeat(120)}` } });
  const working = Array.from({ length: 6 }, (_, i) => ({
    text: `working step ${i + 1} ${CJK}`, delayMs: 700,
    tool_calls: [{ name: 'run_bash', input: { command: `node -e "console.log('s${i}')"` } }],
  }));
  const resize = await tty.runTty({
    cols: 160, rows: 34,
    script: [
      { text: `The provider answered:\n${json}\nUNIQUE-ANSWER-ONE`, tool_calls: [{ name: 'write_file', input: { path: 'newprovider.js', content: 'module.exports = 1;\nconst a = 2;\n' } }] },
      { text: 'wrote it. UNIQUE-DONE-ONE' },
      ...working,
      { text: 'FINAL-STREAM-MARKER' },
    ],
    steps: [
      { until: 'Ask Noema', timeout: 30000 },
      { send: `${CJK} please explain\r` },
      { until: 'UNIQUE-DONE-ONE', timeout: 30000 },
      { snap: 'w160', settle: 500 },
      { resize: [80, 30] }, { snap: 'w80', settle: 700 },
      { resize: [60, 26] }, { snap: 'w60', settle: 700 },
      { resize: [120, 30] }, { snap: 'w120', settle: 700 },
      { send: '/diff\r' }, { snap: 'diff120', settle: 800 },
      { resize: [60, 26] }, { snap: 'diff60', settle: 700 },
      { key: 'enter' }, { snap: 'diffdetail60', settle: 500 },
      { resize: [160, 34] }, { snap: 'diffdetail160', settle: 700 },
      { key: 'escape' }, { key: 'escape' }, { snap: 'closed160', settle: 500 },
      { send: '/lain\r' }, { snap: 'lain160', settle: 800 },
      { resize: [80, 30] }, { snap: 'lain80', settle: 700 },
      { key: 'escape' },
      { send: '/jobs\r' }, { snap: 'jobs80', settle: 800 },
      { key: 'escape' },
      { send: 'keep going\r' },
      // UNTIL THE TURN IS VISIBLY STREAMING, not a fixed 1.2s: a step's prose reaches the feed when its
      // call returns, and under full CPU load (2026-09-19) `node -e` had not returned by then. Six
      // steps × 700ms still follow, so the resizes below land mid-stream as before.
      { until: 'working step', timeout: 20000 }, { resize: [60, 26] }, { snap: 'stream60', settle: 300 },
      { wait: 900 }, { resize: [232, 40] }, { snap: 'stream232', settle: 300 },
      { key: 'pageup' }, { key: 'pageup' },
      { key: 'ctrl-pagedown' },
      { until: 'FINAL-STREAM-MARKER', timeout: 30000 },
      { snap: 'final232', settle: 600 },
    ],
  });
  const R = resize.byName;

  await test('REAL TTY K: the resize run reached every screen', () => {
    assert.deepStrictEqual(resize.timeouts, []);
    assert.deepStrictEqual(Object.keys(R).length, 15);
  });

  for (const s of resize.snaps) {
    await test(`REAL TTY K: ${s.name} (${s.cols} cols) stays inside the frame — CJK and long provider JSON included`, () => assertInFrame(s));
  }

  await test('REAL TTY K: nothing is duplicated by a resize', () => {
    for (const s of resize.snaps) {
      assert.ok(count(s, /UNIQUE-ANSWER-ONE/g) <= 1, `${s.name} shows the answer twice`);
      assert.ok(count(s, /UNIQUE-DONE-ONE/g) <= 1, `${s.name} shows the reply twice`);
      assert.ok(count(s, /Ask (?:LAIN|Noema)/g) === 1, `${s.name} has ${count(s, /Ask (?:LAIN|Noema)/g)} composers`);
    }
  });

  await test('REAL TTY K: nothing is lost by a resize — content reflows and is still there', () => {
    for (const name of ['w160', 'w80', 'w60', 'w120', 'closed160']) {
      assert.match(tty.visible(R[name]), /UNIQUE-DONE-ONE/, `${name} lost the last reply`);
      assert.match(tty.visible(R[name]), new RegExp(CJK.slice(0, 4)), `${name} lost the CJK text`);
    }
  });

  await test('REAL TTY K: /diff stays open through resizes, and its overview and detail are valid at every width', () => {
    for (const name of ['diff120', 'diff60']) {
      assert.match(tty.visible(R[name]), /diff · 1 file changed\s+\+2 −0/, `${name}: the overview survives the resize`);
      assert.match(tty.visible(R[name]), /● newprovider\.js\s+\+2/);
    }
    for (const name of ['diffdetail60', 'diffdetail160']) {
      assert.match(tty.visible(R[name]), /newprovider\.js\s+NEW\s+\+2 −0/);
      assert.match(tty.visible(R[name]), /1 \+ module\.exports = 1;/);
    }
    assert.ok(!/diff · 1 file changed/.test(tty.visible(R.closed160)), 'Esc, Esc closes it');
  });

  await test('REAL TTY K: the live activity counter and /diff agree about the same change', () => {
    // The finished turn's CHANGE row (ui/turnsections.js) carries the same count /diff shows.
    assert.match(tty.visible(R.w160), /newprovider\.js\s+\+2 -0\s+\[(?:× )?Diff\]/);
  });

  await test('REAL TTY K: /lain and /jobs are valid panels through a resize', () => {
    assert.match(tty.visible(R.lain160), /\/lain/);
    assert.match(tty.visible(R.lain80), /\/lain[\s\S]*Esc close/);
    assert.match(tty.visible(R.jobs80), /\/jobs[\s\S]*#1/);
  });

  await test('REAL TTY K: resizing during streaming keeps the turn going, and Ctrl+PgDn still reaches the newest output', () => {
    assert.match(tty.visible(R.stream60), /working step/);
    assert.match(tty.visible(R.stream232), /working step/);
    assert.match(tty.visible(R.final232), /FINAL-STREAM-MARKER/);
    assert.strictEqual(count(R.final232, /USER[A-Z ]* · keep going/g), 1);
  });

  // ---- C: PASTE, DELETE, AND NOTHING LEFT BEHIND ---------------------------
  //
  // Reported with screenshots: pasted rows stayed painted beside the empty
  // `Ask LAIN…`, in the columns LEFT of the frame. Causes (tests/unit/
  // composerrepaint.test.js): lone `\r` line separators from a Windows paste,
  // CJK measured in code units, and rows that never repainted the gutter. The
  // person deletes with Ctrl+Backspace, which unfolded the whole paste.
  const lines = Array.from({ length: 14 }, (_, i) => `Final acceptance ${i}: ACTION COMPILER PC CONTROL`).join('\r');
  const cjk = '混合テキスト 🚀 '.repeat(14);
  const C = await tty.runTty({
    cols: 120, rows: 30,
    steps: [
      { until: 'Ask Noema', timeout: 30000 },
      { send: `\x1b[200~${lines}\x1b[201~` }, { wait: 500 }, { snap: 'pasted' },
      { send: '\b' }, { wait: 800 }, { snap: 'ctrlBackspace' },
      { send: `\x1b[200~${cjk}\x1b[201~` }, { wait: 500 },
      { send: '\x7f'.repeat(cjk.length + 5) }, { wait: 2500 }, { snap: 'cjkDeleted' },
    ],
  });
  const P = Object.fromEntries(C.snaps.map((s) => [s.name, s]));
  const clean = (s) => {
    const lo = require('../../src/ui/frame').contentBounds(s.cols).left;
    s.grounds.forEach((g, y) => assert.ok(!g || g[0] >= lo, `row ${y} has ground in the gutter (${g})`));
    assert.deepStrictEqual(tty.escapes(s), [], 'nothing painted outside the frame');
    assert.match(tty.visible(s), /Ask Noema/, 'the placeholder is back');
    assert.ok(!/Final acceptance|混合/.test(tty.visible(s)), 'no pasted text remains anywhere on screen');
  };

  await test('REAL TTY C: a large Windows paste is collapsed and stays inside the frame', () => {
    assert.deepStrictEqual(C.timeouts, []);
    assert.deepStrictEqual(tty.escapes(P.pasted), []);
  });

  await test('REAL TTY C: ONE Ctrl+Backspace removes the collapsed paste, and every cell it occupied is repainted', () => clean(P.ctrlBackspace));

  await test('REAL TTY C: CJK pasted and deleted leaves no ground in the gutter', () => clean(P.cjkDeleted));
};
