'use strict';

/**
 * CLI CLOSURE (2026-09-23), in a REAL pseudo-console.
 *
 *   G  `/goal` ⏎ + a multi-line PASTE ⏎ executes at once (no /goal continue);
 *      the process is then HARD-KILLED mid-command; `--resume` brings back the
 *      goal and the turn's progress, the killed command UNKNOWN, not replayed
 *   L  liveness: a large tool call streaming reads PREPARING TOOL · edit_file ·
 *      <size>, never STALLED; streamed words show as commentary in the box
 *   D  the Diff arrives in the feed unasked, + green / - red, and is still
 *      there after the turn — the activity box is gone
 *   P  /fast /fast /eco /eco /fast /eco /normal — the header follows the toggles
 *
 * SKIPS WITH A REASON when no PTY driver is configured (LAIN_TTY_PYTHON).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');
const tty = require('../tty/realtty');

const vis = (s) => tty.visible(s);
const E = String.fromCharCode(27);

function sessions(configDir) {
  const d = path.join(configDir, 'sessions');
  return fs.readdirSync(d).filter((x) => x.endsWith('.json')).map((x) => JSON.parse(fs.readFileSync(path.join(d, x), 'utf8')));
}

module.exports = async function () {
  const probe = tty.available();
  if (!probe.ok) {
    await test('CLI CLOSURE: not run — no pseudo-console driver', () => {
      process.stdout.write(`    (skipped: ${probe.why}; set LAIN_TTY_PYTHON to a Python with pywinpty and pyte)\n`);
    });
    return;
  }

  // ---- G — goal capture, hard kill, resume ------------------------------------
  const PASTE = ['Build the quarterly report.', 'Step one: write part1.txt.', 'Step two: run the long check.'].join('\r');
  const g1 = await tty.runTty({
    cols: 110, rows: 32,
    script: [
      { text: 'Writing part one.', tool_calls: [{ name: 'write_file', input: { path: 'part1.txt', content: 'part one\n' } }] },
      { text: 'Running the long check.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 40' } }] },
      { text: 'Done.' },
    ],
    steps: [
      { until: 'Ask LAIN', timeout: 30000 },
      { send: '/goal\r' }, { snap: 'capture', settle: 700 },
      { send: `${E}[200~${PASTE}${E}[201~` }, { wait: 400 },
      { send: '\r' },
      { until: 'sleep 40', timeout: 30000 },
      { snap: 'running', settle: 1500 },
      { hardkill: true },          // TerminateProcess: a crash, not a Ctrl+C
    ],
  });
  await test('CLI G1: `/goal` then a pasted multi-line task EXECUTES at once — one USER turn, no /goal continue', () => {
    assert.match(vis(g1.byName.capture), /GOAL ›|GOAL\s*›/, 'the composer is in capture mode');
    const running = vis(g1.byName.running);
    assert.match(running, /sleep 40/, 'the goal ran: its second step is executing');
    assert.ok(fs.existsSync(path.join(g1.cwd, 'part1.txt')), 'its first step already landed');
    const s = sessions(g1.configDir)[0];
    const users = s.messages.filter((m) => m.role === 'user' && /quarterly report/.test(String(m.content)));
    assert.strictEqual(users.length, 1, 'exactly one user turn carries the goal');
    assert.match(String(users[0].content), /Step two: run the long check\./, 'the whole paste');
    assert.match(s.goal && s.goal.text, /quarterly report[\s\S]*Step two/, 'and it is the durable goal');
  });
  await test('CLI G2: the HARD-KILLED turn is on disk as in-flight, caught during the command', () => {
    assert.ok(g1.hardkilled && !g1.hardkillError, `the driver killed it: ${g1.hardkillError || ''}`);
    const s = sessions(g1.configDir)[0];
    assert.ok(s.inflight, 'in-flight record present after the kill');
    assert.strictEqual(s.inflight.tool && s.inflight.tool.name, 'run_bash');
  });
  const sid = sessions(g1.configDir)[0].id;
  const g2 = await tty.runTty({
    cols: 110, rows: 32, args: ['--resume', sid], configDir: g1.configDir, cwd: g1.cwd,
    steps: [
      { until: 'Ask LAIN', timeout: 30000 }, { snap: 'resumed', settle: 1200 },
      { send: '/goal show\r' }, { snap: 'goal', settle: 1200 },
    ],
  });
  await test('CLI G3: --resume after the kill — RECOVERED notice, goal and progress back, the command NOT replayed', () => {
    const resumed = vis(g2.byName.resumed);
    // The line names the step and the lost command (inflight.js); a fresh Coding crash now resumes by itself
    // (autocontinue.scheduleRecovery), so it no longer asks for `continue`.
    assert.match(resumed, /recovered · cut off at step 2 · run_bash (unknown, )?not re-run/i, `the recovery is said:\n${resumed}`);
    assert.match(vis(g2.byName.goal), /quarterly report/, 'the goal came back');
    const s = sessions(g1.configDir)[0];
    assert.strictEqual(s.inflight, null, 'repaired and saved');
    const lost = s.messages.find((m) => m.role === 'tool' && /\[RECOVERED · UNKNOWN\]/.test(String(m.content)));
    assert.ok(lost, 'the killed command is answered UNKNOWN');
    // The recovered turn is the CRASHED one; a fresh crash may be followed by LAIN's own auto-resume turn.
    const last = s.turns.filter((t) => t.stopReason === 'crashed').pop();
    assert.ok(last, 'the cut-off turn is kept as crashed');
    assert.ok(s.turns.slice(s.turns.indexOf(last) + 1).every((t) => t.from === 'auto-resume'), 'anything after it is LAIN\'s own resume, never a replay the person typed');
    assert.ok(last.actions.some((a) => a.name === 'write_file' && a.ok), 'the completed write is part of the recovered turn');
  });

  // ---- L + D — liveness, commentary, Diff -------------------------------------
  const big = Array.from({ length: 160 }, (_, i) => `export const row${i} = ${i}; // generated row ${i}`).join('\n') + '\n';
  const l = await tty.runTty({
    cols: 110, rows: 34,
    script: [
      { text: 'I am tracing where the recovery state is written before touching anything else in this module.', chunkDelayMs: 120,
        tool_calls: [{ name: 'write_file', input: { path: 'table.js', content: big } }], toolStreamMs: 5000 },
      { text: 'Wrote the table.' },
    ],
    steps: [
      { until: 'Ask LAIN', timeout: 30000 },
      { send: 'generate the table\r' },
      { until: 'Writing', timeout: 20000 }, { snap: 'streaming', settle: 600 },
      { until: 'Preparing tool', timeout: 30000 }, { snap: 'preparing', settle: 1500 },
      { until: 'Wrote the table', timeout: 30000 }, { snap: 'done', settle: 2500 },
    ],
  });
  await test('CLI L1: while words stream, the ONE activity line says Writing and the box quotes the model\'s own words', () => {
    const s = vis(l.byName.streaming);
    assert.match(s, /Writing\s+\d\d:\d\d:\d\d/);
    assert.ok(!/STREAMING · /.test(s), 'the state is not drawn twice');
    assert.match(s, /tracing|recovery state/, `commentary visible:\n${s}`);
  });
  await test('CLI L2: a large tool call streaming reads Preparing tool · write_file · <size> — never STALLED', () => {
    const s = vis(l.byName.preparing);
    assert.match(s, /Preparing tool/);
    assert.match(s, /write_file · \d+(\.\d)? (KB|B)/, s);
    assert.ok(!/STALLED/.test(s));
  });
  await test('CLI D1: the Diff is in the feed unasked, and survives the end of the turn; the activity box is gone', () => {
    const s = vis(l.byName.done);
    assert.match(s, /table\.js/);
    assert.match(s, /\+16\d/, 'the + count');
    assert.match(s, /export const row\d+ = \d+;/, 'the changed lines themselves are on screen');
    assert.ok(!/Preparing tool|PREPARING TOOL|STREAMING ·/.test(s), 'the temporary activity is gone');
    // Colour: the `+` rows and the +N count are drawn green (pyte fg per row).
    const snap = l.byName.done;
    const y = snap.text.findIndex((t) => /\+ export const row/.test(t));
    assert.ok(y >= 0, 'an added row is on screen');
    const greenish = (c) => /green/i.test(c) || /^[0-9a-f]{6}$/i.test(c) && parseInt(c.slice(2, 4), 16) > parseInt(c.slice(0, 2), 16) + 40;
    assert.ok(snap.fg[y].some(greenish), `the + row is green: ${JSON.stringify(snap.fg[y])}`);
  });

  // ---- U — the 2026-09-23 visual direction, in a real terminal ---------------
  const src = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  const edited = src.replace('export const v5 = 5;', 'export const v5 = 500;');
  const run = async (cols, tag) => {
    const cwd = require('../helpers').tmpdir('ux-');
    fs.writeFileSync(path.join(cwd, 'vals.js'), src);
    return tty.runTty({
      cols, rows: 40, cwd,
      script: [
        { text: '', tool_calls: [{ name: 'read_file', input: { path: 'vals.js' } }] },
        { text: 'Streaming a little before the edit so the rectangle is visible for a moment.', chunkDelayMs: 90,
          tool_calls: [{ name: 'edit_file', input: { path: 'vals.js', old: 'export const v5 = 5;', new: 'export const v5 = 500;' } }] },
        { text: `Done ${tag}.` },
      ],
      steps: [
        { until: 'Ask LAIN', timeout: 30000 }, { snap: 'idle', settle: 500 },
        { send: 'change v5\r' },
        { until: 'Writing', timeout: 20000 }, { snap: 'stream', settle: 300 },
        { until: `Done ${tag}`, timeout: 30000 }, { snap: 'done', settle: 2000 },
      ],
    });
  };
  const wide = await run(170, 'wide');
  const narrow = await run(100, 'narrow');
  const hexOf = (snap, y, re) => y >= 0 && (snap.fg[y] || []).some((c) => re.test(String(c)));
  await test('CLI U1: a WIDE terminal draws the Diff side by side (old │ new), a narrow one unified', () => {
    assert.strictEqual(fs.readFileSync(path.join(wide.cwd, 'vals.js'), 'utf8'), edited, 'the edit landed');
    const w = vis(wide.byName.done);
    assert.match(w, /6 export const v5 = 5;\s+│\s+6 export const v5 = 500;/, `split row:\n${w}`);
    const n = vis(narrow.byName.done);
    assert.match(n, /6 - export const v5 = 5;/, n);
    assert.match(n, /6 \+ export const v5 = 500;/);
    assert.ok(!/│\s+6 export const v5 = 500;/.test(n), 'narrow is not split');
  });
  await test('CLI U2: the palette — blue composer edge, violet model activity, teal added row; heads not the old cyan', () => {
    const idle = wide.byName.idle;
    const y = idle.text.findIndex((t) => /▌\s*Ask (?:LAIN|LAIN)/.test(t));
    assert.ok(y >= 0, `the composer carries its edge:\n${vis(idle)}`);
    assert.ok(hexOf(idle, y, /4da3ff/i), `blue edge: ${JSON.stringify(idle.fg[y])}`);
    const st = wide.byName.stream;
    const sy = st.text.findIndex((t) => /Writing|Working/.test(t));
    assert.ok(hexOf(st, sy, /9b8cff/i), `violet activity: ${JSON.stringify(st.fg[sy])}`);
    const d = wide.byName.done;
    const ay = d.text.findIndex((t) => /export const v5 = 500;/.test(t));
    assert.ok(hexOf(d, ay, /72e6a2/i), `teal-green added text: ${JSON.stringify(d.fg[ay])}`);
    const hy = d.text.findIndex((t) => /^\s*CHANGE\b/.test(t));
    assert.ok(hy < 0 || !hexOf(d, hy, /^cyan$|67c7f7/i), 'section heads are identity blue, not the old cyan');
  });

  // ---- U3 — the command row's output tail and the footer (2026-09-23) --------
  const sh = await tty.runTty({
    cols: 120, rows: 36,
    script: [
      { text: 'Running the listing now, streaming slowly so the running footer is visible.', chunkDelayMs: 90,
        tool_calls: [{ name: 'run_bash', input: { command: 'node -e "for (let i = 1; i <= 7; i++) console.log(\'line \' + i)"' } }] },
      { text: 'Done footer.', delayMs: 2000 },   // the shell now returns in ~20 ms: keep the turn running long enough to see its footer
    ],
    steps: [
      { until: 'Ask LAIN', timeout: 30000 }, { snap: 'idle', settle: 500 },
      { send: 'list them\r' },
      { until: 'Writing', timeout: 20000 }, { snap: 'busy', settle: 300 },
      { until: 'Done footer', timeout: 30000 }, { snap: 'done', settle: 1500 },
    ],
  });
  await test('CLI U3: `› cmd`, (N earlier lines), the output tail, the completion; a footer of live key hints', () => {
    const d = vis(sh.byName.done);
    assert.match(d, /› node -e/, d);
    assert.match(d, /\(3 earlier lines\)\s*\n[│\s]*line 4\s*\n[│\s]*line 5\s*\n[│\s]*line 6\s*\n[│\s]*line 7/, `the tail under the command:\n${d}`);
    assert.match(d, /Command completed in \d+(\.\d)?s · exit code 0/);
    const last = (snap) => snap.text.filter((t) => t.trim()).pop() || '';
    assert.match(last(sh.byName.idle), /\/ commands · @ files · shift\+tab mode\s*$/, `idle footer: ${last(sh.byName.idle)}`);
    assert.match(last(sh.byName.busy), /ctrl\+c interrupt · ctrl\+o activity · shift\+tab mode\s*$/, `running footer: ${last(sh.byName.busy)}`);
    assert.match(last(sh.byName.done), /\/ commands/, 'idle again once the turn ends');
  });

  // ---- P — profile toggles ------------------------------------------------------
  const seq = ['/fast', '/fast', '/eco', '/eco', '/fast', '/eco', '/normal'];
  const want = ['FAST', null, 'ECO', null, 'FAST', 'ECO', null];
  const steps = [{ until: 'Ask LAIN', timeout: 30000 }];
  // Each command's receipt names the profile it set; wait for it before the snap
  // (a fixed settle raced the first repaint under a loaded full tier).
  const receipt = ['FAST', 'NORMAL', 'ECO', 'NORMAL', 'FAST', 'ECO', 'NORMAL'];
  seq.forEach((c, i) => { steps.push({ send: `${c}\r` }, { until: `${receipt[i]}(?: \\(token economy\\))? · AUTO`, timeout: 10000 }, { snap: `p${i}`, settle: 700 }); });
  const p = await tty.runTty({ cols: 110, rows: 28, steps });
  await test('CLI P: /fast and /eco toggle; /normal resets — the header follows exactly', () => {
    want.forEach((w, i) => {
      const head = p.byName[`p${i}`].text[0];
      if (w) assert.match(head, new RegExp(`\\b${w}\\b`), `${seq[i]} → ${w}: ${head}`);
      else assert.ok(!/\b(FAST|ECO)\b/.test(head), `${seq[i]} → NORMAL: ${head}`);
    });
  });
};
