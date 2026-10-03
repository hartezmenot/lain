'use strict';

/** STOPPING LAIN — everything it owns, in the order that leaves nothing behind. */

async function shutdown(viewApp, { why = 'the session ended', closeWindow = true } = {}) {
  // IT ALWAYS SHUTS DOWN THE PROCESS, NOT A CONVERSATION
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

  // AND THE SHELL JOBS, WHICH ARE ACTUAL CHILD PROCESSES.
  await step('shell jobs', () => { if (app._jobs) app._jobs.stopAll(why); });

  // AND EVERY PROJECT TERMINAL.
  await step('project terminals', () => require('./pty').closeAll(app));

  // EVERY LIVE CONVERSATION, not only the one in front of us.
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

  // A LISTENING SOCKET AND A DESKTOP BRIDGE must not outlive the LAIN that opened them — a surface still answering after LAIN exits, or a bridge still…
  await step('the harness services', () => require('./harnesslink').shutdown(app));
  await step('the computer bridge', () => { if (app._desktop) app._desktop.bridge.close(why); });
  await step('the control window', () => require('./controlwindow').close(app));
  await step('the specialist workers', () => require('./workerruntime').settle(app));

  // THE NATIVE WINDOW AND ITS CHANNEL.
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
