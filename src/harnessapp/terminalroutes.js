'use strict';

/**
 * THE PROJECT TERMINAL, AND THE WAY OUT TO A REAL ONE.
 *
 * ------------------------------------------------------------------------
 * WHAT THE EMBEDDED TERMINAL IS: THE PROJECT'S PROCESSES, INSIDE THE WINDOW.
 *
 * Opening a project must not throw a console window onto the person's desktop.
 * The work runs headlessly under Core; when somebody wants to SEE it, it is a
 * panel in the application — collapsed by default, because a terminal that
 * opens itself is a terminal that takes the screen from the thing you were
 * reading.
 *
 * What it shows is what LAIN already owns for this project: background commands
 * (`run_background`), dev servers and the Workshop's processes, with their
 * output and their state. Every one of those is read from the authority that
 * already has it — `src/jobs.js`, which is what `/ps` reads — so the window and
 * the terminal cannot disagree about what is running.
 *
 * ------------------------------------------------------------------------
 * IT TAKES TYPING, AND THAT IS NOT A SECOND DOOR FOR THE MODEL.
 *
 * `Open shell` starts a real pseudoconsole owned by Core (src/pty.js), and the
 * keystrokes that reach it come from the WINDOW — a person, in a project they
 * already opened, which is the authority they have in any terminal on their own
 * machine.
 *
 * THE MODEL CANNOT REACH IT. No tool writes here; the only way bytes arrive is
 * a keystroke from the renderer. `run_bash` — what the model uses — still goes
 * through `gate.js`, `trust.js`, `permissions.js` and the mutation transaction,
 * unchanged. The value of one door is that there is one door, and this is not
 * one of them.
 *
 * (This panel was read-only when it was first built, and said so here. The
 * interactive shell arrived with the ConPTY bridge; the reasoning above is what
 * replaced the reasoning for keeping it read-only.)
 *
 * STOPPING is offered, because ending something is the direction that is always
 * safe — the same principle bin/lain-control.js is built on.
 *
 * ------------------------------------------------------------------------
 * `OPEN CLI` IS NOT A SECOND COPY OF LAIN INSIDE THE WINDOW.
 *
 * The Desktop conversation IS the LAIN interface. Embedding the LAIN CLI as the
 * project's terminal would give you a window containing a terminal containing
 * LAIN showing the same conversation you are already looking at.
 *
 * So `Open CLI` opens a REAL terminal window, outside the application, running
 * `lain --resume <this session>` in this project. And because two processes must
 * never hold one transcript, Core HANDS THE SESSION OVER first: it refuses while
 * a turn is running here, and otherwise releases it so the terminal is the only
 * writer. See src/sessionpool.js `handover`.
 */

const path = require('path');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400) { return { code, body: { ok: false, why: String(why || 'refused') } }; }

/** How much of one process's output the panel is handed. It scrolls, not logs. */
const TAIL_LINES = 200;

/**
 * THE PROCESSES THIS PROJECT HAS, projected.
 *
 * Read from `app._jobs` — the shell jobs LAIN started — and from the Harness's
 * own service list. Nothing is started, nothing is polled and nothing is
 * inspected on the machine: this is cheap enough to sit behind a panel that is
 * open while somebody watches a build.
 */
function processes(app) {
  const out = [];
  const jobs = app._jobs;
  if (jobs && jobs.all) {
    for (const j of jobs.all()) {
      const s = j.summary ? j.summary() : {};
      out.push({
        id: String(j.id),
        kind: 'command',
        command: String(s.command || j.command || ''),
        state: String(s.state || (j.done ? 'ENDED' : 'RUNNING')),
        code: s.exitCode == null ? null : s.exitCode,
        running: !j.done,
        lines: j.tail ? j.tail(TAIL_LINES) : '',
      });
    }
  }
  // AND THE SERVICES THE HARNESS OWNS — a dev server is a process in this
  // project too, and one that a person most often wants to see the log of.
  try {
    const harness = require('../harnesslink').existing(app);
    const pm = harness && harness.processes;
    for (const p of (pm && pm.list ? pm.list() : [])) {
      const row = p.toJSON ? p.toJSON() : p;
      const proc = pm.get ? pm.get(row.processId) : null;
      out.push({
        id: `svc:${row.processId}`,
        kind: 'service',
        command: String(row.command || row.name || ''),
        state: String(row.status || 'RUNNING'),
        code: row.exitCode == null ? null : row.exitCode,
        running: Boolean(proc && proc.alive),
        port: row.port || null,
        lines: proc && proc.tail ? proc.tail(TAIL_LINES) : '',
      });
    }
  } catch { /* no harness, no services — an empty panel is the true answer */ }
  return out;
}

