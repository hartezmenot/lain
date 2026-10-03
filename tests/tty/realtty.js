'use strict';

/**
 * RUN LAIN IN A REAL TERMINAL AND READ BACK WHAT IS ON THE SCREEN.
 *
 * The pipe tier (runCli + LAIN_FORCE_TUI) proves the draw path writes the right
 * bytes. This tier proves a TERMINAL shows the right thing: the child gets a real
 * Windows pseudo-console (process.stdout.isTTY, real resize), and every snapshot
 * is the cell grid of a VT emulator that measures wide characters at two cells.
 * Evidence from this tier is REAL_TTY_VERIFIED; from the pipe tier it is not.
 *
 * REQUIRES a Python with `pywinpty` and `pyte`, named by LAIN_TTY_PYTHON. Without
 * it `available()` is false and the tests SKIP and say so — a green run on a
 * machine that could not open a terminal must not read as terminal proof.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { prepareCli, BIN } = require('../helpers');

const DRIVER = path.join(__dirname, 'ptydrive.py');

let probed = null;

/** Is a real-terminal driver available on this machine? */
function available() {
  if (probed) return probed;
  const py = process.env.LAIN_TTY_PYTHON;
  if (!py) { probed = { ok: false, why: 'LAIN_TTY_PYTHON is not set' }; return probed; }
  const pty = process.platform === 'win32' ? 'winpty' : 'ptyprocess';   // ConPTY on Windows, a real pty elsewhere (ptydrive.py)
  const r = spawnSync(py, ['-c', `import ${pty}, pyte`], { encoding: 'utf8', timeout: 20000 });
  probed = r.status === 0 ? { ok: true, python: py } : { ok: false, why: `${py} cannot import ${pty}/pyte: ${(r.stderr || '').trim().slice(0, 160)}` };
  return probed;
}

/**
 * @param {object} o
 *   `script`  mock provider steps
 *   `steps`   driver steps (see ptydrive.py)
 *   `cols`, `rows`
 * @returns {Promise<{snaps, timeouts, byName}>}
 */
async function runTty({ script = [], steps = [], cols = 100, rows = 30, timeoutMs = 240000, env: extra = {}, args = [], cwd: at = null, configDir: cfgDir = null, trust = true } = {}) {
  const probe = available();
  if (!probe.ok) throw new Error(probe.why);
  const { cwd, configDir, env } = prepareCli({ script, env: extra, ...(at ? { cwd: at } : {}), ...(cfgDir ? { configDir: cfgDir } : {}), trust });
  // A REAL TERMINAL: nothing forces the TUI and nothing fakes a size.
  delete env.LAIN_FORCE_TUI;
  delete env.COLUMNS;
  delete env.LINES;
  delete env.LAIN_NO_COLOR;
  delete env.NO_COLOR;
  const scope = await require('../supervisor-scope').open();
  env.LAIN_SUPERVISOR_LEASE_PORT = String(scope.port);
  fs.mkdirSync(configDir, { recursive: true });
  const scenario = path.join(configDir, 'tty-scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ argv: [process.execPath, BIN, ...args], cwd, env, cols, rows, steps }));
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(probe.python, [DRIVER, scenario], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
      child.on('close', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`driver produced no result: ${stderr.slice(-600)}`)); }
      });
    });
    out.byName = Object.fromEntries(out.snaps.map((s) => [s.name, s]));
    out.cwd = cwd;
    out.configDir = configDir;
    return out;
  } finally {
    try { await require('../../src/supervisor').shutdownIn(env.LAIN_HOME); } catch { /* none started */ }
    await scope.close();
  }
}

/** Rows of a snapshot whose painted cells fall outside the content frame. */
function escapes(snap) {
  const { contentBounds } = require('../../src/ui/frame');
  const b = contentBounds(snap.cols);
  const lo = b.left;
  const hi = b.left + b.width - 1;
  const bad = [];
  snap.extents.forEach((e, y) => {
    if (!e) return;
    if (e[0] < lo || e[1] > hi) bad.push({ y, from: e[0], to: e[1], lo, hi, text: snap.text[y].slice(0, 60) });
  });
  return bad;
}

const visible = (snap) => snap.text.join('\n');

module.exports = { available, runTty, escapes, visible };
