'use strict';

/** WHEN THE PROJECT LAST CHANGED — one process-wide timestamp, set by the mutation lifecycle after a write lands (mutation.js APPLY). */

let at = 0;

module.exports = {
  mark() { at = Date.now(); },
  /** Has a project write landed since `t` (ms)? */
  since(t) { return at > 0 && at > (Number(t) || 0); },
};
