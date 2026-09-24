'use strict';

/**
 * HOW MUCH OF AN ACCOUNT'S ALLOWANCE IS USED — as the PROVIDER stated it.
 *
 * ------------------------------------------------------------------------
 * ONLY WHAT A RESPONSE SAID. NOTHING ESTIMATED.
 *
 * The window's quota bar asks "what percentage is this account at". LAIN does
 * not bill anything and does not count anybody's tokens against a plan it has
 * never seen, so the only honest source is the provider itself — and most of
 * them say it on every response, in rate-limit headers:
 *
 *   anthropic-ratelimit-unified-<w>-utilization   a subscription window (5h, 7d)
 *   anthropic-ratelimit-<kind>-limit|remaining|reset
 *   x-ratelimit-limit|remaining|reset-<kind>       OpenAI and compatible routers
 *   x-ratelimit-limit|remaining|reset              OpenRouter and friends
 *
 * provider.js hands every response's headers here (`observe`); nothing else
 * writes. A route whose responses carry none of these has NO usage reading,
 * and that absence is reported as `null` — never as 0%, which would be a claim.
 *
 * ------------------------------------------------------------------------
 * IN MEMORY, PER PROCESS. A reading is true at the moment the response
 * arrived; it is stamped with that moment so a reader can say how old it is.
 * Persisting it would show last week's percentage as though it were today's.
 *
 * ------------------------------------------------------------------------
 * NEVER AN AVERAGE. Several windows can be reported at once (a 5-hour and a
 * weekly one, or requests and tokens). The HEADLINE is the most-used window —
 * the one that will refuse the next request first — and it says which window
 * it is. Averaging unrelated windows would produce a number no provider stated.
 */

/** readings by connection id: { connectionId, provider, model, at, windows[] } */
const readings = new Map();
/** The route the most recent request went to — "what is running now". */
let lastRoute = null;

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "6m0s", "1.5s", "20ms", "2h3m" — OpenAI's reset durations — to ms. */
function durationMs(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return null;           // a bare number is not a duration
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m;
  while ((m = re.exec(s))) {
    matched = true;
    const v = Number(m[1]);
    total += m[2] === 'ms' ? v : m[2] === 's' ? v * 1000 : m[2] === 'm' ? v * 60000 : v * 3600000;
  }
  return matched ? total : null;
}

/**
 * A reset as an absolute time, from any of the shapes providers use: an
 * RFC 3339 date, epoch seconds, epoch milliseconds, or a duration from now.
 */
