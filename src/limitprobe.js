'use strict';

/**
 * CONTINUE ASKS THE PROVIDER (2026-10-03). A rate limit LAIN remembers — an account's stored limit (fabric), the
 * route breaker (availability.js) — is a memory of a 429, not the provider's word now; a usage reset on the
 * provider's own site never reaches it. When the person continues, every such memory on the route this turn would
 * use is dropped, so ONE real request tests it: an answer carries on, a fresh 429 records the limit again.
 * Never for LAIN's own automatic resumes (autocontinue.AUTOMATIC) — those wait for the clock.
 */

/** Drop the remembered limits for the session's route. Returns what was dropped (for the record). */
function forget(app, session) {
  const s = session || (app && app.session);
  if (!app || !s) return [];
  const out = [];
  try { for (const id of require('./fabric/policy').forgetLimits(app, s)) out.push(`account ${id}`); } catch { /* the refusal stands */ }
  try {
    const avail = app.availability;
    const pc = require('./provider').resolve(require('./sessionviews').turnCfg(app, s));
    const connId = pc.connectionId || pc.provider;
    if (avail && connId && !pc.unavailable) {
      const gate = avail.shouldAttemptFor(connId, pc.canonicalModel || pc.model || '');
      // A HOLD LAIN PUT THERE (a limit, an open breaker) — never one the person set (disabled, maintenance).
      if (!gate.allow && (gate.rateLimited || gate.status === 'UNAVAILABLE' || gate.status === 'DEGRADED')) { avail.retry(connId); out.push(`route ${connId}`); }
    }
  } catch { /* the gate re-learns from the next reply */ }
  return out;
}

/** Did the person ask for this turn (typed, Continue, a steer), rather than LAIN resuming on its own? */
function personAsked(from) { return !require('./autocontinue').AUTOMATIC.has(from || ''); }

module.exports = { forget, personAsked };
