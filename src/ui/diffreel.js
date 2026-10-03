'use strict';

/** THE DIFF AS AN EDIT BEING PERFORMED — not as a document being scrolled. */

const script = require('./diffscript');
const { SCRAMBLE_MS } = require('./reveal');

/** How long the window takes to open, and to close again. */
const OPEN_MS = 180;
const CLOSE_MS = 200;
/** Moving to a change: a floor, a cost per row travelled, and a ceiling. */
const SCROLL_MIN = 90;
const SCROLL_PER_ROW = 14;
const SCROLL_MAX = 380;
/** Marking the old code: per line, with a floor so one line is still seen. */
const STRIKE_PER_LINE = 55;
const STRIKE_MIN = 120;
/** Writing the new code. Characters per second, with a floor per hunk. */
const WRITE_CPS = 340;
const WRITE_MIN = 150;
/** The pause on a finished hunk before the viewport moves on. */
const HUNK_SETTLE = 220;
/** The pause on the finished diff before the window closes. */
const FINAL_SETTLE = 420;
/** Rows the window may occupy. A diff is a glance, not a document. */
const MAX_ROWS = 14;
/** Total editing time is capped, so a 400-line refactor does not play for a minute. */
const MAX_REEL_MS = 5200;
/** THERE IS NO QUEUE HERE ANY MORE, and its absence is the fix. */

const STAGE = Object.freeze({
  OPENING: 'OPENING',
  SCROLL: 'SCROLL',
  STRIKE: 'STRIKE',
  WRITE: 'WRITE',
  /** A READ: the code is already there and the window moves down it. */
  READING: 'READING',
  SETTLE: 'SETTLE',
  CLOSING: 'CLOSING',
  CLOSED: 'CLOSED',
});

/** READING IS NOT EDITING, AND IT MUST NOT LOOK LIKE IT. */
/** How long the window dwells on each row it scrolls past. */
const READ_PER_ROW = 55;
/** A short read still gets long enough to register as a read. */
const READ_MIN = 600;
/** However long the file, the look through it is bounded. */
const READ_MAX = 2400;
/** Rows of a file the window will travel through. */
const READ_ROWS = 32;

/** Ease-in-out, so the viewport starts and stops rather than jumping. */
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

/** BUILD A CHANGE'S WINDOW — the item a timeline event carries. */
function build(file, before, after) {
  const s = Array.isArray(before) ? fromRows(before) : script.build(before, after);
  if (!s.rows.length || !s.hunks.length) return null;
  return { file: String(file || ''), reading: false, script: s, plan: planOf(s) };
}

/** LOOK THROUGH A FILE — the code is already there; the window travels down it. */
function buildRead(file, text) {
  const lines = script.lines(text);
  if (!lines || !lines.length) return null;
  // ONE GUTTER, AND IT IS THE FILE'S OWN LINE NUMBERS
  const rows = lines.slice(0, READ_ROWS).map((t, i) => {
    const m = /^\s*(\d+)	(.*)$/.exec(t);
    return m
      ? { kind: 'context', text: m[2], hunk: -1, no: Number(m[1]) }
      : { kind: 'context', text: t, hunk: -1, no: i + 1 };
  });
  if (lines.length > READ_ROWS) {
    rows.push({ kind: 'gap', text: `⋯ ${lines.length - READ_ROWS} more lines`, hunk: -1, no: 0 });
  }
  return {
    file: String(file || ''),
    reading: true,
    script: { rows, hunks: [], added: 0, removed: 0, truncated: lines.length > READ_ROWS },
    plan: { hunks: [], total: clamp(rows.length * READ_PER_ROW, READ_MIN, READ_MAX) },
  };
}

/** THE WHOLE PERFORMANCE, in milliseconds of plan time. */
function planDuration(item) {
  if (!item) return 0;
  return OPEN_MS + item.plan.total + FINAL_SETTLE + CLOSE_MS;
}

