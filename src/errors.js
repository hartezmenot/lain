'use strict';

/** Error classification. */

/** WHICH KIND OF TOO-BIG. */
const LIMIT = Object.freeze({
  SIZE: 'SIZE',
  MESSAGES: 'MESSAGES',
});

/** WHICH LAYER FAILED. Every entry here is a DIFFERENT NEXT MOVE, which is the only reason for a name to exist in this list. */
const KIND = Object.freeze({
  RATE_LIMITED: 'RATE_LIMITED',   // 429 that clears with time
  QUOTA: 'QUOTA',                 // credit/quota exhausted — waiting will not help
  UNAVAILABLE: 'UNAVAILABLE',     // transport/5xx — the server is not answering
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE', // the provider is fine; this model is not served
  TIMEOUT: 'TIMEOUT',
  AUTH: 'AUTH',                   // 401/403 — credential problem, not an outage
  CONTEXT_LIMIT: 'CONTEXT_LIMIT',
  BAD_REQUEST: 'BAD_REQUEST',
  ABORTED: 'ABORTED',
  UNKNOWN: 'UNKNOWN',
});

/** A GATEWAY SAYING THE ACCOUNT IS OUT OF MONEY, in the words each one uses. */
/** A 429 THAT WILL NOT CLEAR BY WAITING. */
const QUOTA_RE = /insufficient[_ ](?:quota|credit|balance|funds)|quota[_ ]exceeded|exceeded your current quota|out of credits?|no credit(?:s)? remaining|billing[_ ](?:hard[_ ])?limit|payment required|add (?:a payment method|credits)|individual quota|reached (?:the |your )?(?:daily |monthly |hourly |weekly )?(?:request|usage|token|message|generation)s?[_ ]limit|(?:daily|monthly|weekly) (?:limit|quota) (?:reached|exceeded)|(?:usage|request|token) limit (?:has been |was )?(?:reached|exceeded)|credits? (?:exhausted|depleted)|exhausted (?:its |your |the )?credits?|requests? per (?:day|month|week) exceeded/i;

/** A PROVIDER SAYING IT DOES NOT SERVE THIS MODEL. */
const MODEL_RE = /\b(?:model|deployment)[^.\n]{0,40}\b(?:not found|does not exist|is not available|unavailable|is not supported|unknown|invalid)|\b(?:unknown|invalid|unsupported|unrecognized|unrecognised)[_ ]model|no such model|model_not_found/i;

/** Transport-level errno names. */
const TRANSPORT_RE = /(ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|network|terminated)/i;

/** A LIMIT THAT STATES WHEN IT ENDS, even when a gateway re-wraps it. */
const LIMIT_WORDS_RE = /\[429\]|\b429\b|rate[_ -]?limit|usage limit|request limit|too many requests|limit (?:has been |was )?(?:reached|exceeded)/i;
/** The longest stated reset believed at all: a quota week, with room. */
const MAX_RESET_MS = 14 * 24 * 3600 * 1000;

