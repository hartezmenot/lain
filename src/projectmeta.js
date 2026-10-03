'use strict';

/** A PROJECT'S LAIN FOLDER — `.lain/`, and the Noema-era `.noema/` for projects Noema already opened. */

const fs = require('fs');
const path = require('path');

const CANON = '.lain';
const LEGACY = '.noema';
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

/** `lain project migrate`: .noema/ → .lain/ (one rename), with a note of where it came from. */
function migrate(root) {
  const r = path.resolve(String(root || process.cwd()));
  const from = path.join(r, LEGACY); const to = path.join(r, CANON);
  if (isDir(to)) return { ok: true, state: isDir(from) ? 'both' : 'done', why: isDir(from) ? `.lain/ is already this project's folder; .noema/ is no longer read (remove it when you are ready)` : 'already migrated' };
  if (!isDir(from)) return { ok: true, state: 'none', why: 'this project has no .noema/ folder' };
  try { fs.renameSync(from, to); } catch (e) { return { ok: false, why: `could not rename .noema/ to .lain/ (${e.code || e.message}) — is LAIN still using this project?` }; }
  try { fs.writeFileSync(path.join(to, 'migrated-from-noema.json'), JSON.stringify({ from: LEGACY, at: new Date().toISOString() }, null, 2)); } catch { /* the rename is the fact */ }
  // THE CONSTITUTION FOLLOWS: NOEMA.md becomes LAIN.md (one rename; an existing LAIN.md is never overwritten).
  try { const a = path.join(to, 'NOEMA.md'); const b = path.join(to, 'LAIN.md'); if (fs.existsSync(a) && !fs.existsSync(b)) fs.renameSync(a, b); } catch { /* read under either name */ }
  // THE SELF-IGNORE FOLLOWS: a project-level .gitignore that ignored .noema/ now also ignores .lain/.
  try {
    const gi = path.join(r, '.gitignore');
    const text = fs.readFileSync(gi, 'utf8');
    if (/^\/?\.noema\/?\s*$/m.test(text) && !/^\/?\.lain\/?\s*$/m.test(text)) fs.appendFileSync(gi, `${text.endsWith('\n') ? '' : '\n'}.lain/\n`);
  } catch { /* no .gitignore */ }
  return { ok: true, state: 'moved', from, to };
}

module.exports = { CANON, LEGACY, NAMES, name, dir, file, isMetaName, legacyOnly, migrate };
