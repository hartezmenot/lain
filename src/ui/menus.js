'use strict';

/** THE AS-YOU-TYPE MENUS — `/` for commands, `@` for files. */

const panelMod = require('./panel');

/** The `@token` being typed at the end of the line, or null. */
function atToken(text) {
  const m = /(?:^|\s)@([^\s]*)$/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** Re-evaluate the menus for the line as it now stands. */
function updateMenus(ui, text, { pasted = false } = {}) {
  if (!ui.enabled) return;
  // A MENU IS AN OFFER MADE TO SOMEONE WHO IS TYPING.
  if (pasted) return;
  if (String(text || '').includes('\n')) { closeMenu(ui); return; }
  // THE MODEL BROWSER FILTERS AS YOU TYPE.
  if (ui.panel.visible && ui.panel.kind === panelMod.KIND.MODEL_SELECTION) {
    if (ui._modelFilter) ui._modelFilter(String(text || ''));
    return;
  }
  if (ui.panel.visible && !ui.panel.isCompletion) return;   // other modals win
  const line = String(text || '');
  const commands = require('../commands');

  // `/` at the START of the line only. A slash mid-sentence is prose; a pasted
  // one was refused above.
  if (/^\/\S*$/.test(line)) {
    showMenu(ui, panelMod.commandPaletteAdapter({
      // `offered()` rather than the raw registry: a compatibility alias still
      // runs when typed and is never proposed. See commands.js `define`.
      commands: commands.offered(),
      filter: line,
    }));
    return;
  }

  const at = atToken(line);
  if (at !== null) {
    const entries = require('../project').completePath(ui.app.session.cwd, at);
    showMenu(ui, panelMod.fileCompletionAdapter({ entries, filter: at }));
    return;
  }

  closeMenu(ui);
}

/** Keys that belong to an open completion menu. */
function completionKey(ui, key) {
  if (!ui.enabled || !ui.panel.isCompletion) return false;
  if (key !== 'tab' && key !== 'right' && key !== 'enter') return false;
  const app = ui.app;
  const item = ui.panel.current;
  // ENTER WITH NOTHING HIGHLIGHTED MUST STILL SUBMIT THE LINE
  if (!item) {
    if (key !== 'enter') return true;
    closeMenu(ui);
    app.input.submitLine();
    return true;
  }

  if (ui.panel.kind === panelMod.KIND.COMMAND_PALETTE) {
    closeMenu(ui);
    app.input.setLine(item.command + ' ');
    if (key === 'enter') {
      // WHILE A TURN IS RUNNING, run it now instead of queueing.
      const commands = require('../commands');
      const turnActive = Boolean(app.abort && !app.abort.signal.aborted);
      if (!turnActive) { app.input.submitLine(); return true; }
      app.input.setLine('');
      ui.setInput('');
      const line = item.command;
      Promise.resolve(commands.run(app, line)).catch((e) => {
        app.render.notice('error', `${line}: ${e && e.message}`);
      });
    }
    return true;
  }

  // FILE_COMPLETION: splice the chosen path over the `@token` being typed.
  const next = app.input.line.replace(/@[^\s]*$/, '@' + item.value);
  app.input.setLine(next);
  // A directory re-lists one level deeper so a path is walked segment by
  // segment; a file is the end of the road and the menu gets out of the way.
  if (item.entry && item.entry.isDir) updateMenus(ui, next);
  else closeMenu(ui);
  return true;
}

/** Open or update the transient completion menu. */
function showMenu(ui, adapter) {
  if (!ui.enabled) return;
  if (ui.panel.visible && ui.panel.isCompletion) ui.panel.replace(adapter);
  else if (!ui.panel.visible) ui.panel.open(adapter);
  else return;                       // a modal panel is open; leave it alone
  ui.refresh();
}

/** Close the completion menu, if that is what is open. Never closes a modal. */
function closeMenu(ui) {
  if (!ui.panel.visible || !ui.panel.isCompletion) return false;
  ui.panel.close(null);
  ui.refresh();
  return true;
}

module.exports = { atToken, updateMenus, completionKey, showMenu, closeMenu };
