'use strict';

/** §4–6, §12–13, §15–17, §50 — the quiet CLI presentation. */

const assert = require('assert');
const { test } = require('../helpers');
const T = require('../../src/ui/text');
const views = require('../../src/ui/views');

const strip = (l) => T.strip(String(l)).replace(/\s+$/, '');

function turn(over = {}) {
  return {
    userInput: 'fix retry ownership', text: 'Retry scheduling now has one owner.',
    narration: [{ step: 0, text: 'Tracing scheduler to queue ownership.' }, { step: 3, text: 'Retry scheduling now has one owner.' }],
    actions: [
      { step: 0, name: 'read_file', target: 'src/scheduler.ts', path: 'src/scheduler.ts', ok: true },
      { step: 1, name: 'edit_file', target: 'src/scheduler.ts', path: 'src/scheduler.ts', ok: true, added: 18, removed: 7 },
      { step: 2, name: 'run_tests', target: 'retry.test.ts', ok: true, note: 'PASS', brief: true },
    ],
    ...over,
  };
}

module.exports = async function () {
  await test('FEED: a turn that changed and checked things reads CHANGE → VERIFY → RESULT; reads are not listed', () => {
    const rows = views.activity({ session: { turns: [turn()] }, width: 96 }).map(strip);
    const at = (s) => rows.findIndex((r) => r === s);
    assert.ok(at('CHANGE') > 0 && at('VERIFY') > at('CHANGE') && at('RESULT') > at('VERIFY'), rows.join('\n'));
    assert.ok(rows.some((r) => /src\/scheduler\.ts\s+\+18 -7\s+\[(?:× )?Diff\]/.test(r)));
    assert.ok(rows.some((r) => /retry\.test\.ts/.test(r)));
    assert.strictEqual(rows[rows.length - 1], 'Retry scheduling now has one owner.');
    assert.ok(!rows.some((r) => /read · src\/scheduler/.test(r)), 'a read leaves no row');
  });

  await test('FEED: a conversational turn is drawn exactly as before — no sections', () => {
    const rows = views.activity({ session: { turns: [{ userInput: 'hi', text: 'Hello.', narration: [{ step: 0, text: 'Hello.' }], actions: [] }] }, width: 96 }).map(strip);
    assert.ok(!rows.includes('CHANGE') && !rows.includes('RESULT'));
  });

  await test('DIFF: shown without a click, bounded; [Show all] expands and lands on it; Esc/close restores the exact prior position', () => {
    const toggle = require('../../src/ui/difftoggle');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-diffshow-'));
    try {
      const file = path.join(dir, 'src', 'scheduler.ts');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join('\n'));
      const checkpoints = { entries: [{ files: [{ path: file, bytes: Buffer.from('const old = 0;\n'), existed: true }] }] };
      const turns = [];
      for (let i = 0; i < 30; i++) turns.push({ userInput: `q${i}`, text: `a${i}`, narration: [{ step: 0, text: `a${i}` }], actions: [] });
      turns.push(turn());
      const opts = { session: { turns, cwd: dir }, width: 96, checkpoints, cwd: dir };
      const shown = views.activity(opts);
      assert.ok(Object.keys(shown.hunkAt).length > 0, 'the hunks are in the feed with no click at all');
      assert.ok(shown.map(strip).some((r) => /… \d+ more lines\s+\[Show all\]/.test(r)), 'a large diff is bounded and says how much more there is');
      const more = Object.values(shown.diffAt).find((d) => d.full);
      assert.ok(more, '[Show all] is clickable');
      const screen = { workspaceScroll: 11, stickToBottom: false, openDiff: null };
      toggle.toggle(screen, more);
      const opened = views.activity({ ...opts, openDiff: screen.openDiff });
      assert.ok(opened.length > shown.length, 'the rest of the hunk rows were added');
      toggle.landing(screen, opened, 10);
      const hunk = Number(Object.keys(opened.hunkAt)[0]);
      assert.ok(screen.workspaceScroll <= hunk && hunk < screen.workspaceScroll + 10, 'the hunk is in view');
      toggle.close(screen);
      assert.strictEqual(screen.workspaceScroll, 11, 'the exact prior position, not "scroll up"');
      assert.strictEqual(screen.stickToBottom, false);
      assert.strictEqual(screen.openDiff, null);
      assert.strictEqual(views.activity({ ...opts, openDiff: null }).length, shown.length, 'back to the bounded preview');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('DIFF: the row control collapses and reopens; switching expansion keeps the ORIGINAL restore point', () => {
    const toggle = require('../../src/ui/difftoggle');
    const screen = { workspaceScroll: 5, stickToBottom: true, openDiff: null };
    toggle.toggle(screen, { turn: 1, path: 'a.js' });
    assert.ok(screen.closedDiffs.has('1:a.js'), 'collapsed');
    toggle.toggle(screen, { turn: 1, path: 'a.js' });
    assert.ok(!screen.closedDiffs.has('1:a.js'), 'reopened');
    toggle.expand(screen, { turn: 1, path: 'a.js' });
    screen.workspaceScroll = 40;
    toggle.expand(screen, { turn: 1, path: 'b.js' });
    toggle.close(screen);
    assert.strictEqual(screen.workspaceScroll, 5);
    assert.strictEqual(screen.stickToBottom, true);
  });

  await test('REFS: `src/foo.ts:84` in prose and in errors is clickable, opening at that line', () => {
    const t = { userInput: 'why', text: 'The throw is at src/queue.ts:84 and C:\\app\\x.js:12.', narration: [{ step: 0, text: 'The throw is at src/queue.ts:84 now.' }], actions: [] };
    const lines = views.activity({ session: { turns: [t] }, width: 96 });
    const refs = Object.values(lines.fileAt);
    assert.ok(refs.includes('src/queue.ts:84'), JSON.stringify(refs));
  });

  await test('ACTIVITY BOX: concise states from runtime facts only; closed when idle; Ctrl+O expands', () => {
    const box = require('../../src/ui/activitybox');
    const now = Date.now();
    const base = { busy: true, phaseSince: now, recent: [{ name: 'read_file', target: 'src/auth/a.js', ok: true }, { name: 'read_file', target: 'src/auth/b.js', ok: true }] };
    assert.strictEqual(box.summary({ ...base, phase: { phase: 'RUNNING_TOOL', tool: 'read_file', target: 'src/auth/c.js' } }).line, 'src/auth · 3 files');
    assert.strictEqual(box.summary({ ...base, phase: { phase: 'RUNNING_TOOL', tool: 'run_tests', target: 'retry' } }).kind, 'TESTING');
    assert.strictEqual(box.summary({ ...base, phase: { phase: 'RUNNING_TOOL', tool: 'locate', target: 'retryJob' } }).kind, 'LOCATING');
    assert.strictEqual(box.summary({ ...base, phase: { phase: 'RETRYING', rateLimited: true, resumeAt: now + 9000 } }).kind, 'RATE LIMITED');
    assert.strictEqual(box.summary({ ...base, phase: { phase: 'WAITING_MODEL' } }).kind, 'THINKING');
    assert.strictEqual(box.rows({ busy: false, phase: null }), 0, 'closed the instant the turn ends');
    assert.strictEqual(box.rows({ busy: true, phase: { phase: 'WAITING_MODEL' }, phaseSince: now, recent: [] }, 99, now), 0, 'not opened for nothing');
    const collapsed = box.rows({ ...base, phase: { phase: 'RUNNING_TOOL', tool: 'read_file', target: 'x.js' } });
    const expanded = box.rows({ ...base, activityExpanded: true, phase: { phase: 'RUNNING_TOOL', tool: 'read_file', target: 'x.js' } });
    // ONE ACTIVITY LINE (2026-10-01): the status strip says what is happening; the box takes rows only for what the
    // line cannot carry — the model's own visible words, agents, and the Ctrl+O detail.
    assert.strictEqual(collapsed, 0, 'a tool acting is said once, on the activity line — no box');
    assert.ok(expanded > collapsed, 'Ctrl+O still expands it');
    const thinking = box.rows({ ...base, phaseSince: now - 5000, phase: { phase: 'WAITING_MODEL' } }, 99, now);
    assert.strictEqual(thinking, 0, 'thinking with nothing visible to quote is said once, on the activity line');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'ui', 'activitybox.js'), 'utf8');
    assert.ok(!/reasoning|narration/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'it never reads the model\'s reasoning or prose');
  });

  await test('HEADER: real step progress; PLAN shows no countdown; the mode is always visible; the live state is NOT repeated', () => {
    const hs = require('../../src/ui/headerstate');
    const { Plan } = require('../../src/plan');
    const plan = new Plan('x'); plan.addSteps(['a', 'b', 'c', 'd', 'e', 'f', 'g']); plan.complete(); plan.complete();
    const session = { plan, execMode: 'AUTO' };
    const ui = { app: { session }, busy: true, phase: { phase: 'RUNNING_TOOL' }, clock: { state: 'RUNNING', startedAt: Date.now() - 258000, accumulated: 0 } };
    const run = hs.run(ui);
    // NOT `RUNNING · 04:18` (2026-10-01): the activity line below owns what is happening and for how long.
    assert.strictEqual(run.parts[0], 'AUTO');
    assert.ok(!run.parts.includes('RUNNING') && !run.parts.some((p) => /^\d+:\d\d/.test(p)), run.parts.join(' · '));
    assert.ok(run.parts.includes('3/7'), run.parts.join(' · '));
    session.execMode = 'PLAN';
    assert.deepStrictEqual(hs.run(ui).parts.slice(0, 2), ['PLAN', 'discussing']);
    assert.ok(!hs.run(ui).parts.some((p) => /\d+\/\d+/.test(p)), 'no 3/7 while discussing');
    assert.strictEqual(require('../../src/ui/progress').livePlan(session), null, 'and no surface shows plan progress in PLAN');
    session.execMode = 'MANUAL'; ui.busy = false; ui.phase = null;
    assert.strictEqual(hs.run(ui).parts[0], 'MANUAL');
    const h = strip(views.header({ cwd: '/x/toradb', model: 'glm-5', width: 110, run: { parts: ['RUNNING', '04:18', '3/7'], tone: 'info' }, output: { tokens: 12400, measured: true } })[0]);
    assert.match(h, /^LAIN · toradb · /);
    assert.match(h, /RUNNING · 04:18 · 3\/7\s+12\.4K$/);
  });
};
