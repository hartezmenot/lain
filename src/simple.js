'use strict';

/**
 * THE SIMPLE EXECUTION PATH (Simplify pass S1). `execution: 'simple'` (the default) lets the model run the loop: the
 * turn ends when it stops calling tools, nothing judges its prose, and the lifecycle is descriptive (ACTIVE while a
 * turn runs, IDLE after). `execution: 'legacy'` keeps the old path for comparison until S10.
 */

/** Simple unless the config (or LAIN_EXECUTION, for a bench) says legacy. */
function on(appOrCfg) {
  const cfg = appOrCfg && appOrCfg.cfg ? appOrCfg.cfg : appOrCfg;
  const v = (cfg && cfg.execution) || process.env.LAIN_EXECUTION || 'simple';
  return String(v).toLowerCase() !== 'legacy';
}

/** The input is the person's message: no classification. One task record per session, for the surfaces that show it. */
function identify(app, text) {
  const s = app.session;
  const first = !s.task;
  if (first) {
    const { Task } = require('./task');
    s.task = new Task(text);
  }
  if (!s.lifecycle) {
    const { Lifecycle } = require('./lifecycle');
    s.lifecycle = new Lifecycle(s.task.objective);
  }
  s.lifecycle.state = 'ACTIVE';
  s.lifecycle.reason = '';
  return { kind: first ? 'new' : 'continue', sameTask: !first, mode: null, modeReason: '', reason: 'simple', taskClass: null, aside: false };
}

/** The turn is over: the lifecycle only describes it, and the fact footer goes on the turn. */
function settle(app, record = null) {
  const life = app.session && app.session.lifecycle;
  if (life) { life.state = 'IDLE'; life.reason = ''; }
  if (record) { try { require('./factfooter').attach(app, record); } catch { /* the footer is only shown */ } }
}

/**
 * THE TOOL SET IS FIXED FOR A SESSION; enabling Computer Control or the Preview mid-session grows it once, at a turn
 * boundary. Returns the log line for that (the cached prefix restarts once), or null when nothing changed.
 */
function toolSetNote(session, schemas) {
  if (!session) return null;
  const names = schemas.map((s) => s.name);
  const prev = session._toolNames;
  session._toolNames = names;
  if (!prev) return null;
  const added = names.filter((n) => !prev.includes(n));
  const gone = prev.filter((n) => !names.includes(n));
  if (!added.length && !gone.length) return null;
  const line = `tools changed for this session: ${[...added.map((n) => `+${n}`), ...gone.map((n) => `-${n}`)].slice(0, 8).join(' ')} — the cached prefix restarts once`;
  (session.toolSetLog = session.toolSetLog || []).push({ at: Date.now(), added, gone });
  return line;
}

module.exports = { on, identify, settle, toolSetNote };
