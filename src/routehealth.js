'use strict';

/** DURABLE ROUTE HEALTH — what a route's provider last told us, kept across processes (2026-10-02). */

const fs = require('fs');
const path = require('path');

const USER_SET = new Set(['DISABLED', 'MAINTENANCE']);

let memo = null;   // { mtimeMs, size, data }

function file() { return path.join(require('./config').configDir(), 'route-health.json'); }

function importLegacy() {
  const routes = {};
  try {
    const dir = path.join(require('./supervisor').stateDir(), 'providers');
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.json')) continue;
      try { const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (r && r.id) routes[r.id] = r; } catch { /* skip */ }
    }
  } catch { /* none */ }
  return routes;
}

function read() {
  const f = file();
  let st = null;
  try { st = fs.statSync(f); } catch { st = null; }
  if (!st) {
    const data = { v: 1, routes: importLegacy() };
    if (Object.keys(data.routes).length) write(data);
    memo = null;
    return data;
  }
  if (memo && memo.mtimeMs === st.mtimeMs && memo.size === st.size) return memo.data;
  let data = null;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { data = null; }
  if (!data || typeof data.routes !== 'object') data = { v: 1, routes: {} };
  memo = { mtimeMs: st.mtimeMs, size: st.size, data };
  return data;
}

function write(data) {
  const f = file();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, f);
  } catch { /* health is a cache of observations */ }
  memo = null;
}

function blank(id) {
  return { id, provider: '', model: '', status: 'UNKNOWN', reason: '', consecutive_failures: 0, rate_limited: false, reset_at: null, detected_at: 0, last_success: null, last_failure: null };
}

function update(id, fn) {
  const data = read();
  const before = data.routes[id] ? JSON.stringify(data.routes[id]) : '';
  const h = { ...blank(id), ...(data.routes[id] || {}) };
  fn(h);
  const after = JSON.stringify(h);
  if (after !== before) { data.routes[id] = h; write(data); }
  return h;
}

/** An observation of a request: the same judgement providers.rs `note` made. */
function note({ connectionId, ok = false, kind = '', reason = '', provider = '', model = '', resetAt = 0, failureThreshold = 3 } = {}) {
  const id = String(connectionId || '');
  if (!id) return null;
  const now = Date.now();
  const threshold = Math.max(1, Number(failureThreshold) || 1);
  return update(id, (h) => {
    if (provider) h.provider = String(provider);
    if (model) h.model = String(model);
    if (USER_SET.has(h.status)) return;
    if (ok) {
      // Unchanged success writes nothing: only a change of state is a fact worth a write.
      if (h.status === 'AVAILABLE' && !h.rate_limited && !h.consecutive_failures) { h.last_success = h.last_success || now; return; }
      Object.assign(h, { status: 'AVAILABLE', reason: '', consecutive_failures: 0, rate_limited: false, reset_at: null, last_success: now, detected_at: now });
      return;
    }
    h.last_failure = now;
    if (reason) h.reason = String(reason).slice(0, 300);
    if (kind === 'AUTH') { if (!h.reason) h.reason = 'authentication failed'; return; }
    h.consecutive_failures += 1;
    if (kind === 'RATE_LIMITED') {
      h.rate_limited = true;
      h.reset_at = Number(resetAt) > 0 ? Number(resetAt) : null;
      if (!h.reason) h.reason = 'rate limited';
      h.status = 'DEGRADED';
      h.detected_at = now;
      return;
    }
    h.status = h.consecutive_failures >= threshold ? 'UNAVAILABLE' : 'DEGRADED';
    h.detected_at = now;
  });
}

/** A person's decision (DISABLED / MAINTENANCE), or any status set deliberately. */
function set(id, status, reason = '') {
  const now = Date.now();
  return update(String(id), (h) => {
    h.status = String(status || 'UNKNOWN');
    h.reason = String(reason || '');
    h.detected_at = now;
    if (!USER_SET.has(h.status)) { h.consecutive_failures = 0; h.rate_limited = false; h.reset_at = null; }
  });
}

function clear(id) { return set(id, 'UNKNOWN', ''); }

function limitedNow(h, now = Date.now()) { return Boolean(h && h.rate_limited && (h.reset_at == null || h.reset_at > now)); }

/** Every row, with the derived fields readers print. */
function list(now = Date.now()) {
  return Object.values(read().routes).map((h) => ({ ...h, limited_now: limitedNow(h, now), resets_in_ms: h.reset_at ? Math.max(0, h.reset_at - now) : null }));
}

function get(id) { const h = read().routes[String(id || '')]; return h ? { ...h } : null; }

/** IS THIS ROUTE SHUT? Only a rate limit with a STATED future reset — a missing reset is not a clock. */
function routeShut(connectionId, now = Date.now()) {
  const h = get(connectionId);
  if (!h || !h.rate_limited || !(Number(h.reset_at) > now)) return null;
  return `ROUTE_SHUT: ${h.id || connectionId} is rate limited for another ${Math.max(1, Math.floor((Number(h.reset_at) - now) / 60000))}m`;
}

function _reset() { memo = null; }

module.exports = { note, set, clear, list, get, routeShut, limitedNow, file, USER_SET, _reset };
