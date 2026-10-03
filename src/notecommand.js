'use strict';

/** `/note` — WRITE IT DOWN BEFORE YOU FORGET IT. */

/** rather than imported back, so this is not a second dispatch path. */
function register({ define, C }) {
  define('/note', {
    // MACHINERY by the registry's test — it is about the project rather than
    // about the running task, so it belongs on the surface panel.
    surface: true,
    flashMs: 0,
    args: '[decision|fact|limitation|source-of-truth] <what you noticed>  ·  drop <id>',
    desc: 'Keep a RUNTIME NOTE — survives compaction/restart, this machine only (not project truth)',
    run(app, { rest }) {
      const memory = require('./memory');
      const root = (app.session && app.session.cwd) || process.cwd();
      const raw = String(rest || '').trim();

      if (!raw) return list(app, memory, root, C);

      const words = raw.split(/\s+/);
      const first = words[0].toLowerCase();

      if (first === 'drop' && words[1]) {
        const r = memory.drop(root, words[1]);
        app.render.write(r.ok ? C.dim(`  dropped ${words[1]}\n`) : C.yellow(`  ${r.why}\n`));
        return;
      }

      // A LEADING KIND WORD IS A KIND; anything else is the note itself. That
      // way the common case — just typing the thought — needs no syntax at all.
      const kinds = Object.values(memory.KIND);
      const isKind = kinds.includes(first);
      const kind = isKind ? first : memory.KIND.NOTE;
      const text = isKind ? words.slice(1).join(' ') : raw;

      const r = memory.add(root, text, { kind });
      if (!r.ok) { app.render.write(C.yellow(`  ${r.why}\n`)); return; }
      if (r.duplicate) {
        app.render.write(C.dim(`  already remembered as ${r.item.id}\n`));
        return;
      }
      app.render.write(
        `  ${C.green('kept')} ${C.dim(r.item.id)}  ${C.bold(kind.toUpperCase())}  ${r.item.text}\n`,
      );
      // WHETHER IT WILL ACTUALLY SURVIVE is the one thing worth saying: a note that silently failed to reach disk is worse than no note, because the user…
      app.render.write(C.dim(r.persisted
        ? '  It will still be here after a restart.\n'
        : '  NOT saved to disk — it will not survive this session.\n'));
    },
  });
}

/** What is remembered — THE MEMORY PANE, drawn here. */
function list(app, memory, root, C) {
  const width = (app.render && app.render.width) || 80;
  for (const line of require('./ui/memoryview').render({ root, width })) {
    app.render.write(line + '\n');
  }
}

module.exports = { register, list };
