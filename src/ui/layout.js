'use strict';

/** THE SCREEN — ONE SURFACE, four regions. */

const views = require('./views');
// A credential may exist inside LAIN and may not be drawn. See src/redact.js
// and the note in `draw` for why the filter sits on the writer.
const redact = require('../redact');
const textselect = require('./textselect');
// Every width in this file is a VISIBLE width. The regions are drawn by padding
// content out to a frame, and `.length` counts colour escapes as cells.
const T = require('./text');
const { P } = require('./paint');

const MIN_ROWS = 8;
const MIN_COLS = 40;

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const HIDE_CUR = '\x1b[?25l';
const SHOW_CUR = '\x1b[?25h';
const CLEAR = '\x1b[2J';

function at(row, col) { return `\x1b[${row};${col}H`; }

// A DRAWN ROW, repainted in place rather than the whole screen being cleared first (the reported flicker): `geometry()` fixes every region's row count…
const L = require('./frameout').row;

/** THE ONE RULE ON THE SCREEN — the line under the header. */
function separator(width, right = '', left = '') {
  const w = Math.max(4, width);
  const tail = right ? ` ${right} ` : '';
  // AND THE SCROLL ANCHOR ON ITS LEFT-HAND END
  const room = w - T.width(tail) - 4;
  const head = left && T.width(left) + 2 <= room ? ` ${left} ` : '';
  const dashes = Math.max(0, w - T.width(tail));
  // THE ANCHOR IS A PINNED ONE-LINE PROMPT PREVIEW
  if (!head) return P.meta('─'.repeat(dashes) + tail);
  // `USER · <preview>` arrives as one string (ui/anchors.js `mark`); the label and
  // the quotation are painted apart so the row reads as a label and a quotation.
  const cut = left.indexOf(' · ');
  const who = cut < 0 ? left : left.slice(0, cut);
  const said = cut < 0 ? '' : left.slice(cut + 3);
  const shown = ` ${left} `;
  const painted = P.surface(
    ' ' + P.key(who) + (said ? P.meta(' · ') + P.plain(said) : '') + ' ',
  );
  return painted + P.meta('─'.repeat(Math.max(0, dashes - T.width(shown))) + tail);
}

class Screen {
  constructor({ out = process.stdout, panel = null } = {}) {
    this.out = out;
    this.panel = panel;
    this.active = false;
    this.workspaceScroll = 0;             // rows scrolled from the TOP of content
    // DRAG-SELECTION OVER THE FEED — the same Selection the input box uses, over a different buffer: the whole rendered feed as plain text, so a selection…
    this.textSelection = new (require('../selection').Selection)();
    this.selectionLines = null;
    /** THE VIEWPORT HAS THREE STATES, and only two of them were ever true here. */
    // THE CONVERSATION FOLLOWS LIVE.
    this.stickToBottom = true;
    this._anchorSpoken = 0;
    this.inputText = '';
    /** THE PAYLOADS IN `inputText` THAT ARRIVED AS PASTES — drawing only. */
    this.inputPastes = [];
    /** Caret position within `inputText`, and which line of it that lands on. */
    this.inputCursorAt = 0;
    this.inputCursorLine = 0;
    this.exitHint = '';                   // "press Ctrl+C again to exit", or ''
    this.status = views.STATE.READY;
    this.state = {};                      // last state snapshot given by the app
    this.completion = null;               // completion screen content, or null
    // THE FRAME PUT ON THE WIRE BY THE LAST DRAW — see the end of `draw`.
    this._lastFrame = null;
    // A resize changes `this.rows` itself, which `L`'s per-row erase cannot cover.
    this._onResize = () => { this._lastFrame = null; if (this.active) this.out.write(CLEAR); this.draw(); };
  }

  /** Terminal size. A pipe reports no dimensions, so COLUMNS/LINES are honoured as the fallback — the usual convention, and what makes the forced-TUI mode… */
  get cols() {
    return Math.max(MIN_COLS, this.out.columns || Number(process.env.COLUMNS) || 80);
  }

  get rows() {
    return Math.max(MIN_ROWS, this.out.rows || Number(process.env.LINES) || 24);
  }

  /** Enter the full-screen UI. */
  enter() {
    const forced = process.env.LAIN_FORCE_TUI === '1';
    if (this.active || (!this.out.isTTY && !forced)) return false;
    this.active = true;
    // THE CURSOR STAYS VISIBLE —.
    this._lastFrame = null;
    this.out.write(ALT_ON + CLEAR);
    this.out.on('resize', this._onResize);
    return true;
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    try { this.out.removeListener('resize', this._onResize); } catch { /* detached */ }
    this._lastFrame = null;
    this.out.write(SHOW_CUR + ALT_OFF);
  }

  /** Region heights — see ui/geometry.js. */
  geometry() { return require('./geometry').regions(this); }

  /** The conversation, and the content of the current pane — ui/panesource.js. */
  liveLines(width) { return require('./panesource').liveLines(this, width); }

  workspaceLines(width, height = 20) { return require('./panesource').workspaceLines(this, width, height); }

