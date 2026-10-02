'use strict';

/**
 * MODEL DIRECTORIES — folders the person pointed LAIN at, and the GGUF files in
 * them. LAIN stores the DIRECTORY REFERENCE and nothing else:
 *
 *   - no model file is copied, moved, renamed or deleted — ever;
 *   - removing a directory from LAIN forgets the reference and its scan; the
 *     folder and every file in it are untouched;
 *   - a scan reads GGUF HEADERS only (gguf.js) — no model is loaded into RAM.
 *
 * Stored at <configDir>/local/modeldirs.json:
 *   { dirs: [{ id, path, addedAt }], pairs: { <model file>: <projector file> | null },
 *     scans: { <dir id>: { at, files: [summary…], skipped } } }
 *
 * PROJECTOR PAIRING (vision). A model and an mmproj are paired automatically
 * only on evidence, never because they share a folder:
 *   1. the projector's output width (clip.vision.projection_dim) equals the
 *      model's embedding width — a projector built for a different model
 *      cannot feed this one; AND
 *   2. exactly one such projector sits in the model's own folder, or the two
 *      headers name the same base model (general.basename).
 * Anything short of that reads "Projector not automatically paired" and the
 * person chooses (`pair`).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gguf = require('./gguf');

const MAX_DEPTH = 6;
const MAX_FILES = 500;

function file() { return path.join(require('../config').configDir(), 'local', 'modeldirs.json'); }
// READ ONCE PER CHANGE (Phase 8.1 performance): a view asked for this file ~40
// times per Usage open. Memoised on the file's mtime and size; write() resets it.
let readMemo = null;
function read() {
  let st = null;
  try { st = fs.statSync(file()); } catch { st = null; }
  const sig = st ? `${file()}|${st.mtimeMs}|${st.size}` : `${file()}|none`;
  if (readMemo && readMemo.sig === sig) return JSON.parse(readMemo.json);
  const v = readUncached();
  readMemo = { sig, json: JSON.stringify(v) };
  return v;
}
function readUncached() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { dirs: Array.isArray(j.dirs) ? j.dirs : [], pairs: j.pairs && typeof j.pairs === 'object' ? j.pairs : {}, scans: j.scans && typeof j.scans === 'object' ? j.scans : {}, settings: j.settings && typeof j.settings === 'object' ? j.settings : {} };
  } catch { return { dirs: [], pairs: {}, scans: {}, settings: {} }; }
}
function write(s) {
  listMemo = null;
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, f);
  readMemo = null;
  try { require('../appcatalog').invalidate(); } catch { /* not loaded */ }   // the local models listed changed
}
function norm(p) { return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase(); }
function idFor(p) { return `dir-${crypto.createHash('sha1').update(norm(p)).digest('hex').slice(0, 10)}`; }

/** Every *.gguf under `root`, bounded in depth and count. Symlinked dirs are not followed. */
function walk(root) {
  const out = []; let skipped = 0;
  const stack = [{ p: root, d: 0 }];
  while (stack.length) {
    const { p, d } = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { skipped++; continue; }
    for (const e of ents) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) { if (d < MAX_DEPTH) stack.push({ p: full, d: d + 1 }); continue; }
      if (e.isFile() && /\.gguf$/i.test(e.name)) {
        if (out.length >= MAX_FILES) { skipped++; continue; }
        out.push(full);
      }
    }
  }
  return { files: out.sort(), skipped };
}

/** SCAN one directory: headers only. Unchanged files reuse the previous scan (size + mtime). */
function scanDir(dir, prev = null) {
  const cache = new Map(((prev && prev.files) || []).map((f) => [f.file, f]));
  const { files, skipped } = walk(dir.path);
  const out = [];
  for (const f of files) {
    let st = null;
    try { st = fs.statSync(f); } catch { continue; }
    const old = cache.get(f);
    out.push(old && old.sizeBytes === st.size && old.modifiedAt === st.mtimeMs ? old : gguf.inspect(f));
  }
  return { at: Date.now(), files: out, skipped, exists: fs.existsSync(dir.path) };
}

function stem(s) {
  return String(s || '').toLowerCase().replace(/\.gguf$/, '').replace(/mmproj/g, '')
    .replace(/(?:^|[-_.])(?:i?q\d(?:_[0-9a-z]+)*|f16|f32|bf16|mxfp4)(?=$|[-_.])/g, '').replace(/[^a-z0-9]+/g, '');
}

/**
 * THE PAIRING for one text model among the projectors LAIN found.
 * Returns { projector, how } or { projector: null, how: why-not }.
 */
function pairFor(model, projectors, manual) {
  if (manual !== undefined) {
    if (manual === null) return { projector: null, how: 'no projector (your choice)' };
    const p = projectors.find((x) => x.file === manual);
    return p ? { projector: p.file, how: 'chosen by you' } : { projector: null, how: 'the projector you chose is no longer found' };
  }
  if (!model.visionArch) return { projector: null, how: 'not a vision architecture' };
  const width = model.embeddingLength;
  const dir = path.dirname(model.file);
  const fits = projectors.filter((p) => p.projector && p.projector.hasVision && width && p.projector.projectionDim === width);
  if (!fits.length) return { projector: null, how: 'Projector not automatically paired — no projector with a matching output width was found' };
  const same = fits.filter((p) => path.dirname(p.file) === dir);
  const named = fits.filter((p) => (p.basename && model.basename && p.basename === model.basename) || (stem(p.name) && stem(p.name) === stem(model.name)));
  const pick = same.length === 1 ? same[0] : named.length === 1 ? named[0] : null;
  if (!pick) return { projector: null, how: 'Projector not automatically paired — more than one projector could fit; choose one' };
  return { projector: pick.file, how: `paired: output width ${width} matches${pick.basename && pick.basename === model.basename ? `, same base model (${model.basename})` : ''}` };
}

