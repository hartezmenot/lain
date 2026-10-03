'use strict';

/** THE NEXT LINE YOU TYPE IS NOT A PROMPT — it is a goal, or a plan. */

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

/** OPEN THE COMPOSER. */
function open(app, kind, { prefill = '', hint = '', target = null, intent = null } = {}) {
  if (!app || !KIND[kind]) return null;
  // `intent` says what a composed GOAL becomes: 'new' (a fresh goal; the active one is
  // paused, never lost) or 'edit' of `target`. Absent, it rewrites the active goal.
  app.composing = { kind, at: Date.now(), hint: String(hint || ''), target, intent };
  if (hint && typeof app.transient === 'function') app.transient('info', hint);
  // THE LINE ITSELF. `setLine` is the existing editor entry point — the one history recall and completion acceptance already use — so the text arrives…
  try { if (app.input && typeof app.input.setLine === 'function') app.input.setLine(String(prefill || '')); } catch { /* a pipe has no line editor */ }
  return app.composing;
}

/** Is a composer open, and for what? */
function pending(app) { return (app && app.composing) || null; }

/** THE HINT GOES WITH THE COMPOSER. */
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

/** CONSUME A LINE, IF A COMPOSER IS OPEN. */
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
      // CAPTURE: the line becomes the goal AND the work (2026-09-23).
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
