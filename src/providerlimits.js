'use strict';

/** WHAT THIS PROVIDER WILL ACCEPT — one source of truth, three different limits. */

/** KNOWN MESSAGE-COUNT CAPS, by provider. */
const KNOWN = Object.freeze({
  // EMPTY, AND STILL LOAD-BEARING.
});

/** HOW MUCH OF THE CAP A REQUEST MAY USE. */
const HEADROOM = 0.95;

/** The `learn`ed caps of this process, by connection id. */
const learned = new Map();

/** WHAT THIS ROUTE WILL TAKE. */
function limitsFor(pc, cfg = {}) {
  const provider = String((pc && pc.provider) || '').toLowerCase();
  const id = String((pc && pc.connectionId) || provider);

  // 1. WHAT THE PROVIDER TOLD US, this session.
  const seen = learned.get(id);

  // 2. WHAT THE USER CONFIGURED. Per connection id first, then per provider —
  //    a person with two omniroute routes may know they differ.
  const configured = (cfg && cfg.providerLimits) || {};
  const byId = configured[id] || configured[provider] || {};

  // 3. A KNOWN DEFAULT.
  const known = KNOWN[provider] || {};

  const messages = Number(seen && seen.messages) || Number(byId.messages) || Number(known.messages) || 0;
  return {
    messages,
    // THE TOKEN WINDOW IS ALREADY MODELLED as `pc.ctx`, and this does not invent a second one — session.budgetChars is the owner of that conversion and…
    tokens: Number(pc && pc.ctx) || 0,
    bytes: Number(byId.bytes) || 0,
    source: seen ? 'the provider said so' : (byId.messages ? 'configured' : (known.messages ? 'known default' : 'unknown')),
  };
}

/** REMEMBER WHAT A REFUSAL TAUGHT US. */
function learn(pc, { messages = 0 } = {}) {
  const id = String((pc && pc.connectionId) || (pc && pc.provider) || '');
  if (!id || !(Number(messages) > 0)) return null;
  const prev = learned.get(id) || {};
  // THE LOWEST OBSERVED CAP WINS. Two routes behind one id may differ, and the
  // smaller number is the one that keeps requests getting through.
  const next = { messages: prev.messages ? Math.min(prev.messages, Number(messages)) : Number(messages) };
  learned.set(id, next);
  return next;
}

/** For tests and for a fresh process. */
function forget() { learned.clear(); }

/** MEASURE A PAYLOAD THE WAY THE PROVIDER WILL COUNT IT. */
function measure(wire) {
  const messages = Array.isArray(wire) ? wire.length : 0;
  let chars = 0;
  for (const m of wire || []) {
    chars += String((m && m.content) || '').length;
    // TOOL CALLS ARE PAYLOAD TOO.
    for (const tc of (m && m.tool_calls) || []) {
      chars += String((tc && tc.arguments) || '').length + String((tc && tc.name) || '').length;
    }
  }
  return { messages, chars };
}

/** WOULD THIS PAYLOAD BE REFUSED? */
function check(wire, limits) {
  const m = measure(wire);
  const cap = Number(limits && limits.messages) || 0;
  if (cap > 0) {
    const allowed = Math.max(1, Math.floor(cap * HEADROOM));
    if (m.messages > allowed) {
      return {
        ok: false, over: 'messages', count: m.messages, limit: cap,
        why: `${m.messages} messages against this provider's ${cap}-message limit`,
      };
    }
  }
  return { ok: true, over: '', count: m.messages, limit: cap, why: '' };
}

/** HOW MANY MESSAGES A PAYLOAD MAY KEEP — the target a compaction aims at. */
function targetFor(limits) {
  const cap = Number(limits && limits.messages) || 0;
  if (!cap) return 0;
  return Math.max(8, Math.floor(cap * HEADROOM) - 8);
}

module.exports = { limitsFor, learn, forget, measure, check, targetFor, KNOWN, HEADROOM };