  /** What the LLM status strip shows, straight from the snapshot the UI built. */
  statusState() {
    return (this.state && this.state.llm) || { phase: null };
  }

  /** The summary row for a buffer too big to show, or null. */

  // THE INPUT REGION lives in ui/inputbox.js — see its header.
  _wrapped() { return require('./inputbox').wrapped(this); }
  _shownInputRows() { return require('./inputbox').shownRows(this); }

  /** The viewport state and the scroll hint — pure functions of state, living in views.js, whose whole job is state -> lines. */
  viewportState(spoken = 0) {
    return views.viewportState({ stickToBottom: this.stickToBottom, spoken, anchorSpoken: this._anchorSpoken });
  }

  scrollHint(lines, bodyRows) {
    return views.scrollHint(lines, bodyRows, {
      stickToBottom: this.stickToBottom, scroll: this.workspaceScroll, anchorSpoken: this._anchorSpoken,
    });
  }

  // THE PINNED TASK BANNER IS GONE, and this is where it was.

  // Thin delegations to ui/textselect.js, which owns the arithmetic; the Screen
  // supplies only which lines were painted and where they landed.
  selectFrom(x, y) { return textselect.beginAt(this, x, y); }
  selectTo(x, y) { return textselect.extendTo(this, x, y); }
  selectedText() { return textselect.selectedText(this); }
  hasSelection() { return this.textSelection.active(); }

  clearSelection() {
    const had = this.textSelection.clear();
    this.selectionLines = null;
    return had;
  }

  scrollWorkspace(delta) {
    const { workspace } = this.geometry();
    const feedRows = Math.max(1, workspace);
    // THE SAME WIDTH THE FRAME IS DRAWN AT, or the scroll would be computed against a feed of a different length than the one on screen.
    const lines = this.workspaceLines(views.contentBounds(this.cols).width, feedRows);
    const maxScroll = Math.max(0, lines.length - feedRows);
    this.workspaceScroll = Math.max(0, Math.min(this.workspaceScroll + delta, maxScroll));
    this.stickToBottom = this.workspaceScroll >= maxScroll;
    this.draw();
  }

  /** JUMP TO THE PREVIOUS OR NEXT THING THE USER SAID. */
  /** MOVING THE VIEWPORT lives in ui/navigate.js — see its header. */
  jumpToRow(row) { return require('./navigate').jumpToRow(this, row); }

  jumpToAnchor(dir) { return require('./navigate').jumpToAnchor(this, dir); }

  /** `_inputTop` AND `_inputLabel` STOOD HERE, and both are gone with the box. */

