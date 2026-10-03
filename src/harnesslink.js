'use strict';

/** WHERE THE HARNESS MEETS THE REPL — the whole of the wiring, in one file. */

/** Was this module ever loaded? Frozen surfaces are cleaned up only if they ran (S9). */
const loaded = (m) => { try { return Boolean(require.cache[require.resolve(m)]); } catch { return false; } };
const { STATE } = require('./harness/state');
// The mode verdict is consumed, never re-derived — see beginTurn.
const modeId = require('./mode');

/** ATTACH ONE. Lazy, because constructing it is cheap but not free, and a one-shot `lain -p 'what is 2+2'` should not build a process manager. */
function harnessFor(app) {
  if (!app) return null;
  if (!app._harness) {
    const { Harness } = require('./harness');
    app._harness = Harness.forApp(app);
  }
  return app._harness;
}

/** The harness only if one already exists — for readers that must not create one. */
function existing(app) { return (app && app._harness) || null; }

/** A TURN IS STARTING. */
function beginTurn(app, verdict, text) {
  // A CONVERSATION IS NOT A TASK
  const chatty = verdict.mode === modeId.KIND.CHAT || verdict.mode === modeId.KIND.EXPLAIN
    || require('./readonly').active(app.session);
  if (chatty && !existing(app)) return null;
  // AN ASIDE (identify.js) is a question asked while the Coding Agent carries
  // a task: it opens no task record of its own and closes none.
  if (verdict.aside) return null;

  let h;
  try { h = harnessFor(app); } catch { return null; }
  if (!h) return null;
  const objective = (app.session.task && app.session.task.objective) || text;
  // LATEST, NOT ACTIVE, AND THE DIFFERENCE IS A REAL BUG THIS AVOIDS.
  const live = h.runtime.latest();
  if (chatty && (!live || live.terminal)) return null;

  if (!verdict.sameTask || !live) {
    const task = h.begin({
      title: String(objective || text).replace(/\s+/g, ' ').slice(0, 100),
      objective,
      sessionId: app.session.id,
    });
    h.runtime.start(task.id, 'the person asked for something');
    return task;
  }
  if (live.terminal) {
    // THE SAME OBJECTIVE AFTER A VERDICT IS A REPAIR, and naming it as one is what makes "two attempts" visible later.
    const repair = h.runtime.repairFor(live.id, { title: `repair: ${live.title}` });
    if (repair) h.runtime.start(repair.id, 'the work continued after a verdict');
    return repair;
  }
  if (live.state === STATE.BLOCKED || live.state === STATE.VERIFYING) {
    h.runtime.resume(live.id, 'the person said something else');
  }
  return live;
}

/** A TURN HAS ENDED. */
function endTurn(app, record = null) {
  const h = existing(app);
  if (!h) return null;
  const task = h.runtime.active();
  if (!task) return null;
  const life = app.session && app.session.lifecycle;
  if (!life) return null;
  const summary = life.summary ? life.summary() : { state: life.state, reason: '' };
  const mapped = h.runtime.syncLifecycle(task.id, summary.state, summary.reason || '');
  // AND THE CLAIM ITSELF, WHICH THE LIFECYCLE DELIBERATELY DOES NOT ACT ON
  if (mapped && mapped.ok && h.runtime.get(task.id).state === STATE.RUNNING
      && record && require('./lifecycle').claimsSuccess(record.text)) {
    return h.runtime.verifying(task.id, 'the model reported success — the evidence decides');
  }
  return mapped;
}

/** THE SESSION IS ENDING. */
async function shutdown(app) {
  // THE AUTHENTICATED BROWSER GOES TOO, AND IT IS NOT THE HARNESS'S
  try { await require('./modelsource/webbrowser').forApp(app).closeAll(); } catch { /* the way out is never blocked by cleanup */ }
  // AND THE FRONTEND WORKSHOP'S PREVIEW BROWSER
  try { if (loaded('./workshop')) await require('./workshop').forApp(app).closeAll(); } catch { /* the way out is never blocked by cleanup */ }   // frozen surfaces: only if they ever loaded
  // AND ANY BROWSER THE RUNTIME OWNS THAT NOBODY ELSE CLAIMED
  try { await require('./env/chromium').forApp(app).stopAll(); } catch { /* the way out is never blocked by cleanup */ }
  // LANGUAGE SERVERS AND DEBUG ADAPTERS this process started are stopped with
  // it (the runtime registry's stop-on-owner-exit is the backstop, not the plan).
  try { await require('./lsp/manager').stopAll(); } catch { /* the way out is never blocked by cleanup */ }
  try { if (loaded('./dap/manager')) await require('./dap/manager').stopAll(); } catch { /* the way out is never blocked by cleanup */ }
  const h = existing(app);
  if (!h) return;
  try { await h.shutdown(); } catch { /* the way out is never blocked by cleanup */ }
}

module.exports = { harnessFor, existing, beginTurn, endTurn, shutdown };
