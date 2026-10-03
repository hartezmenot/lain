'use strict';

/** UI WIRING — the single place the App talks to the terminal UI. */

const { Screen } = require('./layout');
const views = require('./views');
const panelMod = require('./panel');
const termtitle = require('../termtitle');

/** Bound on the in-flight feed, matching what a turn record itself keeps. */
const MAX_LIVE = 200;
/** How much of an actor's own words one entry carries for the dashboard. */
const MAX_DETAIL_LINES = 200;

class UI {
  constructor(app) {
    this.app = app;
    this.panel = new panelMod.InteractionPanel();
    this.screen = new Screen({ out: app.render.out, panel: this.panel });
    /** THE STORY OF THE CURRENT TASK — what was said, by whom, and what was done. */
    this.story = new (require('./story').Story)();
    this.busy = false;
    this.enabled = false;
    this.running = null;      // the tool call in flight, for the ACTIVITY view
    this.startedAt = 0;       // when the current turn began, for elapsed time
    /** THE LIVE EXECUTION PHASE, straight from the turn loop — the single source of truth for "what is LAIN doing right now". */
    this.phase = null;
    this.phaseSince = 0;
    this.interrupting = false;
    /** ONE ELAPSED-WORK CLOCK FOR THE WHOLE FOREGROUND TASK — see ui/workclock.js. */
    this.clock = require('./workclock').create();
    this._tick = null;
    // THE ACTIVITY TIMELINE — see ui/activity.js
    this.activity = new (require('./activity').ActivitySurface)({ instant: true });
  }


  // The story's feeds, by their existing names, so no caller had to change.
  get liveActions() { return this.story.actions; }
  get liveNarration() { return this.story.narration; }
  get liveNotes() { return this.story.notes; }
  get liveThoughts() { return this.story.thoughts; }
  get liveUser() { return this.story.user; }
  get liveFrom() { return this.story.userFrom || null; }
  get liveTyped() { return Boolean(this.story.userTyped); }
  get outputs() { return this.story.outputs; }

  /** WHAT THE OTHER ACTORS SAID, read from the SESSION — see session.js. */
  get extras() { return this.app.session.actors || []; }

  setLiveUser(text, from = null, typed = false) { this.story.setUser(text, from, typed); this.refresh(); }
  noteAction(a) {
    // WHEN AN EDIT LANDED, for its diff's arrival in the feed (ui/turnsections.js). Presentation only: not enumerable, never saved.
    if (a && require('./turnsections').isChange(a) && !a.landedAt) Object.defineProperty(a, 'landedAt', { value: Date.now(), enumerable: false });
    this.story.noteAction(a);
    // The real numbers land here — the timeline’s counters have been climbing
    // towards them, and this is what they land ON.
    this.activity.end(a);
    this._syncTicker();
    this.refresh();
  }

  // AN EDIT ARRIVES IN THE FEED, WHERE IT STAYS (ui/turnsections.js) — it no longer opens a second, temporary window that closed itself.
  showDiff() { this._syncTicker(); this.refresh(); }

  showRead(file, text) { this.activity.showRead(file, text); this._syncTicker(); this.refresh(); }

  /** The real +/- for the edit that just finished, read from the checkpoint. */
  noteEditCounts(added, removed) {
    this.activity.counts(added, removed);
    // ONLY THE CARD. The durable counts come from the CHECKPOINT, onto the turn record, at the moment the call finishes — see describe.js `editSize`.…
    this._syncTicker();
  }
  /** PROSE THE MODEL PRODUCED, ON SCREEN AS SOON AS IT IS A COMPLETE THOUGHT. */
  noteNarration(text) { this.story.noteNarration(text); this._syncTicker(); this.refresh(); }
  noteThought(t) { this.story.noteThought(t); this.refresh(); }

  /** A liveness warning, a block, a notice — the program speaking, quietly. */
  noteSystem(text, level = 'info') { this.story.noteSystem(text, level); this.refresh(); }

