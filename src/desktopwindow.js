'use strict';

/** THE LAIN DESKTOP WINDOW — one per LAIN, owned, and ended with it. */

const desktop = require('./desktop');

let held = null;

function alive() {
  return Boolean(held && held.child && held.child.exitCode === null && !held.child.killed);
}

/** OPEN IT, OR SAY WHY NOT. */
async function open(app, { dev = false, debugPort = 0, mode = null, section = null, minimized = false } = {}) {
  if (alive()) {
    // STARTED MINIMIZED AT SIGN-IN and a window already exists: leave it where it is — never steal the foreground.
    if (minimized) return { ok: true, already: true, pid: held.pid, shown: false, why: '' };
    // A SECOND `/app` IS "SHOW ME THE WINDOW"
    const shown = require('./harnessapp/ipc').toHost('show');
    return { ok: true, already: true, pid: held.pid, shown: Boolean(shown.ok), why: shown.ok ? '' : shown.why };
  }
  if (mode) app._surfaceMode = mode;
  const r = await desktop.open(app, { dev, debugPort, mode, section, minimized });
  if (!r.ok) return r;

  held = r;
  r.child.on('exit', () => { if (held && held.child === r.child) held = null; });

  // THE WINDOW GOES WHEN LAIN GOES. Registered once, and idempotent: a second
  // open replaces what is held, and closing an already-dead child is a no-op.
  if (!open._wired) {
    open._wired = true;
    const end = () => { try { closeSync(); } catch { /* shutting down anyway */ } };
    process.once('exit', end);
    process.once('SIGINT', end);
    process.once('SIGTERM', end);
  }
  return { ok: true, pid: r.pid, pipe: r.pipe, debugPort: r.debugPort || 0 };
}

function status() {
  return alive()
    ? { open: true, pid: held.pid, exe: held.exe, assets: held.assets }
    : { open: false, pid: null, exe: null, assets: null };
}

/** CLOSE IT, AND WAIT UNTIL IT IS ACTUALLY CLOSED. */
async function close() {
  if (!alive()) { held = null; return { ok: true, closed: false }; }
  const child = held.child;
  const pid = held.pid;
  held = null;

  // ASK FIRST, SO THE TRAY ICON GOES WITH IT
  try {
    if (require('./harnessapp/ipc').toHost('exit').ok) {
      const graceful = Date.now() + 1500;
      while (child.exitCode === null && !child.killed && Date.now() < graceful) {
        // eslint-disable-next-line no-await-in-loop -- a short, bounded grace period.
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  } catch { /* the channel is already down; fall through to the kill */ }

  // THE TREE, NOT THE PROCESS.
  try { await require('./harness/processes').stopTree(child); }
  catch { try { child.kill(); } catch { /* already gone */ } }
  // AND THE HANDLES GO WHEN THE PROCESS DOES, not when the kill returns.
  const deadline = Date.now() + 8000;
  while (child.exitCode === null && !child.killed && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- waiting on a process exit.
    await new Promise((r) => setTimeout(r, 50));
  }
  return { ok: true, closed: true, pid };
}

/** The exit path: no await is possible there, so it is best effort and says so. */
function closeSync() {
  if (!alive()) { held = null; return { ok: true, closed: false }; }
  const child = held.child;
  const pid = held.pid;
  held = null;
  try { require('./harness/processes').stopTree(child).catch(() => {}); } catch { /* below */ }
  try { child.kill(); } catch { /* already gone */ }
  return { ok: true, closed: true, pid, bestEffort: true };
}

module.exports = { open, close, closeSync, status, alive };
