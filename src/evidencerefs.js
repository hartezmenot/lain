'use strict';

/**
 * ADDRESSABLE EVIDENCE — a deterministic result, computed once, named, and
 * reused while it is still true (2026-09-25).
 *
 *     evidence:e14   lsp.references   generation 91   "fixButton: 7 references in 4 files"
 *     evidence:e15   gug.slice        generation 91   "SearchBar ← SearchPanel …"
 *     evidence:e16   git.diff         generation 91   "2 files, +4 −1"
 *     evidence:e17   focus.artifact   generation 91   the packet built from e14–e16
 *
 * WHY. A large tool result used to be pasted into the conversation, ride every
 * later request, and — once compaction folded it — be re-run to be seen again.
 * An entry here is the result itself, stored once on the session with what it
 * was computed from; a prompt carries its id and a one-line summary, and
 * `recall_evidence` returns the body when the model actually needs it.
 *
 * VALIDITY IS THE PROJECT GENERATION, NOT A CLOCK. Every entry records the
 * generation it was computed at, the files it read (`deps`) and the words whose
 * appearance anywhere would change it (`words` — a new reference to a symbol can
 * land in any file). When the generation moves:
 *
 *   exact     same generation                          → reuse
 *   carried   the changed files touch neither deps     → reuse, re-stamped
 *             nor words
 *   stale     one of them did                          → refused; named, never served
 *
 * So one edit in an unrelated file invalidates nothing, and an edit to the style
 * owner invalidates exactly the entries that read it. The model is never handed
 * evidence whose source generation no longer matches.
 *
 * `key` makes an entry a CACHE SLOT as well: `focus:S3f…` is the focus artifact
 * for that Selection, `lsp.refs:src/a.ts:12:7` the references at a position.
 * put() with a key whose entry is still valid returns the existing entry.
 *
 * Kept on the session (bounded, persisted with it), so a CLI resuming the
 * session can name the same `evidence:e14` the Harness produced.
 */

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 60;
const MAX_CONTENT = 12000;
const MAX_SUMMARY = 240;

function storeOf(session) {
  if (!session) return null;
  if (!session.evidenceRefs || typeof session.evidenceRefs !== 'object' || !Array.isArray(session.evidenceRefs.list)) session.evidenceRefs = { seq: 0, list: [], stats: {} };
  return session.evidenceRefs;
}

function stat(st, name) { st.stats[name] = (st.stats[name] || 0) + 1; }

function rootOf(session) { return (session && session.cwd) || process.cwd(); }
function genNow(root) { try { return require('./projectgen').current(root).n; } catch { return 0; } }

