'use strict';

/** LIGHTWEIGHT PROJECT CONTEXT. */

const fs = require('fs');
const path = require('path');

// `.lain` is LAIN's own record of the project (tasks, scratch, index): not the
// project's source, and never a place a rename or a search should report hits.
const SKIP = /^(?:node_modules|\.git|\.lain|\.noema|dist|build|out|target|vendor|__pycache__|\.venv|venv|coverage|\.next|\.cache|\.idea|\.vscode)$/i;
const MAX_ENTRIES = 40;
/** HOW MUCH OF THE PROJECT THE MODEL IS SHOWN BEFORE IT TOUCHES ANYTHING. */
const MAX_CHARS = 6800;   // 6000 → 6800 with MAX_DIR_LINE (2026-09-27); the brief is the cached prefix
const MAX_COMPLETIONS = 200;
/** Source directories summarised in the brief, and how many files each shows. */
const MAX_SOURCE_DIRS = 6;
const MAX_FILES_PER_DIR = 400;
/** How wide one directory line may get. See the loop in `brief`. */
// 2600 → 3200 (2026-09-16): LAIN's own src/ outgrew one line, and names past the cut (steerqueue.js, promptcache.js) stopped being listed.
const MAX_DIR_LINE = 4800;

/** Directories worth naming. */
const SOURCE_DIRS = /^(?:src|lib|app|source|pkg|internal|cmd|test|tests|spec|__tests__|bin|scripts|server|client|api|core)$/i;
const CODE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|cs|php|swift|kt|c|h|cc|cpp|hpp|sh|ps1)$/i;

/** Manifest → (language, how to run). Add a row; do not add a subsystem. */
const MANIFESTS = [
  { file: 'package.json', lang: 'javascript', run: (j) => Object.keys((j && j.scripts) || {}).slice(0, 6).map((s) => `npm run ${s}`) },
  { file: 'pyproject.toml', lang: 'python', run: () => ['python -m <module>'] },
  { file: 'requirements.txt', lang: 'python', run: () => ['python main.py'] },
  { file: 'Cargo.toml', lang: 'rust', run: () => ['cargo run', 'cargo test'] },
  { file: 'go.mod', lang: 'go', run: () => ['go run .', 'go test ./...'] },
  { file: 'pom.xml', lang: 'java', run: () => ['mvn test'] },
  { file: 'Makefile', lang: null, run: () => ['make'] },
];

/** One level inside a source directory: which code files are in it. */
function sourceFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const files = [];
  const subdirs = [];
  for (const e of names) {
    if (SKIP.test(e.name)) continue;
    if (e.isDirectory()) subdirs.push(e.name + '/');
    else if (CODE_EXT.test(e.name)) files.push(e.name);
  }
  if (!files.length && !subdirs.length) return null;
  return { files, subdirs };
}

