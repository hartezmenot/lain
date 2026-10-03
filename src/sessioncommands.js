'use strict';

/** THE SESSION AND VIEW COMMANDS — which session is current, and what is on screen right now. */

const { Session } = require('./session');

/** vocabulary, passed in rather than imported back. */
function register({ define, REGISTRY, DURING_TURN, C, FLASH_MS }) {
  define('/new', {
    flashMs: FLASH_MS,   // a receipt, not an inspector - see FLASH_MS
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    duringTurn: DURING_TURN.BLOCKED,
    desc: 'Start a fresh, empty session',
    run(app) {
      // adopt() also rebinds checkpoints and the cached project brief.
      app.adopt(new Session({ cwd: app.cwd }));
      app.render.write(C.dim(`  new session ${app.session.id} — empty.\n`));
    },
  });

  /** `/clean` — CLEAR THE SCREEN'S MEMORY, NOT THE SESSION'S. */
  define('/clean', {
    // ITS OWN RECEIPT MUST NOT BE THE FIRST THING IN THE CLEARED VIEW
    surface: true,
    desc: 'Clear the visible conversation (the model keeps its context; /new starts over)',
    run(app) {
      const s = app.session;
      const turns = (s.turns || []).length;
      const voices = (s.actors || []).length;
      s.turns = [];
      s.actors = [];
      // THE PINNED OBJECTIVE IS PART OF THE VIEW TOO.
      const turnActive = Boolean(app.abort && !app.abort.signal.aborted);
      if (!turnActive) { s.task = null; s.lifecycle = null; s.plan = null; }
      if (app.ui) {
        app.ui.story.beginTurn();
        app.ui.story.endTurn();
        app.ui.story.outputs = [];
        if (app.ui.enabled) {
          app.ui.dismissCompletion();
          app.ui.screen.workspaceScroll = 0;
          app.ui.screen.stickToBottom = true;
        }
      }
      app.render.transcript = [];
      const removed = `${turns} turn(s)` + (voices ? ` and ${voices} actor line(s)` : '');
      // IT SAID "CONTEXT CLEARED" AND THE CONTEXT WAS NOT CLEARED
      const kept = (s.messages || []).length;
      app.render.write(C.green('  View cleared.') + C.dim(`  ${removed} removed from the screen.`) + '\n');
      if (kept) {
        const k = Math.round(s.contextChars() / 1000);
        app.render.write(C.dim(`  The model's context is UNCHANGED — ${kept} messages, ~${k}k chars.`) + '\n');
        app.render.write(C.dim('  /compact shrinks it. /new starts a genuinely fresh session.') + '\n');
      }
      if (turnActive) {
        app.render.write(C.dim('  A turn is still running; it keeps its task and plan. /clean never cancels work.') + '\n');
      }
      if (app.ui && app.ui.enabled) app.ui.refresh();
    },
  });

  /** `/clear` — CLEAR THE CONVERSATION THE MODEL IS SENT. */
  define('/clear', {
    flashMs: FLASH_MS,   // a receipt, not an inspector - see FLASH_MS
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    duringTurn: DURING_TURN.BLOCKED,
    args: '[context]',
    desc: "Clear the model's conversation (the task and plan survive; /clean clears only the screen)",
    run(app) {
      const s = app.session;
      const cleared = s.clearContext();
      const had = cleared.removed;
      const chars = cleared.chars;
      // The view goes too — a screen still showing a conversation the model no
      // longer has is the same trap in the other direction.
      REGISTRY.get('/clean').run(app, { args: [], rest: '' });
      app.render.write(C.green('  Conversation cleared.')
        + C.dim(`  ${had} message(s), ~${Math.round(chars / 1000)}k chars removed from what the model is sent.`) + '\n');
      if (s.task) {
        app.render.write(C.dim(`  The task survives: ${String(s.task.objective || '').slice(0, 60)}\n`));
        app.render.write(C.dim('  /new drops the task and plan as well.\n'));
      }
      app.render.write(C.dim('  Nothing on disk changed — /resume brings this session back.\n'));
      if (app.ui && app.ui.enabled) app.ui.refresh();
    },
  });

  /** `/backup` — a state worth returning to, with the evidence it worked. */
  define('/backup', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    duringTurn: DURING_TURN.BLOCKED,
    args: '[list | create [label] | restore <n>]',
    desc: 'Checkpoint this project, or go back to one that passed',
    run(app, { args, rest }) {
      const B = require('./backups');
      const w = (s) => app.render.write(s);
      const sub = String(args[0] || 'list').toLowerCase();

      const show = () => {
        const rows = B.list();
        if (!rows.length) {
          w(C.dim('  No checkpoints yet. /backup create [label]') + '\n');
          return rows;
        }
        w('\n' + C.bold('CHECKPOINTS') + '\n');
        rows.forEach((r, i) => {
          const when = String(r.at).replace('T', ' ').slice(0, 16);
          // STABLE MEANS A SUITE PASSED. Nothing else earns the word — a list
          // where everything says stable tells you nothing.
          const mark = r.stable ? C.green('✓ stable') : r.tests ? C.yellow('✗ failing') : C.dim('· untested');
          w('  ' + C.bold(String(i + 1).padEnd(3)) + mark + C.dim('  ' + when) + '\n');
          if (r.label) w('      ' + r.label + '\n');
          if (r.tests) w(C.dim(`      ${r.tests.passed} passed, ${r.tests.failed} failed`) + '\n');
          if (r.reason) w(C.dim('      ' + r.reason) + '\n');
          w(C.dim(`      ${r.files} files`
            + (r.config ? ` · config ${String(r.config).slice(0, 8)}` : '')
            + (r.v1 ? ` · V1 ${r.v1}` : '')) + '\n');
        });
        w(C.dim('\n  /backup restore <n> — explicit, and it checkpoints the current state first.') + '\n');
        return rows;
      };

      if (sub === 'list' || !rest) { show(); return; }

      if (sub === 'create' || sub === 'new') {
        const label = rest.slice(args[0].length).trim();
        w(C.dim('  copying the project…') + '\n');
        const r = B.create(app.session.cwd, { label, reason: 'asked for by you' });
        if (!r.ok) { w('  ' + C.yellow(r.why) + '\n'); return; }
        w('  ' + C.green('✓ checkpoint taken') + C.dim(`  ${r.row.files} files`) + '\n');
        // SAID PLAINLY: a checkpoint nobody tested is not a safe harbour, and
        // calling it one would be the whole failure this design exists to avoid.
        w(C.dim('    untested — run the suite, then /backup create again to record a stable one.') + '\n');
        return;
      }

      if (sub === 'restore') {
        const rows = B.list();
        const n = Number(args[1]);
        const row = rows[n - 1];
        if (!row) {
          w(C.yellow(`  There is no checkpoint ${args[1] || ''}.`) + C.dim(' /backup list') + '\n');
          return;
        }
        const r = B.restore(app.session.cwd, row.id);
        if (!r.ok) { w('  ' + C.yellow(r.why) + '\n'); return; }
        w('  ' + C.green('✓ restored')
          + C.dim(`  ${r.written} file(s) from ${String(row.at).replace('T', ' ').slice(0, 16)}`) + '\n');
        if (r.safety) w(C.dim('    the state before this restore is itself checkpoint 1.') + '\n');
        // WHAT WAS NOT TOUCHED.
        if (r.extra.length) {
          w(C.dim(`    ${r.extra.length} file(s) newer than the checkpoint were LEFT IN PLACE:`) + '\n');
          for (const f of r.extra.slice(0, 8)) w(C.dim('      ' + f) + '\n');
          if (r.extra.length > 8) w(C.dim(`      … ${r.extra.length - 8} more`) + '\n');
        }
        return;
      }

      w(C.dim('  /backup · /backup create [label] · /backup restore <n>') + '\n');
    },
  });

  /** `/sessions` and `/resume` — sessions named by WHAT THEY WERE. */
  define('/sessions', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    args: '[text]',
    desc: 'List saved sessions by what they were (does not resume any)',
    run(app, ctx) { return require('./resume').listCommand(app, ctx, { C }); },
  });

  define('/resume', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    duringTurn: DURING_TURN.BLOCKED,
    args: '[text | today | <n> | <id>]',
    desc: 'Browse recent sessions and restore one — no id to remember',
    run(app, ctx) { return require('./resume').runCommand(app, ctx, { C }); },
  });
}

module.exports = { register };
