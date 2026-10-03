'use strict';

/** WATCHING SOMETHING RUN WITHOUT STARING AT IT. */

const jobs = require('./jobs');

/** THE STATES OF AN OBSERVATION. */
const STATE = Object.freeze({
  PREPARING: 'PREPARING',
  OBSERVING: 'OBSERVING',
  STOP_REQUESTED: 'STOP_REQUESTED',
  STOPPED: 'STOPPED',
  ANALYZING: 'ANALYZING',
  WAITING_FOR_USER: 'WAITING_FOR_USER',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

/** Observation is over and the evidence will not grow. */
const FINAL = new Set([STATE.COMPLETED, STATE.FAILED]);

/** WHERE A PIECE OF EVIDENCE CAME FROM. */
const SOURCE = Object.freeze({
  LOG: 'LOG',
  VISUAL: 'VISUAL',
  MEMORY: 'MEMORY',
  PROCESS: 'PROCESS',
  USER: 'USER',
});

/** How many captures one observation may take, however many rules fire. */
const MAX_CAPTURES = 24;

/** And how many events are kept. Enough to reconstruct a run; never unbounded. */
const MAX_EVENTS = 500;

/** A capture may not fire more often than this for the SAME rule. */
const RULE_COOLDOWN_MS = 3000;

/** ONE THING WORTH NOTICING, as the user described it. */
function rule({ name, pattern, capture = false, why = '' }) {
  return {
    name: String(name || 'event'),
    pattern: pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i'),
    capture: Boolean(capture),
    why: String(why || ''),
    fired: 0,
    lastAt: 0,
  };
}

class Observation {
  /** expectation what the user says SHOULD happen — recorded, never enforced rules what is worth noticing */
  constructor({ id = 'obs', command = '', expectation = [], rules = [] } = {}) {
    this.id = id;
    this.command = String(command);
    this.state = STATE.PREPARING;
    /** WHAT WAS SUPPOSED TO HAPPEN, in the user's words, recorded BEFORE the run. */
    this.expectation = (Array.isArray(expectation) ? expectation : [expectation])
      .filter(Boolean).map((s) => String(s));
    this.rules = rules.map(rule);
    this.events = [];
    this.captures = [];
    this.startedAt = 0;
    this.stoppedAt = 0;
    this.stopReason = '';
    /** Lines seen, so "quiet" can be told from "nothing ran". */
    this.lines = 0;
    this.job = null;
  }

  get running() { return this.state === STATE.OBSERVING || this.state === STATE.STOP_REQUESTED; }

  /** Elapsed observation time, or 0 before it starts. */
  get elapsedMs() {
    if (!this.startedAt) return 0;
    return (this.stoppedAt || Date.now()) - this.startedAt;
  }

  /** Record something that happened. */
  note(source, kind, detail = '', extra = {}) {
    if (this.events.length >= MAX_EVENTS) return null;
    const ev = {
      at: Date.now(),
      sinceStartMs: this.startedAt ? Date.now() - this.startedAt : 0,
      source,
      kind: String(kind),
      detail: String(detail || '').slice(0, 400),
      ...extra,
    };
    this.events.push(ev);
    return ev;
  }

  /** Every event from one source, in order. Correlation reads these. */
  from(source) { return this.events.filter((e) => e.source === source); }

  /** FEED ONE LINE OF THE RUN'S OUTPUT. */
  feed(line) {
    const text = String(line == null ? '' : line);
    if (!text.trim()) return [];
    this.lines += 1;
    const wants = [];
    const now = Date.now();
    for (const r of this.rules) {
      if (!r.pattern.test(text)) continue;
      r.fired += 1;
      this.note(SOURCE.LOG, r.name, text.trim(), { rule: r.name });
      if (!r.capture) continue;
      // COOLDOWN PER RULE, not globally: two different rules firing on the same line are two different things worth seeing, and suppressing the second…
      if (now - r.lastAt < RULE_COOLDOWN_MS) continue;
      if (this.captures.length >= MAX_CAPTURES) continue;
      r.lastAt = now;
      wants.push(r);
    }
    return wants;
  }

  /** Record a capture that was actually taken. Path or refusal, never a guess. */
  addCapture({ rule: ruleName, kind, path = '', text = '', why = '', ok = true }) {
    const c = {
      at: Date.now(),
      sinceStartMs: this.startedAt ? Date.now() - this.startedAt : 0,
      rule: String(ruleName || ''),
      kind: String(kind || 'screenshot'),
      path: String(path || ''),
      text: String(text || '').slice(0, 2000),
      ok: Boolean(ok),
      why: String(why || ''),
    };
    this.captures.push(c);
    this.note(SOURCE.VISUAL, c.kind, ok ? (c.path || 'captured') : `NOT CAPTURED — ${c.why}`, { rule: c.rule, ok });
    return c;
  }

  /** A plain account of what happened, for the model and for the report. */
  summary() {
    const byKind = new Map();
    for (const e of this.events) byKind.set(e.kind, (byKind.get(e.kind) || 0) + 1);
    return {
      id: this.id,
      state: this.state,
      command: this.command,
      expectation: this.expectation,
      elapsedMs: this.elapsedMs,
      lines: this.lines,
      events: this.events.length,
      captures: this.captures.filter((c) => c.ok).length,
      capturesRefused: this.captures.filter((c) => !c.ok).length,
      stopReason: this.stopReason,
      kinds: [...byKind.entries()].map(([kind, n]) => ({ kind, n })),
    };
  }
}

/** THE OBSERVATIONS OF ONE SESSION. */
class Observatory {
  constructor() {
    this.current = null;
    this.past = [];
    this.seq = 0;
  }

  /** START WATCHING A COMMAND. */
  begin({ command = '', expectation = [], rules = [] } = {}) {
    if (this.current && this.current.running) {
      return { ok: false, why: `already watching ${this.current.id} — stop it first` };
    }
    this.seq += 1;
    const obs = new Observation({ id: `o${this.seq}`, command, expectation, rules });
    this.current = obs;
    return { ok: true, observation: obs };
  }

  /** The observation an id names, current or finished. */
  find(id) {
    if (this.current && this.current.id === id) return this.current;
    return this.past.find((o) => o.id === id) || null;
  }

  /** Move a finished observation out of the way, keeping its evidence. */
  retire(obs) {
    if (this.current === obs) this.current = null;
    if (!this.past.includes(obs)) this.past.push(obs);
    while (this.past.length > 5) this.past.shift();
    return obs;
  }
}

/** SUBSCRIBE AN OBSERVATION TO A RUNNING JOB. */
function attach(obs, job, onCapture) {
  obs.job = job;
  obs.state = STATE.OBSERVING;
  obs.startedAt = Date.now();
  obs.note(SOURCE.PROCESS, 'STARTED', obs.command);

  let pending = '';
  const consume = (chunk) => {
    pending += String(chunk == null ? '' : chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';           // an unterminated tail waits for more
    for (const line of lines) {
      const wants = obs.feed(line);
      for (const r of wants) {
        // NOT AWAITED, and that is the point: the bot's output must never wait for a screenshot.
        if (typeof onCapture === 'function') {
          Promise.resolve(onCapture(r, obs)).catch((e) => {
            obs.addCapture({ rule: r.name, kind: 'screenshot', ok: false, why: (e && e.message) || 'capture failed' });
          });
        }
      }
    }
  };

  if (typeof job.on === 'function') job.on('output', consume);
  return consume;
}

/** THE RUN IS OVER. Records why, and moves to the state where looking is allowed. */
function finish(obs, reason = 'stopped') {
  if (!obs) return null;
  obs.stoppedAt = Date.now();
  obs.stopReason = String(reason);
  obs.state = STATE.STOPPED;
  obs.note(SOURCE.PROCESS, 'STOPPED', reason);
  return obs;
}

module.exports = {
  Observation, Observatory, STATE, FINAL, SOURCE, rule, attach, finish,
  MAX_CAPTURES, MAX_EVENTS, RULE_COOLDOWN_MS, jobsState: jobs.STATE,
};
