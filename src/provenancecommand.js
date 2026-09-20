'use strict';

/**
 * `/provenance` — §19's runtime-provenance surface, in its own module so the
 * command registry stays below the architecture guard (see tokencommand.js,
 * laincommand.js, compactcommand.js for the same reason).
 */

function register({ define, C }) {
  define('/provenance', {
    flashMs: 0,
    surface: true,
    desc: 'Where the current turn\'s context and task classification came from',
    run(app) {
      app.render.write('\n' + C.bold('Provenance') + '\n');
      for (const [k, v] of require('./provenance').rows(app)) {
        app.render.write('  ' + k.padEnd(26) + v + '\n');
      }
    },
  });
}

module.exports = { register };
