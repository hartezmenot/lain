'use strict';

/**
 * CORE'S CHANGE PROVENANCE — who changed which lines, recorded WHEN it happened.
 *
 * Core owns this record; Laya and the context compilers READ it (they never
 * write or decide provenance).
 *
 * ------------------------------------------------------------------------
 * WHY NOT GIT. A diff says what changed and nothing about who: a line the
 * person typed in the editor and a line the Coding Agent wrote look the same
 * in `git diff`, and by the time anyone asks "what did I change?" the only
 * honest answer left is a guess. So the origin is captured at the one moment
 * it is known:
 *
 *   USER        the IDE editor saved it (POST /api/files/save)
 *   FORMATTER   the editor saved a change its formatter made, and nothing else
 *   AGENT       a LAIN-controlled write — every one passes mutation.js, the
 *               single transaction around source writes; its task id is kept
 *   BOT         reserved: the BOT does not write (tools/index.js refuses it)
 *   EXTENSION   reserved for extension-made edits (none run today)
 *   EXTERNAL    the file changed on disk and LAIN did not write it — seen when
 *               LAIN next looked; WHICH lines is unknown and is said so
 *   UNKNOWN     a caller that could not say
 *
 * ------------------------------------------------------------------------
 * TWO RECORDS, BOTH MACHINE-LOCAL (LAIN's config folder, never the project):
 *
 *   <configDir>/provenance/<projectId>.jsonl     append-only history: one line
 *                                                per change, bounded by rotation
 *   <configDir>/provenance/<projectId>.state.json per file: its last known hash
 *                                                and its REGIONS — which source
 *                                                wrote which lines NOW
 *
 * The regions are the part a history cannot give you. "The person edited lines
 * 72–91" is stale the moment the Agent adds ten lines above them; here every
 * later change SHIFTS earlier regions and clips what it overwrote, so the
 * answer is about the file as it stands. When a change's lines cannot be known
 * (an EXTERNAL write), the file's regions are kept but marked approximate.
 *
 * EVIDENCE, NOT OWNERSHIP. Nothing here locks a line or refuses a write. The
 * Agent is TOLD that the person edited a region recently (focuspacket.js) and
 * decides with that in hand — the task decides what may change.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOURCE = Object.freeze({
  USER: 'USER', AGENT: 'AGENT', BOT: 'BOT', FORMATTER: 'FORMATTER',
  EXTENSION: 'EXTENSION', CORE: 'CORE', TOOL: 'TOOL', EXTERNAL: 'EXTERNAL', UNKNOWN: 'UNKNOWN',
});
/** Who counts as "LAIN" when the person asks what LAIN changed. */
const LAIN_SOURCES = new Set([SOURCE.AGENT, SOURCE.BOT, SOURCE.CORE]);

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_REGIONS = 200;
const DP_CELLS = 400_000;

