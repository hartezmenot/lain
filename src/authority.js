'use strict';

/**
 * THE AUTHORITY CHAIN, PROJECTED ONCE — goal → task → plan → work order.
 *
 * ------------------------------------------------------------------------
 * THE FAILURE THIS FILE EXISTS TO END, and it was found by audit rather than by
 * a crash, which is why it had survived so long.
 *
 * Every consumer that needed to know "what is this work FOR" reached into the
 * session and picked its own fields. `jobrunner.forkSession` chose `task` and
 * `mode`. `prompt.js` chose the goal and the task separately. `tools/plan.js`
 * chose `input.objective` OR `session.task.objective`, whichever was present.
 * `handover.js` chose the task and its steers. None of them was wrong on its
 * own, and together they were four different answers to one question — so a
 * background job inherited the task and silently lost the GOAL, and a plan could
 * be written with an objective that contradicted both.
 *
 *     GOAL          stabilise provider continuation
 *     TASK          repair handover
 *     PLAN          redesign frontend        <- nothing noticed
 *
 * ------------------------------------------------------------------------
 * IT IS A PROJECTION. IT IS NOT A STORE. This is the load-bearing rule.
 *
 * Nothing here holds state, nothing here is persisted, and every field is read
 * through the module that owns it — `goal.js` for the goal, `task.js` for the
 * task and the executor, `plan.js` for the plan. Adding a store here would make
 * a fifth answer to the question, which is the disease rather than the cure.
 *
 * So this module may be deleted and rebuilt from the session at any time, and
 * that is the test of whether it has stayed a projection.
 *
 * ------------------------------------------------------------------------
 * THE LADDER, and what each rung is allowed to do.
 *
 *     GOAL        the durable strategic outcome.      Only `/goal` writes it.
 *     TASK        the current bounded unit of work.   The user's latest ask.
 *     PLAN        one strategy for the task.          Revisable, never authority.
 *     WORK ORDER  one executor's exact assignment.    Derived from the three.
 *
 * A rung may narrow the one above it. It may never contradict it, and it may
 * never replace it. `contradictions()` is where that is checked.
 *
 * ------------------------------------------------------------------------
 * LATEST EXPLICIT USER INTENT OUTRANKS THE STORED GOAL. A goal is what somebody
 * decided earlier; a sentence they just typed is what they want now. So the
 * projection reports the RELATION between the two (see goal.relate) and never
 * resolves it silently — a request that supersedes the direction is surfaced,
 * because acting on it under the old goal and rewriting the goal without being
 * asked are both wrong.
 */

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

/**
 * WHICH REVISION OF THE SCOPE THIS IS.
 *
 * A task's scope changes when the user steers it, and a work order issued before
 * a steer was issued against a different scope than one issued after. Without a
 * revision number the two are indistinguishable, and a worker holding the older
 * one cannot be told that the ground moved.
 *
 * IT IS THE STEER COUNT, which is derived rather than stored on purpose: a
 * counter somebody has to remember to increment is a counter that will disagree
 * with the thing it counts. `plan.steer()` and `task.steer()` are the only ways
 * scope changes, and both append.
 */
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
    // THE USER'S LATER WORDS, which outrank the objective they replaced. Carried
    // here rather than left for each consumer to dig out, because every consumer
    // that missed them acted on a request the user had already corrected.
    steers: (Array.isArray(t.steers) ? t.steers : []).slice(-MAX_STEERS)
      .map((s) => oneLine(s && s.text, 160)).filter(Boolean),
    state: t.state || taskMod.STATE.ACTIVE,
    startedAt: t.startedAt || null,
  };
}

/**
 * WHO IS CARRYING IT, AND WHETHER THEY CAN WORK.
 *
 * Projected from the task because that is where it lives — see task.js EXECUTOR
 * on why an executor is a lease and never a deed. `epoch` is what lets a work
 * order survive a model replacement: see `WorkOrder`.
 */
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
    /**
     * HOW MANY EXECUTORS THIS TASK HAS HAD. One-based: the first executor is
     * epoch 1, and a handover to a second makes it 2.
     *
     * DERIVED FROM THE HANDOVER LOG rather than counted separately, for the same
     * reason `scopeRevision` is derived — `assignExecutor` already appends a row
     * per change, and a second counter could only ever disagree with it.
     */
    epoch: (Array.isArray(t.handovers) ? t.handovers.length : 0) + 1,
    /** Nobody can work this right now, and it is not finished. See task.stranded. */
    stranded: typeof t.stranded === 'boolean' ? t.stranded
      : Boolean(e.state && e.state !== taskMod.EXECUTOR.ACTIVE),
  };
}

/**
 * The plan rung — STRATEGY, never authority.
 *
 * `objective` is deliberately absent from this projection even though `Plan`
 * still carries one. See `contradictions()`: a plan's objective is display text
 * derived from the task, and projecting it beside the task's own would put two
 * objective-shaped strings in front of a consumer that has to pick one.
 */
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

