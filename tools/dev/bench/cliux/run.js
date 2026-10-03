'use strict';

/**
 * WHAT THE CLI SHOWS DURING A TURN — real ConPTY, real VT screen, mock model.
 *
 *   LAIN_TTY_PYTHON=<python with pywinpty+pyte> node bench/cliux/run.js [--out dir]
 *
 * Scripts a realistic turn (slow first response with reasoning → read_file → run_background → job_wait → answer)
 * and snapshots the screen every 400 ms, then prints the ACTIVITY area of each distinct frame. This is the evidence
 * for "duplicate Thinking / Waiting / job_wait" and for silence: what a person actually sees, frame by frame.
 */

const fs = require('fs');
const path = require('path');
const { runTty } = require('../../../../tests/tty/realtty');

const out = (() => { const i = process.argv.indexOf('--out'); return i >= 0 ? process.argv[i + 1] : null; })();

const script = [
  { delayMs: 3500, reasoning: 'I should look at the file first to see what it contains before answering.', tool_calls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
  { delayMs: 2500, text: 'Starting the check in the background.', tool_calls: [{ name: 'run_background', input: { command: 'ping -n 5 127.0.0.1', shell: 'cmd' } }] },
  { delayMs: 1200, tool_calls: [{ name: 'job_wait', input: { id: 'j1' } }] },
  { delayMs: 2500, reasoning: 'The job finished; summarise.', text: 'Done. a.txt holds alpha and beta; the check passed.' },
];

const steps = [{ until: '›|>|Noema', timeout: 20000 }, { wait: 1800 }, { send: 'look at a.txt and run the check\r' }];
for (let i = 0; i < 45; i++) steps.push({ wait: 400 }, { snap: `t${String(i).padStart(2, '0')}` });

(async () => {
  const cwd = fs.mkdtempSync(path.join(require('os').tmpdir(), 'noema-cliux-'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'alpha\nbeta\n');
  const r = await runTty({ script, steps, cols: 110, rows: 32, cwd });
  const seen = new Set();
  const lines = [];
  for (const [name, snap] of Object.entries(r.byName || {})) {
    const screen = snap.text || [];
    const body = screen.map((l) => String(l).replace(/\s+$/, '')).filter(Boolean);
    const key = body.join('\n');
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`===== ${name} =====`, ...body);
  }
  const text = lines.join('\n');
  if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'frames.txt'), text); fs.writeFileSync(path.join(out, 'raw.json'), JSON.stringify(r, null, 1)); }
  process.stdout.write(text + '\n');
})().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
