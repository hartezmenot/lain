'use strict';

/**
 * RUNTIME-BOUND MODELS MAY ONLY RUN INSIDE THEIR RUNTIME.
 *
 * OpenCode's free models are served only to OpenCode itself. Reaching one over
 * plain HTTP — OpenCode Zen's endpoint, or a router that forwards to it — is the
 * path OpenCode refuses ("OpenCode's free tier can only be used from within
 * OpenCode"), and it is the path LAIN must not take: the free tier is an
 * entitlement of the OpenCode program. The route LAIN uses instead is the
 * OpenCode RuntimeBridge (drivers/opencodeserver.js): a real OpenCode session.
 *
 * `check` is consulted by provider.resolve for every API route. It answers
 * { kind: 'runtime-bound', ... } — and the request is not sent — when BOTH:
 *   - the route reaches OpenCode's service: its base URL is on opencode.ai, or
 *     its routing namespace / model prefix names OpenCode (opencode, opencode-go,
 *     opencode-free, oczen, ocgo …), and
 *   - the model is a free, runtime-bound one ("-free", big-pickle, or listed as
 *     runtime-bound by the OpenCode runtime itself).
 */

const OPENCODE_HOST = /(^|\.)opencode\.ai$/i;
const OPENCODE_NS = /^(opencode(-go|-free|-zen)?|oc(zen|go|free)?)$/i;

function hostOf(url) { try { return new URL(String(url)).hostname; } catch { return ''; } }

/** Names OpenCode itself reported as runtime-bound (cached telemetry), lower-cased. */
function listedBound() {
  try {
    const t = require('./runtimeadapters').cachedTelemetry('opencode');
    return new Set(((t && t.models) || []).filter((m) => m.entitlement && m.entitlement.kind === 'runtime-bound').map((m) => String(m.upstream || '').split('/').pop().toLowerCase()));
  } catch { return new Set(); }
}

function isBoundName(name) {
  const n = String(name || '').split('/').pop().toLowerCase();
  if (!n) return false;
  return /-free$/.test(n) || n === 'big-pickle' || listedBound().has(n);
}

/** Does this route reach OpenCode's service? */
function reachesOpenCode({ baseUrl = '', connectionId = '', model = '' } = {}) {
  if (OPENCODE_HOST.test(hostOf(baseUrl))) return true;
  const ns = String(connectionId || '').split(':').slice(2).join(':');   // lain:<conn>:<namespace>
  if (ns && OPENCODE_NS.test(ns)) return true;
  const prefix = String(model || '').split('/');
  return prefix.length > 1 && OPENCODE_NS.test(prefix[0]);
}

/** The refusal, or null when the route may be used. */
function check({ conn = {}, connectionId = '', model = '', upstreamId = '' } = {}) {
  if (conn.protocol === 'runtime') return null;                                  // the runtime itself: the right path
  const name = upstreamId || model;
  if (!isBoundName(name) && !isBoundName(model)) return null;
  if (!reachesOpenCode({ baseUrl: conn.baseUrl, connectionId, model: upstreamId || model })) return null;
  const short = String(model || name).split('/').pop();
  return {
    kind: 'runtime-bound', runtime: 'opencode', model: short, connection: connectionId || conn.id || '',
    why: `${short} is runtime-bound: OpenCode serves it only inside OpenCode, so Noema will not call it over HTTP (${connectionId || conn.id || 'this route'}). Choose "${short} · OpenCode" (OpenCode Runtime) instead.`,
  };
}

module.exports = { check, isBoundName, reachesOpenCode };
