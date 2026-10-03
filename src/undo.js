'use strict';

/** THE UNDO STACK — what an edit LEAVES BEHIND. */

/** Edit kinds that COALESCE: a run of them shares one undo step, not one each. */
const COALESCE_KINDS = new Set(['insert', 'delete-back', 'delete-fwd']);

class UndoStack {
  constructor({ max = 100 } = {}) {
    this.max = max;
    this.undo = [];
    this.redo = [];
    this.kind = null;
  }

  /** Record the state an edit of `kind` is about to leave behind — unless it is a continuation of the same kind of run already in progress. */
  push(snapshot, kind) {
    // A REAL EDIT CUTS OFF REDO — once something new has been done, "redo" no
    // longer has a future to replay, the same rule every editor uses.
    this.redo.length = 0;
    if (this.undo.length && this.kind === kind && COALESCE_KINDS.has(kind)) return;
    this.undo.push(snapshot);
    if (this.undo.length > this.max) this.undo.shift();
    this.kind = kind;
  }

  /** Break a coalescing run without touching either stack. */
  break() { this.kind = null; }

  /** Forget everything — the line was replaced wholesale, not edited. */
  reset() { this.undo.length = 0; this.redo.length = 0; this.kind = null; }

  /** @returns {object|null} the snapshot to restore, or null if there is none. */
  popUndo(current) {
    if (!this.undo.length) return null;
    const prev = this.undo.pop();
    this.redo.push(current);
    this.kind = null; // whatever comes next starts a fresh run
    return prev;
  }

  /** @returns {object|null} the snapshot to restore, or null if there is none. */
  popRedo(current) {
    if (!this.redo.length) return null;
    const next = this.redo.pop();
    this.undo.push(current);
    this.kind = null;
    return next;
  }
}

module.exports = { UndoStack, COALESCE_KINDS };
