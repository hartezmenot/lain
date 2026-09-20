'use strict';

/**
 * `.lain/` SCHEMA — version, backup, migrate, validate, and put it back if not.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS NOW. `.lain/` started as a cache (index.json, rebuilt freely)
 * and became authority: architecture intent, the dictionary, wiring, promoted
 * facts, the fingerprint baseline. A cache can be thrown away when its shape
 * changes; authority cannot. So a shape change is a migration, and a migration
 * is deterministic code in this file — never a model rewriting JSON.
 *
 *     detect version
 *        │ older
 *        ▼
 *     backup  (.lain/backups/schema-<from>-<time>/)
 *        ▼
 *     migrate (one step at a time, each a pure function of the documents)
 *        ▼
 *     validate (every slot parses, has its envelope and its body shape)
 *      ┌─┴──┐
 *    PASS   FAIL
 *     │      │
 *    keep   restore the backup, leave the version where it was
 *
 * A FAILED MIGRATION DOES NOT BRICK THE PROJECT: the documents are exactly what
 * they were, lainstore reads them as before, and the failure is reported.
 *
 * ------------------------------------------------------------------------
 * THE VERSIONS.
 *
 *   1   every `.lain/` written before this file: no schema-version.json.
 *   2   semantic records carry `proof` (fingerprint evidence, see freshness.js).
 *       Records that predate it get `proof: []` and `proofOrigin: 'pre-schema-2'`
 *       — UNKNOWN, honestly, because the fingerprints they were established
 *       against were never recorded and must not be invented from today's disk.
 */

const fs = require('fs');
const path = require('path');

const CURRENT = 2;
const SCHEMA_FILE = 'schema-version.json';
const BACKUPS = 'backups';
/** Directories that are not documents and are never backed up or migrated. */
const SKIP_DIRS = new Set(['scratch', 'tasks', BACKUPS]);

function dirOf(root) { return path.join(String(root), '.lain'); }
function schemaPath(root) { return path.join(dirOf(root), SCHEMA_FILE); }

/** The version on disk: 0 when there is no `.lain/`, 1 when it predates schema-version.json. */
function detect(root) {
  if (!fs.existsSync(dirOf(root))) return 0;
  try {
    const j = JSON.parse(fs.readFileSync(schemaPath(root), 'utf8'));
    return Number.isInteger(j.version) ? j.version : 1;
  } catch { return 1; }
}

function writeSchema(root, version, history) {
  const tmp = `${schemaPath(root)}.tmp`;
  fs.mkdirSync(dirOf(root), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ version, updatedAt: Date.now(), history: (history || []).slice(-20) }, null, 2));
  fs.renameSync(tmp, schemaPath(root));
}

function readSchema(root) {
  try { return JSON.parse(fs.readFileSync(schemaPath(root), 'utf8')); } catch { return { version: detect(root), history: [] }; }
}

/** Every JSON document under `.lain/`, relative, excluding working directories. */
function documents(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!rel && SKIP_DIRS.has(e.name)) continue; walk(path.join(dir, e.name), r); continue; }
      // index.json is a rebuildable cache (projectindex.js), not authority, and can be megabytes.
      if (e.isFile() && e.name.endsWith('.json') && r !== 'index.json') out.push(r);
    }
  };
  walk(dirOf(root), '');
  return out;
}

