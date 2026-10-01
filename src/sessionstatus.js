'use strict';

/**
 * WHAT A SESSION IS DOING — ONE AUTHORITATIVE ANSWER, EIGHT WORDS.
 *
 *     IDLE · RUNNING · WAITING · QUEUED · NEEDS_INPUT · VERIFYING · DONE · FAILED
 *
 * ------------------------------------------------------------------------
 * A PROJECTION OF OWNERS, NOT A SECOND LIFECYCLE.
 *
 * Nothing here is stored as "the status". Every word is read, at the moment it
 * is asked, from the authority that already holds the fact:
 *
 *   running          app.abort — the turn's own controller (sessionpool.running)
 *   needs input      the Harness port's open question, the terminal's
 *                    pendingAsk, a background job parked on a question, or the
 *                    lifecycle saying NEEDS_USER / NEEDS_AUTH
 *   waiting          the turn loop's RETRYING phase (a provider backoff or rate
 *                    limit) or the terminal's own rate-limit wait
 *   queued           a sentence admitted by `handle` whose turn has not begun
 *   verifying        the Harness task record in VERIFYING, or a verification
 *                    tool running, while the turn is live
 *   failed           the last turn's provider failure, a FAILED lifecycle, or
 *                    a FAILED Harness task
 *   done / idle      the last turn exists / there has been none
 *
 * The frontend never infers any of these: it renders `state` and the
 * `summary` beside it. `startedAt` and `elapsed` come from the execution clock
 * that already exists — the terminal's work clock when there is a terminal, and
 * otherwise the turn-start stamp turnauthority.begin records at the same moment
 * the Guardian is told a turn began. No second timer is started here.
 *
 * ------------------------------------------------------------------------
 * LIVE IN THE BACKGROUND. `touch` is called from the places a status can move
 * — every turn phase, every turn end, a question opening or being answered —
 * and emits `session.status` to the window when the word changed, so a rail row
 * for a session nobody is looking at changes the moment its work does.
 */

const STATE = Object.freeze({
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
  QUEUED: 'QUEUED',
  NEEDS_INPUT: 'NEEDS_INPUT',
  VERIFYING: 'VERIFYING',
  DONE: 'DONE',
  FAILED: 'FAILED',
});

/** Tools whose running IS verification. Named by the tools that exist. */
const VERIFY_TOOLS = new Set(['run_tests', 'verify_task', 'migration_verify']);

function isRunning(app) {
  return Boolean(app && app.abort && app.abort.signal && !app.abort.signal.aborted);
}

function harnessTask(app) {
  try {
    const h = app && app._harness;
    const snap = h && h.runtime && h.runtime.snapshot ? h.runtime.snapshot() : null;
    return snap && snap.id ? { id: snap.id, state: snap.state } : null;
  } catch { return null; }
}

function clock(app, running, now) {
  const ui = app && app.ui;
  if (ui && ui.enabled && ui.clock) {
    try {
      const r = require('./ui/workclock').reading(ui.clock, now);
      if (r.shown) return { startedAt: now - r.ms, elapsed: r.ms };
    } catch { /* fall through to the stamp */ }
  }
  if (running && app._turnStartedAt) return { startedAt: app._turnStartedAt, elapsed: Math.max(0, now - app._turnStartedAt) };
  return { startedAt: null, elapsed: null };
}

function question(app) {
  if (app._harnessAsk) return String(app._harnessAsk.question || app._harnessAsk.title || 'Noema asked you something');
  if (app.pendingAsk) return 'Noema asked you something in the terminal';
  try {
    const parked = (app.jobs && app.jobs.all ? app.jobs.all() : []).find((j) => j && j.needsInput && !j.done);
    if (parked) return `background task #${parked.id} needs an answer`;
  } catch { /* no jobs */ }
  return null;
}

/**
 * THE STATUS OF ONE LIVE SESSION.
 * @returns {{state, startedAt, elapsed, activeTurnId, taskId, summary, needsUserAction, view}}
 */