function dir() { return path.join(require('./config').configDir(), 'provenance'); }
function pid(root) { return require('./journey').projectId(root); }
function logFile(root) { return path.join(dir(), `${pid(root)}.jsonl`); }
function stateFile(root) { return path.join(dir(), `${pid(root)}.state.json`); }
/** A text's identity, independent of a byte-order mark (decoders differ on keeping it). */
function hash(text) { return crypto.createHash('sha256').update(String(text == null ? '' : text).replace(/^﻿/, '')).digest('hex').slice(0, 16); }
function relOf(root, p) {
  const abs = path.resolve(root, String(p));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// ---- the line diff ------------------------------------------------------------------

function lines(text) { return String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n'); }

/**
 * THE CHANGED HUNKS between two texts, in OLD coordinates, 0-based:
 * [{ os, oc, ns, nc }] — old start/count replaced by new start/count. Common
 * prefix and suffix are trimmed first; the middle is an exact LCS when it is
 * small enough and one hunk when it is not (a coarser answer, never a wrong one).
 */
function hunks(before, after) {
  const a = lines(before), b = lines(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let sa = a.length, sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb--; }
  const n = sa - p, m = sb - p;
  if (!n && !m) return [];
  if (!n || !m || n * m > DP_CELLS) return [{ os: p, oc: n, ns: p, nc: m }];
  // LCS table over the middle, then walk it into hunks.
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = a[p + i] === b[p + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[p + i] === b[p + j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { os: p + i, oc: 0, ns: p + j, nc: 0 };
    if (j < m && (i >= n || L[i * w + j + 1] >= L[(i + 1) * w + j])) { cur.nc++; j++; } else { cur.oc++; i++; }
  }
  flush();
  return out;
}

// ---- regions ---------------------------------------------------------------------------

/**
 * APPLY ONE CHANGE TO A FILE'S REGIONS. Regions are 0-based half-open
 * [start, end) line spans with a source. Hunks go bottom-up so each one's old
 * coordinates are still valid when it is applied.
 */
function applyToRegions(regions, hs, entry) {
  let rs = (regions || []).slice();
  const sorted = hs.slice().sort((x, y) => y.os - x.os);
  for (const h of sorted) {
    const delta = h.nc - h.oc;
    const next = [];
    for (const r of rs) {
      if (r.end <= h.os) { next.push(r); continue; }
      if (r.start >= h.os + h.oc) { next.push({ ...r, start: r.start + delta, end: r.end + delta }); continue; }
      if (r.start < h.os) next.push({ ...r, end: h.os });
      if (r.end > h.os + h.oc) next.push({ ...r, start: h.os + h.nc, end: r.end + delta });
    }
    if (h.nc > 0) next.push({ source: entry.source, start: h.ns, end: h.ns + h.nc, at: entry.at, taskId: entry.taskId || null, sessionId: entry.sessionId || null });
    rs = next;
  }
  rs.sort((x, y) => x.start - y.start);
  // Adjacent spans from the same write merge; different writes stay apart.
  const merged = [];
  for (const r of rs) {
    const last = merged[merged.length - 1];
    if (last && last.end >= r.start && last.source === r.source && last.at === r.at) last.end = Math.max(last.end, r.end);
    else if (r.end > r.start) merged.push({ ...r });
  }
  return merged.slice(-MAX_REGIONS);
}

// ---- storage ----------------------------------------------------------------------------

const cache = new Map();   // projectId -> state
// THE STATE FILE IS SHARED BY EVERY PROCESS on the project (the Harness and a
// CLI): a cached copy is used only while the file is the one it was read from.
// Otherwise the Harness would mistake a CLI's recorded edit for an EXTERNAL one
// and then write its stale copy over the CLI's record.
function stampOf(f) { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return null; } }
function load(root) {
  const id = pid(root);
  const f = stateFile(root);
  const stamp = stampOf(f);
  const hit = cache.get(id);
  if (hit && hit._stamp === stamp) return hit;
  let st = { v: 1, root: path.resolve(root), files: {} };
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (d && d.files && typeof d.files === 'object') st = { v: 1, root: path.resolve(root), files: d.files };
  } catch { /* first change in this project */ }
  Object.defineProperty(st, '_stamp', { value: stamp, writable: true, enumerable: false });
  cache.set(id, st);
  return st;
}
function persist(root, st) {
  fs.mkdirSync(dir(), { recursive: true });
  const names = Object.keys(st.files);
  if (names.length > MAX_FILES) {
    names.sort((x, y) => (st.files[x].at || 0) - (st.files[y].at || 0));
    for (const k of names.slice(0, names.length - MAX_FILES)) delete st.files[k];
  }
  const f = stateFile(root);
  fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(st));
  fs.renameSync(`${f}.${process.pid}.tmp`, f);
  if (Object.prototype.hasOwnProperty.call(st, '_stamp')) st._stamp = stampOf(f);
  else Object.defineProperty(st, '_stamp', { value: stampOf(f), writable: true, enumerable: false });
}
function append(root, entry) {
  fs.mkdirSync(dir(), { recursive: true });
  const f = logFile(root);
  try {
    if (fs.statSync(f).size > MAX_LOG_BYTES) {
      const keep = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(f, `${keep.slice(Math.floor(keep.length / 2)).join('\n')}\n`);
    }
  } catch { /* no log yet */ }
  fs.appendFileSync(f, `${JSON.stringify(entry)}\n`);
}

// ---- recording --------------------------------------------------------------------------

/**
 * ONE CHANGE, at the moment it is made. `before`/`after` are the file's text;
 * `before: null` is a new file. Returns the entry, or null when nothing changed.
 * Never throws: provenance is a record, and a record must not cost a save.
 */
function record(root, { source = SOURCE.UNKNOWN, path: p, before = null, after = null, sessionId = null, taskId = null, actor = null, tool = null } = {}) {
  try {
    if (!root || !p) return null;
    const rel = relOf(root, p);
    if (!rel) return null;
    const src = SOURCE[source] ? source : SOURCE.UNKNOWN;
    if (before != null && after != null && before === after) return null;
    const hs = after == null ? [] : hunks(before == null ? '' : before, after);
    const entry = {
      v: 1, at: Date.now(), source: src, path: rel,
      hunks: hs.slice(0, 60).map((h) => [h.ns + 1, h.nc, h.oc]),   // [new start line (1-based), lines now, lines replaced]
      added: hs.reduce((n, h) => n + h.nc, 0), removed: hs.reduce((n, h) => n + h.oc, 0),
      created: before == null && after != null, deleted: after == null,
      sessionId: sessionId || null, taskId: taskId || null,
      actor: actor ? String(actor).slice(0, 60) : null, tool: tool ? String(tool).slice(0, 40) : null,
      hashBefore: before == null ? null : hash(before), hashAfter: after == null ? null : hash(after),
    };
    append(root, entry);
    const st = load(root);
    const f = st.files[rel] || { regions: [] };
    if (after == null) delete st.files[rel];
    else {
      st.files[rel] = {
        hash: entry.hashAfter, at: entry.at,
        regions: applyToRegions(before == null ? [] : f.regions, hs, entry),
        approximate: before == null ? false : Boolean(f.approximate && f.hash !== entry.hashBefore),
      };
    }
    persist(root, st);
    return entry;
  } catch { return null; }
}

