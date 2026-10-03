'use strict';

/** THE INPUT — how tall it is, what is drawn in it, and where the caret goes. */

const views = require('./views');
const composer = require('./composer');

/** How many rows of a prompt the region may show at once. */
const MAX_INPUT_ROWS = 8;

/** THE COMPOSER'S INNER PADDING — one column, inside the fill. */
const PAD = 1;

/** Reverse video, and back. The one place this file knows an escape sequence. */
const REV = String.fromCharCode(27) + '[7m';
const OFF = String.fromCharCode(27) + '[27m';

/** Wrap the selected part of one drawn row in reverse video. */
function highlight(text, vr, sel) {
  if (!sel || !vr) return text;
  const from = Math.max(0, sel.start - vr.begins);
  const to = Math.min(text.length, sel.end - vr.begins);
  if (to <= 0 || from >= text.length || to <= from) return text;
  return text.slice(0, from) + REV + text.slice(from, to) + OFF + text.slice(to);
}

/** Is the open panel asking for something that must not be shown? */
function isSecret(screen) {
  const p = screen && screen.panel;
  return Boolean(p && p.visible && p.frame && p.frame.secret);
}

/** The text as it should be DRAWN: itself, or one dot per character. */
function maskIf(screen, text) {
  return isSecret(screen) ? '•'.repeat(String(text).length) : String(text);
}

/** How wide the text may be: the terminal, less the content frame's inset a side. */
function innerWidth(screen) {
  return Math.max(8, screen.cols - PAD * 2);
}

/** THE STRING THAT IS ACTUALLY DRAWN, and the maps back to the buffer. */
function shown(screen) {
  const raw = maskIf(screen, String(screen.inputText || ''));
  if (isSecret(screen)) return { text: raw, spans: [], toProjected: (i) => i, toBuffer: (j) => j };
  return composer.project(raw, screen.inputPastes || []);
}

/** The prompt as the rows it occupies at the CURRENT width. */
function wrapped(screen) {
  return views.wrapInput(shown(screen).text, innerWidth(screen));
}

function shownRows(screen) {
  return Math.max(1, Math.min(
    wrapped(screen).length,
    MAX_INPUT_ROWS,
    Math.max(1, Math.floor((screen.rows - 8) / 3)),
  ));
}

/** WHAT AN EMPTY REGION SAYS. */
const PLACEHOLDER = 'Ask LAIN…';

/** ...AND WHAT IT SAYS WHEN A QUESTION IS OPEN. */
function promptFor(screen) {
  // A COMPOSER SAYS WHAT IT IS CAPTURING
  const compose = screen && (screen.compose || (screen.state && screen.state.compose));
  if (compose) return `${compose} ›`;
  const p = screen && screen.panel;
  if (p && p.visible && p.acceptsTyped && !p.isCompletion) {
    try { return require('./answer').inputLabel(p.options, p.takes); } catch { /* fall through */ }
  }
  return PLACEHOLDER;
}

