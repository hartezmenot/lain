'use strict';

/** `/compact`: the cheap model writes the structured summary; the history becomes it plus the last exchanges (S8). */
function register({ define, DURING_TURN, C, FLASH_MS }) {
  define('/compact', {
    flashMs: FLASH_MS,   // a receipt, not an inspector - see FLASH_MS
    surface: true,
    duringTurn: DURING_TURN.BLOCKED,
    desc: 'Summarise the conversation so far and keep the last exchanges (a cheap model call)',
    async run(app) {
      const r = await require('./compactor').maybe(app.session, require('./sessionviews').turnCfg(app, app.session), { force: true });
      app.render.write((r ? `  ${require('./compactor').line(r)}` : C.dim('  Nothing to compact yet (or the summary could not be written).')) + '\n');
    },
  });
}

module.exports = { register };
