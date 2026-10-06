'use strict';

/**
 * BYTES, EXACTLY. Every Design edit is a set of splices computed from parser offsets and applied to the file's own text:
 * nothing outside the spliced spans is re-printed, so formatting survives by construction and Undo restores bytes
 * exactly. Ids name an element by where it starts in its file (file:line:col), so the same source gives the same id
 * in the canvas, the preview and the tools.
 */

const crypto = require('crypto');

/**
 * Apply non-overlapping splices [{start, end, text}] to `src`. A file that is all CRLF (a Windows checkout,
 * core.autocrlf) stays all CRLF: an inserted bare LF is written as CRLF — and the edit itself is updated, so offsets
 * mapped from the same edits afterwards (mapOffset) agree with the text written.
 */
function splice(src, edits) {
  const list = edits.filter(Boolean).slice().sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < list.length; i++) {
    if (list[i].start < list[i - 1].end) throw new Error(`overlapping edits at ${list[i].start}`);
  }
  if (/\r\n/.test(src) && !/(^|[^\r])\n/.test(src)) for (const e of list) if (typeof e.text === 'string') e.text = e.text.replace(/\r?\n/g, '\r\n');
  let out = ''; let at = 0;
  for (const e of list) { out += src.slice(at, e.start) + e.text; at = e.end; }
  return out + src.slice(at);
}

/** Where `offset` moves to after `edits` were applied (an edit that covers it maps it to the edit's start). */
function mapOffset(offset, edits) {
  let delta = 0;
  for (const e of edits.filter(Boolean)) {
    if (e.end <= offset) delta += e.text.length - (e.end - e.start);
    else if (e.start < offset) return e.start + delta;
  }
  return offset + delta;
}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** The stable id of the element that starts at line:col of `rel` (forward slashes). */
function idFor(rel, line, col) { return `d${sha1(`${String(rel).replace(/\\/g, '/')}:${line}:${col}`).slice(0, 10)}`; }

/** Line/col (1-based) of an offset. */
function lineCol(src, offset) {
  let line = 1; let last = -1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) { line += 1; last = i; }
  return { line, col: offset - last };
}

/** The indentation of the line `offset` is on. */
function indentAt(src, offset) {
  const ls = src.lastIndexOf('\n', offset - 1) + 1;
  const m = /^[ \t]*/.exec(src.slice(ls));
  return m ? m[0] : '';
}

const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MAX_LINES = 16;

/** Line diff (LCS on the changed middle): hunks of [{sign, text}] with their 1-based line in `before`. */
function lineHunks(a, b) {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s += 1;
  let ea = a.length; let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea -= 1; eb -= 1; }
  const A = a.slice(s, ea); const B = b.slice(s, eb);
  const ops = [];
  if (A.length * B.length > 4e6) { A.forEach((t) => ops.push(['-', t])); B.forEach((t) => ops.push(['+', t])); } else {
    const L = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
    for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0; let j = 0;
    while (i < A.length || j < B.length) {
      if (i < A.length && j < B.length && A[i] === B[j]) { ops.push(['=', A[i]]); i += 1; j += 1; } else if (i < A.length && (j >= B.length || L[i + 1][j] >= L[i][j + 1])) { ops.push(['-', A[i]]); i += 1; } else { ops.push(['+', B[j]]); j += 1; }
    }
  }
  const hunks = []; let line = s + 1; let cur = null;
  for (const [sign, text] of ops) {
    if (sign === '=') { cur = null; line += 1; continue; }
    if (!cur) { cur = { line, lines: [] }; hunks.push(cur); }
    cur.lines.push({ sign, text });
    if (sign === '-') line += 1;
  }
  return hunks;
}

/** A unified-looking summary of what changed, hunk by hunk, for the one-line status's expandable diff. */
function diffSummary(rel, before, after) {
  const cut = (t) => (t.length > 200 ? `${t.slice(0, 197)}...` : t);
  const out = []; let shown = 0; let hidden = 0;
  for (const h of lineHunks(before.split('\n'), after.split('\n'))) {
    out.push(`${rel}:${h.line}`);
    for (const l of h.lines) { if (shown < MAX_LINES) { out.push(`${l.sign} ${cut(l.text)}`); shown += 1; } else hidden += 1; }
  }
  if (hidden) out.push(`… ${hidden} more line(s)`);
  return out.join('\n');
}

module.exports = { lineHunks, splice, mapOffset, sha1, idFor, lineCol, indentAt, escAttr, escText, diffSummary };