/** Draw the region. Returns the rows to paint, and moves nothing else. */
function draw(screen, { row: startRow, cols, textRows: totalRows, col: startCol = 1 }) {
  const out = [];
  let row = startRow;
  const { P } = require('./paint');
  const width = Math.max(12, cols || screen.cols);
  const inner = Math.max(8, width - PAD * 2);
  // The cursor-position escape, built rather than written: a raw 0x1b in a source file is what the architecture guard forbids, because it is invisible in…
  const ESC = String.fromCharCode(27);
  const at = (r, c) => ESC + '[' + r + ';' + c + 'H';
  /** One row of the region: the FRAME's width, on the grey ground. */
  // THE ACTIVE EDGE (2026-09-23): the inset cell carries a blue `▌`, LAIN's identity colour — one cell, exactly the PAD it replaces, so every caret and…
  const edge = PAD ? (P.accent ? P.accent('▌') : '▌') + ' '.repeat(PAD - 1) : '';
  const ground = (body, visible) => P.surface(
    edge + body + ' '.repeat(Math.max(0, width - visible)),
  );

  const view = shown(screen);
  // A COMPOSER KEEPS ITS LABEL WHILE THERE IS TEXT: `GOAL › Finish the Harness`.
  const composing = screen && (screen.compose || (screen.state && screen.state.compose));
  const lead = composing && view.text.length ? `${composing} › ` : '';
  const wrappedRows = views.wrapInput(view.text, Math.max(8, inner - lead.length));
  const caret = views.caretRow(wrappedRows, view.toProjected(screen.inputCursorAt));
  // The window follows the caret, so a prompt taller than the region scrolls
  // rather than pinning to its top.
  let first = Math.max(0, Math.min(caret.row - Math.floor((totalRows - 1) / 2), wrappedRows.length - totalRows));
  if (first < 0) first = 0;

  const many = wrappedRows.length > totalRows;
  /** THE TEXT SITS IN THE MIDDLE OF THE REGION */
  const spare = Math.max(0, totalRows - Math.min(wrappedRows.length, totalRows));
  const topPad = Math.floor(spare / 2);
  // THE PLACEHOLDER ONLY WHEN THERE IS GENUINELY NOTHING, and never over a masked credential prompt, where a grey word where the dots go would read as…
  const empty = !view.text.length && !isSecret(screen);
  /** WHAT IS BEHIND THE MARKERS, on the caret's row, right-aligned. */
  const behind = composer.hidden(view.spans, maskIf(screen, String(screen.inputText || '')));

  // WHERE THE REGION BEGINS, as well as where its caret is.
  screen.rowMap.inputStartRow = startRow;
  screen.rowMap.inputRegionRows = totalRows;
  screen.rowMap.inputLines = [];
  for (let i = 0; i < totalRows; i++) {
    // WHICH WRAPPED ROW THIS TERMINAL ROW SHOWS, or none: the rows above and
    // below a centred prompt are fill and carry no text.
    const vi = i - topPad;
    const vr = vi >= 0 && vi < totalRows ? wrappedRows[first + vi] : undefined;
    // ONLY THE CARET'S ROW CARRIES A MARKER, and only when there is something to mark: how far through a scrolled prompt you are, or what the placeholders…
    const onCaret = vr ? first + vi === caret.row : false;
    const tag = onCaret
      ? (many ? `  [${caret.row + 1}/${wrappedRows.length}]` : '') + (behind ? `  ${behind}` : '')
      : '';
    // TABS ARE EXPANDED BEFORE THE ROW IS MEASURED OR DRAWN.
    const text = vr ? views.clip(require('./text').detab(vr.text), Math.max(4, inner - tag.length)) : '';
    const placeholder = views.clip(promptFor(screen), inner);
    // THE SELECTION, IN REVERSE VIDEO.
    const pre = lead && vr ? (first + vi === 0 ? P.meta(lead) : ' '.repeat(lead.length)) : '';
    const body = empty && vi === 0
      ? P.meta(placeholder)
      : pre + highlight(text, vr, screen.inputSelection) + (tag ? P.meta(tag) : '');
    if (vr) {
      // THE CLICK MAP IS IN *BUFFER* COORDINATES
      screen.rowMap.inputLines.push({
        row,
        line: vr.line,
        begins: view.toBuffer(vr.begins),
        length: view.toBuffer(vr.begins + vr.text.length) - view.toBuffer(vr.begins),
        start: 0,
      });
      if (onCaret) {
        // THE FIRST CHARACTER SITS AT THE CONTENT FRAME'S INSET, then text — the same column the conversation above it begins on.
        const caretCells = require('./text').width(vr.text.slice(0, caret.col));
        screen.cursorCol = startCol + PAD + lead.length + Math.min(caretCells, Math.max(0, inner));
        screen.cursorRow = row;
        screen.rowMap.inputRow = row;
        screen.rowMap.inputTextCol = startCol + PAD + lead.length;
        screen.rowMap.inputStart = 0;
        screen.rowMap.inputLineStart = view.toBuffer(vr.begins);
      }
    }
    // MEASURED ON THE PLAIN WIDTH.
    const W = require('./text').width;
    const visible = PAD + (empty && vi === 0 ? W(placeholder) : (vr ? W(lead) : 0) + W(text) + W(tag));
    // THE ERASE STAYS, AND IT IS NOT AN OUTER-BOUND DECISION
    out.push(require('./frameout').row(at(row++, startCol) + ground(body, visible)));
  }
  return out;
}

/** `summary()` STOOD HERE — the extra row under the box reading `⎘ 1,200 lines · 41.2 KB · "Traceback (most recent call last):"`. */

module.exports = { draw, wrapped, shownRows, shown, innerWidth, promptFor, MAX_INPUT_ROWS, PAD, PLACEHOLDER };
