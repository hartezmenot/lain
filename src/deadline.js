'use strict';

/** BOUNDED WAITS WITHOUT LEFTOVER TIMERS (Phase 8.2). */
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
