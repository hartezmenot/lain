'use strict';

/**
 * FINDING A PROGRAM ON PATH, ONCE — llama.cpp's lookup memo (Phase 8.1), for the
 * runtime drivers too (Phase 8.2).
 *
 * A walk is a stat per PATH directory × extension, ~150 on a typical Windows
 * PATH, and the terminal's header asked each runtime driver for its binary on
 * every redraw: in a profiled task, 1.3 s of 2 s of CPU was the `claude` and
 * `opencode` walks. A program found is re-checked with one stat (it may have
 * been uninstalled); one not found is looked for again after 30 s, so a runtime
 * installed while LAIN runs still appears. A changed PATH is a different key.
 */

const fs = require('fs');
const path = require('path');

const MISS_MS = 30_000;
const memo = new Map();   // `${PATH}|${name}|${exts}` -> { path | null, at }

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/** The first `name + ext` on PATH, in the given extension order, or null. */
function find(name, exts = null) {
  const list = exts || (process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']);
  const k = `${process.env.PATH || ''}|${name}|${list.join(',')}`;
  const hit = memo.get(k);
  if (hit) {
    if (hit.path ? isFile(hit.path) : Date.now() - hit.at < MISS_MS) return hit.path;
    memo.delete(k);
  }
  let found = null;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of list) { const p = path.join(dir, name + ext); if (isFile(p)) { found = p; break; } }
    if (found) break;
  }
  memo.set(k, { path: found, at: Date.now() });
  return found;
}

module.exports = { find };
