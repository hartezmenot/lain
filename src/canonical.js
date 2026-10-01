'use strict';

/**
 * CANONICAL BYTES — the same state serialises to the same bytes, every time
 * (2026-09-24).
 *
 * A prefix cache keeps the longest identical HEAD of a request. "Semantically
 * equivalent" is worth nothing to it: a key order that follows insertion, a
 * float printed as 40.00000001, a timestamp or an "3 s ago" makes a context
 * block that says the same thing cost as much as a new one. Everything Core
 * renders into a request from structured state (the Harness context packet,
 * a GUG slice, a project delta) goes through here first.
 *
 *   - object keys sorted; `undefined` dropped, `null` kept (UNKNOWN is a value);
 *   - numbers rounded to 2 decimals (sub-pixel noise is not a change);
 *   - no clocks: callers pass generations, never wall time.
 */

const crypto = require('crypto');

function num(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }

function norm(v) {
  if (v === null || v === undefined) return v === null ? null : undefined;
  if (typeof v === 'number') return num(v);
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => { const n = norm(x); return n === undefined ? null : n; });
  const out = {};
  for (const k of Object.keys(v).sort()) {
    const n = norm(v[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

/** JSON with sorted keys and rounded numbers. */
function stringify(v) { return JSON.stringify(norm(v)); }

/** A short content hash of the canonical form. */
function hash(v, n = 16) { return crypto.createHash('sha1').update(typeof v === 'string' ? v : stringify(v)).digest('hex').slice(0, n); }

module.exports = { stringify, hash, norm, num };
