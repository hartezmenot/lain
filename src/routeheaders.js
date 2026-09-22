'use strict';

/**
 * WHAT A ROUTE REQUIRES OF ITS CLIENT, beyond the key — part of the provider
 * adapter (provider.js), split out at the size guard.
 *
 * OpenCode (Zen and Go) asks a third-party coding agent to name itself in its
 * user agent and to send a STABLE per-conversation id in `x-opencode-session`
 * (opencode.ai/docs/go). Go refuses a request without it: 400 MissingSessionID,
 * measured 2026-09-23; with it, the request is routed and the account's own
 * state answers. Transport, so it lives in the adapter — never in the subagent
 * or turn layers, and never as a provider-specific subagent system.
 */
function routeHeaders(pc, opts = {}) {
  let host = '';
  try { host = new URL(String((pc && pc.baseUrl) || '')).hostname; } catch { return {}; }
  if (!/(^|\.)opencode\.ai$/i.test(host)) return {};
  const h = { 'user-agent': `lain/${require('../package.json').version}` };
  if (opts.sessionId) h['x-opencode-session'] = String(opts.sessionId);
  return h;
}

module.exports = { routeHeaders };
