'use strict';

/**
 * AVAILABILITY — "can this connection be reached right now?"
 *
 * Strictly separate from authentication and from request-readiness. Collapsing
 * them produces exactly the wrong sentence:
 *
 *   authenticated + unreachable  → "the server is down"        (say this)
 *   no credential + unknown      → "log in first"              (different thing)
 *   authenticated + maintenance  → "you turned it off"         (different again)
 *
 * A provider outage is a runtime dependency failing. It is never the lifecycle
 * of the CLI, so NOTHING here can block: every entry point is synchronous and
 * in-memory, and health is LEARNED LAZILY from requests that were going to
 * happen anyway. There is no background ping loop, so `/provider status` costs
 * zero network traffic and works while every provider is dead.
 *
 * The breaker is what stops a dead endpoint becoming a request storm: after
 * `failureThreshold` consecutive failures it is OPEN and requests are skipped
 * before any socket is created. Only an elapsed cooldown or an explicit
 * `/provider retry` lets one probe through.
 *
 * State is keyed by CONNECTION ID, not by provider — the same provider reached
 * two ways can be up on one route and down on the other, which is the whole
 * reason connections exist.
 *
 * ------------------------------------------------------------------------
 * WHAT IS IN MEMORY AND WHAT IS NOT, WHICH CHANGED, AND WHY.
 *
 * This file used to say, in a comment on `app.availability`, that it is
 * "in-memory by design: it describes right now, and a restart legitimately
 * knows nothing". That is exactly right about a BREAKER and exactly wrong about
 * a RATE LIMIT, and the two had been sharing a lifetime because they share a
 * record.
 *
 *   THE BREAKER is a guess about a server that stopped answering. It has no
 *   stated expiry, it is derived from failures this process saw, and a fresh
 *   process is RIGHT to know nothing and re-guess. It stays here.
 *
 *   A RATE LIMIT is not a guess. The provider stated a time — measured live at
 *   `retry in 4 hours` — and it will refuse every request until then. Restart
 *   LAIN five minutes later and the Map is empty, so the next turn calls the
 *   closed route, is refused, and buys the same fact a second time; and the
 *   model picker, which is the one screen where "which of these can I use right
 *   now" is actually asked, shows a shut door as untried.
 *
 * So the rate-limit half is now owned by the supervisor — the process whose one
 * job is to still be running — and this class is a hot mirror in front of it.
 * See `hydrate` for what is adopted from disk and, more importantly, what is
 * deliberately not; `sink` for how observations get out; and
 * rust/lain-supervisor/src/providers.rs for the store itself.
 *
 * THE API DID NOT CHANGE AND MUST NOT. Every entry point here is still
 * synchronous and still cannot block — `shouldAttempt` is called immediately
 * before a socket is opened, and putting a round trip in front of it would make
 * every request wait on the health system that exists to save requests.
 * `hydrate` takes rows that have ALREADY been fetched, and `sink` is
 * fire-and-forget. Nothing here ever awaits.
 */

const STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',       // a request succeeded recently
  DEGRADED: 'DEGRADED',         // some failures, still under the threshold
  UNAVAILABLE: 'UNAVAILABLE',   // breaker open
  MAINTENANCE: 'MAINTENANCE',   // the user said so
  DISABLED: 'DISABLED',         // the user said so
  UNKNOWN: 'UNKNOWN',           // never tried
});

/** States a user set deliberately. Never auto-cleared by a successful request. */
const USER_SET = new Set([STATUS.MAINTENANCE, STATUS.DISABLED]);

const DEFAULTS = { failureThreshold: 2, cooldownMs: 60_000 };
/** How long a 429 that stated no reset keeps a route marked limited. */
const UNKNOWN_RESET_MS = 60_000;

