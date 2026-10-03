'use strict';

/** THE ONE OWNER OF CONTEXT TRANSITIONS. */

const crypto = require('crypto');
const contextbudget = require('./contextbudget');
const providerLimits = require('./providerlimits');

const STATE = Object.freeze({
  NORMAL: 'NORMAL',
  NEAR_LIMIT: 'NEAR_LIMIT',
  COMPACTION_REQUIRED: 'COMPACTION_REQUIRED',
  COMPACTING: 'COMPACTING',
  COMPACTION_VALIDATED: 'COMPACTION_VALIDATED',
  COMPACTION_FAILED: 'COMPACTION_FAILED',
  CONTEXT_UNSATISFIABLE: 'CONTEXT_UNSATISFIABLE',
});

/** One bounded lifecycle per epoch. A provider refusal is new evidence, not a new epoch. */
const MAX_ATTEMPTS_PER_EPOCH = 2;

/** When the conversation passes this fraction of the budget it is NEAR_LIMIT — watched, not compacted. */
const NEAR_RATIO = 0.8;

/** The event timeline is a diagnostic, not a log. Bounded, like everything. */
const MAX_TIMELINE = 64;

/** THE CONTEXT LIFECYCLE, AS NAMED EVENTS. */
const EVENT = Object.freeze({
  CONTEXT_PRESSURE: 'CONTEXT_PRESSURE',
  COMPACTION_REQUESTED: 'COMPACTION_REQUESTED',
  COMPACTION_STARTED: 'COMPACTION_STARTED',
  COMPACTION_COMPLETED: 'COMPACTION_COMPLETED',
  COMPACTION_FAILED: 'COMPACTION_FAILED',
  CONTEXT_REBUILT: 'CONTEXT_REBUILT',
  CONTEXT_VALIDATED: 'CONTEXT_VALIDATED',
  CONTEXT_UNSATISFIABLE: 'CONTEXT_UNSATISFIABLE',
  CONTEXT_CLEARED: 'CONTEXT_CLEARED',
});

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function profileFor(pc) {
  const provider = String((pc && pc.provider) || '');
  const model = String((pc && pc.model) || '');
  const connectionId = String((pc && pc.connectionId) || provider || '');
  return {
    provider,
    model,
    connectionId,
    contextWindow: Number(pc && pc.ctx) || 0,
    maxOutput: Number(pc && pc.maxTokens) || 0,
    profileHash: fingerprint({ provider, model, connectionId, ctx: pc && pc.ctx, maxTokens: pc && pc.maxTokens }),
  };
}

class ContextAuthority {
  constructor(session) {
    if (!session || !Array.isArray(session.messages)) throw new Error('ContextAuthority requires a session');
    this.session = session;
    this.epoch = 0;
    this.state = STATE.NORMAL;
    this.attempts = 0;
    this.lastProfileHash = '';
    this.lastProfile = null;
    this.lastProjectionHash = '';
    this.lastCompactionId = '';
    this.compactionId = '';
    this.unsatisfiable = null;
    this.reason = 'constructed';
    this.timeline = [];
    this._project = null;
    this.touch();
  }

  /** Canonical mutations start a new epoch and invalidate the model projection. */
  touch({ reason = 'canonical-state-changed' } = {}) {
    this.epoch += 1;
    this.state = STATE.NORMAL;
    this.attempts = 0;
    this.reason = reason;
    // A NEW EPOCH RETIRES ANY OPERATION IN FLIGHT.
    this.compactionId = '';
    this.unsatisfiable = null;
    this._project = null;
    return this;
  }

  get active() {
    return this.state === STATE.COMPACTION_REQUIRED || this.state === STATE.COMPACTING;
  }

  profile(pc) {
    const next = profileFor(pc);
    if (this.lastProfileHash && next.profileHash !== this.lastProfileHash) {
      this.touch({ reason: `model-profile-changed:${next.provider}:${next.model}` });
    }
    this.lastProfileHash = next.profileHash;
    this.lastProfile = next;
    return next;
  }

