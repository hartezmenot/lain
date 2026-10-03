'use strict';

/** THE ACTIVITY TIMELINE — a presentation-layer playback of what already happened. */

/** How long each phase lasts at normal speed, in milliseconds. */
const ENTER_MS = 140;
// NO MINIMUM CARD LIFETIME (§50, 2026-09-18): the card holds exactly as long as
// the operation ran. Enter/settle/exit are transitions, not a floor on reality.
const HOLD_MS = 0;
const SETTLE_MS = 200;    // the finished state, counters landed
const EXIT_MS = 160;

/** How much faster playback may run when it is behind. */
const MAX_SPEED = 3.5;
/** How often the unsettled glyphs change while a subject materialises. */
const { SCRAMBLE_MS } = require('./reveal');
/** Backlog at which MAX_SPEED is reached. Kept for callers that measure with it. */
const FULL_SPEED_AT = 12;

/** HOW FAR BEHIND THE PRESENTATION IS ALLOWED TO GET, in milliseconds. */
const TARGET_LAG_MS = 1800;
/** Debt at which `MAX_SPEED` is reached. */
const FULL_LAG_MS = 12000;

/** Bounded, like every other feed in the program. */
const MAX_EVENTS = 400;

/** The phases one activity passes through, in order. */
const PHASE = Object.freeze({
  QUEUED: 'QUEUED',
  ENTER: 'ENTER',
  ACTIVE: 'ACTIVE',
  SETTLE: 'SETTLE',
  EXIT: 'EXIT',
  COMPACT: 'COMPACT',
});

/** THE LABEL ABOVE THE QUOTATION — the verb, and nothing else. */
const VERB = {
  read_file: 'reading',
  list_dir: 'reading',
  file_info: 'reading',
  read_symbol: 'reading',
  grep: 'searching',
  glob: 'searching',
  symbols: 'searching',
  dependents: 'searching',
  check_symbols: 'checking',
  find_residue: 'checking',
  write_file: 'writing',
  append_file: 'appending',
  insert_at: 'patching',
  edit_file: 'patching',
  apply_patch: 'patching',
  replace_symbol: 'patching',
  insert_near_symbol: 'patching',
  rename_symbol: 'patching',
  delete_range: 'patching',
  remove_symbol: 'removing',
  delete_file: 'removing',
  move_file: 'moving',
  run_bash: 'running',
  run_powershell: 'running',
  run_cmd: 'running',
  python_run: 'running',
  process_run: 'running',
  run_background: 'starting shell',
  job_wait: 'waiting for shell',
  job_status: 'checking shell',
  job_stop: 'stopping shell',
  observe_start: 'starting monitor',
  observe_stop: 'stopping monitor',
  delegate: 'starting agent',
  review_changes: 'reviewing',
  engineering_brief: 'surveying',
  plan_write: 'planning',
  plan_step_done: 'planning',
};

/** Tools whose completed form is an edit — `edit python.js  +72 -40`. */
const EDITS = new Set(['write_file', 'edit_file', 'apply_patch', 'append_file', 'insert_at',
  'delete_range', 'replace_symbol', 'insert_near_symbol', 'remove_symbol', 'rename_symbol']);

/** A test or build command, so a green run can say so. */
const RUNS = new Set(['run_bash', 'run_powershell', 'run_cmd', 'python_run', 'process_run', 'run_background']);

function verbOf(name, running) {
  const v = VERB[String(name || '')] || (running ? 'working' : 'did');
  return v;
}

class Playback {
  /** instant play everything at once — a pipe, a test, animation turned off. */
  constructor({ instant = false, now = () => Date.now() } = {}) {
    this.instant = Boolean(instant);
    this._now = now;
    /** Every activity, in the order it really happened. */
    this.events = [];
    /** Where playback has reached: the index of the event currently on screen. */
    this.cursor = 0;
    /** When the event at `cursor` began playing. */
    this.startedAt = 0;
  }

  /** A REAL TOOL EVENT, pushed the moment it happens. */
  enqueue(ev) {
    if (this.events.length >= MAX_EVENTS) return null;
    const e = {
      name: String((ev && ev.name) || ''),
      target: String((ev && ev.target) || ''),
      verb: verbOf((ev && ev.name) || '', true),
      ok: ev && ev.ok !== undefined ? Boolean(ev.ok) : true,
      done: Boolean(ev && ev.done),
      added: Number((ev && ev.added) || 0),
      removed: Number((ev && ev.removed) || 0),
      isEdit: EDITS.has(String((ev && ev.name) || '')),
      isRun: RUNS.has(String((ev && ev.name) || '')),
      note: String((ev && ev.note) || ''),
      at: this._now(),
      /** When the real operation FINISHED. What ends the ACTIVE phase. */
      doneAt: 0,
      /** Extra settle time, in milliseconds, for a card whose diff window is still being performed under it. */
      linger: 0,
      /** Wall-clock length of the REAL operation, once known. */
      tookMs: Number((ev && ev.tookMs) || 0),
    };
    this.events.push(e);
    return e;
  }

