'use strict';

/** THE DESKTOP CONTROL WINDOW — a second window, on top, while LAIN has control. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/** How often LAIN looks for a STOP from the window. */
const POLL_MS = 400;

let child = null;
let timer = null;

function dir() {
  const base = (() => {
    try { return require('./config').configDir(); } catch { return require('./home').resolve(); }
  })();
  return path.join(base, 'control');
}

function statePath() { return path.join(dir(), 'state.json'); }
function revokePath() { return path.join(dir(), 'revoke'); }

/** What the window draws. Written on every change; read on a timer over there. */
function write(app) {
  let status;
  try { status = app.desktop().bridge.status(); } catch { return false; }
  const perms = status.permissions || { capabilities: {} };
  const payload = {
    at: Date.now(),
    pid: process.pid,
    project: require('./ui/text').projectName(app.session.cwd),
    bridge: { state: status.state, name: status.name, reason: status.reason || null },
    target: status.target || null,
    active: Boolean(perms.active),
    capabilities: perms.capabilities || {},
    activity: (status.activity || []).slice(-8).map((a) => ({ text: a.text, ok: a.ok })),
  };
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = statePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, statePath());
    return true;
  } catch { return false; }
}

/** Has the user pressed STOP in the control window? */
function stopRequested() {
  try { return fs.existsSync(revokePath()); } catch { return false; }
}

function clearStop() {
  try { fs.unlinkSync(revokePath()); } catch { /* already gone */ }
}

/** Open the window (if it is not already open) and keep it fed. */
function open(app) {
  clearStop();
  write(app);
  if (!child) {
    const viewer = path.join(__dirname, '..', 'bin', 'lain-control.js');
    try {
      child = process.platform === 'win32'
        // `start` gives it a console window of its own.
        ? spawn('cmd', ['/c', 'start', '', process.execPath, viewer, dir()], { detached: true, stdio: 'ignore' })
        : spawn(process.execPath, [viewer, dir()], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) {
      child = null;
      app.render.notice('warn',
        `could not open the desktop control window (${e.message}). `
        + '/mcp revoke in this terminal is the stop button until it can.');
    }
  }
  if (!timer) {
    timer = setInterval(() => {
      write(app);
      if (!stopRequested()) return;
      clearStop();
      const had = app.desktop().permissions.revoke('you pressed STOP in the control window');
      app.render.notice('warn', had.length
        ? `DESKTOP CONTROL REVOKED from the control window — ${had.join(', ')}`
        : 'desktop control stopped from the control window');
      if (app.ui && app.ui.enabled) app.ui.refresh();
      write(app);
    }, POLL_MS);
    if (timer.unref) timer.unref();
  }
  return Boolean(child);
}

/** Refresh what the window shows. Cheap; safe to call on every change. */
function update(app) { return write(app); }

/** Stop watching. The window itself notices and says CONTROL ENDED. */
function close(app = null) {
  if (timer) { clearInterval(timer); timer = null; }
  if (app) write(app);
  child = null;
  return true;
}

module.exports = { open, update, close, write, stopRequested, clearStop, dir, statePath, revokePath, POLL_MS };