  /** MEASURED PRESSURE, WITHOUT TRANSITIONING. */
  pressure(pc, cfg = {}) {
    const budget = contextbudget.charsFor(pc, cfg);
    const chars = this.session.contextChars();
    const messages = this.session.messages.length;
    const limits = providerLimits.limitsFor(pc, cfg);
    const cap = Number(limits.messages) || 0;
    const allowedMessages = cap > 0 ? Math.max(1, Math.floor(cap * providerLimits.HEADROOM)) : 0;
    const overChars = budget > 0 && chars > budget;
    const overMessages = allowedMessages > 0 && messages > allowedMessages;
    return {
      budget, chars, messages, cap, allowedMessages,
      over: overChars || overMessages,
      overChars, overMessages,
      near: !overChars && !overMessages && budget > 0 && chars > budget * NEAR_RATIO,
      why: overChars
        ? `context ${chars} chars over the ${budget}-char budget`
        : (overMessages ? `${messages} messages over this provider's ${allowedMessages}-message allowance` : ''),
    };
  }

  /** STATE A FACT ON THE TIMELINE. */
  note(type, fields = {}) {
    const ev = {
      type,
      at: new Date().toISOString(),
      sessionId: (this.session && this.session.id) || '',
      epoch: this.epoch,
      compactionId: this.compactionId || this.lastCompactionId || '',
      provider: this.lastProfile ? this.lastProfile.provider : '',
      model: this.lastProfile ? this.lastProfile.model : '',
      ...fields,
    };
    this.timeline.push(ev);
    if (this.timeline.length > MAX_TIMELINE) this.timeline.splice(0, this.timeline.length - MAX_TIMELINE);
    return ev;
  }

  /** THE EVIDENCE AN UNSATISFIABLE EPOCH CARRIES. */
  evidence(pc, cfg = {}, pressure) {
    const profile = profileFor(pc);
    return {
      provider: profile.provider,
      model: profile.model,
      contextWindow: profile.contextWindow,
      maxOutput: profile.maxOutput,
      budgetChars: pressure ? pressure.budget : contextbudget.charsFor(pc, cfg),
      contextChars: this.session.contextChars(),
      messages: this.session.messages.length,
      messageCap: pressure ? pressure.cap : providerLimits.limitsFor(pc, cfg).messages,
      attempts: this.attempts,
      epoch: this.epoch,
      why: pressure ? pressure.why : '',
    };
  }

  beginCompaction({ reason = 'context-pressure' } = {}) {
    // COMPACTING + pressure REMAINS COMPACTING: the second report is a no-op.
    if (this.active) return null;
    // A FAILED or UNSATISFIABLE epoch does not re-arm itself. Only `touch` —
    // genuinely new canonical state — starts a fresh lifecycle.
    if (this.state === STATE.COMPACTION_FAILED || this.state === STATE.CONTEXT_UNSATISFIABLE) return null;
    if (this.attempts >= MAX_ATTEMPTS_PER_EPOCH) {
      this.state = STATE.CONTEXT_UNSATISFIABLE;
      return null;
    }
    // The edge fires: pressure was reported and this call is taking the transition.
    this.state = STATE.COMPACTION_REQUIRED;
    this.attempts += 1;
    this.reason = reason;
    this.compactionId = `${this.epoch}-${this.attempts}-${Date.now().toString(36)}`;
    this.state = STATE.COMPACTING;
    this.note(EVENT.COMPACTION_REQUESTED, { reason, attempt: this.attempts });
    return this.compactionId;
  }

  finishCompaction(id) {
    // STALE BY ID ALONE. An id from another epoch was cleared by `touch`; an id from another operation was replaced by `beginCompaction`. Either way it…
    if (!id || id !== this.compactionId) {
      if (id) return { stale: true, ignored: true, result: null };
      return { stale: false, ignored: true, result: null };
    }
    const valid = Boolean(this.session && Array.isArray(this.session.messages));
    this.state = valid ? STATE.COMPACTION_VALIDATED : STATE.COMPACTION_FAILED;
    this.lastCompactionId = id;
    this.compactionId = '';
    this._project = null;
    this.reason = valid ? 'compaction-validated' : 'compaction-invalid';
    this.note(valid ? EVENT.CONTEXT_VALIDATED : EVENT.COMPACTION_FAILED, { compactionId: id });
    return { stale: false, ignored: false, result: valid ? this : null };
  }

