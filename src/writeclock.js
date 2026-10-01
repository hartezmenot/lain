'use strict';

/**
 * WHEN THE PROJECT LAST CHANGED — one process-wide timestamp, set by the mutation lifecycle after a write lands
 * (mutation.js APPLY). An observation of a page that was loaded BEFORE it is an observation of the old project: the
 * browser probe reloads instead of measuring it (harness/browserharness.js). Found by a real GLM run (2026-10-01):
 * "move the button 6px" measured y=116 before and after the change, because the probe was already on that URL.
 */

let at = 0;

module.exports = {
  mark() { at = Date.now(); },
  /** Has a project write landed since `t` (ms)? */
  since(t) { return at > 0 && at > (Number(t) || 0); },
};
