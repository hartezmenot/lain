'use strict';

/** WHAT IS HAPPENING, AS NAMED FACTS — the contract a companion renders. */

/** THE VOCABULARY. Exactly the names in and nothing invented beside them — a companion written against this list is written against all of it, and a… */
const EVENT = Object.freeze({
  TASK_STARTED: 'task.started',
  TASK_PROGRESS: 'task.progress',
  MODEL_THINKING: 'model.thinking',
  MODEL_TOOL_CALL: 'model.tool_call',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  QUESTION_PRESENTED: 'question.presented',
  QUESTION_RESOLVED: 'question.resolved',
  JOB_STARTED: 'job.started',
  JOB_COMPLETED: 'job.completed',
  WAITING_FOR_USER: 'waiting_for_user',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',

  // THE HARNESS VOCABULARY
  TASK_CREATED: 'task.created',
  TASK_PAUSED: 'task.paused',
  TASK_RESUMED: 'task.resumed',
  TASK_CANCELLED: 'task.cancelled',
  TASK_STATE: 'task.state',

  AGENT_STARTED: 'agent.started',
  AGENT_COMPLETED: 'agent.completed',
  AGENT_FAILED: 'agent.failed',

  TOOL_FAILED: 'tool.failed',

  PROCESS_STARTED: 'process.started',
  PROCESS_STOPPED: 'process.stopped',
  PROCESS_FAILED: 'process.failed',
  PROCESS_HEALTH: 'process.health',

  BROWSER_STARTED: 'browser.started',
  BROWSER_OBSERVED: 'browser.observed',
  BROWSER_ERROR: 'browser.error',
  BROWSER_CLOSED: 'browser.closed',

  VERIFICATION_STARTED: 'verification.started',
  VERIFICATION_PASSED: 'verification.passed',
  VERIFICATION_FAILED: 'verification.failed',
  VERIFICATION_INCONCLUSIVE: 'verification.inconclusive',

  OBSERVATION_MADE: 'observation.made',
  ARTIFACT_CREATED: 'artifact.created',

  APPROVAL_REQUIRED: 'approval.required',
  APPROVAL_RESOLVED: 'approval.resolved',

  RECOVERY_STARTED: 'recovery.started',
  HOOK_RAN: 'hook.ran',

  // (Phase 8.3: the website chat sources and their webmodel.* events are removed.)
});

const NAMES = Object.freeze(Object.values(EVENT));
const KNOWN = new Set(NAMES);

/** How many events are kept for a companion that connects late. Bounded, like everything. */
const MAX_KEPT = 200;
/** No payload field is worth more than this to a window that is drawing it. */
const MAX_FIELD = 2000;

/** Trim one payload to what a companion can actually use. */
function trim(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') out[k] = v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 12).map((x) => String(x).slice(0, 200));
    else out[k] = String(v).slice(0, MAX_FIELD);
  }
  return out;
}

class EventBus {
  constructor() {
    this._handlers = [];
    this._kept = [];
    /** Emitted but never delivered, because a handler threw. Reported, not hidden. */
    this.dropped = 0;
  }

  /** Subscribe. Returns a function that unsubscribes — a companion that disconnects must be able to stop being called, or every reconnect leaks a handler… */
  on(fn) {
    if (typeof fn !== 'function') return () => {};
    this._handlers.push(fn);
    return () => {
      const at = this._handlers.indexOf(fn);
      if (at >= 0) this._handlers.splice(at, 1);
    };
  }

  /** State a fact. Unknown names are REFUSED rather than forwarded. */
  emit(name, payload = {}) {
    const type = String(name || '');
    if (!KNOWN.has(type)) return null;
    const ev = { type, at: Date.now(), ...trim(payload) };
    this._kept.push(ev);
    if (this._kept.length > MAX_KEPT) this._kept.splice(0, this._kept.length - MAX_KEPT);
    for (const fn of [...this._handlers]) {
      // A COMPANION WINDOW IS A CONVENIENCE; THE WORK IS NOT. A subscriber that
      // throws is dropped from the count and the turn carries on.
      try { fn(ev); } catch { this.dropped++; }
    }
    return ev;
  }

  /** What has happened, oldest first — for a companion that connected late. */
  recent(limit = MAX_KEPT) {
    const n = Math.max(0, Math.min(Number(limit) || MAX_KEPT, MAX_KEPT));
    return this._kept.slice(-n);
  }

  /** The most recent event of a kind, or null. */
  last(name) {
    for (let i = this._kept.length - 1; i >= 0; i--) {
      if (this._kept[i].type === name) return this._kept[i];
    }
    return null;
  }

  clear() { this._kept.length = 0; }
}

/** A BUS THAT IS ALWAYS THERE, even when the app is not. */
const NULL_BUS = Object.freeze({
  emit() { return null; },
  on() { return () => {}; },
  recent() { return []; },
  last() { return null; },
  clear() {},
});

function busOf(app) {
  return (app && app.events) || NULL_BUS;
}

module.exports = { EVENT, NAMES, KNOWN, EventBus, MAX_KEPT, MAX_FIELD, trim, busOf, NULL_BUS };