function scan(cwd) {
  const root = cwd || process.cwd();
  const out = { root, languages: [], entries: [], run: [], manifests: [], tree: [] };

  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }

  for (const e of names) {
    if (SKIP.test(e.name)) continue;
    if (out.entries.length < MAX_ENTRIES) out.entries.push(e.isDirectory() ? e.name + '/' : e.name);
  }

  for (const m of MANIFESTS) {
    const p = path.join(root, m.file);
    if (!fs.existsSync(p)) continue;
    out.manifests.push(m.file);
    if (m.lang && !out.languages.includes(m.lang)) out.languages.push(m.lang);
    try {
      const parsed = m.file.endsWith('.json') ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
      for (const cmd of m.run(parsed) || []) if (!out.run.includes(cmd)) out.run.push(cmd);
    } catch { /* an unparseable manifest is not worth failing over */ }
  }

  // Extension census over the top level only — one level, no recursion.
  const byExt = new Map();
  for (const e of names) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (ext) byExt.set(ext, (byExt.get(ext) || 0) + 1);
  }
  const lang = { '.js': 'javascript', '.ts': 'typescript', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.rb': 'ruby', '.cs': 'csharp' };
  for (const [ext] of [...byExt.entries()].sort((a, b) => b[1] - a[1])) {
    const l = lang[ext];
    if (l && !out.languages.includes(l)) out.languages.push(l);
  }

  // ONE LEVEL INSIDE THE OBVIOUS SOURCE DIRECTORIES.
  for (const e of names) {
    if (!e.isDirectory() || SKIP.test(e.name)) continue;
    if (!SOURCE_DIRS.test(e.name)) continue;
    if (out.tree.length >= MAX_SOURCE_DIRS) break;
    const listing = sourceFiles(path.join(root, e.name));
    if (!listing) continue;
    out.tree.push({
      dir: e.name,
      files: listing.files.slice(0, MAX_FILES_PER_DIR),
      more: Math.max(0, listing.files.length - MAX_FILES_PER_DIR),
      subdirs: listing.subdirs.slice(0, MAX_FILES_PER_DIR),
    });
  }
  return out;
}

/** A bounded brief for the system prompt. Built once per session. */
/** WHAT THIS PROJECT IS — and it was already written down. */
const DOC_NAMES = /^(?:readme|contributing|architecture)\.(?:md|markdown|rst|txt)$/i;
/** How much of the opening prose is worth carrying. */
const MAX_DOC_INTRO = 420;
/** Section pointers listed. Beyond this a document is a book, not a map. */
const MAX_DOC_SECTIONS = 14;
/** Never read more of a document than this to find its headings. */
const MAX_DOC_BYTES = 400000;

/** A markdown line that is prose rather than furniture. */
function isProse(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^[#>|\-*+=`[!<]/.test(t)) return false;        // heading, quote, list, badge, table, html
  if (/^\d+[.)]\s/.test(t)) return false;             // ordered list
  return t.length > 30;
}

/** The project's own documentation, as an orientation block. */
function docBrief(root) {
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return ''; }
  const readme = names.find((e) => e.isFile() && DOC_NAMES.test(e.name) && /^readme/i.test(e.name));
  const parts = [];

  if (readme) {
    let text = '';
    try {
      const abs = path.join(root, readme.name);
      if (fs.statSync(abs).size <= MAX_DOC_BYTES) text = fs.readFileSync(abs, 'utf8');
    } catch { text = ''; }
    if (text) {
      const lines = text.split('\n');
      const intro = [];
      for (let i = 0; i < lines.length && intro.join(' ').length < MAX_DOC_INTRO; i++) {
        if (isProse(lines[i])) intro.push(lines[i].trim());
        else if (intro.length) break;                  // the paragraph ended
      }
      if (intro.length) {
        const said = intro.join(' ').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ');
        parts.push(`What this project says it is (${readme.name}): ${said.slice(0, MAX_DOC_INTRO)}`);
      }
      // SECTION POINTERS, with line numbers, so the answer is one ranged read.
      const heads = [];
      for (let i = 0; i < lines.length && heads.length < MAX_DOC_SECTIONS; i++) {
        const m = /^##\s+(.{2,60}?)\s*$/.exec(lines[i]);
        if (m) heads.push(`${m[1]} (line ${i + 1})`);
      }
      if (heads.length) {
        parts.push(`${readme.name} sections — read a RANGE of these rather than the file: ${heads.join(' · ')}`);
      }
    }
  }

  // Other documentation, named only. Where it is beats what it says.
  const docDirs = [];
  for (const d of ['docs', 'doc', 'documentation']) {
    try {
      const inside = fs.readdirSync(path.join(root, d)).filter((f) => /\.(?:md|rst|txt)$/i.test(f));
      if (inside.length) docDirs.push(`${d}/: ${inside.slice(0, 12).join(' ')}`);
    } catch { /* no such directory */ }
  }
  const others = names
    .filter((e) => e.isFile() && DOC_NAMES.test(e.name) && !/^readme/i.test(e.name))
    .map((e) => e.name);
  if (others.length) docDirs.push(others.join(' '));
  if (docDirs.length) parts.push(`Documentation: ${docDirs.join(' | ')}`);

  return parts.join('\n');
}