  /** One line from an actor that is not LAIN's own turn — the external reviewer, or the desktop bridge. */
  /** WHY A SUMMARY AND A DETAIL, rather than one line per line. */
  noteActor(kind, text, { detail = null } = {}) {
    const t = String(text || '').trim();
    if (!t) return;
    const list = this.app.session.actors;
    if (!Array.isArray(list) || list.length >= MAX_LIVE) return;
    const e = { kind, text: t, afterTurns: (this.app.session.turns || []).length };
    if (Array.isArray(detail) && detail.length) e.detail = detail.slice(0, MAX_DETAIL_LINES);
    list.push(e);
    this.refresh();
  }

  noteOutput(command, output, exitCode) { this.story.noteOutput(command, output, exitCode); this.refresh(); }

  /** OUTPUT ARRIVING, COUNTED — the one number on the header. */
  noteOutputChars(n) {
    const chars = Math.max(0, Number(n) || 0);
    if (!chars) return;
    if (!this.liveOutput) this.liveOutput = { chars: 0, tokens: 0, measured: false };
    // A MEASURED FIGURE IS NEVER OVERWRITTEN BY AN ESTIMATE.
    if (this.liveOutput.measured) return;
    this.liveOutput.chars += chars;
    const { CHARS_PER_TOKEN } = require('../session');
    this.liveOutput.tokens = Math.round(this.liveOutput.chars / CHARS_PER_TOKEN);
  }

  /** A genuinely new task: the previous task's story is no longer the news. */
  // THE TURN'S STATE MACHINE lives in ui/turnstate.js
  clearExtras() { return require('./turnstate').clearExtras(this); }
  beginTurn(verdict = null) { return require('./turnstate').beginTurn(this, verdict); }
  endTurn() { return require('./turnstate').endTurn(this); }
  setRunning(name, target) { return require('./turnstate').setRunning(this, name, target); }
  setPhase(next) { return require('./turnstate').setPhase(this, next); }
  setInterrupting(on) { return require('./turnstate').setInterrupting(this, on); }
  setInterrupted(on) { return require('./turnstate').setInterrupted(this, on); }
  setFailed(on) { return require('./turnstate').setFailed(this, on); }

  /** THE REDRAW TICKER — the one timer in the program, and it fabricates nothing. */
  /** WAIT OUT A RATE LIMIT, VISIBLY, AND CARRY ON BY ITSELF. */
  waitForReset(resumeAt, o = {}) { return require('./waiting').waitForReset(this, resumeAt, o); }

  /** THE REDRAW CLOCK, and it has two speeds. */
  _syncTicker() { return require('./activity').syncTicker(this); }

  /** THE STATE THE STATUS STRIP DRAWS — collected in one place, derived nowhere else. */
  // WHAT THE SCREEN IS TOLD lives in ui/projection.js
  statusState() { return require('./projection').statusState(this); }
  snapshot() { return require('./projection').frameState(this); }
  lastSessionToken() { return require('./projection').lastSessionToken(this); }
  readiness(pc) { return require('./projection').readiness(this, pc); }
  changedCount() { return require('./projection').changedCount(this); }
  _title(s) { return require('./projection').title(this, s); }


  /** ESCAPE DURING A RETRY WAIT — stop waiting, keep everything else. */
  cancelRetry() { return require('./waiting').cancelRetry(this); }

  /** ESCAPE OUT OF A LONG RATE-LIMIT WAIT — `waitForReset`'s sibling to `cancelRetry` above, and the same mechanism: the abort signal `app.js`'s… */
  cancelWait() { return require('./waiting').cancelWait(this); }

  /** Enter the full-screen UI. */
  enable() {
    if (!this.screen.enter()) return false;
    this.enabled = true;
    this.app.render.attachScreen(this.screen);
    this.refresh();
    return true;
  }

