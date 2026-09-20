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
 * WHAT A SHORTCUT SHOULD POINT AT is `LAIN.exe` (src/desktop.js
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
    process.stderr.write('lain: LAIN Desktop is Windows-only for now — run `lain` and use /app browser\n');
    return 2;
  }

  // ---- IS THERE ALREADY A LAIN? ----------------------------------------
  const lock = require('./corelock');
  const found = await lock.discover();
  if (found.running) {
    const shown = await lock.ask('show');
    if (shown && shown.ok) {
      out(shown.already
        ? `LAIN is already running (pid ${found.pid}) — its window is in front.\n`
        : `LAIN is already running (pid ${found.pid}) — opened its window.\n`);
      return 0;
    }
    // IT ANSWERED `status` AND REFUSED `show`. That is a real failure in a real
    // LAIN, and starting a second one on top of it would turn one broken window
    // into two competing instances.
    process.stderr.write(`lain: LAIN is running (pid ${found.pid}) but could not open its window: ${(shown && shown.why) || 'no answer'}\n`);
    return 1;
  }

  // ---- THEN THIS PROCESS IS LAIN ---------------------------------------
  //
  // THE SAME PREPARE THE TERMINAL DOES, and deliberately nothing more. In
  // particular this does NOT start the messaging gateway: LAIN has never
  // autostarted one — `/bot` and `lain --bot` start it, and it runs as its own
  // process discovered through its own lock file (src/bot/service.js). So a
  // gateway that was already running is still running and is reached the same
  // way; one that was not is not started by opening a window. Inventing an
  // autostart here would be a new behaviour wearing the clothes of a launch
  // path, and it would connect a person's bot because they opened their
  // application.
  const app = new App({ cwd: opts.cwd, interactive: false });

  // ANNOUNCED BEFORE `prepare()`, NOT AFTER. Two launches close enough together
  // both pass `discover()` and both reach here — that race cannot be closed
  // from this side, only shortened — but leaving the lock for AFTER `prepare()`
  // held it open for however long that took, which is exactly the gap that let
  // a second launch decide it was first too and spawn a second window. `pipe`
  // and `handle()`'s status/quit verbs need nothing this app has not set in its
  // constructor; only `show` reaches `desktop.open`, and by the time another
  // process's request actually arrives over the pipe, round-tripped through a
  // fresh OS process launch, `prepare()` below has already finished.
  const held = await lock.announce(app, { surface: 'desktop' });
  if (!held.ok) out(`(LAIN could not claim the single-instance lock: ${held.why})\n`);

  await app.prepare();

  const opened = await require('./desktopwindow').open(app, { dev: Boolean(opts.dev) });
  if (!opened.ok && !opened.already) {
    process.stderr.write(`lain: the desktop did not open: ${opened.why || 'unknown'}\n`);
    await require('./teardown').shutdown(app, { why: 'the desktop did not open' });
    return 1;
  }
  out('LAIN Desktop is open. Close the window to send LAIN to the system tray; quit from the tray icon.\n');

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

  await require('./teardown').shutdown(app, { why: 'LAIN Desktop closed' });
  return app.exitCode || 0;
}

module.exports = { main };
