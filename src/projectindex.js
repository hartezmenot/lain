'use strict';

/**
 * `.lain/` — WHAT THIS PROJECT IS, KEPT BETWEEN SESSIONS.
 *
 * ------------------------------------------------------------------------
 * THE OBJECTION THIS HAS TO ANSWER FIRST, because it is written down in
 * codemodel.js and it was right:
 *
 *     NO STORE. Nothing here is written to disk or cached across a turn. V1's
 *     `.lain/index.json` was rebuilt at startup and then aged with every edit
 *     LAIN made, so it answered confidently from stale data for the rest of
 *     the session.
 *
 * That is a real failure and it is worse than having no index at all: a wrong
 * answer given confidently costs more than no answer. So the rule here is not
 * "cache harder". It is:
 *
 *     THE INDEX IS NEVER READ WITHOUT CHECKING THE DISK FIRST.
 *
 * Every query goes through `fresh()`, which stats the tree and re-scans
 * anything whose size or mtime moved. A `stat` of a few hundred files is
 * single-digit milliseconds; parsing them is not. The saving is real and the
 * staleness is structurally impossible, because the stale entry is replaced
 * BEFORE the question is answered rather than on a timer or at startup.
 *
 * ------------------------------------------------------------------------
 * WHAT IT IS FOR. A model opening this project reads a README, lists a tree,
 * greps, and reads a dozen files to learn what an index already knows — and
 * every one of those steps is a request carrying ~65,000 tokens. The point of
 * this file is that the SECOND session, and the second question in the first
 * session, cost a stat walk instead.
 *
 * ------------------------------------------------------------------------
 * WHAT IS IN IT, AND WHAT DELIBERATELY IS NOT.
 *
 *   files      per file: size, mtime, language, declared symbols, import
 *              specifiers. Enough to answer "where is X", "what does this file
 *              define", "who imports this".
 *
 * NOT the file contents. NOT the conversation. NOT anything the model said.
 * `.lain/` is machine state about the PROJECT, and it is never sent to a model
 * wholesale — a caller asks it a question and gets an answer. Shipping the
 * index into a prompt would recreate the cost it exists to remove.
 *
 * ------------------------------------------------------------------------
 * ITS LIMITS, STATED. The fingerprint is size + mtime, which is what `stat`
 * gives cheaply. An edit that changes neither — a deliberate timestamp forgery,
 * or a same-length rewrite within the same clock tick — is invisible to it.
 * Symbol extraction is `codemodel`'s, so it covers what jsscan supports and
 * records other languages by identity alone. Both are recorded in the answer
 * rather than papered over.
 */

const fs = require('fs');
const path = require('path');

const search = require('./tools/search');
const codemodel = require('./codemodel');

/** The directory, inside the project being worked on. */
const DIR = '.lain';
const INDEX = 'index.json';

/** Bumped when the shape changes, so an old index is rebuilt rather than misread. */
const VERSION = 1;

/** Files past this are recorded by identity only — parsing them is not worth it. */
const MAX_FILE_BYTES = 2_000_000;

/** A refresh that would take longer than this reports what it did and stops. */
const BUDGET_MS = 4000;

function dirFor(root) { return path.join(root, DIR); }
function fileFor(root) { return path.join(dirFor(root), INDEX); }

function empty(root) {
  return { version: VERSION, root, builtAt: 0, refreshedAt: 0, files: {} };
}