  disable() {
    if (!this.enabled) return;
    // THE LAST FRAME IS THE SETTLED ACCOUNT.
    this.activity.drain();
    this.refresh();
    this.enabled = false;
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    termtitle.restore();
    this.screen.leave();
  }

  refresh() {
    if (!this.enabled) return;
    // THE WORK CLOCK, BEFORE ANYTHING READS IT
    require('./projection').clock(this);
    const s = this.snapshot();
    this._title(s);
    this.screen.status = views.statusOf({
      lifecycle: s.lifecycle,
      busy: this.busy,
      // ANY modal panel is LAIN waiting on a person, not LAIN working — it was matched on the ask_user title alone, so browsing models or config reported…
      awaitingUser: this.panel.visible && !this.panel.isCompletion && !this.panel.isPassive && !this.panel.isInspector && this.panel.kind !== 'SHELF',
      providerStatus: s.providerStatus,
      // The live phase is the most specific true thing available, so it decides the header word: THINKING and RUNNING are both "working", and telling them…
      phase: this.phase,
      interrupting: this.interrupting,
      interrupted: this.interrupted,
      failed: this.failed,
      // Plan at 100% with the task still open — see App.maybeComplete.
      pendingCompletion: this.app.pendingCompletion || null,
    });
    this.screen.draw(s);
  }

  setBusy(on) { this.busy = Boolean(on); this.refresh(); }
  /** The input row's content AND where the caret is in it. */
  setInput(text, cursor = null) {
    const s = String(text || '');
    this.screen.inputText = s;
    this.screen.inputCursorAt = cursor == null ? s.length : Math.max(0, Math.min(s.length, cursor));
    const upto = s.slice(0, this.screen.inputCursorAt);
    this.screen.inputCursorLine = upto.split('\n').length - 1;
    // THE SELECTION TRAVELS WITH THE TEXT. The reader owns it; the screen only
    // draws it, and reading it here means there is one place it is copied.
    const reader = this.app.input;
    this.screen.inputSelection = reader && typeof reader.range === 'function' ? reader.range() : null;
    // WHAT ARRIVED AS A PASTE, for the composer's DRAWING only — the reader owns the record, the screen only projects it, and `s` above is the whole of…
    this.screen.inputPastes = (reader && Array.isArray(reader.pastesInLine)) ? reader.pastesInLine : [];
    this.refresh();
  }

  /** The transient "press Ctrl+C again to exit" hint, drawn on the input frame. */
  setExitHint(text) {
    const t = String(text || '');
    if (this.screen.exitHint === t) return;
    this.screen.exitHint = t;
    this.refresh();
  }

  /** Record command output for the OUTPUT view. Bounded — never unbounded growth. */

  showCompletion(verification = []) { return require('./completionview').show(this, verification); }

  /** Redraw the report with the CURRENT cursor — Up/Down never re-derive it. */
  _renderCompletion() { return require('./completionview').render(this); }

  dismissCompletion() { return require('./completionview').dismiss(this); }

  /** Open the interaction panel with an adapter and await the user's answer. */
  async ask(adapter) {
    if (!this.enabled) return null;      // non-TTY callers print text instead
    const p = this.panel.open(adapter);
    this.refresh();
    const value = await p;
    this.refresh();
    return value;
  }

  /** What the panel is currently for — IDLE when nothing is open. */
  get mode() { return this.panel.kind; }

