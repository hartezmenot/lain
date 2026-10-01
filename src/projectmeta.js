'use strict';

/**
 * A PROJECT'S NOEMA FOLDER — `.noema/`, and LAIN's `.lain/` for projects LAIN already opened.
 *
 * ONE AUTHORITY PER PROJECT: `.noema/` when it exists; otherwise an existing `.lain/` (used as it is); otherwise a
 * new project gets `.noema/`. The two are never both written. Moving `.lain/` → `.noema/` is DELIBERATE
 * (`noema project migrate`), because a project may track `.lain/` in its own git history and a silent rename would
 * be a change in the person's repository they did not make.
 */

const fs = require('fs');
const path = require('path');

const CANON = '.noema';
const LEGACY = '.lain';
const NAMES = Object.freeze([CANON, LEGACY]);

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** The folder name this project uses. */
function name(root) {
  const r = String(root || process.cwd());
  if (isDir(path.join(r, CANON))) return CANON;
  if (isDir(path.join(r, LEGACY))) return LEGACY;
  return CANON;
}
function dir(root) { return path.join(String(root || process.cwd()), name(root)); }
function file(root, ...rel) { return path.join(dir(root), ...rel); }
function isMetaName(n) { return NAMES.includes(String(n).toLowerCase()); }
function legacyOnly(root) { const r = String(root || process.cwd()); return !isDir(path.join(r, CANON)) && isDir(path.join(r, LEGACY)); }

/** `noema project migrate`: .lain/ → .noema/ (one rename), with a note of where it came from. */
function migrate(root) {
  const r = path.resolve(String(root || process.cwd()));
  const from = path.join(r, LEGACY); const to = path.join(r, CANON);
  if (isDir(to)) return { ok: true, state: isDir(from) ? 'both' : 'done', why: isDir(from) ? `.noema/ is already this project's folder; .lain/ is no longer read (remove it when you are ready)` : 'already migrated' };
  if (!isDir(from)) return { ok: true, state: 'none', why: 'this project has no .lain/ folder' };
  try { fs.renameSync(from, to); } catch (e) { return { ok: false, why: `could not rename .lain/ to .noema/ (${e.code || e.message}) — is Noema or LAIN still using this project?` }; }
  try { fs.writeFileSync(path.join(to, 'migrated-from-lain.json'), JSON.stringify({ from: LEGACY, at: new Date().toISOString() }, null, 2)); } catch { /* the rename is the fact */ }
  // THE SELF-IGNORE FOLLOWS: a project-level .gitignore that ignored .lain/ now also ignores .noema/.
  try {
    const gi = path.join(r, '.gitignore');
    const text = fs.readFileSync(gi, 'utf8');
    if (/^\/?\.lain\/?\s*$/m.test(text) && !/^\/?\.noema\/?\s*$/m.test(text)) fs.appendFileSync(gi, `${text.endsWith('\n') ? '' : '\n'}.noema/\n`);
  } catch { /* no .gitignore */ }
  return { ok: true, state: 'moved', from, to };
}

module.exports = { CANON, LEGACY, NAMES, name, dir, file, isMetaName, legacyOnly, migrate };
