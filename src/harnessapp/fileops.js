'use strict';

/** THE IDE'S FILE OPERATIONS — new, rename, move, delete, Save As, and project search/replace. */

const fs = require('fs');
const path = require('path');
const source = require('./source');
// EVERY WRITE BELOW IS THE PERSON'S, THROUGH THE ONE MUTATION TRANSACTION (mutation.js `change`, actor USER): provenance, the project generation, the…
const mutation = require('../mutation');

const MAX_RESULTS = 2000;
const MAX_FILES_WITH_HITS = 400;
const MAX_LINE = 400;

function bad(why, extra = {}) { return { ok: false, why: String(why), ...extra }; }

/** A child path under the project, refused when it would escape or is empty. */
function target(app, rel) {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!r || r === '.' ) return bad('no path given');
  const at = source.locate(app, r);
  if (!at.ok) return at;
  if (at.rel === '.') return bad('that is the project folder itself');
  return at;
}

async function createFile(app, rel, body = '') {
  const at = target(app, rel);
  if (!at.ok) return at;
  if (fs.existsSync(at.abs)) return bad(`${at.rel} already exists`, { exists: true });
  return mutation.change(app, {
    name: 'ide.create_file', targets: [at.abs], what: `created ${at.rel}`,
    write: () => {
      try {
        fs.mkdirSync(path.dirname(at.abs), { recursive: true });
        fs.writeFileSync(at.abs, String(body || ''), { flag: 'wx' });
      } catch (e) { return bad(`cannot create ${at.rel}: ${(e && e.message) || e}`); }
      return { ok: true, path: at.rel };
    },
  });
}

function createFolder(app, rel) {
  const at = target(app, rel);
  if (!at.ok) return at;
  if (fs.existsSync(at.abs)) return bad(`${at.rel} already exists`, { exists: true });
  try { fs.mkdirSync(at.abs, { recursive: true }); } catch (e) { return bad(`cannot create ${at.rel}: ${(e && e.message) || e}`); }
  return { ok: true, path: at.rel };
}

/** Rename or move, inside the project, never over an existing file. */
async function rename(app, from, to) {
  const a = target(app, from);
  if (!a.ok) return a;
  const b = target(app, to);
  if (!b.ok) return b;
  if (!fs.existsSync(a.abs)) return bad(`${a.rel} no longer exists`);
  const sameFile = a.abs.toLowerCase() === b.abs.toLowerCase();
  if (fs.existsSync(b.abs) && !sameFile) return bad(`${b.rel} already exists`, { exists: true });
  if (path.resolve(b.abs).toLowerCase().startsWith(`${path.resolve(a.abs).toLowerCase()}${path.sep}`)) return bad('a folder cannot be moved into itself');
  // A FOLDER'S MOVE CHANGES EVERY FILE IN IT: those are the targets, from and to.
  const isDir = fs.statSync(a.abs).isDirectory();
  const olds = isDir ? mutation.filesUnder(a.abs) : [a.abs];
  const news = olds.map((p) => path.join(b.abs, path.relative(a.abs, p)));
  return mutation.change(app, {
    name: 'ide.move', targets: [...olds, ...(isDir ? news : [b.abs])], what: `moved ${a.rel} → ${b.rel}`,
    write: () => {
      try {
        fs.mkdirSync(path.dirname(b.abs), { recursive: true });
        fs.renameSync(a.abs, b.abs);
      } catch (e) { return bad(`cannot move ${a.rel}: ${(e && e.message) || e}`); }
      return { ok: true, from: a.rel, path: b.rel };
    },
  });
}

/** TO THE RECYCLE BIN. PowerShell's VisualBasic FileSystem is the documented .NET route to it, and it is present on every Windows. The path is passed as… */
function recycle(abs, isDir) {
  // A TEST PROFILE HAS ITS OWN BIN (tests/harness/isolation.js sets it), so an
  // automated run never puts anything in the person's real Recycle Bin.
  if (process.env.LAIN_TRASH_DIR) {
    try {
      const to = path.join(process.env.LAIN_TRASH_DIR, `${Date.now()}-${path.basename(abs)}`);
      fs.mkdirSync(process.env.LAIN_TRASH_DIR, { recursive: true });
      fs.renameSync(abs, to);
      return { ok: true };
    } catch (e) { return { ok: false, why: e.message }; }
  }
  if (process.platform !== 'win32') return { ok: false, why: 'the recycle bin is only reached on Windows' };
  // THE PATH TRAVELS IN THE ENVIRONMENT, not in the script text: nothing about
  // a file name can change what PowerShell runs.
  const script = "Add-Type -AssemblyName Microsoft.VisualBasic; $p=$env:LAIN_RECYCLE_PATH; "
    + (isDir
      ? "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')"
      : "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')");
  const r = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, LAIN_RECYCLE_PATH: abs },
  });
  if (r.status !== 0 || fs.existsSync(abs)) return { ok: false, why: (r.stderr || r.error && r.error.message || 'the recycle bin refused it').toString().trim().split('\n')[0] };
  return { ok: true };
}

async function remove(app, rel) {
  const at = target(app, rel);
  if (!at.ok) return at;
  let st;
  try { st = fs.statSync(at.abs); } catch { return bad(`${at.rel} no longer exists`); }
  const targets = st.isDirectory() ? mutation.filesUnder(at.abs) : [at.abs];
  return mutation.change(app, {
    name: 'ide.delete', targets, what: `deleted ${at.rel}`,
    write: () => {
      const r = recycle(at.abs, st.isDirectory());
      if (!r.ok) return bad(`${at.rel} was not deleted: ${r.why}`);
      return { ok: true, path: at.rel, recycled: true };
    },
  });
}

