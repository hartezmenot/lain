'use strict';

/** THE PROJECT TERMINAL, AND THE WAY OUT TO A REAL ONE. */

const path = require('path');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400) { return { code, body: { ok: false, why: String(why || 'refused') } }; }

/** How much of one process's output the panel is handed. It scrolls, not logs. */
const TAIL_LINES = 200;

/** THE PROCESSES THIS PROJECT HAS, projected. */
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
  /** OPEN A REAL SHELL IN THIS PROJECT. */
  'POST /api/terminal/open': async (app, body = {}) => {
    const r = require('../pty').open(app, {
      cols: Number(body.cols) || 120,
      rows: Number(body.rows) || 30,
    });
    if (!r.ok) return bad(r.why);
    const t = r.terminal;
    return ok({ id: t.id, cwd: t.cwd, shell: t.shell, cols: t.cols, rows: t.rows });
  },

  /** WHAT THE SHELL HAS WRITTEN SINCE `since`. */
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

  /** WHAT IS RUNNING IN THIS PROJECT. */
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

  /** OPEN A REAL LAIN CLI ON THIS SESSION, in a terminal of its own. */
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
    // `start` OWNS OPENING A WINDOW on Windows, and is a cmd builtin rather than an executable — hence `cmd /c`.
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
