'use strict';

/** SELECTING TEXT IN THE FEED — drag to highlight, release to copy. */

const T = require('./text');

/** Bound on what one drag may copy, so a selection cannot exhaust memory. */
const MAX_COPY_CHARS = 2_000_000;

/** The plain text of each rendered line, and where each line begins in the flattened document. */
function measure(lines) {
  const plain = [];
  const starts = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    const p = T.strip(String(l == null ? '' : l));
    plain.push(p);
    at += p.length + 1;                    // +1 for the newline that joins them
  }
  return { plain, starts, total: Math.max(0, at - 1) };
}

/** The offset of a column on a line. */
function offsetAt({ plain, starts }, lineIndex, column) {
  if (!plain.length) return 0;
  const i = Math.max(0, Math.min(plain.length - 1, lineIndex));
  const col = Math.max(0, Math.min(plain[i].length, column));
  return starts[i] + col;
}

/** Which columns of `lineIndex` fall inside `range`, or null. */
function spanOnLine({ plain, starts }, range, lineIndex) {
  if (!range || lineIndex < 0 || lineIndex >= plain.length) return null;
  const start = starts[lineIndex];
  const end = start + plain[lineIndex].length;
  if (range.end <= start || range.start > end) return null;
  return {
    from: Math.max(0, range.start - start),
    to: Math.min(plain[lineIndex].length, range.end - start),
    // A line fully inside the selection highlights to its end, including the
    // newline, so consecutive lines read as one region.
    toEnd: range.end > end,
  };
}

/** The selected text, ready for the clipboard. Never carries colour. */
function textOf({ plain, starts, total }, range) {
  if (!range) return '';
  const from = Math.max(0, Math.min(total, range.start));
  const to = Math.max(from, Math.min(total, range.end));
  const out = [];
  for (let i = 0; i < plain.length; i++) {
    const s = starts[i];
    const e = s + plain[i].length;
    if (e < from) continue;
    if (s > to) break;
    out.push(plain[i].slice(Math.max(0, from - s), Math.max(0, Math.min(plain[i].length, to - s))));
  }
  // TRAILING BLANKS GO. The feed pads with empty rows above short content and clips every row to the terminal width, so a selection routinely ends in a…
  return out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '').slice(0, MAX_COPY_CHARS);
}

/** Paint a highlight over part of an already-rendered line. */
function highlight(rendered, from, to, { toEnd = false, width = 0 } = {}) {
  const src = String(rendered == null ? '' : rendered);
  if (to <= from && !toEnd) return src;
  const ON = '\x1b[7m';
  const OFF = '\x1b[27m';
  let out = '';
  let col = 0;
  let inside = false;
  let i = 0;
  while (i < src.length) {
    // An escape sequence occupies no columns.
    if (src[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(src.slice(i));
      if (m) {
        out += m[0];
        if (inside) out += ON;             // a reset inside the span must not end it
        i += m[0].length;
        continue;
      }
    }
    if (!inside && col === from) { out += ON; inside = true; }
    if (inside && col === to && !toEnd) { out += OFF; inside = false; }
    out += src[i];
    col += 1;
    i += 1;
  }
  if (!inside && col <= from && from <= col) { out += ON; inside = true; }
  // A line that runs into the next one is highlighted to the full width, so the
  // block has a straight right edge instead of a ragged one.
  if (inside && toEnd && width > col) out += ' '.repeat(width - col);
  if (inside) out += OFF;
  return out;
}

/** Which feed line a screen row is showing. */
function lineForRow(rowMap, scroll, y) {
  if (!rowMap || !Number.isFinite(rowMap.feedStart)) return null;
  const offset = y - rowMap.feedStart;
  if (offset < 0 || offset >= (rowMap.feedRows || 0)) return null;
  const pad = Number(rowMap.feedPad) || 0;
  if (offset < pad) return null;                       // a blank pad row holds no text
  return scroll + (offset - pad);
}

// ------------------------------------------------- driving it from a Screen --

/** The four operations a Screen needs, as plain functions over one. */

/** Begin a selection at a screen position. False when it is not over text. */
/** The screen column the feed's first character sits on. 1 before the frame. */
function feedCol(screen) {
  const c = screen && screen.rowMap && Number(screen.rowMap.feedCol);
  return Number.isFinite(c) && c > 0 ? c : 1;
}

function beginAt(screen, x, y) {
  const lines = screen.lastFeedLines;
  if (!lines || !lines.length) return false;
  const lineIndex = lineForRow(screen.rowMap, screen.workspaceScroll, y);
  if (lineIndex == null || lineIndex >= lines.length) return false;
  const m = measure(lines);
  screen.selectionLines = lines;
  // THE FEED NO LONGER STARTS AT COLUMN 1
  screen.textSelection.from(offsetAt(m, lineIndex, x - feedCol(screen)), m.total);
  return true;
}

/** Move the head of a selection in progress. */
function extendTo(screen, x, y) {
  const lines = screen.selectionLines || screen.lastFeedLines;
  if (!lines || !lines.length || screen.textSelection.anchor === null) return false;
  const m = measure(lines);
  const start = screen.rowMap && screen.rowMap.feedStart;
  const rows = (screen.rowMap && screen.rowMap.feedRows) || 0;
  let at;
  if (Number.isFinite(start) && y < start) {
    at = offsetAt(m, screen.workspaceScroll, 0);
  } else if (Number.isFinite(start) && y >= start + rows) {
    at = offsetAt(m, Math.min(lines.length - 1, screen.workspaceScroll + rows), Infinity);
  } else {
    const lineIndex = lineForRow(screen.rowMap, screen.workspaceScroll, y);
    if (lineIndex == null) return false;
    at = offsetAt(m, lineIndex, x - feedCol(screen));
  }
  screen.textSelection.to(at, m.total);
  return true;
}

/** Paint the highlight over the rows about to be drawn. */
function paintRows(window, { lines, sel, feedPad = 0, scroll = 0, cols = 0 }) {
  if (!sel || !lines || !lines.length) return window;
  const m = measure(lines);
  return window.map((text, i) => {
    if (i < feedPad) return text;                    // a blank pad row holds no text
    const span = spanOnLine(m, sel, scroll + (i - feedPad));
    if (!span) return text;
    return highlight(text || '', span.from, span.to, { toEnd: span.toEnd, width: cols });
  });
}

/** The selected text as the user sees it — no colour, no trailing padding. */
function selectedText(screen) {
  const lines = screen.selectionLines || screen.lastFeedLines;
  const range = screen.textSelection && screen.textSelection.range();
  if (!lines || !range) return '';
  return textOf(measure(lines), range);
}

module.exports = {
  measure, offsetAt, spanOnLine, textOf, highlight, lineForRow,
  beginAt, extendTo, selectedText, paintRows, MAX_COPY_CHARS,
};
