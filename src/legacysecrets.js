'use strict';

/** SENSITIVE LEGACY FILES — plaintext credentials left behind by an older LAIN or Noema build (2026-10-02). */

const fs = require('fs');
const path = require('path');

// A field whose NAME says credential, holding a value long enough to be one.
const SECRET_NAME = /^(?:api[_-]?key|key|token|bot[_-]?token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|bearer)$/i;
// A value whose SHAPE says credential, wherever it sits.
const SECRET_SHAPE = /\bsk-[A-Za-z0-9_-]{20,}|\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b|\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bya29\.[A-Za-z0-9_-]{20,}|\b1\/\/0[A-Za-z0-9_-]{30,}/g;
// Backups and leftovers of the configuration file — never the live config.json, which holds references only.
const CANDIDATE = /^config\.json\..+$/i;

function countIn(text) {
  let n = 0;
  const seen = new Set();
  try {
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        // EVERY FIELD COUNTS (two connections sharing one key are two places to clean); shapes below skip these values.
        if (typeof v === 'string' && v.length >= 12 && SECRET_NAME.test(k) && !/^cred:/.test(v)) { seen.add(v); n++; } else walk(v);
      }
    };
    walk(JSON.parse(text));
  } catch { /* not JSON: shapes only */ }
  for (const m of String(text).match(SECRET_SHAPE) || []) if (!seen.has(m)) { seen.add(m); n++; }
  return n;
}

/** Credential-bearing leftovers beside the live config. Counts only — no value leaves this function. */
function scan(dir = require('./config').configDir()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!CANDIDATE.test(name)) continue;
    const file = path.join(dir, name);
    let text;
    try { const st = fs.statSync(file); if (!st.isFile() || st.size > 4 * 1024 * 1024) continue; text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const count = countIn(text);
    if (count) out.push({ file, name, count });
  }
  return out;
}

/** One line a person can act on, or null. */
function summary(dir) {
  const found = scan(dir);
  if (!found.length) return null;
  const n = found.reduce((a, f) => a + f.count, 0);
  const names = found.map((f) => f.name).join(', ');
  return {
    found,
    text: `Sensitive legacy file detected · ${names} · ${n} credential-like value${n === 1 ? '' : 's'} in plaintext · Action required: delete the file and rotate those keys`,
  };
}

module.exports = { scan, summary, countIn };
