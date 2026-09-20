'use strict';

/**
 * READ COVERAGE — a read that came back elided is not a read that succeeded
 * (2026-09-18, reported live on a ~5,000-line `server.ts`).
 *
 * THE LOOP. A whole-file read larger than the usable context is stubbed or
 * truncated by compaction the moment it lands ("[elided to fit the context
 * window] … Re-run the call if you need it"). The model re-runs it, it is
 * elided again, and the task stalls on evidence it can never obtain.
 *
 * WHAT THIS DOES, in the one tool door every read uses (toolstep.js):
 *
 *   READ_REQUESTED → READ_RETURNED_PARTIAL_OR_ELIDED is recorded per file
 *     (fingerprinted by size+mtime), distinct from a complete read.
 *   A whole-file read of that same unchanged file — or of a file that cannot
 *     fit at all — is NARROWED instead of repeated: the file's outline (line
 *     numbers of its declarations) plus a bounded first window of real lines,
 *     with how to ask for the rest (offset/limit, read_symbol).
 *   The blockage is reported ONCE per file, then the work simply continues:
 *     BLOCKAGE · … ADAPTED · targeted ranges. Never a stop.
 *
 * Ranged reads are never touched — they are the fallback.
 */

const fs = require('fs');
const path = require('path');

/** A whole file larger than this share of the compaction budget cannot survive a turn. */
const TOO_BIG_RATIO = 0.35;
/** The real lines served in the narrowed window. */
const WINDOW_CHARS = 12_000;
const OUTLINE_MAX = 60;

function stateOf(session) {
  if (!session._readCoverage) {
    Object.defineProperty(session, '_readCoverage', { value: new Map(), enumerable: false, writable: true });
    Object.defineProperty(session, '_blockageShown', { value: new Set(), enumerable: false, writable: true });
  }
  return session._readCoverage;
}

const keyOf = (abs) => (process.platform === 'win32' ? String(abs).toLowerCase() : String(abs));

function stamp(abs) {
  try { const st = fs.statSync(abs); return st.isFile() ? { size: st.size, mtime: Math.floor(st.mtimeMs) } : null; } catch { return null; }
}

/** Compaction elided or truncated a whole-file body: record incomplete coverage. */
function noteElided(session, p) {
  if (!session || !p) return;
  const abs = path.isAbsolute(String(p)) ? String(p) : path.resolve(session.cwd || process.cwd(), String(p));
  const s = stamp(abs);
  if (!s) return;
  const st = stateOf(session);
  const prev = st.get(keyOf(abs));
  st.set(keyOf(abs), { ...s, elided: true, times: ((prev && prev.times) || 0) + 1 });
}

function budgetChars(ctx) {
  try {
    const cfg = (ctx && ctx.app && ctx.app.cfg) || {};
    const pc = require('./provider').resolve(cfg);
    return require('./contextbudget').charsFor(pc, cfg);
  } catch { return 0; }
}

/**
 * WHERE THE DECLARATIONS ARE, across the WHOLE file. structure.js caps its
 * units (at 400, mostly variables in a big file), which hid every function
 * past the first few — exactly the ones a narrowed read must point at. This is
 * a line scan for callable/type declarations; when there are more than fit,
 * they are sampled evenly so the outline spans the file.
 */
const DECL_RE = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)|def\s+([A-Za-z_]\w*)|(?:pub\s+)?fn\s+([A-Za-z_]\w*)|func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*))/;

function outline(text) {
  const found = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = DECL_RE.exec(lines[i]);
    if (!m) continue;
    const name = m.slice(1).find(Boolean);
    const kind = m[1] || m[3] || m[6] || m[7] || m[8] ? 'function' : m[2] ? 'class' : 'type';
    found.push(`  ${String(i + 1).padStart(6)}  ${kind.padEnd(8)} ${name}`);
  }
  if (found.length <= OUTLINE_MAX) return found;
  const step = found.length / OUTLINE_MAX;
  return Array.from({ length: OUTLINE_MAX }, (_, k) => found[Math.floor(k * step)]);
}

/**
 * Before a read runs. Returns a substitute (the narrowed read) or null.
 * @param {object} ctx  the tool context (cwd, app)
 */
function guard(session, call, ctx = {}) {
  if (!session || !call || call.name !== 'read_file') return null;
  const input = call.input || {};
  if (input.offset != null || input.limit != null || !input.path) return null;
  const cwd = ctx.cwd || session.cwd || process.cwd();
  const abs = path.resolve(cwd, String(input.path));
  const s = stamp(abs);
  if (!s) return null;
  const prior = stateOf(session).get(keyOf(abs));
  const elidedBefore = Boolean(prior && prior.elided && prior.size === s.size && prior.mtime === s.mtime);
  const budget = budgetChars(ctx);
  const tooBig = budget > 0 && s.size > budget * TOO_BIG_RATIO;
  if (!elidedBefore && !tooBig) return null;

  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  let used = 0;
  let n = 0;
  while (n < lines.length && used + lines[n].length + 8 <= WINDOW_CHARS) { used += lines[n].length + 8; n += 1; }
  n = Math.max(1, n);
  const rel = path.relative(cwd, abs).replace(/\\/g, '/') || String(input.path);
  const window = lines.slice(0, n).map((l, i) => `${String(i + 1).padStart(5)}\t${l}`).join('\n');
  const shown = stateOf(session) && session._blockageShown;
  const first = !shown.has(keyOf(abs));
  shown.add(keyOf(abs));
  const why = elidedBefore
    ? `the previous whole read of it (${lines.length} lines, ${s.size} chars) was elided to fit the context window`
    : `a whole read (${lines.length} lines, ${s.size} chars) does not fit the usable context`;
  const head = first
    ? `BLOCKAGE · ${rel}: ${why}.\nADAPTED · narrowed to its outline and lines 1–${n}. Continue with ranges (read_file offset/limit, 40–120 lines around what you need) or read_symbol — the whole read is narrowed again if repeated.`
    : `NARROWED · ${rel} (whole read does not fit) · outline + lines 1–${n}; read further ranges with offset/limit.`;
  if (first && ctx.app && typeof ctx.app.transient === 'function') {
    try { ctx.app.transient('warn', `BLOCKAGE · ${rel} is too large to read whole — ADAPTED: targeted ranges`); } catch { /* the result still says it */ }
  }
  const out = outline(text);
  return {
    output: `${head}\n${out.length ? `\nOUTLINE (${out.length} declarations):\n${out.join('\n')}\n` : ''}\nLINES 1–${n} of ${lines.length}:\n${window}`,
    narrowed: true,
    meta: { path: rel, lines: lines.length, coverage: { complete: false, returned: [1, n], elidedBefore } },
  };
}

module.exports = { guard, noteElided, TOO_BIG_RATIO, WINDOW_CHARS };
