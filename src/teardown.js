'use strict';

/**
 * STOPPING LAIN — everything it owns, in the order that leaves nothing behind.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE NOW.
 *
 * This sequence lived at the foot of `repl.js`, which was right while the only
 * way to end LAIN was to type `/exit` in a terminal. There are three ways now:
 *
 *     the terminal ends       repl.js, as before
 *     Quit from the tray      the window's menu, with no terminal involved
 *     a `quit` on the control pipe   a second launcher asking the first to stop
 *
 * Three callers and one sequence. Duplicating it would mean a shutdown path
 * that forgets the shell jobs, or the browsers, or the desktop host — and the
 * whole reason this list is long is that every entry on it is something this
 * repository has already paid for by leaving it running.
 *
 * ------------------------------------------------------------------------
 * CLOSING A WINDOW IS NOT THIS.
 *
 * Pressing X on LAIN Desktop hides it to the tray: the bots stay connected, the
 * background work carries on, Core stays up. That is a WINDOW event and it is
 * handled in the window (native/host.cs). This file is the other thing — the
 * explicit end of the application — and it is reached only when a person says
 * so. The two must never be spelled with the same button. See §18 of the
 * lifecycle correction, and src/corelock.js for the verb that gets here.
 */

/**
 * @param {object} app
 * @param {{why?: string, closeWindow?: boolean}} opts
 */
async function shutdown(viewApp, { why = 'the session ended', closeWindow = true } = {}) {
  // ---- IT ALWAYS SHUTS DOWN THE PROCESS, NOT A CONVERSATION -------------
  //
  // A Quit from the tray arrives as a route, and a route acts on the session
  // the window is VIEWING (harnessapp/routes.js `acting`) — which may be a
  // sibling. The gateway, the shell jobs, the harness services and the computer
  // bridge all hang off the PRIMARY App, so shutting down through a sibling
  // would sweep almost nothing and report success: every one of those would be
  // left running with nothing on screen to say so.
  //
  // Found by reading this after wiring the quit route, not by a failure —
  // which is why it is stated here rather than fixed quietly.
  const app = viewApp && viewApp._sibling ? viewApp._sibling : viewApp;
  const problems = [];
  const step = async (what, fn) => {
    try { await fn(); } catch (e) { problems.push(`${what}: ${(e && e.message) || e}`); }
  };

  // THE MESSAGING GATEWAY FIRST. It holds a long poll and can accept new work;
  // stopping it first means nothing new arrives during the rest of this.
  await step('the bot service', async () => { if (app._botService) await app._botService.stop(); });
  // THE ASSISTANT'S CLOCK (and its lease, so the next LAIN takes over at once),
  // and OpenCode's owned server — see assistant/scheduler.js, drivers/opencodeserver.js.
  await step('the assistant scheduler', () => require('./assistant/scheduler').stop(app));
  await step('the OpenCode server', () => require('./drivers/opencodeserver').stop());
  // THE LAIN SERVER and the MCP servers LAIN started (Phase 8.1) end with LAIN — never orphaned.
  await step('the LAIN server', () => require('./serve').stop());
  await step('MCP servers', () => { for (const id of [...require('./integrations')._live.keys()]) require('./integrations').disconnect(app, id); });

  // EACH ACCOUNT'S RUNTIME (a codex app-server per signed-in account) — the
  // processes this LAIN started, by their own handles.
  await step('account runtimes', () => require('./accountinstances').stopAll());

  // A BACKGROUND JOB HOLDS a provider request, a tool and a forked session. It
  // must not outlive the LAIN that started it.
  await step('background jobs', () => app.jobs.cancelAll(why));

  // AND THE SHELL JOBS, WHICH ARE ACTUAL CHILD PROCESSES. `run_background`
  // spawns a real child — a test suite, a build, a watcher — and for a long
  // time nothing ever called `stopAll`, so one started before `/exit` simply
  // carried on, detached, with nobody left who knew about it. `/ps` is what
  // made it visible.
  await step('shell jobs', () => { if (app._jobs) app._jobs.stopAll(why); });

  // AND EVERY PROJECT TERMINAL. A pseudoconsole is a real shell with a real
  // child; one left running after LAIN exits is the orphan this sequence exists
  // to prevent, and it is the kind a person cannot even see to close.
  await step('project terminals', () => require('./pty').closeAll(app));

  // EVERY LIVE CONVERSATION, not only the one in front of us. A session the
  // window opened beside this one has its own turn, its own jobs and its own
  // unsaved state — see src/sessionpool.js.
  await step('the other open sessions', () => {
    const pool = app.pool();
    for (const id of pool.ids()) {
      const other = pool.live(id);
      if (!other || other === app) continue;
      try { if (other.abort && !other.abort.signal.aborted) other.abort.abort(); } catch { /* already done */ }
      try { other.jobs.cancelAll(why); } catch { /* none started */ }
      try { other.session.save(); } catch { /* keep what it had */ }
    }
  });

  // A LISTENING SOCKET AND A DESKTOP BRIDGE must not outlive the LAIN that
  // opened them — a surface still answering after LAIN exits, or a bridge still
  // holding a grant, is exactly the thing nobody remembers turning off.
  await step('the harness services', () => require('./harnesslink').shutdown(app));
  await step('the computer bridge', () => { if (app._desktop) app._desktop.bridge.close(why); });
  await step('the control window', () => require('./controlwindow').close(app));
  await step('the specialist workers', () => require('./workerruntime').settle(app));

  // THE NATIVE WINDOW AND ITS CHANNEL. Awaited, because "closed" has to mean the
  // process is gone: a `close` that fired a kill and reported success left two
  // LAIN Desktop hosts on the desktop with nothing left to talk to.
  if (closeWindow) {
    await step('the desktop window', () => require('./desktopwindow').close());
    await step('the desktop channel', () => require('./harnessapp/ipc').stop());
  }

  // AND STOP BEING THE LAIN THIS ACCOUNT IS RUNNING, so the next launch starts
  // one rather than talking to a pipe nobody is listening on.
  await step('the core lock', () => require('./corelock').release());

  await step('saving the session', () => app.session.save());
  // AFTER the save: the next host reads what this one wrote. Unfinished work becomes a pause (sessionlease.js).
  await step('the session leases', () => require('./surfacehandoff').releaseAll(app));
  return { ok: problems.length === 0, problems };
}

module.exports = { shutdown };
