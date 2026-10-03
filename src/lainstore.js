'use strict';

/** `<project>/.lain/` — ONE AUTHORITY FOR WHERE PROJECT INTELLIGENCE LIVES. */

const fs = require('fs');
const path = require('path');

/** The directory, inside the project being worked on: `.lain/` — or `.noema/` for a project the Noema era opened */
const meta = require('./projectmeta');
const DIR = meta.CANON;

/** THE SLOTS. A closed list, because an open one is how a second authority arrives: a module that can invent a filename will, and then two modules own… */
const SLOTS = Object.freeze({
  /** The INTENDED architecture: what this project is meant to be. */
  architecture: 'architecture/skeleton.json',
  /** What was on disk the last time intent was compared against it. */
  observed: 'fingerprints/observed.json',
  /** Typed relationships between architecture nodes. */
  wiring: 'graph/wiring.json',
  /** The dictionary: what the project's words mean. */
  concepts: 'graph/concepts.json',
  /** Facts promoted out of scratch because something verified them. */
  memory: 'memory/facts.json',
  /** What was checked, when, and by what. */
  validation: 'validation/checks.json',
  /** The file/symbol index. Written by projectindex.js since before this file. */
  index: 'index.json',
  /** Content fingerprints of the tree when LAIN first arrived. See bootstrap.js. */
  baseline: 'fingerprints/baseline.json',
});

/** Directories that exist because something writes into them per-session. */
const SCRATCH = 'scratch';

/** WHERE A TASK'S EVIDENCE LIVES — one directory per task, under `.lain/tasks/`. */
const TASKS = 'tasks';

/** Bumped when an envelope's shape changes, so an old document is discarded. */
const VERSION = 1;

function dirFor(root) { return meta.dir(String(root)); }

/** The absolute path of a slot. */
function pathOf(root, slot) {
  const rel = SLOTS[slot];
  if (!rel) throw new Error(`unknown .lain slot "${slot}" — the slot list is closed on purpose`);
  return path.join(dirFor(root), rel);
}

/** Where one session's working files go. See scratch.js for the lifecycle. */
function scratchDir(root, sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown';
  return path.join(dirFor(root), SCRATCH, safe);
}

function scratchRoot(root) { return path.join(dirFor(root), SCRATCH); }

/** Every task directory, whoever wrote it. */
function tasksRoot(root) { return path.join(dirFor(root), TASKS); }

/** One task's evidence directory. */
function taskDir(root, taskId) {
  const safe = String(taskId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown';
  return path.join(tasksRoot(root), /^\.+$/.test(safe) ? 'unknown' : safe);
}

/** A file inside one task's directory, in a named sub-area. */
const AREAS = Object.freeze(['logs', 'tests', 'browser', 'screenshots', 'observations', 'verification', 'diff', 'reports']);

function taskFile(root, taskId, area, name) {
  const a = String(area || '');
  if (!AREAS.includes(a)) throw new Error(`unknown task artifact area "${a}" — the area list is closed on purpose`);
  const safe = String(name || 'file').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'file';
  return path.join(taskDir(root, taskId), a, safe);
}

/** READ A SLOT, or the fallback. */
/** The schema is brought current before the first read or write of a project. */
function schemaFirst(root) {
  try { require('./lainschema').ensure(root); } catch { /* documents are still readable as they are */ }
}

function read(root, slot, fallback = null) {
  schemaFirst(root);
  let raw;
  try { raw = fs.readFileSync(pathOf(root, slot), 'utf8'); } catch { return fallback; }
  let doc;
  try { doc = JSON.parse(raw); } catch { return fallback; }
  if (!doc || typeof doc !== 'object') return fallback;
  if (doc.version !== VERSION) return fallback;
  return doc.body === undefined ? fallback : doc.body;
}

/** WRITE A SLOT, atomically. */
function write(root, slot, body) {
  if (held(root)) return false;
  const file = pathOf(root, slot);
  const created = !fs.existsSync(dirFor(root));
  if (!created) schemaFirst(root);
  const doc = { version: VERSION, slot, updatedAt: Date.now(), body };
  let text;
  try { text = JSON.stringify(doc); } catch { return false; }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    if (created) require('./lainschema').stampNew(root);
    return true;
  } catch {
    return false;
  }
}

/** When a slot was last written, or 0. Cheap: one stat, no parse. */
function updatedAt(root, slot) {
  try { return Math.floor(fs.statSync(pathOf(root, slot)).mtimeMs); } catch { return 0; }
}

/** Whether a slot has ever been written. */
function has(root, slot) {
  try { return fs.statSync(pathOf(root, slot)).isFile(); } catch { return false; }
}

/** WHAT THIS PROJECT REMEMBERS, as a fact rather than an impression. */
function survey(root) {
  const out = { dir: dirFor(root), exists: false, slots: {}, scratch: [] };
  try { out.exists = fs.statSync(out.dir).isDirectory(); } catch { return out; }
  for (const slot of Object.keys(SLOTS)) {
    const at = updatedAt(root, slot);
    let bytes = 0;
    if (at) { try { bytes = fs.statSync(pathOf(root, slot)).size; } catch { /* raced */ } }
    out.slots[slot] = { present: at > 0, updatedAt: at, bytes };
  }
  try {
    for (const e of fs.readdirSync(scratchRoot(root), { withFileTypes: true })) {
      if (e.isDirectory()) out.scratch.push(e.name);
    }
  } catch { /* no scratch yet, which is the ordinary case */ }
  return out;
}

/** PERMANENTLY FORGET ONE SLOT. */
function forget(root, slot) {
  if (held(root)) return false;
  try { fs.unlinkSync(pathOf(root, slot)); return true; } catch { return false; }
}

// A HELD PROJECT IS NOT WRITTEN
const holds = new Map();
const keyOf = (root) => path.resolve(String(root || '.')).toLowerCase();
function hold(root, sessionId, on) {
  const k = keyOf(root);
  const who = holds.get(k) || new Set();
  if (on) who.add(String(sessionId || '-')); else who.delete(String(sessionId || '-'));
  if (who.size) holds.set(k, who); else holds.delete(k);
}
/** Is this project's `.lain/` held? Also true for any path inside a held project. */
function held(root) {
  if (!holds.size || !root) return false;
  let k = keyOf(root);
  for (const n of meta.NAMES) {
    const d = `${path.sep}${n}`.toLowerCase();
    const at = k.indexOf(`${d}${path.sep}`);
    if (at >= 0) { k = k.slice(0, at); break; }
    if (k.endsWith(d)) { k = k.slice(0, -d.length); break; }
  }
  return holds.has(k);
}

module.exports = {
  DIR, SLOTS, VERSION, SCRATCH, TASKS, AREAS,
  dirFor, pathOf, scratchDir, scratchRoot, tasksRoot, taskDir, taskFile,
  read, write, has, updatedAt, survey, forget, hold, held,
};
