'use strict';

/** SCRATCH — where a turn keeps its working notes, and why it is not memory. */

const fs = require('fs');
const path = require('path');

const lainstore = require('./lainstore');

/** One finding. Longer than this is a log line, not a finding. */
const MAX_TEXT = 1_000;

/** Findings kept per session. A turn that has 200 findings has a log. */
const MAX_NOTES = 200;

/** Promoted facts kept. Old ones fall off the end rather than growing forever. */
const MAX_FACTS = 400;

const MANIFEST = 'manifest.json';

function dirOf(root, sessionId) { return lainstore.scratchDir(root, sessionId); }

function manifestPath(root, sessionId) { return path.join(dirOf(root, sessionId), MANIFEST); }

// A HELD project (a declared read-only task — lainstore.hold) keeps its scratch manifest here, in this process, instead of in `.lain/scratch/`: notes…
const heldManifests = new Map();
const heldKey = (root, sessionId) => `${path.resolve(String(root)).toLowerCase()}|${sessionId}`;

function readManifest(root, sessionId) {
  const k = heldKey(root, sessionId);
  if (heldManifests.has(k)) return heldManifests.get(k);
  try {
    const j = JSON.parse(fs.readFileSync(manifestPath(root, sessionId), 'utf8'));
    if (!j || typeof j !== 'object') return null;
    return { notes: [], ...j, notes: Array.isArray(j.notes) ? j.notes : [] };
  } catch {
    return null;
  }
}

function writeManifest(root, sessionId, m) {
  if (lainstore.held(root)) { heldManifests.set(heldKey(root, sessionId), m); return true; }
  const file = manifestPath(root, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** OPEN A SCRATCH for this turn. */
function open(root, sessionId, { goal = '', turn = 0 } = {}) {
  const existing = readManifest(root, sessionId);
  const m = existing || { session: String(sessionId), openedAt: Date.now(), goal: '', turn: 0, notes: [] };
  if (goal) m.goal = String(goal).slice(0, 400);
  if (turn) m.turn = Number(turn) || 0;
  m.touchedAt = Date.now();
  const ok = writeManifest(root, sessionId, m);
  return { ok, dir: dirOf(root, sessionId), manifest: m, resumed: Boolean(existing) };
}

/** RECORD A FINDING. */
function note(root, sessionId, { text, by = '', kind = 'finding' } = {}) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'a note needs text' };
  const m = readManifest(root, sessionId) || open(root, sessionId).manifest;
  m.notes.push({
    text: t.slice(0, MAX_TEXT),
    by: String(by).slice(0, 60),
    kind: String(kind).slice(0, 30),
    at: Date.now(),
  });
  // OLDEST FIRST OUT. A turn that keeps finding things keeps the recent ones,
  // which are the ones a handover would carry.
  if (m.notes.length > MAX_NOTES) m.notes = m.notes.slice(-MAX_NOTES);
  m.touchedAt = Date.now();
  return { ok: writeManifest(root, sessionId, m), count: m.notes.length };
}

/** What this turn has found so far. */
function notes(root, sessionId) {
  const m = readManifest(root, sessionId);
  return m ? m.notes : [];
}

/** A path inside the scratch, for a worker that needs a real file. */
function file(root, sessionId, name) {
  const safe = String(name || 'file').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'file';
  const dir = dirOf(root, sessionId);
  if (!lainstore.held(root)) {
    const created = !fs.existsSync(lainstore.dirFor(root));
    try { fs.mkdirSync(dir, { recursive: true }); if (created) require('./lainschema').stampNew(root); } catch { /* read-only project */ }
  }
  return path.join(dir, safe);
}

// PROMOTION — the one door from scratch into memory

function facts(root) {
  const body = lainstore.read(root, 'memory', null);
  return body && Array.isArray(body.facts) ? body.facts : [];
}

/** PROMOTE A FINDING TO A DURABLE FACT. */
function promote(root, sessionId, { text, evidence, by = 'lain' } = {}) {
  const t = String(text || '').trim();
  const e = String(evidence || '').trim();
  if (!t) return { ok: false, error: 'a fact needs text' };
  if (!e) {
    return {
      ok: false,
      error: 'a promoted fact must name the evidence that established it — '
        + 'a command that ran, a test that passed, a file that was read. '
        + 'Without provenance the next model cannot tell it from a guess.',
    };
  }
  const list = facts(root);
  const fact = {
    text: t.slice(0, MAX_TEXT),
    evidence: e.slice(0, MAX_TEXT),
    by: String(by).slice(0, 60),
    session: String(sessionId || ''),
    at: Date.now(),
    // THE FINGERPRINTS of the files the evidence names, so the fact goes STALE
    // when they change. See freshness.js.
    proof: require('./freshness').stamp(root, require('./freshness').pathsIn(root, e)).evidence,
  };
  // THE SAME FACT TWICE IS ONE FACT, refreshed. Otherwise a loop that promotes
  // on every pass fills memory with copies.
  const idx = list.findIndex((f) => f.text === fact.text);
  if (idx >= 0) list[idx] = fact; else list.push(fact);
  const kept = list.slice(-MAX_FACTS);
  return { ok: lainstore.write(root, 'memory', { facts: kept }), fact, count: kept.length };
}

/** Durable facts, newest last. What a briefing reads. */
function remembered(root, { max = 20 } = {}) {
  return facts(root).slice(-max);
}

// LIFECYCLE

/** THE TURN FINISHED. Remove the scratch. */
function close(root, sessionId) {
  const dir = dirOf(root, sessionId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    // LEAVE NO SCAFFOLDING.
    for (const parent of [lainstore.scratchRoot(root), lainstore.dirFor(root)]) {
      try { fs.rmdirSync(parent); } catch { /* not empty, or already gone */ }
    }
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** SCRATCHES FROM TURNS THAT NEVER COMPLETED. */
function orphans(root, { exclude = '', olderThanMs = 0 } = {}) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(lainstore.scratchRoot(root), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  const now = Date.now();
  for (const name of names) {
    if (exclude && name === String(exclude).replace(/[^A-Za-z0-9_.-]/g, '_')) continue;
    const m = readManifest(root, name);
    if (!m) continue;
    const age = now - (Number(m.touchedAt) || Number(m.openedAt) || 0);
    if (olderThanMs && age < olderThanMs) continue;
    out.push({ session: name, goal: m.goal || '', notes: m.notes, openedAt: m.openedAt, touchedAt: m.touchedAt, age });
  }
  return out.sort((a, b) => (a.touchedAt || 0) - (b.touchedAt || 0));
}

/** WHAT AN INTERRUPTED TURN LEFT, in the words a handover carries. */
function say(entry, { max = 8 } = {}) {
  if (!entry || !entry.notes || !entry.notes.length) return '';
  const rows = entry.notes.slice(-max).reverse()
    .map((n) => `  - ${n.text}${n.by ? `  [${n.by}]` : ''}`);
  const head = entry.goal
    ? `UNFINISHED WORK from session ${entry.session} — ${entry.goal}`
    : `UNFINISHED WORK from session ${entry.session}`;
  return [head, ...rows].join('\n');
}

module.exports = {
  MAX_TEXT, MAX_NOTES, MAX_FACTS,
  dirOf, open, note, notes, file,
  promote, remembered, facts,
  close, orphans, say,
};
