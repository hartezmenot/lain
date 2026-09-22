'use strict';

/**
 * THE NEXT LINE YOU TYPE IS NOT A PROMPT — it is a goal, or a plan.
 *
 * ------------------------------------------------------------------------
 * WHY A MODE AND NOT AN ARGUMENT.
 *
 * `/goal stabilise the CLI and finish the Harness` works and is kept. But the
 * request in §14–§15 is the other half: `/goal` on its own opens a composer,
 * and if a goal already exists it comes BACK INTO THE COMPOSER for editing —
 * delete words, append detail, rewrite it — rather than being printed
 * read-only beside a message telling you to retype it.
 *
 * That needs exactly two things: the line prefilled, and the next Enter routed
 * somewhere other than the model.
 *
 * ------------------------------------------------------------------------
 * IT REUSES THE ONE MECHANISM THAT ALREADY EXISTS.
 *
 * `app.pendingAsk` is LAIN's existing rule for "the next line is an ANSWER, not
 * a new task" — it is what stops a pasted review starting a turn, mutating the
 * plan or resetting a step. This is the same rule for a different destination,
 * and it is checked in the same place in `App.handle`, immediately after it.
 *
 * A composed PLAN line or a goal EDIT therefore cannot start a turn, cannot
 * touch task identity, cannot spend a token and cannot reach a model:
 * `App.handle` returns before it reaches the classifier. The one exception is
 * deliberate and named: a CAPTURED goal (`/goal`, then the task) is returned as
 * `{ run }`, and `App.handle` routes that text through the ordinary gateway as
 * the person's own message — capturing a goal means "do this".
 *
 * ------------------------------------------------------------------------
 * ESCAPE IS ALWAYS A CANCEL, AND SO IS AN EMPTY LINE.
 *
 * Nothing is committed by pressing Enter on nothing. A person who opens the
 * goal composer, reads their own goal back and changes their mind has made no
 * decision, and a mode that treated that as "clear the goal" would be
 * destroying durable direction with the least deliberate keystroke there is.
 * Clearing a goal is `/goal clear`, typed on purpose.
 */

/** The things a composed line can become. */
const KIND = Object.freeze({
  GOAL: 'GOAL',
  PLAN_REPLACE: 'PLAN_REPLACE',
  PLAN_ADD: 'PLAN_ADD',
  PLAN_NEW: 'PLAN_NEW',
});

/** What the composer says in front of the line, per kind. */
const LABEL = Object.freeze({
  [KIND.GOAL]: 'GOAL',
  [KIND.PLAN_REPLACE]: 'PLAN',
  [KIND.PLAN_ADD]: 'PLAN +',
  [KIND.PLAN_NEW]: 'PLAN',
});

/**
 * OPEN THE COMPOSER.
 *
 * @param {string} prefill  the existing value, copied back for editing. This is
 *   the §15 behaviour and it is the point of the whole mode: an existing goal
 *   is EDITED, never retyped from memory.
 */
function open(app, kind, { prefill = '', hint = '', target = null, intent = null } = {}) {
  if (!app || !KIND[kind]) return null;
  // `intent` says what a composed GOAL becomes: 'new' (a fresh goal; the active one is
  // paused, never lost) or 'edit' of `target`. Absent, it rewrites the active goal.
  app.composing = { kind, at: Date.now(), hint: String(hint || ''), target, intent };
  if (hint && typeof app.transient === 'function') app.transient('info', hint);
  // THE LINE ITSELF. `setLine` is the existing editor entry point — the one
  // history recall and completion acceptance already use — so the text arrives
  // with the cursor at its end, undo reset, and the paste flag cleared.
  try { if (app.input && typeof app.input.setLine === 'function') app.input.setLine(String(prefill || '')); } catch { /* a pipe has no line editor */ }
  return app.composing;
}

/** Is a composer open, and for what? */
function pending(app) { return (app && app.composing) || null; }

/**
 * THE HINT GOES WITH THE COMPOSER. "Enter commits, Esc cancels" describes a
 * mode; once the mode is shut it is an instruction for nothing, and left in
 * the story it read as a question still waiting for an answer.
 */
function dropHint(app, c) {
  const notes = c && c.hint && app.ui && app.ui.story && app.ui.story.notes;
  if (!Array.isArray(notes)) return;
  const at = notes.map((n) => n.text).lastIndexOf(c.hint);
  if (at >= 0) notes.splice(at, 1);
}

/** Shut it without committing anything. */
function cancel(app) {
  if (!app) return null;
  dropHint(app, app.composing);
  app.composing = null;
  try { if (app.input && typeof app.input.setLine === 'function') app.input.setLine(''); } catch { /* no editor */ }
  return null;
}

/** The label the input region draws while a composer is open, or ''. */
function label(app) {
  const c = pending(app);
  return c ? (LABEL[c.kind] || '') : '';
}

/**
 * CONSUME A LINE, IF A COMPOSER IS OPEN.
 *
 * Called from `App.handle` beside `answerPending`. Returns true when the line
 * was taken, which is the caller's signal to return without classifying it.
 *
 * @returns {boolean}
 */
function take(app, textIn) {
  const c = pending(app);
  if (!c) return false;
  dropHint(app, c);
  app.composing = null;
  const value = String(textIn == null ? '' : textIn).trim();
  // AN EMPTY LINE COMMITS NOTHING. See the header: the least deliberate
  // keystroke there is must not destroy durable direction.
  if (!value) {
    // Nothing committed, nothing said: the line simply comes back.
    return true;
  }
  if (c.kind === KIND.GOAL) {
    const goal = require('./goal');
    if (c.intent === 'new') {
      // CAPTURE: the line becomes the goal AND the work (2026-09-23). The caller
      // (`App.handle`) runs `run` as the person's own message — once, no second
      // `/goal continue`. Editing an existing goal (below) only edits it.
      goal.create(app.session, value);
      try { app.session.save(); } catch { /* the change still holds for this run */ }
      return { run: value };
    }
    if (c.intent === 'edit' && c.target) goal.edit(app.session, c.target, value);
    else goal.set(app.session, value);
    // NO RECEIPT: the goal is state, not news. `/goal show` shows it on its shelf.
  } else if (c.kind === KIND.PLAN_REPLACE || c.kind === KIND.PLAN_ADD || c.kind === KIND.PLAN_NEW) {
    // ONE PLAN OWNER. The steps are built by plan.js from this text; nothing
    // here keeps a second copy of them or a second notion of what a step is.
    require('./plancompose').commit(app, c.kind === KIND.PLAN_REPLACE ? 'replace' : c.kind === KIND.PLAN_NEW ? 'new' : 'add', value);
  }
  try { app.session.save(); } catch { /* the change still holds for this run */ }
  return true;
}

module.exports = { KIND, LABEL, open, pending, cancel, label, take };
