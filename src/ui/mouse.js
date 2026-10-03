'use strict';

/** THE MOUSE — where a click landed, and what that means. */

// `tabAt` STOOD HERE — column arithmetic that inverted the tab strip's labels back into a pane name, so a click on `3 diff` landed on the same pane…

/** A click on the INPUT row becomes a caret position. */
function caretAt(screen, x, y = null) {
  const m = screen.rowMap || {};
  // WAS COLUMN-ONLY, and assumed the click landed on the line the caret was already on.
  const rows = Array.isArray(m.inputLines) ? m.inputLines : [];
  const hit = (y !== null && rows.find((r) => r.row === y))
    || rows.find((r) => r.row === m.inputRow)
    || null;
  if (!hit) {
    // Nothing drawn yet, or a row the map does not know.
    return String(screen.inputText || '').length;
  }
  const offset = Math.max(0, x - (m.inputTextCol || 5));
  const within = Math.max(0, Math.min(hit.length, hit.start + offset));
  return hit.begins + within;
}

/** The user message drawn on screen row `y`, or null. */
function recallAt(screen, y) {
  const lines = screen.lastFeedLines;
  if (!lines || !lines.userAt) return null;
  const at = require('./textselect').lineForRow(screen.rowMap, screen.rowMap.feedScroll || 0, y);
  return at == null ? null : (lines.userAt[at] || null);
}

/** THE FILE A FEED ROW NAMES, or null. */
/** The [Diff] control on row `y` — only when the click lands ON the control. */
function diffAt(screen, y, x = null) {
  const lines = screen.lastFeedLines;
  if (!lines || !lines.diffAt) return null;
  const at = require('./textselect').lineForRow(screen.rowMap, screen.rowMap.feedScroll || 0, y);
  const d = at == null ? null : lines.diffAt[at];
  if (!d) return null;
  if (x != null && d.col != null && d.col >= 0) {
    const within = x - (screen.rowMap.contentCol || 1);
    if (within < d.col - 1) return null;
  }
  // `full` marks the `[Show all]` row of a bounded diff — ui/difftoggle.js.
  return { turn: d.turn, path: d.path, ...(d.full ? { full: true } : {}), ...(d.shown != null ? { shown: d.shown } : {}) };
}

function fileAt(screen, y) {
  const lines = screen.lastFeedLines;
  if (!lines || !lines.fileAt) return null;
  const at = require('./textselect').lineForRow(screen.rowMap, screen.rowMap.feedScroll || 0, y);
  return at == null ? null : (lines.fileAt[at] || null);
}

/** OPEN WHAT WAS CLICKED. */
const MAX_PEEK_BYTES = 400_000;

function openFile(ui, rel) {
  const panel = ui.screen && ui.screen.panel;
  if (!rel || !ui.app || !panel) return false;
  // A QUESTION WITH A CALLER BEHIND IT IS NEVER COVERED by a file somebody clicked.
  if (panel.visible && !panel.isPassive) return false;
  const path = require('path');
  const fs = require('fs');
  const base = (ui.app.session && ui.app.session.cwd) || ui.app.cwd || process.cwd();
  // `src/foo.ts:84` OPENS AT LINE 84 (§17) — the same temporary view.
  const ref = /^(.*?):(\d{1,6})$/.exec(String(rel));
  const line = ref ? Number(ref[2]) : 0;
  if (ref) rel = ref[1];
  const abs = path.isAbsolute(rel) ? rel : path.resolve(base, rel);
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return false;
    const text = st.size > MAX_PEEK_BYTES
      ? fs.readFileSync(abs, 'utf8').slice(0, MAX_PEEK_BYTES)
      : fs.readFileSync(abs, 'utf8');
    const adapter = require('./adapters').outputAdapter({ title: rel, lines: [] });
    // THE FILE AS IT IS: its own case in the title, and its blank lines kept.
    adapter.title = rel;
    adapter.keepCase = true;
    const rows = text.replace(/\r\n/g, '\n').split('\n');
    // Numbered when opened at a line, so the referenced row is findable at a glance.
    adapter.items = rows.map((l, i) => ({ label: (line ? `${String(i + 1).padStart(5)}${i + 1 === line ? ' ▶ ' : '   '}` : '') + (l.replace(/\s+$/, '') || ' '), selectable: false }));
    if (line) adapter.title = `${rel}:${line}`;
    panel.open(adapter);
    if (line) panel.scroll = Math.max(0, Math.min(rows.length - 1, line - 4));
    return true;
  } catch {
    return false;
  }
}

