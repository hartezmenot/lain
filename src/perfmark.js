'use strict';

/**
 * WHERE THE MILLISECONDS GO between Enter and the provider, and between the provider and the screen.
 *
 * In-memory and always on (a `performance.now()` and a Map write per mark): `reset()` at submit, `mark(name)` keeps
 * the FIRST time a point was reached in this turn, `add(name, ms)` sums a cost that recurs (prompt assembly per
 * step, a tool's own run time). `/perf` and bench/latency read `read()`. Never throws, never decides anything.
 */

const { performance } = require('perf_hooks');

let t0 = performance.now();
const marks = new Map();
const sums = new Map();

function reset() { t0 = performance.now(); marks.clear(); sums.clear(); }

function mark(name) {
  if (!marks.has(name)) marks.set(name, performance.now() - t0);
}

function add(name, ms) {
  if (Number.isFinite(ms)) sums.set(name, (sums.get(name) || 0) + ms);
}

/** Time a synchronous or async section into `add(name)`. */
function time(name, fn) {
  const s = performance.now();
  let out;
  try { out = fn(); } catch (e) { add(name, performance.now() - s); throw e; }
  if (out && typeof out.then === 'function') return out.finally(() => add(name, performance.now() - s));
  add(name, performance.now() - s);
  return out;
}

function read() {
  const o = {};
  for (const [k, v] of marks) o[`@${k}`] = +v.toFixed(2);
  for (const [k, v] of sums) o[`Σ${k}`] = +v.toFixed(2);
  return o;
}

module.exports = { reset, mark, add, time, read };