class Availability {
  constructor(cfg = {}) {
    this.failureThreshold = Math.max(1, Number(cfg.failureThreshold) || DEFAULTS.failureThreshold);
    this.cooldownMs = Math.max(1000, Number(cfg.cooldownMs) || DEFAULTS.cooldownMs);
    this.state = new Map();
    /**
     * WHERE OBSERVATIONS GO TO OUTLIVE THIS PROCESS.
     *
     * `(id, observation) => void`. Installed by the App when a supervisor is
     * reachable, and null otherwise — which is the ordinary case on a machine
     * with no Rust toolchain, and everything here works exactly as it did.
     * Called fire-and-forget: see `_push`.
     */
    this.sink = null;
    /** Routes whose durable row was adopted at startup. For reporting only. */
    this.hydrated = new Set();
  }

  /**
   * A FACT LEAVING THIS PROCESS, and it may never be allowed to hurt the caller.
   *
   * `noteFailure` runs on the failure path of a model request, inside a turn
   * that is already going badly. A sink that throws, rejects, or is slow must
   * not add a second failure on top of the first — so the call is not awaited,
   * its rejection is swallowed, and the in-memory answer is returned regardless.
   * The durable copy is an improvement on this state, never a precondition for
   * it.
   */
  _push(id, observation) {
    if (!this.sink) return;
    try {
      const r = this.sink(id, observation);
      if (r && typeof r.catch === 'function') r.catch(() => { /* the mirror is best-effort */ });
    } catch { /* a broken sink must never break a turn */ }
  }

  /**
   * ADOPT WHAT A PREVIOUS PROCESS LEARNED — selectively, and the selection is
   * the whole design.
   *
   * Called once at startup with rows already fetched from the supervisor. Four
   * rules, and each is a different answer to "is this fact still true?":
   *
   *   A RATE LIMIT WITH A STATED RESET STILL IN THE FUTURE — adopted. This is
   *   the entire reason the durable store exists. The provider named a time; the
   *   time has not arrived; the door is still shut and nothing about a new
   *   process changes that.
   *
   *   A RATE LIMIT WITH NO STATED RESET — NOT adopted as blocking. This is the
   *   restraint that matters most. Inside a live process an unstated reset means
   *   "shut until something says otherwise", because we just watched the refusal
   *   happen. Across a restart it means nothing usable: a limit recorded with no
   *   clock could be twenty seconds old or three days old, and there is no
   *   evidence here to tell them apart. Adopting it would wedge a route shut
   *   with no mechanism that could ever discover it had cleared — a permanent
   *   outage manufactured out of a missing field. The reason text is kept as
   *   context; the door is left openable, and the next request settles it.
   *
   *   A BREAKER — never adopted. It is a guess about reachability derived from
   *   failures THIS process did not see, and a fresh process is right to re-guess.
   *   The original comment on this file was correct about that case and stays.
   *
   *   A STATE A PERSON SET — adopted. "I disabled this route" is a decision, not
   *   an observation, and a decision does not expire because a process did.
   *
   * @param {Array} rows  provider rows from supervisor.providers()
   * @returns {{adopted:number, limited:number, decisions:number}}
   */
  hydrate(rows, now = Date.now()) {
    const out = { adopted: 0, limited: 0, decisions: 0 };
    if (!Array.isArray(rows)) return out;
    for (const row of rows) {
      const id = String((row && row.id) || '');
      if (!id) continue;

      const statusWord = String((row && row.status) || '');
      if (USER_SET.has(statusWord)) {
        const e = this._entry(id);
        e.status = statusWord;
        e.reason = String(row.reason || '');
        this.hydrated.add(id);
        out.adopted += 1;
        out.decisions += 1;
        continue;
      }

      // A STATED RESET, AND STILL IN THE FUTURE. Both halves are required; see
      // the second rule above for why the unstated case is deliberately dropped.
      const resetAt = Number(row && row.reset_at) || 0;
      if (row && row.rate_limited && resetAt > now) {
        const e = this._entry(id);
        // HISTORICAL, NOT LIVE (§48, 2026-09-18). A limit observed by an earlier
        // process is kept for `/provider` diagnostics only: it no longer shuts
        // the door or paints the primary UI, because a restarted runtime showing
        // a red warning nobody in this process observed was the reported defect.
        // The next real request re-establishes the live state either way.
        e.historicalLimit = { resumeAt: resetAt, reason: String(row.reason || 'rate limited') };
        e.reason = String(row.reason || 'rate limited');
        this.hydrated.add(id);
        out.adopted += 1;
        out.limited += 1;
      }
    }
    return out;
  }

