'use strict';

/** THE INPUT SELECTION — an anchor, a head, and what that means. */

class Selection {
  constructor() {
    this.anchor = null;
    this.head = null;
  }

  /** Begin one at `at`. Nothing is selected until the head moves away. */
  from(at, max) {
    this.anchor = clamp(at, max);
    this.head = this.anchor;
    return this.anchor;
  }

  /** Move the head. Returns false when there is no selection in progress. */
  to(at, max) {
    if (this.anchor === null) return false;
    this.head = clamp(at, max);
    return true;
  }

  clear() {
    const had = this.active();
    this.anchor = null;
    this.head = null;
    return had;
  }

  active() {
    return this.anchor !== null && this.head !== null && this.head !== this.anchor;
  }

  /** `{start, end}` in buffer order, or null. */
  range() {
    if (!this.active()) return null;
    return { start: Math.min(this.anchor, this.head), end: Math.max(this.anchor, this.head) };
  }
}

function clamp(at, max) {
  const n = Number(at);
  const top = Number.isFinite(max) ? max : Infinity;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(top, n));
}

/** THE CLIPBOARD KEYS, and what a selection changes about them. */
function clipboardKey(reader, ch) {
  const CTRL_C = String.fromCharCode(3);
  const CTRL_X = String.fromCharCode(24);
  const CTRL_V = String.fromCharCode(22);
  if (ch === CTRL_C) {
    if (!reader.hasSelection()) return false;    // it still means interrupt
    reader.emit('clipboard', { action: 'copy', text: reader.selectedText() });
    return true;
  }
  if (ch === CTRL_X) {
    if (reader.hasSelection()) {
      reader.emit('clipboard', { action: 'cut', text: reader.selectedText() });
      reader.deleteSelection();
    }
    return true;
  }
  if (ch === CTRL_V) {
    // Most terminals paste by writing the bytes themselves (bracketed, which
    // the reader already handles). This is for the ones that send the key.
    reader.emit('clipboard', { action: 'paste' });
    return true;
  }
  return false;
}

module.exports = { Selection, clipboardKey };
