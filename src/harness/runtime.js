'use strict';

/** THE TASK RUNTIME — the one thing that knows what a task is doing and why. */

const { EVENT } = require('../events');
const state = require('./state');
const { TaskRecord } = require('./record');
const { ArtifactStore, KIND } = require('./artifacts');
const { Hooks, POINT } = require('./hooks');

/** How many finished task records stay in memory. Disk keeps the rest. */
const MAX_KEPT = 50;

/** Events that are NOT worth a line in a task's durable log. */
const NOT_LOGGED = new Set([EVENT.MODEL_THINKING]);

/** A TASK THAT NEVER DID ANYTHING LEAVES NO TRACE. */
const MATERIAL = new Set([
  EVENT.TOOL_STARTED, EVENT.TOOL_COMPLETED, EVENT.TOOL_FAILED,
  EVENT.JOB_STARTED, EVENT.JOB_COMPLETED,
  EVENT.PROCESS_STARTED, EVENT.PROCESS_STOPPED, EVENT.PROCESS_FAILED, EVENT.PROCESS_HEALTH,
  EVENT.BROWSER_STARTED, EVENT.BROWSER_OBSERVED, EVENT.BROWSER_ERROR,
  EVENT.VERIFICATION_STARTED, EVENT.VERIFICATION_PASSED, EVENT.VERIFICATION_FAILED,
  EVENT.VERIFICATION_INCONCLUSIVE,
  EVENT.OBSERVATION_MADE, EVENT.ARTIFACT_CREATED,
  EVENT.AGENT_STARTED, EVENT.AGENT_COMPLETED, EVENT.AGENT_FAILED,
  EVENT.APPROVAL_REQUIRED, EVENT.APPROVAL_RESOLVED,
  EVENT.QUESTION_PRESENTED,
]);

class TaskRuntime {
  /** bus — the shared EventBus (src/events.js). */
  constructor({ bus = null, workspace = process.cwd(), store = null, persist = true } = {}) {
    this.bus = bus;
    this.workspace = String(workspace);
    this.store = store || new ArtifactStore(this.workspace);
    this.persist = persist !== false;
    this.hooks = new Hooks();
    /** id -> TaskRecord, live and recent. */
    this._tasks = new Map();
    /** The task events are attributed to. Null between tasks. */
    this.activeId = null;
    this._unsubscribe = null;
    /** Has anything material happened yet? See MATERIAL above. */
    this._armed = new Set();
    /** Events seen before arming, flushed in order the moment it happens. */
    this._pending = new Map();
    if (bus) this.attach(bus);
  }

  // ------------------------------------------------------------------ wiring --

  /** Follow a bus. Idempotent: attaching twice does not double-log, because the previous subscription is dropped first. */
  attach(bus) {
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
    this.bus = bus;
    if (!bus || typeof bus.on !== 'function') return;
    this._unsubscribe = bus.on((ev) => {
      const id = ev.taskId || this.activeId;
      if (!id) return;
      if (NOT_LOGGED.has(ev.type)) return;
      const task = this._tasks.get(id);
      if (task) task.eventCount += 1;
      // ARMING IS THE FIRST MATERIAL FACT.
      if (!task) return;
      if (this.persist && !this._armed.has(id) && MATERIAL.has(ev.type)) this._arm(id);
      if (this.persist && this._armed.has(id)) this.store.appendEvent(id, ev);
      else {
        const pending = this._pending.get(id) || [];
        pending.push(ev);
        this._pending.set(id, pending.slice(-200));
      }
    });
  }

  detach() {
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
  }

  /** Emit onto the shared bus. The subscriber above does the logging. */
  _emit(name, payload) {
    if (!this.bus || typeof this.bus.emit !== 'function') return null;
    return this.bus.emit(name, payload);
  }

  _save(task) {
    if (!this.persist || !this._armed.has(task.id)) return;
    this.store.saveTask(task);
  }

  /** SOMETHING REAL HAPPENED — start writing. */
  _arm(id = this.activeId) {
    if (!this.persist || this._armed.has(id) || !this.get(id)) return;
    this._armed.add(id);
    const queued = this._pending.get(id) || [];
    this._pending.delete(id);
    // AND THE DRAWER IS BOUNDED — here, at the one moment this task is about to take a directory of its own.
    try { this.store.prune(); } catch { /* a full drawer is not a failure */ }
    for (const ev of queued) this.store.appendEvent(id, ev);
    const task = this.get(id);
    if (task) this.store.saveTask(task);
  }

  _hook(point, task) {
    this.hooks.fire(point, Object.freeze(this.snapshot(task.id)), (r) => {
      this._emit(EVENT.HOOK_RAN, {
        taskId: task.id, hook: r.name, point: r.point, ms: r.ms, ok: r.ok, error: r.error,
      });
    });
  }

  // ------------------------------------------------------------------ tasks --

