'use strict';

/**
 * WORK ORDER ENFORCEMENT — scope and baseline, as runtime facts.
 *
 * ------------------------------------------------------------------------
 * WHAT CHANGED. authority.js declared `readScope`, `writeScope` and
 * `baselineFingerprints` and said, correctly, that nothing enforced them. This
 * is the enforcement. A prompt asking a worker to stay in its lane is an
 * instruction; this is the lane.
 *
 * ------------------------------------------------------------------------
 * WHO IT BINDS, AND WHO IT DOES NOT. Only an order marked `bounded`. The main
 * executor carries no bounded order — it keeps its strategic freedom to
 * investigate and change whatever the task needs. A `/bg` fork is a copy of the
 * main executor's task and is likewise unbounded. A bounded worker is the one
 * thing whose assignment is enforced:
 *
 *     MAIN EXECUTOR    high strategic freedom      ctx.workOrder absent or unbounded
 *     BOUNDED WORKER   enforced assignment         ctx.workOrder.bounded === true
 *
 * ------------------------------------------------------------------------
 * SCOPE ENTRIES.
 *
 *     src/auth/session.ts                  the file
 *     src/auth/**                          a glob
 *     src/auth/session.ts::validateSession one declaration in the file
 *
 * A symbol-scoped entry admits a symbol tool naming that symbol, and a text edit
 * whose changed lines fall inside the symbol's span — checked AFTER the edit
 * against the file as it was before, because only then is the span known.
 *
 * EXPANSION IS REQUESTED, NEVER TAKEN. `requestExpansion` records a request on
 * the order; only `grantExpansion`, which no tool can reach, widens the scope,
 * and the order's own scope arrays are frozen so a worker holding the object
 * cannot push into them.
 */

const path = require('path');

const VERDICT = Object.freeze({
  OUTSIDE_WORK_ORDER: 'OUTSIDE_WORK_ORDER',
  STALE_WORK_ORDER: 'STALE_WORK_ORDER',
});

const SYMBOL_TOOLS = new Set(['replace_symbol', 'insert_near_symbol', 'remove_symbol']);

function relOf(cwd, abs) {
  return path.relative(String(cwd || process.cwd()), abs).replace(/\\/g, '/');
}

function norm(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, ''); }

