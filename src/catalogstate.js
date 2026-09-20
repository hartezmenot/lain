'use strict';

/**
 * WHAT A MODEL SOURCE'S CATALOG DISCOVERY LAST SAID — as STATE on the source,
 * not as a warning printed every time `/model` opens.
 *
 * ------------------------------------------------------------------------
 * REPORTED: every `/model` printed a WARN block with the provider's raw JSON:
 *
 *   lain:custom: could not read a model list — 401 Authorization Required —
 *     {"error":"UNAUTHORIZED","message":"Invalid TokenFaucet API key."}
 *   lain:api.b.ai: could not read a model list — 405 Not Allowed —
 *     {"error":{"message":"Method not allowed for this endpoint. Use POST."}}
 *
 * Two different failures, and neither was remembered: a failure wrote no cache,
 * so each launch asked again, and `ensureCatalog` printed the whole response.
 *
 *   401/403  AUTH_REQUIRED         the credential is rejected; asking again with
 *                                  the SAME credential cannot succeed
 *   404/405  CATALOG_UNAVAILABLE   this endpoint does not enumerate models the
 *   /501                           OpenAI way — inference compatibility is not
 *                                  catalog compatibility; asking again with the
 *                                  same URL cannot succeed either
 *   429      RATE_LIMITED          quota semantics, never an auth or catalog
 *                                  verdict; retried after a short wait
 *   other    UNREACHABLE           network, timeout, 5xx; retried after a wait
 *
 * A record is keyed by a FINGERPRINT of the base URL and the credential, so
 * fixing either one (a new key through `/api`, a corrected URL) is a different
 * source and is asked again at once. Nothing here deletes a connection or
 * touches a credential. `/model refresh` always asks, whatever is recorded.
 *
 * The raw response is KEPT on the record (diagnostics, `/model refresh`) and
 * never printed on its own into the transcript.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE = Object.freeze({
  OK: 'OK',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  CATALOG_UNAVAILABLE: 'CATALOG_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  UNREACHABLE: 'UNREACHABLE',
});

/** How the picker and the one-line notice name each state. */
const LABEL = Object.freeze({
  AUTH_REQUIRED: 'auth required',
  CATALOG_UNAVAILABLE: 'catalog unavailable',
  RATE_LIMITED: 'rate limited',
  UNREACHABLE: 'unreachable',
});

/** Transient failures are asked about again after this; stable ones are not. */
const RETRY_MS = 10 * 60 * 1000;
const STABLE = new Set([STATE.AUTH_REQUIRED, STATE.CATALOG_UNAVAILABLE]);

function classify(status) {
  const s = Number(status) || 0;
  if (s === 401 || s === 403) return STATE.AUTH_REQUIRED;
  if (s === 404 || s === 405 || s === 501) return STATE.CATALOG_UNAVAILABLE;
  if (s === 429) return STATE.RATE_LIMITED;
  return STATE.UNREACHABLE;
}

/** Which URL and which credential this verdict was about. Never the credential itself. */
function fingerprint(conn) {
  return crypto.createHash('sha256')
    .update(`${(conn && conn.baseUrl) || ''}|${(conn && conn.apiKey) || ''}`)
    .digest('hex').slice(0, 16);
}

function file(id) {
  const dir = path.join(require('./config').configDir(), 'catalog');
  return path.join(dir, String(id).replace(/[^a-zA-Z0-9._-]/g, '_') + '.state.json');
}

function read(conn) {
  try { return JSON.parse(fs.readFileSync(file(conn.id), 'utf8')); } catch { return null; }
}

/** The recorded verdict for this source as it is configured NOW, or null. */
function of(conn) {
  const r = read(conn);
  return r && r.fingerprint === fingerprint(conn) ? r : null;
}

/** Should an ordinary (not forced) discovery skip this source? */
function suppressed(conn, now = Date.now()) {
  const r = of(conn);
  if (!r || r.state === STATE.OK) return false;
  if (STABLE.has(r.state)) return true;
  return now - (Number(r.at) || 0) < RETRY_MS;
}

/**
 * Record what discovery said. Returns true when this is a CHANGE — a source
 * that was healthy (or configured differently) is now in this state — which is
 * the only moment worth one line on screen.
 */
function record(conn, result) {
  const prev = of(conn);
  const next = result.ok
    ? { state: STATE.OK }
    : { state: classify(result.status), status: result.status || null, raw: String(result.raw || result.error || '').slice(0, 2000), url: result.url || '' };
  const rec = { ...next, id: conn.id, fingerprint: fingerprint(conn), at: Date.now() };
  try {
    fs.mkdirSync(path.dirname(file(conn.id)), { recursive: true });
    fs.writeFileSync(file(conn.id), JSON.stringify(rec), 'utf8');
  } catch { /* an unwritable cache costs a repeat ask next launch, nothing more */ }
  return !prev ? rec.state !== STATE.OK : prev.state !== rec.state;
}

/** Every configured source whose recorded verdict is not OK, for the picker. */
function issues(connections) {
  const out = [];
  for (const c of connections || []) {
    const r = c && c.baseUrl ? of(c) : null;
    if (r && r.state !== STATE.OK) out.push({ id: c.id, state: r.state, label: LABEL[r.state] || r.state });
  }
  return out;
}

/** `lain:custom · auth required` — the whole of what the transcript gets. */
function line(id, state) { return `MODEL SOURCE · ${id} · ${LABEL[state] || String(state).toLowerCase()}`; }

module.exports = { STATE, LABEL, classify, fingerprint, of, suppressed, record, issues, line, RETRY_MS };
