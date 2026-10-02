'use strict';

/**
 * THE CLI AND UPDATES (packaging pass §I). One updater (updater.js); this is only the CLI's policy over it.
 *
 *   CHECK      once, 30 s after an interactive CLI starts, then at most every six hours (cached) — never a loop.
 *   STAGE      download + verify + unpack in the background, independent of whatever task is running.
 *   IDLE       no turn running and nothing typed for a minute → "LAIN X is ready — restarting; your session
 *              continues" → the launcher restarts into it, same terminal, same session.
 *   BUSY       the Coding Agent is working → never interrupted. Once: "LAIN X installed and ready. Restart to
 *              update." — and by default it restarts AFTER THE TASK (lifecycle.arm 'task'). The person can choose:
 *              /update now · /update after-checkpoint · /update after-task · /update later.
 */

// LAIN_UPDATE_IDLE_MS / LAIN_UPDATE_FIRST_CHECK_MS shorten the waits for the acceptance run; nothing else changes.
const IDLE_MS = Number(process.env.LAIN_UPDATE_IDLE_MS) > 0 ? Number(process.env.LAIN_UPDATE_IDLE_MS) : 60 * 1000;
const FIRST_CHECK_MS = Number(process.env.LAIN_UPDATE_FIRST_CHECK_MS) > 0 ? Number(process.env.LAIN_UPDATE_FIRST_CHECK_MS) : 30 * 1000;

function U() { return require('./updater'); }
function L() { return require('./lifecycle'); }

function say(app, text, tone = 'info') { try { app.render.notice(tone, text); } catch { process.stderr.write(`${text}\n`); } }

function idle(app) { return !L().busy(app) && Date.now() - (app._lastInputAt || 0) > IDLE_MS; }

async function tick(app, { force = false } = {}) {
  const st = app._update || (app._update = { told: null });
  const r = await U().check({ cfg: app.cfg, force }).catch((e) => ({ state: 'error', why: e.message }));
  let status = r;
  if (r.state === 'available' && U().settings(app.cfg).auto && U().installRoot()) {
    const s = await U().stage({ cfg: app.cfg }).catch((e) => ({ ok: false, why: e.message }));
    status = s.ok ? U().status() : { ...r, why: s.why };
  }
  if (status.state !== 'staged') return status;
  const v = status.staged.version;
  if (idle(app)) {
    say(app, `LAIN ${v} is ready — restarting now; this session continues.`);
    await L().perform(app, 'update');
    return status;
  }
  if (st.told !== v) {
    st.told = v;
    if (!L().pending(app, 'update')) L().arm(app, 'update', L().busy(app) ? 'task' : 'checkpoint');
    say(app, `LAIN ${v} installed and ready. Restart to update — it restarts after the current task (/update now · /update after-checkpoint · /update later).`);
  }
  return status;
}

/** Called once by an interactive CLI. Timers are unref'd: they never keep LAIN alive. */
function start(app) {
  if (!U().installRoot() || process.env.LAIN_NO_UPDATE_CHECK === '1') return null;
  const first = setTimeout(() => tick(app).catch(() => null), FIRST_CHECK_MS);
  const every = setInterval(() => tick(app).catch(() => null), U().CHECK_MS);
  for (const t of [first, every]) if (typeof t.unref === 'function') t.unref();
  return { first, every };
}

/**
 * THE HARNESS: CHECK ONLY. The window's Update button (beside Usage) appears when the check finds a release; the
 * person downloads and restarts from there (harnessapp/updateroutes.js) — a graphical session is never restarted
 * or even downloaded into by itself. Same cadence, same unref'd timers.
 */
function watch(app) {
  if (!U().installRoot() || process.env.LAIN_NO_UPDATE_CHECK === '1') return null;
  const check = () => U().check({ cfg: app.cfg }).then(() => { try { require('../harnessapp/ipc').wake(); } catch { /* no window */ } }, () => null);
  const first = setTimeout(check, FIRST_CHECK_MS);
  const every = setInterval(check, U().CHECK_MS);
  for (const t of [first, every]) if (typeof t.unref === 'function') t.unref();
  return { first, every };
}

