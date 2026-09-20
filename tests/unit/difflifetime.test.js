'use strict';

/**
 * THE DIFF LIVES AS LONG AS THE TURN, NOT AS LONG AS AN ANIMATION.
 *
 * Reported (steer, 2026-09-19): "Diff sometimes does not show". Traced: while a
 * turn ran, its only diff surface was the reel animation (ui/diffreel.js) and
 * the counters card — both transient — and the live feed drew an edit as an
 * ordinary action row with no [Diff]. The control existed only once the turn
 * had settled. So between the animation ending and DONE there was no Diff.
 *
 *   J. the Diff persists after the activity collapses
 *   K. the counter expiring does not remove the Diff
 *   L. the activity minimizes when the Diff is primary
 *   M. a completed turn retains a reopenable Diff (same index, same row)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');
const T = require('../../src/ui/text');
const views = require('../../src/ui/views');
const turnevents = require('../../src/turnevents');
const toggle = require('../../src/ui/difftoggle');
const box = require('../../src/ui/activitybox');

const strip = (l) => T.strip(String(l)).replace(/\s+$/, '');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-difflife-'));
  const file = path.join(dir, 'cart.js');
  fs.writeFileSync(file, 'const total = 1;\nconst tax = 2;\n');
  return {
    dir, file,
    checkpoints: { entries: [{ files: [{ path: file, bytes: Buffer.from('const total = 0;\n'), existed: true }] }] },
    clean: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** The real turnevents path into a recording UI: what the live feed will be drawn from. */
function liveEdit(w) {
  const live = [];
  let counts = null;
  const app = {
    render: { toolResult() {}, toolStart() {}, text() {}, nl() {}, notice() {}, write() {} },
    session: { cwd: w.dir, turns: [], messages: [], actors: [] },
    checkpoints: w.checkpoints,
    ui: {
      enabled: true, noteAction(a) { live.push(a); }, noteNarration() {}, noteActor() {}, noteOutput() {}, setRunning() {},
      noteEditCounts(a, r) { counts = { a, r }; }, showDiff() {}, showRead() {},
    },
  };
  turnevents.apply(app, { type: 'tool_result', name: 'edit_file', input: { path: 'cart.js', old: 'x', new: 'y' }, output: 'edited', isError: false,
    size: { name: 'edit_file', path: 'cart.js', added: 2, removed: 1 } }, { liveText: '' });
  return { live, counts: () => counts };
}

