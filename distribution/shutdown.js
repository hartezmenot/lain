'use strict';

/**
 * ASK A RUNNING LAIN TO STOP — for the installer, before it replaces binaries.
 *
 *     node distribution/shutdown.js
 *
 * ------------------------------------------------------------------------
 * IT USES THE ONE CONTROL PATH, AND SAYS SO IN ONE LINE.
 *
 * `src/corelock.js` is the single-instance lock and its control pipe, with
 * exactly three verbs — show, status, quit. `quit` runs LAIN's own shutdown
 * sequence (src/teardown.js): the gateway, the agent and shell jobs, the
 * project terminals, every live session, the harness services, the computer
 * bridge, the window, the lock. That is what makes an upgrade safe, and it is
 * why the installer asks rather than kills.
 *
 * IT ALWAYS EXITS. An installer that hangs waiting for a reply is worse than
 * one that gives up: there may be no LAIN running at all, which is the ordinary
 * case for a first install.
 *
 * (This exists because the installer first called `bin/lain-control.js quit`,
 * which is a DIFFERENT program — the Computer MCP stop window — that takes a
 * directory rather than a verb. It sat forever waiting for a state file, and
 * the install hung.)
 */

const WAIT_MS = 25_000;

async function main() {
  let lock;
  try { lock = require('../src/corelock'); } catch (e) {
    process.stdout.write(`no control channel in this install: ${e.message}\n`);
    return 0;
  }

  let found = null;
  try { found = await lock.discover(); } catch (e) {
    process.stdout.write(`could not look for a running LAIN: ${e.message}\n`);
    return 0;
  }
  if (!found || !found.running) { process.stdout.write('no LAIN is running\n'); return 0; }

  process.stdout.write(`asking LAIN (pid ${found.pid}) to shut down\n`);
  try { await lock.ask('quit'); } catch (e) {
    process.stdout.write(`it did not take the request: ${e.message}\n`);
    return 1;
  }

  // WAIT FOR IT TO ACTUALLY GO, because "asked" is not "stopped" and the next
  // thing the installer does is overwrite the files it is running from.
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    let alive = false;
    try { process.kill(found.pid, 0); alive = true; } catch { alive = false; }
    if (!alive) { process.stdout.write('it stopped\n'); return 0; }
    await new Promise((r) => setTimeout(r, 300));
  }
  process.stdout.write(`it is still running after ${Math.round(WAIT_MS / 1000)}s\n`);
  return 2;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    process.stdout.write(`${(e && e.message) || e}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
