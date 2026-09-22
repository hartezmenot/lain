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
    assert.match(resumed, /recovered · cut off at step 2 · type continue to resume/i, `the recovery is said:\n${resumed}`);
    assert.match(vis(g2.byName.goal), /quarterly report/, 'the goal came back');
    const s = sessions(g1.configDir)[0];
    assert.strictEqual(s.inflight, null, 'repaired and saved');
    const lost = s.messages.find((m) => m.role === 'tool' && /\[RECOVERED · UNKNOWN\]/.test(String(m.content)));
    assert.ok(lost, 'the killed command is answered UNKNOWN');
    const last = s.turns[s.turns.length - 1];
    assert.strictEqual(last.stopReason, 'crashed');
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
      { until: 'STREAMING', timeout: 20000 }, { snap: 'streaming', settle: 600 },
      { until: 'PREPARING TOOL', timeout: 30000 }, { snap: 'preparing', settle: 1500 },
      { until: 'Wrote the table', timeout: 30000 }, { snap: 'done', settle: 2500 },
    ],
  });
  await test('CLI L1: while words stream, the box says STREAMING and quotes the model\'s own words', () => {
    const s = vis(l.byName.streaming);
    assert.match(s, /STREAMING · \d\d:\d\d/);
    assert.match(s, /tracing|recovery state/, `commentary visible:\n${s}`);
  });
  await test('CLI L2: a large tool call streaming reads PREPARING TOOL · write_file · <size> — never STALLED', () => {
    const s = vis(l.byName.preparing);
    assert.match(s, /PREPARING TOOL/);
    assert.match(s, /write_file · \d+(\.\d)? (KB|B)/, s);
    assert.ok(!/STALLED/.test(s));
  });
  await test('CLI D1: the Diff is in the feed unasked, and survives the end of the turn; the activity box is gone', () => {
    const s = vis(l.byName.done);
    assert.match(s, /table\.js/);
    assert.match(s, /\+16\d/, 'the + count');
    assert.match(s, /export const row\d+ = \d+;/, 'the changed lines themselves are on screen');
    assert.ok(!/PREPARING TOOL|STREAMING ·/.test(s), 'the temporary activity is gone');
    // Colour: the `+` rows and the +N count are drawn green (pyte fg per row).
    const snap = l.byName.done;
    const y = snap.text.findIndex((t) => /\+ export const row/.test(t));
    assert.ok(y >= 0, 'an added row is on screen');
    const greenish = (c) => /green/i.test(c) || /^[0-9a-f]{6}$/i.test(c) && parseInt(c.slice(2, 4), 16) > parseInt(c.slice(0, 2), 16) + 40;
    assert.ok(snap.fg[y].some(greenish), `the + row is green: ${JSON.stringify(snap.fg[y])}`);
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