module.exports = async function () {
  await test('DIFF J: the turn in flight carries a CHANGE row with [Diff] — after the activity has collapsed', () => {
    const w = workspace();
    try {
      const { live } = liveEdit(w);
      assert.strictEqual(live.length, 1);
      assert.strictEqual(live[0].path, 'cart.js', 'the live row knows its file');
      // The activity box is closed (not busy): nothing transient is on screen.
      assert.strictEqual(box.summary({ busy: false }), null);
      const rows = views.activity({ session: { turns: [], cwd: w.dir }, width: 96, liveUser: 'fix the total', liveActions: live, cwd: w.dir }).map(strip);
      // IN PLACE: the live account stays interleaved (prose, the call, the next prose); the row carries the control.
      assert.ok(rows.some((r) => /edited · cart\.js\s+\+2 -1\s+\[(?:× )?Diff\]/.test(r)), rows.join('\n'));
      assert.ok(!rows.includes('CHANGE'), 'the CHANGE section is the SETTLED form; the live turn keeps its order');
    } finally { w.clean(); }
  });

  await test('DIFF K: the counters card expiring does not remove the Diff — the row is from the turn, not the card', () => {
    const w = workspace();
    try {
      const { live, counts } = liveEdit(w);
      assert.ok(counts(), 'the card did get its counts');
      // The card's lifetime ends (the ActivityTimeline clears it); the feed is
      // drawn from the live record alone, so the Diff is untouched.
      const lines = views.activity({ session: { turns: [], cwd: w.dir }, width: 96, liveUser: 'fix', liveActions: live, cwd: w.dir });
      const at = Object.keys(lines.diffAt).map(Number);
      assert.strictEqual(at.length, 1, 'one clickable [Diff] control');
      assert.deepStrictEqual({ turn: lines.diffAt[at[0]].turn, path: lines.diffAt[at[0]].path }, { turn: 0, path: 'cart.js' });
      // And it opens the real hunk while the turn is still running.
      const screen = { workspaceScroll: 0, stickToBottom: true, openDiff: null };
      toggle.toggle(screen, lines.diffAt[at[0]]);
      const opened = views.activity({ session: { turns: [], cwd: w.dir }, width: 96, liveUser: 'fix', liveActions: live, openDiff: screen.openDiff, checkpoints: w.checkpoints, cwd: w.dir }).map(strip);
      assert.ok(opened.some((r) => /\[× Diff\]/.test(r)));
      assert.ok(opened.some((r) => /\+.*const total = 1;/.test(r)), opened.join('\n'));
      // SEVERAL EDITS OF ONE FILE update ONE Diff: only the latest row carries the control.
      const twice = [...live, { ...live[0] }];
      const both = views.activity({ session: { turns: [], cwd: w.dir }, width: 96, liveUser: 'fix', liveActions: twice, cwd: w.dir });
      assert.strictEqual(Object.keys(both.diffAt).length, 1, 'one control per file, on its latest edit');
      assert.strictEqual(both.map(strip).filter((r) => /edited · cart\.js/.test(r)).length, 2, 'both edits stay in the account');
      // A SYMBOL EDIT has no change verb and left NO live row (live, 2026-09-19: replace_symbol, then a 90s smoke, no Diff).
      const sym = [{ ...live[0], name: 'replace_symbol' }];
      const s = views.activity({ session: { turns: [], cwd: w.dir }, width: 96, liveUser: 'fix', liveActions: sym, cwd: w.dir });
      assert.strictEqual(Object.keys(s.diffAt).length, 1, 'a replace_symbol edit carries its Diff while the turn runs');
    } finally { w.clean(); }
  });

  await test('DIFF L: the activity rectangle minimizes to one line when a Diff (or any action) is primary', () => {
    const now = Date.now();
    const thinking = { busy: true, phaseSince: now - 5000, phase: { phase: 'WAITING_MODEL' }, recent: [{ name: 'read_file', target: 'a.js', ok: true }] };
    assert.strictEqual(box.rows(thinking, 20, now), 2, 'the rectangle while only thinking is happening');
    assert.strictEqual(box.rows(thinking, 20, now, { minimal: true }), 1, 'one line when a Diff is primary');
    const acting = { busy: true, phase: { phase: 'RUNNING_TOOL', tool: 'read_file', target: 'src/a.js' }, recent: [] };
    assert.strictEqual(box.rows(acting, 20), 1, 'a tool acting is primary too');
    const one = box.draw(acting, 60, 1).map(strip);
    assert.strictEqual(one.length, 1);
    assert.match(one[0], /READING · src\/a\.js/);
    assert.doesNotMatch(one[0], /┌|└/, 'no box chrome');
    const geo = require('../../src/ui/geometry');
    const screen = (over) => ({ rows: 40, cols: 100, panel: null, state: { llm: thinking, liveActions: [] }, _wrapped: () => [{ text: '' }], _pasteSummary: () => '', ...over });
    const quiet = geo.regions(screen({}));
    const expanded = geo.regions(screen({ openDiff: { turn: 0, path: 'a.js' } }));
    const arriving = geo.regions(screen({ state: { llm: thinking, liveActions: [{ name: 'edit_file', path: 'a.js', ok: true, landedAt: Date.now() }] } }));
    assert.strictEqual(quiet.activityRows, 2);
    assert.strictEqual(expanded.activityRows, 1, 'an expanded diff is primary');
    assert.strictEqual(arriving.activityRows, 1, 'a diff arriving in the feed is primary');
    assert.strictEqual(arriving.workspace - quiet.workspace, 1, 'the row went to the feed the diff is in');
  });

  await test('DIFF M: the completed turn keeps a reopenable Diff at the SAME index — an open Diff stays open across settlement', () => {
    const w = workspace();
    try {
      const { live } = liveEdit(w);
      const openDiff = { turn: 0, path: 'cart.js' };
      const during = views.activity({ session: { turns: [], cwd: w.dir }, width: 96, liveUser: 'fix', liveActions: live, openDiff, checkpoints: w.checkpoints, cwd: w.dir }).map(strip);
      assert.ok(during.some((r) => /cart\.js.*\[× Diff\]/.test(r)));
      // The turn settles: the record carries the same action (turn.js actionRecord).
      const settled = [{ userInput: 'fix', text: 'Fixed the total.', narration: [{ step: 0, text: 'Fixed the total.' }],
        actions: [{ step: 0, name: 'edit_file', target: 'cart.js', path: 'cart.js', ok: true, added: 2, removed: 1 }] }];
      const after = views.activity({ session: { turns: settled, cwd: w.dir }, width: 96, openDiff, checkpoints: w.checkpoints, cwd: w.dir });
      const rows = after.map(strip);
      assert.ok(rows.some((r) => /cart\.js\s+\+2 -1\s+\[× Diff\]/.test(r)), 'still open, same numbers: ' + rows.join('\n'));
      const closed = views.activity({ session: { turns: settled, cwd: w.dir }, width: 96, cwd: w.dir });
      const at = Object.keys(closed.diffAt).map(Number);
      assert.strictEqual(at.length, 1, 'reopenable after DONE');
      assert.strictEqual(closed.diffAt[at[0]].turn, 0);
    } finally { w.clean(); }
  });
};