/** Act on one decoded mouse event. */
function handleMouse(ui, ev) {
  if (!ui.enabled || !ev) return false;
  const screen = ui.screen;
  const m = screen.rowMap;
  if (!m) return false;                       // nothing drawn yet
  const { kind, x, y } = ev;

  // THE INPUT BOX IS THREE ROWS, not one.
  const overInput = (map, row) => Number.isFinite(map.inputRow)
    && row >= map.inputRow - 1 && row <= map.inputRow + 1;

  // WHEEL
  if (kind === 'wheel-up' || kind === 'wheel-down') {
    const delta = kind === 'wheel-up' ? -3 : 3;
    if (ui.panel.visible && m.panelRows > 0 && y >= m.panelStart) {
      ui.panel.scrollBy(delta, Math.max(1, m.panelRows - 6));
      ui.refresh();
      return true;
    }
    const reader = ui.app && ui.app.input;
    if (overInput(m, y) && reader && typeof reader.recallPrev === 'function') {
      if (kind === 'wheel-up') reader.recallPrev();
      else reader.recallNext();
      ui.refresh();
      return true;
    }
    screen.scrollWorkspace(delta);
    return true;
  }

  // DRAGGING INSIDE THE INPUT BOX SELECTS TEXT —
  if (kind === 'drag' || kind === 'release') {
    // A DRAG THAT STARTED IN THE FEED BELONGS TO THE FEED
    if (screen.textSelection && screen.textSelection.anchor !== null && ui._selectingFeed) {
      if (kind === 'drag') {
        screen.selectTo(x, y);
        // PACED AND LOCAL (ui/selectframe.js): the first motion of a burst draws now, the rest fold into one frame per
        // 16 ms — never a full Core projection per mouse sample.
        if (ui.screen && typeof ui.screen.draw === 'function' && ui.enabled) require('./selectframe').requestLocalFrame(ui); else ui.refresh();
        return true;
      }
      // RELEASE COPIES. One gesture — highlight, let go, it is on the clipboard — because the alternative is a selection that looks copied and is not, and…
      ui._selectingFeed = false;
      const text = screen.selectedText();
      // A CLICK, NOT A DRAG: nothing was selected, and the press landed on a
      // message. Put it back on the input line. See `recallAt`.
      if (!text && ui._recallSaid && ui.app && ui.app.input
        && typeof ui.app.input.setLine === 'function') {
        ui.app.input.setLine(ui._recallSaid);
        ui._recallSaid = null;
        if (screen.clearSelection) screen.clearSelection();
        ui.refresh();
        return true;
      }
      // A ROW THAT NAMES A FILE OPENS IT
      if (!text && ui._toggleDiff) {
        require('./difftoggle').toggle(screen, ui._toggleDiff);
        ui._toggleDiff = null; ui._openFile = null; ui._recallSaid = null;
        if (screen.clearSelection) screen.clearSelection();
        ui.refresh();
        return true;
      }
      ui._toggleDiff = null;
      if (!text && ui._openFile) {
        const opened = openFile(ui, ui._openFile);
        ui._openFile = null;
        ui._recallSaid = null;
        if (opened) {
          if (screen.clearSelection) screen.clearSelection();
          ui.refresh();
          return true;
        }
      }
      ui._openFile = null;
      ui._recallSaid = null;
      if (text) {
        let ok = false;
        try { ok = require('../copy').toClipboard(text); } catch { ok = false; }
        const lines = text.split('\n').length;
        // AN OPERATION, NOT A MESSAGE
        require('./operation').note(ui, ok
          ? `Copied ${lines} line(s) · ${text.length} characters`
          : 'Could not reach the clipboard — the text is still selected',
        { level: ok ? 'info' : 'warn' });
      }
      ui.refresh();
      return true;
    }
    const reader = ui.app && ui.app.input;
    if (!reader || typeof reader.selectTo !== 'function') return true;
    const rows = Array.isArray(m.inputLines) ? m.inputLines : [];
    if (!rows.length || reader.selAnchor === null) return true;
    if (kind === 'drag') {
      // CLAMPED TO THE BOX. Dragging up out of it should extend to the start of the prompt rather than doing nothing, which is what an editor does when you…
      const above = y < rows[0].row;
      const below = y > rows[rows.length - 1].row;
      const at = above ? 0
        : below ? String(screen.inputText || '').length
          : caretAt(screen, x, y);
      reader.selectTo(at);
      reader.cursor = at;
      ui.refresh();
    }
    return true;
  }

  if (kind !== 'press') return false;

  // THE SCROLL ANCHOR ON THE HEADER'S RULE
  if (m.anchorRow && y === m.anchorRow && m.anchorTarget >= 0) {
    if (screen.jumpToRow(m.anchorTarget)) return true;
  }

  // AN OPEN PANEL OWNS ITS OWN ROWS
  if (ui.panel.visible && m.panelRows > 0 && y >= m.panelStart) {
    const bodyTop = m.panelStart + 3;                 // border, title, separator
    const idx = screen.panel.scroll + (y - bodyTop);
    const item = screen.panel.items[idx];
    // A FRAME MAY OWN ITS CLICKS — a shelf's action buttons (ui/shelf.js). The
    // column is measured from the row text, past the panel indent and marker.
    const frame = screen.panel.frame;
    if (frame && typeof frame.onClick === 'function') {
      frame.onClick(item, x - (m.panelCol || 1) - 4, { panel: screen.panel, index: idx });
      ui.refresh();
      return true;
    }
    if (item && item.selectable !== false) {
      screen.panel.cursor = idx;
      ui.refresh();
      return true;
    }
    return true;                                       // inside the panel: swallow
  }
  // A click OUTSIDE an open modal does nothing at all. Dismissing on an
  // outside click would cancel a question the user may simply have clicked past.
  if (ui.panel.visible && !ui.panel.isCompletion) return true;

  // THE INPUT ROWS
  const onText = Array.isArray(m.inputLines) && m.inputLines.some((r) => r.row === y);
  if (onText || y === m.inputRow) {
    const app = ui.app;
    if (!app.input) return true;
    const at = caretAt(screen, x, y);
    app.input.cursor = at;
    // THE ANCHOR FOR A DRAG THAT MAY FOLLOW.
    if (typeof app.input.selectFrom === 'function') app.input.selectFrom(at);
    // Through the reader's own event, so the screen updates by the one path
    // every other edit uses.
    app.input.emit('edit', app.input.line);
    return true;
  }

  // CLICKING WHAT YOU SAID PUTS IT BACK ON THE INPUT LINE
  ui._recallSaid = recallAt(screen, y);
  // ARMED THE SAME WAY, for the same reason: a press that turns into a drag
  // is a selection, not a click, and must not open anything.
  ui._openFile = fileAt(screen, y);
  ui._toggleDiff = diffAt(screen, y, x);

  // A PRESS IN THE FEED BEGINS A TEXT SELECTION
  if (screen.selectFrom && screen.selectFrom(x, y)) {
    ui._selectingFeed = true;
    ui.refresh();
    return true;
  }

  // Everywhere else — the header, the status strip — a click is not an action.
  if (screen.clearSelection && screen.clearSelection()) ui.refresh();
  return true;
}

module.exports = { handleMouse, caretAt };
