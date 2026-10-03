'use strict';

/** WHICH KEY DOES WHAT — the keyboard, in one place. */

function handleKey(ui, key) {
  return ROUTE.call(ui, key);
}

/** Bound to the UI so the body reads exactly as it did as a method. */
function ROUTE(key) {
  if (!this.enabled) return false;
  const g = this.screen.geometry();

  // ESCAPE CLOSES AN OPEN GOAL/PLAN COMPOSER
  if (key === 'escape' && require('../composemode').pending(this.app)) {
    require('../composemode').cancel(this.app);
    require('./operation').note(this, 'Cancelled');
    this.refresh();
    return true;
  }

  // ESCAPE OUT OF A RETRY WAIT OUTRANKS EVERY PANEL
  if (key === 'escape' && this.phase && this.phase.phase === 'RETRYING'
      && (!this.panel.visible || this.panel.isPassive)) {
    if (this.panel.visible) this.panel.close(null);
    return this.cancelRetry();
  }

  // ESCAPE OUT OF A LONG RATE-LIMIT WAIT, THE SAME WAY
  if (key === 'escape' && this.waitingUntil && (!this.panel.visible || this.panel.isPassive)) {
    if (this.panel.visible) this.panel.close(null);
    return this.cancelWait();
  }

  // ESCAPE TAKES BACK A STEER YOU HAVE NOT SENT YET
  if (key === 'escape' && !this.panel.visible && this.app.steerQueue && this.app.steerQueue.length) {
    const text = this.app.takeBackSteer();
    if (text != null) {
      // Onto the line THROUGH THE READER, so it arrives as an ordinary edit with a caret at the end — the same path a paste takes.
      if (this.app.input) this.app.input.setLine(text);
      else this.setInput(text);
      this.refresh();
      return true;
    }
  }

  // CTRL+PGDN: THE NEWEST OUTPUT, FROM ANYWHERE
  if (key === 'ctrl-pagedown') {
    this.screen.stickToBottom = true;
    this.refresh();
    return true;
  }

  // AN ADVISORY IS NOT A PANEL YOU ARE IN
  if (this.panel.visible && this.panel.isAdvisory) {
    if (key === 'escape') {
      this.panel.close(null);
      this.refresh();
      return true;
    }
    const lineEmpty = !(this.app.input && String(this.app.input.line || '').length);
    if (lineEmpty && (key === 'up' || key === 'down')) {
      this.panel.move(key === 'up' ? -1 : 1, 10);
      this.refresh();
      return true;
    }
    if (lineEmpty && key === 'enter') {
      this.panel.select({ key: 'enter' });
      this.refresh();
      return true;
    }
    return false;
  }

  if (this.panel.visible) {
    const rows = Math.max(1, g.panelRows - 6);
    // AN INSPECTOR NAVIGATES ITSELF — ←/→ between files, Enter into one.
    if (this.panel.frame && typeof this.panel.frame.onKey === 'function'
        && this.panel.frame.onKey(key, { panel: this.panel, rows })) {
      this.refresh();
      return true;
    }
    switch (key) {
      // A SELECTION MOVE IS RENDERER STATE (ui/selectframe.js): the row moves now, from the last projection — no Core
      // re-projection between two arrow presses.
      case 'up': this.panel.move(-1, rows); require('./selectframe').paintLocal(this); return true;
      case 'down': this.panel.move(1, rows); require('./selectframe').paintLocal(this); return true;
      case 'pageup': this.panel.scrollBy(-rows, rows); this.refresh(); return true;
      case 'pagedown': this.panel.scrollBy(rows, rows); this.refresh(); return true;
      // ENTER PREFERS WHAT YOU TYPED.
      case 'enter':
        if (this.submitTypedAnswer()) return true;
        this.panel.select({ key: 'enter' }); this.refresh(); return true;
      // → is "go deeper" in a drill-down: on the model list it opens the routes for a model Enter would have committed outright.
      case 'right': if (this.panel.isCompletion) return false; this.panel.select({ key: 'right' }); this.refresh(); return true;
      // ← is "back" in a drill-down, but in a completion menu it is just a cursor key.
      case 'left':
        if (this.panel.isCompletion) return false;
        if (this.panel.stack.length > 1) this.panel.back();
        else this.panel.close(null);
        this.refresh();
        return true;
      // ESCAPE ASKS THE FRAME FIRST.
      case 'escape':
        if (!this.panel.escape()) this.panel.close(null);
        this.refresh();
        return true;
      // A MODAL PANEL OWNS TAB.
      case 'tab': case 'shift-tab':
        if (this.panel.isCompletion) return false;
        this.refresh();
        return true;
      default: return false;
    }
  }

  if (this.screen.completion) {
    // THE TASK-COMPLETE OVERLAY IS A REPORT, NOT A PLACE.
    if (key === 'escape' || key === 'enter') { this.dismissCompletion(); return true; }
    this.dismissCompletion();
    return false;
  }

  // ESCAPE STOPS A RETRY WAIT, before Escape means anything else.
  if (key === 'escape' && this.phase && this.phase.phase === 'RETRYING') return this.cancelRetry();

  switch (key) {
    case 'pageup': this.screen.scrollWorkspace(-(g.workspace - 2)); return true;
    case 'pagedown': this.screen.scrollWorkspace(g.workspace - 2); return true;
    // ALT+↑ / ALT+↓ — the previous or next thing the USER said.
    case 'escape':
      if (!this.panel.visible && this.screen.openDiff) {
        require('./difftoggle').close(this.screen);
        this.refresh();
        return true;
      }
      return false;
    case 'ctrl-o':
      this.activityExpanded = !this.activityExpanded;
      this.refresh();
      return true;
    case 'shift-tab': {
      const m = require('../execmode').cycle(this.app.session);
      try { this.app.session.save(); } catch { /* the mode still applies in memory */ }
      require('./operation').say(this.app, `${require('../execmode').WORD[m]} mode`, 'info');
      this.refresh();
      return true;
    }
    case 'alt-up': return this.screen.jumpToAnchor(-1);
    case 'alt-down': return this.screen.jumpToAnchor(1);
    // HOME/END BELONG TO WHATEVER YOU ARE EDITING.
    case 'home':
      if (this.screen.inputText) return false;
      this.screen.workspaceScroll = 0; this.screen.stickToBottom = false; this.refresh(); return true;
    case 'end':
      if (this.screen.inputText) return false;
      this.screen.stickToBottom = true; this.refresh(); return true;
    // ALT+1..9 AND CTRL+1..9 ARE NO LONGER BOUND
    default: return false;
  }
}

module.exports = { handleKey };
