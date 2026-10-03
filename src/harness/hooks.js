'use strict';

/** LIFECYCLE HOOKS — and the two rules that stop them becoming a hidden program. */

const POINT = Object.freeze({
  TASK_CREATED: 'task.created',
  TASK_STARTED: 'task.started',
  BEFORE_EXECUTION: 'before.execution',
  AFTER_EXECUTION: 'after.execution',
  BEFORE_VERIFICATION: 'before.verification',
  AFTER_VERIFICATION: 'after.verification',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
});

const POINTS = Object.freeze(Object.values(POINT));
const KNOWN = new Set(POINTS);

/** A hook that takes longer than this is REPORTED as slow. It is not killed. */
const SLOW_MS = 2000;

class Hooks {
  constructor() {
    this._at = new Map();
    /** Hooks that threw, by name. Reported on `/harness doctor`, never hidden. */
    this.failures = [];
  }

  /** Register. Returns an unregister function. */
  on(point, name, fn) {
    const p = String(point);
    if (!KNOWN.has(p)) {
      throw new Error(`unknown hook point "${p}" — the points are ${POINTS.join(', ')}`);
    }
    if (typeof fn !== 'function') return () => {};
    const entry = { name: String(name || 'anonymous').slice(0, 60), fn };
    if (!this._at.has(p)) this._at.set(p, []);
    this._at.get(p).push(entry);
    return () => {
      const list = this._at.get(p) || [];
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    };
  }

  names(point) { return (this._at.get(String(point)) || []).map((e) => e.name); }

  count() {
    let n = 0;
    for (const list of this._at.values()) n += list.length;
    return n;
  }

  /** Fire one point. */
  fire(point, snapshot, report = null) {
    const list = this._at.get(String(point)) || [];
    for (const entry of list) {
      const began = Date.now();
      let ok = true;
      let error = '';
      try {
        entry.fn(snapshot);
      } catch (e) {
        ok = false;
        error = String((e && e.message) || e).slice(0, 200);
        this.failures.push({ name: entry.name, point: String(point), error, at: began });
        if (this.failures.length > 50) this.failures.shift();
      }
      const ms = Date.now() - began;
      if (typeof report === 'function') {
        try { report({ name: entry.name, point: String(point), ms, ok, error, slow: ms > SLOW_MS }); } catch { /* a reporter that fails must not fail the hook */ }
      }
    }
  }
}

module.exports = { Hooks, POINT, POINTS, SLOW_MS };