/** WHAT THE WINDOW LOOKS LIKE `t` MILLISECONDS INTO ITS OWN PERFORMANCE. */
function frame(item, t) {
  if (!item || !item.script.rows.length) return closed();
  const elapsed = Math.max(0, Number(t) || 0);
  const total = planDuration(item);
  if (elapsed >= total) return closed();

  const view = Math.min(item.script.rows.length, MAX_ROWS);
  let height = view;
  let stage = STAGE.SETTLE;

  if (elapsed < OPEN_MS) {
    // IT REALLY GROWS, and it was only claiming to
    const opening = Math.max(1, Math.round(view * (elapsed / OPEN_MS)));
    const pristine = {
      stage: STAGE.OPENING, hunk: -1, added: 0, removed: 0,
      focus: 0, struck: -1, written: -1, writing: 0, hunkRef: null,
    };
    return {
      open: true,
      stage: STAGE.OPENING,
      file: item.file,
      rows: item.script.rows.slice(0, opening).map((_, i) => rowAt(item, i, pristine)),
      height: opening,
      top: 0,
      added: 0,
      removed: 0,
      finalAdded: item.script.added,
      finalRemoved: item.script.removed,
      hunk: -1,
      hunks: item.plan.hunks.length,
      total: item.script.rows.length,
    };
  }

  const at = elapsed - OPEN_MS;
  if (at >= item.plan.total + FINAL_SETTLE) {
    stage = STAGE.CLOSING;
    const p = (at - item.plan.total - FINAL_SETTLE) / CLOSE_MS;
    height = Math.max(0, Math.round(view * (1 - p)));
  }

  const state = perform(item, Math.min(at, item.plan.total));
  if (stage !== STAGE.CLOSING) stage = state.stage;

  // THE VIEWPORT FOLLOWS THE EDIT
  const focus = state.focus;
  const top = clamp(Math.round(focus - (view - 1) / 2), 0,
    Math.max(0, item.script.rows.length - view));
  const rows = [];
  for (let i = top; i < Math.min(item.script.rows.length, top + view); i++) {
    rows.push(rowAt(item, i, state));
  }

  return {
    open: true,
    stage,
    file: item.file,
    rows: height > 0 ? rows.slice(0, Math.max(0, height)) : [],
    height,
    top,
    added: state.added,
    removed: state.removed,
    finalAdded: item.script.added,
    finalRemoved: item.script.removed,
    // Clamped for DISPLAY.
    hunk: Math.min(state.hunk, Math.max(0, item.plan.hunks.length - 1)),
    hunks: item.plan.hunks.length,
    total: item.script.rows.length,
    truncated: Boolean(item.script.truncated),
    // WHICH SCRAMBLE FRAME THIS IS, so the character currently being typed can resolve out of an unsettled glyph the same way prose does (ui/reveal.js).
    tick: Math.floor(elapsed / SCRAMBLE_MS),
  };
}

