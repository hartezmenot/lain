'use strict';

/**
 * THE DIFF IS TRANSCRIPT, NOT A CLICK TARGET — arrival and lifetime separated.
 *
 * ------------------------------------------------------------------------
 * REPORTED: the Diff worked but was the wrong interaction. A change was a
 * `[Diff]` to click, the live animation (ui/diffreel.js) played in a separate
 * window above the caret and CLOSED itself, and `+18 -7` had no colour.
 *
 * NOW: a mutation's real hunks sit under its change row in the feed without
 * being asked for. The newest one OPENS as grey space and its rows arrive
 * there over ~0.6s (a pure function of time since it landed — nothing waits),
 * then it simply stays: through VERIFY, after DONE, scrolling up with
 * everything else. The row's control collapses/reopens; a large diff is
 * bounded with `[Show all]`. Counts are green and red; so are the lines.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');
const T = require('../../src/ui/text');
const views = require('../../src/ui/views');
const sections = require('../../src/ui/turnsections');

const strip = (l) => T.strip(String(l)).replace(/\s+$/, '');

function workspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-difftx-'));
  const entries = [];
  for (const [name, before, after] of files) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, after);
    entries.push({ path: file, bytes: Buffer.from(before), existed: true });
  }
  return { dir, checkpoints: { entries: [{ files: entries }] }, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const edit = (name, over = {}) => ({ step: 0, name: 'edit_file', target: name, path: name, ok: true, added: 1, removed: 1, ...over });

function live(w, liveActions, extra = {}) {
  return views.activity({ session: { turns: [], cwd: w.dir }, width: 96, liveUser: 'fix it', liveActions, checkpoints: w.checkpoints, cwd: w.dir, ...extra });
}

module.exports = async function () {
  await test('DIFF: a mutation shows its hunk in the feed WHILE the turn runs — no click', () => {
    const w = workspace([['cart.js', 'const total = 0;\n', 'const total = 1;\n']]);
    try {
      const rows = live(w, [edit('cart.js')]).map(strip);
      assert.ok(rows.some((r) => /-\s*const total = 0;/.test(r)), rows.join('\n'));
      assert.ok(rows.some((r) => /\+\s*const total = 1;/.test(r)), 'the added line is on screen before DONE');
    } finally { w.clean(); }
  });

  await test('DIFF: arrival — grey space first, rows arriving top-down, then the whole diff for good', () => {
    const w = workspace([['a.js', 'x\n', Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n')]]);
    try {
      const landed = 1_000_000;
      const a = edit('a.js');
      Object.defineProperty(a, 'landedAt', { value: landed, enumerable: false });
      const at = (ms) => live(w, [a], { now: landed + ms });
      const content = (lines) => lines.map(strip).filter((r) => /line \d/.test(r)).length;
      const hunks = (lines) => Object.keys(lines.hunkAt).length;
      const opening = at(10);
      assert.strictEqual(content(opening), 0, 'the space opens before anything is written into it');
      assert.ok(hunks(opening) > 0, 'but the space itself is already there');
      const middle = content(at(sections.OPEN_MS + sections.ARRIVE_MS / 2));
      const done = content(at(sections.OPEN_MS + sections.ARRIVE_MS + 50));
      assert.ok(middle > 0 && middle < done, `rows arrive progressively (${middle} of ${done})`);
      assert.strictEqual(content(at(60_000)), done, 'and after the animation the diff REMAINS');
      assert.strictEqual(opening.length, at(60_000).length, 'the space never changes height while it fills');
    } finally { w.clean(); }
  });

  await test('DIFF: the arrival is renderer-only — the edit record is not waited on, and never serialises the stamp', () => {
    const a = edit('a.js');
    Object.defineProperty(a, 'landedAt', { value: Date.now(), enumerable: false });
    assert.ok(!('landedAt' in JSON.parse(JSON.stringify(a))), 'presentation state never reaches a saved session');
    assert.ok(sections.arriving([a]), 'the fast ticker runs while it arrives');
    assert.ok(!sections.arriving([a], Date.now() + 5000), 'and stops afterwards');
  });

  await test('DIFF: it stays through VERIFY — a later check does not remove it', () => {
    const w = workspace([['cart.js', 'const total = 0;\n', 'const total = 1;\n']]);
    try {
      const rows = live(w, [edit('cart.js'), { step: 1, name: 'run_tests', target: 'cart.test.js', ok: true }]).map(strip);
      assert.ok(rows.some((r) => /\+\s*const total = 1;/.test(r)));
    } finally { w.clean(); }
  });

  await test('DIFF: it stays after DONE, in the CHANGE section, as normal transcript', () => {
    const w = workspace([['cart.js', 'const total = 0;\n', 'const total = 1;\n']]);
    try {
      const settled = [{ userInput: 'fix', text: 'Fixed.', narration: [{ step: 0, text: 'Fixed.' }], actions: [edit('cart.js')] }];
      const rows = views.activity({ session: { turns: settled, cwd: w.dir }, width: 96, checkpoints: w.checkpoints, cwd: w.dir }).map(strip);
      const change = rows.indexOf('CHANGE');
      const added = rows.findIndex((r) => /\+\s*const total = 1;/.test(r));
      assert.ok(change >= 0 && added > change && added < rows.indexOf('RESULT'), rows.join('\n'));
    } finally { w.clean(); }
  });

  await test('DIFF: collapsed by its control, the summary still says file and +/-; reopening restores the hunk', () => {
    const w = workspace([['cart.js', 'const total = 0;\n', 'const total = 1;\n']]);
    try {
      const settled = [{ userInput: 'fix', text: 'Fixed.', narration: [{ step: 0, text: 'Fixed.' }], actions: [edit('cart.js', { added: 1, removed: 1 })] }];
      const opts = { session: { turns: settled, cwd: w.dir }, width: 96, checkpoints: w.checkpoints, cwd: w.dir };
      const collapsed = views.activity({ ...opts, closedDiffs: new Set(['0:cart.js']) }).map(strip);
      assert.ok(collapsed.some((r) => /cart\.js\s+\+1 -1\s+\[Diff\]/.test(r)), collapsed.join('\n'));
      assert.ok(!collapsed.some((r) => /const total/.test(r)));
      const reopened = views.activity({ ...opts, closedDiffs: new Set() }).map(strip);
      assert.ok(reopened.some((r) => /\+\s*const total = 1;/.test(r)));
    } finally { w.clean(); }
  });

  await test('DIFF: a symbol-level edit produces the same visible diff', () => {
    const w = workspace([['m.js', 'function f() { return 0; }\n', 'function f() { return 1; }\n']]);
    try {
      const rows = live(w, [edit('m.js', { name: 'replace_symbol' })]).map(strip);
      assert.ok(rows.some((r) => /\+\s*function f\(\) \{ return 1; \}/.test(r)), rows.join('\n'));
    } finally { w.clean(); }
  });

  await test('DIFF: several files keep their order, each diff under its own row', () => {
    const w = workspace([['a.js', 'a0\n', 'a1\n'], ['b.js', 'b0\n', 'b1\n']]);
    try {
      const rows = live(w, [edit('a.js'), edit('b.js', { step: 1 })]).map(strip);
      const ra = rows.findIndex((r) => /a\.js\s.*\[× Diff\]/.test(r));
      const da = rows.findIndex((r) => /\+\s*a1/.test(r));
      const rb = rows.findIndex((r) => /b\.js\s.*\[× Diff\]/.test(r));
      const db = rows.findIndex((r) => /\+\s*b1/.test(r));
      assert.ok(ra < da && da < rb && rb < db, rows.join('\n'));
    } finally { w.clean(); }
  });

  await test('DIFF: +N is green and -N is red on the change row; the path and the rest are not', () => {
    const prev = process.env.LAIN_FORCE_COLOR;
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      const { P } = require('../../src/ui/paint');
      const row = require('../../src/ui/rowpaint').paintMark('✓ edited · src/scheduler.ts   +18 -7   [× Diff]', P);
      assert.ok(row.includes(P.ok('+18')), 'additions green');
      assert.ok(row.includes(P.bad('-7')), 'deletions red');
      assert.ok(!row.includes(P.ok('src/scheduler.ts')) && !row.includes(P.bad('src/scheduler.ts')), 'the filename keeps its own colour');
      assert.ok(row.includes(P.path('src/scheduler.ts')), 'the path is painted as a path, not swallowed with the counts');
    } finally { if (prev === undefined) delete process.env.LAIN_FORCE_COLOR; else process.env.LAIN_FORCE_COLOR = prev; }
  });

  await test('DIFF: added lines green, removed lines red, context neutral — on the dark ground', () => {
    const prev = process.env.LAIN_FORCE_COLOR;
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      const { P } = require('../../src/ui/paint');
      const panes = require('../../src/ui/panes');
      const add = panes.diffRow('   1 + new', 40, P);
      const del = panes.diffRow('   1 - old', 40, P);
      const ctx = panes.diffRow('   1   same', 40, P);
      assert.ok(add.includes(P.ok('   1 + new').slice(0, 8)), 'green');
      assert.ok(del.includes(P.bad('   1 - old').slice(0, 8)), 'red');
      assert.ok(ctx.includes('\x1b[48;5;236m'), 'dark-grey ground');
    } finally { if (prev === undefined) delete process.env.LAIN_FORCE_COLOR; else process.env.LAIN_FORCE_COLOR = prev; }
  });

  await test('DIFF: a turn touching many files shows only the most RECENT diffs; older rows stay one line and open on click', () => {
    const files = Array.from({ length: 6 }, (_, i) => [`f${i}.js`, `old${i}\n`, `new${i}\n`]);
    const w = workspace(files);
    try {
      const toggle = require('../../src/ui/difftoggle');
      const acts = files.map(([n], i) => edit(n, { step: i }));
      const rows = live(w, acts).map(strip);
      const diffs = rows.filter((r) => /\+\s*new\d/.test(r));
      assert.strictEqual(diffs.length, sections.MAX_AUTO_FILES, rows.join('\n'));
      assert.ok(rows.some((r) => /\+\s*new5/.test(r)) && !rows.some((r) => /\+\s*new0/.test(r)), 'the newest are shown, the oldest are not');
      const lines = live(w, acts);
      const oldest = Object.values(lines.diffAt).find((d) => d.path === 'f0.js');
      assert.strictEqual(oldest.shown, false);
      const screen = { workspaceScroll: 0, stickToBottom: true, openDiff: null };
      toggle.toggle(screen, oldest);
      const opened = live(w, acts, { shownDiffs: screen.shownDiffs, closedDiffs: screen.closedDiffs }).map(strip);
      assert.ok(opened.some((r) => /\+\s*new0/.test(r)), 'one click opens an older file');
    } finally { w.clean(); }
  });

  await test('DIFF: a RECEDING change row goes quiet except its counts, which keep green and red', () => {
    const prev = process.env.LAIN_FORCE_COLOR;
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      const { P } = require('../../src/ui/paint');
      const quiet = { ...P, meta: P.faint, path: P.faint, plain: P.faint };
      const row = require('../../src/ui/rowpaint').paintMark('✓ edited · a.js   +3 -2   [Diff]', quiet);
      assert.ok(row.includes('\x1b[38;5;244m'), 'the row recedes');
      assert.ok(row.includes(P.ok('+3')) && row.includes(P.bad('-2')), 'the counts do not');
    } finally { if (prev === undefined) delete process.env.LAIN_FORCE_COLOR; else process.env.LAIN_FORCE_COLOR = prev; }
  });

  await test('DIFF: an edit no longer opens the second, self-closing reel window — it arrives in the feed', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'index.js'), 'utf8');
    const m = /showDiff\([^)]*\)\s*\{([^}]*)\}/.exec(src);
    assert.ok(m, 'showDiff exists');
    assert.ok(!/activity\.showDiff/.test(m[1]), 'showDiff does not open the reel window any more');
  });
};
