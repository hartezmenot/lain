'use strict';

/** THE CLI AND UPDATES (packaging pass §I). */

// LAIN_UPDATE_IDLE_MS / LAIN_UPDATE_FIRST_CHECK_MS shorten the waits for the acceptance run; nothing else changes.
const IDLE_MS = Number(process.env.LAIN_UPDATE_IDLE_MS) > 0 ? Number(process.env.LAIN_UPDATE_IDLE_MS) : 60 * 1000;
const FIRST_CHECK_MS = Number(process.env.LAIN_UPDATE_FIRST_CHECK_MS) > 0 ? Number(process.env.LAIN_UPDATE_FIRST_CHECK_MS) : 30 * 1000;

function U() { return require('./updater'); }
function L() { return require('./lifecycle'); }

function say(app, text, tone = 'info') { try { app.render.notice(tone, text); } catch { process.stderr.write(`${text}\n`); } }

/**
 * COMPLETELY IDLE (2026-10-07) — nothing a restart could cost: no model request, no task, no background job or agent
 * (lifecycle.busy), no question, decision or permission open (a panel), no unsent draft, and no keystroke for IDLE_MS.
 */
function idle(app, now = Date.now()) {
  if (L().busy(app)) return false;
  try { if (app.ui && app.ui.panel && app.ui.panel.visible) return false; } catch { /* no UI */ }
  try { if (app.input && String(app.input.line || '').trim()) return false; } catch { /* no input */ }
  if (app._lastInputAt && now - app._lastInputAt < IDLE_MS) return false;
  return true;
}

/**
 * THE CLI UPDATE POLICY (2026-10-07). Checking, downloading, verifying and staging are automatic. Then:
 *   idle      restart into the new version at once — the session resumes (--resume, the launcher's same console)
 *   busy      never interrupted: ONE notice ("installed · restart when the current task finishes"); when the work
 *             reaches an idle boundary, one more ("✓ Update installed · Restart to activate" — /update now · later),
 *             and if the person does nothing and LAIN stays idle, the same automatic restart
 *   later     `/update later` keeps it staged and stops the automatic restart for this session
 */
async function tick(app, { force = false } = {}) {
  const st = app._update || (app._update = { told: null });
  const r = await U().check({ cfg: app.cfg, force }).catch((e) => ({ state: 'error', why: e.message }));
  let status = r;
  if (r.state === 'available' && U().settings(app.cfg).auto && U().installRoot()) {
    const s = await U().stage({ cfg: app.cfg }).catch((e) => ({ ok: false, why: e.message }));
    status = s.ok ? U().status() : { ...r, why: s.why };
  }
  const ux = require('./ux').view(app, { fresh: true });
  if (status.state === 'staged' && U().installRoot() && U().settings(app.cfg).auto) { follow(app, status.staged.version); return status; }
  const key = `${status.state}:${ux.version}`;
  if (ux.label && st.told !== key) {
    st.told = key;
    // AUTOMATIC UPDATES OFF (or a checkout): said once, and nothing restarts by itself.
    say(app, status.state === 'staged'
      ? `${ux.label} — ${L().busy(app) ? '/update after-task (nothing running is stopped)' : '/update now'} · /update later`
      : `${ux.label} — /update to install it${U().installRoot() ? '' : ' (with the LAIN installer)'}`);
    try { if (app.ui && app.ui.enabled) app.ui.refresh(); } catch { /* the header shows it next frame */ }
  }
  return status;
}

/** One staged version, followed to its restart: at most two notices, never a reminder per turn. */
function follow(app, version) {
  const st = app._update || (app._update = {});
  if (st.following === version) return;
  st.following = version;
  if (st.watch) clearInterval(st.watch);
  let saidBusy = false; let saidIdle = false; let quietSince = null;
  const step = () => {
    if (st.later || st.following !== version) { clearInterval(st.watch); return; }
    const now = Date.now();
    if (!idle(app, now)) {
      quietSince = null;
      if (L().busy(app) && !saidBusy && !saidIdle) { saidBusy = true; say(app, `✓ LAIN ${version} installed · restart when the current task finishes`); }
      return;
    }
    if (saidBusy && !saidIdle) { saidIdle = true; say(app, `${require('./ux').INSTALLED} — /update now · /update later (LAIN restarts by itself if you leave it idle)`); quietSince = now; return; }
    if (quietSince == null) quietSince = now;
    // IDLE FROM THE START (or left idle after the notice): the restart is automatic, the session resumes.
    if (!saidBusy || now - quietSince >= IDLE_MS) {
      clearInterval(st.watch);
      if (!saidBusy) say(app, `✓ LAIN ${version} installed — restarting into it (this session continues).`);
      L().perform(app, 'update').catch(() => null);
    }
  };
  st.watch = setInterval(step, 2000);
  if (typeof st.watch.unref === 'function') st.watch.unref();
  step();
}

