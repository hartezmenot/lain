'use strict';


/** INPUT. Emits complete user inputs, where a PASTE IS ONE INPUT. */

const EventEmitter = require('events');
const { decodeEscape, mouseEvent } = require('./keydecode');
const { clipboardKey } = require('./selection');
const { UndoStack } = require('./undo');

/** The escape byte, named rather than written: a raw 0x1b in source is invisible in a diff. */
const ESC = String.fromCharCode(27);
/** Ctrl+C. Named for the same reason ESC is: a raw control byte is invisible in a diff. */
const CTRL_C = String.fromCharCode(3);

// Bracketed paste - the markers and the framing - lives in its own file.
const paste = require('./pastebuffer');
const { PASTE_START, PASTE_END } = paste;

const MAX_HISTORY = 200;
/** How many pasted blocks one line remembers, for the COMPOSER's drawing only. */
const MAX_PASTE_RECORDS = 16;
/** How long a lone ESC waits to see whether it is really an arrow key. */
const ESC_WAIT_MS = 40;

class Input extends EventEmitter {
  constructor({ stdin = process.stdin, stdout = process.stdout } = {}) {
    super();
    this.stdin = stdin;
    this.stdout = stdout;
    this.isTTY = Boolean(stdin.isTTY);
    this.buf = '';        // bytes not yet forming a complete input
    this.line = '';       // the line being typed (TTY)
    this.cursor = 0;      // caret position within `line`
    this.pasting = false;
    /** What is selected in the line being edited. See selection.js. */
    this.sel = new (require('./selection').Selection)();
    this.pasteBuf = '';
    /** Did any part of the line being edited arrive as a paste? */
    this.pastedInLine = false;
    /** WHAT arrived as a paste in the line being edited, oldest first — never WHERE it is. */
    this.pastesInLine = [];
    this.closed = false;
    this.promptStr = '';
    /** When the TUI owns the input row, the reader must not echo. */
    this.echo = true;
    /** Submitted prompts, newest last. Bounded, in-memory, this session only. */
    this.history = [];
    /** Where ↑/↓ currently sit. `history.length` means "not recalling". */
    this.histIndex = 0;
    /** What was being typed before recall started, so ↓ can return to it. */
    this.draft = '';
    /** UNDO / REDO — scoped to the line currently being edited, not to the session. */
    this._undoStack = new UndoStack();
    /** Ask the terminal for mouse reports. */
    this.mouse = false;
    this._onData = this._onData.bind(this);
  }

  start() {
    if (this.isTTY) {
      try { this.stdin.setRawMode(true); } catch { /* not a real tty */ }
      this.stdout.write('\x1b[?2004h'); // enable bracketed paste
      this._mouseOn();
    }
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', this._onData);
    this.stdin.on('end', () => this._close());
    this.stdin.on('close', () => this._close());
    this.stdin.resume();
  }

  stop() {
    if (this._escTimer) { clearTimeout(this._escTimer); this._escTimer = null; }
    if (this.closed) return;
    this.closed = true;
    if (this.isTTY) {
      this.stdout.write('\x1b[?2004l');
      this._mouseOff();
      try { this.stdin.setRawMode(false); } catch { /* already restored */ }
    }
    this.stdin.removeListener('data', this._onData);
    try { this.stdin.pause(); } catch { /* already paused */ }
  }

  // mouse SGR encoding (`ESC[<b;x;yM`) is the only one whose coordinates survive past column 95.

  /** Turn reporting on, if it is wanted and there is a terminal to ask. */
  _mouseOn() {
    if (!this.mouse || !this.isTTY) return;
    this.stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    this._mouseEnabled = true;
  }

