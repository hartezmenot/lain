'use strict';

/** THE INPUT VIEWPORT — pure geometry for the input row. */
/** THE BUFFER AS THE ROWS IT ACTUALLY OCCUPIES —. */
/** How many CODE UNITS of `text`, from `col`, fit in `room` CELLS. */
function unitsIn(text, col, room) {
  const { cells } = require('./text');
  let used = 0;
  let i = col;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const w = cells(cp);
    if (used + w > room && i > col) break;
    used += w;
    i += cp > 0xffff ? 2 : 1;
  }
  return i - col;
}

function wrapInput(buffer, width) {
  const buf = String(buffer == null ? '' : buffer);
  // One column is reserved for the caret: at the end of a row it sits AFTER the
  // last character and needs somewhere to be drawn.
  const room = Math.max(4, Number(width) || 4) - 1;
  const rows = [];
  let at = 0;

  for (const [line, text] of buf.split('\n').entries()) {
    let col = 0;
    do {
      const fits = unitsIn(text, col, room);
      if (col + fits >= text.length) {
        rows.push({ line, start: col, text: text.slice(col), begins: at + col, last: true });
        break;
      }
      // The last space inside the room, so a word is not split when it need not be.
      const window = text.slice(col, col + fits + 1);
      const space = window.lastIndexOf(' ');
      // A SINGLE TOKEN LONGER THAN THE BOX is cut mid-word. The alternative is
      // a blank row followed by the same problem, which is worse than a cut.
      const take = space > 0 ? space : fits;
      rows.push({ line, start: col, text: text.slice(col, col + take), begins: at + col, last: false });
      // A space AT the break is consumed by it: leading a wrapped row with a
      // space is a visible indent nobody typed.
      col += take + (space > 0 ? 1 : 0);
    } while (true);
    at += text.length + 1;
  }
  return rows;
}

/** Which visual row the caret is on, and which column of it. */
function caretRow(rows, cursor) {
  const caret = Math.max(0, Number(cursor) || 0);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const end = r.begins + r.text.length;
    if (caret < end) return { row: i, col: caret - r.begins };
    if (caret === end && (r.last || i === rows.length - 1)) return { row: i, col: caret - r.begins };
  }
  const last = rows[rows.length - 1] || { begins: 0, text: '' };
  return { row: Math.max(0, rows.length - 1), col: last.text.length };
}

/** THE INPUT VIEWPORT — what to show of a line too long to fit, and where the caret sits within that. */
function inputViewport(buffer, cursor, width) {
  const buf = String(buffer == null ? '' : buffer);
  const caret = Math.max(0, Math.min(buf.length, Number(cursor) || 0));
  const all = buf.split('\n');
  // Which line the caret is on, and where within it.
  let line = 0;
  let seen = 0;
  for (; line < all.length; line++) {
    if (caret <= seen + all[line].length) break;
    seen += all[line].length + 1;
  }
  if (line >= all.length) line = all.length - 1;
  const text = all[line] || '';
  const col = caret - seen;

  // One column is reserved for the caret itself: at the end of a line it sits AFTER the last character, which needs somewhere to be drawn.
  const room = Math.max(4, width) - 1;
  if (text.length <= room) {
    return { text, cursorCol: Math.min(col, room), line, lines: all.length, scrolled: false, start: 0, lineStart: seen };
  }

  // Keep the caret inside the window with a little context ahead of it, so the next characters typed are already visible rather than each one shoving the…
  const pad = Math.min(8, Math.floor(room / 4));
  let start = Math.max(0, col - room + pad);
  start = Math.min(start, Math.max(0, text.length - room));
  let slice = text.slice(start, start + room);
  let cursorCol = col - start;

  // Ellipses replace a character each, never overlay one, so the column the
  // caret is drawn in stays truthful.
  if (start > 0) { slice = '…' + slice.slice(1); }
  if (start + room < text.length) { slice = slice.slice(0, -1) + '…'; }
  cursorCol = Math.max(0, Math.min(slice.length, cursorCol));
  return { text: slice, cursorCol, line, lines: all.length, scrolled: true, start, lineStart: seen };
}

/** `pasteSummary` STOOD HERE — the extra row under the input box reading `⎘ 1,200 lines · 41.2 KB · "Traceback (most recent call last):"`. */

/** How many lines the buffer holds. */
function lineCount(buffer) {
  const s = String(buffer == null ? '' : buffer);
  if (!s) return 1;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

module.exports = { inputViewport, lineCount, wrapInput, caretRow };