/** Copy every document to a new backup directory. Returns its name. */
function backup(root, from) {
  const name = `schema-${from}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dest = path.join(dirOf(root), BACKUPS, name);
  fs.mkdirSync(dest, { recursive: true });
  const docs = documents(root);
  for (const rel of docs) {
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(dirOf(root), rel), target);
  }
  fs.writeFileSync(path.join(dest, 'MANIFEST.json'), JSON.stringify({ from, docs, at: Date.now() }, null, 2));
  return name;
}

/**
 * PUT A BACKUP BACK. Documents created since it was taken are removed; every
 * document it holds is restored byte for byte.
 */
function rollback(root, name) {
  const src = path.join(dirOf(root), BACKUPS, String(name));
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(src, 'MANIFEST.json'), 'utf8')); } catch {
    return { ok: false, why: `no backup ${name}` };
  }
  const kept = new Set(manifest.docs);
  for (const rel of documents(root)) {
    if (!kept.has(rel)) { try { fs.rmSync(path.join(dirOf(root), rel), { force: true }); } catch { /* raced */ } }
  }
  for (const rel of manifest.docs) {
    const target = path.join(dirOf(root), rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(src, rel), target);
  }
  return { ok: true, restored: manifest.docs.length, version: detect(root) };
}

function readDoc(root, rel) {
  try { return JSON.parse(fs.readFileSync(path.join(dirOf(root), rel), 'utf8')); } catch { return undefined; }
}

function writeDoc(root, rel, doc) {
  const file = path.join(dirOf(root), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(doc));
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * THE MIGRATIONS. `from → from + 1`, each a function of the documents on disk.
 * A step may not read the source tree: a migration describes `.lain/`, and
 * today's disk is not evidence about when a record was made.
 */
const MIGRATIONS = {
  1: function toTwo(root) {
    const SLOTS = require('./lainstore').SLOTS;
    const mark = (rec) => (rec && typeof rec === 'object' && !Array.isArray(rec.proof)
      ? { ...rec, proof: [], proofOrigin: 'pre-schema-2' } : rec);
    const memory = readDoc(root, SLOTS.memory);
    if (memory && memory.body && Array.isArray(memory.body.facts)) {
      memory.body.facts = memory.body.facts.map(mark);
      writeDoc(root, SLOTS.memory, memory);
    }
    const concepts = readDoc(root, SLOTS.concepts);
    if (concepts && concepts.body && concepts.body.terms && typeof concepts.body.terms === 'object') {
      for (const k of Object.keys(concepts.body.terms)) concepts.body.terms[k] = mark(concepts.body.terms[k]);
      writeDoc(root, SLOTS.concepts, concepts);
    }
    const wiring = readDoc(root, SLOTS.wiring);
    if (wiring && wiring.body && Array.isArray(wiring.body.edges)) {
      wiring.body.edges = wiring.body.edges.map(mark);
      writeDoc(root, SLOTS.wiring, wiring);
    }
  },
};

/** SHAPES a slot's body must have. A slot that is absent is valid; a malformed one is not. */
const SHAPES = {
  architecture: (b) => b && typeof b.nodes === 'object',
  concepts: (b) => b && typeof b.terms === 'object',
  wiring: (b) => b && Array.isArray(b.edges),
  memory: (b) => b && Array.isArray(b.facts),
  validation: (b) => b && Array.isArray(b.checks),
  baseline: (b) => b && typeof b.files === 'object',
  observed: (b) => b && typeof b === 'object',
};

/** Every slot parses, carries its envelope, and has its body's shape. */
function validate(root, version) {
  const lainstore = require('./lainstore');
  const problems = [];
  for (const [slot, rel] of Object.entries(lainstore.SLOTS)) {
    if (slot === 'index') continue;                    // projectindex.js owns its own version and rebuilds
    const file = path.join(dirOf(root), rel);
    if (!fs.existsSync(file)) continue;
    const doc = readDoc(root, rel);
    if (doc === undefined) { problems.push(`${rel} does not parse`); continue; }
    if (!doc || doc.version !== lainstore.VERSION) { problems.push(`${rel} has no envelope version ${lainstore.VERSION}`); continue; }
    const shape = SHAPES[slot];
    if (shape && !shape(doc.body)) problems.push(`${rel} body has the wrong shape`);
    if (version >= 2 && (slot === 'memory' || slot === 'wiring') && doc.body) {
      const rows = slot === 'memory' ? doc.body.facts : doc.body.edges;
      if (Array.isArray(rows) && rows.some((r) => r && !Array.isArray(r.proof))) problems.push(`${rel} has records without proof`);
    }
    if (version >= 2 && slot === 'concepts' && doc.body && doc.body.terms) {
      if (Object.values(doc.body.terms).some((r) => r && !Array.isArray(r.proof))) problems.push(`${rel} has records without proof`);
    }
  }
  return { ok: problems.length === 0, problems };
}

const ensured = new Set();

/**
 * BRING `.lain/` TO THE CURRENT SCHEMA, once per process per project.
 *
 * @param {object} [o]  `migrations` replaces the table (tests inject a failing
 *                       step to prove the restore); `force` re-runs the check.
 * @returns {{ok, from, to, backup?, restored?, problems?}}
 */
function ensure(root, { migrations = MIGRATIONS, force = false, target = CURRENT } = {}) {
  const r = path.resolve(String(root));
  const key = process.platform === 'win32' ? r.toLowerCase() : r;
  if (ensured.has(key) && !force) return { ok: true, from: target, to: target, cached: true };
  ensured.add(key);
  const from = detect(r);
  if (from === 0) return { ok: true, from: 0, to: 0, note: 'no .lain yet — it is created at the current schema when first written' };
  if (from >= target) return { ok: true, from, to: from };
  let name;
  try { name = backup(r, from); } catch (e) {
    return { ok: false, from, to: from, problems: [`backup failed, nothing migrated: ${e.message}`] };
  }
  const history = readSchema(r).history || [];
  let v = from;
  try {
    while (v < target) {
      const step = migrations[v];
      if (typeof step !== 'function') throw new Error(`no migration from version ${v}`);
      step(r);
      v += 1;
    }
    const check = validate(r, target);
    if (!check.ok) throw Object.assign(new Error('validation failed'), { problems: check.problems });
    writeSchema(r, target, [...history, { from, to: target, at: Date.now(), backup: name }]);
    return { ok: true, from, to: target, backup: name };
  } catch (e) {
    const back = rollback(r, name);
    // schema-version.json is absent from a v1 backup, so rollback removed any partial
    // one; a later version's is restored with its old contents.
    return {
      ok: false, from, to: from, backup: name, restored: back.ok,
      problems: e.problems || [String((e && e.message) || e)],
    };
  }
}

/** A `.lain/` created fresh is created at the current schema. */
function stampNew(root) {
  if (detect(root) === 0 || fs.existsSync(schemaPath(root))) return false;
  try { writeSchema(root, CURRENT, []); return true; } catch { return false; }
}

module.exports = { CURRENT, detect, backup, rollback, validate, ensure, stampNew, MIGRATIONS, documents, _ensured: ensured };
