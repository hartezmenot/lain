'use strict';

/**
 * Error classification. One place decides what a failure MEANS, so the turn
 * loop, the renderer and (later) the availability breaker cannot disagree.
 *
 * The distinction that matters: a REACHABILITY failure is a runtime dependency
 * having a bad day and must be reported, never thrown. A BUG is a programming
 * error and must keep throwing, or we lose real stack traces to a catch-all.
 */

/**
 * WHICH KIND OF TOO-BIG. A window measured in tokens and a cap on the NUMBER
 * of messages are refused with the same status and fixed in opposite ways:
 * one wants shorter messages, the other wants fewer of them. Compaction only
 * ever knew how to make them shorter.
 */
const LIMIT = Object.freeze({
  SIZE: 'SIZE',
  MESSAGES: 'MESSAGES',
});

/**
 * WHICH LAYER FAILED. Every entry here is a DIFFERENT NEXT MOVE, which is the
 * only reason for a name to exist in this list.
 *
 * THE TWO THAT WERE MISSING, and why they cost more than they look:
 *
 *   QUOTA is not RATE_LIMITED. A rate limit clears on its own and waiting is
 *     the correct response; an exhausted quota does not clear until somebody
 *     pays, and waiting for it is waiting forever. Both arrive as 429 from some
 *     gateways, so the status code alone cannot separate them — the body can,
 *     and does. Reported as one, LAIN sat in a retry loop against a wall.
 *
 *   MODEL_UNAVAILABLE is not UNAVAILABLE. "This provider is down" and "this
 *     provider is fine and does not serve that model" have opposite fixes:
 *     wait, versus pick another model. Reported as an outage, a typo in a model
 *     name looked like the provider having a bad day, and the retry schedule
 *     ran its whole course before saying anything useful.
 *
 * NONE OF THESE IS EVER "LAIN IS BROKEN". That distinction is the point of the
 * whole file: a failure of a runtime dependency is reported, and a programming
 * error keeps throwing so a real stack trace survives.
 */
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

/**
 * A GATEWAY SAYING THE ACCOUNT IS OUT OF MONEY, in the words each one uses.
 *
 * Read from the BODY, not the status: 429 carries both meanings, 402 is not
 * universal, and some gateways return 400 for it. The words are what differ.
 */
/**
 * A 429 THAT WILL NOT CLEAR BY WAITING.
 *
 * ------------------------------------------------------------------------
 * WHAT WAS MISSING, and it was measured off a real session rather than guessed.
 * The bridge answered:
 *
 *     429 — {"message":"[tokenrouter/…] [429]: You have reached the request
 *            limit[…]"}
 *
 * Nothing in the old pattern matched that, so it fell through to the plain
 * `status === 429` branch and came back RETRIABLE. The retry loop then sent
 * FIVE more requests, twenty seconds apart, to a provider that had just said
 * the account had no requests left — a hundred seconds of waiting, five more
 * refusals against the exhausted cap, and no possible success. That is LAIN
 * multiplying "too many requests" by six on its own.
 *
 * THE DISCRIMINATOR IS WHICH LIMIT, NOT THE WORD "LIMIT". A RATE limit clears
 * on its own and waiting is exactly right. A REQUEST/DAILY/MONTHLY/USAGE cap,
 * or an individual quota, clears when a period rolls over or somebody pays —
 * neither of which a backoff schedule brings about. So "rate limit" stays
 * retriable and is deliberately NOT matched here, while the caps that do not
 * clear are.
 */
const QUOTA_RE = /insufficient[_ ](?:quota|credit|balance|funds)|quota[_ ]exceeded|exceeded your current quota|out of credits?|no credit(?:s)? remaining|billing[_ ](?:hard[_ ])?limit|payment required|add (?:a payment method|credits)|individual quota|reached (?:the |your )?(?:daily |monthly |hourly |weekly )?(?:request|usage|token|message|generation)s?[_ ]limit|(?:daily|monthly|weekly) (?:limit|quota) (?:reached|exceeded)|(?:usage|request|token) limit (?:has been |was )?(?:reached|exceeded)|credits? (?:exhausted|depleted)|exhausted (?:its |your |the )?credits?|requests? per (?:day|month|week) exceeded/i;

