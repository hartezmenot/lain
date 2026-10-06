'use strict';

/** `lain --desktop` — LAIN, started as an application rather than as a terminal. */

const { App } = require('./app');

async function main(opts = {}) {
  const out = (s) => { if (!opts.quiet) process.stdout.write(s); };

  if (process.platform !== 'win32') {
    process.stderr.write('lain: LAIN Desktop is Windows-only for now — run `lain` and use /app browser\n');
    return 2;
  }

  // ---- WHICH WINDOW (packaging pass §D, §E, §M) ------------------------
  // null: the Harness (an installed component); 'dashboard': the Model Dashboard alone; 'preview': the Preview alone.
  const mode = opts.mode === 'dashboard' || opts.mode === 'preview' ? opts.mode : null;
  const section = require('./fabric/dashlaunch').sectionOf(opts.section || 'accounts');
  if (!mode && !require('./components').harness()) { process.stderr.write(`lain: ${require('./components').NOT_INSTALLED}\n`); return 2; }

  // ---- IS THERE ALREADY A LAIN? ----------------------------------------
  const lock = require('./corelock');
  const found = await lock.discover();
  // A DIFFERENT LAIN IS RUNNING (an update was installed while it ran): say so; refuse only a protocol mismatch.
  if (found.running && found.version) {
    const b = require('./update/updater').build();
    const c = require('./update/compat').attach({ version: found.version, protocol: found.protocol }, { version: b.version, protocol: b.protocol });
    if (!c.ok) { process.stderr.write(`lain: ${c.why}\n`); return 2; }
    if (c.note) process.stderr.write(`lain: ${c.note}\n`);
  }
  // THE RUNNING LAIN SHOWS IT (the Harness is preferred when it runs).
  if (found.running && mode) {
    const what = mode === 'dashboard' ? 'Model Dashboard' : 'Preview';
    const r = await lock.ask(mode === 'dashboard' ? 'dashboard:' + section : 'preview');
    if (r && r.ok) { out(`LAIN is running (pid ${found.pid}) — opened its ${what}.\n`); return 0; }
    process.stderr.write(`lain: LAIN is running (pid ${found.pid}) but could not open its ${what}: ${(r && r.why) || 'no answer'}\n`);
    return 1;
  }
  // "OPEN WITH LAIN" / "OPEN FOLDER IN LAIN" (2026-09-29): the running LAIN opens it; there is never a second LAIN.
  if (found.running && opts.open) {
    const r = await lock.ask('open', { path: opts.open });
    if (r && r.ok) { out(`LAIN is already running (pid ${found.pid}) — opened ${r.opened || opts.open}.\n`); return 0; }
    process.stderr.write(`lain: LAIN is running (pid ${found.pid}) but could not open ${opts.open}: ${(r && r.why) || 'no answer'}\n`);
    return 1;
  }
  // STARTED AT SIGN-IN (startup.js, `--startup`): the person's startup choices, read from the one canonical setting.
  const startup = opts.startup ? require('./startup').setting(require('./config').load()) : null;
  if (found.running) {
    // A LAIN IS ALREADY RUNNING (a CLI's Core): the Harness ATTACHES to it — one Core, one session authority.
    const shown = await lock.ask(startup && startup.minimized ? 'show:minimized' : 'show');
    if (shown && shown.ok) {
      out(shown.already
        ? `LAIN is already running (pid ${found.pid}) — its window is in front.\n`
        : `LAIN is already running (pid ${found.pid}) — opened its window.\n`);
      return 0;
    }
    // IT ANSWERED `status` AND REFUSED `show`.
    process.stderr.write(`lain: LAIN is running (pid ${found.pid}) but could not open its window: ${(shown && shown.why) || 'no answer'}\n`);
    return 1;
  }

  // THEN THIS PROCESS IS LAIN
  const resume = opts.resume || (startup && startup.restoreWorkspace ? (require('./session').Session.list(1)[0] || null) : null);
  const app = new App({ cwd: opts.cwd, interactive: false, ...(resume ? { resume } : {}) });
  // STARTED WELL: the launcher keeps a freshly updated Harness only once it reports healthy (update/updater.js).
  try { require('./update/updater').markHealthy(); } catch { /* not started by the launcher */ }
  app._surfaceName = 'harness';   // the writer lease (surfacehandoff.js) names this surface
  // LAIN SERVER, WHEN ASKED TO START WITH LAIN (Settings › Router Server; serve.js). Loopback unless allowed otherwise.
  try { if (app.cfg && app.cfg.server && app.cfg.server.startWithLain) require('./serve').start(app).catch(() => {}); } catch { /* the window comes first */ }

  // ANNOUNCED BEFORE `prepare()`, NOT AFTER.
  try { require('./credentials').prefetchAsync(Object.values((app.cfg && app.cfg.connections) || {}).map((c) => c && c.credentialRef).filter(Boolean)); } catch { /* read when needed */ }
  const held = await lock.announce(app, { surface: 'desktop' });
  if (!held.ok) out(`(LAIN could not claim the single-instance lock: ${held.why})\n`);

  await app.prepare();
  // THE BOT AND THE ASSISTANT'S CLOCK START AFTER THE WINDOW (Phase P, 2026-10-02) — below, queued behind the first-state
  // warm-up desktop.open schedules — so neither stands between a launch and the first paint.
  const background = () => {
    try { require('./assistant/scheduler').start(app); } catch { /* the assistant's clock is not fatal */ }
  };
  // MODELS, LIGHTLY (modelcatalog.js): a provider listing older than a day is re-read once, a minute after start — never blocking.
  try { require('./modelcatalog').scheduleBackground(app); } catch { /* the next start tries again */ }

  if (mode === 'preview') {
    const root = (() => { try { const p = require('./sessionviews').project(app.session); return p.attached && !p.missing ? p.root : null; } catch { return null; } })();
    if (!root) { process.stderr.write('lain: open a project folder first (run lain preview inside it)\n'); await require('./teardown').shutdown(app, { why: 'no project' }); return 2; }
    const f = await require('./workshop').forApp(app).frameOpen(root, {});
    if (!f.ok) { process.stderr.write(`lain: the Preview could not start: ${f.why}\n`); await require('./teardown').shutdown(app, { why: 'preview did not start' }); return 1; }
  }
  // A DEBUGGING PORT ONLY WITH --dev (and the host checks --dev again): LAIN_DESKTOP_DEBUG_PORT lets an acceptance run
  // drive the INSTALLED window itself rather than a build from source. A normal launch never opens one.
  const debugPort = opts.dev ? (Number(process.env.LAIN_DESKTOP_DEBUG_PORT) || 0) : 0;
  const opened = await require('./desktopwindow').open(app, { dev: Boolean(opts.dev), debugPort, mode, section: mode === 'dashboard' ? section : null, minimized: Boolean(startup && startup.minimized) });
  if (!opened.ok && !opened.already) {
    process.stderr.write(`lain: the window did not open: ${opened.why || 'unknown'}\n`);
    await require('./teardown').shutdown(app, { why: 'the desktop did not open' });
    return 1;
  }
  setImmediate(background);
  // THE CLI THAT HOSTED THIS WINDOW CLOSED WITH WORK LEFT (repl.js, `--continue-session`): the same session, taken
  // over through its lease and continued — the same task, plan and checkpoint; no new session, no replayed prompt.
  if (!mode && opts.continueSession && opts.resume) {
    setTimeout(() => {
      try {
        const route = require('./harnessapp/workbenchroutes').ROUTES['POST /api/workbench/continue'];
        Promise.resolve(route(app, {})).catch(() => {});
      } catch { /* the window shows Paused · CLI closed and ▶ Continue */ }
    }, 400);
  }
  // THE HARNESS LOOKS FOR UPDATES (check only — the person chooses Download / Restart from the Update button).
  if (!mode) { try { require('./update/cli').watch(app); } catch { /* updates are optional */ } }
  if (!mode && opts.afterUpdate) { try { require('./update/cli').afterRestart(app); } catch { /* not after an update */ } }
  out(mode === 'dashboard' ? 'The LAIN Model Dashboard is open — close it when you are done.\n'
    : mode === 'preview' ? 'The LAIN Preview is open — close it when you are done.\n'
      : 'LAIN Harness is open. Close the window to keep LAIN running in the tray; Exit LAIN ends it.\n');
  // STARTED BY "OPEN WITH LAIN": the project and the file, now that this LAIN and its window are up.
  if (opts.open) {
    const r = await require('./openpath').open(app, opts.open).catch((e) => ({ ok: false, why: e.message }));
    if (!r.ok) process.stderr.write(`lain: could not open ${opts.open}: ${r.why}\n`);
  }

  // STAY UP UNTIL SOMEBODY SAYS OTHERWISE
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (app.wantExit) { clearInterval(tick); resolve(); return; }
      if (!require('./desktopwindow').alive()) { clearInterval(tick); resolve(); }
    }, 1000);
    const bye = () => { clearInterval(tick); resolve(); };
    process.once('SIGINT', bye);
    process.once('SIGTERM', bye);
  });

  await require('./teardown').shutdown(app, { why: 'LAIN Desktop closed' });
  return app.exitCode || 0;
}

module.exports = { main };