function perform(item, t) {
  const rows = item.script.rows;

  // A READ: TRAVEL, DO NOT EDIT
  if (item.reading) {
    const span = Math.max(1, item.plan.total);
    const p = ease(clamp(t / span, 0, 1));
    return {
      stage: STAGE.READING,
      hunk: -1,
      added: 0,
      removed: 0,
      focus: p * Math.max(0, rows.length - 1),
      struck: -1,
      written: -1,
      writing: 0,
    };
  }

  let clock = 0;
  let added = 0;
  let removed = 0;
  let prevAnchor = 0;

  for (const h of item.plan.hunks) {
    // ---- SCROLL: from wherever we were to this change --------------------
    if (t < clock + h.scroll) {
      const p = h.scroll ? ease((t - clock) / h.scroll) : 1;
      return {
        stage: STAGE.SCROLL, hunk: h.index, added, removed,
        focus: prevAnchor + (h.at - prevAnchor) * p,
        struck: -1, written: -1, writing: 0,
      };
    }
    clock += h.scroll;

    // STRIKE: the old code is crossed out, CHARACTER BY CHARACTER
    if (h.removedRows.length) {
      if (t < clock + h.strike) {
        const p = clamp((t - clock) / h.strike, 0, 1);
        const budget = p * (h.gone || h.removedRows.length);
        let seen = 0;
        let idx = h.removedRows.length - 1;
        let partial = 1;
        for (let k = 0; k < h.removedRows.length; k++) {
          const len = Math.max(1, rows[h.removedRows[k]].text.length);
          if (budget < seen + len) { idx = k; partial = (budget - seen) / len; break; }
          seen += len;
        }
        return {
          // The removal count is the lines FULLY crossed out.
          stage: STAGE.STRIKE, hunk: h.index, added, removed: removed + idx,
          focus: h.removedRows[idx],
          struck: idx, striking: clamp(partial, 0, 1), written: -1, writing: 0, hunkRef: h,
        };
      }
      clock += h.strike;
    }
    removed += h.removedRows.length;

    // ---- WRITE: the replacement appears, character by character ----------
    if (h.addedRows.length) {
      if (t < clock + h.write) {
        const p = clamp((t - clock) / h.write, 0, 1);
        const chars = p * h.chars;
        let seen = 0;
        let idx = h.addedRows.length - 1;
        let partial = 1;
        for (let k = 0; k < h.addedRows.length; k++) {
          const len = Math.max(1, rows[h.addedRows[k]].text.length);
          if (chars < seen + len) { idx = k; partial = (chars - seen) / len; break; }
          seen += len;
        }
        return {
          stage: STAGE.WRITE, hunk: h.index, added: added + idx, removed,
          focus: h.addedRows[idx],
          struck: h.removedRows.length, written: idx, writing: clamp(partial, 0, 1), hunkRef: h,
        };
      }
      clock += h.write;
    }
    added += h.addedRows.length;

    // ---- SETTLE: the finished hunk, held ---------------------------------
    if (t < clock + h.settle) {
      return {
        stage: STAGE.SETTLE, hunk: h.index, added, removed,
        focus: h.last, struck: h.removedRows.length, written: h.addedRows.length, writing: 1, hunkRef: h,
      };
    }
    clock += h.settle;
    prevAnchor = h.last;
  }

  // EVERY HUNK PERFORMED. The playhead is past the last one — which is what
  // `_rowAt` needs to hear, or the final hunk would still read as pending.
  return {
    stage: STAGE.SETTLE, hunk: item.plan.hunks.length,
    // THE REAL TOTALS, which is only ever different from what was performed when the document was truncated (ui/diffscript.js MAX_ROWS).
    added: item.script.added, removed: item.script.removed,
    focus: prevAnchor, struck: Infinity, written: Infinity, writing: 1,
  };
}

/** One document row, in the state the performance has it in. */
function rowAt(item, i, state) {
  const r = item.script.rows[i];
  if (r.kind === 'gap') return { text: r.text, kind: 'gap', state: 'gap', no: 0 };
  if (r.kind === 'context') return { text: r.text, kind: 'context', state: 'plain', no: r.no };

  // WHICH SIDE OF THE PLAYHEAD THIS ROW IS ON.
  const h = state.hunkRef && state.hunkRef.index === r.hunk ? state.hunkRef : null;
  const past = r.hunk < state.hunk;
  const future = !past && !h;

  if (r.kind === 'removed') {
    // Before its turn it is still ordinary code; from the moment the editor
    // reaches it, it is red and struck, and it stays that way — it is gone.
    if (future) return { text: r.text, kind: 'removed', state: 'plain', no: r.no };
    if (past) return { text: r.text, kind: 'removed', state: 'struck', no: r.no };
    const k = h.removedRows.indexOf(i);
    if (k < state.struck) return { text: r.text, kind: 'removed', state: 'struck', no: r.no };
    if (k > state.struck) return { text: r.text, kind: 'removed', state: 'plain', no: r.no };
    // THE LINE THE PEN IS ON.
    const cut = Math.max(0, Math.round(r.text.length * (state.striking == null ? 1 : state.striking)));
    return { text: r.text, kind: 'removed', state: 'striking', cut, no: r.no };
  }

  // ADDED. An empty row until it is written, so the document does not reflow
  // under the reader while the change is being made.
  if (future) return { text: '', kind: 'added', state: 'blank', no: r.no };
  if (past) return { text: r.text, kind: 'added', state: 'added', no: r.no };
  const k = h.addedRows.indexOf(i);
  if (k < state.written) return { text: r.text, kind: 'added', state: 'added', no: r.no };
  if (k > state.written) return { text: '', kind: 'added', state: 'blank', no: r.no };
  const n = Math.max(0, Math.round(r.text.length * state.writing));
  return { text: r.text.slice(0, n), kind: 'added', state: 'writing', no: r.no };
}