  normalize() {
    if (this.state === STATE.COMPACTION_VALIDATED) {
      this.state = STATE.NORMAL;
      return true;
    }
    return false;
  }

  /** THE ONE TRANSITION INTO COMPACTION. */
  compact(pc, cfg = {}, { reason = 'context-pressure', force = false } = {}) {
    const profile = this.profile(pc);
    const pressure = this.pressure(pc, cfg);

    // EDGE-TRIGGERED, NOT LEVEL-TRIGGERED A check that finds no pressure consumes nothing — no attempt, no compaction — so a caller that asks on every step…
    if (!pressure.over && !force) {
      if (this.state === STATE.NORMAL || this.state === STATE.NEAR_LIMIT || this.state === STATE.COMPACTION_VALIDATED) {
        this.state = pressure.near ? STATE.NEAR_LIMIT : STATE.NORMAL;
      }
      return {
        attempted: false, stale: false, ignored: true,
        reason: pressure.near ? 'near-limit' : 'under-budget',
        id: null, pressure, profile,
        result: {
          compacted: false,
          before: pressure.chars, after: pressure.chars, elided: 0, folded: 0,
          beforeMessages: pressure.messages, afterMessages: pressure.messages,
        },
      };
    }

    if (pressure.over) this.note(EVENT.CONTEXT_PRESSURE, { reason, ...pressure });
    // NOTE: no state is assigned here.

    const id = this.beginCompaction({ reason: pressure.why || reason });
    if (!id) {
      // Refused: already COMPACTING, already FAILED, or the epoch's budget is spent.
      if (this.state === STATE.CONTEXT_UNSATISFIABLE && !this.unsatisfiable) {
        this.unsatisfiable = this.evidence(pc, cfg, pressure);
        this.note(EVENT.CONTEXT_UNSATISFIABLE, this.unsatisfiable);
      }
      return {
        attempted: false, stale: false, ignored: true,
        reason: this.reason, id: null, pressure, profile,
        busy: this.active,
        failed: this.state === STATE.COMPACTION_FAILED,
        unsatisfiable: this.unsatisfiable,
      };
    }
    this.note(EVENT.COMPACTION_STARTED, { compactionId: id, attempt: this.attempts, reason: pressure.why || reason });

    const room = contextbudget.charsFor(pc, cfg);
    const limits = providerLimits.limitsFor(pc, cfg);
    const target = providerLimits.targetFor(limits);

    let result;
    try {
      result = this.session.compact({ budgetChars: room, maxMessages: target });
    } catch (e) {
      // A compaction that threw leaves the machine FAILED for the rest of this epoch.
      this.state = STATE.COMPACTION_FAILED;
      this.compactionId = '';
      this.reason = 'compaction-threw';
      this.note(EVENT.COMPACTION_FAILED, { compactionId: id, error: String((e && e.message) || e) });
      return {
        attempted: true, stale: false, ignored: false, failed: true,
        reason: 'compaction-threw', error: String((e && e.message) || e),
        id, pressure, profile,
      };
    }

    // VALIDATED, NOT TRUSTED `compact() returned` is not proof.
    const before = Number(result && result.before) || 0;
    const after = Number(result && result.after) || 0;
    const beforeMessages = Number(result && result.beforeMessages) || 0;
    const afterMessages = Number(result && result.afterMessages) || 0;
    const grew = after > before && afterMessages >= beforeMessages;
    const valid = Array.isArray(this.session && this.session.messages) && !grew;
    this.finishCompaction(id);
    if (!valid) {
      this.state = STATE.COMPACTION_FAILED;
      this.reason = 'compaction-invalid';
      this.note(EVENT.COMPACTION_FAILED, { compactionId: id, reason: 'compaction-invalid', before, after });
      return {
        attempted: true, stale: false, ignored: false, failed: true,
        reason: 'compaction-invalid', result, id, pressure, profile,
      };
    }
    this.note(EVENT.COMPACTION_COMPLETED, {
      compactionId: id, before, after,
      elided: (result && result.elided) || 0, folded: (result && result.folded) || 0,
      beforeMessages: (result && result.beforeMessages) || 0,
      afterMessages: (result && result.afterMessages) || 0,
    });
    try { require('./capgate').compacted(this.session, { reason, before, after }); } catch { /* the Compact hook is optional */ }
    // STILL OVER, ACROSS EPOCHS A compaction that ends over budget means the NEXT step compacts again and stubs whatever was just read — the reread loop…
    const afterPressure = this.pressure(pc, cfg);
    this.overStreak = afterPressure.over ? (this.overStreak || 0) + 1 : 0;
    const task = this.session.task;
    const plan = this.session.plan;
    const step = plan && Array.isArray(plan.steps) ? plan.steps.findIndex((s) => s && !require('./plan').stepDone(s)) : -1;
    this.note(EVENT.CONTEXT_REBUILT, {
      compactionId: id, after, messages: this.session.messages.length,
      overAfter: afterPressure.over,
      floorChars: afterPressure.over ? afterPressure.chars : 0,
      overStreak: this.overStreak,
      taskId: (task && task.id) || '',
      planStep: step >= 0 ? step + 1 : null,
    });
    this.normalize();

    // STILL OVER? DIAGNOSE, DO NOT RECURSE Compaction ran and the context is still over budget. The causes are named in the evidence, and the response is…
    if (afterPressure.over) {
      const productive = Boolean(result && result.compacted);
      if (!productive || this.attempts >= MAX_ATTEMPTS_PER_EPOCH) {
        this.state = STATE.CONTEXT_UNSATISFIABLE;
        const unsatisfiable = this.evidence(pc, cfg, afterPressure);
        this.unsatisfiable = unsatisfiable;
        this.note(EVENT.CONTEXT_UNSATISFIABLE, unsatisfiable);
        return { attempted: true, stale: false, ignored: false, result, reason, id, pressure, profile, unsatisfiable };
      }
    }
    return { attempted: true, stale: false, ignored: false, result, reason, id, pressure, profile };
  }

