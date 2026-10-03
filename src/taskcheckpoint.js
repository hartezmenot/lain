'use strict';

/** THE COMMITTED TASK CHECKPOINT — Core's one answer to "where does this task stand?" (Gate 3 §81–84, 2026-09-30). */

const crypto = require('crypto');

function stepOf(session) {
  const plan = session && session.plan;
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length || plan.retiredAt) return null;
  return typeof plan.current === 'function' ? plan.current() : null;
}
function positionOf(plan, cur) {
  if (plan && typeof plan.position === 'function' && cur) return plan.position(cur);
  return { index: null, total: plan && Array.isArray(plan.steps) ? plan.steps.length : 0 };
}

/** The committed checkpoint, as every surface shows it. `committed` says whether the plan has moved since. */
function view(session) {
  const c = (session && session.checkpoint) || null;
  const plan = session && session.plan;
  const cur = stepOf(session);
  const pos = positionOf(plan, cur);
  return {
    taskId: (session && session.task && session.task.id) || null,
    phaseId: c ? c.phaseId : null,
    stepId: cur ? cur.id || null : null,
    step: cur ? { index: pos.index, total: pos.total, text: String(cur.text || ''), status: cur.status } : null,
    done: plan && plan.completed ? plan.completed.length : 0,
    checkpointId: c ? c.checkpointId : null,
    generation: c ? c.generation : 0,
    at: c ? c.at : null,
    reason: c ? c.reason : null,
    committed: Boolean(c && cur && c.stepId === cur.id && c.stepIndex === pos.index),
  };
}

/** COMMIT: record where the work stands and write the session before returning. */
function commit(session, reason, { phaseId = null, save = true } = {}) {
  if (!session) return null;
  const prev = session.checkpoint || { generation: 0, phaseId: null };
  const plan = session.plan;
  const cur = stepOf(session);
  const pos = positionOf(plan, cur);
  const generation = (Number(prev.generation) || 0) + 1;
  session.checkpoint = {
    taskId: (session.task && session.task.id) || null,
    phaseId: phaseId || prev.phaseId || null,
    stepId: cur ? cur.id || null : null,
    stepIndex: pos.index,
    stepTotal: pos.total,
    stepText: cur ? String(cur.text || '').slice(0, 200) : '',
    done: plan && plan.completed ? plan.completed.length : 0,
    checkpointId: `cp-${generation}-${crypto.randomBytes(3).toString('hex')}`,
    generation,
    at: Date.now(),
    reason: String(reason || 'checkpoint').slice(0, 80),
  };
  let saved = false;
  if (save && typeof session.save === 'function') {
    try { session.save(); saved = true; } catch { saved = false; }
  }
  const out = { ...session.checkpoint, saved };
  for (const fn of [...LISTENERS]) { try { fn(session, out); } catch { /* a listener never breaks a commit */ } }
  return out;
}

/** ON COMMIT: `fn(session, checkpoint)` after every committed checkpoint — how "restart after the current checkpoint" (update/lifecycle.js) waits for a… */
const LISTENERS = new Set();
function onCommit(fn) { LISTENERS.add(fn); return () => LISTENERS.delete(fn); }

/** Restore with the session (session.js). */
function restore(session, data) {
  const c = data && data.checkpoint;
  session.checkpoint = c && typeof c === 'object' && Number.isFinite(Number(c.generation)) ? { ...c, generation: Number(c.generation) } : null;
}

/** One line for a person or a model: "Step 3 of 5 — Wire the API (checkpoint 12)". */
function line(session) {
  const v = view(session);
  if (!v.step) return '';
  return `Step ${v.step.index} of ${v.step.total} — ${v.step.text}${v.generation ? ` (checkpoint ${v.generation})` : ''}`;
}

module.exports = { view, commit, restore, line, onCommit };
