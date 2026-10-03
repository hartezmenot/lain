'use strict';

/** CANONICAL BYTES — the same state serialises to the same bytes, every time (2026-09-24). */

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
