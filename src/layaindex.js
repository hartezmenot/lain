'use strict';

/**
 * THE LAYA PROJECT INDEX — a project's embeddings, prepared before a task asks.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES (Toralink, 2026-09-24). Laya was HOT and still
 * produced 0 inferences. Its adapter kept one in-memory text→vector memo, and
 * the ranking request embedded every project file it had not seen — inside the
 * 2 s TASK deadline. The first ranking of a project was therefore a cold index
 * build, it always missed the deadline, and lexical fallback answered. The
 * memo also died with the process, so every new worker host paid it again.
 *
 *     MODEL HOT  !=  PROJECT READY.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS. The worker host (workerhostmain.js) owns one index per project:
 *
 *   items      one line per candidate file — path, first doc line, declared
 *              symbols — from the existing project index (projectindex.js,
 *              IN MEMORY: `persist:false`, so nothing is written to the
 *              project's `.lain/`); the same exclusions the index already
 *              applies, plus generated / build / lockfile / benchmark output
 *   vectors    Laya's embedding of each line, computed ONCE in the background
 *              (prewarm, at project attach) and persisted in LAIN's machine-local
 *              cache — `<LAIN home>/workercache/laya/<project>/` — never in the
 *              source tree, so git never sees it and a read-only project stays
 *              byte-identical
 *   ranking    a task's Laya inference is the QUERY embedding only; cosine
 *              against the prepared vectors runs here, in microseconds
 *
 * KEYING. A file's vector is reused only when its CONTENT fingerprint (sha1 of
 * the bytes — never the mtime) and its embedded TEXT are both unchanged, and
 * the whole store only when the embedding identity (Laya model + adapter
 * embedding schema + item schema) matches exactly. Otherwise it is recomputed:
 * vectors from an incompatible encoder are never compared.
 *
 * A RENAME is a re-embed. The path is part of the embedded text, so the old
 * vector is not the new file's vector even when the bytes are identical —
 * reusing it would be wrong, and correctness comes first.
 *
 * HOLDS NO AUTHORITY: it ranks candidates it is given. It never chooses the
 * candidate universe (Core's deterministic tier does, locateassist.js), never
 * sees the user's constraints, and never writes anything but its own cache.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Bumped whenever the embedded TEXT's shape changes — every stored vector is then invalid. */
const ITEM_SCHEMA = 'laya-items-v2';
/** Bumped whenever the store's file layout changes. */
const STORE_VERSION = 1;
const MAX_FILES = 1500;
const MAX_HASH_BYTES = 2_000_000;
const TEXT_MAX = 300;

/** Worth embedding as evidence about behaviour. */
const TEXTY = /\.(m?[jt]sx?|cjs|py|rs|go|java|kt|cs|rb|php|swift|css|scss|html?|vue|svelte|md|json|ya?ml|toml|sql|sh|ps1)$/i;
/**
 * NEVER EMBEDDED: output, not source. On top of the walk's own exclusions
 * (tools/search.js — node_modules, .git, …), which this does not duplicate.
 */
