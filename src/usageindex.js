'use strict';

/**
 * THE USAGE INDEX (Phase 8.1) — so opening USAGE never re-reads history.
 *
 * Two layers over the receipts (usage.js, <configDir>/usage/receipts-YYYY-MM.jsonl):
 *
 *   ROWS       each receipts file is parsed ONCE per process; afterwards only the
 *              bytes appended since the last read are parsed (the files are
 *              append-only JSONL). A file that shrank or was replaced is re-read.
 *   BUCKETS    hourly aggregates keyed by
 *                hour · provider · account · model · project · session · role · origin
 *              with requests / failed / input / output / reasoning / cache read /
 *              cache write / reported cost. Persisted to usage/index-v1.json with
 *              each file's indexed size, so a NEW PROCESS continues from where the
 *              last one stopped instead of rebuilding (the historical build happens
 *              once). A receipt written by this process updates its bucket as it
 *              is appended.
 *
 *   generation() increments whenever new receipts are seen — the key other caches
 *   (reset windows) invalidate on, instead of recomputing per render.
 *
 * The receipts stay the source of truth; the index is disposable and rebuilt
 * whenever it disagrees with the files (unknown version, a file that shrank).
 */

const fs = require('fs');
const path = require('path');

const VERSION = 1;
const HOUR = 3600 * 1000;
const DIMS = Object.freeze(['provider', 'account', 'model', 'project', 'session', 'role', 'origin']);

let files = new Map();       // name -> { size, mtimeMs, byId: Map(id -> row) }
let gen = 0;
let buckets = null;          // Map(key -> sums), loaded lazily
let indexed = null;          // { [file]: size } the buckets cover
let loadedFor = null;        // the usage dir the state belongs to
let stats = { fullParses: 0, tailParses: 0, bytesParsed: 0 };

function usageDir() { return require('./usage').dir(); }
function indexFile() { return path.join(usageDir(), `index-v${VERSION}.json`); }
function resetIfMoved() {
  const d = usageDir();
  if (loadedFor === d) return;
  loadedFor = d; files = new Map(); buckets = null; indexed = null; gen += 1;
}

function receiptFiles() {
  try { return fs.readdirSync(usageDir()).filter((f) => /^receipts-\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
}

/** Parse `text` (whole lines only) into `into`; returns the number of bytes consumed. */
function parseLines(buf, into, onRow) {
  const last = buf.lastIndexOf(0x0a);
  if (last < 0) return 0;
  const text = buf.slice(0, last + 1).toString('utf8');
  for (const ln of text.split('\n')) {
    if (!ln) continue;
    let r; try { r = JSON.parse(ln); } catch { continue; }
    if (!r || !r.id) continue;
    const had = into.has(r.id);
    into.set(r.id, r);
    if (!had && onRow) onRow(r);
  }
  stats.bytesParsed += last + 1;
  return last + 1;
}

/** Bring one file's row cache up to date — only the appended tail is parsed. */
function refreshFile(name, onRow) {
  const f = path.join(usageDir(), name);
  let st;
  try { st = fs.statSync(f); } catch { files.delete(name); return; }
  let rec = files.get(name);
  if (rec && st.size === rec.size && st.mtimeMs === rec.mtimeMs) return;
  if (!rec || st.size < rec.size) {
    rec = { size: 0, mtimeMs: 0, byId: new Map() };
    files.set(name, rec);
    stats.fullParses += 1;
  } else stats.tailParses += 1;
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const len = st.size - rec.size;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, rec.size);
    rec.size += parseLines(buf, rec.byId, onRow);
    rec.mtimeMs = st.mtimeMs;
    gen += 1;
  } catch { /* read what we can next time */ } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ } }
}

function monthKey(t) { const d = new Date(t); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }

/** Rows in [from, to], oldest first, once per id — from the cache, tail-parsed. */
function rows({ from = 0, to = Date.now() + 1 } = {}) {
  resetIfMoved();
  const loKey = monthKey(from);
  const out = [];
  for (const name of receiptFiles()) {
    if (name.slice(9, 16) < loKey) continue;
    refreshFile(name, null);
    const rec = files.get(name);
    if (!rec) continue;
    for (const r of rec.byId.values()) if (r.at >= from && r.at <= to) out.push(r);
  }
  // An id appears in one file only in practice; dedupe anyway, newest wins.
  const byId = new Map();
  for (const r of out) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

// ---- hourly buckets --------------------------------------------------------------

function blank() { return { requests: 0, failed: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costRows: 0 }; }
function keyFor(r) {
  const h = Math.floor((r.at || 0) / HOUR) * HOUR;
  const origin = r.origin || (() => { try { return require('./usage').originOf(r, r.role); } catch { return ''; } })();
  return [h, ...DIMS.map((d) => (d === 'origin' ? origin : (r[d] == null ? '' : String(r[d]))))].join('\u0001');
}
function add(s, r) {
  s.requests += 1; if (r.ok === false) s.failed += 1;
  s.input += r.input || 0; s.output += r.output || 0; s.reasoning += r.reasoning || 0;
  s.cacheRead += r.cacheRead || 0; s.cacheWrite += r.cacheWrite || 0;
  if (r.costUsd != null) { s.costUsd += r.costUsd; s.costRows += 1; }
}
let bucketIds = null;   // ids already counted in buckets (this process), so a re-read never double counts
let dirty = false;

/** Load the persisted buckets, or build them once from the receipts. */
function ensureBuckets() {
  resetIfMoved();
  if (buckets) return;
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(indexFile(), 'utf8')); } catch { saved = null; }
  const names = receiptFiles();
  const sizes = {};
  for (const n of names) { try { sizes[n] = fs.statSync(path.join(usageDir(), n)).size; } catch { /* gone */ } }
  // The saved index is usable when every file it covered is still at least that long.
  const usable = saved && saved.v === VERSION && saved.files && Object.entries(saved.files).every(([n, s]) => sizes[n] != null && sizes[n] >= s);
  buckets = new Map(); bucketIds = new Set(); indexed = {};
  if (usable) {
    for (const [k, v] of Object.entries(saved.buckets || {})) buckets.set(k, v);
    indexed = { ...saved.files };
    // Continue from where it stopped: count only the bytes past each file's indexed size.
    advance(names);
  } else {
    stats.fullParses += 1;
    for (const n of names) indexed[n] = 0;
    advance(names);
  }
  dirty = true;
  persist();
}
function tailInto(name, offset) {
  const f = path.join(usageDir(), name);
  let fd;
  try {
    const size = fs.statSync(f).size;
    fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, size - offset, offset);
    const seen = new Map();
    const used = parseLines(buf, seen, null);
    for (const r of seen.values()) { if (bucketIds.has(r.id)) continue; bucketIds.add(r.id); const k = keyFor(r); if (!buckets.has(k)) buckets.set(k, blank()); add(buckets.get(k), r); }
    return used;
  } catch { return 0; /* partial */ } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ } }
}
/** THE BUCKETS MOVE FORWARD FROM EACH FILE'S RECORDED OFFSET — whole lines only, never re-counting what they hold. */
function advance(names) {
  for (const n of names || receiptFiles()) {
    let size = 0;
    try { size = fs.statSync(path.join(usageDir(), n)).size; } catch { continue; }
    const from = indexed[n] || 0;
    if (size < from) { indexed[n] = 0; }   // a file that shrank: the next full build corrects it
    else if (size > from) { const used = tailInto(n, from); indexed[n] = from + used; if (used) { dirty = true; gen += 1; } }
  }
}
function persist() {
  if (!dirty || !buckets) return;
  try {
    const obj = {}; for (const [k, v] of buckets) obj[k] = v;
    const sizes = { ...indexed };
    fs.mkdirSync(usageDir(), { recursive: true });
    fs.writeFileSync(`${indexFile()}.tmp`, JSON.stringify({ v: VERSION, at: Date.now(), files: sizes, buckets: obj }));
    fs.renameSync(`${indexFile()}.tmp`, indexFile());
    dirty = false;
  } catch { /* a cache */ }
}

/**
 * AGGREGATES over [from, to] grouped by one dimension (or 'hour'/'day'), from the
 * buckets — no receipt is read. Filters match exact dimension values.
 */
function aggregate({ from = 0, to = Date.now() + 1, by = null, filters = {} } = {}) {
  ensureBuckets();
  // Fold in anything appended since (tail only).
  advance();
  const groups = new Map();
  const total = blank();
  for (const [k, v] of buckets) {
    const parts = k.split('\u0001');
    const h = Number(parts[0]);
    if (h + HOUR <= from || h > to) continue;
    const row = { hour: h }; DIMS.forEach((d, i) => { row[d] = parts[i + 1]; });
    if (Object.entries(filters).some(([d, want]) => want != null && want !== '' && row[d] !== String(want))) continue;
    add2(total, v);
    if (by) {
      const g = by === 'hour' ? String(h) : by === 'day' ? localDay(h) : (row[by] || '(none)');
      if (!groups.has(g)) groups.set(g, blank());
      add2(groups.get(g), v);
    }
  }
  if (dirty) persist();
  return { total, groups: [...groups.entries()].map(([key, s]) => ({ key, ...s })).sort((a, b) => (b.input + b.output) - (a.input + a.output)) };
}
function localDay(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function add2(a, b) { for (const k of Object.keys(a)) a[k] += b[k] || 0; }

/** A receipt this process just appended: counted now, not on the next read. */
function noteAppended() { gen += 1; }

module.exports = { rows, aggregate, ensureBuckets, generation: () => gen, noteAppended, stats: () => ({ ...stats, cachedFiles: files.size, buckets: buckets ? buckets.size : null }), DIMS, _reset() { files = new Map(); buckets = null; indexed = null; bucketIds = null; loadedFor = null; stats = { fullParses: 0, tailParses: 0, bytesParsed: 0 }; gen += 1; } };