  _mouseOff() {
    if (!this._mouseEnabled) return;
    this.stdout.write('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
    this._mouseEnabled = false;
  }

  /** Called by the UI once it knows it owns a real terminal. */
  enableMouse() {
    this.mouse = true;
    if (!this.closed) this._mouseOn();
  }

  /** GIVE THE TERMINAL ITS SELECTION BACK. */
  disableMouse() {
    this.mouse = false;
    this._mouseOff();
  }

  /** Is the terminal's own selection currently taken? */
  mouseCaptured() {
    return Boolean(this._mouseEnabled);
  }

  _close() {
    if (this.closed) return;
    // Flush a trailing line that arrived without a newline — this is what makes `echo "fix the parser" | lain` work, where there is no Enter to press.
    const pending = (this.line + this.buf).trim();
    const wasPasted = this.pastedInLine;
    if (pending && !wasPasted) { this.line = ''; this.cursor = 0; this.buf = ''; this.pastedInLine = false; this.pastesInLine.length = 0; this._emitInput(pending, false); }
    this.closed = true;
    this.emit('close');
  }

  // history Bounded, in-memory, owned HERE where a submitted line is already known.

  /** Put a line into history without submitting it — an MCQ answer typed on this same line resolves inside the panel and never reaches `_emitInput`, so… */
  remember(value) { this._remember(value); this.histIndex = this.history.length; }

  _remember(value) {
    const v = String(value);
    if (!v.trim()) return;                                  // blanks never enter
    if (this.history[this.history.length - 1] === v) return; // no run of dupes
    this.history.push(v);
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  /** Replace the line outright — history recall, a completion being accepted. */
  setLine(text) {
    this.line = String(text == null ? '' : text);
    this.cursor = this.line.length;
    this.pastedInLine = false;
    this.pastesInLine.length = 0;
    this._resetUndo();
    this.emit('edit', this.line);
    return this.line;
  }

  // caret The line used to be append-only — ←/→/Home/End were decoded and fell through to nothing, so a typo could only be fixed by deleting everything…

  /** Insert text at the caret and leave the caret after it. */
  _insert(text, kind = 'insert') {
    this._pushUndo(kind);
    if (this.hasSelection()) this._deleteSelectionRaw();
    const s = String(text);
    this.line = this.line.slice(0, this.cursor) + s + this.line.slice(this.cursor);
    this.cursor += s.length;
    this.emit('edit', this.line);
  }

  // THE SELECTION

  /** Where a drag began, or null. Read by the mouse layer. */
  get selAnchor() { return this.sel.anchor; }

  /** A NEW SELECTION breaks any typing run in progress — see `_undoBreak`. */
  selectFrom(at) {
    this._undoBreak();
    return this.sel.from(at, this.line.length);
  }

  selectTo(at) {
    if (!this.sel.to(at, this.line.length)) return false;
    this.emit('edit', this.line);
    return true;
  }

  clearSelection() { return this.sel.clear(); }

  hasSelection() { return this.sel.active(); }

  /** `{start, end}` in buffer order, or null. The one answer everything reads. */
  range() { return this.sel.range(); }

  /** The selected text, or an empty string. */
  selectedText() {
    const r = this.range();
    return r ? this.line.slice(r.start, r.end) : '';
  }

  /** Remove the current selection with NO undo snapshot — for `_insert`, which takes ONE snapshot covering the whole "replace selection with typed text". */
  _deleteSelectionRaw() {
    const r = this.range();
    if (!r) return false;
    this.line = this.line.slice(0, r.start) + this.line.slice(r.end);
    this.cursor = r.start;
    this.clearSelection();
    if (this.line === '') { this.pastedInLine = false; this.pastesInLine.length = 0; }
    return true;
  }

  /** Delete the selection, leaving the caret where it began. */
  deleteSelection() {
    if (!this.hasSelection()) return false;
    this._pushUndo('delete-selection');
    const did = this._deleteSelectionRaw();
    if (did) this.emit('edit', this.line);
    return did;
  }

  /** Insert text at the caret, as though it had been typed or pasted. */
  insertText(text, { pasted = false } = {}) {
    // LF ONLY, the same as a bracketed paste — see pastebuffer.js `lf`.
    const s = paste.lf(text == null ? '' : text);
    if (!s) return false;
    this._insert(s, pasted ? 'paste' : 'insert');
    if (pasted) {
      this.pastedInLine = true;
      // RECORDED FOR THE DRAWING, AND ONLY FOR THE DRAWING — see the field.
      this.pastesInLine.push(s);
      if (this.pastesInLine.length > MAX_PASTE_RECORDS) this.pastesInLine.shift();
    }
    return true;
  }

  /** Move the caret by `delta` characters. Returns true if it moved. */
  moveCursor(delta) {
    // A DELIBERATE CARET MOVE ENDS THE SELECTION (what an arrow key means everywhere else) AND BREAKS AN UNDO RUN — typing, moving away, and typing again…
    this.clearSelection();
    this._undoBreak();
    const next = Math.max(0, Math.min(this.line.length, this.cursor + delta));
    if (next === this.cursor) return false;
    this.cursor = next;
    this.emit('edit', this.line);
    return true;
  }

  /** ↑/↓ INSIDE A MULTI-LINE BUFFER — move between its lines, keeping the column. */
  moveCursorLine(delta) {
    if (!this.line.includes('\n')) return false;
    const before = this.line.slice(0, this.cursor);
    const lines = this.line.split('\n');
    const row = before.split('\n').length - 1;
    const col = this.cursor - (before.lastIndexOf('\n') + 1);
    const next = row + delta;
    if (next < 0 || next >= lines.length) return false;
    this._undoBreak();
    let at = 0;
    for (let i = 0; i < next; i++) at += lines[i].length + 1;
    this.cursor = at + Math.min(col, lines[next].length);
    this.emit('edit', this.line);
    return true;
  }

  /** DELETE THE PREVIOUS WORD — Ctrl+Backspace, Ctrl+W, Alt+Backspace. */
  deleteWord() {
    if (require('./lineedit').deletePaste(this, -1)) return true;   // a collapsed paste goes whole
    if (this.cursor <= 0) return false;
    const before = this.line.slice(0, this.cursor);
    const isWord = (c) => /[A-Za-z0-9_]/.test(c);
    let i = before.length;
    while (i > 0 && /\s/.test(before[i - 1])) i -= 1;
    if (i > 0) {
      const cls = isWord(before[i - 1]);
      while (i > 0 && !/\s/.test(before[i - 1]) && isWord(before[i - 1]) === cls) i -= 1;
    }
    if (i === this.cursor) return false;
    this._pushUndo('delete-word');
    this.line = before.slice(0, i) + this.line.slice(this.cursor);
    this.cursor = i;
    if (this.line === '') { this.pastedInLine = false; this.pastesInLine.length = 0; }
    this.emit('edit', this.line);
    return true;
  }

  // UNDO / REDO — the stack and its coalescing rule live in undo.js Every EDIT calls `_pushUndo(kind)` before it mutates `line`; every CARET- or…
  _pushUndo(kind) { this._undoStack.push(this._snapshot(), kind); }
  _undoBreak() { this._undoStack.break(); }
  _resetUndo() { this._undoStack.reset(); }

  _snapshot() {
    return { line: this.line, cursor: this.cursor, selAnchor: this.sel.anchor, selHead: this.sel.head };
  }

  _restore(snap) {
    this.line = snap.line;
    this.cursor = Math.max(0, Math.min(this.line.length, snap.cursor));
    this.sel.anchor = snap.selAnchor;
    this.sel.head = snap.selHead;
    if (this.line === '') { this.pastedInLine = false; this.pastesInLine.length = 0; }
    this.emit('edit', this.line);
  }

  /** Ctrl+Z. @returns {boolean} true when there was something to undo. */
  undo() {
    const prev = this._undoStack.popUndo(this._snapshot());
    if (!prev) return false;
    this._restore(prev);
    return true;
  }

  /** Ctrl+Y. @returns {boolean} true when there was something to redo. */
  redo() {
    const next = this._undoStack.popRedo(this._snapshot());
    if (!next) return false;
    this._restore(next);
    return true;
  }

  /** A decoded mouse report, classified in keydecode.js and emitted as one event. */
  _emitMouse(button, x, y, final) {
    this.emit('mouse', mouseEvent({ button, x, y, final }));
  }

  /** INSERT A NEWLINE AT THE CARET — a new line of prompt, not a submission. */
  newline() {
    this._insert('\n');
    // In TUI mode the screen owns the input region and redraws it from `edit`.
    if (this._echoing) this.stdout.write('\n');
    return true;
  }

  // THE LINE EDITOR lives in src/lineedit.js
  editKey(key) { return require('./lineedit').editKey(this, key); }
  lineStart() { return require('./lineedit').lineStart(this); }
  lineEnd() { return require('./lineedit').lineEnd(this); }
  wordBoundary(dir) { return require('./lineedit').wordBoundary(this, dir); }
  moveCursorTo(at) { return require('./lineedit').moveCursorTo(this, at); }
  extendSelection(at) { return require('./lineedit').extendSelection(this, at); }
  deleteForward() { return require('./lineedit').deleteForward(this); }
  cursorHome() { return require('./lineedit').cursorHome(this); }
  cursorEnd() { return require('./lineedit').cursorEnd(this); }
  selectAll() { return require('./lineedit').selectAll(this); }
  deleteWordForward() { return require('./lineedit').deleteWordForward(this); }


  /** Submit the current line exactly as if Enter had been pressed. */
  submitLine() {
    const text = this.line;
    this.line = '';
    this.cursor = 0;
    this.histIndex = this.history.length;
    this._resetUndo();
    this.emit('edit', '');
    if (text.trim()) this._emitInput(text, false);
    return text;
  }

  /** ↑ — an older prompt. Returns false when there is nothing older. */
  recallPrev() {
    if (!this.history.length || this.histIndex <= 0) return false;
    if (this.histIndex === this.history.length) this.draft = this.line;
    this.histIndex -= 1;
    this.setLine(this.history[this.histIndex]);
    return true;
  }

  /** ↓ — a newer prompt, then back to whatever was being typed. */
  recallNext() {
    if (this.histIndex >= this.history.length) return false;
    this.histIndex += 1;
    this.setLine(this.histIndex === this.history.length ? this.draft : this.history[this.histIndex]);
    return true;
  }

  prompt(str) {
    if (str !== undefined) this.promptStr = str;
    if (this.isTTY && !this.closed) this.stdout.write(this.promptStr);
  }

  _emitInput(text, isPaste) {
    const value = String(text);
    if (!value.trim()) return;
    // A paste is content, often huge, and is not something anyone wants to
    // arrow back through — it stays out of history, as it always has.
    if (!isPaste) this._remember(value);
    this.histIndex = this.history.length;
    this.draft = '';
    this.emit('input', { text: value, isPaste: Boolean(isPaste), lines: value.split('\n').length });
  }

  _onData(chunk) {
    this.buf += chunk;

    for (;;) {
      // BRACKETED PASTE IS A PROTOCOL ON THE BYTE STREAM, and it is framed in src/pastebuffer.js - see the note there for why it is not editing, and for the…
      if (this.pasting) { if (paste.absorb(this)) continue; return; }
      if (paste.open(this)) continue;

      if (!this._consume()) return;
    }
  }

  /** True while the reader may write to the terminal: only a TTY has a cursor. */
  get _echoing() { return this.echo && this.isTTY; }

  /** Minimal editing over the raw byte stream — the ONE consumer, used for a TTY and a pipe alike. */
  _consume() {
    if (!this.buf.length) return false;
    const ch = this.buf[0];

    // A NEW LINE, WITHOUT SENDING A bare LINE FEED is Ctrl+J, the one newline request every terminal can send — Shift+Enter is handled below where…
    if (ch === '\n' && this.isTTY) {
      this.buf = this.buf.slice(1);
      this.newline();
      return true;
    }

    if (ch === '\r' || ch === '\n') {
      // CRLF is one Enter, not two.
      this.buf = this.buf.slice(ch === '\r' && this.buf[1] === '\n' ? 2 : 1);
      // Enter belongs to an open completion menu even when the line is not empty — "/stat<Enter>" means run the highlighted command, not send the fragment to…
      if (typeof this.enterGoesToUI === 'function' && this.enterGoesToUI()) {
        this.emit('key', 'enter');
        return true;
      }
      const text = this.line;
      const wasPasted = this.pastedInLine;
      this.line = '';
      this.cursor = 0;
      this.pastedInLine = false;
      this.histIndex = this.history.length;
      this.draft = '';
      this._resetUndo();
      if (this._echoing) this.stdout.write('\n');
      this.emit('edit', '');
      // An empty Enter is a UI action (confirm a panel selection), not input.
      if (!text.trim()) { this.emit('key', 'enter'); return true; }
      // ONE input, however it was assembled: typed, pasted, or typed around a paste.
      this._emitInput(text, wasPasted);
      return true;
    }
    if (ch === '\t') {                            // completion accept
      this.buf = this.buf.slice(1);
      this.emit('key', 'tab');
      return true;
    }
    // CTRL+BACKSPACE — delete the previous WORD.
    if (ch === '\b') {                            // ctrl-backspace
      this.buf = this.buf.slice(1);
      this.deleteWord();
      return true;
    }
    if (ch === '\x17') {                          // ctrl-w
      this.buf = this.buf.slice(1);
      this.deleteWord();
      return true;
    }
    if (ch === '\x7f') {                          // backspace
      this.buf = this.buf.slice(1);
      // WITH A SELECTION, BACKSPACE DELETES ALL OF IT — one keystroke.
      if (this.deleteSelection()) return true;
      // Backspace only ever edits text.
      if (this.cursor > 0) {
        this._pushUndo('delete-back');
        this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
        this.cursor -= 1;
        if (this.line === '') { this.pastedInLine = false; this.pastesInLine.length = 0; }
        if (this._echoing) this.stdout.write('\b \b');
        this.emit('edit', this.line);
      }
      return true;
    }
    // THE CLIPBOARD KEYS — Ctrl+C, Ctrl+X, Ctrl+V.
    if (clipboardKey(this, ch)) { this.buf = this.buf.slice(1); return true; }
    if (ch === CTRL_C) {                          // ctrl-c, with nothing selected
      this.buf = this.buf.slice(1);
      this.emit('interrupt');
      return true;
    }
    if (ch === '\x04') {                          // ctrl-d
      this.buf = this.buf.slice(1);
      if (!this.line) { this._close(); return false; }
      return true;
    }
    if (ch === ESC) {
      // WHAT THE SEQUENCE MEANS lives in keydecode.js — a pure function of the buffer, so every terminal disagreement it navigates is assertable without a…
      const d = decodeEscape(this.buf);
      if (!d) { this.buf = this.buf.slice(1); return true; }
      // Incomplete but still possible: reading the lone ESC now would turn a
      // split arrow key into a spurious cancel.
      if (d.wait) { this._armEscape(); return false; }
      this.buf = this.buf.slice(d.take);
      if (d.mouse) { this._emitMouse(d.mouse.button, d.mouse.x, d.mouse.y, d.mouse.final); return true; }
      if (d.action === 'deleteWord') { this.deleteWord(); return true; }
      if (d.action === 'newline') { this.newline(); return true; }
      if (d.key) this.emit('key', d.key);
      return true;
    }
    if (ch >= '\x01' && ch <= '\x1a' && !'\r\n\b'.includes(ch)) {
      // Ctrl+letter. Ctrl+1..5 arrive as plain digits on most terminals, so the
      // view tabs are bound in the printable path below instead.
      this.buf = this.buf.slice(1);
      this.emit('key', 'ctrl-' + String.fromCharCode(ch.charCodeAt(0) + 96));
      return true;
    }
    // Printable run. TAB (\x09) is excluded deliberately: it falls outside the control ranges either side of it, so leaving it in swallowed the keystroke…
    const m = /^[^\r\n\t\x00-\x08\x0b-\x1f\x7f]+/.exec(this.buf);
    if (!m) { this.buf = this.buf.slice(1); return true; }
    // INSERT AT THE CURSOR, not at the end.
    this._insert(m[0]);
    // In TUI mode the screen owns the input row, so echoing here would draw the
    // characters twice; `edit` lets the screen redraw the row it owns.
    if (this._echoing) this.stdout.write(m[0]);
    this.buf = this.buf.slice(m[0].length);
    return true;
  }

  /** Resolve a pending bare ESC once it is clear no sequence is following. */
  _armEscape() {
    if (this._escTimer) return;
    this._escTimer = setTimeout(() => {
      this._escTimer = null;
      if (this.closed) return;
      if (!/^\x1b(?:\[[0-9;]*)?$/.test(this.buf)) return;  // it completed after all
      this.buf = this.buf.slice(1);
      this.emit('key', 'escape');
      if (this.buf) this._onData('');
    }, ESC_WAIT_MS);
    if (this._escTimer.unref) this._escTimer.unref();
  }
}

module.exports = { Input, PASTE_START, PASTE_END };
