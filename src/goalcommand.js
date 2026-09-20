'use strict';

/**
 * `/goal` — WHAT THE USER IS TRYING TO ACHIEVE.
 *
 * ------------------------------------------------------------------------
 * THE ONE BEHAVIOUR THAT MAKES IT WORTH HAVING.
 *
 * `/goal` with a goal already set does NOT print it read-only. It copies it
 * back into the composer:
 *
 *     GOAL › Stabilize LAIN CLI and finish Harness_
 *
 * so it can be edited — words deleted, detail appended, the whole thing
 * rewritten — and committed with Enter. A read-only panel would make every
 * revision a retype from memory, and a goal that is annoying to revise is a
 * goal that goes stale and then gets ignored.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT MACHINERY, so it does not go to the command panel.
 *
 * A goal is a statement about the WORK, in the record of the work — the same
 * argument `/plan` already makes for itself in commands.js. Routed to the panel
 * it would sit in a box that closes on Esc.
 *
 * ------------------------------------------------------------------------
 * WITHOUT A LINE EDITOR — a pipe, `-p`, a test — there is no composer to open.
 * `/goal <text>` still works and is the form a script uses; bare `/goal` prints
 * the goal, because printing is the only thing a surface with no keyboard can
 * usefully do.
 */

const goal = require('./goal');
const compose = require('./composemode');

function register({ define, C }) {
  define('/goal', {
    // Like /plan: a statement about the task belongs in the task's record.
    args: '[<what you are trying to achieve> | clear]',
    desc: 'The standing goal this work serves — bare /goal edits it',
    run(app, { args = [], rest = '' } = {}) {
      const w = (s) => app.render.write(s);
      const sub = String(args[0] || '').toLowerCase();
      const current = goal.text(app.session);

      if (sub === 'clear' || sub === 'none') {
        if (!current) { w(C.dim('  No goal set.\n')); return; }
        goal.clear(app.session);
        try { app.session.save(); } catch { /* the change still holds for this run */ }
        w(C.dim('  Goal cleared.\n'));
        return;
      }

      // ---- `/goal <text>` — the direct form ------------------------------
      // A NEW goal: the active one, if different, is paused rather than lost.
      if (rest && rest.trim()) {
        goal.create(app.session, rest.trim());
        try { app.session.save(); } catch { /* the change still holds for this run */ }
        w(C.green('  ✓ goal  ') + C.bold(goal.text(app.session)) + '\n');
        return;
      }

      // ---- BARE `/goal` — open the composer, prefilled --------------------
      // `input.isTTY`, not `ui.enabled` — see plan.js for the whole reasoning.
      // The short version: UI ENABLED is a fact about output, and
      // `LAIN_FORCE_TUI=1` draws real frames over a pipe. Opening the composer
      // there is worse than the plan case rather than better: nothing blocks,
      // so the composer stays open and EATS the following piped lines as its
      // own text instead of running them.
      const interactive = Boolean(app.ui && app.ui.enabled && app.input && app.input.isTTY);
      if (!interactive) {
        // NOTHING TO TYPE INTO. Say what is true rather than opening a mode
        // nobody can close — the same rule the ask panel follows on a pipe.
        if (current) w('  ' + C.bold(current) + '\n' + C.dim('  /goal <text> to change it\n'));
        else w(C.dim('  No goal set. /goal <what you are trying to achieve>\n'));
        return;
      }
      // ---- NO GOAL AT ALL: straight into the composer ---------------------
      //
      // `GOAL › _` is the whole interface: the composer's label says what the
      // line is for, so nothing is written into the conversation.
      const goals = goal.list(app.session);
      if (!goals.length) {
        compose.open(app, compose.KIND.GOAL, { prefill: '', intent: 'new' });
        return;
      }
      return shelfFor(app, goals);
    },
  });
}

/**
 * THE GOAL SHELF — Continue · Edit · New · Delete, on the goal(s) that exist.
 *
 * One goal: it is the context line. Several: they are choices (the active one
 * first, marked), and the action applies to the one selected. No narration is
 * printed either way; the shelf closes and the composer or the prompt is back.
 */
async function shelfFor(app, goals) {
  const { shelf } = require('./ui/shelf');
  const single = goals.length === 1;
  const picked = await app.ui.ask(shelf({
    title: 'Goal',
    context: single ? [goals[0].text] : [],
    choices: single ? [] : goals.map((g) => ({
      label: g.text.replace(/\s+/g, ' ').slice(0, 72) + (g.text.length > 72 ? '…' : ''),
      value: g.id,
      detail: g.state === goal.STATE.ACTIVE ? '· active' : '',
    })),
    actions: [
      { label: 'Continue', value: 'continue' },
      { label: 'Edit', value: 'edit' },
      { label: 'New', value: 'new' },
      { label: 'Delete', value: 'delete', confirm: 'Delete this goal? It cannot be brought back.', yes: 'Delete' },
    ],
  }));
  if (!picked) return;
  const targetId = picked.choice || goals[0].id;
  const target = goals.find((g) => g.id === targetId) || goals[0];
  const save = () => { try { app.session.save(); } catch { /* the change still holds for this run */ } };
  switch (picked.action) {
    // ---- CONTINUE MEANS CONTINUE THE WORK -------------------------------
    //
    // It used to mean `goal.activate` and nothing else: the goal became the
    // active one and LAIN sat there until the person typed "continue" at it.
    // The button says Continue, so it continues — resolving the plan, the
    // step in hand and what has already landed, and starting the turn. See
    // src/continueactions.js, and note the three Continue buttons in this
    // product are three NAMED actions rather than one generic one.
    case 'continue': {
      const cont = require('./continueactions');
      const r = await cont.goalContinue(app, target.id);
      if (r.outcome === cont.OUTCOME.COMPLETED) {
        // A FINISHED GOAL IS NOT SILENTLY RE-RUN, and the evidence that it
        // finished is not overwritten. The person decides.
        const again = await app.ui.ask(shelf({
          title: 'Goal already completed',
          context: [target.text],
          actions: [
            { label: 'Reopen', value: 'reopen' },
            { label: 'Cancel', value: 'cancel' },
          ],
        }));
        if (!again || again.action !== 'reopen') return;
        await cont.goalContinue(app, target.id, { reopen: true });
        save();
        return;
      }
      save();
      return;
    }
    case 'edit':
      compose.open(app, compose.KIND.GOAL, { prefill: target.text, intent: 'edit', target: target.id });
      return;
    case 'new':
      compose.open(app, compose.KIND.GOAL, { prefill: '', intent: 'new' });
      return;
    case 'delete':
      goal.remove(app.session, target.id);
      save();
      return;
    default:
  }
}

module.exports = { register, shelfFor };
