'use strict';

/** AGENT WORK THAT THE PROMPT DOES NOT WAIT FOR. */

const { STATE, FINAL } = require('./jobs');

/** Finished jobs kept so a result can still be read. Never unbounded. */
const MAX_KEPT = 20;

/** Phases that mean the job is BLOCKED on something outside itself. */
const WAITING_PHASES = new Set(['WAITING', 'RATE_LIMITED', 'ASKING', 'RETRYING', 'WAITING_FOR_INPUT']);

/** THE PHASE THAT MEANS "I ASKED YOU SOMETHING AND I AM HOLDING". */
const NEEDS_INPUT = 'WAITING_FOR_INPUT';

class AgentJob {
  constructor({ id, request, primary = false, session = null, kind = 'agent' }) {
    this.id = id;
    // FIRST-CLASS FACTS (§33): what kind of work, whose session/task/step it belongs to, and which files it owns.
    this.kind = kind;           // agent | process | branch | subagent | ab
    this.parentSessionId = null;
    this.taskId = null;
    this.planStep = null;
    this.scope = [];
    this.resultSummary = null;
    this.request = String(request || '');
    /** Does this job own `app.session`? Exactly one may. See the header. */
    this.primary = Boolean(primary);
    /** The session this job's turn writes to. Never shared with another job. */
    this.session = session;
    this.state = STATE.QUEUED;
    /** What it is doing this instant — the "current activity". */
    this.phase = null;
    this.detail = '';
    this.startedAt = null;
    this.endedAt = null;
    /** The turn record when it finished, or null. */
    this.result = null;
    /** The message when it failed, or null. Never an Error object: this is
     *  rendered, persisted and read by the model. */
    this.error = null;
    /** Cooperative cancellation. The SAME AbortController the turn is given. */
    this.abort = new AbortController();
    /** THE QUESTION THIS JOB IS HOLDING FOR, and the promise waiting on it. */
    this.question = null;
    this._answer = null;
    this._waiters = [];
  }

  get done() { return FINAL.has(this.state); }

  /** Blocked on something outside itself — a tool, a limit, an answer. */
  get waiting() { return this.state === STATE.RUNNING && WAITING_PHASES.has(this.phase); }

  /** Blocked on the USER specifically, which is the one a person can clear. */
  get needsInput() { return this.state === STATE.RUNNING && this.phase === NEEDS_INPUT && Boolean(this.question); }

  /** What `/jobs` prints. RUNNING, WAITING and NEEDS INPUT are one state. */
  get label() { return this.needsInput ? 'NEEDS INPUT' : this.waiting ? 'WAITING' : this.state; }

  /** PARK UNTIL SOMEBODY ANSWERS. */
  askUser(question, options = []) {
    this.question = { question: String(question || ''), options: options.slice(0, 12), at: Date.now() };
    this.phase = NEEDS_INPUT;
    return new Promise((resolve) => { this._answer = resolve; });
  }

  /** `/answer <n> <text>` — settle the parked question and let the turn resume. */
  reply(text) {
    if (!this._answer) return false;
    const done = this._answer;
    this._answer = null;
    this.question = null;
    this.phase = 'RUNNING_TOOL';
    done(String(text == null ? '' : text));
    return true;
  }

  get elapsedMs() {
    if (!this.startedAt) return 0;
    return (this.endedAt || Date.now()) - this.startedAt;
  }

  /** One line: what it is doing, or how it ended. */
  get activity() {
    if (this.needsInput) return this.question.question;
    if (this.state === STATE.QUEUED) return 'queued';
    if (this.done) return this.error || (this.result ? 'finished' : String(this.state).toLowerCase());
    return this.detail || String(this.phase || 'working').toLowerCase();
  }

  /** Settle once, and wake everything waiting. Never throws. */
  _finish(state, { result = null, error = null } = {}) {
    if (this.done) return this;
    this.state = state;
    this.result = result;
    this.error = error;
    this.endedAt = Date.now();
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) { try { w(this); } catch { /* a waiter must not unsettle the job */ } }
    return this;
  }

  /** COOPERATIVE, AND IT IS THE SAME MECHANISM Ctrl+C ALREADY USES. */
  cancel(why = 'cancelled') {
    if (this.done) return false;
    try { this.abort.abort(); } catch { /* already aborted */ }
    // A PARKED QUESTION IS RELEASED, or the turn awaiting it never unwinds and
    // the "cancelled" job goes on holding a promise for the life of the process.
    if (this._answer) { const done = this._answer; this._answer = null; this.question = null; done(null); }
    this._finish(STATE.CANCELLED, { error: String(why) });
    return true;
  }

  /** Resolves when the job settles. No interval, no poll — see the header. */
  wait() {
    if (this.done) return Promise.resolve(this);
    return new Promise((resolve) => { this._waiters.push(resolve); });
  }

  /** What the UI and `/jobs` read. A plain object; never the live job. */
  summary() {
    return {
      id: this.id,
      state: this.state,
      label: this.label,
      waiting: this.waiting,
      needsInput: this.needsInput,
      question: this.question ? this.question.question : null,
      primary: this.primary,
      request: this.request,
      activity: this.activity,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      elapsedMs: this.elapsedMs,
      error: this.error,
      kind: this.kind,
      sessionId: this.parentSessionId || (this.session && this.session.id) || null,
      taskId: this.taskId || null,
      planStep: this.planStep,
      scope: this.scope.slice(),
      result: this.resultSummary,
      word: this.state === 'SUCCEEDED' ? 'DONE' : this.waiting || this.needsInput ? 'WAITING' : this.state,
      agentType: this.agentType || null, agentLabel: this.agentLabel || null, chars: this.chars || 0, childSession: this.sessionId || null,
    };
  }
}

/** THE JOBS THIS SESSION HAS STARTED. */
class AgentJobs {
  constructor({ onChange = null } = {}) {
    this.list = [];
    /** Called whenever anything about any job changes, so the screen can
     *  redraw without anybody polling. */
    this.onChange = onChange;
    this._seq = 0;
  }

  changed() { if (this.onChange) { try { this.onChange(); } catch { /* drawing must not break the job */ } } }

  /** The job that owns `app.session`, or null. At most one, ever. */
  primary() { return this.list.find((j) => j.primary && !j.done) || null; }

  create({ request, primary = false, session = null, kind = 'agent' }) {
    this._seq += 1;
    const job = new AgentJob({ id: String(this._seq), request, primary, session, kind });
    this.list.push(job);
    // Finished jobs are kept so a result can still be read, but not forever.
    while (this.list.length > MAX_KEPT) {
      const oldest = this.list.findIndex((j) => j.done);
      if (oldest < 0) break;
      this.list.splice(oldest, 1);
    }
    this.changed();
    return job;
  }

  get(id) { return this.list.find((j) => j.id === String(id)) || null; }
  running() { return this.list.filter((j) => !j.done); }
  all() { return this.list.slice(); }

  /** Everything still going, stopped. Called when the session ends. */
  cancelAll(why = 'the session ended') {
    let n = 0;
    for (const j of this.running()) if (j.cancel(why)) n += 1;
    if (n) this.changed();
    return n;
  }
}

module.exports = { AgentJob, AgentJobs, STATE, FINAL, MAX_KEPT, WAITING_PHASES, NEEDS_INPUT };