/**
 * A PROVIDER SAYING IT DOES NOT SERVE THIS MODEL.
 *
 * Deliberately narrow, and it must not match a missing FILE, a missing route or
 * a missing tool — only a model. Every phrase here names the model explicitly.
 */
const MODEL_RE = /\b(?:model|deployment)[^.\n]{0,40}\b(?:not found|does not exist|is not available|unavailable|is not supported|unknown|invalid)|\b(?:unknown|invalid|unsupported|unrecognized|unrecognised)[_ ]model|no such model|model_not_found/i;

/** Transport-level errno names. NOTE: no \b before these — `\bECONN\b` cannot
 *  match inside ECONNREFUSED, which in V1 meant a dead local bridge was never
 *  classified as transient and took the whole REPL down. */
const TRANSPORT_RE = /(ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|network|terminated)/i;

/**
 * A LIMIT THAT STATES WHEN IT ENDS, even when a gateway re-wraps it.
 *
 * Observed live through 9router (2026-09-18): HTTP 503 with
 *   {"error":{"message":"[codex/gpt-5.6-luna] [429]: The usage limit has been
 *    reached (reset after 1m 59s)"}}
 * The router mapped the upstream 429 to 503, so this fell to the 5xx branch:
 * shown as `Network 503`, retried at 5s, 10s, 15s… — five refusals inside the
 * window the provider had already named. The body carries both the upstream
 * status and the reset; they are the truth, whatever the outer status says.
 */
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

/**
 * WHEN THE LIMIT ENDS, in ms from `now`, or 0 when the provider did not say.
 * Every shape seen on the wire: a duration ("reset after 1m 59s", "resets in
 * 4h 12m", "try again in 3 days"), an ISO time ("resets at
 * 2026-09-22T08:00:00Z"), epoch seconds ("reset": 1789900000), and a weekday
 * with a clock ("Reset Monday 08:00"). A known reset is waited for — never
 * hammered with a retry ladder (turn.js, ratelimit.js, availability.js).
 */
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
  // ---- THE UPSTREAM'S STATUS, WHEN A ROUTER WRAPS IT -----------------------
  //
  // 9router answers every upstream refusal as 503 with the real status in the
  // body: `[codex/gpt-5.6-luna] [401]: …`, `[kimchi/kimi-k3] [402]: …`,
  // `[nvidia/z-ai/glm-5.2] [410]: Gone`. Read as 503 they were all "the
  // network", retried up to ten times. The inner 4xx is the answer that was given.
  const inner = outer >= 500 ? /\]\s*\[(4\d\d)\]\s*:/.exec(msg) : null;
  const status = inner ? Number(inner[1]) : outer;

  // ---- A LIMIT WITH A SHORT, STATED RESET: wait exactly that long ----------
  const limited = status === 429 || LIMIT_WORDS_RE.test(msg);
  const reset = limited ? resetHintMs(msg) : 0;
  // A STATED RESET OF ANY LENGTH IS A RATE LIMIT WITH A CLOCK: waited for once
  // in the turn when short, handed to WAIT / change-model when long
  // (ratelimit.worthAsking), and the route stays shut until then
  // (availability) — never a 1/10 retry ladder against a named window.
  if (limited && reset > 0) {
    return {
      kind: KIND.RATE_LIMITED, retriable: true, status,
      retryAfterMs: Math.max(retryAfterMs(err), reset), resetHintMs: reset,
      limitClass: limitClass(msg, reset), resetSource: 'provider message',
      message: err.message || 'rate limited',
    };
  }

  // ---- QUOTA BEFORE RATE LIMIT, because a 429 can be either ---------------
  //
  // Order is the discriminator. A gateway that has run the account out of
  // credit answers 429 with a body that says so; one that is merely throttling
  // answers 429 with a body that does not. Checked first, and by WORDS rather
  // than by status, so an exhausted account is never handed to the retry loop.
  if (QUOTA_RE.test(msg) || status === 402) {
    return {
      kind: KIND.QUOTA,
      // NOT RETRIABLE, and this is the whole value of the distinction: waiting
      // for a quota to refill is waiting for somebody to pay, which no backoff
      // schedule will bring about.
      retriable: false,
      status,
      message: err.message || 'the provider quota or credit for this account is exhausted',
    };
  }
  if (status === 429) {
    return { kind: KIND.RATE_LIMITED, retriable: true, status, retryAfterMs: retryAfterMs(err), message: err.message || 'rate limited' };
  }
  // ---- A MODEL THAT IS NOT SERVED IS NOT AN OUTAGE ------------------------
  //
  // Before 5xx and before the transport check, because some gateways answer a
  // bad model name with a 5xx and the transport regex matches the word
  // "network" wherever it appears. The provider answered; it answered that it
  // will not serve this. The fix is a different model, not more patience.
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
    // WHICH LIMIT, because they have different fixes and only one of them is
    // the one LAIN knew how to attack.
    //
    // Compaction shortens message BODIES. Against a window measured in tokens
    // that is the whole answer. Against a provider that caps the NUMBER of
    // messages — "chat history exceeds the 800-message limit" — it is no answer
    // at all: a thousand short messages are still a thousand messages, so
    // compaction ran, truthfully reported "nothing to elide", and every
    // subsequent request was refused exactly as before.
    //
    // Observed live on 2026-08-22 against omniroute, which returns
    // `code: "chat_history_too_large", reason: "message_limit"`.
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

