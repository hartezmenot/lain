'use strict';

/**
 * TASK IDENTITY — the single authority.
 *
 * V1 had four of these (`diagnostic.continuationOnly`, `diagnostic.taskContinuation`,
 * `App._planResumeIntent`, `TaskLifecycle.classifyPrompt`) and they disagreed.
 * One of them was anchored only at the start, so a pasted block beginning with
 * `continue;` was read as an instruction to resume.
 *
 * Everything that needs to know "is this the same task?" calls `classify()` and
 * consumes the verdict. Nothing re-interprets the raw input.
 *
 * THE RULES, in priority order:
 *   1. A PASTE IS NEVER A CONTROL WORD. The terminal told us structurally that
 *      this is content. No amount of "continue" at the top changes that.
 *   2. Multi-line input is never a control word either — same reason, weaker
 *      signal, for terminals that do not bracket pastes.
 *   3. A short, exact continuation phrase continues the ACTIVE task. With no
 *      active task it is a new task (there is nothing to continue).
 *   4. A restatement of the active objective is the SAME task, not a new one.
 *      This is what stops evidence being thrown away every time a user rephrases.
 *   5. Anything else with an active task is a STEER: it adjusts the current work
 *      without discarding it.
 *   6. Anything else is a new task.
 *
 * Session boundaries are NOT crossed here. `/resume` is the only thing that does
 * that, and it is a command, not a classification.
 */

const KIND = Object.freeze({
  NEW: 'new',
  CONTINUATION: 'continuation',
  RESTATEMENT: 'restatement',
  STEER: 'steer',
  CONTENT: 'content',
});

/**
 * ---------------------------------------------------------------------------
 * P0 — THE STALE-TASK BUG. Reproduced: an active task exists, the user
 * explicitly says "cancel it, do something else instead", and — because
 * nothing here recognised cancellation as its own thing — that fell through
 * every rule to STEER ("new instruction while a task is active — adjusts it,
 * does not replace it"). `identify.js` then appended it as a correction to
 * the SAME task and left the OLD plan/goal state fully in force, which is
 * exactly backwards: the user asked to stop that work, not adjust it.
 *
 * `CANCEL_RE` is deliberately an explicit cancel-verb PLUS a reference to the
 * active work — "cancel it", "stop that", "forget the current task", "drop
 * this plan" — never a bare noun match, so "add a cancel button" or "the
 * upload was cancelled by the server" (a fact being reported, not an
 * instruction) do not fire it. A false negative here costs one more STEER,
 * which is recoverable; a false positive would silently discard live work on
 * a passing mention of the word.
 */