  /** The running operation finished. */
  complete(patch = {}) {
    // THE OLDEST UNFINISHED EVENT, not the newest.
    const e = this.events.find((x) => !x.done) || this.events[this.events.length - 1];
    if (!e) return null;
    if (patch.added !== undefined) e.added = Number(patch.added) || 0;
    if (patch.removed !== undefined) e.removed = Number(patch.removed) || 0;
    if (patch.ok !== undefined) e.ok = Boolean(patch.ok);
    if (patch.note !== undefined) e.note = String(patch.note || '');
    if (patch.name !== undefined && patch.name) { e.name = String(patch.name); e.isEdit = EDITS.has(e.name); e.isRun = RUNS.has(e.name); }
    e.done = true;
    e.tookMs = Math.max(0, this._now() - e.at);
    e.doneAt = this._now();
    return e;
  }

  /** How many events are waiting behind the one on screen. */
  get backlog() { return Math.max(0, this.events.length - 1 - this.cursor); }

  /** HOW MUCH PRESENTATION TIME IS STILL OWED, at full speed, in milliseconds. */
  debtMs(now = this._now()) {
    let owed = 0;
    for (let i = this.cursor; i < this.events.length; i++) {
      const e = this.events[i];
      const hold = e.done
        ? Math.max(HOLD_MS, (e.doneAt || 0) - (e.at || 0) - ENTER_MS)
        : HOLD_MS;
      const full = ENTER_MS + hold + SETTLE_MS + (e.linger || 0) + EXIT_MS;
      // The head has been on screen since `startedAt`; the rest have not been
      // on screen at all.
      owed += i === this.cursor && this.startedAt
        ? Math.max(0, full - Math.max(0, Number(now) - this.startedAt))
        : full;
    }
    return owed;
  }

  /** The clock multiplier for how far behind the presentation currently is. */
  speed(now = this._now()) {
    if (this.instant) return Infinity;
    const debt = this.debtMs(now);
    if (debt <= TARGET_LAG_MS) return 1;
    const t = Math.min(1, (debt - TARGET_LAG_MS) / (FULL_LAG_MS - TARGET_LAG_MS));
    return 1 + t * (MAX_SPEED - 1);
  }

