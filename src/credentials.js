'use strict';

/** CREDENTIAL REFERENCES — the one boundary a secret crosses. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REF_RE = /^cred:[a-z0-9][a-z0-9._-]{0,80}:[a-z_]{2,24}$/i;

/** The OS store, or — tests only — an in-memory one. */
let backend = null;
function store_() { return backend || require('./secretstore'); }
function useBackend(b) { backend = b || null; cache.clear(); }
function memoryBackend() {
  const m = new Map();
  return { available: () => ({ ok: true, kind: 'memory' }), put: (n, s) => { m.set(n, String(s)); return { ok: true }; }, get: (n) => (m.has(n) ? m.get(n) : null), has: (n) => m.has(n), remove: (n) => m.delete(n), _map: m };
}

const cache = new Map();   // ref -> secret, this process only

function metaFile() { return path.join(require('./config').configDir(), 'credentials.json'); }
// Memoised on mtime+size (Phase 8.1): describe() asked once per reference per listing.
let metaMemo = null;
function readMeta() {
  let st = null;
  try { st = fs.statSync(metaFile()); } catch { st = null; }
  const sig = st ? metaFile() + '|' + st.mtimeMs + '|' + st.size : metaFile() + '|none';
  if (metaMemo && metaMemo.sig === sig) return JSON.parse(metaMemo.json);
  let d;
  try { d = JSON.parse(fs.readFileSync(metaFile(), 'utf8')); d = d && d.refs ? d : { version: 1, refs: {} }; } catch { d = { version: 1, refs: {} }; }
  metaMemo = { sig, json: JSON.stringify(d) };
  return d;
}
function writeMeta(d) {
  fs.mkdirSync(path.dirname(metaFile()), { recursive: true });
  fs.writeFileSync(`${metaFile()}.tmp`, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(`${metaFile()}.tmp`, metaFile());
  metaMemo = null;
}

function ref(owner, kind = 'api_key') {
  const o = String(owner || '').toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 80);
  const r = `cred:${o}:${kind}`;
  if (!REF_RE.test(r)) throw new Error('a credential reference names an owner and a kind');
  return r;
}
function isRef(r) { return REF_RE.test(String(r || '')); }
/** secretstore names are [a-z0-9._-]; a reference maps onto one deterministically. */
function blobName(r) { return String(r).replace(/:/g, '.'); }

function mask(secret) {
  const s = String(secret || '');
  return s.length >= 12 ? `••••${s.slice(-4)}` : '••••';
}

/** Keep a secret under a reference. Returns what may be shown — never the secret. */
function store(r, secret, { kind = 'api_key' } = {}) {
  if (!isRef(r)) return { ok: false, why: 'not a credential reference' };
  const s = String(secret || '');
  if (!s) return { ok: false, why: 'nothing to store' };
  require('./redact').register(s);
  const put = store_().put(blobName(r), s);
  if (!put.ok) return { ok: false, why: put.why || 'the secret store refused' };
  cache.set(r, s);
  try { require('./appcatalog').invalidate(); } catch { /* not loaded */ }
  const d = readMeta();
  d.refs[r] = { kind, masked: mask(s), fingerprint: crypto.createHash('sha256').update(s).digest('hex').slice(0, 12), storedAt: new Date().toISOString() };
  writeMeta(d);
  return { ok: true, ref: r, ...describe(r) };
}

/** INTERNAL: the secret, for the request about to be sent. Never for display. */
function resolve(r) {
  if (!isRef(r)) return '';
  if (cache.has(r)) return cache.get(r);
  const s = store_().get(blobName(r));
  if (!s) return '';
  require('./redact').register(s);
  cache.set(r, s);
  return s;
}

/** WARM THE CACHE for several references in one secret-store call (Phase 8.1). */
function prefetch(refs) {
  // (a key the launch warm-up is already reading is left to it — prefetchAsync, below)
  const want = [...new Set((refs || []).filter((r) => isRef(r) && !cache.has(r) && !inflight.has(r)))];
  if (want.length < 2 || typeof store_().getMany !== 'function') return;
  let got = {};
  try { got = store_().getMany(want.map(blobName)) || {}; } catch { return; }
  for (const r of want) {
    const s = got[blobName(r)];
    if (!s) continue;
    require('./redact').register(s);
    cache.set(r, s);
  }
}

/** WARM THE CACHE WITHOUT BLOCKING (Phase 8.2) — started first thing at launch, so the first listing (the header, the dashboard) finds the keys already… */
let warming = Promise.resolve();
const inflight = new Set();
function prefetchAsync(refs) {
  const want = [...new Set((refs || []).filter((r) => isRef(r) && !cache.has(r) && !inflight.has(r)))];
  if (!want.length || typeof store_().getManyAsync !== 'function') return warming;
  for (const r of want) inflight.add(r);
  warming = store_().getManyAsync(want.map(blobName)).then((got) => {
    for (const r of want) {
      const s = got && got[blobName(r)];
      if (!s || cache.has(r)) continue;
      require('./redact').register(s);
      cache.set(r, s);
    }
  }, () => { /* resolve() reads them when needed */ }).then(() => {
    for (const r of want) inflight.delete(r);
    // THE LISTINGS BUILT WHILE THE KEYS WERE ON THEIR WAY are rebuilt with them (connections.js).
    try { require('./appcatalog').invalidate(); } catch { /* not loaded */ }
  });
  return warming;
}
/** Resolves when the launch warm-up (if any) has finished. */
function warmed() { return warming; }
/** Already read this run (a resolve() will not touch the secret store). */
function cached(r) { return cache.has(r); }
/** The secret exists — a file check, no decryption (listings use this; a request reads the secret itself). */
function present(r) { return isRef(r) && (cache.has(r) || store_().has(blobName(r))); }
/** READ ONE SECRET WITHOUT BLOCKING, right before the request that needs it (provider.chat). */
async function ensure(r) {
  if (!isRef(r) || cache.has(r)) return;
  if (inflight.has(r)) { await warming; if (cache.has(r)) return; }
  await prefetchAsync([r]);
}
/** A key the launch warm-up is still reading (a listing need not wait for it; connections.js). */
function pending(r) { return inflight.has(r) && !cache.has(r); }

/** What a person may see about a reference. */
function describe(r) {
  const m = readMeta().refs[r];
  if (!m) return { ref: r, present: store_().has(blobName(r)), masked: null, kind: null, storedAt: null };
  return { ref: r, present: store_().has(blobName(r)), masked: m.masked, kind: m.kind, storedAt: m.storedAt, fingerprint: m.fingerprint };
}

function remove(r) {
  if (!isRef(r)) return false;
  cache.delete(r);
  try { require('./appcatalog').invalidate(); } catch { /* not loaded */ }
  const gone = store_().remove(blobName(r));
  const d = readMeta();
  const had = Boolean(d.refs[r]);
  delete d.refs[r];
  if (had) writeMeta(d);
  return Boolean(gone || had);
}

function list() { return Object.keys(readMeta().refs).map(describe); }

/** THE GUARD: does any secret this process has seen appear in `value`? */
function leaks(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const s of cache.values()) if (s && s.length >= 8 && text.includes(s)) return true;
  return false;
}

module.exports = {
  cached, present, ensure, ref, isRef, store, resolve, prefetch, prefetchAsync, warmed, pending, describe, remove, list, mask, leaks, useBackend, memoryBackend, REF_RE };