  _entry(id) {
    const key = String(id || 'unknown');
    if (!this.state.has(key)) {
      this.state.set(key, { id: key, status: STATUS.UNKNOWN, reason: '', consecutiveFailures: 0, lastOkAt: 0, lastFailAt: 0, openedAt: 0 });
    }
    return this.state.get(key);
  }

  /** Expire a limit whose time has passed — shared by every reader, so displays agree with the gate. */
  _expire(e, now = Date.now()) {
    if (e.rateLimited && e.resumeAt && e.resumeAt <= now) { e.rateLimited = false; e.resumeAt = 0; }
    if (e.rateLimited && !e.resumeAt && now - (e.limitedAt || 0) >= UNKNOWN_RESET_MS) e.rateLimited = false;
    return e;
  }

  get(id) { return { ...this._expire(this._entry(id)) }; }

  /** THE one answer to "is this route rate limited right now?" — expiry included. */
  limitActive(id, now = Date.now()) {
    const e = this._entry(id);
    if (!e.rateLimited) return false;
    if (e.resumeAt) return e.resumeAt > now;
    return now - (e.limitedAt || 0) < UNKNOWN_RESET_MS;
  }
  all() { return [...this.state.values()].map((e) => ({ ...e })); }

  /** Learned from a request that already happened. Zero extra traffic. */
  noteSuccess(id) {
    const e = this._entry(id);
    // MIRRORED EVEN WHEN THE USER'S CHOICE WINS BELOW, because the supervisor
    // applies the same rule to its own row and needs to see the observation to
    // record `last_success` — the field that answers "when did this route last
    // actually work", which is the question `/provider status` asks about a
    // route somebody disabled and has forgotten about.
    this._push(id, { ok: true, kind: '', reason: '', resetAt: 0 });
    if (USER_SET.has(e.status)) return this.get(id); // the user's choice wins
    e.status = STATUS.AVAILABLE;
    e.reason = '';
    e.consecutiveFailures = 0;
    e.openedAt = 0;
    e.lastOkAt = Date.now();
    // A REQUEST THAT WORKED IS THE PROOF A LIMIT HAS CLEARED. Leaving the
    // countdown behind would keep the model list saying "rate limited · 2h" for
    // a route that had just answered — the one thing a status must never do.
    e.rateLimited = false;
    e.resumeAt = 0;
    return this.get(id);
  }

  noteFailure(id, classified) {
    const e = this._entry(id);
    // THE ONE PLACE A LIMIT'S CLOCK CROSSES THE PROCESS BOUNDARY.
    //
    // `retryAfterMs` is a duration and the store keeps an absolute time, so the
    // conversion happens exactly here, once, against the same `Date.now()` the
    // in-memory copy below uses — the two must not be able to disagree by the
    // width of a socket call. A missing or zero duration stays zero, which the
    // whole stack reads as THE PROVIDER DID NOT SAY rather than as "clears now".
    const retryMs = Number(classified && classified.retryAfterMs) || 0;
    this._push(id, {
      ok: false,
      kind: String((classified && classified.kind) || ''),
      reason: String((classified && classified.message) || ''),
      resetAt: retryMs > 0 ? Date.now() + retryMs : 0,
    });
    if (USER_SET.has(e.status)) return this.get(id);
    // An AUTH failure is NOT an availability problem — the server answered.
    if (classified && classified.kind === 'AUTH') {
      e.reason = classified.message || 'authentication failed';
      return this.get(id);
    }
    e.consecutiveFailures += 1;
    e.lastFailAt = Date.now();
    e.reason = (classified && classified.message) || 'request failed';
    // ---- WHEN A RATE LIMIT CLEARS, remembered on the CONNECTION ------------
    //
    // So the model list can say "rate limited · 3h 59m" beside the route, not
    // only in the strip of whichever turn happened to hit it. Choosing a model
    // is exactly the moment you want to know which routes are callable, and
    // "which of these can I actually use right now" was not answerable there.
    if (classified && classified.kind === 'RATE_LIMITED') {
      e.rateLimited = true;
      e.limitedAt = Date.now();
      e.resumeAt = Number(classified.retryAfterMs) > 0 ? Date.now() + Number(classified.retryAfterMs) : 0;
    }
    if (e.consecutiveFailures >= this.failureThreshold) {
      e.status = STATUS.UNAVAILABLE;
      e.openedAt = Date.now();
    } else {
      e.status = STATUS.DEGRADED;
    }
    return this.get(id);
  }