function of(app, { running = null, now = Date.now() } = {}) {
  const s = app && app.session;
  const live = running == null ? isRunning(app) : Boolean(running);
  const task = harnessTask(app);
  const phase = app && app._phase ? app._phase : null;
  const t = clock(app, live, now);
  const out = (state, summary = '', needsUserAction = false) => ({
    state,
    startedAt: live ? t.startedAt : null,
    elapsed: live ? t.elapsed : null,
    activeTurnId: live ? (app._turnId || null) : null,
    taskId: task ? task.id : null,
    summary: String(summary || '').slice(0, 160),
    needsUserAction: Boolean(needsUserAction),
    view: s && s.thread ? s.thread : null,
  });
  if (!s) return out(STATE.IDLE);

  const asked = question(app);
  const life = s.lifecycle || null;

  if (live) {
    if (asked) return out(STATE.NEEDS_INPUT, asked, true);
    if ((phase && phase.phase === 'RETRYING') || (app.ui && app.ui.waitingUntil)) {
      return out(STATE.WAITING, phase && phase.rateLimited ? 'rate limited — waiting to retry' : 'waiting to retry the provider');
    }
    if ((task && task.state === 'VERIFYING') || (phase && phase.phase === 'RUNNING_TOOL' && VERIFY_TOOLS.has(String(phase.tool || '')))) {
      return out(STATE.VERIFYING, phase && phase.tool ? `running ${phase.tool}` : 'gathering evidence');
    }
    const doing = !phase ? 'working'
      : phase.phase === 'RUNNING_TOOL' ? `running ${phase.tool || 'a tool'}`
        : phase.phase === 'WAITING_MODEL' || phase.phase === 'RECEIVING' ? 'waiting for the model'
          : String(phase.detail || phase.phase || 'working').toLowerCase();
    return out(STATE.RUNNING, doing);
  }

  if (app.dispatching > 0) return out(STATE.QUEUED, 'about to start');
  if (asked) return out(STATE.NEEDS_INPUT, asked, true);
  if (life && (life.state === 'NEEDS_USER' || life.state === 'NEEDS_AUTH')) {
    return out(STATE.NEEDS_INPUT, life.reason || (life.state === 'NEEDS_AUTH' ? 'the provider needs sign-in' : 'waiting for you'), true);
  }
  try {
    const bg = (app.jobs && app.jobs.running ? app.jobs.running() : []).filter((j) => !j.primary);
    if (bg.length) return { ...out(STATE.RUNNING, `${bg.length} background task${bg.length > 1 ? 's' : ''}`), startedAt: null, elapsed: null };
  } catch { /* no jobs */ }

  const last = (s.turns || []).slice(-1)[0] || null;
  if (last && last.providerFailure) return out(STATE.FAILED, `the last turn did not finish — ${last.providerFailure.message || last.providerFailure.kind || 'provider failure'}`);
  if (life && life.state === 'FAILED') return out(STATE.FAILED, life.reason || 'failed');
  if (task && task.state === 'FAILED') return out(STATE.FAILED, 'verification failed');
  if (last) {
    if (last.stopReason === 'aborted') return out(STATE.DONE, 'stopped');
    if (task && task.state === 'VERIFYING') return out(STATE.DONE, 'finished — not verified yet');
    if (task && task.state === 'PASSED') return out(STATE.DONE, 'verified');
    return out(STATE.DONE, '');
  }
  return out(STATE.IDLE);
}

/**
 * A STATUS MAY HAVE MOVED. Record the phase, wake the window, and emit
 * `session.status` when the word or its summary changed.
 */
function touch(app, { phase, ended = false } = {}) {
  if (!app) return null;
  if (phase !== undefined) app._phase = phase && phase.phase === 'ENDED' ? null : phase;
  if (ended) { app._phase = null; }
  let ipc = null;
  try { ipc = require('./harnessapp/ipc'); } catch { return null; }
  let st = null;
  try {
    st = of(app);
    const key = `${st.state}|${st.summary}|${st.needsUserAction}`;
    if (app._statusKey !== key && app.session) {
      app._statusKey = key;
      ipc.emit({ type: 'session.status', session: app.session.id, status: st });
    }
  } catch { /* a status that cannot be computed is left to the next read */ }
  try { ipc.wake(); } catch { /* no window */ }
  return st;
}

module.exports = { STATE, VERIFY_TOOLS, of, touch, isRunning };
