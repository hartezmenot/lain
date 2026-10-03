'use strict';

/** THE AUTHORITY CHAIN, PROJECTED ONCE — goal → task → plan → work order. */

const goalMod = require('./goal');
const taskMod = require('./task');

/** Bounds on projected text. A projection is a briefing, not a transcript. */
const MAX_OBJECTIVE = 300;
const MAX_GOAL_TEXT = 400;
const MAX_STEERS = 4;
const MAX_STEPS = 6;

function oneLine(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** WHICH REVISION OF THE SCOPE THIS IS. */
function scopeRevision(session) {
  const task = session && session.task;
  const steers = task && Array.isArray(task.steers) ? task.steers.length : 0;
  return steers;
}

/** The goal rung, or null when the user has set no direction. */
function goalOf(session) {
  const g = goalMod.get(session);
  if (!g) return null;
  return {
    id: goalMod.id(session),
    text: oneLine(g.text, MAX_GOAL_TEXT),
    setAt: g.setAt || null,
  };
}

/** The task rung, or null. Includes the executor, which belongs to the task. */
function taskOf(session) {
  const t = session && session.task;
  if (!t) return null;
  return {
    id: t.id || '',
    objective: oneLine(t.objective, MAX_OBJECTIVE),
    // THE USER'S LATER WORDS, which outrank the objective they replaced.
    steers: (Array.isArray(t.steers) ? t.steers : []).slice(-MAX_STEERS)
      .map((s) => oneLine(s && s.text, 160)).filter(Boolean),
    state: t.state || taskMod.STATE.ACTIVE,
    startedAt: t.startedAt || null,
  };
}

/** WHO IS CARRYING IT, AND WHETHER THEY CAN WORK. */
function executorOf(session) {
  const t = session && session.task;
  const e = t && t.executor;
  if (!e) return null;
  return {
    provider: e.provider || '',
    model: e.model || '',
    state: e.state || taskMod.EXECUTOR.ACTIVE,
    since: e.since || null,
    why: e.why || '',
    /** HOW MANY EXECUTORS THIS TASK HAS HAD. */
    epoch: (Array.isArray(t.handovers) ? t.handovers.length : 0) + 1,
    /** Nobody can work this right now, and it is not finished. See task.stranded. */
    stranded: typeof t.stranded === 'boolean' ? t.stranded
      : Boolean(e.state && e.state !== taskMod.EXECUTOR.ACTIVE),
  };
}

/** The plan rung — STRATEGY, never authority. */
function planOf(session) {
  const p = session && session.plan;
  if (!p || !Array.isArray(p.steps) || !p.steps.length) return null;
  const steps = p.steps;
  const isDone = require('./plan').stepDone;
  const done = steps.filter((s) => s && isDone(s)).length;
  const current = steps.find((s) => s && !isDone(s)) || null;
  return {
    total: steps.length,
    done,
    live: typeof p.isLive === 'boolean' ? p.isLive : true,
    // THE OPEN STEPS ONLY, and bounded. A completed step is evidence and is
    // still on the plan; it is not what a worker needs to be told to do.
    open: steps.filter((s) => s && !isDone(s)).slice(0, MAX_STEPS)
      .map((s) => oneLine(s.text, 160)).filter(Boolean),
    current: current ? oneLine(current.text, 160) : '',
  };
}

/** WHERE THE PROJECTION'S FACTS CAME FROM, and whether they are current. */
function freshnessOf(session) {
  return {
    goal: goalMod.get(session) ? 'SET' : 'UNSET',
    task: session && session.task ? 'SET' : 'UNSET',
    plan: session && session.plan && Array.isArray(session.plan.steps) && session.plan.steps.length
      ? 'SET' : 'UNSET',
    executor: session && session.task && session.task.executor ? 'SET' : 'UNASSIGNED',
    at: new Date().toISOString(),
  };
}

/** THE RUNGS THAT ARGUE WITH EACH OTHER. */
function contradictions(session, { planObjective = null } = {}) {
  const out = [];
  const task = session && session.task;
  const stated = planObjective == null
    ? (session && session.plan && session.plan.objective) || ''
    : planObjective;
  const statedText = oneLine(stated, MAX_OBJECTIVE);
  if (!statedText) return out;

  // AGAINST THE TASK FIRST, because the task is the rung directly above a plan.
  const taskObjective = oneLine(task && task.objective, MAX_OBJECTIVE);
  if (taskObjective && taskMod.objectiveOverlap(taskObjective, statedText) === 0) {
    // AND AGAINST THE GOAL, because a plan may legitimately restate the DIRECTION rather than this task — "stabilise handover" over a task of "fix…
    const goalText = oneLine(goalMod.text(session), MAX_GOAL_TEXT);
    if (!goalText || taskMod.objectiveOverlap(goalText, statedText) === 0) {
      out.push({
        rung: 'plan',
        stated: statedText,
        contradicts: taskObjective ? 'task' : 'goal',
        authority: taskObjective || goalText,
        why: 'the stated plan objective shares no content with the task or the goal it should serve',
      });
    }
  }
  return out;
}

/** THE CANONICAL PROJECTION. */
function project(session, options = {}) {
  const { request = '', workOrder = null } = options;
  return {
    version: 1,
    goal: goalOf(session),
    task: taskOf(session),
    plan: planOf(session),
    workOrder: workOrder ? workOrder.toJSON() : null,
    executor: executorOf(session),
    scopeRevision: scopeRevision(session),
    /** HOW THE REQUEST IN HAND STANDS TO THE STANDING GOAL, when there is one. */
    relation: request ? goalMod.relate(session, request) : null,
    /** WHAT WOULD PROVE THIS DONE: the level selected from the change, and the separate claims. */
    verification: verifyContract(session),
    contradictions: contradictions(session),
    freshness: freshnessOf(session),
  };
}

/** THE VERIFY CONTRACT, projected. */
const contract = require('./verifycontract');
const LEVEL = contract.LEVEL;

function verifyContract(session) {
  const t = session && session.task;
  const foreign = t && Array.isArray(t.foreignFailures) ? t.foreignFailures : [];
  // THE LADDER NOW EXISTS (verifycontract.js). The level is SELECTED from what
  // the task changed, and is UNSPECIFIED only when it changed nothing.
  const c = contract.contractFor(session);
  return {
    level: c.level,
    reasons: c.reasons,
    plan: c.plan,
    evidence: c.evidence,
    taskComplete: Boolean(t && t.state === taskMod.STATE.COMPLETED),
    taskPassed: c.taskPassed,
    // THREE CLAIMS, NEVER ONE. Clean needs a passing PROJECT-level run AND no
    // outstanding foreign failure; release needs release proof.
    projectClean: c.projectClean && foreign.length === 0,
    releaseReady: c.releaseReady,
    foreignFailures: foreign.slice(-10).map((f) => ({
      what: oneLine(f && f.what, 200),
      why: oneLine(f && f.why, 200),
    })),
  };
}

// --------------------------------------------------------------- work order --

/** ONE EXECUTOR'S EXACT ASSIGNMENT — the contract every worker backend shares. */
class WorkOrder {
  /** `id` the order's own handle. */
  constructor(spec = {}) {
    this.id = String(spec.id || `W${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    /** THE CHAIN THIS ORDER HANGS FROM. Ids, never copies — see the file header. */
    this.goalId = String(spec.goalId || '');
    this.taskId = String(spec.taskId || '');
    this.scopeRevision = Number.isFinite(spec.scopeRevision) ? spec.scopeRevision : 0;
    /** THE OBJECTIVE AS THE WORKER SEES IT. */
    this.objectiveProjection = oneLine(spec.objective, MAX_OBJECTIVE);
    this.readScope = Object.freeze(Array.isArray(spec.readScope) ? spec.readScope.slice(0, 50) : []);
    this.writeScope = Object.freeze(Array.isArray(spec.writeScope) ? spec.writeScope.slice(0, 50) : []);
    /** A BOUNDED ORDER IS ENFORCED. */
    this.bounded = spec.bounded === true;
    this.expansionRequests = Array.isArray(spec.expansionRequests) ? spec.expansionRequests.slice(0, 20) : [];
    this.dependencyScope = Array.isArray(spec.dependencyScope) ? spec.dependencyScope.slice(0, 50) : [];
    this.baselineFingerprints = spec.baselineFingerprints && typeof spec.baselineFingerprints === 'object'
      ? { ...spec.baselineFingerprints } : {};
    this.verificationContract = spec.verificationContract && typeof spec.verificationContract === 'object'
      ? spec.verificationContract : { level: LEVEL.UNSPECIFIED };
    /** WHO IS RUNNING IT, AND WHICH EPOCH THAT IS. See `reassign`. */
    this.executor = spec.executor && typeof spec.executor === 'object'
      ? { provider: String(spec.executor.provider || ''), model: String(spec.executor.model || '') }
      : null;
    this.executorEpoch = Number.isFinite(spec.executorEpoch) ? spec.executorEpoch : 1;
    this.state = STATE_OF.includes(spec.state) ? spec.state : WO_STATE.ISSUED;
    /** WHAT THE WORKER SAID, AND WHAT LAIN SAW — never the same field. */
    this.resultClaim = null;
    this.evidenceReceipts = [];
    this.staleReason = '';
  }

  /** A DIFFERENT MODEL PICKS THIS UP. */
  reassign({ provider = '', model = '' } = {}) {
    this.executor = { provider: String(provider), model: String(model) };
    this.executorEpoch += 1;
    this.state = WO_STATE.ACTIVE;
    return this;
  }

  /** The provider will not serve this executor. The ORDER stays open. */
  block(why = '') {
    this.state = WO_STATE.BLOCKED;
    this.staleReason = '';
    this.blockedWhy = oneLine(why, 200);
    return this;
  }

  /** THE WORKER'S OWN ACCOUNT OF WHAT IT DID. */
  claim(text, { observed = [] } = {}) {
    this.resultClaim = {
      text: oneLine(text, 600),
      at: new Date().toISOString(),
      // WHAT A TOOL REPORTED, beside what the worker said about it. Observed is
      // stronger than claimed and weaker than verified — handover.js's ladder.
      observed: (Array.isArray(observed) ? observed : []).slice(0, 20)
        .map((o) => oneLine(o, 200)).filter(Boolean),
    };
    this.state = WO_STATE.CLAIMED;
    return this;
  }

  /** Evidence LAIN gathered itself. The only input to `verified()`. */
  receipt(kind, detail) {
    this.evidenceReceipts.push({
      kind: oneLine(kind, 40),
      detail: oneLine(detail, 300),
      at: new Date().toISOString(),
    });
    if (this.evidenceReceipts.length > 40) this.evidenceReceipts.shift();
    return this;
  }

  /** LAIN VERIFIED IT. Requires at least one receipt, and refuses otherwise. */
  verified() {
    if (!this.evidenceReceipts.length) return false;
    this.state = WO_STATE.VERIFIED;
    return true;
  }

  /** The ground moved under this order. It is not a failure; it needs rebasing. */
  stale(reason) {
    this.state = WO_STATE.STALE;
    this.staleReason = oneLine(reason, 300);
    return this;
  }

  toJSON() {
    return {
      id: this.id,
      goalId: this.goalId,
      taskId: this.taskId,
      scopeRevision: this.scopeRevision,
      objectiveProjection: this.objectiveProjection,
      readScope: this.readScope,
      writeScope: this.writeScope,
      dependencyScope: this.dependencyScope,
      baselineFingerprints: this.baselineFingerprints,
      verificationContract: this.verificationContract,
      executor: this.executor,
      executorEpoch: this.executorEpoch,
      state: this.state,
      resultClaim: this.resultClaim,
      evidenceReceipts: this.evidenceReceipts,
      staleReason: this.staleReason,
      bounded: this.bounded,
      expansionRequests: this.expansionRequests,
      ...(this.blockedWhy ? { blockedWhy: this.blockedWhy } : {}),
    };
  }

  static from(data) {
    if (!data || typeof data !== 'object') return null;
    const w = new WorkOrder({ ...data, objective: data.objectiveProjection });
    w.executorEpoch = Number.isFinite(data.executorEpoch) ? data.executorEpoch : 1;
    w.state = STATE_OF.includes(data.state) ? data.state : WO_STATE.ISSUED;
    w.resultClaim = data.resultClaim || null;
    w.evidenceReceipts = Array.isArray(data.evidenceReceipts) ? data.evidenceReceipts.slice(-40) : [];
    w.staleReason = String(data.staleReason || '');
    if (data.blockedWhy) w.blockedWhy = String(data.blockedWhy);
    return w;
  }
}

/** A WORK ORDER'S LIFECYCLE. */
const WO_STATE = Object.freeze({
  ISSUED: 'ISSUED',
  ACTIVE: 'ACTIVE',
  /** The provider will not serve its executor. The order is still wanted. */
  BLOCKED: 'BLOCKED',
  /** The worker says it is done. Nothing has checked. */
  CLAIMED: 'CLAIMED',
  /** LAIN checked. Requires receipts — see `verified()`. */
  VERIFIED: 'VERIFIED',
  /** The baseline moved. Needs rebasing, not re-running. */
  STALE: 'STALE',
  /** LAIN applied the proposal, verification failed, and it was reverted. Still open. */
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

const STATE_OF = Object.values(WO_STATE);

/** ISSUE AN ORDER FROM THE CHAIN — the only constructor callers should use. */
function issue(session, { id = '', objective = '', readScope = [], writeScope = [], bounded = false, baseline = null } = {}) {
  const chain = project(session);
  // THE BASELINE IS MEASURED AT ISSUE for every concrete path the order may
  // write, so a result computed against older bytes is refused later.
  const cwd = (session && session.cwd) || process.cwd();
  const concrete = writeScope.map((e) => String(e).split('::')[0]).filter((p) => p && !/[*?]/.test(p));
  const rr = require('./readreceipts');
  const baselineFingerprints = baseline || Object.fromEntries([...new Set(concrete)].map((rel) => { const f = rr.contentFingerprint(require('path').resolve(cwd, rel)); return [rel.replace(/\\/g, '/'), f ? f.fp : null]; }));
  return new WorkOrder({
    bounded,
    baselineFingerprints,
    id,
    goalId: chain.goal ? chain.goal.id : '',
    taskId: chain.task ? chain.task.id : '',
    scopeRevision: chain.scopeRevision,
    objective,
    readScope,
    writeScope,
    verificationContract: { level: chain.verification.level },
    executor: chain.executor
      ? { provider: chain.executor.provider, model: chain.executor.model } : null,
    executorEpoch: chain.executor ? chain.executor.epoch : 1,
    state: WO_STATE.ISSUED,
  });
}

/** THE CHAIN AS PROSE, for a model that is about to work. */
function brief(chain, { omit = [] } = {}) {
  if (!chain) return '';
  // `omit` IS THE ANTI-DUPLICATION RULE, not a convenience.
  const skip = new Set(omit);
  const rows = [];
  if (chain.goal && !skip.has('goal')) {
    rows.push(`GOAL (the standing direction, not this assignment)\n  ${chain.goal.text}`);
  }
  if (chain.task && !skip.has('task')) {
    rows.push(`TASK (the bounded unit of work this serves)\n  ${chain.task.objective}`);
    if (chain.task.steers.length) {
      rows.push('THE USER HAS SINCE SAID (these override the original request)\n'
        + chain.task.steers.map((s) => `  - ${s}`).join('\n'));
    }
  }
  if (chain.plan && chain.plan.current && !skip.has('plan')) {
    rows.push(`PLAN (one strategy, revisable — step ${chain.plan.done + 1} of ${chain.plan.total})\n  ${chain.plan.current}`);
  }
  const w = chain.workOrder;
  if (w) {
    rows.push(`WORK ORDER ${w.id} (your exact assignment)\n  ${w.objectiveProjection}`);
    if (w.writeScope.length) rows.push(`YOU MAY WRITE\n${w.writeScope.map((p) => `  - ${p}`).join('\n')}`);
  }
  // WHAT WOULD PROVE IT, when anything is known.
  const v = chain.verification;
  if (v && v.foreignFailures.length) {
    rows.push('FAILURES THAT ARE NOT YOURS (recorded, do not repair them)\n'
      + v.foreignFailures.map((f) => `  - ${f.what}`).join('\n'));
  }
  return rows.join('\n\n');
}

module.exports = {
  project, brief, issue, contradictions, verifyContract, scopeRevision,
  WorkOrder, WO_STATE, LEVEL,
  MAX_OBJECTIVE,
};