/** `/update [now|after-checkpoint|after-task|later|check]` */
async function command(app, arg = '') {
  const a = String(arg || '').trim().toLowerCase();
  const u = U();
  if (!u.installRoot() && a !== 'check' && a !== '') return 'Updates apply to an installed LAIN — this is a development checkout (node bin/lain.js).';
  if (a === 'later') { L().cancel(app, 'update'); return 'Update postponed — it stays downloaded; /update now when you are ready.'; }
  if (a === 'after-checkpoint' || a === 'checkpoint') { const r = L().arm(app, 'update', 'checkpoint'); return r.when === 'now' ? 'Restarting now (nothing is running).' : 'LAIN restarts at the next committed checkpoint; the task continues after it.'; }
  if (a === 'after-task' || a === 'task') { L().arm(app, 'update', 'task'); return 'LAIN restarts when the current task is done.'; }
  if (a === 'now' || a === 'restart' || a === 'install') {
    let st = u.status();
    if (st.state === 'available') { const s = await u.stage({ cfg: app.cfg }); if (!s.ok) return `Update not installed: ${s.why}`; st = u.status(); }
    if (st.state !== 'staged') return st.state === 'current' ? `LAIN ${st.current} is up to date.` : `No update is ready (${st.why || st.state}).`;
    if (L().busy(app)) return 'The Coding Agent is working. /update after-checkpoint or /update after-task — or stop the task first.';
    await L().perform(app, 'update');
    return `Restarting into LAIN ${st.staged.version}…`;
  }
  const r = await tick(app, { force: true });
  const b = u.build();
  const head = `LAIN ${b.version} (${b.channel}${b.revision ? `, ${b.revision}` : ''})`;
  if (r.state === 'unconfigured') return `${head} — no update source is configured for this build.`;
  if (r.state === 'error') return `${head} — ${r.why}`;
  if (r.state === 'available') return `${head} — LAIN ${r.available.version} is available.${u.installRoot() ? '' : ' (install it with the LAIN installer)'}`;
  if (r.state === 'staged') return `${head} — LAIN ${r.staged.version} is downloaded and ready. /update now to restart into it.`;
  return `${head} — up to date.`;
}

/** `lain update [--check]` from a shell: nothing is running, so a verified update is switched to directly. */
async function oneShot(args = []) {
  const u = U();
  const cfg = (() => { try { return require('../config').load(); } catch { return {}; } })();
  const r = await u.check({ cfg, force: true });
  const b = u.build();
  if (args.includes('--check') || r.state === 'current' || r.state === 'unconfigured' || r.state === 'error') {
    process.stdout.write(`LAIN ${b.version} (${b.channel}) — ${r.state === 'available' ? `LAIN ${r.available.version} is available` : r.state === 'staged' ? `LAIN ${r.staged.version} is downloaded` : r.state === 'current' ? 'up to date' : r.why}\n`);
    return r.state === 'error' ? 1 : 0;
  }
  if (!u.installRoot()) { process.stdout.write('Updates apply to an installed LAIN — this is a development checkout.\n'); return 1; }
  const s = r.state === 'available' ? await u.stage({ cfg }) : { ok: true };
  if (!s.ok) { process.stdout.write(`Update not installed: ${s.why}\n`); return 1; }
  const a = u.apply({ args: ['--version'], cwd: process.cwd() });
  if (!a.ok) { process.stdout.write(`Update not installed: ${a.why}\n`); return 1; }
  try { require('fs').unlinkSync(require('path').join(u.installRoot(), 'restart.json')); } catch { /* none */ }
  process.stdout.write(`LAIN ${a.version} installed (from ${a.from || b.version}). It starts the next time you run lain; ${a.from || b.version} is kept for rollback.\n`);
  return 0;
}

/**
 * AFTER THE LAUNCHER RESTARTED INTO A NEW VERSION (`--after-update`): say so, and — when the session had unfinished
 * plan work (it was paused at a committed checkpoint for the restart) — continue it from that checkpoint, the same way
 * ▶ Continue does. The position is the durable commit, so the task resumes exactly where it stopped.
 */
function afterRestart(app) {
  const b = U().build();
  const st = U().readState();
  const from = st.applied && st.applied.from;
  say(app, `Updated to LAIN ${b.version}${from ? ` (from ${from})` : ''}.`);
  const s = app.session;
  let unfinished = false;
  try { unfinished = require('../surfacehandoff').unfinished(s); } catch { unfinished = false; }
  if (!s || !s.plan || !unfinished) return { continued: false };
  const t = setTimeout(() => { require('../continueactions').planContinue(app).catch(() => null); }, 1500);
  if (typeof t.unref === 'function') t.unref();
  return { continued: true };
}

module.exports = { start, watch, tick, command, oneShot, afterRestart, IDLE_MS };