/**
 * WHERE THE PROJECTION'S FACTS CAME FROM, and whether they are current.
 *
 * A consumer that cannot tell a MEASURED absence from an UNKNOWN one will treat
 * the second as the first — the mistake `tokenview.js` documents at length and
 * the reason every rung reports its own presence here rather than being inferred
 * from a null.
 */
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

/**
 * THE RUNGS THAT ARGUE WITH EACH OTHER.
 *
 * Returns a list, empty when the chain is coherent. Each entry names the rung
 * that overstepped, what it said, and what it contradicted — so a caller can
 * REPORT the contradiction rather than having to decide which side wins, which
 * is not a decision code should be making.
 *
 * ------------------------------------------------------------------------
 * WHAT COUNTS AS A CONTRADICTION, because "different words" does not.
 *
 * A task objective almost never repeats the goal's wording, and a plan step
 * repeats neither. Flagging difference would flag everything and be ignored
 * within a day. So the only thing checked is a rung carrying its OWN objective
 * that shares no content words with the rung above it — a plan called "redesign
 * frontend" under a task called "repair handover" is not a narrowing of it in
 * any reading.
 *
 * `objectiveOverlap` is task.js's, reused deliberately: "are these two sentences
 * about the same work" already had one answer in this tree and must not acquire
 * a second.
 */
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
    // AND AGAINST THE GOAL, because a plan may legitimately restate the
    // DIRECTION rather than this task — "stabilise handover" over a task of "fix
    // continuation" shares nothing with the task and is still coherent.
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

/**
 * THE CANONICAL PROJECTION. One call, one answer, no field-picking.
 *
 * @param {object} session
 * @param {object} [options]
 *   `request`   the sentence being acted on right now, when there is one. Used
 *               only to report how it stands to the standing goal — never to
 *               change the goal. See goal.relate.
 *   `workOrder` an issued WorkOrder to include, when one exists.
 *
 * TOTAL. A null session projects a chain of nulls rather than throwing: this is
 * consulted from prompt building, from a fork and from a handover, and none of
 * those may fail over an absent rung.
 */
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
    /**
     * HOW THE REQUEST IN HAND STANDS TO THE STANDING GOAL, when there is one.
     * Reported, never applied — see this file's header and goal.js `relate`.
     */
    relation: request ? goalMod.relate(session, request) : null,
    /**
     * WHAT WOULD PROVE THIS DONE: the level selected from the change, and the
     * separate claims. See verifycontract.js.
     */
    verification: verifyContract(session),
    contradictions: contradictions(session),
    freshness: freshnessOf(session),
  };
}

/**
 * THE VERIFY CONTRACT, projected.
 *
 * The ladder, the selection, the escalation, the failure classes and the
 * evidence states live in verifycontract.js. This projection carries what a
 * consumer of the chain needs: the selected level and why, and the separate
 * claims — task complete, task passed, project clean, release ready — that one
 * number would erase. `foreignFailures` are failures this task did not cause
 * and may not repair.
 */
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

/**
 * ONE EXECUTOR'S EXACT ASSIGNMENT — the contract every worker backend shares.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS BEFORE THERE ARE PARALLEL WORKERS. Because the alternative is
 * what was already starting to happen: `/bg` had its own way of orienting a
 * worker, and an OpenRouter path and a Codex path would each have invented
 * another. Three orchestrations with three notions of "what is this worker for"
 * cannot be made to agree afterwards — the agreement has to exist first, with
 * one consumer, and then get more.
 *
 *     WORK ORDER
 *          │
 *    executor adapter
 *     ┌────┼────┐
 *     ▼    ▼    ▼
 *    /bg  future  future
 *
 * ------------------------------------------------------------------------
 * WHAT IS ENFORCED, and by whom:
 *
 *   `readScope` / `writeScope`   ENFORCED for a BOUNDED order by
 *       workorderguard.js — at the tool door for reads, and in the mutation
 *       transaction (mutation.js) for writes. `dependencyScope` is declarative.
 *
 *   `baselineFingerprints`   ENFORCED. Measured at `issue`; a write or a
 *       proposal whose target no longer matches is STALE_WORK_ORDER and nothing
 *       is overwritten (mutation.js, proposal.js).
 *
 * A field with no consumer yet is carried ONLY when the contract cannot be
 * truthful without it. Everything else was left out.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT PERSISTED, AND THAT IS A LIMITATION RATHER THAN A DESIGN.
 *
 * `toJSON`/`from` exist and round-trip faithfully, but nothing writes the result
 * to disk: `Session.toJSON` is an allowlist that does not include `workOrder`,
 * and the job registry is in-memory. So an order lives exactly as long as its
 * job — which MATCHES what `/bg` does today (a background job does not survive a
 * restart either), so nothing is inconsistent.
 *
 * IT WILL HAVE TO CHANGE before a worker can be resumed across a crash, and the
 * serialisation is here so that change is a wiring job rather than a redesign.
 * Until then: an order is not durable state, and no caller should assume it is.
 */
