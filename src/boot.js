'use strict';

/**
 * BEFORE ANYTHING ELSE RUNS — shared by `lain` (bin/lain.js) and the compatibility `noema` (bin/noema.js).
 *
 *   LAIN_*             the canonical environment names. A Noema-era NOEMA_X is mirrored to LAIN_X for the transition
 *                      (an explicit LAIN_X always wins), so old scripts keep working and no code reads NOEMA_*.
 *   THE HOME           the Noema-era ~/.noema (or an unmoved ~/.lain-v2) moves to ~/.lain once, before any module
 *                      reads it (home.js) — one rename, a junction at the old path, never a second home.
 *   `noema`            still works for a transition period — the SAME program, the same home, the same sessions and
 *                      the same Core — and says once per home that the product is called LAIN again.
 */

const fs = require('fs');
const path = require('path');

function aliasEnv(env = process.env) {
  for (const k of Object.keys(env)) {
    if (!k.startsWith('NOEMA_')) continue;
    const canon = `LAIN_${k.slice(6)}`;
    if (env[canon] === undefined) env[canon] = env[k];
  }
  // THE HOME has several spellings; the most specific wins (home.js reads them in the same order).
  if (!env.LAIN_CONFIG_DIR && (env.LAIN_HOME || env.NOEMA_CONFIG_DIR || env.NOEMA_HOME)) env.LAIN_CONFIG_DIR = env.LAIN_HOME || env.NOEMA_CONFIG_DIR || env.NOEMA_HOME;
}

function start({ via = 'lain', argv = process.argv.slice(2) } = {}) {
  aliasEnv();
  // THE INSTALLED `noema` IS A ONE-LINE SHIM (`noema.cmd` → lain.exe, distribution/setup.cs) that marks where it came
  // from; it is the same LAIN, and the mark is not inherited by anything LAIN starts.
  if (process.env.LAIN_VIA === 'noema' || process.env.NOEMA_VIA === 'noema') via = 'noema';
  delete process.env.LAIN_VIA; delete process.env.NOEMA_VIA;
  const home = require('./home');
  const pkg = require('../package.json');
  // THE OLD HOME'S OWN SUPERVISOR is stopped first (verified by ping), so the one-time move is not deferred forever.
  const from = home.pendingMove();
  const ready = from ? require('./supervisor').shutdownIn(from, { timeoutMs: 4000 }).catch(() => null) : Promise.resolve();
  return ready.then(() => afterMove(home, pkg, via, argv));
}

function afterMove(home, pkg, via, argv) {
  const moved = home.migrate({ version: pkg.version });
  if (moved.state === 'moved') process.stderr.write(`LAIN moved your data to ${moved.to} (the old folder now points there).\n`);
  else if (moved.state === 'deferred' && !argv.includes('--version') && !argv.includes('-v')) process.stderr.write(`note: ${moved.why}\n`);
  if (via === 'noema') {
    const flag = path.join(home.resolve(), 'migrations', 'noema-command-notice');
    if (!fs.existsSync(flag)) {
      process.stderr.write('Noema has been renamed back to LAIN.\nUse `lain` for future commands (`noema` keeps working for now).\n');
      try { fs.mkdirSync(path.dirname(flag), { recursive: true }); fs.writeFileSync(flag, new Date().toISOString()); } catch { /* said again next time */ }
    }
  }
  const FORCE_EXIT_GRACE_MS = 3000;
  const finish = (code) => {
    process.exitCode = typeof code === 'number' ? code : 0;
    const t = setTimeout(() => process.exit(process.exitCode), FORCE_EXIT_GRACE_MS);
    if (typeof t.unref === 'function') t.unref();
  };
  // EXIT HYGIENE: see bin/lain.js — process.exit right after a real fetch trips a libuv assertion on Node 24.
  return require('./cli').main(argv).then((code) => finish(code), (err) => {
    process.stderr.write(`lain: fatal: ${err && err.stack ? err.stack : err}\n`);
    finish(1);
  });
}

module.exports = { start, aliasEnv };
