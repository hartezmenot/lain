'use strict';

/** THE ACTIVITY SURFACE — the timeline, the diff window, and the clock they need. */

/** Redraw cadence while the timeline is animating. */
const FRAME_MS = 12;

/** The most presentation time a patch card may be held open for its own window. */
const MAX_LINGER_MS = 7000;

/** The ordinary settle an event gets anyway — see `_attach` for why it is here. */
const { SETTLE_MS } = require('./playback');

/** PAST THIS MUCH PRESENTATION DEBT, AN OPERATION GETS ITS CARD AND NO WINDOW. */
const MAX_WINDOW_DEBT_MS = 12000;

class ActivitySurface {
  /** instant play everything at once — a pipe, a test, animation off. */
  constructor({ instant = false, now = () => Date.now() } = {}) {
    const { Playback } = require('./playback');
    this.instant = Boolean(instant);
    this._now = now;
    // ONE PLAYHEAD, and it is this one.
    this.playback = new Playback({ instant: this.instant, now });
    /** Set by `drain` — the screen is going away, so nothing may still be moving. */
    this.drained = false;
  }

  /** A tool STARTED. Enqueued, never awaited. */
  begin(name, target) {
    if (!name) return null;
    return this.playback.enqueue({ name, target });
  }

  /** A tool FINISHED. The real numbers land here — the counters have been climbing towards them, and this is what they land ON. */
  end(action) {
    const a = action || {};
    return this.playback.complete({
      ok: a.ok !== false,
      note: a.note || '',
      name: a.name || '',
      added: Number(a.added) || 0,
      removed: Number(a.removed) || 0,
    });
  }

  /** THE REAL LINE COUNTS FOR THE EDIT THAT JUST FINISHED. */
  counts(added, removed) {
    // THE MOST RECENTLY FINISHED EVENT — the one whose result these numbers were read for.
    const done = this.playback.events.filter((x) => x.done);
    const e = done[done.length - 1] || this.playback.events[this.playback.events.length - 1];
    if (!e) return null;
    e.added = Number(added) || 0;
    e.removed = Number(removed) || 0;
    e.isEdit = e.isEdit || Boolean(e.added || e.removed);
    return e;
  }

  /** NOTHING IS RUNNING ANY MORE — release anything still held open. */
  settle() {
    let n = 0;
    for (const e of this.playback.events) {
      if (e.done) continue;
      e.done = true;
      e.tookMs = Math.max(0, this._now() - e.at);
      // WHEN IT FINISHED, which is what ends the ACTIVE phase — see ui/playback.js `_hold`.
      e.doneAt = this._now();
      n += 1;
    }
    return n;
  }

  /** FINISH PLAYING, NOW — the screen is going away. */
  drain() {
    this.settle();
    this.playback.cursor = this.playback.events.length;
    // ---- AND THE PROSE, WHICH IS ALSO STILL MOVING ----------------------
    //
    // A paragraph resolves from the moment it was said and keeps resolving
    // across the end of its turn (ui/conversation.js). At teardown there is no
    // next frame to finish it in, so the LAST thing on screen was a line of
    // unsettled glyphs — `░|=*#! +@▓` where the answer should be. A presentation
    // that eats the answer on the way out is worse than no presentation.
    //
    // Set here rather than by clearing a stamp, because the stamps belong to the
    // session and are written to disk: a resumed session must come back with its
    // prose settled and its record intact, and those are the same records.
    this.drained = true;
  }

  /** An edit landed: perform its change once, as a temporary window. */
  showDiff(file, before, after) {
    try {
      return this._attach(file, require('./diffreel').build(file, before, after));
    } catch { return false; }
  }

  /** A READ: look through the file, on the same surface, without editing it. */
  showRead(file, text) {
    try {
      return this._attach(file, require('./diffreel').buildRead(file, text));
    } catch { return false; }
  }

