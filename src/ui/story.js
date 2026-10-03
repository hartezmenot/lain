'use strict';

/** THE STORY OF THE CURRENT TASK — what was said, by whom, and what was done. */

/** Bound on each feed, matching what a turn record itself keeps. */
const MAX = 200;

class Story {
  constructor() {
    /** Finished calls of the turn in flight. */
    this.actions = [];
    /** Prose the model produced this turn, interleaved with the calls. */
    this.narration = [];
    /** The message this turn is about, shown from the instant it is submitted. */
    this.user = null;
    /** Bounded shell and test output for the OUTPUT surface. */
    this.outputs = [];
    /** What the PROGRAM said this turn — a liveness warning, a block, a notice. */
    this.notes = [];
    /** Folded thinking phases of the turn in flight (ui/thoughtrow.js), anchored like narration. */
    this.thoughts = [];
  }

  /** A new turn: whatever the last one was doing is no longer the news. */
  beginTurn() {
    this.actions = [];
    this.narration = [];
    this.notes = [];
    this.thoughts = [];
  }

  /** The turn is over: hand the feed back to the persisted record. */
  endTurn() {
    this.actions = [];
    this.narration = [];
    this.notes = [];
    this.thoughts = [];
    this.user = null;
  }

  /** A genuinely new task: the previous task's story is no longer the news. */
  newTask() {
    this.user = null;
  }

  /** is almost always. Set when LAIN continues its own work — the turn an external consultation hands back, a rate-limit resume — so the feed can draw a… */
  setUser(text, from = null, typed = false) {
    this.user = String(text || '').trim() || null;
    this.userFrom = this.user ? (from || null) : null;
    this.userTyped = Boolean(this.user && typed);
  }

  noteAction(a) {
    if (this.actions.length < MAX) this.actions.push(a);
  }

  /** `at` IS WHEN IT ARRIVED, and the presentation layer needs it. */
  noteNarration(text, at = Date.now()) {
    const t = String(text || '').trim();
    if (t && this.narration.length < MAX) {
      this.narration.push({ text: t, after: this.actions.length, at });
    }
  }

  /** A thinking phase ended (turn.js `thought`): kept by reference, so its exact token count can land later. */
  noteThought(t) {
    if (t && this.thoughts.length < MAX) this.thoughts.push(Object.assign(t, { after: this.actions.length }));
  }

  /** One line from the program itself, placed where it was said. */
  noteSystem(text, level = 'info') {
    const t = String(text || '').trim();
    if (t && this.notes.length < MAX) this.notes.push({ text: t, level, after: this.actions.length });
  }

  /** Command output, for the OUTPUT surface. Bounded — never unbounded growth. */
  noteOutput(command, output, exitCode) {
    this.outputs.push({ command, output: String(output || '').slice(0, 20000), exitCode });
    if (this.outputs.length > 20) this.outputs.shift();
  }
}

module.exports = { Story, MAX };
