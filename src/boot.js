'use strict';

/** BEFORE ANYTHING ELSE RUNS — `lain` (bin/lain.js), the one command. */

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
  // (The Noema-era `noema` command and its LAIN_VIA mark are retired — 2026-10-07. A stale mark is not inherited.)
  delete process.env.LAIN_VIA; delete process.env.NOEMA_VIA;
  const home = require('./home');
  const pkg = require('../package.json');
  // THE OLD HOME'S OWN SUPERVISOR is stopped first (verified by ping), so the one-time move is not deferred forever.
  const from = home.pendingMove();
  const ready = from ? require('./supervisor').shutdownIn(from, { timeoutMs: 4000 }).catch(() => null) : Promise.resolve();
  return ready.then(() => afterMove(home, pkg, via, argv));
}

/**
 * HOUSEKEEPING, once per start and off the first frame's path (2026-10-06): leases of LAIN processes that are all gone,
 * and diagnostic traces past their retention (14 days). Records of the past are not kept forever by default.
 */
function housekeeping(home) {
  setTimeout(() => {
    try { require('./runtimeregistry').pruneDead(); } catch { /* next start */ }
    try {
      const dir = path.join(home.resolve(), 'reqtrace');
      const cutoff = Date.now() - 14 * 864e5;
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try { if (f.endsWith('.jsonl') && fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* in use */ }
      }
    } catch { /* no traces */ }
  }, 2000).unref();
}

function afterMove(home, pkg, via, argv) {
  const moved = home.migrate({ version: pkg.version });
  housekeeping(home);
  if (moved.state === 'moved') process.stderr.write(`LAIN moved your data to ${moved.to} .\n`);
  else if (moved.state === 'deferred' && !argv.includes('--version') && !argv.includes('-v')) process.stderr.write(`note: ${moved.why}\n`);
  const FORCE_EXIT_GRACE_MS = 3000;
  const finish = (code) => {
    // A RESTART FOR AN UPDATE (update/lifecycle.js) already chose the code the launcher acts on; main ending is not a reason to drop it.
    if (process.exitCode !== require('./update/updater').RESTART_CODE) process.exitCode = typeof code === 'number' ? code : 0;
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
