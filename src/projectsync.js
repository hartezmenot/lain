'use strict';

/**
 * THE SEAM BETWEEN THE TWO STATE DOMAINS.
 *
 * ------------------------------------------------------------------------
 *     ~/.lain-v2/supervisor/projects/     THE RUNTIME'S BOOKKEEPING
 *         identity, and when it last synchronised a tree. Counts and a
 *         digest. Rust owns it, and it outlives every CLI process.
 *
 *     <project>/.lain/                    THE MATERIALISED INDEX
 *         symbols, imports, fingerprints, per file. It lives WITH the project
 *         because it describes the project — a checkout somebody clones has no
 *         business carrying another machine's home directory around.
 *
 * NEITHER IS A COPY OF THE OTHER, and that is the property this file exists to
 * keep. The runtime never holds a symbol table; the project never holds a
 * record of which machines have opened it. On the day they disagreed there
 * would be nothing to reconcile, because they describe different things.
 *
 * ------------------------------------------------------------------------
 * WHO DECIDES WHAT.
 *
 *     the worker    reads the tree and says what it found      (projectindex)
 *     Rust          says whether that matches what it recorded (projects.rs)
 *     this file     carries one to the other
 *
 * The decision is the RUNTIME'S because it has to survive the process that
 * computed it: a CLI that opens a project, indexes it and exits has learned
 * something no session file records, and the next CLI would rediscover it.
 *
 * ------------------------------------------------------------------------
 * IT DEGRADES TO EXACTLY THE OLD BEHAVIOUR. With no supervisor running, the
 * index still refreshes and every query still answers — the verdict is simply
 * `UNKNOWN` and nothing is recorded. Project intelligence must not require a
 * background process to be up.
 */

const projectindex = require('./projectindex');

/** A local call should be instant; hanging is the failure. */
const TIMEOUT_MS = 3000;

/**
 * A CHEAP SUMMARY OF WHAT THE TREE LOOKS LIKE NOW.
 *
 * Built from the fingerprints the index already holds, so it costs nothing
 * beyond the stat walk that was happening anyway. It is COMPARED, never
 * interpreted: the runtime asks only whether this string equals the one it
 * recorded, so its internal shape is this file's business alone.
 *
 * FNV-1a over `path:size:mtime` per file, in sorted order. Sorted because a
 * directory walk does not promise an order and a digest that changed with the
 * filesystem's mood would report every project as modified.
 */
function digestOf(index) {
  const files = Object.entries((index && index.files) || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let h = 0xcbf29ce4n;
  let lo = 0x84222325n;
  // 64-bit FNV in two halves, so this stays exact in a language with 53-bit
  // integers. A collision here would report a changed tree as unchanged, which
  // is the one wrong answer worth this much care.
  let hash = (h << 32n) | lo;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const [rel, e] of files) {
    const line = `${rel}:${e.size}:${e.mtime}`;
    for (let i = 0; i < line.length; i++) {
      hash ^= BigInt(line.charCodeAt(i) & 0xff);
      hash = (hash * prime) & mask;
    }
  }
  return `${files.length}-${hash.toString(16)}`;
}

/**
 * OPEN A PROJECT: refresh the index, and tell the runtime what was found.
 *
 * @returns {Promise<{verdict:string, index:object, refresh:object, project:object|null}>}
 *   `verdict` is the RUNTIME'S: NEW, UNCHANGED, MODIFIED, RESHAPED — or
 *   UNKNOWN when no supervisor answered, which is not an error and not a claim.
 */
const fs = require('fs');
const path = require('path');
function bookFile() { return path.join(require('./config').configDir(), 'projects.json'); }
function readBook() { try { const d = JSON.parse(fs.readFileSync(bookFile(), 'utf8')); if (d && d.projects) return d; } catch { /* first use */ } return { v: 1, projects: {} }; }
function writeBook(d) {
  const keys = Object.keys(d.projects).sort((a, b) => (d.projects[b].opened_at || 0) - (d.projects[a].opened_at || 0));
  for (const k of keys.slice(500)) delete d.projects[k];
  const f = bookFile(); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(d)); fs.renameSync(`${f}.${process.pid}.tmp`, f);
}

async function open(root, { budgetMs } = {}) {
  // ---- THE WORKER READS THE TREE ----------------------------------------
  //
  // Stat every file, re-scan what moved. This happens FIRST because the digest
  // describes the tree as it is now, and the runtime's answer is a comparison
  // against it — asking before looking would be asking about nothing.
  // EXTERNAL CHANGES ARE WATCHED from the moment a project is opened, so the
  // next query re-measures only what an editor, git or a formatter touched.
  // LAIN_WATCH=0 turns it off (the test runner does, so temp trees can be removed).
  if (process.env.LAIN_WATCH !== '0') { try { require('./freshness').track(root); } catch { /* the stat walk still answers */ } }
  const refresh = projectindex.refresh(root, budgetMs ? { budgetMs } : {});
  const digest = digestOf(refresh.index);
  const symbols = Object.values(refresh.index.files || {})
    .reduce((n, e) => n + ((e.symbols || []).length), 0);

  // ---- WHAT THE LAST SESSION SAW (2026-10-02: a small Node record, no supervisor) ----------------
  //
  // Counts and a digest per project root, never the index: a symbol table here would be a second copy of the
  // project's own. NEW → never opened; UNCHANGED → the same digest; MODIFIED → it moved; RESHAPED → the index format.
  let verdict = 'UNKNOWN';
  let project = null;
  try {
    const book = readBook();
    const key = path.resolve(root).toLowerCase();
    const prev = book.projects[key] || null;
    verdict = !prev ? 'NEW' : prev.index_version !== projectindex.VERSION ? 'RESHAPED' : prev.digest === digest ? 'UNCHANGED' : 'MODIFIED';
    project = { path: root, digest, index_version: projectindex.VERSION, files: Object.keys(refresh.index.files || {}).length, symbols, opened_at: Date.now(), first_seen: prev ? prev.first_seen || prev.opened_at : Date.now() };
    book.projects[key] = project;
    writeBook(book);
  } catch { verdict = 'UNKNOWN'; }

  return { verdict, digest, index: refresh.index, refresh, project, symbols };
}

/**
 * What the runtime's verdict means, in a sentence a person can read.
 *
 * SAID RATHER THAN INFERRED. "Unchanged since you last opened it" is a fact the
 * runtime holds and nothing else does — the index alone can only say that
 * nothing moved since the last stat, which is a different and much weaker claim.
 */
function say(verdict, refresh) {
  const rescanned = (refresh.changed || 0) + (refresh.added || 0);
  switch (verdict) {
    case 'NEW':
      return `First time in this project — ${refresh.added} file(s) indexed.`;
    case 'UNCHANGED':
      return 'Unchanged since the last session. Nothing was re-read.';
    case 'MODIFIED':
      return `Changed since the last session — ${rescanned} file(s) re-read`
        + `${refresh.removed ? `, ${refresh.removed} gone` : ''}.`;
    case 'RESHAPED':
      return 'The index format changed, so it was rebuilt.';
    default:
      // NOT A GUESS: no record could be read, so say what the worker did without claiming the history.
      return `${refresh.reused} file(s) reused, ${rescanned} re-read `
        + '(no record of the last session could be read).';
  }
}

module.exports = { open, digestOf, say, TIMEOUT_MS };