  /** Advance playback to `now` and return what the screen should show. */
  at(now = this._now()) {
    if (!this.events.length) return { active: null, history: [], busy: false, phase: PHASE.COMPACT };

    // INSTANT: everything is already history. This is the path a pipe and a
    // test take, and it must produce the same CONTENT as a full playback.
    if (this.instant) {
      this.cursor = this.events.length;
      // THE CALL STILL IN FLIGHT IS SHOWN AS IT IS, NOW — no enter, no hold, no settle.
      const last = this.events[this.events.length - 1];
      const live = last && !last.done ? last : null;
      const before = live && this.events.length > 1 ? this.events[this.events.length - 2] : null;
      return {
        active: live ? {
          still: true, leaving: before ? compactOf(before) : null, verb: live.verb, target: live.target, name: live.name, ok: live.ok,
          isEdit: live.isEdit, isRun: live.isRun, added: 0, removed: 0,
          finalAdded: live.added, finalRemoved: live.removed, progress: 0,
          phase: PHASE.ACTIVE, window: null, windowMs: 0, performing: false, enter: 1, tick: 0,
        } : null,
        history: (live ? this.events.slice(0, -1) : this.events).map((e) => compactOf(e)),
        busy: false,
        phase: live ? PHASE.ACTIVE : PHASE.COMPACT,
      };
    }

    // Walk the playhead forward over every event whose time is up.
    for (;;) {
      if (this.cursor >= this.events.length) break;
      const e = this.events[this.cursor];
      if (!this.startedAt) this.startedAt = e.at;
      const endsAt = this.startedAt + this._span(e, this.startedAt, now);
      if (now < endsAt) break;
      this.cursor += 1;
      this.startedAt = endsAt;
    }

    const history = this.events.slice(0, this.cursor).map((ev) => compactOf(ev));
    if (this.cursor >= this.events.length) {
      return { active: null, history, busy: false, phase: PHASE.COMPACT };
    }

    const e = this.events[this.cursor];
    const speed = this.speed(now);
    const elapsed = Math.max(0, now - this.startedAt);
    const enterEnd = ENTER_MS / speed;
    const activeEnd = enterEnd + this._hold(e, this.startedAt) / speed;
    const settleEnd = activeEnd + (SETTLE_MS + (e.linger || 0)) / speed;

    let phase = PHASE.ACTIVE;
    if (elapsed < enterEnd) phase = PHASE.ENTER;
    else if (elapsed < activeEnd) phase = PHASE.ACTIVE;
    else if (elapsed < settleEnd) phase = PHASE.SETTLE;
    else phase = PHASE.EXIT;

    // HOW FAR THROUGH THE ACTIVE PHASE, for the counters to interpolate along.
    const windowMs = e.window ? Math.max(0, (elapsed - enterEnd) * speed) : 0;
    const performing = Boolean(e.window) && windowMs < (e.windowTotal || 0);

    // HOW FAR THROUGH ENTER, so the subject MATERIALISES rather than appearing.
    const enter = enterEnd > 0 ? Math.max(0, Math.min(1, elapsed / enterEnd)) : 1;
    // Which scramble frame this is. Derived from the clock, so drawing a frame
    // twice cannot advance the effect.
    const tick = Math.floor(elapsed / SCRAMBLE_MS);

    const span = Math.max(1, activeEnd - enterEnd);
    const progress = phase === PHASE.ENTER ? 0
      : phase === PHASE.ACTIVE ? Math.max(0, Math.min(1, (elapsed - enterEnd) / span))
        : 1;

    return {
      active: {
        // WHAT IS ON ITS WAY OUT, carried for the length of the ENTER phase.
        leaving: phase === PHASE.ENTER && this.cursor > 0
          ? compactOf(this.events[this.cursor - 1]) : null,
        // PRESENT TENSE WHILE ITS OWN WINDOW IS STILL PERFORMING
        verb: (phase === PHASE.SETTLE || phase === PHASE.EXIT) && !performing
          ? doneVerb(e) : e.verb,
        target: e.target,
        name: e.name,
        ok: e.ok,
        isEdit: e.isEdit,
        isRun: e.isRun,
        // COUNTERS CLIMB while the edit is active and land on the real numbers.
        added: e.isEdit ? Math.round(e.added * progress) : 0,
        removed: e.isEdit ? Math.round(e.removed * progress) : 0,
        finalAdded: e.added,
        finalRemoved: e.removed,
        progress,
        phase,
        // THE WINDOW THIS OPERATION CARRIES, AND HOW FAR INTO IT WE ARE --
        window: e.window || null,
        windowMs,
        performing,
        enter,
        tick,
      },
      history,
      busy: true,
      phase,
    };
  }

  /** HOW LONG THE ACTIVE PHASE HOLDS — until the operation FINISHED. */
  _hold(e, from) {
    if (!e.done) return Infinity;
    return Math.max(HOLD_MS, (e.doneAt || 0) - from - ENTER_MS);
  }

  /** The whole clock length of one event at the current speed. */
  _span(e, from, now = this._now()) {
    const hold = this._hold(e, from);
    if (hold === Infinity) return Infinity;
    return (ENTER_MS + hold + SETTLE_MS + (e.linger || 0) + EXIT_MS) / this.speed(now);
  }

  /** Is anything still playing? The ticker asks this to decide whether to run. */
  busy(now = this._now()) {
    if (this.instant) return false;
    return this.at(now).busy;
  }

  /** Forget everything. A new task starts with an empty timeline. */
  reset() {
    this.events = [];
    this.cursor = 0;
    this.startedAt = 0;
  }
}

/** The past-tense label a finished activity settles into. */
function doneVerb(e) {
  if (e.isEdit) return 'edit';
  const v = String(e.verb || '');
  return v === 'reading' ? 'read'
    : v === 'searching' ? 'searched'
      : v === 'writing' ? 'wrote'
        : v === 'patching' ? 'edit'
          : v === 'removing' ? 'removed'
            : v === 'running' ? 'ran'
              : v === 'checking' ? 'checked'
                : v === 'reviewing' ? 'reviewed'
                  : v === 'moving' ? 'moved'
                    : v === 'surveying' ? 'surveyed'
                      : v === 'planning' ? 'planned'
                        : v;
}

/** One finished activity, as the single quiet line it leaves behind. */
function compactOf(e) {
  return {
    verb: doneVerb(e),
    target: e.target,
    name: e.name,
    ok: e.ok,
    isEdit: e.isEdit,
    added: e.added,
    removed: e.removed,
    note: e.note,
  };
}

module.exports = {
  Playback, PHASE, VERB, EDITS, RUNS, verbOf, doneVerb, compactOf,
  ENTER_MS, HOLD_MS, SETTLE_MS, EXIT_MS, MAX_SPEED, FULL_SPEED_AT, MAX_EVENTS,
  TARGET_LAG_MS, FULL_LAG_MS,
};
