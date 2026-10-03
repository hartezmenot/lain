'use strict';

/** WHERE IS NODE — asked properly, because the answer is not always on PATH. */

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

/** THE STANDARD WINDOWS INSTALL LOCATIONS. */
function windowsInstalls(env, override) {
  if (process.platform !== 'win32') return [];
  // INJECTABLE FOR TESTS ONLY, and for one reason: this machine HAS Node at the literal fallback below, so "Node is genuinely unavailable" is otherwise…
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

/** FIND NODE. */
function find(opts = {}) {
  const env = opts.env || process.env;
  const cfg = opts.cfg || {};
  const searched = [];

  // ---- 1. THE INTERPRETER ALREADY RUNNING THIS ---------------------------
  const self = opts.self === undefined ? process.execPath : opts.self;
  if (self) {
    searched.push(`the running interpreter (${self})`);
    if (usable(self)) return { ok: true, exe: self, how: 'the Node already running LAIN' };
  }

  // 2. WHAT SOMEBODY CONFIGURED
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
    why: 'Node could not be found. LAIN needs a Node executable to start its Core.'
      + ` Looked in: ${searched.join('; ')}.`
      + ' Install Node (https://nodejs.org) or set `nodePath` in config.json to the full path of node.exe.',
    searched,
  };
}

/** The same answer, or a thrown error carrying the diagnostic. */
function must(opts = {}) {
  const r = find(opts);
  if (!r.ok) { const e = new Error(r.why); e.searched = r.searched; throw e; }
  return r;
}

module.exports = { find, must, usable, pathDirs, windowsInstalls, candidatesIn };