/**
 * Load what was written last time, or an empty index.
 *
 * A CORRUPT OR OLD INDEX IS AN EMPTY ONE, never an error and never a partial
 * read. The whole thing is rebuilt on the next refresh, which costs one pass —
 * and the alternative, half-trusting a file that did not parse, is the class of
 * bug this module is built to avoid.
 */
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
  try {
    const created = !fs.existsSync(dirFor(root));
    fs.mkdirSync(dirFor(root), { recursive: true });
    if (created) require('./lainschema').stampNew(root);
    const tmp = path.join(dirFor(root), `${INDEX}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, fileFor(root));
    return true;
  } catch {
    // ---- A PROJECT THAT CANNOT BE WRITTEN TO STILL WORKS -----------------
    //
    // A read-only checkout, a permission problem, a directory somebody has
    // deliberately locked down. The index degrades to per-session and every
    // query still answers; it simply pays the scan each time. Refusing to
    // operate would be a worse trade than being slower.
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
//
// This used to keep its own regex, and it disagreed with the scanner's: it
// admitted `.ts`/`.tsx`, the scanner did not, and `scanOne` quietly stored the
// file with no symbols. A whole TypeScript project indexed to zero symbols and
// nothing said so. There is one list now — see jsscan.js SUPPORTED.
const { supports } = require('./jsscan');

/** Everything the index records about one file. */
function scanOne(abs, rel, stamp) {
  const entry = { size: stamp.size, mtime: stamp.mtime, lang: supports(rel) ? 'js' : 'other' };
  if (entry.lang !== 'js' || stamp.size > MAX_FILE_BYTES) return entry;
  let model;
  try { model = codemodel.scanFile(abs); } catch { return entry; }
  // A FILE THIS INDEX CALLED SCANNABLE AND THE SCANNER REFUSES IS A CONTRADICTION,
  // and it is recorded on the entry rather than silently becoming an empty one.
  // `unscanned` is what a coverage report counts and what stops this exact
  // class of defect from being invisible again.
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
  // `codemodel` records `{ spec, line }` and covers `require(...)` as well as
  // `import` — which matters here, because this project is CommonJS and an
  // index that only understood ESM would have reported that nothing imports
  // anything. It did, until this line read the right field.
  entry.imports = (model.imports || [])
    .map((i) => (typeof i === 'string' ? i : (i && i.spec) || ''))
    .filter(Boolean);
  return entry;
}

/**
 * BRING THE INDEX UP TO DATE WITH THE DISK.
 *
 * Stats every file; re-scans only what moved. Returns what it did, because a
 * caller that cannot see the difference between "nothing changed" and "the
 * budget ran out" cannot report honestly either.
 */
function refresh(root, { budgetMs = BUDGET_MS, index = null } = {}) {
  const started = Date.now();
  const ix = index || load(root);
  const before = ix.files || {};
  const files = {};
  let scanned = 0;
  let reused = 0;
  let changed = 0;
  let added = 0;
  let truncated = false;

  // ---- LAZY, TARGETED REFRESH --------------------------------------------
  //
  // When a watcher has been running since before this index was last fully
  // refreshed, only the paths it saw change are re-measured. No watcher, an
  // overflow, or an older index: the stat walk below, which is always correct.
  const freshness = require('./freshness');
  const dirty = Object.keys(before).length ? freshness.pending(root, ix.refreshedAt) : null;
  if (dirty) {
    Object.assign(files, before);
    for (const rel of dirty) {
      if (rel === DIR || rel.startsWith(`${DIR}/`) || freshness.IGNORE.test(rel)) continue;
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
    if (f.rel === DIR || f.rel.startsWith(`${DIR}/`)) continue;
    const stamp = stampOf(f.abs);
    if (!stamp) continue;
    scanned += 1;
    const prev = before[f.rel];
    if (prev && prev.size === stamp.size && prev.mtime === stamp.mtime) {
      // ---- THE WHOLE POINT ----------------------------------------------
      //
      // Unchanged: keep what was learned last time. This is the line that
      // turns "read the project again" into a stat.
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
  const persisted = save(root, next);
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

/**
 * THE ONLY WAY TO GET AN INDEX. Never returns one without checking the disk.
 *
 * This is the answer to codemodel.js's objection: there is no accessor that
 * hands back what was written last time, so no caller can accidentally answer
 * from a stale entry — the staleness is not merely unlikely, it is unreachable.
 */
function fresh(root, opts = {}) {
  return refresh(root, opts);
}

// ---------------------------------------------------------------------------
// QUERIES — served from the index, so they cost no walk of their own.
// ---------------------------------------------------------------------------

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

/**
 * WHAT THIS PROJECT IS, IN ONE COMPACT BLOCK.
 *
 * The thing a model would otherwise spend four requests discovering. It is a
 * PROJECTION of the index, never the index: counts, the biggest modules, and
 * what changed since last time — not every symbol of every file.
 */
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

/**
 * HOW MUCH OF THIS PROJECT THE INDEX ACTUALLY KNOWS, AND WHAT IT MISSED.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS. The index once held a whole TypeScript project as 47 files
 * and ZERO symbols, and nothing anywhere said so: the files were admitted, the
 * scanner refused them, and the empty entries looked exactly like entries. A
 * number that would have made that obvious in one glance is worth more than the
 * comment explaining how it happened.
 *
 * SO EVERY FILE IS IN EXACTLY ONE BUCKET, and `unscanned` is never silent. This
 * is a DIAGNOSTIC — `/status` and the doctor ask for it — not a surface that
 * lives on screen.
 *
 * FRESH   everything admitted was scanned
 * PARTIAL something was admitted and could not be scanned, and it says which
 * STALE  nothing has been indexed yet, or the last refresh ran out of budget
 * UNKNOWN there is no index on disk at all
 */
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

  // ---- STRUCTURAL COLLAPSE IS NOT FRESHNESS ------------------------------
  //
  // THE FAILURE THIS CATCHES, which is the one that actually happened: a
  // TypeScript project indexed 47 files, every one of them "scanned", and
  // produced ZERO declarations — because the scanner admitted the extension and
  // then refused to parse it. Every count was green. `state` said FRESH. And
  // every structural question fell back to grep for the rest of the session,
  // with nothing anywhere saying why.
  //
  // A file with no declarations is ordinary (a config, a barrel, a constant). A
  // whole project of source files with no declarations between them is not a
  // project — it is a scanner that stopped working, and the honest word for it
  // is PARTIAL with a reason, never FRESH.
  //
  // BOUNDED SO IT CANNOT CRY WOLF: it takes effect only when there are enough
  // code files for "none of them declares anything" to be evidence rather than
  // coincidence.
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
