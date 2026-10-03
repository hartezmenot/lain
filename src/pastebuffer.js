'use strict';

/** BRACKETED PASTE — the framing, split out of the line editor. */

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** HOW MANY BYTES AT THE END OF `buf` COULD BE THE START OF `marker`. */
function partialSuffix(buf, marker) {
  const max = Math.min(buf.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (buf.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}

/** INSIDE A PASTE: take what has arrived, and say whether it ended. */
function absorb(r) {
  const end = r.buf.indexOf(PASTE_END);
  if (end < 0) {
    // A tail that could be the beginning of the end marker joins the next read.
    // Anything that cannot be is paste content and goes in. See the header.
    const keep = partialSuffix(r.buf, PASTE_END);
    r.pasteBuf += keep ? r.buf.slice(0, r.buf.length - keep) : r.buf;
    r.buf = keep ? r.buf.slice(r.buf.length - keep) : '';
    return false;
  }
  r.pasteBuf += r.buf.slice(0, end);
  r.buf = r.buf.slice(end + PASTE_END.length);
  r.pasting = false;

  // A PASTE IS TEXT ARRIVING IN THE INPUT BOX — never a submission.
  const text = lf(r.pasteBuf).replace(/\n$/, '');
  r.pasteBuf = '';

  // ONE UNDO STEP for the whole paste, and A SELECTION UNDER IT IS REPLACED exactly as typing over one is — this writes `line`/`cursor` directly rather…
  r._pushUndo('paste');
  if (r.hasSelection()) r._deleteSelectionRaw();
  // Pasted text lands AT THE CARET, like any other insertion, and leaves the
  // caret after it — so the viewport follows what was just pasted.
  r.line = r.line.slice(0, r.cursor) + text + r.line.slice(r.cursor);
  r.cursor += text.length;
  // Remembered so the eventual submit can still say it came from a paste;
  // downstream never has to guess that from the content.
  r.pastedInLine = r.pastedInLine || Boolean(text);
  // AND THE PAYLOAD ITSELF, FOR THE COMPOSER'S DRAWING
  if (text && Array.isArray(r.pastesInLine)) {
    r.pastesInLine.push(text);
    if (r.pastesInLine.length > 16) r.pastesInLine.shift();
  }
  r.histIndex = r.history.length;
  r.emit('edit', r.line, { pasted: true });
  return true;
}

/** THE EDITOR BUFFER HOLDS LF ONLY — every line ending becomes `\n`. */
function lf(s) { return String(s).replace(/\r\n?/g, '\n'); }

/** NOT IN A PASTE: open one if the start marker is here. */
function open(r) {
  const start = r.buf.indexOf(PASTE_START);
  if (start < 0) return false;
  const before = r.buf.slice(0, start);
  r.buf = r.buf.slice(start + PASTE_START.length);
  r.pasting = true;
  if (!before) return true;
  if (r.isTTY) {
    // TYPED CHARACTERS GO IN AT THE CARET, AND MOVE IT
    const typed = before.replace(/\r/g, '');
    r.line = r.line.slice(0, r.cursor) + typed + r.line.slice(r.cursor);
    r.cursor += typed.length;
    return true;
  }
  // PIPED INPUT. `before` can hold whole lines that arrived in the same chunk as the paste marker. Assigning them to `line` — a TTY-only field the piped…
  const parts = before.replace(/\r/g, '').split('\n');
  const partial = parts.pop();
  for (const line of parts) r._emitInput(line, false);
  if (partial) r.pasteBuf += partial;
  return true;
}

module.exports = { PASTE_START, PASTE_END, partialSuffix, absorb, open, lf };