  /**
   * Checked BEFORE any socket. A connection already known to be down costs zero
   * requests and zero waiting.
   */
  shouldAttempt(id, now = Date.now()) {
    const e = this._entry(id);
    if (e.status === STATUS.DISABLED) return { allow: false, status: e.status, reason: 'disabled by you', retryAfterMs: 0 };
    if (e.status === STATUS.MAINTENANCE) return { allow: false, status: e.status, reason: 'in maintenance', retryAfterMs: 0 };

    // ---- A KNOWN RATE LIMIT IS A CLOSED DOOR, AND IT HAS A CLOCK ON IT ----
    //
    // The breaker below counts FAILURES and opens after two of them. A rate
    // limit needs neither the count nor the guess: the server has already said
    // when to come back, so a request sent before then is guaranteed to be
    // refused, and sending it anyway is the retry loop this prevents.
    //
    // Distinguished from the breaker on purpose. `UNAVAILABLE` means "we do not
    // know if it is up"; this means "we know it is up and it will say no until
    // a stated time" — and only the second one has an alternative worth
    // offering, because the same model on another provider is very likely fine.
    // See failover.js.
    if (e.rateLimited && e.resumeAt > now) {
      return {
        allow: false,
        status: e.status,
        rateLimited: true,
        reason: e.reason || 'rate limited',
        resumeAt: e.resumeAt,
        retryAfterMs: e.resumeAt - now,
      };
    }
    // The limit has expired: it is over until something says otherwise, so the
    // flag is dropped rather than left to make every future check look blocked.
    if (e.rateLimited && e.resumeAt && e.resumeAt <= now) { e.rateLimited = false; e.resumeAt = 0; }
    // AN UNSTATED RESET IS NOT FOREVER (2026-09-18). One 429 with no Retry-After
    // used to leave `rateLimited` set until a success on that route — and
    // failover never routes to a limited route, so the success never came:
    // three providers read "rate limited · unknown reset" at once and switching
    // models could not escape it. It now expires after a bounded window.
    if (e.rateLimited && !e.resumeAt && now - (e.limitedAt || 0) >= UNKNOWN_RESET_MS) { e.rateLimited = false; }

    if (e.status !== STATUS.UNAVAILABLE) return { allow: true, status: e.status, reason: '' };
    const elapsed = now - (e.openedAt || 0);
    if (elapsed >= this.cooldownMs) return { allow: true, status: e.status, reason: 'cooldown elapsed — one probe allowed', probe: true };
    return { allow: false, status: e.status, reason: e.reason || 'unreachable', retryAfterMs: this.cooldownMs - elapsed };
  }

  // ---- user controls. These MUST work while the provider is dead. ----------
  //
  // A DECISION IS MIRRORED TOO, and it is the one kind of state that SHOULD
  // survive a restart unconditionally. "I turned this route off" does not stop
  // being true because a process ended, and the alternative — a disabled route
  // quietly re-enabling itself on the next launch — is a control that undoes
  // itself. Note the shape: `decision`, never `ok`, so the sink can tell an
  // observation from an instruction. See §19: only a person makes these.
  disable(id, reason = 'disabled by user') {
    const e = this._entry(id); e.status = STATUS.DISABLED; e.reason = reason;
    this._push(id, { decision: 'SET', status: STATUS.DISABLED, reason });
    return this.get(id);
  }

  enable(id) { return this._clear(id); }

