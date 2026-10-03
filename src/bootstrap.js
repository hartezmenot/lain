'use strict';

/** ENTERING A PROJECT LAIN HAS NEVER SEEN — deterministically, with no model. */

const fs = require('fs');
const path = require('path');

const MAX_BASELINE_FILES = 20_000;
const MAX_HASH_BYTES = 2_000_000;
const BUDGET_MS = 15_000;

/** Content fingerprints for the tree, bounded. Written to `.lain/fingerprints/baseline.json`. */
function baseline(root, { budgetMs = BUDGET_MS } = {}) {
  const started = Date.now();
  const search = require('./tools/search');
  const rr = require('./readreceipts');
  const files = {};
  let count = 0;
  let truncated = false;
  for (const f of search.walk(root)) {
    if (require('./projectmeta').isMetaName(f.rel.split('/')[0])) continue;
    if (count >= MAX_BASELINE_FILES || Date.now() - started > budgetMs) { truncated = true; break; }
    let st;
    try { st = fs.statSync(f.abs); } catch { continue; }
    const stamp = { size: st.size, mtime: Math.floor(st.mtimeMs) };
    if (st.size > MAX_HASH_BYTES) { files[f.rel] = { fp: `size:${st.size}`, ...stamp }; count += 1; continue; }
    const fp = rr.contentFingerprint(f.abs);
    if (fp) { files[f.rel] = { fp: fp.fp, ...stamp }; count += 1; }
  }
  const body = { at: Date.now(), files, count, truncated };
  const written = require('./lainstore').write(root, 'baseline', body);
  return { ...body, written, ms: Date.now() - started };
}

/** Directories by source-file count — the shape of the tree, without reading it. */
function topology(index) {
  const dirs = {};
  for (const rel of Object.keys(index.files || {})) {
    const d = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : '.';
    dirs[d] = (dirs[d] || 0) + 1;
  }
  return Object.entries(dirs).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([dir, files]) => ({ dir, files }));
}

/** Declared and conventional entry points: manifest `main`/`bin`, then well-known names. */
function entriesOf(root, rels) {
  const out = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.main) out.push(String(pkg.main).replace(/^\.\//, ''));
    if (typeof pkg.bin === 'string') out.push(pkg.bin.replace(/^\.\//, ''));
    else if (pkg.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) out.push(String(v).replace(/^\.\//, ''));
  } catch { /* no manifest */ }
  const CONVENTIONAL = /^(index\.(js|ts|mjs)|main\.(py|go|js|ts)|app\.py|__main__\.py|src\/main\.rs|src\/index\.(js|ts)|cmd\/[^/]+\/main\.go|manage\.py)$/;
  for (const rel of rels) if (CONVENTIONAL.test(rel)) out.push(rel);
  return [...new Set(out)].slice(0, 12);
}

/** THE WHOLE BOOTSTRAP. */
function bootstrap(root, { budgetMs = BUDGET_MS } = {}) {
  const started = Date.now();
  const r = path.resolve(String(root));
  const priorLain = require('./projectmeta').NAMES.some((n) => fs.existsSync(path.join(r, n)));
  try { require('./lainschema').ensure(r); } catch { /* an unwritable project still bootstraps in memory */ }

  const languages = require('./langscan').languages(r);
  const ix = require('./projectindex');
  const refresh = ix.refresh(r, { budgetMs });
  const index = refresh.index;
  const rels = Object.keys(index.files || {});
  let symbols = 0;
  let imports = 0;
  let parsed = 0;
  for (const rel of rels) {
    const e = index.files[rel];
    if (Array.isArray(e.symbols)) { parsed += 1; symbols += e.symbols.length; }
    imports += (e.imports || []).length;
  }
  // DEPENDENTS, resolved once for every parsed file: who imports it.
  const dependents = {};
  let edges = 0;
  for (const rel of rels) {
    if (!Array.isArray(index.files[rel].symbols)) continue;
    const who = ix.importersOf(index, rel);
    if (who.length) { dependents[rel] = who; edges += who.length; }
  }
  const entryPoints = entriesOf(r, rels);
  const base = baseline(r, { budgetMs });
  return {
    root: r,
    priorLain,
    files: rels.length,
    languages,
    parsed,
    symbols,
    imports,
    dependencyEdges: edges,
    dependents,
    topology: topology(index),
    entryPoints,
    baseline: { files: base.count, written: base.written, truncated: base.truncated },
    index: { persisted: refresh.persisted, truncated: refresh.truncated },
    llm: false,
    ms: Date.now() - started,
  };
}

module.exports = { bootstrap, baseline, topology, MAX_BASELINE_FILES };