const CANCEL_RE = /\b(?:cancel|abandon|drop|scrap|forget)\b[^.?!\n]{0,40}\b(?:this|that|it|the (?:current |active |previous )?(?:task|plan|goal|thing|request|work)|what (?:we|i|you)(?:'re| are)? (?:doing|working on))\b/i;
/** The bare exact form — "cancel it.", "cancel that", "stop it" alone. */
const CANCEL_EXACT_RE = /^(?:cancel|abandon|drop|scrap|forget)(?: (?:it|that|this|the (?:task|plan|goal)))?[.!]?$/i;

/**
 * ------------------------------------------------------------------------
 * WHAT THE TASK ITSELF IS DOING. Not what any model is doing about it.
 *
 * THE FAILURE THIS SEPARATION EXISTS TO END, and it is a real one: a model
 * reached its weekly limit mid-task, and the only state anybody had said the
 * work had "failed". So the next model was handed a dead task, the objective
 * was restated by the user, the evidence was thrown away, and a task that was
 * nine tenths finished was begun again from nothing.
 *
 * A PROVIDER LIMIT IS A FACT ABOUT A PROVIDER. It is not a fact about whether
 * the account backend still needs writing. Those are two different questions
 * and they now have two different fields — see `EXECUTOR` below.
 */
const STATE = Object.freeze({
  /** Wanted, unfinished, and nothing has superseded it. The ordinary state. */
  ACTIVE: 'ACTIVE',
  /** The user set it aside. It keeps every fact it had. */
  PAUSED: 'PAUSED',
  /** A later task took over its objective. Kept for provenance, not for work. */
  SUPERSEDED: 'SUPERSEDED',
  /** Its verify contract was satisfied. See §42 — this is not "the repo is clean". */
  COMPLETED: 'COMPLETED',
  /** Deliberately dropped. Only the user can say this. */
  ABANDONED: 'ABANDONED',
});

/** Task states in which work may still legitimately be done. */
const LIVE_STATES = new Set([STATE.ACTIVE, STATE.PAUSED]);

/**
 * WHAT THE MODEL CURRENTLY CARRYING THE TASK IS DOING.
 *
 * ------------------------------------------------------------------------
 * AN EXECUTOR IS A LEASE, NOT A DEED. Nothing here grants a model ownership of
 * a file, a folder or a subsystem, and there is deliberately no field in which
 * such a claim could be written down. A model that touched a file leaves
 * PROVENANCE — who changed what, under which task, from which baseline — and
 * provenance answers "where did this come from", never "who is allowed to
 * change it next". The user's current task decides that.
 *
 * The distinction matters because the alternative was tried by accident: when
 * the only record was "Opus wrote this backend", the next model treated it as
 * someone else's property and declined to repair a login bug that ran straight
 * through it.
 */
const EXECUTOR = Object.freeze({
  /** Holding the task and able to work it. */
  ACTIVE: 'ACTIVE',
  /**
   * The PROVIDER will not serve this model right now — a rate limit, a weekly
   * cap, an outage, a revoked key. NOT a statement about the task, and never a
   * reason to end one.
   */
  PROVIDER_BLOCKED: 'PROVIDER_BLOCKED',
  /** The executor errored in a way that is about the model, not the provider. */
  FAILED: 'FAILED',
  /** Handed over cleanly — the user switched model, or the work was passed on. */
  RELEASED: 'RELEASED',
});

/** Exact, whole-input phrases that mean "carry on". Anchored at BOTH ends. */
const CONTINUE_RE = /^(?:continue|continue the previous task|continue please|keep working|keep going|carry on|go on|go ahead|proceed|resume|next|next step|and\?|\?)[.!]?$/i;

/** Words that carry no information about WHICH objective is meant. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'at', 'for',
  'it', 'its', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'please', 'can', 'you',
  'why', 'how', 'what', 'when', 'where', 'and', 'but', 'or', 'not', 'with', 'me', 'i',
  'still', 'again', 'now', 'then', 'so', 'do', 'does', 'did', 'have', 'has', 'had',
  'fix', 'make', 'add', 'change', 'update', 'get', 'use',
]);

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Jaccard overlap of content words. Deliberately crude, and the asymmetry is
 * deliberate too: a false "same task" costs one preserved evidence set, while a
 * false "new task" throws away everything already learned — which is the failure
 * this file exists to prevent.
 */
function objectiveOverlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const RESTATEMENT_THRESHOLD = 0.4;

/**
 * REMOVE THE CANCEL SENTENCE, KEEP THE REST. "Cancel the current task.
 * Diagnose Calculator using Computer MCP." should become the new task's
 * objective as "Diagnose Calculator using Computer MCP.", not carry the
 * instruction to cancel forward as part of what the new task is FOR.
 *
 * Splits on the first sentence terminator after the cancel clause; a single
 * clause with nothing after it ("Cancel it.") returns '' and the caller falls
 * back to the raw text, so a new task is never created with a blank objective.
 */
function stripCancelClause(trimmed) {
  const m = CANCEL_RE.exec(trimmed);
  if (!m) return '';
  const after = trimmed.slice(m.index + m[0].length);
  const cut = after.search(/[.!?]/);
  const rest = (cut >= 0 ? after.slice(cut + 1) : after).trim();
  return rest;
}

/**
 * @param {string} text
 * @param {object} ctx
 *   isPaste     — the terminal said this was pasted
 *   activeTask  — { objective } or null
 * @returns {{kind, reason, sameTask:boolean}}
 */
function classify(text, ctx = {}) {
  const raw = String(text == null ? '' : text);
  const trimmed = raw.trim();
  const active = ctx.activeTask || null;
  const multiline = raw.includes('\n');

  if (ctx.isPaste) {
    return {
      kind: KIND.CONTENT, sameTask: Boolean(active),
      reason: 'the terminal reported this as pasted content, so it is never a control word',
    };
  }
  if (multiline) {
    return {
      kind: KIND.CONTENT, sameTask: Boolean(active),
      reason: 'multi-line input is content, not a control word',
    };
  }
  if (CONTINUE_RE.test(trimmed)) {
    return active
      ? { kind: KIND.CONTINUATION, sameTask: true, reason: 'exact continuation phrase with an active task' }
      : { kind: KIND.NEW, sameTask: false, reason: 'continuation phrase but there is no active task to continue' };
  }
  // ---- EXPLICIT CANCELLATION, BEFORE RESTATEMENT AND BEFORE STEER --------
  //
  // Checked before restatement because "cancel the login task, build the
  // signup page instead" can share vocabulary with the old objective without
  // meaning "keep going on it" — cancellation is the stronger, more explicit
  // signal and wins. A cancelled task is superseded, never merely adjusted:
  // see identify.js, which is where the old task is actually retired.
  if (active && (CANCEL_RE.test(trimmed) || CANCEL_EXACT_RE.test(trimmed))) {
    const rest = stripCancelClause(trimmed);
    return {
      kind: KIND.NEW, sameTask: false, cancelled: true,
      // WHAT THE NEW TASK ACTUALLY IS, with the cancel clause itself removed
      // so the task's own objective reads as the work, not as "cancel X, ".
      // Empty after stripping ("cancel it." alone) falls back to the raw text
      // so a new task object is never created with a blank objective.
      newText: rest || trimmed,
      reason: 'explicit cancellation of the active task — it is superseded, not adjusted',
    };
  }
  if (active && objectiveOverlap(active.objective, trimmed) >= RESTATEMENT_THRESHOLD) {
    return { kind: KIND.RESTATEMENT, sameTask: true, reason: 'restates the active objective' };
  }
  if (active) {
    return { kind: KIND.STEER, sameTask: true, reason: 'new instruction while a task is active — adjusts it, does not replace it' };
  }
  return { kind: KIND.NEW, sameTask: false, reason: 'no active task' };
}

/**
 * The current task. Owned by the session; there is no module-level state and no
 * second place that tracks "what are we doing".
 */
class Task {
  constructor(objective) {
    this.objective = String(objective || '');
    this.startedAt = new Date().toISOString();
    this.steers = [];        // [{ text, at }]
    this.turnIds = [];
    /**
     * A STABLE HANDLE FOR THIS TASK, so evidence, receipts and a handover
     * packet can all name the same thing across a model switch and a restart.
     * Time-ordered, so a directory of task evidence sorts by when the work
     * happened without parsing anything.
     */
    this.id = `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    /** See STATE. The task's own lifecycle, independent of any model. */
    this.state = STATE.ACTIVE;
    /**
     * WHO IS CARRYING IT, AND WHAT THAT MODEL IS ABLE TO DO. See EXECUTOR.
     *
     * `null` until something assigns one: a task created before a provider was
     * chosen has no executor, and inventing one would put a model's name on
     * work it never saw.
     */
    this.executor = null;    // { provider, model, state, since, why }
    /**
     * EVERY EXECUTOR THIS TASK HAS HAD, oldest first. PROVENANCE — see EXECUTOR
     * on why this is not ownership. It answers "who did what, and why did they
     * stop", which is exactly what a returning model needs and exactly what the
     * previous design could not say.
     */
    this.handovers = [];     // [{ from, to, why, at }]
    /**
     * FAILURES THIS TASK DID NOT CAUSE AND MAY NOT REPAIR — §43.
     *
     * A broad test run shows every broken thing in the repository, including
     * another task's unfinished work. That is EVIDENCE, and it is emphatically
     * not authorisation: a model whose task is the API layer must not start
     * repairing a half-written bot module because a smoke run happened to show
     * it red. Recorded here so it can be REPORTED without being adopted, and so
     * "this task is complete" and "this repository is clean" stay two separate
     * claims. See §44.
     */
    this.foreignFailures = [];  // [{ what, why, at }]
    /**
     * HOW MANY TIMES SOMEBODY WENT OUTSIDE ABOUT THIS TASK.
     *
     * Declared here rather than stuck on the object by whoever needed it,
     * because `toJSON` is an allowlist: an ad-hoc `_externalConsults` was set
     * correctly, read correctly, and then silently dropped on save — so a
     * `--resume` came back believing no consultation had ever happened, and the
     * one thing that stops a chain of second opinions is the memory that there
     * already was one.
     */
    this.externalConsults = 0;
  }

  /** One more outside opinion on this task. See externalrequest.consultedOn. */
  consultedExternally() { this.externalConsults += 1; return this; }

  /** True while work on this task is still legitimate, whoever is (or is not) carrying it. */
  get live() { return LIVE_STATES.has(this.state); }

  /**
   * NOBODY CAN WORK THIS RIGHT NOW — but it is not finished.
   *
   * The single most important predicate in this file, because it is the one the
   * old design could not express. A task whose executor is PROVIDER_BLOCKED is
   * ACTIVE and unfinished and simply has no model on it this minute. Handing it
   * to another model is the ordinary remedy, not an exception.
   */
  get stranded() { return this.live && Boolean(this.executor) && this.executor.state !== EXECUTOR.ACTIVE; }

  /**
   * A MODEL TAKES THE TASK UP. THE TASK IS NOT TOUCHED.
   *
   * ------------------------------------------------------------------------
   * THIS METHOD'S WHOLE JOB IS WHAT IT DOES NOT DO. It does not clear the
   * objective, the steers, the evidence, the plan or the id, and it does not
   * reset `state`. Regression #3: a rate-limited executor must not be able to
   * destroy task continuity, and the way that keeps happening is that
   * "switching model" is implemented as "start again".
   *
   * The outgoing executor's exit is recorded first, with its reason, so the
   * packet the incoming model reads can say WHY it is here — `provider limit`
   * and `the user changed their mind` need different handovers.
   */
  assignExecutor({ provider = '', model = '', why = '' } = {}, at = new Date().toISOString()) {
    const prev = this.executor;
    if (prev) {
      // A CLEAN HANDOVER IF NOBODY SAID OTHERWISE. An executor that is still
      // ACTIVE when it is replaced was not blocked and did not fail — it was
      // swapped, which is the user exercising the authority §1.1 gives them.
      if (prev.state === EXECUTOR.ACTIVE) prev.state = EXECUTOR.RELEASED;
      this.handovers.push({
        from: prev.model || prev.provider || 'unknown',
        to: model || provider || 'unknown',
        why: String(why || prev.why || '').slice(0, 200),
        at,
      });
    }
    this.executor = {
      provider: String(provider || ''),
      model: String(model || ''),
      state: EXECUTOR.ACTIVE,
      since: at,
      why: '',
    };
    return this;
  }

  /**
   * THE PROVIDER WILL NOT SERVE THIS MODEL. The task stays exactly as it is.
   *
   * Deliberately says nothing about `state`. See STATE's header: this used to
   * be recorded as the task failing, and that single conflation is what threw
   * away nine tenths of a finished task.
   */
  blockExecutor(why = '', at = new Date().toISOString()) {
    if (!this.executor) return this;
    this.executor.state = EXECUTOR.PROVIDER_BLOCKED;
    this.executor.why = String(why || '').slice(0, 200);
    this.executor.blockedAt = at;
    return this;
  }

  /** The same model can work again — a limit expired, a key was replaced. */
  resumeExecutor(at = new Date().toISOString()) {
    if (!this.executor) return this;
    this.executor.state = EXECUTOR.ACTIVE;
    this.executor.why = '';
    this.executor.since = at;
    return this;
  }

  /**
   * SOMETHING IS BROKEN THAT THIS TASK DID NOT BREAK — record, do not adopt.
   *
   * Deduplicated on `what`, because a broad suite re-run reports the same
   * foreign failure every time and a list that grows without bound stops being
   * read. Bounded for the same reason.
   */
  noteForeignFailure(what, why = '', at = new Date().toISOString()) {
    const key = String(what || '').slice(0, 200);
    if (!key) return this;
    if (this.foreignFailures.some((f) => f.what === key)) return this;
    this.foreignFailures.push({ what: key, why: String(why || '').slice(0, 200), at });
    if (this.foreignFailures.length > MAX_FOREIGN) this.foreignFailures.shift();
    return this;
  }

  /**
   * THE TASK REACHED A TERMINAL STATE.
   *
   * `COMPLETED` here means THIS TASK'S verify contract was satisfied — §42/§44.
   * It does NOT assert that the repository is clean, and `foreignFailures`
   * survives into the record precisely so the two cannot be confused by anybody
   * reading it later.
   */
  settle(state) {
    if (!Object.values(STATE).includes(state)) return this;
    this.state = state;
    if (this.executor && this.executor.state === EXECUTOR.ACTIVE) {
      this.executor.state = EXECUTOR.RELEASED;
    }
    return this;
  }

  steer(text) {
    this.steers.push({ text: String(text), at: new Date().toISOString() });
    return this;
  }

  /**
   * THIS IS AN ALLOWLIST, AND THAT HAS BITTEN ONCE ALREADY.
   *
   * See `externalConsults` above: it was set correctly, read correctly, and
   * silently dropped here, so a `--resume` came back believing no consultation
   * had ever happened. EVERY FIELD ADDED TO THE CONSTRUCTOR MUST BE ADDED HERE
   * AND TO `from`, or it survives in memory and evaporates on restart — which
   * is the worst shape a bug can have, because it only appears after the thing
   * that would have shown it is gone.
   */
  toJSON() {
    return {
      objective: this.objective, startedAt: this.startedAt,
      steers: this.steers, turnIds: this.turnIds,
      externalConsults: this.externalConsults,
      id: this.id, state: this.state,
      executor: this.executor, handovers: this.handovers,
      foreignFailures: this.foreignFailures,
    };
  }

  static from(data) {
    if (!data || typeof data !== 'object') return null;
    const t = new Task(data.objective);
    t.startedAt = data.startedAt || t.startedAt;
    // ---- THE ARRAYS ARE COPIED, NEVER ADOPTED -----------------------------
    //
    // `toJSON` returns the LIVE arrays — it is an allowlist, not a deep clone —
    // so `Task.from(other.toJSON())` used to hand the new Task the old one's
    // own `steers` by reference. Two Tasks then shared one array, and a steer
    // recorded against either appeared on both.
    //
    // THAT IS NOT THEORETICAL: it is exactly how a `/bg` fork shared state with
    // the conversation that forked it. A worker being told "keep the old format
    // working" wrote that sentence into the foreground task's own record, where
    // a user who had never said it would read it as their own correction.
    //
    // A DESERIALISER MUST NOT ALIAS ITS INPUT. Fixed here rather than at the one
    // call site that noticed, because every future caller of `from` inherits it.
    t.steers = Array.isArray(data.steers) ? data.steers.slice() : [];
    t.turnIds = Array.isArray(data.turnIds) ? data.turnIds.slice() : [];
    t.externalConsults = Number(data.externalConsults) || 0;
    // ---- A RECORD WRITTEN BEFORE THESE FIELDS EXISTED IS STILL A TASK ------
    //
    // Restoring a session saved by an older build must not produce a task with
    // `state: undefined`, because `live` would then be false and the session
    // would come back looking finished. The constructor's defaults are the
    // fallback, and they are the right ones: an id it did not have, and ACTIVE.
    t.id = typeof data.id === 'string' && data.id ? data.id : t.id;
    t.state = Object.values(STATE).includes(data.state) ? data.state : STATE.ACTIVE;
    // AN EXECUTOR IS RESTORED AS IT WAS, NOT AS ACTIVE. A session resumed after
    // a weekly limit must come back knowing it is still blocked; optimistically
    // clearing that would send the first turn straight back into the limit.
    t.executor = data.executor && typeof data.executor === 'object'
      ? {
        provider: String(data.executor.provider || ''),
        model: String(data.executor.model || ''),
        state: Object.values(EXECUTOR).includes(data.executor.state)
          ? data.executor.state : EXECUTOR.ACTIVE,
        since: data.executor.since || t.startedAt,
        why: String(data.executor.why || ''),
        ...(data.executor.blockedAt ? { blockedAt: data.executor.blockedAt } : {}),
      }
      : null;
    t.handovers = Array.isArray(data.handovers) ? data.handovers.slice() : [];
    t.foreignFailures = Array.isArray(data.foreignFailures)
      ? data.foreignFailures.slice(-MAX_FOREIGN) : [];
    return t;
  }
}

/** Foreign failures carried. A briefing, not an inventory — see noteForeignFailure. */
const MAX_FOREIGN = 20;

module.exports = {
  KIND, STATE, EXECUTOR, LIVE_STATES, MAX_FOREIGN,
  classify, objectiveOverlap, tokens, Task, CONTINUE_RE, RESTATEMENT_THRESHOLD,
  CANCEL_RE, CANCEL_EXACT_RE, stripCancelClause,
};
