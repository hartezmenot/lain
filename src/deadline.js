'use strict';

/**
 * BOUNDED WAITS WITHOUT LEFTOVER TIMERS (Phase 8.2).
 *
 *   await deadline.race(work, 5000)                           → work's value, or undefined after 5 s
 *   await deadline.race(work, 30000, () => ({ ok: false }))   → work's value, or the fallback
 *   await deadline.race(work, 30000, () => { throw err; })    → work's value, or the throw
 *
 * `Promise.race([work, new Promise((r) => setTimeout(r, ms))])` was written a
 * dozen times, and every copy left its timer armed for the full `ms` after the
 * work had finished: under the Preview's stream (a frame, a hover every ~70 ms)
 * that was hundreds of live timers each holding its request, and a process
 * that could not exit until the last one fired. Here the timer is cleared the
 * moment the work settles. (It is NOT unref'd: while the work is pending the
 * deadline must still be able to fire — an unref'd one let a process with
 * nothing else to wait on exit before its bound, which is a different program.)
 */
function race(work, ms, onTimeout = null) {
  let timer = null;
  const bound = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try { resolve(onTimeout ? onTimeout() : undefined); } catch (e) { reject(e); }
    }, Math.max(0, Number(ms) || 0));
  });
  return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

module.exports = { race };