/** Everything LAIN knows about the directories and their models, for a view. */
/**
 * MEMOISED (2026-10-01): provider.resolve reaches this several times per turn (runtimeconnections → llama.cpp), and it
 * re-parsed the scan state and stat'ed every directory each time — measured at ~25 ms a turn on a real home. The
 * answer is reused while the state file is unchanged, for at most LIST_TTL_MS (the directory checks). Read-only:
 * callers must not mutate it.
 */
const LIST_TTL_MS = 2000;
let listMemo = null;
function list() {
  let st = null;
  try { st = fs.statSync(file()); } catch { st = null; }
  const sig = st ? `${file()}|${st.mtimeMs}|${st.size}` : `${file()}|none`;
  if (listMemo && listMemo.sig === sig && Date.now() - listMemo.at < LIST_TTL_MS) return listMemo.value;
  const value = listUncached();
  listMemo = { sig, at: Date.now(), value };
  return value;
}
function listUncached() {
  const s = read();
  const all = [];
  for (const d of s.dirs) for (const f of ((s.scans[d.id] && s.scans[d.id].files) || [])) all.push({ ...f, dirId: d.id });
  const projectors = all.filter((f) => f.ok && f.kind === 'projector');
  const models = all.filter((f) => f.ok && f.kind === 'text').map((m) => {
    const pr = pairFor(m, projectors, Object.prototype.hasOwnProperty.call(s.pairs, m.file) ? s.pairs[m.file] : undefined);
    return { ...m, id: modelId(m.file), projector: pr.projector, pairing: pr.how, vision: Boolean(pr.projector) };
  });
  return {
    dirs: s.dirs.map((d) => {
      const sc = s.scans[d.id] || null;
      const files = (sc && sc.files) || [];
      return { ...d, exists: fs.existsSync(d.path), scannedAt: sc ? sc.at : null, skipped: sc ? sc.skipped : 0,
        counts: { gguf: files.length, text: files.filter((f) => f.kind === 'text').length, projector: files.filter((f) => f.kind === 'projector').length, other: files.filter((f) => f.kind === 'other' || !f.ok).length } };
    }),
    models,
    projectors,
    other: all.filter((f) => !f.ok || f.kind === 'other'),
    settings: s.settings,
  };
}

/** A stable LAIN id for a local file: llamacpp/<file stem>-<short hash of its path>. */
function modelId(fileName) {
  const base = path.basename(String(fileName)).replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return `llamacpp/${base}-${crypto.createHash('sha1').update(norm(fileName)).digest('hex').slice(0, 6)}`;
}

function add(dirPath) {
  const p = path.resolve(String(dirPath || ''));
  let st = null;
  try { st = fs.statSync(p); } catch { return { ok: false, why: 'that folder does not exist' }; }
  if (!st.isDirectory()) return { ok: false, why: 'that is not a folder' };
  const s = read();
  if (s.dirs.some((d) => norm(d.path) === norm(p))) return { ok: false, why: 'that folder is already added' };
  const d = { id: idFor(p), path: p, addedAt: Date.now() };
  s.dirs.push(d);
  s.scans[d.id] = scanDir(d);
  write(s);
  return { ok: true, dir: d, scan: { gguf: s.scans[d.id].files.length } };
}

/** FORGET a directory reference. The folder and its files are not touched. */
function remove(id) {
  const s = read();
  const d = s.dirs.find((x) => x.id === id);
  if (!d) return { ok: false, why: 'no such directory' };
  s.dirs = s.dirs.filter((x) => x.id !== id);
  delete s.scans[id];
  write(s);
  return { ok: true, removed: d.path, note: 'Only LAIN\'s reference was removed. The folder and its models are untouched.' };
}

function rescan(id = null) {
  const s = read();
  let n = 0;
  for (const d of s.dirs) { if (id && d.id !== id) continue; s.scans[d.id] = scanDir(d, s.scans[d.id]); n++; }
  write(s);
  return { ok: true, rescanned: n };
}

/** CHOOSE a projector for a model (null = none; undefined clears the choice → automatic). */
function pair(modelFile, projectorFile) {
  const s = read();
  if (projectorFile === undefined) delete s.pairs[modelFile];
  else s.pairs[modelFile] = projectorFile;
  write(s);
  return { ok: true };
}

/** Per-model runtime defaults (context, GPU layers, threads) — Advanced settings. */
function setDefaults(modelFile, values = {}) {
  const s = read();
  const cur = { ...((s.settings[modelFile]) || {}) };
  for (const k of ['ctx', 'ngl', 'threads']) {
    if (values[k] === null || values[k] === '') delete cur[k];
    else if (values[k] !== undefined) { const n = Number(values[k]); if (!Number.isInteger(n) || n < 0) return { ok: false, why: `${k} must be a whole number` }; cur[k] = n; }
  }
  s.settings[modelFile] = cur;
  write(s);
  return { ok: true, settings: cur };
}

function byId(id) { return list().models.find((m) => m.id === id) || null; }

module.exports = { list, add, remove, rescan, pair, setDefaults, byId, modelId, pairFor, scanDir, walk, file };