/**
 * LAIN LOOKED AT A FILE. If it is not what LAIN last recorded, somebody outside
 * LAIN changed it: an EXTERNAL entry, lines unknown, and the file's regions are
 * marked approximate from here on. Files LAIN has never recorded are ignored —
 * there is no "before" to differ from.
 */
function observe(root, p, text, { sessionId = null } = {}) {
  try {
    const rel = relOf(root, p);
    if (!rel) return null;
    const st = load(root);
    const f = st.files[rel];
    if (!f || f.hash === hash(text)) return null;
    const entry = {
      v: 1, at: Date.now(), source: SOURCE.EXTERNAL, path: rel, hunks: null, added: null, removed: null,
      sessionId, taskId: null, actor: null, tool: null, hashBefore: f.hash, hashAfter: hash(text), linesUnknown: true,
    };
    append(root, entry);
    st.files[rel] = { ...f, hash: entry.hashAfter, at: entry.at, approximate: true };
    persist(root, st);
    return entry;
  } catch { return null; }
}

// ---- reading ------------------------------------------------------------------------------

function entries(root, { rel = null, source = null, since = null, sessionId = null, limit = 200 } = {}) {
  let text = '';
  try { text = fs.readFileSync(logFile(root), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (rel && e.path !== rel) continue;
    if (source && (source === 'Noema' ? !LAIN_SOURCES.has(e.source) : e.source !== source)) continue;
    if (since && e.at < since) continue;
    if (sessionId && e.sessionId !== sessionId) continue;
    out.push(e);
  }
  return out.slice(-limit);
}

/** A file's regions as they stand, 1-based inclusive lines, newest first. */
function regions(root, p) {
  const rel = relOf(root, p);
  if (!rel) return { path: null, regions: [], approximate: false };
  const f = load(root).files[rel];
  if (!f) return { path: rel, regions: [], approximate: false, known: false };
  return {
    path: rel, known: true, approximate: Boolean(f.approximate),
    regions: f.regions.map((r) => ({ source: r.source, startLine: r.start + 1, endLine: r.end, at: r.at, taskId: r.taskId || null }))
      .sort((x, y) => y.at - x.at),
  };
}

/**
 * THE PERSON'S RECENT HAND-EDITS in these files — what the Coding Agent must be
 * told before it works there. Regions as they stand now, so the line numbers
 * are the file's current ones.
 */
function recentUserEdits(root, rels, { withinMs = 24 * 3600_000 } = {}) {
  const now = Date.now();
  const out = [];
  for (const rel of rels || []) {
    const r = regions(root, rel);
    for (const g of r.regions) {
      if (g.source !== SOURCE.USER || now - g.at > withinMs) continue;
      out.push({ path: r.path, startLine: g.startLine, endLine: g.endLine, at: g.at, approximate: r.approximate });
    }
  }
  return out.sort((x, y) => y.at - x.at).slice(0, 40);
}

function ago(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

/** "What did I change?" / "What did LAIN change?" — from the record, never from a diff. */
function summary(root, { source = null, since = null, sessionId = null } = {}) {
  const want = source === 'I' || source === 'ME' ? SOURCE.USER : source;
  const list = entries(root, { source: want, since, sessionId, limit: 2000 });
  const counts = {};
  for (const e of list) counts[e.source] = (counts[e.source] || 0) + 1;
  if (!list.length) {
    return { counts, text: `No ${want ? `${want === 'Noema' ? 'Noema (Agent)' : want} ` : ''}changes are recorded for this project${since ? ' in that period' : ''}. Provenance is recorded from the moment Noema saw each change; earlier history is only in git, without who.` };
  }
  const byFile = new Map();
  for (const e of list) {
    const k = `${e.source} ${e.path}`;
    const cur = byFile.get(k) || { source: e.source, path: e.path, n: 0, added: 0, removed: 0, last: 0, tasks: new Set(), unknown: false };
    cur.n++; cur.added += e.added || 0; cur.removed += e.removed || 0; cur.last = Math.max(cur.last, e.at);
    if (e.taskId) cur.tasks.add(e.taskId);
    if (e.linesUnknown) cur.unknown = true;
    byFile.set(k, cur);
  }
  const rows = [...byFile.values()].sort((x, y) => y.last - x.last).slice(0, 40);
  const lines2 = rows.map((r) => `${r.source.padEnd(9)} ${r.path} — ${r.n} change(s)${r.unknown ? ', lines not known' : `, +${r.added} −${r.removed} lines`}, last ${ago(r.last)}${r.tasks.size ? ` (task ${[...r.tasks].slice(-2).join(', ')})` : ''}`);
  return { counts, text: `${list.length} recorded change(s): ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}\n${lines2.join('\n')}` };
}

/** Forget cached state (tests, and a project whose store was removed). */
function reset() { cache.clear(); }

module.exports = {
  SOURCE, LAIN_SOURCES, hunks, applyToRegions, record, observe, entries, regions, recentUserEdits, summary, reset, hash, logFile, stateFile,
};
