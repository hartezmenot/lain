'use strict';

/** `.lain/` — WHAT THIS PROJECT IS, KEPT BETWEEN SESSIONS. */

const fs = require('fs');
const path = require('path');

const search = require('./tools/search');
const codemodel = require('./codemodel');

/** The directory, inside the project being worked on: `.lain/`, or an existing Noema-era `.noema/` (projectmeta.js). */
const meta = require('./projectmeta');
const DIR = meta.CANON;
const INDEX = 'index.json';

/** Bumped when the shape changes, so an old index is rebuilt rather than misread. */
const VERSION = 1;

/** Files past this are recorded by identity only — parsing them is not worth it. */
const MAX_FILE_BYTES = 2_000_000;

/** A refresh that would take longer than this reports what it did and stops. */
const BUDGET_MS = 4000;

function dirFor(root) { return meta.dir(root); }
/** LAIN's own folder (either name) — never indexed. */
function ownRel(rel) { return meta.isMetaName(String(rel).split('/')[0]); }
function fileFor(root) { return path.join(dirFor(root), INDEX); }

function empty(root) {
  return { version: VERSION, root, builtAt: 0, refreshedAt: 0, files: {} };
}

/** Load what was written last time, or an empty index. */
function load(root) {
  try {
    const raw = fs.readFileSync(fileFor(root), 'utf8');
    const j = JSON.parse(raw);
    if (!j || j.version !== VERSION || !j.files || typeof j.files !== 'object') return empty(root);
    return { ...empty(root), ...j, root };
  } catch {
    return empty(root);
  }
}