  /** THE MODEL CONTEXT PROJECTION, cached per (epoch, profile, shape). */
  project(pc, build, { stable = '', live = '', tools = 0 } = {}) {
    const profile = this.profile(pc);
    const projectionHash = fingerprint({
      epoch: this.epoch,
      profile: profile.profileHash,
      stable,
      live,
      tools,
      messages: this.session ? this.session.messages.length : 0,
      chars: this.session ? this.session.contextChars() : 0,
    });
    if (this._project && this.lastProjectionHash === projectionHash) return this._project;
    this._project = { wire: build(), profile, projectionHash, builtAt: Date.now() };
    this.lastProjectionHash = projectionHash;
    return this._project;
  }

  /** EXPLICIT CLEAR — a different lifecycle operation, never a compaction. */
  clearContext() {
    const removed = this.session ? this.session.messages.length : 0;
    const chars = this.session ? this.session.contextChars() : 0;
    // Noted BEFORE the epoch turns, so an in-flight compaction id — if any —
    // is on the record as the operation the clear retired.
    this.note(EVENT.CONTEXT_CLEARED, { removed, chars });
    if (this.session) this.session.messages = [];
    // THE BODIES WENT WITH THE MESSAGES. The ledger keeps what was read, but it
    // must stop claiming the model still holds it — see toolstep.bodyOnWire.
    const ev = this.session && this.session.evidence;
    if (ev && ev.byPath) for (const e of ev.byPath.values()) e.bodyPresent = false;
    this.touch({ reason: 'explicit-context-clear' });
    return { removed, chars };
  }
}

module.exports = {
  ContextAuthority, profileFor, STATE, EVENT,
  MAX_ATTEMPTS_PER_EPOCH, NEAR_RATIO, MAX_TIMELINE,
};
