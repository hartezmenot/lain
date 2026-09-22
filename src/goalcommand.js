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

/**
 * THE SEMANTICS (2026-09-23 — a goal is set in order to be WORKED ON):
 *
 *   /goal <text>     set the durable goal, then execute it — one USER turn
 *   /goal            capture mode: the next submitted line (a multi-line paste
 *                    included) becomes the goal and executes the same way
 *   /goal show       show it (the Continue · Edit · New · Delete shelf on a TTY)
 *   /goal continue   resume the active — or most recent paused — goal
 *   /goal clear      clear it
 *
 * Before, `/goal <text>` and the capture composer stored the goal and stopped,
 * so a pasted task needed a second `/goal continue` to start. The text runs as
 * the person's own message (drawn once, as USER), never as a paraphrase.
 */
const SUB = Object.freeze({ clear: 'clear', none: 'clear', show: 'show', continue: 'continue', resume: 'continue' });

function register({ define, C }) {
  define('/goal', {
    // Like /plan: a statement about the task belongs in the task's record.
    args: '[<what you are trying to achieve> | show | continue | clear]',
    desc: 'Set the standing goal and start on it — bare /goal captures the next message',
    run(app, { args = [], rest = '' } = {}) {
      const w = (s) => app.render.write(s);
      const sub = args.length === 1 ? SUB[String(args[0] || '').toLowerCase()] : null;
      const current = goal.text(app.session);

      if (sub === 'clear') {
        if (!current) { w(C.dim('  No goal set.\n')); return; }
        goal.clear(app.session);
        try { app.session.save(); } catch { /* the change still holds for this run */ }
        w(C.dim('  Goal cleared.\n'));
        return;
      }

      // `input.isTTY`, not `ui.enabled` — see plan.js for the whole reasoning.
      // The short version: UI ENABLED is a fact about output, and
      // `LAIN_FORCE_TUI=1` draws real frames over a pipe. Opening the composer
      // there is worse than the plan case rather than better: nothing blocks,
      // so the composer stays open and EATS the following piped lines as its
      // own text instead of running them.
      const interactive = Boolean(app.ui && app.ui.enabled && app.input && app.input.isTTY);

      if (sub === 'continue') {
        const target = goal.list(app.session)[0];
        if (!target) { w(C.dim('  No goal to continue. /goal <what you are trying to achieve>\n')); return; }
        return require('./continueactions').goalContinue(app, target.id);
      }

      if (sub === 'show') {
        const goals = goal.list(app.session);
        if (!goals.length) { w(C.dim('  No goal set. /goal <what you are trying to achieve>\n')); return; }
        if (!interactive) { w('  ' + C.bold(current || goals[0].text) + '\n' + C.dim('  /goal continue · /goal clear\n')); return; }
        return shelfFor(app, goals);
      }

      // ---- `/goal <text>` — set it and start on it ------------------------
      // A NEW goal: the active one, if different, is paused rather than lost.
      if (rest && rest.trim()) return execute(app, rest.trim());

      // ---- BARE `/goal` — capture mode -------------------------------------
      if (!interactive) {
        // NOTHING TO TYPE INTO. Say what is true rather than opening a mode
        // nobody can close — the same rule the ask panel follows on a pipe.
        if (current) w('  ' + C.bold(current) + '\n' + C.dim('  /goal <text> to set a new one · /goal continue\n'));
        else w(C.dim('  No goal set. /goal <what you are trying to achieve>\n'));
        return;
      }
      // `GOAL › _` is the whole interface: the composer's label says what the
      // line is for, so nothing is written into the conversation. ALWAYS EMPTY:
      // prefilling the current goal would glue a pasted task onto it. Editing an
      // existing goal is `/goal show` → Edit.
      compose.open(app, compose.KIND.GOAL, { prefill: '', intent: 'new' });
    },
  });
}

/**
 * SET THE GOAL AND RUN IT — the direct form and a captured line end here.
 *
 * The text goes through `App.handle` as the person's own message: the input
 * gateway still decides whether it can reach a model now (a rate-limited route
 * holds it), and the interactive loop gets its prompt back at once. `asText`
 * keeps a goal that happens to begin with `/` from being run as a command.
 */
function execute(app, text) {
  goal.create(app.session, text);
  try { app.session.save(); } catch { /* the change still holds for this run */ }
  // ONE TURN AT A TIME PER SESSION: set mid-turn, it runs when that turn ends
  // (submitclose.js), never as a second concurrent turn.
  if (app.abort && !app.abort.signal.aborted) {
    app._queuedContinue = { text, goal: true, at: Date.now() };
    app.render.write('  goal set — starts when the current turn ends\n');
    return null;
  }
  const background = Boolean(app.interactive && app.ui && app.ui.enabled && typeof app.startPrimary === 'function');
  return app.handle(text, { background, asText: true });
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

module.exports = { register, shelfFor, execute };
