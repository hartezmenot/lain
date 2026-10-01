'use strict';

/**
 * WHERE IS NODE — asked properly, because the answer is not always on PATH.
 *
 * ------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO END.
 *
 * LAIN Desktop is launched from a shortcut, the Start menu, or a double-click.
 * None of those inherit the PATH a developer has in their terminal: Explorer
 * hands a process the SYSTEM and USER PATH as they were when Explorer started,
 * which on a machine where Node was installed after login, or installed for a
 * different user, or installed by a version manager that edits a shell profile
 * rather than the registry, does not contain Node at all.
 *
 * So `spawn('node', …)` fails with ENOENT and the person is shown "a node
 * error" about a program they can see in `C:\Program Files\nodejs`. That is the
 * worst kind of error: true, useless, and indistinguishable from LAIN being
 * broken.
 *
 * ------------------------------------------------------------------------
 * THE ORDER, AND WHY EACH STEP IS WHERE IT IS.
 *
 *   1. THE NODE ALREADY RUNNING THIS CODE. `process.execPath` is not a guess —
 *      it is the interpreter that got here, it certainly exists, and it is
 *      certainly capable of running LAIN because it is running LAIN. Anything
 *      else is a worse answer to the same question.
 *   2. WHAT THE USER CONFIGURED. `nodePath` in config, or `LAIN_NODE` in the
 *      environment. A person who has said where Node is has settled it, and an
 *      override that loses to a search is not an override.
 *   3. PATH. The ordinary case, and the one that works in a terminal.
 *   4. THE STANDARD WINDOWS INSTALL. `%ProgramFiles%\nodejs\node.exe` — where
 *      the official installer puts it, and where it is on this machine.
 *   5. THE 32-BIT LOCATION, for a 32-bit Node on a 64-bit Windows.
 *   6. FAIL, NAMING EVERY PLACE THAT WAS LOOKED. A diagnostic a person can act
 *      on beats a category of error every time.
 *
 * ------------------------------------------------------------------------
 * IT RETURNS A PATH, NEVER A COMMAND STRING.
 *
 * `C:\Program Files\nodejs\node.exe` contains a space, and the only reliable
 * way to survive that is never to build a shell string in the first place:
 * callers spawn `{ exe, args }` with an argument ARRAY and no shell. A quoted
 * command line is a second escaping problem that only shows up on the machines
 * that have the space — which is all of them.
 */

const fs = require('fs');
const path = require('path');

/** An executable that exists and is a file. Never a directory that shares a name. */
function usable(p) {
  if (!p) return false;
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Where a PATH entry would put a node executable on this platform. */
function candidatesIn(dir) {
  if (!dir) return [];
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd', 'node.bat'] : ['node'];
  return names.map((n) => path.join(dir, n));
}

/** Every directory on PATH, in order, with the empty entries dropped. */
function pathDirs(env) {
  const raw = env.PATH || env.Path || env.path || '';
  return String(raw).split(path.delimiter).map((d) => d.trim()).filter(Boolean);
}

/**
 * THE STANDARD WINDOWS INSTALL LOCATIONS.
 *
 * Read from the environment rather than hard-coded, because `Program Files` is
 * localised on some Windows installations and relocated on others — the
 * variable is the machine's own answer. The literal is the last-resort fallback
 * for a process started with an environment so bare it has neither.
 */
function windowsInstalls(env, override) {
  if (process.platform !== 'win32') return [];
  // INJECTABLE FOR TESTS ONLY, and for one reason: this machine HAS Node at the
  // literal fallback below, so "Node is genuinely unavailable" is otherwise
  // unreachable here — and an error path nobody can execute is an error path
  // nobody has checked. Production passes nothing and searches for real.
  const roots = Array.isArray(override) ? override : [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramW6432,
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ];
  const out = [];
  for (const r of roots) {
    if (!r) continue;
    const exe = path.join(r, 'nodejs', 'node.exe');
    if (!out.includes(exe)) out.push(exe);
  }
  return out;
}

/**
 * FIND NODE.
 *
 * @param {{env?: object, cfg?: object, self?: string|null}} opts
 *   `self` is the running interpreter — `process.execPath` in production, and
 *   overridable so a test can ask what a NON-Node caller (the native host)
 *   would find without that shortcut answering first.
 * @returns {{ok: true, exe: string, how: string} | {ok: false, why: string, searched: string[]}}
 */
function find(opts = {}) {
  const env = opts.env || process.env;
  const cfg = opts.cfg || {};
  const searched = [];

  // ---- 1. THE INTERPRETER ALREADY RUNNING THIS ---------------------------
  const self = opts.self === undefined ? process.execPath : opts.self;
  if (self) {
    searched.push(`the running interpreter (${self})`);
    if (usable(self)) return { ok: true, exe: self, how: 'the Node already running Noema' };
  }

  // ---- 2. WHAT SOMEBODY CONFIGURED --------------------------------------
  //
  // A CONFIGURED PATH THAT IS WRONG IS AN ERROR, NOT A HINT. Falling through to
  // a search would silently run a different Node than the one the person named,
  // which is the bug an override exists to prevent.
  const declared = String(cfg.nodePath || env.LAIN_NODE || '').trim();
  if (declared) {
    searched.push(`the configured path (${declared})`);
    if (usable(declared)) return { ok: true, exe: declared, how: 'the configured Node path' };
    return {
      ok: false,
      why: `the configured Node path does not exist: ${declared}`
        + ' — set `nodePath` in config.json or LAIN_NODE to a real node executable, or unset it to search for one',
      searched,
    };
  }

  // ---- 3. PATH -----------------------------------------------------------
  for (const dir of pathDirs(env)) {
    for (const c of candidatesIn(dir)) {
      if (usable(c)) {
        searched.push(`PATH (${c})`);
        return { ok: true, exe: c, how: 'PATH' };
      }
    }
  }
  searched.push(`PATH (${pathDirs(env).length} entries, no node)`);
  if (process.platform === 'win32' && Array.isArray(opts.roots) && !opts.roots.length) searched.push('no standard installation directories to search');

  // ---- 4/5. WHERE WINDOWS PUTS IT ---------------------------------------
  for (const c of windowsInstalls(env, opts.roots)) {
    searched.push(c);
    if (usable(c)) return { ok: true, exe: c, how: 'the standard Windows installation' };
  }

  // ---- 6. SAY WHAT WAS LOOKED FOR, AND WHERE ----------------------------
  return {
    ok: false,
    why: 'Node could not be found. Noema needs a Node executable to start its Core.'
      + ` Looked in: ${searched.join('; ')}.`
      + ' Install Node (https://nodejs.org) or set `nodePath` in config.json to the full path of node.exe.',
    searched,
  };
}

/**
 * The same answer, or a thrown error carrying the diagnostic. For callers that
 * cannot usefully continue without Node and would only rethrow.
 */
function must(opts = {}) {
  const r = find(opts);
  if (!r.ok) { const e = new Error(r.why); e.searched = r.searched; throw e; }
  return r;
}

module.exports = { find, must, usable, pathDirs, windowsInstalls, candidatesIn };
