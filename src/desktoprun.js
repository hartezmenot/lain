'use strict';

/**
 * `lain --desktop` — LAIN, started as an application rather than as a terminal.
 *
 * ------------------------------------------------------------------------
 * THIS IS THE ENTRY POINT A SHORTCUT USES.
 *
 * Until now the only way to reach the window was: open a terminal, run `lain`,
 * type `/app`. That makes the application a child of a terminal session, which
 * is precisely what LAIN Desktop is not meant to be. A person double-clicks
 * LAIN; LAIN opens.
 *
 * A SHORTCUT POINTS AT `lain --desktop`, and that is deliberately not a second
 * executable. §16 of the blueprint forbids `lain-cli` / `lain-harness` /
 * `lain-runtime` — one program, one name — and a launcher bin would be that
 * rule broken for a shortcut's convenience, which a shortcut's own arguments
 * already provide.
 *
 * WHAT A SHORTCUT SHOULD POINT AT is `Noema Harness.exe` (src/desktop.js
 * `installLauncher`), which is a `winexe` and starts Core with
 * `CreateNoWindow` — measured: no process in the launched tree has a visible
 * window. A shortcut pointed at npm's generated `lain.cmd` instead is a console
 * program and would show one; that is the reason the launcher exists.
 *
 *              LAIN CORE
 *                  │
 *        ┌─────────┴─────────┐
 *     LAIN CLI          LAIN DESKTOP
 *        │                   │
 *        └──── sessions ─────┘
 *
 * Both are SURFACES. Neither owns the conversation — the session store does,
 * and both read the same one, so a session started in the terminal appears in
 * the window and a session started in the window resumes in the terminal. There
 * is no desktop session database; there is no CLI session database; there is
 * the session directory, and `/resume` and the rail are two readings of it.
 *
 * ------------------------------------------------------------------------
 * IT NEVER BECOMES A SECOND LAIN.
 *
 * First it asks whether this account already has one (src/corelock.js). If it
 * does — a CLI in a terminal, or an earlier launch already in the tray — it
 * sends `show` and exits. The window that opens belongs to the LAIN that was
 * already running, with its sessions, its bots and its work in flight. Two
 * LAINs would be two gateways polling one Telegram token, two supervisors and
 * two writers on one session directory.
 *
 * ------------------------------------------------------------------------
 * THERE IS NO REPL HERE, AND THAT IS THE ONLY DIFFERENCE FROM `lain`.
 *
 * The same `App`, the same turn loop, the same tools, the same gates. What it
 * does not do is read stdin or draw a terminal frame — so it can be launched
 * with no console attached and nothing has to stay open to keep LAIN alive.
 * Questions a turn asks go to the Harness port, which is where a window-started
 * turn's questions already went (harnessapp/sessionroutes.js).
 */

const { App } = require('./app');

/**
 * @param {{cwd?: string, dev?: boolean, quiet?: boolean}} opts
 * @returns {Promise<number>} an exit code
 */
