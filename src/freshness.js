'use strict';

/** FRESHNESS — whether what LAIN knows about the project still matches the disk. */

const fs = require('fs');
const path = require('path');

const STATE = Object.freeze({ FRESH: 'FRESH', STALE: 'STALE', PARTIAL: 'PARTIAL', UNKNOWN: 'UNKNOWN' });

/** Never descended into by the watcher's consumers: machine state and dependencies. */
const IGNORE = /(^|\/)(\.lain|\.noema|\.git|node_modules|__pycache__|target|dist|build|\.next|\.venv|venv)(\/|$)/;
/** Past this many dirty paths the targeted refresh is no cheaper than the walk. */
const OVERFLOW = 2000;

function norm(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, ''); }
/** THE REAL PATH, ALWAYS. */
function realRoot(root) {
  const r = path.resolve(String(root));
  try { return fs.realpathSync.native(r); } catch { return r; }
}
function keyOf(root) { const r = realRoot(root); return process.platform === 'win32' ? r.toLowerCase() : r; }

const trackers = new Map();

/** START WATCHING A PROJECT. */
function track(root) {
  const k = keyOf(root);
  if (trackers.has(k)) return trackers.get(k);
  const t = { root: realRoot(root), dirty: new Set(), overflow: false, generation: 0, startedAt: Date.now(), available: false, watcher: null };
  try {
    t.watcher = fs.watch(t.root, { recursive: true, persistent: false }, (event, filename) => {
      if (!filename) { t.overflow = true; t.generation += 1; return; }
      const rel = norm(filename);
      if (IGNORE.test(rel)) return;
      t.dirty.add(rel);
      t.generation += 1;
      if (t.dirty.size > OVERFLOW) t.overflow = true;
    });
    t.watcher.on('error', () => { t.available = false; t.overflow = true; });
    t.available = true;
  } catch {
    t.available = false;
  }
  trackers.set(k, t);
  return t;
}

function untrack(root) {
  const k = keyOf(root);
  const t = trackers.get(k);
  if (t && t.watcher) { try { t.watcher.close(); } catch { /* already closed */ } }
  trackers.delete(k);
}

function trackerOf(root) { return trackers.get(keyOf(root)) || null; }

/** LAIN's own write, marked the same way an external one is. */
function markChanged(root, absPaths) {
  const t = trackerOf(root);
  const r = path.resolve(String(root));
  const real = realRoot(root);
  for (const p of absPaths || []) {
    let rel = norm(path.isAbsolute(p) ? path.relative(r, p) : p);
    if (rel.startsWith('..') && path.isAbsolute(p)) rel = norm(path.relative(real, p));
    if (!rel || rel.startsWith('..')) continue;
    if (t) t.dirty.add(rel);
  }
  if (t) t.generation += 1;
}

/** THE PATHS A TARGETED REFRESH MUST RE-MEASURE, or null when it cannot be targeted (no watcher, overflow, or an index built before watching began). */
function pending(root, indexRefreshedAt = 0) {
  const t = trackerOf(root);
  if (!t || !t.available || t.overflow) return null;
  if (!indexRefreshedAt || indexRefreshedAt < t.startedAt) return null;
  return [...t.dirty];
}

/** The refresh absorbed these; they are clean until the next event. */
function consume(root, rels, { full = false } = {}) {
  const t = trackerOf(root);
  if (!t) return;
  if (full) { t.dirty.clear(); t.overflow = false; return; }
  for (const r of rels || []) t.dirty.delete(norm(r));
}

function isDirty(root, rel) {
  const t = trackerOf(root);
  return Boolean(t && (t.overflow || t.dirty.has(norm(rel))));
}

// ---------------------------------------------------------------- evidence --

function fingerprintOf(root, rel) {
  const f = require('./readreceipts').contentFingerprint(path.resolve(String(root), String(rel)));
  return f ? f.fp : null;
}