  /** GIVE THE WINDOW TO THE EVENT THAT PRODUCED IT — one operation, one identity. */
  _attach(file, item) {
    if (!item) return false;
    // ALREADY TOO FAR BEHIND TO PERFORM ANOTHER ONE
    if (this.playback.debtMs() > MAX_WINDOW_DEBT_MS) return false;
    const want = String(file || '');
    const events = this.playback.events;
    const reserve = Math.min(MAX_LINGER_MS,
      Math.max(0, require('./diffreel').planDuration(item) - SETTLE_MS));
    let fallback = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (String(e.target || '') !== want) continue;
      if (i < this.playback.cursor) { fallback = fallback || e; continue; }
      e.window = item;
      // The plan length, so ui/playback.js can ask "is the window still
      // performing?" without reaching for the renderer to find out.
      e.windowTotal = require('./diffreel').planDuration(item);
      e.linger = Math.max(e.linger || 0, reserve);
      return true;
    }
    // EVERY MATCHING EVENT HAS ALREADY BEEN PLAYED.
    return Boolean(fallback) && false;
  }

  /** A new task: an empty timeline and no window. */
  reset() {
    this.playback.reset();
    this.drained = false;
  }

  /** ONE PARAGRAPH, AS IT STANDS THIS INSTANT — see ui/reveal.js. */
  reveal(text, at, now = this._now()) {
    if (this.instant || this.drained || !at) return String(text == null ? '' : text);
    try { return require('./reveal').resolve(text, at, now); } catch { return String(text == null ? '' : text); }
  }

  /** Is any prose still resolving? The redraw clock asks this. */
  revealing(entries, now = this._now()) {
    if (this.instant || this.drained) return false;
    try { return require('./reveal').pending(entries, now); } catch { return false; }
  }

  /** Is anything still playing? The redraw clock asks this. */
  busy(now = this._now()) {
    if (this.instant) return false;
    // THE WINDOW IS INSIDE THE EVENT'S SPAN, so one question covers both. It
    // used to need two, which is the same duplication that let them disagree.
    return this.playback.busy(now);
  }

  /** THE WINDOW BELONGING TO THE OPERATION ON SCREEN, at this instant. */
  _window(state) {
    const a = state && state.active;
    if (!a || !a.window) return null;
    // NOT UNTIL ITS SUBJECT HAS ARRIVED
    const { PHASE } = require('./playback');
    if (a.phase === PHASE.ENTER) return null;
    return require('./diffreel').frame(a.window, a.windowMs);
  }

  /** THE ROWS, at this instant — quiet history, the live operation, and the diff window under it when one is open. */
  rows(width = 80, now = this._now()) {
    const timeline = require('./timeline');
    const state = this.playback.at(now);
    const win = this._window(state);
    track(state, win);
    const out = timeline.rows(state, width);
    const reel = win ? timeline.diffRows(win, width) : [];
    if (reel.length) {
      if (out.length) out.push('');
      for (const r of reel) out.push(r);
    }
    return out;
  }

  /** JUST THE LIVE POSITION — the active card and the diff window under it. */
  liveRows(width = 80, now = this._now()) {
    const timeline = require('./timeline');
    const state = this.playback.at(now);
    const win = this._window(state);
    track(state, win);
    const out = timeline.rows({ active: state.active, history: [] }, width);
    const reel = win ? timeline.diffRows(win, width) : [];
    if (reel.length) {
      if (out.length) out.push('');
      for (const r of reel) out.push(r);
    }
    return out;
  }
}

/** THE PATCH CARD'S COUNTERS FOLLOW THE DIFF WINDOW, not a phase timer. */
function track(state, reel) {
  const a = state && state.active;
  if (!a || !a.isEdit || !reel || !reel.open) return state;
  if (!reel.finalAdded && !reel.finalRemoved) return state;
  // NO FILE CHECK, AND THERE CANNOT BE ONE TO MAKE.
  a.added = reel.added;
  a.removed = reel.removed;
  a.dir = reel.stage === 'WRITE' ? 'add' : reel.stage === 'STRIKE' ? 'remove' : null;
  return state;
}

/** Redraw cadence while only a spinner or an elapsed count is changing. */
const TICK_MS = 250;

/** THE REDRAW CLOCK, and it has two speeds. */
/** The prose of the most recent recorded turn, which may still be resolving. */
function lastNarrationOf(ui) {
  const turns = (ui.app && ui.app.session && ui.app.session.turns) || [];
  const t = turns[turns.length - 1];
  return (t && Array.isArray(t.narration)) ? t.narration : [];
}

function syncTicker(ui) {
  // PROSE RESOLVING COUNTS AS ANIMATION.
  const revealing = ui.enabled && ui.activity && ui.story
    && (ui.activity.revealing(ui.story.narration)
      || ui.activity.revealing(lastNarrationOf(ui)));
  // AND AN EDIT'S DIFF ARRIVING IN THE FEED — ui/turnsections.js `arriving`.
  const landing = ui.enabled && ui.story && require('./turnsections').arriving(ui.story.actions || []);
  const animating = ui.enabled && ui.activity && (ui.activity.busy() || revealing || landing);
  const working = Boolean(ui.phase || ui.interrupting || ui.waitingUntil);
  const wanted = ui.enabled && (working || animating);
  const want = animating ? FRAME_MS : TICK_MS;
  if (wanted && ui._tick && ui._tickMs !== want) {
    clearInterval(ui._tick);
    ui._tick = null;
  }
  if (wanted && !ui._tick) {
    ui._tickMs = want;
    ui._tick = setInterval(() => { syncTicker(ui); ui.refresh(); }, want);
    if (ui._tick.unref) ui._tick.unref();
  } else if (!wanted && ui._tick) {
    clearInterval(ui._tick);
    ui._tick = null;
    ui._tickMs = 0;
  }
}

module.exports = { ActivitySurface, syncTicker, FRAME_MS, TICK_MS, MAX_LINGER_MS };