async function main(opts = {}) {
  const out = (s) => { if (!opts.quiet) process.stdout.write(s); };

  if (process.platform !== 'win32') {
    process.stderr.write('noema: Noema Desktop is Windows-only for now — run `noema` and use /app browser\n');
    return 2;
  }

  // ---- WHICH WINDOW (packaging pass §D, §E, §M) ------------------------
  // null: the Harness (an installed component); 'dashboard': the Model Dashboard alone; 'preview': the Preview alone.
  const mode = opts.mode === 'dashboard' || opts.mode === 'preview' ? opts.mode : null;
  const section = require('./fabric/dashlaunch').sectionOf(opts.section || 'accounts');
  if (!mode && !require('./components').harness()) { process.stderr.write(`noema: ${require('./components').NOT_INSTALLED}\n`); return 2; }

  // ---- IS THERE ALREADY A LAIN? ----------------------------------------
  const lock = require('./corelock');
  const found = await lock.discover();
  // A DIFFERENT NOEMA IS RUNNING (an update was installed while it ran): say so; refuse only a protocol mismatch.
  if (found.running && found.version) {
    const b = require('./update/updater').build();
    const c = require('./update/compat').attach({ version: found.version, protocol: found.protocol }, { version: b.version, protocol: b.protocol });
    if (!c.ok) { process.stderr.write(`noema: ${c.why}\n`); return 2; }
    if (c.note) process.stderr.write(`noema: ${c.note}\n`);
  }
  // THE RUNNING NOEMA SHOWS IT (the Harness is preferred when it runs).
  if (found.running && mode) {
    const what = mode === 'dashboard' ? 'Model Dashboard' : 'Preview';
    const r = await lock.ask(mode === 'dashboard' ? 'dashboard:' + section : 'preview');
    if (r && r.ok) { out(`Noema is running (pid ${found.pid}) — opened its ${what}.\n`); return 0; }
    process.stderr.write(`noema: Noema is running (pid ${found.pid}) but could not open its ${what}: ${(r && r.why) || 'no answer'}\n`);
    return 1;
  }
  // "OPEN WITH LAIN" / "OPEN FOLDER IN LAIN" (2026-09-29): the running LAIN opens it; there is never a second LAIN.
  if (found.running && opts.open) {
    const r = await lock.ask('open', { path: opts.open });
    if (r && r.ok) { out(`Noema is already running (pid ${found.pid}) — opened ${r.opened || opts.open}.\n`); return 0; }
    process.stderr.write(`noema: Noema is running (pid ${found.pid}) but could not open ${opts.open}: ${(r && r.why) || 'no answer'}\n`);
    return 1;
  }
  // STARTED AT SIGN-IN (startup.js, `--startup`): the person's startup choices, read from the one canonical setting.
  const startup = opts.startup ? require('./startup').setting(require('./config').load()) : null;
  if (found.running) {
    // A NOEMA IS ALREADY RUNNING (a CLI's Core): the Harness ATTACHES to it — one Core, one session authority.
    const shown = await lock.ask(startup && startup.minimized ? 'show:minimized' : 'show');
    if (shown && shown.ok) {
      out(shown.already
        ? `Noema is already running (pid ${found.pid}) — its window is in front.\n`
        : `Noema is already running (pid ${found.pid}) — opened its window.\n`);
      return 0;
    }
    // IT ANSWERED `status` AND REFUSED `show`. That is a real failure in a real
    // LAIN, and starting a second one on top of it would turn one broken window
    // into two competing instances.
    process.stderr.write(`noema: Noema is running (pid ${found.pid}) but could not open its window: ${(shown && shown.why) || 'no answer'}\n`);
    return 1;
  }

  // ---- THEN THIS PROCESS IS LAIN ---------------------------------------
  //
  // THE SAME PREPARE THE TERMINAL DOES — and then the messaging the person
  // CONNECTED comes back (botconnect.resume). Not "a bot because they opened
  // their application": a channel is resumed only when `enabled` is set, which
  // only an explicit connect sets and disconnect clears. Before this, a
  // connected Telegram bot went silent after every restart — the runtime polls
  // only while a gateway holds its mailbox, and nothing started one. A gateway
  // already running elsewhere (`lain --bot`) is found and left alone.
  // RESTORE THE PREVIOUS WORKSPACE at sign-in (default on): the most recent session and its project.
  const resume = opts.resume || (startup && startup.restoreWorkspace ? (require('./session').Session.list(1)[0] || null) : null);
  const app = new App({ cwd: opts.cwd, interactive: false, ...(resume ? { resume } : {}) });
  // STARTED WELL: the launcher keeps a freshly updated Harness only once it reports healthy (update/updater.js).
  try { require('./update/updater').markHealthy(); } catch { /* not started by the launcher */ }
  app._surfaceName = 'harness';   // the writer lease (surfacehandoff.js) names this surface
  // LAIN SERVER, WHEN ASKED TO START WITH LAIN (Settings › Router Server; serve.js). Loopback unless allowed otherwise.
  try { if (app.cfg && app.cfg.server && app.cfg.server.startWithLain) require('./serve').start(app).catch(() => {}); } catch { /* the window comes first */ }

  // ANNOUNCED BEFORE `prepare()`, NOT AFTER. Two launches close enough together
  // both pass `discover()` and both reach here — that race cannot be closed
  // from this side, only shortened — but leaving the lock for AFTER `prepare()`
  // held it open for however long that took, which is exactly the gap that let
  // a second launch decide it was first too and spawn a second window. `pipe`
  // and `handle()`'s status/quit verbs need nothing this app has not set in its
  // constructor; only `show` reaches `desktop.open`, and by the time another
  // process's request actually arrives over the pipe, round-tripped through a
  // fresh OS process launch, `prepare()` below has already finished.
  // THE KEYS, READ WHILE THE REST STARTS (Phase 8.2): the window's first listing finds them warm.
  try { require('./credentials').prefetchAsync(Object.values((app.cfg && app.cfg.connections) || {}).map((c) => c && c.credentialRef).filter(Boolean)); } catch { /* read when needed */ }
  const held = await lock.announce(app, { surface: 'desktop' });
  if (!held.ok) out(`(Noema could not claim the single-instance lock: ${held.why})\n`);

  await app.prepare();
  require('./botconnect').resume(app).catch(() => {});
  try { require('./assistant/scheduler').start(app); } catch { /* the assistant's clock is not fatal */ }
  // MODELS, LIGHTLY (modelcatalog.js): a provider listing older than a day is re-read once, a minute after start — never blocking.
  try { require('./modelcatalog').scheduleBackground(app); } catch { /* the next start tries again */ }

  if (mode === 'preview') {
    const root = (() => { try { const p = require('./sessionviews').project(app.session); return p.attached && !p.missing ? p.root : null; } catch { return null; } })();
    if (!root) { process.stderr.write('noema: open a project folder first (run noema preview inside it)\n'); await require('./teardown').shutdown(app, { why: 'no project' }); return 2; }
    const f = await require('./workshop').forApp(app).frameOpen(root, {});
    if (!f.ok) { process.stderr.write(`noema: the Preview could not start: ${f.why}\n`); await require('./teardown').shutdown(app, { why: 'preview did not start' }); return 1; }
  }
  const opened = await require('./desktopwindow').open(app, { dev: Boolean(opts.dev), mode, section: mode === 'dashboard' ? section : null, minimized: Boolean(startup && startup.minimized) });
  if (!opened.ok && !opened.already) {
    process.stderr.write(`noema: the window did not open: ${opened.why || 'unknown'}\n`);
    await require('./teardown').shutdown(app, { why: 'the desktop did not open' });
    return 1;
  }
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
  out(mode === 'dashboard' ? 'The Noema Model Dashboard is open — close it when you are done.\n'
    : mode === 'preview' ? 'The Noema Preview is open — close it when you are done.\n'
      : 'Noema Harness is open. Close the window to keep Noema running in the tray; Exit Noema ends it.\n');
  // STARTED BY "OPEN WITH LAIN": the project and the file, now that this LAIN and its window are up.
  if (opts.open) {
    const r = await require('./openpath').open(app, opts.open).catch((e) => ({ ok: false, why: e.message }));
    if (!r.ok) process.stderr.write(`noema: could not open ${opts.open}: ${r.why}\n`);
  }

  // ---- STAY UP UNTIL SOMEBODY SAYS OTHERWISE ---------------------------
  //
  // CORE OUTLIVES THE WINDOW ON PURPOSE. Closing the window hides it to the
  // tray (native/host.cs); the bots stay connected and background work carries
  // on. What ends LAIN is an explicit Quit — from the tray, or from a `quit` on
  // the control pipe — and both go through src/teardown.js.
  //
  // The window host EXITING is a different matter: if the process is gone, so is
  // the tray icon, and there is nothing left to restore LAIN from. That is the
  // one thing that ends this wait on its own.
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (app.wantExit) { clearInterval(tick); resolve(); return; }
      if (!require('./desktopwindow').alive()) { clearInterval(tick); resolve(); }
    }, 1000);
    const bye = () => { clearInterval(tick); resolve(); };
    process.once('SIGINT', bye);
    process.once('SIGTERM', bye);
  });

  await require('./teardown').shutdown(app, { why: 'Noema Desktop closed' });
  return app.exitCode || 0;
}

module.exports = { main };