function save(root, index) {
  // A HELD project (a declared read-only task — lainstore.hold) keeps the index
  // in memory for this process and writes nothing, like a read-only checkout.
  if (require('./lainstore').held(root)) return false;
  try {
    const created = !fs.existsSync(dirFor(root));
    fs.mkdirSync(dirFor(root), { recursive: true });
    if (created) require('./lainschema').stampNew(root);
    const tmp = path.join(dirFor(root), `${INDEX}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, fileFor(root));
    return true;
  } catch {
    // A PROJECT THAT CANNOT BE WRITTEN TO STILL WORKS
    return false;
  }
}

/** What a file looked like on disk, cheaply. */
function stampOf(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    return { size: st.size, mtime: Math.floor(st.mtimeMs) };
  } catch {
    return null;
  }
}

// WHICH FILES CARRY SYMBOLS IS THE SCANNER'S ANSWER, NOT A COPY OF IT.
const { supports } = require('./jsscan');

/** Everything the index records about one file. */
function scanOne(abs, rel, stamp) {
  const entry = { size: stamp.size, mtime: stamp.mtime, lang: supports(rel) ? 'js' : 'other' };
  if (entry.lang !== 'js' || stamp.size > MAX_FILE_BYTES) return entry;
  let model;
  try { model = codemodel.scanFile(abs); } catch { return entry; }
  // A FILE THIS INDEX CALLED SCANNABLE AND THE SCANNER REFUSES IS A CONTRADICTION, and it is recorded on the entry rather than silently becoming an empty…
  if (!model || !model.supported || !model.source) {
    entry.unscanned = (model && model.why) || 'the scanner returned nothing';
    return entry;
  }
  const src = model.source;
  entry.symbols = (model.symbols || []).map((s) => ({
    name: s.name,
    kind: s.kind,
    container: s.container || null,
    line: src.slice(0, s.start).split('\n').length,
  }));
  // `codemodel` records `{ spec, line }` and covers `require(...)` as well as `import` — which matters here, because this project is CommonJS and an…
  entry.imports = (model.imports || [])
    .map((i) => (typeof i === 'string' ? i : (i && i.spec) || ''))
    .filter(Boolean);
  return entry;
}

/** BRING THE INDEX UP TO DATE WITH THE DISK. */
function refresh(root, { budgetMs = BUDGET_MS, index = null, persist = true } = {}) {
  const started = Date.now();
  const ix = index || load(root);
  const before = ix.files || {};
  const files = {};
  let scanned = 0;
  let reused = 0;
  let changed = 0;
  let added = 0;
  let truncated = false;

  // LAZY, TARGETED REFRESH
  const freshness = require('./freshness');
  const dirty = Object.keys(before).length ? freshness.pending(root, ix.refreshedAt) : null;
  if (dirty) {
    Object.assign(files, before);
    for (const rel of dirty) {
      if (ownRel(rel) || freshness.IGNORE.test(rel)) continue;
      const abs = path.join(root, rel);
      const stamp = stampOf(abs);
      const prev = before[rel];
      if (!stamp) { if (prev) delete files[rel]; continue; }
      scanned += 1;
      if (prev && prev.size === stamp.size && prev.mtime === stamp.mtime) { reused += 1; continue; }
      files[rel] = scanOne(abs, rel, stamp);
      if (prev) changed += 1; else added += 1;
    }
    freshness.consume(root, dirty);
  }
  for (const f of (dirty ? [] : search.walk(root))) {
    // The index never indexes itself.
    if (ownRel(f.rel)) continue;
    const stamp = stampOf(f.abs);
    if (!stamp) continue;
    scanned += 1;
    const prev = before[f.rel];
    if (prev && prev.size === stamp.size && prev.mtime === stamp.mtime) {
      // THE WHOLE POINT
      files[f.rel] = prev;
      reused += 1;
      continue;
    }
    if (Date.now() - started > budgetMs) {
      // OUT OF TIME. What was already known is kept, and the caller is told the
      // pass was incomplete so it does not report a full refresh.
      if (prev) files[f.rel] = prev;
      truncated = true;
      continue;
    }
    files[f.rel] = scanOne(f.abs, f.rel, stamp);
    if (prev) changed += 1; else added += 1;
  }

  // Anything in the old index and no longer on disk is simply absent from the
  // new one — a deletion needs no special case.
  const removed = Object.keys(before).filter((k) => !files[k]).length;
  if (!dirty && !truncated) freshness.consume(root, [], { full: true });

  const next = {
    version: VERSION,
    root,
    builtAt: ix.builtAt || Date.now(),
    refreshedAt: Date.now(),
    files,
  };
  // `persist: false` — an IN-MEMORY refresh for machine-local consumers (the Laya project index, layaindex.js) that must never write the project's…
  const persisted = persist ? save(root, next) : false;
  return {
    index: next,
    scanned,
    reused,
    changed,
    added,
    removed,
    truncated,
    persisted,
    targeted: Boolean(dirty),
    ms: Date.now() - started,
  };
}

/** THE ONLY WAY TO GET AN INDEX. */
function fresh(root, opts = {}) {
  return refresh(root, opts);
}

// QUERIES — served from the index, so they cost no walk of their own.

/** Every declaration of `name`, across the project. */
function definitionsOf(index, name) {
  const out = [];
  for (const [rel, e] of Object.entries(index.files || {})) {
    for (const s of e.symbols || []) {
      if (s.name === name) out.push({ file: rel, ...s });
    }
  }
  return out;
}

/** Every file whose imports name `relPath`. */
function importersOf(index, relPath) {
  const target = String(relPath).replace(/\\/g, '/');
  const noExt = target.replace(/\.[^./]+$/, '');
  const base = path.posix.basename(noExt);
  const out = [];
  for (const [rel, e] of Object.entries(index.files || {})) {
    if (rel === target) continue;
    for (const spec of e.imports || []) {
      const s = String(spec).replace(/\\/g, '/').replace(/^\.\//, '');
      if (!s) continue;
      if (/^\.\.?\//.test(spec) || spec.startsWith('./')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), s));
        if (resolved === target || target.startsWith(resolved + '.')
          || target === `${resolved}/index.js` || target === `${resolved}/index.ts`) {
          out.push(rel);
          break;
        }
        continue;
      }
      if (s === target || s === noExt || s === base || target.endsWith('/' + s)) {
        out.push(rel);
        break;
      }
    }
  }
  return out;
}

/** What one file declares. */
function outlineOf(index, relPath) {
  const e = (index.files || {})[String(relPath).replace(/\\/g, '/')];
  return e && e.symbols ? e.symbols : [];
}

/** WHAT THIS PROJECT IS, IN ONE COMPACT BLOCK. */
function orientation(index, { changed = [], max = 12 } = {}) {
  const files = Object.entries(index.files || {});
  const js = files.filter(([, e]) => e.lang === 'js');
  const symbolCount = js.reduce((n, [, e]) => n + ((e.symbols || []).length), 0);
  const biggest = js
    .map(([rel, e]) => [rel, (e.symbols || []).length])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);

  const out = [
    'PROJECT INDEX',
    `  ${files.length} file(s) indexed · ${js.length} readable as code · ${symbolCount} declaration(s)`,
  ];
  if (biggest.length) {
    out.push('', 'LARGEST MODULES BY DECLARATION COUNT');
    for (const [rel, n] of biggest) out.push(`  ${String(n).padStart(4)}  ${rel}`);
  }
  if (changed.length) {
    out.push('', `CHANGED SINCE THE LAST SESSION (${changed.length})`);
    for (const c of changed.slice(0, max)) out.push(`  ${c}`);
    if (changed.length > max) out.push(`  [${changed.length - max} more]`);
  }
  out.push('', 'Ask `locate <name|path>` for anything specific. This block is a summary of an '
    + 'index on disk, not the index itself.');
  return out.join('\n');
}

/** HOW MUCH OF THIS PROJECT THE INDEX ACTUALLY KNOWS, AND WHAT IT MISSED. */
function coverage(root, { index = null, max = 8 } = {}) {
  const onDisk = index ? null : undefined;
  const ix = index || load(root);
  const persisted = fs.existsSync(fileFor(root));
  const entries = Object.entries(ix.files || {});
  const code = entries.filter(([, e]) => e.lang === 'js');
  const scanned = code.filter(([, e]) => Array.isArray(e.symbols));
  const unscanned = code.filter(([, e]) => !Array.isArray(e.symbols));
  const symbols = scanned.reduce((n, [, e]) => n + e.symbols.length, 0);
  const imports = scanned.reduce((n, [, e]) => n + ((e.imports || []).length), 0);

  // WHY each unscanned file was missed. A bucket called "we missed it" is the
  // thing this function exists to make impossible.
  const why = {};
  for (const [rel, e] of unscanned) {
    const reason = e.unscanned
      || (e.size > MAX_FILE_BYTES ? `over ${Math.round(MAX_FILE_BYTES / 1e6)} MB` : 'no reason recorded');
    (why[reason] = why[reason] || []).push(rel);
  }

  // STRUCTURAL COLLAPSE IS NOT FRESHNESS
  const COLLAPSE_FLOOR = 3;
  const collapsed = code.length >= COLLAPSE_FLOOR && scanned.length > 0 && symbols === 0;
  if (collapsed) {
    why['scanned, but nothing was declared — the scanner may have stopped understanding this language'] = scanned.map(([rel]) => rel).slice(0, 8);
  }

  const state = !persisted && !entries.length ? 'UNKNOWN'
    : (!entries.length ? 'STALE' : ((unscanned.length || collapsed) ? 'PARTIAL' : 'FRESH'));

  return {
    state,
    persisted,
    root: ix.root || root,
    refreshedAt: ix.refreshedAt || 0,
    discovered: entries.length,
    code: code.length,
    scanned: scanned.length,
    unscanned: unscanned.length,
    other: entries.length - code.length,
    symbols,
    imports,
    why,
    onDisk,
    lines: [
      'PROJECT INTELLIGENCE',
      `  files indexed      ${String(entries.length).padStart(6)}`,
      `  readable as code   ${String(code.length).padStart(6)}`,
      `  scanned            ${String(scanned.length).padStart(6)}`,
      `  declarations       ${String(symbols).padStart(6)}`,
      `  imports            ${String(imports).padStart(6)}`,
      `  not scanned        ${String(unscanned.length).padStart(6)}`,
      `  freshness          ${state}${persisted ? '' : ' (nothing persisted)'}`,
      ...Object.entries(why).flatMap(([reason, rels]) => [
        `    ${rels.length} × ${reason}`,
        ...rels.slice(0, max).map((r) => `      ${r}`),
        ...(rels.length > max ? [`      [${rels.length - max} more]`] : []),
      ]),
    ].join('\n'),
  };
}

module.exports = {
  DIR, INDEX, VERSION, BUDGET_MS, MAX_FILE_BYTES,
  load, save, refresh, fresh, stampOf, coverage,
  definitionsOf, importersOf, outlineOf, orientation,
  dirFor, fileFor, empty,
};