const GENERATED = /(^|\/)(?:dist|build|coverage|\.next|\.nuxt|\.cache|\.turbo|__pycache__|\.venv|venv|target|\.lain|\.noema)(?:\/|$)|(^|\/)bench(?:marks?)?\/out\/|\.min\.(?:js|css)$|\.map$|(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock)$/i;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** The project's canonical identity: one key for every spelling of its path. */
function canonical(root) {
  let r = path.resolve(String(root || '.'));
  try { r = fs.realpathSync.native(r); } catch { /* not there: the resolved path */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
function projectKey(root) { return sha1(canonical(root)).slice(0, 16); }

function headLine(src) {
  for (const raw of String(src).slice(0, 2048).split(/\r?\n/)) {
    const l = raw.trim();
    const m = l.match(/^(?:\/\*\*?|\*|\/\/+|#+|<!--|"""|<title>)\s*(.+?)(?:\*\/|-->|<\/title>)?$/);
    if (!m) continue;
    const t = m[1].replace(/^[*\s]+/, '').trim();
    if (t.length >= 8 && !/^(use strict|eslint|@ts-|!|-{3,}|={3,})/i.test(t)) return t.slice(0, 140);
  }
  return '';
}

/**
 * THE CANDIDATE LINES, from the project index held IN MEMORY.
 * @returns {{items:[{id,text,contentHash,textHash,imports}], considered, excluded, generation, index}}
 */
function items(root, { index = null } = {}) {
  const ix = index || require('./projectindex').fresh(root, { persist: false }).index;
  const files = (ix && ix.files) || {};
  const rels = Object.keys(files).sort();
  const excluded = { generated: 0, notText: 0, unreadable: 0, overCap: 0 };
  const out = [];
  for (const rel of rels) {
    if (GENERATED.test(rel)) { excluded.generated += 1; continue; }
    if (!TEXTY.test(rel)) { excluded.notText += 1; continue; }
    if (out.length >= MAX_FILES) { excluded.overCap += 1; continue; }
    const e = files[rel] || {};
    let buf;
    try {
      const abs = path.join(root, rel);
      if (fs.statSync(abs).size > MAX_HASH_BYTES) { excluded.unreadable += 1; continue; }
      buf = fs.readFileSync(abs);
    } catch { excluded.unreadable += 1; continue; }
    const syms = (e.symbols || []).filter((s) => !s.container).map((s) => s.name).slice(0, 12);
    const text = [rel, headLine(buf.toString('utf8')), syms.join(' ')].filter(Boolean).join(' — ').slice(0, TEXT_MAX);
    out.push({ id: rel, text, contentHash: sha1(buf), textHash: sha1(`${ITEM_SCHEMA}\0${text}`), imports: e.imports || [] });
  }
  return { items: out, considered: rels.length, excluded, generation: generation(out), index: ix };
}

/** One word for "this exact set of files, with this exact content". */
function generation(list) {
  return sha1(list.map((i) => `${i.id}\0${i.contentHash}\0${i.textHash}`).join('\n')).slice(0, 12);
}

/** The embedding identity. Vectors from different identities are never compared. */
function embedKey(meta) {
  if (!meta || !meta.model || !meta.schema) return null;
  return `${meta.model}|${meta.schema}|${ITEM_SCHEMA}`;
}

// ---- the store: LAIN's machine-local cache, never the project --------------------

/** `<LAIN home>/workercache/laya` — the worker host's sibling. */
function cacheRoot(hostDir) { return path.join(path.dirname(path.resolve(hostDir)), 'workercache', 'laya'); }
function storeDir(root, key) { return path.join(root, key); }

/**
 * @returns {{ok:true, byId:Map<id,{contentHash,textHash}>, vecs:Map<id,Float32Array>, meta, ms}|{ok:false, why}}
 */
function readStore(dir, key) {
  const t0 = Date.now();
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { return { ok: false, why: 'absent' }; }
  if (!meta || meta.version !== STORE_VERSION) return { ok: false, why: `store version ${meta && meta.version} != ${STORE_VERSION}` };
  if (meta.embedKey !== key) return { ok: false, why: `embedding identity changed (${meta.embedKey} → ${key})` };
  let buf;
  try { buf = fs.readFileSync(path.join(dir, 'vectors.f32')); } catch { return { ok: false, why: 'vectors missing' }; }
  const dim = Number(meta.dim) || 0;
  const rows = Object.keys(meta.files || {}).length;
  if (!dim || buf.length !== rows * dim * 4 || sha1(buf) !== meta.vectorsSha1) return { ok: false, why: 'vectors do not match the manifest' };
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const byId = new Map();
  const vecs = new Map();
  for (const [id, f] of Object.entries(meta.files)) {
    byId.set(id, { contentHash: f.contentHash, textHash: f.textHash });
    vecs.set(id, all.slice(f.row * dim, (f.row + 1) * dim));
  }
  return { ok: true, byId, vecs, dim, meta, ms: Date.now() - t0 };
}

/** Atomic: vectors first, then the manifest that vouches for them (by hash). */
function writeStore(dir, { key, dim, root, projectKey: pk, generation: gen, byId, vecs, metrics = null }) {
  const t0 = Date.now();
  fs.mkdirSync(dir, { recursive: true });
  const ids = [...byId.keys()].filter((id) => vecs.has(id)).sort();
  const buf = Buffer.alloc(ids.length * dim * 4);
  const files = {};
  ids.forEach((id, row) => {
    const v = vecs.get(id);
    Buffer.from(v.buffer, v.byteOffset, dim * 4).copy(buf, row * dim * 4);
    files[id] = { ...byId.get(id), row };
  });
  const tmpV = path.join(dir, `vectors.f32.${process.pid}.tmp`);
  fs.writeFileSync(tmpV, buf);
  fs.renameSync(tmpV, path.join(dir, 'vectors.f32'));
  const meta = { version: STORE_VERSION, embedKey: key, dim, root: canonical(root), projectKey: pk, generation: gen,
    writtenAt: new Date().toISOString(), vectorsSha1: sha1(buf), files, metrics };
  const tmpM = path.join(dir, `index.json.${process.pid}.tmp`);
  fs.writeFileSync(tmpM, JSON.stringify(meta));
  fs.renameSync(tmpM, path.join(dir, 'index.json'));
  return { bytes: buf.length + Buffer.byteLength(JSON.stringify(meta)), ms: Date.now() - t0 };
}

/**
 * WHAT A REFRESH MUST DO. A vector is reused only when the file's content AND
 * embedded text are unchanged; everything else is embedded; files that left
 * the candidate set are removed (no dead candidates in the ranking space).
 */
function plan(byId, vecs, list) {
  const reuse = [];
  const embed = [];
  const live = new Set();
  for (const it of list) {
    live.add(it.id);
    const had = byId.get(it.id);
    if (had && had.contentHash === it.contentHash && had.textHash === it.textHash && vecs.has(it.id)) reuse.push(it);
    else embed.push(it);
  }
  const removed = [...byId.keys()].filter((id) => !live.has(id));
  return { reuse, embed, removed };
}

// ---- vectors on the wire ---------------------------------------------------------

function fromB64(b64, dim) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const out = [];
  for (let i = 0; i + dim <= all.length; i += dim) out.push(all.slice(i, i + dim));
  return out;
}

function toB64(vectors) {
  const dim = vectors.length ? vectors[0].length : 0;
  const buf = Buffer.alloc(vectors.length * dim * 4);
  vectors.forEach((v, i) => Buffer.from(v.buffer, v.byteOffset, dim * 4).copy(buf, i * dim * 4));
  return buf.toString('base64');
}

/**
 * COSINE OVER THE PREPARED VECTORS — only candidates whose stored text is
 * exactly the current one are scored; anything else is reported as stale,
 * never ranked on an old vector.
 */
function rankCandidates(byId, vecs, qvec, candidates, k = 8) {
  const norm = (v) => { let s = 0; for (let i = 0; i < v.length; i += 1) s += v[i] * v[i]; return Math.sqrt(s) || 1; };
  const qn = norm(qvec);
  const scored = [];
  const stale = [];
  for (const c of candidates) {
    const had = byId.get(c.id);
    const v = vecs.get(c.id);
    if (!had || !v || had.textHash !== c.textHash) { stale.push(c.id); continue; }
    let dot = 0;
    for (let i = 0; i < v.length; i += 1) dot += v[i] * qvec[i];
    scored.push({ id: c.id, cos: +(dot / (qn * norm(v))).toFixed(4) });
  }
  scored.sort((a, b) => b.cos - a.cos);
  return { ranked: scored.slice(0, k), scored: scored.length, stale };
}

/**
 * READY FOR TASK — both axes: the model resident and answering, AND this
 * project's index usable (READY, or a STALE_PARTIAL whose refresh is not
 * running). A model that is hot over an absent or building index is NOT ready.
 */
function readyForTask(modelState, project, indexing = null) {
  if (!['HOT_IDLE', 'INFERENCING'].includes(modelState) || !project) return false;
  if (indexing) return false;
  return Boolean(project.usable != null ? project.usable : ['READY', 'STALE_PARTIAL'].includes(project.state));
}

module.exports = {
  readyForTask,
  ITEM_SCHEMA, STORE_VERSION, TEXTY, GENERATED, canonical, projectKey, items, generation, embedKey,
  cacheRoot, storeDir, readStore, writeStore, plan, fromB64, toB64, rankCandidates, headLine,
};