/** STAMP THE EVIDENCE a piece of knowledge is established against: the content fingerprint of each path that exists now. */
function stamp(root, rels) {
  const out = [];
  const seen = new Set();
  for (const raw of rels || []) {
    const rel = norm(raw);
    if (!rel || seen.has(rel) || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    seen.add(rel);
    let st = null;
    try { st = fs.statSync(path.resolve(String(root), rel)); } catch { st = null; }
    if (!st) { out.push({ path: rel, fp: null, kind: 'absent' }); continue; }
    if (!st.isFile()) { out.push({ path: rel, fp: null, kind: 'dir' }); continue; }
    out.push({ path: rel, fp: fingerprintOf(root, rel), kind: 'file' });
  }
  return { evidence: out, at: Date.now() };
}

/** IS KNOWLEDGE ESTABLISHED AGAINST THIS EVIDENCE STILL TRUE OF THE DISK? */
function ofEvidence(root, evidence) {
  const rows = Array.isArray(evidence) ? evidence : [];
  if (!rows.length) return { state: STATE.UNKNOWN, stale: [], unchecked: [] };
  const stale = [];
  const unchecked = [];
  let fresh = 0;
  for (const e of rows) {
    if (!e || !e.path) continue;
    if (e.kind === 'dir') { unchecked.push(e.path); continue; }
    const now = fingerprintOf(root, e.path);
    if (e.kind === 'absent') { if (now) stale.push(e.path); else unchecked.push(e.path); continue; }
    if (now === e.fp) fresh += 1; else stale.push(e.path);
  }
  if (stale.length) return { state: STATE.STALE, stale, unchecked };
  if (unchecked.length && fresh) return { state: STATE.PARTIAL, stale, unchecked };
  if (unchecked.length) return { state: STATE.UNKNOWN, stale, unchecked };
  return { state: STATE.FRESH, stale, unchecked };
}

/** Paths a free-text evidence note names, that exist under the root. */
function pathsIn(root, text) {
  const out = [];
  for (const m of String(text || '').matchAll(/[A-Za-z0-9_.\-/\\]+\.[A-Za-z0-9]{1,6}/g)) {
    const rel = norm(m[0]);
    if (rel.startsWith('..')) continue;
    try { if (fs.statSync(path.resolve(String(root), rel)).isFile()) out.push(rel); } catch { /* not a path */ }
  }
  return [...new Set(out)].slice(0, 12);
}

// ------------------------------------------------------------------ layers --

/** One indexed file against the disk. */
function ofIndexFile(root, index, rel) {
  const e = index && index.files && index.files[norm(rel)];
  if (!e) return STATE.UNKNOWN;
  let st;
  try { st = fs.statSync(path.resolve(String(root), norm(rel))); } catch { return STATE.STALE; }
  if (st.size !== e.size || Math.floor(st.mtimeMs) !== e.mtime) return STATE.STALE;
  if (isDirty(root, rel)) return STATE.STALE;
  return e.lang === 'js' ? STATE.FRESH : STATE.PARTIAL;
}

/** An architecture node, from what the reconciler observed. */
function ofNode(node) {
  const o = (node && node.observed) || {};
  if (!node || !node.location) return STATE.UNKNOWN;
  if (o.status === 'DRIFTED' || o.status === 'MISSING' || o.status === 'DAMAGED') return STATE.STALE;
  if (o.status === 'PRESENT') return node.verification && node.verification.fingerprint ? STATE.FRESH : STATE.PARTIAL;
  return STATE.UNKNOWN;
}

/** A concept, a remembered fact, a validation row: whatever evidence it carries. */
function ofRecord(root, record) {
  return ofEvidence(root, record && record.proof).state;
}

/** A wiring edge depends on both ends. The worse end decides. */
function ofEdge(root, edge, model) {
  const order = [STATE.STALE, STATE.UNKNOWN, STATE.PARTIAL, STATE.FRESH];
  const states = [];
  for (const id of [edge && edge.from, edge && edge.to]) {
    const node = model && model.nodes ? model.nodes[id] : null;
    states.push(node ? ofNode(node) : STATE.UNKNOWN);
  }
  if (edge && Array.isArray(edge.proof)) states.push(ofEvidence(root, edge.proof).state);
  return order.find((s) => states.includes(s)) || STATE.UNKNOWN;
}

function tally(states) {
  const out = { FRESH: 0, STALE: 0, PARTIAL: 0, UNKNOWN: 0 };
  for (const s of states) out[s] = (out[s] || 0) + 1;
  return out;
}

/** EVERY LAYER'S FRESHNESS, COUNTED. */
function report(root) {
  const lainstore = require('./lainstore');
  const index = require('./projectindex').load(root);
  const rels = Object.keys(index.files || {});
  const indexStates = rels.map((r) => ofIndexFile(root, index, r));
  const symbolStates = rels.filter((r) => (index.files[r].symbols || []).length).map((r) => ofIndexFile(root, index, r));
  const importStates = rels.filter((r) => (index.files[r].imports || []).length).map((r) => ofIndexFile(root, index, r));
  const base = lainstore.read(root, 'baseline', null);
  const baseStates = base && base.files ? Object.entries(base.files).map(([rel, b]) => baselineState(root, rel, b)) : [];
  let model = null;
  try { model = require('./architecture').load(root); } catch { model = null; }
  const nodes = model && model.nodes ? Object.values(model.nodes) : [];
  let dict = null;
  try { dict = require('./dictionary').load(root); } catch { dict = null; }
  let graph = null;
  try { graph = require('./wiring').load(root); } catch { graph = null; }
  const memory = lainstore.read(root, 'memory', null);
  const validation = lainstore.read(root, 'validation', null);
  return {
    index: tally(indexStates),
    symbols: tally(symbolStates),
    imports: tally(importStates),
    fingerprints: tally(baseStates),
    architecture: tally(nodes.map(ofNode)),
    concepts: tally(dict ? Object.values(dict.terms || {}).map((e) => ofRecord(root, e)) : []),
    wiring: tally(graph ? (graph.edges || []).map((e) => ofEdge(root, e, model)) : []),
    memory: tally(memory && Array.isArray(memory.facts) ? memory.facts.map((f) => ofRecord(root, f)) : []),
    validation: tally(validation && Array.isArray(validation.checks) ? validation.checks.map((c) => ofRecord(root, c)) : []),
    dirty: (trackerOf(root) && trackerOf(root).dirty.size) || 0,
    watching: Boolean(trackerOf(root) && trackerOf(root).available),
  };
}

/** One line per layer for a surface. */
function describe(r) {
  const row = (name, t) => {
    const n = t.FRESH + t.STALE + t.PARTIAL + t.UNKNOWN;
    if (!n) return `  ${name.padEnd(13)} none recorded`;
    return `  ${name.padEnd(13)} ${['FRESH', 'STALE', 'PARTIAL', 'UNKNOWN'].filter((k) => t[k]).map((k) => `${t[k]} ${k}`).join(' · ')}`;
  };
  return ['PROJECT FRESHNESS (derived from disk now)',
    row('index', r.index), row('symbols', r.symbols), row('imports', r.imports), row('fingerprints', r.fingerprints),
    row('architecture', r.architecture), row('concepts', r.concepts), row('wiring', r.wiring),
    row('memory', r.memory), row('validation', r.validation),
    `  external      ${r.watching ? `watching · ${r.dirty} dirty path(s) awaiting a lazy refresh` : 'not watching — queries re-stat the tree'}`,
  ].join('\n');
}

// ---------------------------------------------------------------- baseline --

/** One baseline row against the disk: the stamp first, the hash only if it moved. */
function baselineState(root, rel, b) {
  const row = b && typeof b === 'object' ? b : { fp: b };
  let st;
  try { st = fs.statSync(path.resolve(String(root), rel)); } catch { return STATE.STALE; }
  if (row.size === st.size && row.mtime === Math.floor(st.mtimeMs)) return STATE.FRESH;
  if (String(row.fp).startsWith('size:')) return STATE.PARTIAL;
  return fingerprintOf(root, rel) === row.fp ? STATE.FRESH : STATE.STALE;
}

const baselined = new Set();

/** MEASURE THE PROJECT BEFORE LAIN FIRST WRITES TO IT. */
function ensureBaseline(root) {
  const r = path.resolve(String(root || ''));
  const k = keyOf(r);
  if (baselined.has(k)) return false;
  baselined.add(k);
  if (!r || r === path.parse(r).root || r === path.resolve(require('os').homedir())) return false;
  const lainstore = require('./lainstore');
  if (lainstore.has(r, 'baseline')) return false;
  try { require('./bootstrap').baseline(r); return true; } catch { return false; }
}

module.exports = {
  STATE, IGNORE, track, untrack, trackerOf, markChanged, pending, consume, isDirty,
  stamp, ofEvidence, pathsIn, ofIndexFile, ofNode, ofRecord, ofEdge, report, describe,
  ensureBaseline, fingerprintOf, baselineState, _baselined: baselined,
};
