'use strict';

/**
 * A PATH A SHELL WROTE, READ BY A FILE TOOL — one resolver for every file tool.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT (2026-09-29, a live Coding Agent transcript). On Windows the
 * Agent ran `cargo test > /tmp/p45.log` through run_bash, then asked
 * file_info for `/tmp/p45.log` and was told "no such file". Both were right
 * about their own world: Git Bash maps `/tmp` to the user's temp directory
 * (%TEMP%), and Node resolves a root-relative `/tmp/p45.log` against the
 * CURRENT DRIVE — `D:\tmp\p45.log`. The failure then ended the turn and the
 * task sat paused on a file that existed the whole time.
 *
 * So a file tool resolves the spellings a POSIX shell on Windows produces —
 * `/tmp/…`, `/c/…` (a drive), `~/…` — to where that shell actually put the
 * file, but ONLY when the literal Windows reading does not exist: a project
 * that really has `D:\tmp` keeps it.
 *
 * AND OUTPUT A TASK DEPENDS ON LIVES WITH THE TASK. `$LAIN_SCRATCH` (set on
 * every shell command, see shell.js) is `<project>/.lain/tasks/<task>/logs`:
 * it survives the model's turn, a process restart and a model switch, where
 * `/tmp` survives none of them reliably.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }

/** The Git Bash reading of a POSIX spelling on Windows, or null. */
function posixOnWindows(s) {
  if (process.platform !== 'win32') return null;
  const t = /^\/tmp(?:\/(.*))?$/i.exec(s);
  if (t) return path.join(os.tmpdir(), (t[1] || '').split('/').join(path.sep));
  const d = /^\/([a-z])(?:\/(.*))?$/i.exec(s);
  if (d) return `${d[1].toUpperCase()}:${path.sep}${(d[2] || '').split('/').join(path.sep)}`;
  const h = /^~(?:\/(.*))?$/.exec(s);
  if (h) return path.join(os.homedir(), (h[1] || '').split('/').join(path.sep));
  return null;
}

/** The absolute path a file tool should use for `p`, relative to `cwd`. */
function resolve(cwd, p) {
  const s = String(p || '').trim();
  if (!s) return null;
  const literal = path.isAbsolute(s) ? s : path.resolve(cwd || process.cwd(), s);
  const mapped = posixOnWindows(s);
  if (mapped && !exists(literal) && exists(mapped)) return mapped;
  return literal;
}

/**
 * "no such file" with the one fact that explains it, for a POSIX temp spelling on Windows:
 * where that path was looked for, and where task output belongs instead.
 */
function missing(p) {
  const s = String(p || '');
  const mapped = posixOnWindows(s);
  if (!mapped) return `no such file: ${s}`;
  return `no such file: ${s} — looked in ${mapped} too (run_bash's ${s.split('/')[1] ? `/${s.split('/')[1]}` : s} on Windows). `
    + 'Keep output a later step needs under $LAIN_SCRATCH (it lasts for the whole task), or read the command\'s output directly.';
}

/** The task's durable scratch directory for shell output (created on demand), or null without a project. */
function scratchFor(session) {
  if (!session || !session.cwd) return null;
  try {
    const store = require('../lainstore');
    const taskId = (session.task && session.task.id) || session.id || 'session';
    // lainstore owns every path inside `.lain/` — the task's `logs` area, by its own join.
    const dir = path.dirname(store.taskFile(session.cwd, taskId, 'logs', 'scratch'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch { return null; }
}

module.exports = { resolve, missing, posixOnWindows, scratchFor };