/** AN INSTALLED LAIN, STARTED: the previous version's idle supervisor makes way (supervisor.js handedOver). */
function handover() {
  if (U().installRoot()) require('../supervisor').retireStale().catch(() => false);
}

/** Called once by an interactive CLI. Timers are unref'd: they never keep LAIN alive. */
function start(app) {
  handover();
  if (!U().installRoot() || process.env.LAIN_NO_UPDATE_CHECK === '1') return null;
  const first = setTimeout(() => tick(app).catch(() => null), FIRST_CHECK_MS);
  const every = setInterval(() => tick(app).catch(() => null), U().CHECK_MS);
  for (const t of [first, every]) if (typeof t.unref === 'function') t.unref();
  return { first, every };
}

/** THE HARNESS: CHECK ONLY. */
function watch(app) {
  handover();
  if (!U().installRoot() || process.env.LAIN_NO_UPDATE_CHECK === '1') return null;
  const check = () => U().check({ cfg: app.cfg }).then(() => { try { require('../harnessapp/ipc').wake(); } catch { /* no window */ } }, () => null);
  const first = setTimeout(check, FIRST_CHECK_MS);
  const every = setInterval(check, U().CHECK_MS);
  for (const t of [first, every]) if (typeof t.unref === 'function') t.unref();
  return { first, every };
}

/** `/update [install|now|after-checkpoint|after-task|later|check]` */
async function command(app, arg = '') {
  const a = String(arg || '').trim().toLowerCase();
  const u = U();
  if (!u.installRoot() && a !== 'check' && a !== '') return 'Updates apply to an installed LAIN — this is a development checkout (node bin/lain.js).';
  if (a === 'later') { L().cancel(app, 'update'); (app._update || (app._update = {})).later = true; return 'Update postponed — it stays downloaded; /update now when you are ready.'; }
  if (a === 'after-checkpoint' || a === 'checkpoint') { const r = L().arm(app, 'update', 'checkpoint'); return r.when === 'now' ? 'Restarting now (nothing is running).' : 'LAIN restarts at the next committed checkpoint; the task continues after it.'; }
  if (a === 'after-task' || a === 'task') { L().arm(app, 'update', 'task'); return 'LAIN restarts when the current task is done.'; }
  if (a === 'install') {
    // INSTALL = download, verify, unpack — nothing restarts (Phase 7). Activating it is a separate choice.
    let st = u.status();
    if (st.state === 'available') { const s = await u.stage({ cfg: app.cfg }); if (!s.ok) return `Update not installed: ${s.why}`; st = u.status(); }
    if (st.state !== 'staged') return st.state === 'current' ? `LAIN ${st.current} is up to date.` : `No update is ready (${st.why || st.state}).`;
    return `${require('./ux').INSTALLED} — ${L().busy(app) ? '/update after-checkpoint or /update after-task (nothing running is stopped)' : '/update now'}.`;
  }
  if (a === 'now' || a === 'restart') {
    let st = u.status();
    if (st.state === 'available') { const s = await u.stage({ cfg: app.cfg }); if (!s.ok) return `Update not installed: ${s.why}`; st = u.status(); }
    if (st.state !== 'staged') return st.state === 'current' ? `LAIN ${st.current} is up to date.` : `No update is ready (${st.why || st.state}).`;
    if (L().busy(app)) return 'Something is working (a turn, a background job or agent) — it is never stopped for an update. /update after-checkpoint or /update after-task.';
    await L().perform(app, 'update');
    return `Restarting into LAIN ${st.staged.version}…`;
  }
  const r = await tick(app, { force: true });
  const b = u.build();
  const head = `LAIN ${b.version} (${b.channel}${b.revision ? `, ${b.revision}` : ''})`;
  if (r.state === 'unconfigured') return `${head} — no update source is configured for this build.`;
  if (r.state === 'error') return `${head} — ${r.why}`;
  if (r.state === 'available') return `${head} — ${require('./ux').availableLabel(r.available.version)}.${u.installRoot() ? ' /update install to download it.' : ' (install it with the LAIN installer)'}`;
  if (r.state === 'staged') return `${head} — ${require('./ux').INSTALLED} (LAIN ${r.staged.version}). ${L().busy(app) ? '/update after-checkpoint or /update after-task — nothing running is stopped.' : '/update now.'}`;
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

/** AFTER THE LAUNCHER RESTARTED INTO A NEW VERSION (`--after-update`): say so, and — when the session had unfinished plan work */
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

module.exports = { start, watch, tick, command, oneShot, afterRestart, idle, follow, IDLE_MS };
