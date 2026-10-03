'use strict';

/** ONE REGISTRY FOR EVERY PROCESS (Phase 8.3). */

const CHECK_MS = 500;
let lastCheck = 0;

function sync(app, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastCheck < CHECK_MS) return false;
  lastCheck = now;
  const r = (app && app._sibling) || app;
  if (!r || !r.cfg) return false;
  const config = require('../config');
  if (!config.changedOnDisk()) return false;
  // THREE-WAY (config.mergeExternal): what another process changed is taken; what this one changed stands.
  const taken = config.mergeExternal(r.cfg);
  if (!taken.length) return false;
  try { require('../appcatalog').invalidate(); } catch { /* not loaded */ }
  r._acctMemo = null; r._fabricMemo = null; r._connMemo = null;
  return true;
}

module.exports = { sync };