function resetAt(text, now) {
  const s = String(text || '').trim();
  if (!s) return null;
  const d = durationMs(s);
  if (d != null) return now + d;
  const n = num(s);
  if (n != null) {
    if (n > 1e12) return n;                              // epoch ms
    if (n > 1e9) return n * 1000;                        // epoch seconds
    return now + n * 1000;                               // seconds from now
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** "5h" -> "5-hour", "7d" -> "7-day", anything else as the provider named it. */
function windowLabel(name) {
  const m = /^(\d+)([hd])$/.exec(name);
  if (m) return `${m[1]}-${m[2] === 'h' ? 'hour' : 'day'}`;
  return name.replace(/-/g, ' ');
}

/** Every header as a lowercase-keyed plain object, from a fetch Headers or a map. */
function flatten(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
    headers.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
    return out;
  }
  for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = String(v);
  return out;
}

/**
 * THE WINDOWS A SET OF HEADERS DESCRIBES.
 *
 * @returns {Array<{name, label, percent, limit, remaining, resetAt, subscription}>}
 *          percent is 0..100 (used), or null when only a reset was stated.
 */
function parse(headers, now = Date.now()) {
  const h = flatten(headers);
  const acc = new Map();
  const slot = (name, subscription) => {
    if (!acc.has(name)) acc.set(name, { name, label: windowLabel(name), percent: null, limit: null, remaining: null, resetAt: null, subscription });
    return acc.get(name);
  };
  for (const [k, v] of Object.entries(h)) {
    let m = /^anthropic-ratelimit-unified-([a-z0-9]+)-(utilization|reset)$/.exec(k);
    if (m) {
      const w = slot(m[1], true);
      if (m[2] === 'utilization') {
        const u = num(v);
        // A FRACTION ON THE WIRE (0.63). A value above one is already a percent.
        if (u != null) w.percent = Math.max(0, Math.min(100, u <= 1 ? u * 100 : u));
      } else {
        w.resetAt = resetAt(v, now);
      }
      continue;
    }
    m = /^anthropic-ratelimit-([a-z-]+)-(limit|remaining|reset)$/.exec(k);
    if (m && !m[1].startsWith('unified')) {
      const w = slot(m[1], false);
      if (m[2] === 'reset') w.resetAt = resetAt(v, now); else w[m[2]] = num(v);
      continue;
    }
    m = /^x-ratelimit-(limit|remaining|reset)(?:-([a-z-]+))?$/.exec(k);
    if (m) {
      const w = slot(m[2] || 'requests', false);
      if (m[1] === 'reset') w.resetAt = resetAt(v, now); else w[m[1]] = num(v);
    }
  }
  const out = [];
  for (const w of acc.values()) {
    if (w.percent == null && w.limit != null && w.remaining != null && w.limit > 0) {
      w.percent = Math.max(0, Math.min(100, ((w.limit - w.remaining) / w.limit) * 100));
    }
    if (w.percent == null && w.resetAt == null) continue;
    out.push(w);
  }
  return out;
}

/** The window that will refuse first: subscription windows before per-minute ones. */
function headline(windows) {
  const rated = (windows || []).filter((w) => w.percent != null);
  if (!rated.length) return null;
  const subs = rated.filter((w) => w.subscription);
  const pool = subs.length ? subs : rated;
  return pool.reduce((a, b) => (b.percent > a.percent ? b : a));
}

/**
 * A RESPONSE ARRIVED. Called by provider.js for every model request, success
 * or refusal. Never throws: usage is a reading, and a turn must not fail over
 * a header it could not parse.
 */
function observe(route, headers, now = Date.now()) {
  try {
    const id = String((route && (route.connectionId || route.provider)) || '');
    if (!id) return null;
    // BOTH MODEL NAMES: what went on the wire (`model`) and LAIN's catalog id
    // (`canonicalModel`), which is what a role's selection is written in.
    const who = {
      connectionId: id,
      provider: (route && route.provider) || null,
      model: (route && route.model) || null,
      canonicalModel: (route && route.canonicalModel) || null,
    };
    lastRoute = { ...who, at: now };
    const windows = parse(headers, now);
    if (!windows.length) return null;
    const rec = { ...who, at: now, windows };
    readings.set(id, rec);
    return rec;
  } catch { return null; }
}

/**
 * THE READING FOR A ROLE'S SELECTION: by route first — a catalog route id
 * (`lain:host:Label`) belongs to its base connection (`lain:host`) — then by
 * model, in either of its two names.
 */
function forSelection(connectionId, modelId) {
  const cid = String(connectionId || '');
  const mid = String(modelId || '');
  for (const r of readings.values()) {
    if (cid && (r.connectionId === cid || cid.startsWith(`${r.connectionId}:`))) return forConnection(r.connectionId);
  }
  for (const r of readings.values()) {
    if (mid && (r.canonicalModel === mid || r.model === mid)) return forConnection(r.connectionId);
  }
  return null;
}

/** The last reading for a route, with its headline window, or null. */
function forConnection(id) {
  const r = readings.get(String(id || ''));
  if (!r) return null;
  return { ...r, windows: r.windows.map((w) => ({ ...w })), headline: headline(r.windows) };
}

function all() { return [...readings.keys()].map(forConnection); }
function last() { return lastRoute ? { ...lastRoute } : null; }
function _reset() { readings.clear(); lastRoute = null; }

module.exports = { observe, parse, headline, forConnection, forSelection, all, last, durationMs, _reset };