  /** Create a task. It is PLANNED — created is not started, and the difference is real: a task can exist, be scoped and be shown on a dashboard before… */
  create({ title = '', objective = '', sessionId = null, causedBy = null } = {}) {
    const task = new TaskRecord({ title, objective, workspace: this.workspace, sessionId });
    task.causedBy = causedBy || null;
    this._tasks.set(task.id, task);
    this._trim();
    // EACH TASK EARNS ITS OWN DIRECTORY.
    this.activeId = task.id;
    this._save(task);
    this._emit(EVENT.TASK_CREATED, { taskId: task.id, title: task.title, state: task.state, causedBy: task.causedBy });
    this._hook(POINT.TASK_CREATED, task);
    return task;
  }

  get(id) { return this._tasks.get(String(id)) || null; }

  /** The active task record, or null. Strictly the one events are attributed to. */
  active() { return this.activeId ? this.get(this.activeId) : null; }

  /** THE ONE A SURFACE SHOULD DRAW — the active task, or the most recent one. */
  latest() {
    if (this.activeId && this.get(this.activeId)) return this.get(this.activeId);
    const all = this.list();
    return all.length ? all[0] : null;
  }

  /** Live tasks, newest first. Finished ones on disk are `store.listTasks()`. */
  list() {
    return [...this._tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  _trim() {
    if (this._tasks.size <= MAX_KEPT) return;
    const done = [...this._tasks.values()].filter((t) => t.terminal).sort((a, b) => a.updatedAt - b.updatedAt);
    while (this._tasks.size > MAX_KEPT && done.length) {
      const id = done.shift().id;
      this._tasks.delete(id);
      this._armed.delete(id);
      this._pending.delete(id);
    }
  }

  // ------------------------------------------------------------ transitions --

  /** The one place a state is written. */
  _move(id, next, why, eventName = null, extra = {}, verification = null) {
    const task = this.get(id);
    if (!task) return { ok: false, why: `no such task ${id}` };
    const before = task.state;
    const verdict = task.moveTo(next, why, verification);
    if (!verdict.ok) return verdict;
    this._save(task);
    if (before !== task.state) {
      this._emit(EVENT.TASK_STATE, {
        taskId: task.id, from: before, to: task.state, why: String(why || ''), title: task.title,
      });
      if (eventName) this._emit(eventName, { taskId: task.id, title: task.title, why: String(why || ''), ...extra });
    }
    if (task.terminal && this.activeId === task.id) this.activeId = null;
    return { ok: true, why: '', task };
  }

  start(id, why = 'execution started') {
    const r = this._move(id, state.STATE.RUNNING, why, EVENT.TASK_STARTED);
    if (r.ok) {
      this.activeId = id;
      this._hook(POINT.TASK_STARTED, r.task);
      this._hook(POINT.BEFORE_EXECUTION, r.task);
    }
    return r;
  }

  /** BLOCKED — it cannot proceed without something outside itself. */
  block(id, why = 'blocked') {
    return this._move(id, state.STATE.BLOCKED, why, EVENT.TASK_PAUSED, { kind: 'blocked' });
  }

  pause(id, why = 'paused') {
    return this._move(id, state.STATE.BLOCKED, why, EVENT.TASK_PAUSED, { kind: 'paused' });
  }

  resume(id, why = 'resumed') {
    const r = this._move(id, state.STATE.RUNNING, why, EVENT.TASK_RESUMED);
    if (r.ok) this.activeId = id;
    return r;
  }

  /** STOP EXECUTING AND GO AND PROVE IT. */
  verifying(id, why = 'execution finished — gathering evidence') {
    const r = this._move(id, state.STATE.VERIFYING, why, EVENT.VERIFICATION_STARTED);
    if (r.ok) {
      this._hook(POINT.AFTER_EXECUTION, r.task);
      this._hook(POINT.BEFORE_VERIFICATION, r.task);
    }
    return r;
  }

  /** SETTLE THE TASK FROM A VERIFICATION RESULT. */
  settle(id, result) {
    const task = this.get(id);
    if (!task) return { ok: false, why: `no such task ${id}` };
    const next = state.fromVerdict(result && result.verdict);
    if (!next) return { ok: false, why: `"${result && result.verdict}" is not a verification verdict` };
    if (task.state !== state.STATE.VERIFYING) return { ok: false, why: 'settlement requires a VERIFYING task' };
    if (!require('./verify').isResult(result, id)) return { ok: false, why: 'settlement requires a verification result for this task' };
    task.noteVerification(result);
    const eventName = next === state.STATE.PASSED
      ? EVENT.VERIFICATION_PASSED
      : next === state.STATE.FAILED ? EVENT.VERIFICATION_FAILED : EVENT.VERIFICATION_INCONCLUSIVE;
    this._emit(eventName, {
      taskId: task.id, verdict: result.verdict, passed: result.passed || 0,
      failed: result.failed || 0, inconclusive: result.inconclusive || 0, why: result.why || '',
    });
    const r = this._move(id, next, result.why || `verification ${result.verdict}`,
      next === state.STATE.PASSED ? EVENT.TASK_COMPLETED : EVENT.TASK_FAILED, {}, result);
    if (!r.ok) return r;
    this._hook(POINT.AFTER_VERIFICATION, task);
    this._hook(next === state.STATE.PASSED ? POINT.TASK_COMPLETED : POINT.TASK_FAILED, task);
    return r;
  }

  /** A failure that is not a verification verdict: the work could not proceed. */
  fail(id, why = 'failed') {
    const r = this._move(id, state.STATE.FAILED, why, EVENT.TASK_FAILED);
    if (r.ok) this._hook(POINT.TASK_FAILED, r.task);
    return r;
  }

  cancel(id, why = 'cancelled by the user') {
    return this._move(id, state.STATE.CANCELLED, why, EVENT.TASK_CANCELLED);
  }

  /** RE-EXECUTE AFTER A RED CONTRACT. */
  reopen(id, why = 'recovering from a failed check') {
    const r = this._move(id, state.STATE.RUNNING, why, EVENT.RECOVERY_STARTED);
    if (r.ok) { this.activeId = id; this._hook(POINT.BEFORE_EXECUTION, r.task); }
    return r;
  }

  /** A REPAIR TASK for one that ended FAILED. */
  repairFor(id, { title = '' } = {}) {
    const failed = this.get(id);
    if (!failed) return null;
    return this.create({
      title: title || `repair: ${failed.title}`,
      objective: failed.objective,
      sessionId: failed.sessionId,
      causedBy: failed.id,
    });
  }

  // ----------------------------------------------------------- consumption --

  /** CONSUME lifecycle.js's verdict. */
  syncLifecycle(id, lifecycleState, why = '') {
    const next = state.fromLifecycle(lifecycleState);
    if (!next) return { ok: true, why: 'the lifecycle says nothing about the task state' };
    const task = this.get(id);
    if (!task) return { ok: false, why: `no such task ${id}` };
    if (next === state.STATE.VERIFYING) return this.verifying(id, why || 'the model stopped — the evidence decides');
    if (next === state.STATE.BLOCKED) return this.block(id, why || `the turn is ${lifecycleState}`);
    if (next === state.STATE.FAILED) return this.fail(id, why || 'the turn failed');
    return { ok: true, why: '' };
  }

  // -------------------------------------------------------------- evidence --

  /** Keep something, attribute it to the task, and say so on the bus. */
  keep(id, { kind = KIND.LOG, name = 'artifact', body = '', note = '' } = {}) {
    const task = this.get(id);
    if (!this.persist || !task) return null;
    // KEEPING AN ARTIFACT IS MATERIAL BY DEFINITION — it is bytes going to
    // disk. Arm before writing, or the record they belong to is never saved.
    this._arm(id);
    const rec = this.store.put(id, { kind, name, body, note });
    if (!rec) return null;
    if (task) { task.noteArtifact(rec); this._save(task); }
    this._emit(EVENT.ARTIFACT_CREATED, {
      taskId: String(id), artifactId: rec.id, kind: rec.kind, name: rec.name, bytes: rec.bytes,
    });
    return rec;
  }

  noteProcess(id, p) {
    const task = this.get(id);
    if (!task) return null;
    const row = task.noteProcess(p);
    this._save(task);
    return row;
  }

  noteObservation(id, o) {
    const task = this.get(id);
    if (!task) return null;
    task.noteObservation(o);
    this._save(task);
    this._emit(EVENT.OBSERVATION_MADE, {
      taskId: task.id, goal: o.goal, source: o.source, ok: Boolean(o.ok), summary: o.summary,
    });
    return task.observations[task.observations.length - 1];
  }

  noteAgent(id, a) {
    const task = this.get(id);
    if (!task) return null;
    task.noteAgent(a);
    this._save(task);
    // THREE NAMES BECAUSE THERE ARE THREE FACTS.
    const failed = /FAIL|ERROR|CANCEL/i.test(String(a.outcome || ''));
    const name = !a.outcome ? EVENT.AGENT_STARTED : (failed ? EVENT.AGENT_FAILED : EVENT.AGENT_COMPLETED);
    this._emit(name, {
      taskId: task.id, agent: a.name, scope: a.scope, outcome: a.outcome || '',
      why: failed ? String(a.outcome) : '',
    });
    return task.agents[task.agents.length - 1];
  }

  // -------------------------------------------------------------- snapshot --

  /** WHAT EVERY SURFACE READS. */
  snapshot(id = null) {
    const task = id ? this.get(id) : this.latest();
    if (!task) return null;
    const v = task.lastVerification;
    return {
      id: task.id,
      title: task.title,
      state: task.state,
      tone: task.tone,
      reason: task.reason,
      terminal: task.terminal,
      workspace: task.workspace,
      sessionId: task.sessionId,
      causedBy: task.causedBy,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      processes: task.processes.slice(),
      agents: task.agents.slice(-5),
      artifacts: task.artifacts.length,
      events: task.eventCount,
      observations: task.observations.length,
      verification: v ? { ...v } : null,
      attempts: task.verifications.length,
      persisted: this.persist,
    };
  }
}

module.exports = { TaskRuntime, MAX_KEPT, NOT_LOGGED };
