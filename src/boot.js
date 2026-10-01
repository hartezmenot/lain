'use strict';

/**
 * BEFORE ANYTHING ELSE RUNS — shared by `noema` (bin/noema.js) and the deprecated `lain` (bin/lain.js).
 *
 *   NOEMA_* → LAIN_*   the canonical environment names are NOEMA_*; the code still reads its historical LAIN_*
 *                      names, so each NOEMA_X is mirrored to LAIN_X (an explicit LAIN_X is left as it is).
 *   THE HOME           LAIN's ~/.lain-v2 moves to ~/.noema once, before any module reads it (home.js).
 *   `lain`             still works — the SAME program, the same home and the same Core — and says once per home
 *                      that it has been renamed.
 */

const fs = require('fs');
const path = require('path');

function aliasEnv(env = process.env) {
  for (const k of Object.keys(env)) {
    if (!k.startsWith('NOEMA_')) continue;
    const legacy = `LAIN_${k.slice(6)}`;
    if (env[legacy] === undefined) env[legacy] = env[k];
  }
  // THE HOME has three spellings; the most specific wins (home.js reads them in the same order).
  if (!env.LAIN_CONFIG_DIR && (env.NOEMA_CONFIG_DIR || env.NOEMA_HOME)) env.LAIN_CONFIG_DIR = env.NOEMA_CONFIG_DIR || env.NOEMA_HOME;
}

function start({ via = 'noema', argv = process.argv.slice(2) } = {}) {
  aliasEnv();
  // THE INSTALLED `lain` IS A ONE-LINE SHIM (`lain.cmd` → noema.exe, distribution/setup.cs) that marks where it came
  // from; it is the same Noema, and the mark is not inherited by anything Noema starts.
  if (process.env.NOEMA_VIA === 'lain') via = 'lain';
  delete process.env.NOEMA_VIA;
  const home = require('./home');
  const pkg = require('../package.json');
  const moved = home.migrate({ version: pkg.version });
  if (moved.state === 'moved') process.stderr.write(`Noema moved your LAIN data to ${moved.to} (the old folder now points there).\n`);
  else if (moved.state === 'deferred' && !argv.includes('--version') && !argv.includes('-v')) process.stderr.write(`note: ${moved.why}\n`);
  if (via === 'lain') {
    const flag = path.join(home.resolve(), 'migrations', 'lain-command-notice');
    if (!fs.existsSync(flag)) {
      process.stderr.write('LAIN has been renamed to Noema.\nThe `lain` command is deprecated; use `noema`.\n');
      try { fs.mkdirSync(path.dirname(flag), { recursive: true }); fs.writeFileSync(flag, new Date().toISOString()); } catch { /* said again next time */ }
    }
  }
  const FORCE_EXIT_GRACE_MS = 3000;
  const finish = (code) => {
    process.exitCode = typeof code === 'number' ? code : 0;
    const t = setTimeout(() => process.exit(process.exitCode), FORCE_EXIT_GRACE_MS);
    if (typeof t.unref === 'function') t.unref();
  };
  // EXIT HYGIENE: see bin/noema.js — process.exit right after a real fetch trips a libuv assertion on Node 24.
  return require('./cli').main(argv).then((code) => finish(code), (err) => {
    process.stderr.write(`noema: fatal: ${err && err.stack ? err.stack : err}\n`);
    finish(1);
  });
}

module.exports = { start, aliasEnv };
