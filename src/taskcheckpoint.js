'use strict';

/**
 * THE COMMITTED TASK CHECKPOINT — Core's one answer to "where does this task stand?" (Gate 3 §81–84, 2026-09-30).
 * (Not checkpoint.js: that module is REVERSIBILITY — the prior bytes of files a tool changes.)
 *
 *     task → phase → model turn → tools → landed changes → evidence → CHECKPOINT COMMIT → advance
 *
 * A step's progress becomes current only when it is COMMITTED: the plan's new position (a step finished, a
 * revision, a phase checkpoint, a person's steer) is written into `session.checkpoint` and the session is saved
 * — atomically, before the call that moved it returns. A process that dies a moment later comes back to the
 * committed position, never to an older one and never to the model's prose about it.
 *
 * ONE AUTHORITY, EVERY SURFACE READS IT:
 *
 *   taskId              the task the work belongs to (task.js)
 *   phaseId             the Workbench phase record last closed (supervision.checkpoint), if any
 *   stepId              the plan step in hand — its stable id (plan.js), not its number
 *   step {index,total}  its place among the live steps: "step 3 of 5" everywhere
 *   checkpointId        this commit
 *   generation          increases with every commit; a surface holding a lower one is stale
 *
 * The Harness task strip, the handover packet and the continuation instruction read `view(session)`; none of
 * them counts steps of its own.
 */

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

/**
 * COMMIT: record where the work stands and write the session before returning. `phaseId` names the Workbench
 * phase record this commit closes. A save that fails is reported (`saved: false`), not hidden.
 */
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

/**
 * ON COMMIT: `fn(session, checkpoint)` after every committed checkpoint — how "restart after the current checkpoint"
 * (update/lifecycle.js) waits for a safe point without polling. Returns the function that removes it.
 */
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