  /** The `ask_user` back end. */
  async askUser({ question, options = [], input = null }) {
    if (!this.enabled) return null;            // non-interactive: the tool says so
    // END OF INPUT IS A STATE, NOT AN EVENT
    if (this.app && this.app.inputClosed) return null;
    const A = require('./answer');
    // "Other…" BELONGS ONLY TO A LIST OF CHOICES.
    const kind = A.kindOf(input, options);
    const choices = kind === A.KIND.CHOICE && options.length ? [...options, A.OTHER] : options;
    // A COMPANION HAS TO KNOW A QUESTION IS OPEN.
    const { EVENT, busOf } = require('../events');
    busOf(this.app).emit(EVENT.QUESTION_PRESENTED, { question, kind, options: choices });
    const answer = await this.ask(panelMod.askAdapter({ question, options: choices, input }));
    busOf(this.app).emit(EVENT.QUESTION_RESOLVED, {
      question,
      kind,
      answer: answer == null ? '' : String(answer),
      dismissed: answer == null,
    });
    return answer;
  }

  /** ENTER WITH TEXT ON THE LINE, WHILE A QUESTION IS OPEN. */
  submitTypedAnswer() {
    if (!this.enabled || !this.panel.visible || !this.panel.acceptsTyped) return false;
    const input = this.app.input;
    const text = input ? String(input.line || '') : '';
    if (!text.trim()) return false;            // an empty line means the highlighted row
    const commands = require('../commands');
    if (commands.looksLikeCommand(text)) {
      if (input) { input.remember(text); input.setLine(''); }
      this.setInput('');
      this.refresh();
      Promise.resolve(commands.run(this.app, text)).catch((e) => {
        this.app.render.notice('error', `${text}: ${e && e.message}`);
      });
      return true;
    }
    // A SECRET IS NOT REMEMBERED.
    const secret = Boolean(this.panel.frame && this.panel.frame.secret);
    if (!this.panel.submitTyped(text)) return false;
    if (input) { if (!secret) input.remember(text); input.setLine(''); }
    this.setInput('');
    this.refresh();
    return true;
  }

  /** Install (or clear) the model browser's live filter. */
  setModelFilter(fn) { this._modelFilter = typeof fn === 'function' ? fn : null; }

  // as-you-type menus

  static atToken(text) { return require('./menus').atToken(text); }
  updateMenus(text, meta) { return require('./menus').updateMenus(this, text, meta); }
  completionKey(key) { return require('./menus').completionKey(this, key); }
  showMenu(adapter) { return require('./menus').showMenu(this, adapter); }
  closeMenu() { return require('./menus').closeMenu(this); }

  /** Enter on an empty input line, with the workspace showing a list. */
  async workspaceSelect() {
    // ENTER ON AN EMPTY LINE USED TO OPEN WHAT THE PANE OFFERED — a file picker on DIFF and FILES, a step picker on PLAN.
    return false;
  }

  /** A SINGLE LETTER TYPED WHILE THE COMPLETION OVERLAY IS UP. */
  completionShortcut(text) {
    if (!this.enabled || !this.screen.completion) return false;
    const k = String(text || '');
    if (k.length !== 1) return false;
    return this.handleKey(k.toLowerCase());
  }

  /** The same problem, one layer down: a letter an OPEN PANEL advertises. */
  panelShortcut(text) {
    if (!this.enabled || !this.panel.visible) return false;
    const k = String(text || '');
    if (k.length !== 1) return false;
    // AN ADVISORY NEVER TAKES A LETTER OUT OF A SENTENCE
    if (this.panel.isAdvisory) {
      const line = this.app.input ? String(this.app.input.line || '') : '';
      if (line.length) return false;
    }
    if (!this.panel.shortcut(k)) return false;
    this.refresh();
    return true;
  }

  // `nextView` AND `ensureReport` STOOD HERE.

  /** WHICH KEY DOES WHAT lives in ui/keys.js — the routing of a keystroke is a different job from owning the panel, the screen and the redraw, and keeping… */
  handleKey(key) { return require('./keys').handleKey(this, key); }

  /** WHERE A CLICK LANDED lives in ui/mouse.js, for the same reason keys live in ui/keys.js: it is hit-testing against what was DRAWN, not state this… */
  handleMouse(ev) { return require('./mouse').handleMouse(this, ev); }

}

module.exports = { UI, views, panel: panelMod };
