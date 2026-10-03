'use strict';

/**
 * `App.once`, verbatim, except that the input arrives the way a terminal
 * delivers a PASTE: `handle(text, { isPaste })`. `lain -p` submits typed text,
 * which never reaches the paste path — and the paste path is where the
 * Toralink brief was misclassified (2026-09-24).
 *
 *   node runner.js <promptFile> <paste: 1|0>
 *
 * `DIAG_LAIN_ROOT` runs another LAIN tree (a pre-fix baseline copy, say).
 */

const fs = require('fs');
const path = require('path');

const LAIN = process.env.DIAG_LAIN_ROOT || path.join(__dirname, '..', '..', '..', '..');
const text = fs.readFileSync(process.argv[2], 'utf8');
const isPaste = process.argv[3] === '1';

(async () => {
  const { App } = require(path.join(LAIN, 'src/app'));
  const { Session } = require(path.join(LAIN, 'src/session'));
  const app = new App({ cwd: process.cwd(), interactive: false });
  app.interactive = false;
  await app.prepare();
  try {
    await app.handle(text, { isPaste });
  } finally {
    await require(path.join(LAIN, 'src/harnesslink')).shutdown(app);
    require(path.join(LAIN, 'src/workerruntime')).settle(app);
  }
  try { app.session.save(); } catch { /* best effort */ }
  process.stdout.write(`\n  session ${app.session.id}  ·  resume with: lain --resume ${Session.shortId(app.session.id)}\n`);
  process.exitCode = app.exitCode || 0;
  const t = setTimeout(() => process.exit(process.exitCode), 3000);
  t.unref();
})().catch((e) => { process.stderr.write(`runner fatal: ${(e && e.stack) || e}\n`); process.exitCode = 1; });
