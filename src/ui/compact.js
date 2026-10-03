'use strict';

/** FLOOD COMPACTION — what a long run of events becomes on screen. */

/** views.js holds the shared text helpers; required lazily to avoid a cycle. */
const V = () => require('./views');

/** TOOL FLOOD COMPACTION — a long run of calls becomes a count, not a wall. */
const KEEP = 4;
/** How many rows a FINISHED run of calls keeps. */
const KEEP_OLD = 2;

/** `retry 3/5 at 12:07:56 (4s) · Esc cancels the wait` — one attempt, announced. */
const RETRY_NOTE = /^(.*?)\s+—\s+retry\s+(\d+)\/(\d+)\b/;

/** A run of retry notices, as the single event it is. */
function compactRetries(run) {
  const hits = run.map((e) => RETRY_NOTE.exec(e.text || '')).filter(Boolean);
  if (hits.length < 2) return null;
  const last = hits[hits.length - 1];
  const why = String(hits[0][1] || '').trim();
  return {
    kind: 'note',
    // The retries themselves are a WARNING; whatever failure ends the run
    // arrives as its own ERROR row and keeps its colour.
    level: 'warn',
    text: `retrying · ${last[2]}/${last[3]}${why ? ` — ${why}` : ''}`,
    compacted: true,
  };
}

function compactRuns(entries, keep = KEEP) {
  const out = [];
  // WHERE THE CURRENT RUN OF CALLS BEGINS — the same question ui/feed.js's renderer asks to decide what recedes.
  let lastActionRun = -1;
  for (let k = 0; k < entries.length; k++) {
    if (entries[k].kind !== 'action') continue;
    if (k === 0 || entries[k - 1].kind !== 'action') lastActionRun = k;
  }
  let i = 0;
  while (i < entries.length) {
    // ---- A RUN OF RETRIES IS ONE EVENT ----------------------------------
    if (entries[i].kind === 'note') {
      let j = i;
      while (j < entries.length && entries[j].kind === 'note') j++;
      const run = entries.slice(i, j);
      const folded = compactRetries(run);
      if (folded) {
        // ORDER IS PRESERVED, and it matters: the failure that ENDED the run came after the attempts, and printing it above them tells the story backwards…
        let placed = false;
        for (const e of run) {
          if (RETRY_NOTE.test(e.text || '')) {
            if (!placed) { out.push(folded); placed = true; }
            continue;
          }
          out.push(e);
        }
        i = j;
        continue;
      }
      for (const e of run) out.push(e);
      i = j;
      continue;
    }
    if (entries[i].kind !== 'action') { out.push(entries[i++]); continue; }
    let j = i;
    while (j < entries.length && entries[j].kind === 'action') j++;
    const run = entries.slice(i, j);
    // HISTORY IS COMPACTED HARDER THAN THE WORK IN HAND
    const room = i === lastActionRun ? keep : KEEP_OLD;
    // Only whole successful call rows count towards a flood; a wrapped detail line is part of the row above it and must travel with it.
    const units = [];
    for (const e of run) { if (e.verb || !units.length) units.push([e]); else units[units.length - 1].push(e); }
    if (units.length <= room + 2) { for (const e of run) out.push(e); i = j; continue; }
    const head = units.slice(0, units.length - room);
    const kept = units.slice(units.length - room);
    // Failures inside the compacted head survive verbatim, above the summary.
    const failed = head.filter((u) => u[0].failed);
    const summary = summarise(head.filter((u) => !u[0].failed).map((u) => u[0]));
    if (summary) out.push({ kind: 'action', text: summary, compacted: true });
    for (const u of failed) for (const e of u) out.push(e);
    for (const u of kept) for (const e of u) out.push(e);
    i = j;
  }
  return out;
}

/** `✓ Searched ×7 · Read ×5` — one row for a run, grouped by what it did. */
function summarise(rows) {
  const counts = new Map();
  let n = 0;
  for (const r of rows) {
    if (!r.verb) continue;
    counts.set(r.verb, (counts.get(r.verb) || 0) + 1);
    n++;
  }
  if (!n) return '';
  // LOWER CASE, to match the rows it stands for.
  const parts = [...counts.entries()].map(([v, c]) => {
    const verb = String(v).toLowerCase();
    return c > 1 ? `${verb} ×${c}` : verb;
  });
  return `${V().MARK.done} ${parts.join(' · ')}`;
}
module.exports = { compactRuns, summarise, compactRetries, KEEP, KEEP_OLD, RETRY_NOTE };