const UNIT_MS = (u) => {
  const x = u.toLowerCase();
  if (x.startsWith('w')) return 7 * 86400000;
  if (x.startsWith('d')) return 86400000;
  if (x.startsWith('h')) return 3600000;
  if (x.startsWith('m')) return 60000;
  return 1000;
};
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** WHEN THE LIMIT ENDS, in ms from `now`, or 0 when the provider did not say. */
function resetHintMs(msg, now = Date.now()) {
  const s = String(msg || '');
  const dur = /(?:reset|resets|try again|retry|available again)\s*(?:after|in)?\s*:?\s*((?:\d+(?:\.\d+)?\s*(?:weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(s);
  if (dur) {
    let ms = 0;
    for (const [, n, u] of dur[1].matchAll(/(\d+(?:\.\d+)?)\s*(weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) ms += Number(n) * UNIT_MS(u);
    return ms > 0 && ms <= MAX_RESET_MS ? Math.round(ms) : 0;
  }
  const iso = /(?:reset|resets|resets_at|reset_at|available again|try again)[^0-9]{0,12}(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(s);
  if (iso) { const t = Date.parse(iso[1]); if (t > now && t - now <= MAX_RESET_MS) return t - now; }
  const epoch = /(?:reset|resets_at|reset_at)["']?\s*[:=]\s*["']?(\d{10})(?:\.\d+)?\b/i.exec(s);
  if (epoch) { const t = Number(epoch[1]) * 1000; if (t > now && t - now <= MAX_RESET_MS) return t - now; }
  const wk = /\breset(?:s)?\s+(?:on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:at\s+)?(\d{1,2}):(\d{2}))?/i.exec(s);
  if (wk) {
    const d = new Date(now);
    const want = DAYS.indexOf(wk[1].toLowerCase());
    let add = (want - d.getDay() + 7) % 7;
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + add, Number(wk[2] || 0), Number(wk[3] || 0), 0, 0);
    if (t.getTime() <= now) t.setDate(t.getDate() + 7);
    add = t.getTime() - now;
    return add > 0 && add <= MAX_RESET_MS ? add : 0;
  }
  return 0;
}

/** Which kind of window a stated limit is, for the person reading it. */
function limitClass(msg, resetMs) {
  const s = String(msg || '');
  if (/\bweekly|per week|week\b/i.test(s) || resetMs >= 3 * 86400000) return 'weekly';
  if (/\bdaily|per day\b/i.test(s) || resetMs >= 6 * 3600000) return 'daily';
  if (/\bhourly|per hour|5-?hour\b/i.test(s) || resetMs >= 15 * 60000) return 'hourly';
  return 'rate';
}

function classify(err) {
  if (!err) return { kind: KIND.UNKNOWN, retriable: false, message: 'unknown error' };
  if (err.name === 'AbortError' || err.aborted) {
    return { kind: KIND.ABORTED, retriable: false, message: 'aborted' };
  }
  const outer = Number(err.status || err.statusCode) || 0;
  const msg = String((err && err.message) || err) + ' ' + String((err && err.code) || '');
  // THE UPSTREAM'S STATUS, WHEN A ROUTER WRAPS IT
  const inner = outer >= 500 ? /\]\s*\[(4\d\d)\]\s*:/.exec(msg) : null;
  const status = inner ? Number(inner[1]) : outer;

  // ---- A LIMIT WITH A SHORT, STATED RESET: wait exactly that long ----------
  const limited = status === 429 || LIMIT_WORDS_RE.test(msg);
  const reset = limited ? resetHintMs(msg) : 0;
  // A STATED RESET OF ANY LENGTH IS A RATE LIMIT WITH A CLOCK: waited for once in the turn when short, handed to WAIT / change-model when long…
  if (limited && reset > 0) {
    return {
      kind: KIND.RATE_LIMITED, retriable: true, status,
      retryAfterMs: Math.max(retryAfterMs(err), reset), resetHintMs: reset,
      limitClass: limitClass(msg, reset), resetSource: 'provider message',
      message: err.message || 'rate limited',
    };
  }

  // QUOTA BEFORE RATE LIMIT, because a 429 can be either
  if (QUOTA_RE.test(msg) || status === 402) {
    return {
      kind: KIND.QUOTA,
      // NOT RETRIABLE, and this is the whole value of the distinction: waiting for a quota to refill is waiting for somebody to pay, which no backoff…
      retriable: false,
      status,
      message: err.message || 'the provider quota or credit for this account is exhausted',
    };
  }
  if (status === 429) {
    return { kind: KIND.RATE_LIMITED, retriable: true, status, retryAfterMs: retryAfterMs(err), message: err.message || 'rate limited' };
  }
  // A MODEL THAT IS NOT SERVED IS NOT AN OUTAGE
  if (MODEL_RE.test(msg)) {
    return {
      kind: KIND.MODEL_UNAVAILABLE,
      retriable: false,
      status,
      message: err.message || 'that model is not available on this connection',
    };
  }
  if (status === 401 || status === 403) {
    return { kind: KIND.AUTH, retriable: false, status, message: err.message || `authentication failed (HTTP ${status})` };
  }
  if (status === 413 || /context length|too many tokens|maximum context/i.test(msg)) {
    // WHICH LIMIT, because they have different fixes and only one of them is the one LAIN knew how to attack.
    const count = /(\d[\d,]*)[- ]message limit|message[_ ]limit|too many messages|history exceeds/i.exec(msg);
    const cap = /(\d[\d,]*)[- ]message/i.exec(msg);
    return {
      kind: KIND.CONTEXT_LIMIT,
      retriable: false,
      status,
      limitKind: count ? LIMIT.MESSAGES : LIMIT.SIZE,
      maxMessages: count && cap ? Number(String(cap[1]).replace(/,/g, '')) || 0 : 0,
      message: err.message || 'context limit exceeded',
    };
  }
  if (status === 408 || err.timedOut || /timed? ?out/i.test(msg)) {
    // `noResponse` marks "the server never sent headers". Retrying that only
    // multiplies the wait — it is a fast failure so the breaker can take over.
    return { kind: KIND.TIMEOUT, retriable: !err.noResponse, status, message: err.message || 'timed out' };
  }
  if (status >= 500 && status < 600) {
    return { kind: KIND.UNAVAILABLE, retriable: true, status, message: err.message || `provider returned HTTP ${status}` };
  }
  if (TRANSPORT_RE.test(msg)) {
    return { kind: KIND.UNAVAILABLE, retriable: true, status, message: err.message || 'provider unreachable' };
  }
  if (status >= 400 && status < 500) {
    return { kind: KIND.BAD_REQUEST, retriable: false, status, message: err.message || `HTTP ${status}` };
  }
  return { kind: KIND.UNKNOWN, retriable: false, status, message: err.message || String(err) };
}

/** Retry-After, in ms, SANITY-CLAMPED. */
function retryAfterMs(err) {
  const raw = Number(err && err.retryAfter) || 0;
  if (raw > 0 && raw * 1000 <= MAX_RESET_MS) return raw * 1000;        // a delta, up to a quota week
  if (raw > 1e9) {                                                     // an absolute epoch in seconds
    const left = raw * 1000 - Date.now();
    if (left > 0 && left <= MAX_RESET_MS) return left;
  }
  return 0;
}

/** Is this a runtime dependency failing (report it) rather than our bug (throw)? */
function isProviderFailure(err) {
  const k = classify(err).kind;
  return k === KIND.RATE_LIMITED || k === KIND.QUOTA || k === KIND.UNAVAILABLE
    || k === KIND.MODEL_UNAVAILABLE || k === KIND.TIMEOUT
    || k === KIND.AUTH || k === KIND.CONTEXT_LIMIT || k === KIND.BAD_REQUEST;
}

/** THE LAYER, IN WORDS A PERSON READS. */
const LAYER = Object.freeze({
  [KIND.RATE_LIMITED]: 'the provider is rate limiting this account — it clears on its own',
  [KIND.QUOTA]: 'the provider quota or credit for this account is exhausted — waiting will not clear it',
  [KIND.UNAVAILABLE]: 'the provider is not answering — this is an outage upstream, not a fault here',
  [KIND.MODEL_UNAVAILABLE]: 'the provider is reachable but does not serve that model — choose another with /models',
  [KIND.TIMEOUT]: 'the provider did not answer in time',
  [KIND.AUTH]: 'the credential for this connection was refused — check /api or /oauth',
  [KIND.CONTEXT_LIMIT]: 'the request was larger than this model accepts',
  [KIND.BAD_REQUEST]: 'the provider refused the request as malformed',
  [KIND.ABORTED]: 'you interrupted it',
  [KIND.UNKNOWN]: 'the cause is not established',
});

/** What to tell the user, given a raw error. Names the layer, never LAIN. */
function explain(err) {
  const c = classify(err);
  return { ...c, layer: LAYER[c.kind] || LAYER[KIND.UNKNOWN] };
}

/** HOW A RETRY IS NAMED, AND HOW THE PROVIDER'S OWN WORDS ARE CLIPPED. */
/** THE CONDITION, IN ONE WORD — what a retry is called on screen. */
function retryWord(failure) {
  return failure && failure.kind === KIND.RATE_LIMITED ? 'Rate limited' : 'Provider busy';
}

/** THE PROVIDER'S OWN REASON, AS ONE SENTENCE. */
function shortReason(failure) {
  const code = failure && failure.status ? `${failure.status} ` : '';
  const raw = String((failure && failure.message) || 'no answer').replace(/\s+/g, ' ').trim();
  const head = raw.split(/ [-—] |[{[]/)[0].trim() || raw;
  return (code + head).slice(0, 60);
}

module.exports = {
  KIND, LIMIT, LAYER, classify, explain, isProviderFailure, retryAfterMs, resetHintMs,
  retryWord, shortReason,
};
