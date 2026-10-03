'use strict';

/** THE EDIT SCRIPT — a change, described as the sequence of edits that made it. */

/** Unchanged lines kept around a hunk, so a change is seen in its place. */
const CONTEXT = 3;
/** The largest middle section a full diff is computed for. */
const MAX_CELLS = 400000;
/** Bound on the document the window can play, in rows. */
const MAX_ROWS = 600;

/** Split, tolerating either line ending, and never inventing a trailing line. */
function lines(s) {
  if (s == null) return null;
  const t = String(s).replace(/\r\n/g, '\n');
  if (t === '') return [];
  // The newline ending the last line does not begin another one.
  return (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n');
}

/** The longest common subsequence of two line arrays, as an op list. */
function script(a, b) {
  const m = a.length;
  const n = b.length;
  const L = new Uint32Array((m + 1) * (n + 1));
  const at = (i, j) => i * (n + 1) + j;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      L[at(i, j)] = a[i] === b[j]
        ? L[at(i + 1, j + 1)] + 1
        : Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ op: 'eq', text: a[i] }); i++; j++; }
    else if (L[at(i + 1, j)] >= L[at(i, j + 1)]) { ops.push({ op: 'del', text: a[i] }); i++; }
    else { ops.push({ op: 'add', text: b[j] }); j++; }
  }
  while (i < m) { ops.push({ op: 'del', text: a[i] }); i++; }
  while (j < n) { ops.push({ op: 'add', text: b[j] }); j++; }
  return ops;
}

/** Every op, with the common prefix and suffix already known to be equal. */
function ops(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }

  const head = a.slice(0, s).map((text) => ({ op: 'eq', text }));
  const tail = a.slice(ea + 1).map((text) => ({ op: 'eq', text }));
  const midA = a.slice(s, ea + 1);
  const midB = b.slice(s, eb + 1);

  let mid;
  if (!midA.length) mid = midB.map((text) => ({ op: 'add', text }));
  else if (!midB.length) mid = midA.map((text) => ({ op: 'del', text }));
  else if (midA.length * midB.length > MAX_CELLS) {
    // TOO BIG TO DIFF PROPERLY, AND IT SAYS SO BY SHAPE: one hunk, every
    // removal then every addition. Exactly what `unified()` reports.
    mid = midA.map((text) => ({ op: 'del', text })).concat(midB.map((text) => ({ op: 'add', text })));
  } else mid = script(midA, midB);

  return head.concat(mid, tail);
}

/** THE SCRIPT, as a document to play plus the hunks to stop at. */
function build(before, after) {
  const a = lines(before);
  const b = lines(after);
  if (a == null && b == null) return empty();
  const all = a == null
    ? (b || []).map((text) => ({ op: 'add', text }))
    : b == null
      ? a.map((text) => ({ op: 'del', text }))
      : ops(a, b);

  // Which ops are near a change — everything else is elidable.
  const near = new Uint8Array(all.length);
  for (let i = 0; i < all.length; i++) {
    if (all[i].op === 'eq') continue;
    for (let k = Math.max(0, i - CONTEXT); k < Math.min(all.length, i + CONTEXT + 1); k++) near[k] = 1;
  }

  // THE COUNTS ARE THE WHOLE CHANGE, NOT THE PART THAT FITS
  let added = 0;
  let removed = 0;
  for (const o of all) {
    if (o.op === 'add') added++;
    else if (o.op === 'del') removed++;
  }

  const rows = [];
  const hunks = [];
  let hunk = -1;
  let noA = 0;
  let noB = 0;
  let skipped = 0;

  const flushSkip = () => {
    if (!skipped) return;
    rows.push({ kind: 'gap', text: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}`, hunk: -1, no: 0 });
    skipped = 0;
  };

  for (let i = 0; i < all.length; i++) {
    const o = all[i];
    if (o.op === 'eq') { noA++; noB++; } else if (o.op === 'del') noA++; else noB++;
    if (o.op === 'eq' && !near[i]) {
      // A run of unchanged lines nobody needs to watch scroll past.
      if (hunk >= 0) hunk = -1;
      skipped++;
      continue;
    }
    flushSkip();
    if (o.op !== 'eq') {
      if (hunk < 0) {
        hunk = hunks.length;
        hunks.push({ index: hunk, at: rows.length, removed: 0, added: 0, first: rows.length });
      }
      if (o.op === 'del') hunks[hunk].removed++; else hunks[hunk].added++;
    }
    rows.push({
      kind: o.op === 'eq' ? 'context' : o.op === 'del' ? 'removed' : 'added',
      text: o.text,
      hunk: o.op === 'eq' ? -1 : hunk,
      no: o.op === 'del' ? noA : noB,
    });
    if (rows.length >= MAX_ROWS) break;
  }
  flushSkip();

  // WHERE THE WINDOW STOPS, and it is the first CHANGED row of the hunk rather
  // than the context above it: the eye should land on the edit, not near it.
  for (const h of hunks) {
    const first = rows.findIndex((r) => r.hunk === h.index);
    h.at = first < 0 ? h.at : first;
    h.last = rows.reduce((acc, r, k) => (r.hunk === h.index ? k : acc), h.at);
  }

  return { rows, hunks, added, removed, truncated: rows.length >= MAX_ROWS };
}

function empty() { return { rows: [], hunks: [], added: 0, removed: 0, truncated: false }; }

module.exports = { build, ops, script, lines, empty, CONTEXT, MAX_CELLS, MAX_ROWS };