/** WHERE EXECUTION STARTS. */
function entryPoints(root) {
  const out = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (j && typeof j.bin === 'string') out.push(j.bin);
    else if (j && j.bin && typeof j.bin === 'object') out.push(...Object.values(j.bin).map(String));
    if (j && j.main) out.push(String(j.main));
  } catch { /* no manifest, or not JSON */ }
  return [...new Set(out)].slice(0, 4);
}

function brief(cwd) {
  const s = scan(cwd);
  const root = path.resolve(cwd || process.cwd());
  const parts = [];
  // MEANING BEFORE NAMES
  const docs = docBrief(root);
  if (docs) parts.push(docs);
  if (s.languages.length) parts.push(`Languages: ${s.languages.join(', ')}`);
  if (s.manifests.length) parts.push(`Manifests: ${s.manifests.join(', ')}`);
  if (s.run.length) parts.push(`Likely commands: ${s.run.slice(0, 4).join(' · ')}`);
  const entries = entryPoints(root);
  if (entries.length) parts.push(`Entry point(s): ${entries.join(' · ')}`);
  if (s.entries.length) parts.push(`Top level: ${s.entries.join(' ')}`);
  for (const t of s.tree) {
    const items = [...t.subdirs, ...t.files];
    if (!items.length) continue;
    // AS MANY NAMES AS FIT ON THE LINE, AND THE COUNT OF THE REST
    let room = MAX_DIR_LINE - t.dir.length - 3;
    const shown = [];
    let hidden = t.more || 0;
    for (const name of items) {
      if (room - (name.length + 1) < 0) { hidden += 1; continue; }
      room -= name.length + 1;
      shown.push(name);
    }
    if (!shown.length) continue;
    parts.push(`${t.dir}/: ${shown.join(' ')}${hidden ? ` (+${hidden} more)` : ''}`);
  }
  const out = parts.join('\n');
  if (out.length <= MAX_CHARS) return out;
  // CUT AT A LINE, AND SAY SO
  const cut = out.slice(0, MAX_CHARS);
  const at = cut.lastIndexOf(String.fromCharCode(10));
  return (at > 0 ? cut.slice(0, at) : cut) + String.fromCharCode(10)
    + '[listing cut to fit — not the whole project; use glob or list_dir for the rest]';
}

/** Path completion for the `@` menu. */
function completePath(cwd, prefix = '') {
  const raw = String(prefix || '').replace(/\\/g, '/');
  const slash = raw.lastIndexOf('/');
  const dirPart = slash >= 0 ? raw.slice(0, slash + 1) : '';
  const base = (slash >= 0 ? raw.slice(slash + 1) : raw).toLowerCase();

  const root = path.resolve(cwd || process.cwd());
  const dir = path.resolve(root, dirPart);
  // Never complete outside the project: `@../../` lists nothing rather than
  // offering the rest of the disk.
  const rel = path.relative(root, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return [];

  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  const out = [];
  for (const e of names) {
    if (SKIP.test(e.name)) continue;
    if (!base && e.name.startsWith('.')) continue;      // hidden only on request
    if (base && !e.name.toLowerCase().startsWith(base)) continue;
    out.push({ path: dirPart + e.name + (e.isDirectory() ? '/' : ''), isDir: e.isDirectory() });
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.path.localeCompare(b.path) : a.isDir ? -1 : 1));
  return out.slice(0, MAX_COMPLETIONS);
}

module.exports = { scan, brief, completePath, SKIP, MAX_CHARS, MAX_ENTRIES, MAX_COMPLETIONS };
