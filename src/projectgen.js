'use strict';

/**
 * THE PROJECT GENERATION — one number per project, shared by every LAIN
 * process working on it (2026-09-25).
 *
 * It used to live in harnesscontext.js as a Map in process memory, which made
 * it a per-PROCESS count: the Harness and a CLI attached to the same project
 * each had their own "generation 7", and neither number meant anything to the
 * other. Anything keyed by it — the canonical Selection, a focus artifact,
 * evidence validity — could not be compared across surfaces.
 *
 * Now it is a small file next to the project's provenance (editledger.js keeps
 * the same per-project directory): `<projectId>.generation.json`, holding the
 * number and the last changes that advanced it. Advancing takes a short lock
 * so two processes never hand out the same number.
 *
 *   advance(root, {file, by})   the ONE way the number moves. Called only by
 *                               harnesscontext.noteSourceEdit, whose own two
 *                               callers are guarded (oneauthority.test.js).
 *   current(root)               the number now — re-read when the file moved.
 *   since(root, n)              the changes after generation n.
 *
 * A change another process made is noticed on the next read; the listeners
 * registered with `onForeign` (the GUG's stale marks) hear about it, so this
 * process's derived state does not keep describing the old file.
 *
 * `base` — the generation a prompt's stable prefix was built at — is a fact
 * about THIS process's prompt cache, not about the project, so it stays in
 * memory here and is never written.
 */

const fs = require('fs');
const path = require('path');

const MAX_CHANGES = 200;
const LOCK_WAIT_MS = 400;
const LOCK_STALE_MS = 5000;

/** root → { n, base, changes, stamp, seen } */
const state = new Map();
const listeners = [];

function dir() { return path.join(require('./config').configDir(), 'provenance'); }
function fileOf(root) { return path.join(dir(), `${require('./journey').projectId(root)}.generation.json`); }
function keyOf(root) { return path.resolve(root || '.'); }

function stampOf(f) {
  try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return null; }
}

function readDisk(f) {
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { n: Number(d.n) || 0, changes: Array.isArray(d.changes) ? d.changes : [] };
  } catch { return { n: 0, changes: [] }; }
}

function sleep(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best effort */ } }

function withLock(f, fn) {
  const lock = `${f}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); held = true; } catch (e) {
      if (!e || e.code !== 'EEXIST') break;
      // A lock nobody released in five seconds belongs to a process that died.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > until) break;
      sleep(5);
    }
  }
  try { return fn(); } finally { if (held) try { fs.unlinkSync(lock); } catch { /* already gone */ } }
}

/** The record for a project, refreshed from disk when another process moved it. */
function current(root) {
  const k = keyOf(root);
  let rec = state.get(k);
  if (!rec) { rec = { n: 0, base: 0, changes: [], stamp: undefined, seen: 0 }; state.set(k, rec); }
  const f = fileOf(k);
  const stamp = stampOf(f);
  if (stamp !== rec.stamp) {
    const d = stamp ? readDisk(f) : { n: 0, changes: [] };
    rec.n = d.n; rec.changes = d.changes; rec.stamp = stamp;
    if (rec.base > rec.n) rec.base = rec.n;
    // CHANGES MADE BY ANOTHER PROCESS: this one's derived state hears of them once.
    const foreign = rec.changes.filter((c) => c.n > rec.seen && c.pid !== process.pid);
    rec.seen = Math.max(rec.seen, rec.n);
    if (foreign.length) for (const l of listeners) { try { l(k, foreign); } catch { /* a listener never costs a read */ } }
  }
  return rec;
}

/** Advance by one change. Returns the new generation. */
function advance(root, { file, by = 'user' } = {}) {
  const k = keyOf(root);
  const f = fileOf(k);
  const rec = current(k);
  try { fs.mkdirSync(dir(), { recursive: true }); } catch { /* the write below reports it */ }
  withLock(f, () => {
    const d = readDisk(f);
    d.n = Math.max(d.n, rec.n) + 1;
    d.changes.push({ file: String(file || ''), by: String(by || 'user'), n: d.n, pid: process.pid, at: Date.now() });
    if (d.changes.length > MAX_CHANGES) d.changes.splice(0, d.changes.length - MAX_CHANGES);
    try {
      fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(d));
      fs.renameSync(`${f}.${process.pid}.tmp`, f);
    } catch { /* a read-only config dir still counts in memory */ }
    rec.n = d.n; rec.changes = d.changes; rec.seen = d.n; rec.stamp = stampOf(f);
  });
  return rec.n;
}

/** The changes after generation `n`, oldest first. */
function since(root, n) { return current(root).changes.filter((c) => c.n > n); }

/** Pin the generation this process's stable prompt prefix describes. */
function pinBase(root) { const r = current(root); r.base = r.n; return r.base; }

/** Hear about changes another process made (for derived state such as GUG stale marks). */
function onForeign(fn) { if (typeof fn === 'function' && !listeners.includes(fn)) listeners.push(fn); }

function _reset() { state.clear(); }

module.exports = { current, advance, since, pinBase, onForeign, _reset, MAX_CHANGES };