/**
 * Retry-After, in ms, SANITY-CLAMPED. A gateway that sends an absolute epoch
 * instead of a delta produced a ~26-day wait in V1. Anything past an hour is
 * not a delta.
 */
function retryAfterMs(err) {
  const raw = Number(err && err.retryAfter) || 0;
  if (raw > 0 && raw * 1000 <= MAX_RESET_MS) return raw * 1000;        // a delta, up to a quota week
  if (raw > 1e9) {                                                     // an absolute epoch in seconds
    const left = raw * 1000 - Date.now();
    if (left > 0 && left <= MAX_RESET_MS) return left;
  }
  return 0;
}

/**
 * Is this a runtime dependency failing (report it) rather than our bug (throw)?
 * This is the single predicate that keeps the REPL alive.
 */
function isProviderFailure(err) {
  const k = classify(err).kind;
  return k === KIND.RATE_LIMITED || k === KIND.QUOTA || k === KIND.UNAVAILABLE
    || k === KIND.MODEL_UNAVAILABLE || k === KIND.TIMEOUT
    || k === KIND.AUTH || k === KIND.CONTEXT_LIMIT || k === KIND.BAD_REQUEST;
}

/**
 * THE LAYER, IN WORDS A PERSON READS.
 *
 * One sentence per kind, and every one of them names something OTHER than LAIN
 * — because that is what these are. A screen that shows a provider's 429 as
 * though LAIN had malfunctioned sends the user to debug the wrong program, and
 * three of LAIN's modes share one upstream account, so a limit hit in one of
 * them surfaces in all three at once and looks exactly like a bug.
 */
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

/**
 * ------------------------------------------------------------------------
 * HOW A RETRY IS NAMED, AND HOW THE PROVIDER'S OWN WORDS ARE CLIPPED.
 *
 * These lived in turn.js, beside the retry loop that uses them, until that file
 * reached the god-object guard. The seam is a real one and was always here:
 * everything in turn.js RUNS a turn, and this file decides what a failure IS.
 * Naming one and quoting one are the same concern as classifying one.
 */
/**
 * THE CONDITION, IN ONE WORD — what a retry is called on screen.
 *
 * `RATE_LIMITED` is the one a person acts on differently (wait, or change route),
 * so it keeps its own word; everything else retriable is the road being busy.
 */
function retryWord(failure) {
  return failure && failure.kind === KIND.RATE_LIMITED ? 'Rate limited' : 'Provider busy';
}

/**
 * THE PROVIDER'S OWN REASON, AS ONE SENTENCE.
 *
 * Some answer a refusal with a whole JSON object, and the durable notice that used
 * to carry this printed all of it. The status code and the first clause are the
 * useful part; the rest is on `record.errors` for /status to show.
 */
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
