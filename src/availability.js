'use strict';

/** AVAILABILITY — "can this connection be reached right now?" */

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
    /** WHERE OBSERVATIONS GO TO OUTLIVE THIS PROCESS. */
    this.sink = null;
    /** Routes whose durable row was adopted at startup. For reporting only. */
    this.hydrated = new Set();
  }

  /** A FACT LEAVING THIS PROCESS, and it may never be allowed to hurt the caller. */
  _push(id, observation) {
    if (!this.sink) return;
    try {
      const r = this.sink(id, observation);
      if (r && typeof r.catch === 'function') r.catch(() => { /* the mirror is best-effort */ });
    } catch { /* a broken sink must never break a turn */ }
  }

  /** ADOPT WHAT A PREVIOUS PROCESS LEARNED — selectively, and the selection is the whole design. */
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
        // HISTORICAL, NOT LIVE (§48, 2026-09-18).
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
    // MIRRORED EVEN WHEN THE USER'S CHOICE WINS BELOW, because the supervisor applies the same rule to its own row and needs to see the observation to…
    this._push(id, { ok: true, kind: '', reason: '', resetAt: 0 });
    if (USER_SET.has(e.status)) return this.get(id); // the user's choice wins
    e.status = STATUS.AVAILABLE;
    e.reason = '';
    e.consecutiveFailures = 0;
    e.openedAt = 0;
    e.lastOkAt = Date.now();
    // A REQUEST THAT WORKED IS THE PROOF A LIMIT HAS CLEARED.
    e.rateLimited = false;
    e.resumeAt = 0;
    return this.get(id);
  }

  noteFailure(id, classified) {
    const e = this._entry(id);
    // THE ONE PLACE A LIMIT'S CLOCK CROSSES THE PROCESS BOUNDARY.
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
    // WHEN A RATE LIMIT CLEARS, remembered on the CONNECTION
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

  /** Checked BEFORE any socket. */
  shouldAttempt(id, now = Date.now()) {
    const e = this._entry(id);
    if (e.status === STATUS.DISABLED) return { allow: false, status: e.status, reason: 'disabled by you', retryAfterMs: 0 };
    if (e.status === STATUS.MAINTENANCE) return { allow: false, status: e.status, reason: 'in maintenance', retryAfterMs: 0 };

    // A KNOWN RATE LIMIT IS A CLOSED DOOR, AND IT HAS A CLOCK ON IT
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
    // AN UNSTATED RESET IS NOT FOREVER (2026-09-18).
    if (e.rateLimited && !e.resumeAt && now - (e.limitedAt || 0) >= UNKNOWN_RESET_MS) { e.rateLimited = false; }

    if (e.status !== STATUS.UNAVAILABLE) return { allow: true, status: e.status, reason: '' };
    const elapsed = now - (e.openedAt || 0);
    if (elapsed >= this.cooldownMs) return { allow: true, status: e.status, reason: 'cooldown elapsed — one probe allowed', probe: true };
    return { allow: false, status: e.status, reason: e.reason || 'unreachable', retryAfterMs: this.cooldownMs - elapsed };
  }

  // user controls. These MUST work while the provider is dead.
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

  /** Back to knowing nothing, which is what "try it again" means. */
  _clear(id) {
    const e = this._entry(id);
    e.status = STATUS.UNKNOWN;
    e.reason = '';
    e.consecutiveFailures = 0;
    e.openedAt = 0;
    e.rateLimited = false;
    e.resumeAt = 0;
    // AND IN THE DURABLE COPY, or `/provider retry` becomes a control that works until you restart — which is the same class of bug as the one the comment…
    this.hydrated.delete(id);
    this._push(id, { decision: 'CLEAR' });
    // "Try this route again" covers every model behind it.
    if (!String(id).includes('#')) {
      for (const k of [...this.state.keys()]) if (k.startsWith(`${id}#`)) this._clear(k);
    }
    return this.get(id);
  }

  // ROUTE + MODEL

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
