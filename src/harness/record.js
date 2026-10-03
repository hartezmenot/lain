'use strict';

/** THE TASK RECORD — what a task IS, once a task is more than a sentence. */

const state = require('./state');

/** A title is a label for a list, not a description. */
const MAX_TITLE = 120;

/** Bounded, like everything: a record is read on every surface. */
const MAX_PROCESSES = 32;
const MAX_VERIFICATIONS = 32;
const MAX_OBSERVATIONS = 200;

let seq = 0;

/** Task ids are `t<n>-<timestamp36>`. */
function newId(now = Date.now()) {
  seq += 1;
  return `t${seq}-${now.toString(36)}`;
}

class TaskRecord {
  #state = state.STATE.PLANNED;
  constructor({ id = null, title = '', objective = '', workspace = process.cwd(), sessionId = null, environment = 'host' } = {}) {
    this.id = id || newId();
    this.title = String(title || objective || 'untitled').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || 'untitled';
    this.objective = String(objective || '');
    this.workspace = String(workspace);
    this.sessionId = sessionId ? String(sessionId) : null;
    /** WHERE THIS TASK RUNS — `host` or `vm:<id>`. */
    // AN UNREADABLE VALUE BECOMES `host`, NEVER `undefined` AND NEVER A VM.
    this.environment = (require('../env/environments').parse(environment).spec) || 'host';
    /** Why the task is in the state it is in. Always a sentence a person reads. */
    this.reason = 'created';
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    /** Every state it has been in, in order: [{from, to, why, at}]. */
    this.history = [];
    /** Managed processes owned by this task: [{processId, name, port, status}]. */
    this.processes = [];
    /** Verification attempts, appended, never removed. */
    this.verifications = [];
    /** Observation summaries — the goal asked and the source that answered. */
    this.observations = [];
    /** Artifact ids kept for this task. The bodies live in the artifact store. */
    this.artifacts = [];
    /** How many events the durable log has taken. A count, not a copy. */
    this.eventCount = 0;
    /** A repair task names the task whose failure caused it. */
    this.causedBy = null;
    /** Agents that worked on this task: [{name, scope, at, outcome}]. */
    this.agents = [];
  }

  /** MOVE. Refuses illegal transitions rather than performing them quietly. */
  get state() { return this.#state; }

  moveTo(next, why = '', verification = null) {
    if (next === state.STATE.PASSED && (!require('./verify').isResult(verification, this.id) || verification.verdict !== next)) {
      return { ok: false, why: 'PASSED requires a verification result for this task' };
    }
    const verdict = state.transition(this.state, next);
    if (!verdict.ok) return verdict;
    if (this.state !== next) {
      this.history.push({ from: this.state, to: next, why: String(why || ''), at: Date.now() });
      this.#state = next;
    }
    this.reason = String(why || this.reason);
    this.updatedAt = Date.now();
    return { ok: true, why: '' };
  }

  get terminal() { return state.TERMINAL.has(this.state); }
  get tone() { return state.TONE[this.state] || 'idle'; }

  noteProcess(p) {
    const at = this.processes.findIndex((x) => x.processId === p.processId);
    const row = {
      processId: p.processId, name: p.name, port: p.port == null ? null : p.port,
      status: p.status, health: p.health || null, pid: p.pid == null ? null : p.pid,
    };
    if (at >= 0) this.processes[at] = row;
    else this.processes.push(row);
    if (this.processes.length > MAX_PROCESSES) this.processes.splice(0, this.processes.length - MAX_PROCESSES);
    this.updatedAt = Date.now();
    return row;
  }

  noteVerification(result) {
    this.verifications.push({
      at: Date.now(),
      verdict: result.verdict,
      contract: result.contract || null,
      passed: result.passed || 0,
      failed: result.failed || 0,
      inconclusive: result.inconclusive || 0,
      why: String(result.why || '').slice(0, 400),
    });
    if (this.verifications.length > MAX_VERIFICATIONS) this.verifications.shift();
    this.updatedAt = Date.now();
  }

  noteObservation(o) {
    this.observations.push({
      at: Date.now(),
      goal: String(o.goal || '').slice(0, 120),
      source: String(o.source || '').slice(0, 40),
      ok: Boolean(o.ok),
      summary: String(o.summary || '').slice(0, 300),
    });
    if (this.observations.length > MAX_OBSERVATIONS) this.observations.shift();
    this.updatedAt = Date.now();
  }

  noteArtifact(rec) {
    this.artifacts.push({ id: rec.id, kind: rec.kind, name: rec.name, bytes: rec.bytes, at: rec.at });
    this.updatedAt = Date.now();
  }

  noteAgent(a) {
    this.agents.push({
      name: String(a.name || 'agent').slice(0, 60),
      scope: String(a.scope || '').slice(0, 200),
      at: Date.now(),
      outcome: a.outcome ? String(a.outcome).slice(0, 80) : null,
    });
    this.updatedAt = Date.now();
  }

  /** The last verification, or null. What "is it proved?" actually reads. */
  get lastVerification() {
    return this.verifications.length ? this.verifications[this.verifications.length - 1] : null;
  }

  toJSON() {
    return {
      id: this.id, title: this.title, objective: this.objective, workspace: this.workspace,
      sessionId: this.sessionId, environment: this.environment, state: this.state, reason: this.reason,
      createdAt: this.createdAt, updatedAt: this.updatedAt,
      history: this.history, processes: this.processes, verifications: this.verifications,
      observations: this.observations, artifacts: this.artifacts, agents: this.agents,
      eventCount: this.eventCount, causedBy: this.causedBy,
    };
  }

  static from(data) {
    if (!data || typeof data !== 'object') return null;
    const t = new TaskRecord({
      id: data.id, title: data.title, objective: data.objective,
      workspace: data.workspace, sessionId: data.sessionId,
      // A RECORD WRITTEN BEFORE THIS FIELD EXISTED RAN ON THE HOST. Defaulting
      // is the truthful reading of its absence, not a guess.
      environment: data.environment || 'host',
    });
    t.#state = state.isState(data.state) ? data.state : state.STATE.PLANNED;
    t.reason = String(data.reason || '');
    t.createdAt = Number(data.createdAt) || t.createdAt;
    t.updatedAt = Number(data.updatedAt) || t.updatedAt;
    for (const k of ['history', 'processes', 'verifications', 'observations', 'artifacts', 'agents']) {
      t[k] = Array.isArray(data[k]) ? data[k] : [];
    }
    t.eventCount = Number(data.eventCount) || 0;
    t.causedBy = data.causedBy || null;
    return t;
  }
}

module.exports = { TaskRecord, newId, MAX_TITLE, MAX_PROCESSES, MAX_VERIFICATIONS, MAX_OBSERVATIONS };
