'use strict';

/**
 * ONE REGISTRY FOR EVERY PROCESS (Phase 8.3). The Harness and a CLI can be two
 * LAIN processes. Accounts (accounts.json), the fabric (fabric.json) and the
 * secret store are files every process re-reads; API sources and defaults live
 * in config.json, which a process loads once. So when ANOTHER process changed
 * config.json — the Harness added an API, a CLI removed one — what it changed
 * is taken here (config.mergeExternal: three-way, per connection), and the
 * catalogs that depend on it are rebuilt. Checked at most every 500 ms (one stat); this process's own writes
 * never count as a change (config.js remembers them).
 */

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