  /** Redraw everything from state. Deterministic; costs no model tokens. */
  draw(state = null) {
    if (state) this.state = state;
    if (!this.active) return;
    const cols = this.cols;
    const rows = this.rows;
    const g = this.geometry();
    const buf = [];
    // THE ONE CONTENT FRAME
    const box = views.contentBounds(cols);
    const col0 = box.left + 1;
    // WHERE CONTENT LANDED, for the click and selection arithmetic.
    this._box = box;

    // HEADER — ONE ROW OF METADATA, NO BOX
    const head = views.header({
      cwd: this.state.cwd,
      model: this.state.model,
      account: this.state.account || '', effort: this.state.effort || null,   // account first (Phase 8.2)
      provider: this.state.provider,
      connection: this.state.connection,
      output: this.state.output,
      width: box.width,
      run: this.state.run || null,
    });
    let row = 1;
    buf.push(L(at(row++, col0) + views.clip(head[0] || '', box.width)));
    // THE RULE UNDER IT IS DRAWN LAST, because the scroll hint it carries is not known until the feed has been laid out.
    const ruleRow = g.headerRows > 1 ? row++ : 0;

    // CONVERSATION (scrollable, bounded)
    const feedRows = Math.max(0, g.workspace);
    // THE INVISIBLE CONTENT FRAME
    const lines = this.workspaceLines(box.width, feedRows);
    // HELD FOR THE SELECTION, which needs the whole feed rather than the rows on screen — that is what lets a drag survive scrolling.
    this.lastFeedLines = lines;
    // WHERE EACH REGION ACTUALLY LANDED.

    // THE SCROLL POSITION IS SETTLED BEFORE ANYTHING DESCRIBES IT.
    require('./difftoggle').landing(this, lines, feedRows);   // a diff just opened lands on its hunk
    const maxScroll = Math.max(0, lines.length - feedRows);
    if (this.stickToBottom) {
      this.workspaceScroll = maxScroll;
      this._anchorSpoken = Number(lines.spoken) || 0;
    }
    if (this.workspaceScroll > maxScroll) this.workspaceScroll = maxScroll;

    // THE FRAME, RECORDED WITH THE REST OF THE GEOMETRY
    this.rowMap = { cols, contentCol: col0, contentWidth: box.width, gutter: box.left };
    // THE RULE, NOW THAT THE HINT IS KNOWN.
    const anchor = require('./anchors').scrollAnchor(lines, this.workspaceScroll, feedRows);
    this.rowMap.anchorRow = anchor ? ruleRow : 0;
    this.rowMap.anchorTarget = anchor ? anchor.row : -1;
    if (ruleRow) {
      buf.push(L(at(ruleRow, col0) + views.clip(
        separator(box.width, this.scrollHint(lines, feedRows), anchor ? anchor.mark : ''), box.width,
      )));
    }
    const window = lines.slice(this.workspaceScroll, this.workspaceScroll + feedRows);
    // NO PADDING ABOVE. The conversation starts at the TOP of its region and grows down, which is how reading works and what leaves the calm empty space…
    const feedPad = 0;
    this.rowMap.feedStart = row;
    this.rowMap.feedRows = feedRows;
    // Kept at zero so ui/textselect.js and ui/mouse.js keep ONE arithmetic for
    // window row -> feed line, rather than two that differ by a constant.
    this.rowMap.feedPad = feedPad;
    // Selection maps window row -> lines[scroll + i - pad].
    this.rowMap.feedScroll = this.workspaceScroll;

    const painted = textselect.paintRows(window, {
      lines, sel: this.textSelection && this.textSelection.range(), feedPad,
      scroll: this.rowMap.feedScroll, cols: box.width,
    });
    // THE COLUMN THE FEED STARTS ON, for ui/textselect.js: a click at screen column x is column `x - feedCol` of the line under it, and the frame moved…
    this.rowMap.feedCol = col0;
    for (let i = 0; i < feedRows; i++) {
      buf.push(L(at(row++, col0) + views.clip(painted[i] || '', box.width)));
    }

    // PENDING USER INPUT (only when something is waiting) Above the strip rather than below it, so "the strip is immediately above the input" stays true…
    this.rowMap.pendingStart = row;
    this.rowMap.pendingRows = g.pendingRows || 0;
    if (g.pendingRows > 0) {
      const plines = require('./pending').draw(this.statusState(), box.width, g.pendingRows);
      for (let i = 0; i < g.pendingRows; i++) buf.push(L(at(row++, col0) + views.clip(plines[i] || '', box.width)));
    }
    // WHAT IS RUNNING THAT YOU ARE NOT LOOKING AT
    this.rowMap.jobsStart = row;
    this.rowMap.jobRows = g.jobRows || 0;
    if (g.jobRows > 0) {
      const jlines = require('./jobsview').draw(this.statusState(), box.width, g.jobRows);
      for (let i = 0; i < g.jobRows; i++) buf.push(L(at(row++, col0) + views.clip(jlines[i] || '', box.width)));
    }
    this.rowMap.activityRows = g.activityRows || 0;   // the transient ACTIVITY box — ui/activitybox.js
    for (const l of require('./activitybox').draw(this.statusState(), box.width, g.activityRows || 0)) buf.push(L(at(row++, col0) + views.clip(l, box.width)));
    // INTERACTION PANEL (hidden / compact / expanded)

    // LLM STATUS (fixed, directly above the input) Moved DOWN from the task banner deliberately: what is happening this second belongs beside the caret…
    this.rowMap.statusStart = row;
    this.rowMap.statusRows = g.statusRows;
    if (g.statusRows > 0) {
      const strip = require('./status').statusStrip(this.statusState(), box.width, g.statusRows);
      for (let i = 0; i < g.statusRows; i++) buf.push(L(at(row++, col0) + views.clip(strip[i] || '', box.width)));
    }

    // INPUT (fixed, LAST, always on the floor)
    if (g.hintRows > 0) {
      buf.push(L(at(row++, col0) + views.clip(P.warn(this.exitHint), box.width)));
    }
    buf.push(...require('./inputbox').draw(this, { row, cols: box.width, textRows: g.textRows, col: col0 }));
    row += g.textRows;
    // THE FOOTER: live key hints, one restrained row (ui/footer.js). Zero rows with a panel open.
    if (g.footerRows > 0) buf.push(L(at(row++, col0) + views.clip(require('./footer').line(this, box.width, P), box.width)));

    // THE PANEL, DIRECTLY BELOW THE INPUT
    this.rowMap.panelStart = row;
    this.rowMap.panelRows = g.panelRows;
    if (g.panelRows > 0 && this.panel && this.panel.visible) {
      // AND THE PANEL IS INSIDE THE FRAME TOO
      this.rowMap.panelCol = col0;
      const plines = this.panel.render(box.width, g.panelRows);
      for (let i = 0; i < g.panelRows; i++) {
        buf.push(L(at(row++, col0) + views.clip(plines[i] || '', box.width)));
      }
    }

    // PARK THE CURSOR WHERE THE CARET ACTUALLY IS.
    const park = at(Math.max(1, this.cursorRow), Math.max(1, Math.min(cols, this.cursorCol))) + SHOW_CUR;

    // AN UNCHANGED FRAME IS NOT WRITTEN AGAIN
    const frame = require('./frameout').sanitize(redact.text(buf.join('')));
    if (frame === this._lastFrame) { this.out.write(park); return; }
    this._lastFrame = frame;
    this.out.write(HIDE_CUR + frame + park);
  }
}

module.exports = { Screen, MIN_ROWS, MIN_COLS };