class WorkOrder {
  /**
   * @param {object} spec
   *   `id`         the order's own handle. A caller with a natural one (a job
   *                number) should pass it, so the row and the order agree.
   *   `objective`  what THIS worker is to do — not the goal, not the task.
   */
  constructor(spec = {}) {
    this.id = String(spec.id || `W${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    /** THE CHAIN THIS ORDER HANGS FROM. Ids, never copies — see the file header. */
    this.goalId = String(spec.goalId || '');
    this.taskId = String(spec.taskId || '');
    this.scopeRevision = Number.isFinite(spec.scopeRevision) ? spec.scopeRevision : 0;
    /**
     * THE OBJECTIVE AS THE WORKER SEES IT. A PROJECTION, and named so nobody
     * reads it as a fourth authority: it is derived from the request that
     * created the order and is bounded to a briefing's length.
     */
    this.objectiveProjection = oneLine(spec.objective, MAX_OBJECTIVE);
    this.readScope = Object.freeze(Array.isArray(spec.readScope) ? spec.readScope.slice(0, 50) : []);
    this.writeScope = Object.freeze(Array.isArray(spec.writeScope) ? spec.writeScope.slice(0, 50) : []);
    /**
     * A BOUNDED ORDER IS ENFORCED. workorderguard.js refuses a write outside
     * `writeScope` and a result whose baseline moved. The main executor and a
     * `/bg` fork carry unbounded orders and keep their freedom.
     */
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
    /**
     * WHAT THE WORKER SAID, AND WHAT LAIN SAW — never the same field.
     *
     * `resultClaim` is the worker's own account and is NOT evidence. See
     * `claim()`; the three-word vocabulary is handover.js's and is reused rather
     * than re-invented.
     */
    this.resultClaim = null;
    this.evidenceReceipts = [];
    this.staleReason = '';
  }

  /**
   * A DIFFERENT MODEL PICKS THIS UP. The order does not change.
   *
   * THE IDENTITY IS NOT TOUCHED — not `id`, not `goalId`, not `taskId`, not the
   * scope, not the baseline, not the evidence. Only the executor and the epoch.
   * That is the whole point of an epoch, and it is the work-order-level form of
   * the rule task.js already holds: a model name is not part of a task's
   * identity, so replacing the model cannot replace the work.
   */
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

  /**
   * THE WORKER'S OWN ACCOUNT OF WHAT IT DID. RECORDED AS A CLAIM.
   *
   * `state` becomes CLAIMED and never VERIFIED. A worker saying "implemented and
   * tested" has produced a sentence, and the whole reason this method is named
   * `claim` is that there is no code path from a sentence to a verdict. See
   * `verified()`, which only LAIN-owned verification reaches.
   */
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

  /**
   * LAIN VERIFIED IT. Requires at least one receipt, and refuses otherwise.
   *
   * THE REFUSAL IS THE FEATURE. Without it, `verified()` is a setter a caller
   * can reach from a worker's claim in one line, and the distinction this class
   * is built around evaporates at the first convenient call site.
   */
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

/**
 * A WORK ORDER'S LIFECYCLE. `CLAIMED` and `VERIFIED` are two states and not one,
 * which is the only reason this list is worth having.
 */
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

/**
 * ISSUE AN ORDER FROM THE CHAIN — the only constructor callers should use.
 *
 * It exists so that no caller has to know how to read a goal id off a session,
 * which is how the field-picking this module ends got started in the first place.
 */
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

/**
 * THE CHAIN AS PROSE, for a model that is about to work.
 *
 * ------------------------------------------------------------------------
 * FOUR LABELLED RUNGS AND NOTHING ELSE. A worker that is handed the parent's
 * whole session learns everything except which part of it is the assignment —
 * that was the shape of the `/bg` defect, where a fork inherited the task and
 * lost the goal and nobody could tell from the worker's output that it had.
 *
 * BOUNDED, because it rides every request the worker makes.
 */
function brief(chain, { omit = [] } = {}) {
  if (!chain) return '';
  // `omit` IS THE ANTI-DUPLICATION RULE, not a convenience. A caller that has
  // already stated a rung must say so, or the prompt carries one fact twice -
  // which is how a system prompt grows: not by anybody adding a paragraph, but
  // by two places each correctly stating the same thing. The first wiring of
  // this into appprompt.js printed the standing goal directly under a `# Goal`
  // heading that had just printed it.
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
  // WHAT WOULD PROVE IT, when anything is known. Silent otherwise: an empty
  // heading is worse than no heading, and inventing a level would assert a
  // verification nobody selected.
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