function readSmall(abs) {
  try { const s = fs.statSync(abs); if (!s.isFile() || s.size > 400000) return null; return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

/**
 * DID THE CHANGES SINCE `generation` TOUCH SOMETHING WITH THESE DEPS / WORDS?
 * The one rule, shared with the canonical Selection's carry-forward.
 */
function touched(root, { generation, deps = [], words = [] }, { exhaustive = false } = {}) {
  let changes = [];
  try { changes = require('./projectgen').since(root, generation); } catch { changes = []; }
  if (!changes.length) return { touched: false, files: [] };
  const files = [...new Set(changes.map((c) => c.file))];
  // The change log is bounded: a generation older than it cannot be vouched for.
  const oldest = changes.length ? changes[0].n : Infinity;
  if (oldest > generation + 1 && !exhaustive) return { touched: true, files, why: 'older than the change log' };
  const d = new Set(deps);
  const hit = files.filter((f) => d.has(f));
  if (hit.length) return { touched: true, files: hit, why: 'a file it read changed' };
  const w = words.filter(Boolean);
  if (w.length) {
    for (const f of files) {
      const text = readSmall(path.join(root, f));
      if (text == null || w.some((x) => text.includes(x))) return { touched: true, files: [f], why: text == null ? `${f} is gone or too large to check` : `${f} now mentions it` };
    }
  }
  return { touched: false, files: [] };
}

/** Where an entry stands now: 'exact' | 'carried' | 'stale'. Carried entries are re-stamped. */
function standing(session, e) {
  const root = rootOf(session);
  const now = genNow(root);
  if (e.generation === now) return { state: 'exact' };
  if (e.stale) return { state: 'stale', why: e.stale };
  const t = touched(root, e);
  if (t.touched) { e.stale = `${t.why}: ${t.files.slice(0, 3).join(', ')} (generation ${e.generation} → ${now})`; return { state: 'stale', why: e.stale }; }
  e.carriedFrom = e.carriedFrom != null ? e.carriedFrom : e.generation;
  e.generation = now;
  return { state: 'carried' };
}

/**
 * RECORD A RESULT. With a `key` whose entry is still valid, the existing entry
 * is returned instead (and counted as reused).
 */
function put(session, { kind, key = null, source = '', summary = '', content = '', deps = [], words = [], data = null } = {}) {
  const st = storeOf(session);
  if (!st) return null;
  const root = rootOf(session);
  if (key) {
    const prev = lookup(session, key);
    if (prev.entry && prev.state !== 'stale') return prev.entry;
  }
  st.seq += 1;
  const text = String(content || '');
  const e = {
    id: `e${st.seq}`, kind: String(kind || 'result'), key: key || null, source: String(source || ''),
    summary: String(summary || '').replace(/\s+/g, ' ').slice(0, MAX_SUMMARY),
    content: text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT)}\n[… ${text.length - MAX_CONTENT} more characters not kept]` : text,
    chars: text.length, generation: genNow(root), deps: [...new Set(deps.filter(Boolean))].slice(0, 200), words: [...new Set(words.filter(Boolean))].slice(0, 12),
    data: data == null ? null : data, at: Date.now(), stale: null, carriedFrom: null,
  };
  // A NEW ENTRY FOR A KEY retires the stale one it replaces.
  if (key) st.list = st.list.filter((x) => x.key !== key);
  st.list.push(e);
  if (st.list.length > MAX_ENTRIES) st.list.splice(0, st.list.length - MAX_ENTRIES);
  stat(st, 'computed');
  return e;
}

/** The entry for a cache key and where it stands, counting the outcome. */
function lookup(session, key) {
  const st = storeOf(session);
  if (!st || !key) return { entry: null, state: 'missing' };
  const e = st.list.slice().reverse().find((x) => x.key === key);
  if (!e) { stat(st, 'miss'); return { entry: null, state: 'missing' }; }
  const s = standing(session, e);
  stat(st, s.state === 'stale' ? 'stale' : s.state === 'carried' ? 'carried' : 'hit');
  return { entry: e, state: s.state, why: s.why || '' };
}

/** By id (`e14` or `evidence:e14`). */
function get(session, id) {
  const st = storeOf(session);
  const want = String(id || '').replace(/^evidence:/, '').trim();
  const e = st ? st.list.find((x) => x.id === want) : null;
  if (!e) return { entry: null, state: 'missing' };
  const s = standing(session, e);
  return { entry: e, state: s.state, why: s.why || '' };
}

/** The one-line reference a prompt carries instead of the body. */
function ref(e) { return e ? `evidence:${e.id} (${e.kind}, generation ${e.generation}${e.carriedFrom != null ? `, unchanged since ${e.carriedFrom}` : ''}): ${e.summary}` : ''; }

/** For /api/focus/metrics and the report: counts and the entries without bodies. */
function view(session) {
  const st = storeOf(session);
  if (!st) return { entries: [], stats: {} };
  return { stats: { ...st.stats }, entries: st.list.map((e) => ({ id: e.id, kind: e.kind, key: e.key, source: e.source, summary: e.summary, chars: e.chars, generation: e.generation, carriedFrom: e.carriedFrom, stale: e.stale, deps: e.deps.length })) };
}

function toJSON(session) {
  const st = session && session.evidenceRefs;
  if (!st || !Array.isArray(st.list)) return {};
  return { evidenceRefs: { seq: st.seq, list: st.list.slice(-MAX_ENTRIES).map((e) => ({ ...e, data: null })), stats: {} } };
}
function restore(session, data = {}) {
  const d = data.evidenceRefs;
  session.evidenceRefs = d && Array.isArray(d.list) ? { seq: Number(d.seq) || d.list.length, list: d.list.filter((e) => e && e.id && e.kind), stats: {} } : { seq: 0, list: [], stats: {} };
}

module.exports = { put, get, lookup, standing, touched, ref, view, toJSON, restore, MAX_ENTRIES, MAX_CONTENT };
