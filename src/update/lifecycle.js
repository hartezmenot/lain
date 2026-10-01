'use strict';

/**
 * RESTART FOR AN UPDATE, AND EXIT — the one safe way Noema stops while work may be in hand (packaging pass §I3, §K).
 *
 *   when: 'now'         at once (offered only when idle, or when the person chose "stop")
 *         'checkpoint'  at the next COMMITTED checkpoint (taskcheckpoint.js commit) — never mid-step
 *         'task'        when the Coding Agent is no longer working (the task finished, paused or needs the person)
 *
 * THE SEQUENCE, always the same: commit the checkpoint → save the session → release the writer lease (a pause, never
 * an ending) → then, for an update, point the install at the staged version and exit with 75 so the launcher starts it
 * with `--resume <session> --after-update`; for Exit, the ordinary shutdown (teardown.js). The resumed process
 * continues the SAME task from the SAME committed step — the stale "Step 3/4" failure cannot recur, because the
 * position is the durable commit, not a count.
 */

const WATCH_MS = 2000;

function busy(app) {
  try {
    if (app.abort) return true;
    const w = require('../workbench').of(app.session);
    return Boolean(w && ((w.autoRun && w.autoRun.waiting && w.autoRun.waiting.until > Date.now()) || w.running));
  } catch { return Boolean(app && app.abort); }
}

function saveNow(app, reason) {
  const s = app && app.session;
  if (!s) return null;
  let cp = null;
  try { if (s.plan) cp = require('../taskcheckpoint').commit(s, reason); } catch { cp = null; }
  try { s.save(); } catch { /* reported by the caller's next read */ }
  try { require('../surfacehandoff').release(app); } catch { /* not the CLI */ }
  try { s.save(); } catch { /* as above */ }
  return cp;
}

/** DO IT NOW. kind: 'update' | 'exit'. Returns what happened; the process ends shortly after. */
async function perform(app, kind, { stopTurn = false } = {}) {
  if (stopTurn && app.abort) { try { app.abort.abort(); } catch { /* ended */ } await new Promise((r) => setTimeout(r, 300)); }
  const cp = saveNow(app, kind === 'update' ? 'restart for update' : 'exit');
  const s = app.session;
  if (kind === 'update') {
    const U = require('./updater');
    const surface = require('../surfacehandoff').surfaceOf(app);
    const args = [...(surface === 'cli' ? [] : ['--desktop']), ...(s && s.id ? ['--resume', s.id] : []), '--after-update'];
    const r = U.apply({ args, cwd: (s && s.cwd) || process.cwd() });
    if (!r.ok) return r;
    try { app.render.notice('info', `Restarting into Noema ${r.version} — this ${surface === 'cli' ? 'terminal' : 'window'} continues ${cp && cp.stepIndex ? `at step ${cp.stepIndex} of ${cp.stepTotal}` : 'where it was'}.`); } catch { /* no renderer */ }
    process.exitCode = r.restartCode;
    setTimeout(() => process.exit(r.restartCode), 300).unref();
    try { await require('../teardown').shutdown(app, { why: 'restarting for an update' }); } catch { /* exiting anyway */ }
    return { ok: true, restarting: r.version, checkpoint: cp };
  }
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 3000).unref();
  try { await require('../teardown').shutdown(app, { why: 'Exit Noema' }); } catch { /* exiting anyway */ }
  return { ok: true, exiting: true, checkpoint: cp };
}

/**
 * ARM IT for later: 'checkpoint' fires on the next committed checkpoint, 'task' when the Agent stops working.
 * One arm at a time per kind; a newer choice replaces an older one; `cancel` clears it.
 */
function arm(app, kind, when) {
  const st = app._pendingStop || (app._pendingStop = {});
  cancel(app, kind);
  if (when === 'now') { perform(app, kind).catch(() => null); return { ok: true, when }; }
  if (when === 'checkpoint') {
    // AT THE COMMIT the turn is stopped before it starts the next step: the resumed process begins that step fresh.
    const off = require('../taskcheckpoint').onCommit((session) => {
      if (session !== app.session) return;
      off();
      st[kind] = null;
      setImmediate(() => perform(app, kind, { stopTurn: true }).catch(() => null));
    });
    st[kind] = { when, off, at: Date.now() };
    // NO TASK AT ALL: there is no checkpoint coming — idle means now.
    if (!busy(app)) { off(); perform(app, kind).catch(() => null); return { ok: true, when: 'now' }; }
    return { ok: true, when };
  }
  if (when === 'task') {
    let quiet = 0;
    const t = setInterval(() => {
      quiet = busy(app) ? 0 : quiet + 1;
      if (quiet >= 2) { clearInterval(t); st[kind] = null; perform(app, kind).catch(() => null); }
    }, WATCH_MS);
    if (typeof t.unref === 'function') t.unref();
    st[kind] = { when, off: () => clearInterval(t), at: Date.now() };
    return { ok: true, when };
  }
  return { ok: false, why: `when is now, checkpoint or task` };
}

function cancel(app, kind) {
  const st = app._pendingStop || {};
  const cur = st[kind];
  if (cur && typeof cur.off === 'function') { try { cur.off(); } catch { /* gone */ } }
  st[kind] = null;
  return { ok: true };
}

function pending(app, kind) { const st = app._pendingStop || {}; return st[kind] ? st[kind].when : null; }

module.exports = { busy, perform, arm, cancel, pending };
