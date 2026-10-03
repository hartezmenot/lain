'use strict';

/** THE SEAM BETWEEN THIS PROCESS'S PROVIDER HEALTH AND THE DURABLE COPY. */

const health = require('./routehealth');

/** WHAT WE LEARN ABOUT A ROUTE, KEPT FOR THE NEXT PROCESS. */
function installSink(app) {
  if (!app || !app.availability) return;
  app.availability.sink = (id, ev) => {
    if (ev && ev.decision === 'SET') return health.set(id, ev.status, ev.reason);
    if (ev && ev.decision === 'CLEAR') return health.clear(id);
    let pc = {};
    try { pc = require('./provider').resolve({ ...app.cfg, _evidence: app.connectionEvidence }); } catch { pc = {}; }
    return health.note({
      connectionId: id,
      ok: Boolean(ev && ev.ok),
      kind: (ev && ev.kind) || '',
      reason: (ev && ev.reason) || '',
      // NAMED FOR THE ROW'S SAKE: `/provider status` can say which provider a bare connection id belongs to after a
      // restart, when nothing else in this process has met it yet.
      provider: pc.provider || '',
      model: (app.cfg && app.cfg.model) || '',
      resetAt: Number(ev && ev.resetAt) || 0,
      failureThreshold: app.availability.failureThreshold,
    });
  };
}

/** WHICH DOORS WERE SHUT WHILE THIS PROCESS DID NOT EXIST. */
function refresh(app, { adopt = false } = {}) {
  if (!app) return undefined;
  let rows = [];
  try { rows = health.list(); } catch { rows = []; }
  app._supervisedProviders = rows;
  // Adopted silently: a limit from an earlier process is diagnostics, never a primary-UI warning (availability.hydrate).
  if (adopt && app.availability) { try { app.availability.hydrate(rows); } catch { /* health is not a dependency of a turn */ } }
  return Promise.resolve();
}

/** IS THIS ROUTE SHUT? A rate limit with a stated future reset, learned by any process on this home. */
function routeShut(connectionId, now = Date.now()) { return health.routeShut(connectionId, now); }

module.exports = { installSink, refresh, routeShut };
