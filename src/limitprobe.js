'use strict';

/**
 * CONTINUE ASKS THE PROVIDER (2026-10-03). A rate limit LAIN remembers — an account's stored limit (fabric), the
 * route breaker (availability.js) — is a memory of a 429, not the provider's word now; a usage reset on the
 * provider's own site never reaches it. When the person continues, every such memory on the route this turn would
 * use is dropped, so ONE real request tests it: an answer carries on, a fresh 429 records the limit again. A breaker an
 * outage opened (refused, unreachable) is not a limit and stays open until /provider retry (2026-10-07).
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
      // A HOLD A 429 PUT THERE (a limit, a breaker the limit opened) — never one the person set (disabled, maintenance), and never an
      // outage's breaker: a dead route re-tested on every typed line is the retry storm the breaker exists to stop (/provider retry reopens it).
      const limit = gate.rateLimited || avail.getFor(connId, pc.canonicalModel || pc.model || '').rateLimited;
      if (!gate.allow && limit && (gate.rateLimited || gate.status === 'UNAVAILABLE' || gate.status === 'DEGRADED')) { avail.retry(connId); out.push(`route ${connId}`); }
    }
  } catch { /* the gate re-learns from the next reply */ }
  return out;
}

/** Did the person ask for this turn (typed, Continue, a steer), rather than LAIN resuming on its own? */
function personAsked(from) { return !require('./autocontinue').AUTOMATIC.has(from || ''); }

module.exports = { forget, personAsked };
