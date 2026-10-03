'use strict';

/** THE SEAM BETWEEN THE TWO STATE DOMAINS. */

const projectindex = require('./projectindex');

/** A local call should be instant; hanging is the failure. */
const TIMEOUT_MS = 3000;

/** A CHEAP SUMMARY OF WHAT THE TREE LOOKS LIKE NOW. */
function digestOf(index) {
  const files = Object.entries((index && index.files) || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let h = 0xcbf29ce4n;
  let lo = 0x84222325n;
  // 64-bit FNV in two halves, so this stays exact in a language with 53-bit integers.
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

/** OPEN A PROJECT: refresh the index, and tell the runtime what was found. */
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
  // THE WORKER READS THE TREE
  if (process.env.LAIN_WATCH !== '0') { try { require('./freshness').track(root); } catch { /* the stat walk still answers */ } }
  const refresh = projectindex.refresh(root, budgetMs ? { budgetMs } : {});
  const digest = digestOf(refresh.index);
  const symbols = Object.values(refresh.index.files || {})
    .reduce((n, e) => n + ((e.symbols || []).length), 0);

  // WHAT THE LAST SESSION SAW (2026-10-02: a small Node record, no supervisor)
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

/** What the runtime's verdict means, in a sentence a person can read. */
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