function globRe(glob) {
  const g = norm(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i += 1; if (g[i + 1] === '/') i += 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

/** `{ file, symbol }` for one scope entry. */
function parseEntry(entry) {
  const s = norm(entry);
  const i = s.indexOf('::');
  return i < 0 ? { file: s, symbol: '' } : { file: s.slice(0, i), symbol: s.slice(i + 2) };
}

/** The entries of `scope` whose file part matches `rel`. */
function matching(scope, rel) {
  const r = norm(rel);
  return (Array.isArray(scope) ? scope : []).map(parseEntry).filter((e) => {
    if (!e.file) return false;
    if (/[*?]/.test(e.file)) return globRe(e.file).test(r);
    return process.platform === 'win32' ? e.file.toLowerCase() === r.toLowerCase() : e.file === r;
  });
}

function isBounded(order) { return Boolean(order && order.bounded === true); }

/**
 * MAY THIS WORKER WRITE THESE PATHS? Asked BEFORE anything is touched.
 *
 * @returns {{ok:boolean, denied:Array, spans:Array}}
 *   `spans` lists files admitted only by symbol-scoped entries, whose edit must
 *   still pass `spanAllowed` once applied.
 */
function writeAllowed(order, absPaths, { name = '', input = {}, cwd = '' } = {}) {
  const out = { ok: true, denied: [], spans: [] };
  if (!isBounded(order)) return out;
  for (const abs of absPaths || []) {
    const rel = relOf(cwd, abs);
    const hits = matching(order.writeScope, rel);
    if (!hits.length) {
      out.denied.push({ rel, why: `${VERDICT.OUTSIDE_WORK_ORDER}: ${rel} is not in work order ${order.id}'s write scope` });
      continue;
    }
    if (hits.some((h) => !h.symbol)) continue;      // a whole-file entry admits any edit to it
    const symbols = hits.map((h) => h.symbol);
    if (SYMBOL_TOOLS.has(name)) {
      if (!symbols.includes(String(input.name || ''))) {
        out.denied.push({ rel, why: `${VERDICT.OUTSIDE_WORK_ORDER}: ${rel}::${input.name} — the order grants only ${symbols.map((s) => `${rel}::${s}`).join(', ')}` });
      }
      continue;
    }
    if (name === 'rename_symbol' || name === 'move_file' || name === 'delete_file' || name === 'write_file') {
      out.denied.push({ rel, why: `${VERDICT.OUTSIDE_WORK_ORDER}: ${name} changes more than ${symbols.map((s) => `${rel}::${s}`).join(', ')}` });
      continue;
    }
    out.spans.push({ abs, rel, symbols });
  }
  out.ok = out.denied.length === 0;
  return out;
}

/** The changed line span of `before` → `after`, in `before`'s line numbers (1-based, inclusive). */
function changedSpan(before, after) {
  const b = String(before).split('\n');
  const a = String(after).split('\n');
  let p = 0;
  while (p < b.length && p < a.length && b[p] === a[p]) p += 1;
  let s = 0;
  while (s < b.length - p && s < a.length - p && b[b.length - 1 - s] === a[a.length - 1 - s]) s += 1;
  if (p === b.length && p === a.length) return null;                 // identical
  // A pure insertion changes no `before` line: its span is the insertion point.
  const from = p + 1;
  const to = Math.max(from, b.length - s);
  return { from, to };
}

/**
 * DID A TEXT EDIT STAY INSIDE THE SYMBOLS IT WAS ADMITTED FOR?
 *
 * The declaration spans come from `codemodel` over the BEFORE text, which is the
 * file the order was issued against.
 */
function spanAllowed(beforeText, afterText, abs, symbols) {
  const span = changedSpan(beforeText, afterText);
  if (!span) return { ok: true, span: null };
  let model;
  try { model = require('./codemodel').scan(String(beforeText), abs); } catch { model = null; }
  if (!model || !Array.isArray(model.symbols)) return { ok: false, span, why: 'the file could not be parsed to find the symbol' };
  const lineOf = (i) => String(beforeText).slice(0, i).split('\n').length;
  for (const want of symbols) {
    const [name, container] = String(want).split('@');
    for (const sym of model.symbols) {
      if (sym.name !== name || (container && sym.container !== container)) continue;
      const from = sym.startLine || lineOf(sym.start);
      const to = sym.endLine || lineOf(sym.end);
      if (span.from >= from && span.to <= to) return { ok: true, span, symbol: want, range: { from, to } };
    }
  }
  return { ok: false, span, why: `lines ${span.from}-${span.to} are outside ${symbols.join(', ')}` };
}

/** May a bounded worker READ this path? An empty read scope reads anything. */
function readAllowed(order, abs, cwd = '') {
  if (!isBounded(order) || !Array.isArray(order.readScope) || !order.readScope.length) return { ok: true };
  const rel = relOf(cwd, abs);
  if (matching(order.readScope, rel).length || matching(order.writeScope, rel).length) return { ok: true };
  return { ok: false, why: `${VERDICT.OUTSIDE_WORK_ORDER}: ${rel} is not in work order ${order.id}'s read scope` };
}

/** Fingerprints for a set of project-relative paths; null records absence. */
function baseline(cwd, rels) {
  const rr = require('./readreceipts');
  const out = {};
  for (const rel of rels || []) {
    const f = rr.contentFingerprint(path.resolve(String(cwd || process.cwd()), rel));
    out[norm(rel)] = f ? f.fp : null;
  }
  return out;
}

/**
 * HAS THE GROUND MOVED SINCE THE ORDER WAS ISSUED?
 *
 * Every path in the order's baseline, or only `onlyRels` when given, compared
 * with the disk now. A non-empty answer means the order is STALE and its result
 * must not be applied — the file now holds somebody else's version.
 */
function stale(order, cwd, { onlyRels = null, extra = {} } = {}) {
  const base = { ...((order && order.baselineFingerprints) || {}), ...extra };
  const now = baseline(cwd, Object.keys(base));
  const want = onlyRels ? new Set(onlyRels.map(norm)) : null;
  const out = [];
  for (const [rel, expected] of Object.entries(base)) {
    if (want && !want.has(norm(rel))) continue;
    const actual = now[norm(rel)];
    if (expected !== actual) out.push({ rel: norm(rel), expected, actual });
  }
  return out;
}

/** A worker asking for more room. Recorded; nothing widens. */
function requestExpansion(order, { paths = [], why = '' } = {}) {
  if (!order) return null;
  const req = { id: `X${(order.expansionRequests || []).length + 1}`, paths: paths.map(norm), why: String(why).slice(0, 300), at: Date.now(), granted: false };
  order.expansionRequests = [...(order.expansionRequests || []), req];
  return req;
}

/**
 * THE ONLY WAY A SCOPE WIDENS, and it names who decided. Not reachable from a
 * tool: the model-facing vocabulary has no door to it.
 */
function grantExpansion(order, requestId, { by = '' } = {}) {
  if (by !== 'user' && by !== 'lain') return { ok: false, why: 'scope may be widened only by the user or Noema, never by the worker' };
  const req = (order.expansionRequests || []).find((r) => r.id === requestId);
  if (!req) return { ok: false, why: `no expansion request ${requestId}` };
  order.writeScope = Object.freeze([...order.writeScope, ...req.paths]);
  order.expansionRequests = order.expansionRequests.map((r) => (r === req ? { ...r, granted: true, by } : r));
  return { ok: true, writeScope: order.writeScope };
}

module.exports = {
  VERDICT, isBounded, writeAllowed, readAllowed, spanAllowed, changedSpan,
  baseline, stale, requestExpansion, grantExpansion, parseEntry, matching,
};