  maintenance(id, reason = 'maintenance') {
    const e = this._entry(id); e.status = STATUS.MAINTENANCE; e.reason = reason;
    this._push(id, { decision: 'SET', status: STATUS.MAINTENANCE, reason });
    return this.get(id);
  }

  /** Explicit user retry closes the breaker immediately — no waiting. */
  retry(id) { return this._clear(id); }

  /**
   * Back to knowing nothing, which is what "try it again" means.
   *
   * THE RATE-LIMIT FLAGS ARE CLEARED HERE TOO, and they were not. `/provider
   * retry` closed the breaker and left `rateLimited` set with a resumeAt hours
   * away, so the gate that now reads those (see shouldAttempt) would have kept
   * refusing a route the user had just explicitly re-enabled — a control that
   * appears to work and does nothing.
   */
  _clear(id) {
    const e = this._entry(id);
    e.status = STATUS.UNKNOWN;
    e.reason = '';
    e.consecutiveFailures = 0;
    e.openedAt = 0;
    e.rateLimited = false;
    e.resumeAt = 0;
    // AND IN THE DURABLE COPY, or `/provider retry` becomes a control that works
    // until you restart — which is the same class of bug as the one the comment
    // above records, one process boundary further out. The route would come
    // back rate limited on the next launch, hydrated from a countdown the user
    // had already explicitly dismissed.
    this.hydrated.delete(id);
    this._push(id, { decision: 'CLEAR' });
    // "Try this route again" covers every model behind it.
    if (!String(id).includes('#')) {
      for (const k of [...this.state.keys()]) if (k.startsWith(`${id}#`)) this._clear(k);
    }
    return this.get(id);
  }

  // ---- ROUTE + MODEL ------------------------------------------------------
  //
  // ONE CONNECTION CAN SERVE HUNDREDS OF MODELS (a router: 9router's
  // `lain:localhost` carries 939). Keyed by connection alone, one model's
  // upstream refusal — codex's `[429] usage limit`, a revoked codex token —
  // opened the breaker for EVERY model on the router: switching to
  // kr/claude-sonnet-4.5 showed `availability UNAVAILABLE` and its turn was
  // skipped with zero requests (live, 2026-09-18).
  //
  // So a failure the SERVER ANSWERED (it has an HTTP status) is about the
  // model/account behind the route and is recorded under `conn#model`; a
  // failure with no answer (refused, reset, timed out) is the route itself and
  // stays on the connection. Every reader below consults both, worst wins.

  noteOutcome(connId, model, failure) {
    const scoped = scopeKey(connId, model);
    if (failure) {
      const answered = Number(failure.status) > 0;
      return this.noteFailure(model && answered ? scoped : connId, failure);
    }
    if (model && this.state.has(scoped)) this.noteSuccess(scoped);
    return this.noteSuccess(connId);
  }

  shouldAttemptFor(connId, model, now = Date.now()) {
    const route = this.shouldAttempt(connId, now);
    if (!route.allow || !model || !this.state.has(scopeKey(connId, model))) return route;
    return this.shouldAttempt(scopeKey(connId, model), now);
  }

  getFor(connId, model) {
    const route = this.get(connId);
    if (!model || !this.state.has(scopeKey(connId, model))) return route;
    const m = this.get(scopeKey(connId, model));
    return SEVERITY[m.status] > SEVERITY[route.status] || (m.rateLimited && !route.rateLimited) ? { ...m, id: route.id, scope: 'model' } : route;
  }

  limitActiveFor(connId, model, now = Date.now()) {
    return this.limitActive(connId, now) || Boolean(model && this.state.has(scopeKey(connId, model)) && this.limitActive(scopeKey(connId, model), now));
  }
}

const SEVERITY = { UNKNOWN: 0, AVAILABLE: 0, DEGRADED: 1, UNAVAILABLE: 2, MAINTENANCE: 3, DISABLED: 3 };
function scopeKey(connId, model) { return model ? `${connId || 'unknown'}#${model}` : String(connId || 'unknown'); }

module.exports = { Availability, STATUS, USER_SET, DEFAULTS, UNKNOWN_RESET_MS, scopeKey };