/** HOW LONG EACH HUNK TAKES, laid out once so the walk above is arithmetic. */
function planOf(s) {
  const hunks = [];
  let prev = 0;
  let total = 0;
  for (const h of s.hunks) {
    const removedRows = [];
    const addedRows = [];
    let chars = 0;
    // Characters ON THE WAY OUT.
    let gone = 0;
    for (let i = 0; i < s.rows.length; i++) {
      const r = s.rows[i];
      if (r.hunk !== h.index) continue;
      if (r.kind === 'removed') { removedRows.push(i); gone += Math.max(1, r.text.length); }
      else if (r.kind === 'added') { addedRows.push(i); chars += Math.max(1, r.text.length); }
    }
    const dist = Math.abs(h.at - prev);
    const e = {
      index: h.index,
      at: h.at,
      last: h.last == null ? h.at : h.last,
      removedRows,
      addedRows,
      chars,
      gone,
      scroll: clamp(SCROLL_MIN + dist * SCROLL_PER_ROW, SCROLL_MIN, SCROLL_MAX),
      strike: removedRows.length ? Math.max(STRIKE_MIN, removedRows.length * STRIKE_PER_LINE) : 0,
      write: addedRows.length ? Math.max(WRITE_MIN, (chars / WRITE_CPS) * 1000) : 0,
      settle: HUNK_SETTLE,
    };
    total += e.scroll + e.strike + e.write + e.settle;
    prev = e.last;
    hunks.push(e);
  }
  if (total > MAX_REEL_MS && total > 0) {
    const k = MAX_REEL_MS / total;
    for (const e of hunks) {
      e.scroll *= k; e.strike *= k; e.write *= k; e.settle *= k;
    }
    total = MAX_REEL_MS;
  }
  return { hunks, total };
}

/** A SCRIPT FROM ALREADY-RENDERED DIFF ROWS. */
function fromRows(list) {
  const rows = [];
  let added = 0;
  let removed = 0;
  for (const raw of (Array.isArray(list) ? list : []).slice(0, script.MAX_ROWS)) {
    const s = String(raw == null ? '' : raw);
    const m = /^(\s*\d*\s*)([+\- ])\s?(.*)$/.exec(s);
    const mark = m ? m[2] : (s.startsWith('+') ? '+' : s.startsWith('-') ? '-' : ' ');
    const text = m ? m[3] : s.replace(/^[+\- ]/, '');
    if (mark === '+') { rows.push({ kind: 'added', text, hunk: 0, no: rows.length + 1 }); added++; }
    else if (mark === '-') { rows.push({ kind: 'removed', text, hunk: 0, no: rows.length + 1 }); removed++; }
    else rows.push({ kind: 'context', text, hunk: -1, no: rows.length + 1 });
  }
  const first = rows.findIndex((r) => r.hunk === 0);
  const last = rows.reduce((acc, r, k) => (r.hunk === 0 ? k : acc), first);
  return {
    rows,
    hunks: first < 0 ? [] : [{ index: 0, at: first, last, added, removed }],
    added,
    removed,
    truncated: false,
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function closed() {
  return {
    open: false, stage: STAGE.CLOSED, file: '', rows: [], height: 0, top: 0,
    added: 0, removed: 0, finalAdded: 0, finalRemoved: 0, hunk: -1, hunks: 0, total: 0,
  };
}

module.exports = {
  build, buildRead, frame, planDuration, closed,
  STAGE, planOf, fromRows,
  OPEN_MS, CLOSE_MS, SCROLL_MIN, SCROLL_PER_ROW, SCROLL_MAX,
  STRIKE_PER_LINE, STRIKE_MIN, WRITE_CPS, WRITE_MIN,
  HUNK_SETTLE, FINAL_SETTLE, MAX_ROWS, MAX_REEL_MS, READ_ROWS, READ_PER_ROW, READ_MIN, READ_MAX,
};