/** SAVE AS: a new path in the project, in the encoding asked for. */
async function saveAs(app, rel, body, { encoding = 'utf8', overwrite = false } = {}) {
  const at = target(app, rel);
  if (!at.ok) return at;
  if (fs.existsSync(at.abs) && !overwrite) return bad(`${at.rel} already exists`, { exists: true });
  return mutation.change(app, {
    name: 'ide.save_as', targets: [at.abs], what: `saved as ${at.rel}`,
    write: () => {
      try {
        fs.mkdirSync(path.dirname(at.abs), { recursive: true });
        fs.writeFileSync(at.abs, source.encode(String(body == null ? '' : body), encoding));
      } catch (e) { return bad(`cannot write ${at.rel}: ${(e && e.message) || e}`); }
      const text = source.readText(at.abs);
      const st = fs.statSync(at.abs);
      return { ok: true, path: at.rel, hash: source.digest(text), mtimeMs: st.mtimeMs, encoding };
    },
  });
}

// ---------------------------------------------------------------- search --

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** The pattern a search compiles to, or why it cannot. */
function pattern({ query, regex = false, caseSensitive = false, wholeWord = false }) {
  const q = String(query || '');
  if (!q) return { ok: false, why: 'nothing to search for' };
  let src = regex ? q : escapeRe(q);
  if (wholeWord) src = `\\b(?:${src})\\b`;
  try { return { ok: true, re: new RegExp(src, caseSensitive ? 'g' : 'gi') }; } catch (e) { return { ok: false, why: `not a valid regular expression: ${e.message}` }; }
}

function globs(list) {
  const { globToRegExp } = require('../tools/search');
  return String(list || '').split(',').map((g) => g.trim()).filter(Boolean)
    .map((g) => globToRegExp(g.includes('/') || g.startsWith('*') ? g : `**/${g}`));
}

function matchesAny(res, rel) {
  return res.some((re) => re.test(rel) || re.test(`${rel}/`) || rel.split('/').some((_, i, parts) => re.test(parts.slice(0, i + 1).join('/'))));
}

/** PROJECT SEARCH — every match, by file, with the line text around it. */
function search(app, opts = {}) {
  const p = pattern(opts);
  if (!p.ok) return p;
  const { walk, looksBinary } = require('../tools/search');
  const root = app.session.cwd;
  const inc = globs(opts.include);
  const exc = globs(opts.exclude);
  const files = [];
  let total = 0;
  let truncated = false;
  for (const f of walk(root)) {
    if (inc.length && !matchesAny(inc, f.rel)) continue;
    if (exc.length && matchesAny(exc, f.rel)) continue;
    let buf;
    try { buf = fs.readFileSync(f.abs); } catch { continue; }
    if (buf.length > source.MAX_FILE_BYTES || looksBinary(buf)) continue;
    const c = source.classify(buf);
    if (c.binary) continue;
    const lines = c.text.split(/\r?\n/);
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(lines[i]))) {
        hits.push({ line: i + 1, col: m.index + 1, len: m[0].length, text: lines[i].slice(0, MAX_LINE) });
        if (!m[0].length) p.re.lastIndex += 1;
        total += 1;
        if (total >= MAX_RESULTS) break;
      }
      if (total >= MAX_RESULTS) break;
    }
    if (hits.length) files.push({ path: f.rel, hash: source.digest(c.text), hits });
    if (total >= MAX_RESULTS || files.length >= MAX_FILES_WITH_HITS) { truncated = true; break; }
  }
  return { ok: true, files, total, truncated };
}

/** REPLACE IN FILES — only in the files the person saw in the results, and only where each is still the file that was searched (its hash). */
async function replace(app, opts = {}) {
  const p = pattern(opts);
  if (!p.ok) return p;
  const replacement = String(opts.replacement == null ? '' : opts.replacement);
  const done = [];
  const skipped = [];
  const plan = [];
  for (const want of Array.isArray(opts.files) ? opts.files.slice(0, MAX_FILES_WITH_HITS) : []) {
    const at = source.locate(app, want && want.path);
    if (!at.ok) { skipped.push({ path: want && want.path, why: at.why }); continue; }
    let buf;
    try { buf = fs.readFileSync(at.abs); } catch (e) { skipped.push({ path: at.rel, why: e.message }); continue; }
    const c = source.classify(buf);
    if (c.binary) { skipped.push({ path: at.rel, why: 'binary' }); continue; }
    if (want.hash && source.digest(c.text) !== want.hash) { skipped.push({ path: at.rel, why: 'changed since the search' }); continue; }
    let count = 0;
    const next = c.text.replace(p.re, (...m) => { count += 1; return opts.regex ? m[0].replace(new RegExp(p.re.source, p.re.flags.replace('g', '')), replacement) : replacement; });
    if (!count) continue;
    plan.push({ at, next, encoding: c.encoding, count });
  }
  if (!plan.length) return { ok: true, replaced: done, skipped, total: 0 };
  // ONE TRANSACTION FOR THE WHOLE REPLACE: one generation step, one delta.
  return mutation.change(app, {
    name: 'ide.replace', targets: plan.map((x) => x.at.abs), what: `replaced ${JSON.stringify(String(opts.query).slice(0, 40))} in ${plan.length} file(s)`,
    write: () => {
      for (const x of plan) {
        try { fs.writeFileSync(x.at.abs, source.encode(x.next, x.encoding)); } catch (e) { skipped.push({ path: x.at.rel, why: e.message }); continue; }
        done.push({ path: x.at.rel, count: x.count });
      }
      return { ok: true, replaced: done, skipped, total: done.reduce((n, d) => n + d.count, 0) };
    },
  });
}

module.exports = { createFile, createFolder, rename, remove, saveAs, search, replace, pattern };
