'use strict';

/** TASK IDENTITY — the single authority. */

const KIND = Object.freeze({
  NEW: 'new',
  CONTINUATION: 'continuation',
  RESTATEMENT: 'restatement',
  STEER: 'steer',
  CONTENT: 'content',
});

/** P0 — THE STALE-TASK BUG. */
const CANCEL_RE = /\b(?:cancel|abandon|drop|scrap|forget)\b[^.?!\n]{0,40}\b(?:this|that|it|the (?:current |active |previous )?(?:task|plan|goal|thing|request|work)|what (?:we|i|you)(?:'re| are)? (?:doing|working on))\b/i;
/** The bare exact form — "cancel it.", "cancel that", "stop it" alone. */
const CANCEL_EXACT_RE = /^(?:cancel|abandon|drop|scrap|forget)(?: (?:it|that|this|the (?:task|plan|goal)))?[.!]?$/i;

/** WHAT THE TASK ITSELF IS DOING. */
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

/** WHAT THE MODEL CURRENTLY CARRYING THE TASK IS DOING. */
const EXECUTOR = Object.freeze({
  /** Holding the task and able to work it. */
  ACTIVE: 'ACTIVE',
  /** The PROVIDER will not serve this model right now — a rate limit, a weekly cap, an outage, a revoked key. */
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

/** Jaccard overlap of content words. */
function objectiveOverlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const RESTATEMENT_THRESHOLD = 0.4;

/** REMOVE THE CANCEL SENTENCE, KEEP THE REST. */
function stripCancelClause(trimmed) {
  const m = CANCEL_RE.exec(trimmed);
  if (!m) return '';
  const after = trimmed.slice(m.index + m[0].length);
  const cut = after.search(/[.!?]/);
  const rest = (cut >= 0 ? after.slice(cut + 1) : after).trim();
  return rest;
}

/** isPaste — the terminal said this was pasted activeTask — { objective } or null @returns {{kind, reason, sameTask:boolean}} */
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
  // EXPLICIT CANCELLATION, BEFORE RESTATEMENT AND BEFORE STEER
  if (active && (CANCEL_RE.test(trimmed) || CANCEL_EXACT_RE.test(trimmed))) {
    const rest = stripCancelClause(trimmed);
    return {
      kind: KIND.NEW, sameTask: false, cancelled: true,
      // WHAT THE NEW TASK ACTUALLY IS, with the cancel clause itself removed so the task's own objective reads as the work, not as "cancel X, ".
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

/** The current task. Owned by the session; there is no module-level state and no second place that tracks "what are we doing". */
class Task {
  constructor(objective) {
    this.objective = String(objective || '');
    this.startedAt = new Date().toISOString();
    this.steers = [];        // [{ text, at }]
    this.turnIds = [];
    /** A STABLE HANDLE FOR THIS TASK, so evidence, receipts and a handover packet can all name the same thing across a model switch and a restart. */
    this.id = `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    /** See STATE. The task's own lifecycle, independent of any model. */
    this.state = STATE.ACTIVE;
    /** WHO IS CARRYING IT, AND WHAT THAT MODEL IS ABLE TO DO. */
    this.executor = null;    // { provider, model, state, since, why }
    /** EVERY EXECUTOR THIS TASK HAS HAD, oldest first. */
    this.handovers = [];     // [{ from, to, why, at }]
    /** FAILURES THIS TASK DID NOT CAUSE AND MAY NOT REPAIR — §43. */
    this.foreignFailures = [];  // [{ what, why, at }]
    /** HOW MANY TIMES SOMEBODY WENT OUTSIDE ABOUT THIS TASK. */
    this.externalConsults = 0;
    /** WHERE THE WORK BEGAN, AND WHETHER THE CODING AGENT HAS CARRIED IT — the session journey (journey.js). */
    this.origin = null;      // 'chat' | 'ide' | 'terminal' | 'bot' | null
    this.agentic = false;
  }

  /** One more outside opinion on this task. See externalrequest.consultedOn. */
  consultedExternally() { this.externalConsults += 1; return this; }

  /** True while work on this task is still legitimate, whoever is (or is not) carrying it. */
  get live() { return LIVE_STATES.has(this.state); }

  /** NOBODY CAN WORK THIS RIGHT NOW — but it is not finished. */
  get stranded() { return this.live && Boolean(this.executor) && this.executor.state !== EXECUTOR.ACTIVE; }

  /** A MODEL TAKES THE TASK UP. */
  assignExecutor({ provider = '', model = '', why = '' } = {}, at = new Date().toISOString()) {
    const prev = this.executor;
    if (prev) {
      // A CLEAN HANDOVER IF NOBODY SAID OTHERWISE.
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

  /** THE PROVIDER WILL NOT SERVE THIS MODEL. */
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

  /** SOMETHING IS BROKEN THAT THIS TASK DID NOT BREAK — record, do not adopt. */
  noteForeignFailure(what, why = '', at = new Date().toISOString()) {
    const key = String(what || '').slice(0, 200);
    if (!key) return this;
    if (this.foreignFailures.some((f) => f.what === key)) return this;
    this.foreignFailures.push({ what: key, why: String(why || '').slice(0, 200), at });
    if (this.foreignFailures.length > MAX_FOREIGN) this.foreignFailures.shift();
    return this;
  }

  /** THE TASK REACHED A TERMINAL STATE. */
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

  /** THIS IS AN ALLOWLIST, AND THAT HAS BITTEN ONCE ALREADY. */
  toJSON() {
    return {
      objective: this.objective, startedAt: this.startedAt,
      steers: this.steers, turnIds: this.turnIds,
      externalConsults: this.externalConsults,
      id: this.id, state: this.state,
      executor: this.executor, handovers: this.handovers,
      foreignFailures: this.foreignFailures,
      origin: this.origin, agentic: this.agentic,
    };
  }

  static from(data) {
    if (!data || typeof data !== 'object') return null;
    const t = new Task(data.objective);
    t.startedAt = data.startedAt || t.startedAt;
    // THE ARRAYS ARE COPIED, NEVER ADOPTED
    t.steers = Array.isArray(data.steers) ? data.steers.slice() : [];
    t.turnIds = Array.isArray(data.turnIds) ? data.turnIds.slice() : [];
    t.externalConsults = Number(data.externalConsults) || 0;
    // A RECORD WRITTEN BEFORE THESE FIELDS EXISTED IS STILL A TASK
    t.id = typeof data.id === 'string' && data.id ? data.id : t.id;
    t.state = Object.values(STATE).includes(data.state) ? data.state : STATE.ACTIVE;
    // AN EXECUTOR IS RESTORED AS IT WAS, NOT AS ACTIVE.
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
    t.origin = typeof data.origin === 'string' ? data.origin : null;
    t.agentic = data.agentic === true;
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
