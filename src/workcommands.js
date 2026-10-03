'use strict';

/** THE WORKING-TREE COMMANDS — what changed on disk, and putting it back. */

const path = require('path');

function register({ define, DURING_TURN, C, FLASH_MS }) {
  define('/undo', {
    flashMs: FLASH_MS,   // a receipt, not an inspector - see FLASH_MS
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    duringTurn: DURING_TURN.BLOCKED,
    desc: 'Restore the files changed by the most recent mutating tool call',
    run(app) {
      const r = app.checkpoints.undo();
      if (!r.ok) {
        // A refusal to overwrite someone else's change is a WARNING, not the
        // shrug that "nothing to undo" is. They are different situations.
        if (r.stale) app.render.notice('warn', r.error);
        else app.render.write(C.dim(`  ${r.error}\n`));
        return;
      }
      app.render.write(C.green(`  undid ${r.id}`) + '\n');
      for (const f of r.restored) {
        app.render.write(C.dim(`    ${f.action}  ${path.relative(app.session.cwd, f.path)}`) + '\n');
        app.session.evidence.invalidate(f.path); // the bytes changed under us
      }
    },
  });

  define('/diff', {
    // AN INSPECTOR, NOT OUTPUT: it opens its own persistent panel (ui/diffinspector.js) and stays until Esc.
    surface: true,
    flashMs: 0,
    desc: 'Inspect what changed — overview by file, Enter for the diff, Esc to close',
    run(app) {
      if (app.ui && app.ui.enabled) {
        app.ui.panel.open(require('./ui/diffinspector').inspector(app));
        app.ui.refresh();
        return;
      }
      const panes = require('./ui/panes');
      const lines = panes.diffView({ checkpoints: app.checkpoints, cwd: app.session && app.session.cwd, width: (app.render && app.render.width) || 80 });
      for (const line of lines) app.render.write(line + '\n');
    },
  });

  define('/changes', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    args: '[files]',
    desc: 'What changed on disk this session — the diff, or `files` for the grouped list',
    run(app, { rest }) {
      // THIS IS WHERE THE DIFF AND FILES PANES WENT.
      const panes = require('./ui/panes');
      const width = (app.render && app.render.width) || 80;
      const cwd = app.session && app.session.cwd;
      const files = panes.changedFiles({ checkpoints: app.checkpoints, cwd });
      if (!files.length) { app.render.write(C.dim('  No changes recorded this session.\n')); return; }

      const wantFiles = /^files?$/i.test(String(rest || '').trim());
      const lines = wantFiles
        ? panes.filesView({ checkpoints: app.checkpoints, cwd, width, tree: app.projectTree ? app.projectTree() : [] })
        : panes.diffView({ checkpoints: app.checkpoints, cwd, width });
      for (const line of lines) app.render.write(line + '\n');
      app.render.write(C.dim(wantFiles
        ? '\n  /changes shows the diff itself · /undo reverts the most recent one.\n'
        : '\n  /changes files groups them by what happened · /undo reverts the most recent one.\n'));
    },
  });
}

module.exports = { register };
