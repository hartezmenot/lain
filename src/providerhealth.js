'use strict';

/**
 * THE SEAM BETWEEN THIS PROCESS'S PROVIDER HEALTH AND THE DURABLE COPY.
 *
 *   availability.js   what is true about a route, answered SYNCHRONOUSLY just before a socket opens; it also owns the
 *                     rules for which durable facts are still true after a restart (hydrate)
 *   routehealth.js    the durable copy, a small file every Noema process on this home reads (2026-10-02 — it used to
 *                     live in the Rust supervisor, which had to be running, or started, to keep a rate limit)
 *   THIS FILE         the wiring between the two
 *
 * PLAIN FUNCTIONS OVER `app`, never methods: an extraction that keeps a `this` becomes `undefined` in strict mode, in
 * whatever branch nothing routinely exercises — which for provider health is a real rate limit at four in the morning.
 */

const health = require('./routehealth');

/**
 * WHAT WE LEARN ABOUT A ROUTE, KEPT FOR THE NEXT PROCESS. availability.js learns provider health from requests that
 * were happening anyway; this records it so the next Noema does not have to buy the same fact again. A person's
 * decision (`/provider disable|maintenance`) is a SET, a `/provider retry` a CLEAR. Never throws (Availability._push
 * swallows whatever a sink does wrong).
 */
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

/**
 * WHICH DOORS WERE SHUT WHILE THIS PROCESS DID NOT EXIST. A local file read: no process is started or asked.
 * `adopt` is true exactly once, at the start of the process — after that the in-memory copy has seen this session's
 * own requests and is the fresher of the two.
 */
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
