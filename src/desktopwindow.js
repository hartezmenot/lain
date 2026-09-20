'use strict';

/**
 * THE LAIN DESKTOP WINDOW — one per LAIN, owned, and ended with it.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT INSIDE desktop.js. That module BUILDS the host and knows how
 * to start one. This one knows there should be exactly ONE, that a second
 * `/app` means "show me the window I already have" rather than "give me
 * another", and that a window must not outlive the LAIN it renders.
 *
 * AN ORPHANED WINDOW IS THE FAILURE TO AVOID. A host process that survives its
 * Core shows a live-looking application backed by nothing: it reconnects
 * forever to a pipe that will never answer, and the person is looking at the
 * last frame of a session that ended. So the child is tracked, ended on exit,
 * and — because a crash is not a graceful exit — the host also gives up on its
 * own when the pipe stays gone (native/host.cs bounds the backoff).
 */

const desktop = require('./desktop');

let held = null;

function alive() {
  return Boolean(held && held.child && held.child.exitCode === null && !held.child.killed);
}

/**
 * OPEN IT, OR SAY WHY NOT.
 *
 * @returns {Promise<{ok: boolean, why?: string, already?: boolean, pid?: number}>}
 */
async function open(app, { dev = false, debugPort = 0 } = {}) {
  if (alive()) {
    // ---- A SECOND `/app` IS "SHOW ME THE WINDOW" -------------------------
    //
    // And since X sends LAIN to the TRAY rather than ending it, "the host is
    // running" no longer implies "the window is on screen". This returned
    // `already: true` and did nothing — so after closing LAIN to the tray, every
    // way of asking for it back reported success and left it hidden.
    //
    // Raising a window belongs to the process that OWNS it (Windows will not
    // give this one the foreground right), so Core asks and the host does it.
    // See harnessapp/ipc.js `toHost` and native/host.cs `FromCore`.
    const shown = require('./harnessapp/ipc').toHost('show');
    return { ok: true, already: true, pid: held.pid, shown: Boolean(shown.ok), why: shown.ok ? '' : shown.why };
  }
  const r = await desktop.open(app, { dev, debugPort });
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

/**
 * CLOSE IT, AND WAIT UNTIL IT IS ACTUALLY CLOSED.
 *
 * AWAITABLE ON PURPOSE. The first version fired `stopTree` and returned
 * `{closed: true}` immediately, which read as done and was not: a caller that
 * exited straight afterwards left the window standing. Measured — a second
 * launch found the first host still on the desktop, reporting a successful
 * close. "Closed" has to mean the process is gone, so this resolves when it is.
 *
 * `closeSync` stays for the exit handlers, where there is nothing left to await
 * with and a best-effort kill is the only thing available.
 */
async function close() {
  if (!alive()) { held = null; return { ok: true, closed: false }; }
  const child = held.child;
  const pid = held.pid;
  held = null;

  // ---- ASK FIRST, SO THE TRAY ICON GOES WITH IT -------------------------
  //
  // A killed host leaves its notification-area icon behind until somebody
  // hovers over it — a ghost LAIN in the corner of the screen for something
  // that no longer exists. Windows only removes it when the owning process
  // disposes it, which needs `OnClosing` to actually run.
  //
  // BOUNDED, AND NOT TRUSTED. A host that is wedged, mid-crash or not listening
  // gets no say: the kill below happens regardless once this short grace period
  // is over. "Closed" still has to mean the process is gone.
  try {
    if (require('./harnessapp/ipc').toHost('exit').ok) {
      const graceful = Date.now() + 1500;
      while (child.exitCode === null && !child.killed && Date.now() < graceful) {
        // eslint-disable-next-line no-await-in-loop -- a short, bounded grace period.
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  } catch { /* the channel is already down; fall through to the kill */ }

  // THE TREE, NOT THE PROCESS. A WebView2 host owns renderer and GPU children;
  // ending only the parent leaves them behind. processes.js already owns how a
  // tree is ended per platform, so there is not a second answer here.
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