const ROUTES = {
  /**
   * OPEN A REAL SHELL IN THIS PROJECT.
   *
   * A pseudoconsole, not a command runner — see src/pty.js for why that
   * distinction is the whole feature. Core owns the process; the window sends
   * keystrokes and receives bytes.
   */
  'POST /api/terminal/open': async (app, body = {}) => {
    const r = require('../pty').open(app, {
      cols: Number(body.cols) || 120,
      rows: Number(body.rows) || 30,
    });
    if (!r.ok) return bad(r.why);
    const t = r.terminal;
    return ok({ id: t.id, cwd: t.cwd, shell: t.shell, cols: t.cols, rows: t.rows });
  },

  /**
   * WHAT THE SHELL HAS WRITTEN SINCE `since`.
   *
   * Byte-offset rather than "everything": the panel may have been shut for ten
   * minutes of build output, and re-sending all of it on every poll would make
   * the terminal the most expensive thing in the application.
   */
  'POST /api/terminal/read': async (app, body = {}) => {
    const t = require('../pty').get(app, body.id);
    if (!t) return bad('no such terminal', 404);
    return ok(t.read({ since: Number(body.since) || 0 }));
  },

  /** Keystrokes, verbatim. Base64 so control bytes survive the journey. */
  'POST /api/terminal/input': async (app, body = {}) => {
    const t = require('../pty').get(app, body.id);
    if (!t) return bad('no such terminal', 404);
    if (!t.alive) return bad('that terminal has exited', 409);
    let bytes;
    try { bytes = Buffer.from(String(body.data || ''), 'base64'); } catch { return bad('unreadable input'); }
    t.write(bytes);
    return ok({ id: t.id });
  },

  /** The panel changed size, so the shell must be told. */
  'POST /api/terminal/resize': async (app, body = {}) => {
    const t = require('../pty').get(app, body.id);
    if (!t) return bad('no such terminal', 404);
    t.resize(body.cols, body.rows);
    return ok({ id: t.id, cols: t.cols, rows: t.rows });
  },

  /** Ctrl+C — the command in the shell, not the shell. */
  'POST /api/terminal/interrupt': async (app, body = {}) => {
    const t = require('../pty').get(app, body.id);
    if (!t) return bad('no such terminal', 404);
    t.interrupt();
    return ok({ id: t.id });
  },

  /** End one. The session and the conversation are untouched. */
  'POST /api/terminal/close': async (app, body = {}) => {
    const r = require('../pty').close(app, body.id);
    return r.ok ? ok(r) : bad(r.why, 404);
  },

  /**
   * WHAT IS RUNNING IN THIS PROJECT. Its own route rather than part of
   * `/api/state`, because the output is big and the panel is usually shut —
   * putting it in the poll would ship a build log every 1.5 seconds to nobody.
   */
  'POST /api/terminal/processes': async (app) => ok({
    cwd: app.session.cwd,
    project: path.basename(app.session.cwd || ''),
    processes: processes(app),
    // AND THE SHELLS THIS SESSION HAS OPEN. A person looking at the drawer
    // wants both: what LAIN started, and what they are typing in.
    terminals: require('../pty').list(app),
  }),

  /** STOP ONE. The one direction that is always safe to offer. */
  'POST /api/terminal/stop': async (app, body = {}) => {
    const id = String(body.id || '');
    const jobs = app._jobs;
    const j = jobs && jobs.get ? jobs.get(id) : null;
    if (!j) return bad('that process is not one LAIN is holding', 404);
    j.cancel('you stopped it from the Harness');
    return ok({ stopped: id });
  },

  /**
   * OPEN A REAL LAIN CLI ON THIS SESSION, in a terminal of its own.
   *
   * THE HANDOVER IS THE WHOLE CARE HERE. Two processes on one transcript would
   * be two conversations writing one file, so this refuses while a turn is
   * running in the session and otherwise releases it before the terminal starts.
   */
  'POST /api/desktop/opencli': async (app, body = {}) => {
    if (process.platform !== 'win32') return bad('opening a terminal is Windows-only for now', 501);
    const pool = app.pool();
    const id = String(body.id || app.session.id);
    const live = pool.live(id);
    if (!live) return bad('that session is not open here', 404);
    const cwd = live.session.cwd || app.cwd;
    const short = require('../session').Session.shortId(id);

    if (pool.running(id)) {
      return bad('a turn is running in this session — the terminal would be a second writer on it', 409);
    }
    const hand = pool.handover(id);
    if (!hand.ok) return bad(hand.why, 409);

    const { spawn } = require('child_process');
    const bin = path.join(__dirname, '..', '..', 'bin', 'lain.js');
    // `start` OWNS OPENING A WINDOW on Windows, and is a cmd builtin rather than
    // an executable — hence `cmd /c`. The empty string is `start`'s title
    // argument, which it otherwise takes from the first quoted word and then
    // fails to find a program to run.
    const child = spawn('cmd', ['/c', 'start', '', 'cmd', '/k',
      `"${process.execPath}" "${bin}" --resume ${short}`], {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return ok({ opened: true, session: id, short, cwd });
  },
};

module.exports = { ROUTES, processes, TAIL_LINES };
