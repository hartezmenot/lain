'use strict';

/** GIT AS AN INSTRUMENT — what the working tree says happened, versus what was meant to happen. */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/** A diff bigger than this in one file is worth remarking on. */
const BIG_FILE_LINES = 400;
/** A change set bigger than this in total is worth remarking on. */
const BIG_TOTAL_LINES = 1500;
/** Above this fraction of a file's lines touched, it is a rewrite not an edit. */
const REWRITE_FRACTION = 0.8;

/** Paths that are produced rather than written, and rarely belong in a diff. */
const GENERATED = [
  [/(?:^|\/)node_modules\//, 'a dependency directory'],
  [/(?:^|\/)(?:dist|build|out|target|coverage|\.next|__pycache__)\//, 'a build output directory'],
  [/\.min\.(?:js|css)$/, 'a minified bundle'],
  [/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock)$/, 'a lockfile'],
  [/\.(?:pyc|pyo|class|o|so|dll|exe)$/, 'a compiled artifact'],
  [/(?:^|\/)\.env(?:\.|$)/, 'an environment file, which may hold secrets'],
];

/** A READ-ONLY GIT QUESTION, asked directly (Phase 8.2). */
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 20_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err ? err.message : '')), code: err ? (Number.isInteger(err.code) ? err.code : 1) : 0 });
    });
  });
}

/** The working tree, from `--porcelain`, which is the machine-readable form and is stable across git versions in a way the human output is not. */
async function status(cwd) {
  const r = await git(cwd, ['status', '--porcelain=v1', '-uall', '--', '.']);
  if (!r.ok) return { ok: false, error: r.err.trim() || 'git status failed' };
  const files = [];
  for (const line of r.out.split('\n')) {
    if (!line.trim()) continue;
    const x = line[0];
    const y = line[1];
    let file = line.slice(3).trim();
    // A rename is reported as `old -> new`; the new name is the one that exists.
    const arrow = file.indexOf(' -> ');
    let from = null;
    if (arrow >= 0) { from = file.slice(0, arrow).trim(); file = file.slice(arrow + 4).trim(); }
    files.push({
      file: file.replace(/^"|"$/g, ''),
      from,
      staged: x !== ' ' && x !== '?',
      untracked: x === '?',
      deleted: x === 'D' || y === 'D',
      renamed: Boolean(from),
    });
  }
  return { ok: true, files };
}

/** Lines added and removed per file, for both the staged and unstaged halves. */
async function numstat(cwd) {
  const totals = new Map();
  for (const args of [
    // no-relative: numstat's names must sit in the same frame as status's.
    ['diff', '--numstat', '--no-relative', '--', '.'],
    ['diff', '--numstat', '--staged', '--no-relative', '--', '.'],
  ]) {
    const r = await git(cwd, args);
    if (!r.ok) continue;
    for (const line of r.out.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (!m) continue;
      const file = m[3].includes(' => ') ? m[3].replace(/.*=> /, '').replace(/[{}]/g, '') : m[3];
      const prev = totals.get(file) || { added: 0, removed: 0, binary: false };
      if (m[1] === '-' || m[2] === '-') prev.binary = true;
      else { prev.added += Number(m[1]); prev.removed += Number(m[2]); }
      totals.set(file, prev);
    }
  }
  return totals;
}

function countLines(abs) {
  try { return fs.readFileSync(abs, 'utf8').split('\n').length; } catch { return null; }
}

/** The whole assessment. */
async function review(cwd, { expected = [] } = {}) {
  // One rev-parse answers both entry questions at once: is cwd inside a work tree at all, and — the fact the frame conversion below turns on — how cwd…
  const pf = await git(cwd, ['rev-parse', '--is-inside-work-tree', '--show-prefix']);
  const pfl = String(pf.out || '').split('\n');
  if (!pf.ok || pfl[0].trim() !== 'true') {
    return { ok: false, error: 'not a git repository, so there is nothing to compare against' };
  }
  const st = await status(cwd);
  if (!st.ok) return { ok: false, error: st.error };
  const stats = await numstat(cwd);

  // THE TWO FRAMES, JOINED IN ONE PLACE
  const prefix = (pfl[1] || '').trim();
  const inCwd = (name) => (prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name);

  const want = new Set(expected.map((p) => {
    const rel = path.isAbsolute(p) ? path.relative(cwd, p) : p;
    return rel.replace(/\\/g, '/');
  }));

  const files = st.files.map((f) => {
    // The stats join happens in git's root frame — both sides as git reported them — and only then is the name converted to the cwd frame for everything…
    const s = stats.get(f.file) || { added: 0, removed: 0, binary: false };
    const total = s.added + s.removed;
    const file = inCwd(f.file);
    const lines = f.deleted ? null : countLines(path.join(cwd, file));
    const generated = GENERATED.find(([re]) => re.test(file));
    return {
      ...f,
      file,
      from: f.from ? inCwd(f.from) : f.from,
      added: s.added,
      removed: s.removed,
      binary: s.binary,
      lines,
      // A "rewrite" is a file where nearly every line is on both sides of the diff — the signature of writing a file back whole instead of patching it, and…
      rewrite: !f.deleted && !f.untracked && lines != null && lines > 30
        && s.removed >= lines * REWRITE_FRACTION && s.added >= lines * REWRITE_FRACTION,
      big: total >= BIG_FILE_LINES,
      generated: generated ? generated[1] : null,
      unexpected: want.size > 0 && !want.has(file),
    };
  });

  const totalLines = files.reduce((n, f) => n + f.added + f.removed, 0);
  return {
    ok: true,
    files,
    totalLines,
    huge: totalLines >= BIG_TOTAL_LINES,
    hadExpectation: want.size > 0,
    missing: [...want].filter((w) => !files.some((f) => f.file === w)),
  };
}

/** One line per file, then the observations that are worth a second look. */
function describe(r) {
  if (!r.ok) return r.error;
  if (!r.files.length) return 'The working tree is clean — git reports nothing changed, added or deleted.';

  const lines = [`${r.files.length} file(s) differ from the last commit, ${r.totalLines} line(s) in total.`];
  for (const f of r.files.slice(0, 40)) {
    const marks = [
      f.untracked ? 'NEW' : null,
      f.deleted ? 'DELETED' : null,
      f.renamed ? `renamed from ${f.from}` : null,
      f.binary ? 'binary' : null,
    ].filter(Boolean).join(' ');
    lines.push(`  ${f.file}  +${f.added} -${f.removed}${marks ? `  ${marks}` : ''}`);
  }
  if (r.files.length > 40) lines.push(`  [${r.files.length - 40} more]`);

  // WHAT IS WORTH A SECOND LOOK
  const notes = [];
  const rewrites = r.files.filter((f) => f.rewrite);
  if (rewrites.length) {
    notes.push(`WHOLE-FILE REWRITE: ${rewrites.map((f) => f.file).join(', ')} — nearly every line is on both `
      + 'sides of the diff. That is what writing a file back whole looks like, and what a reformat looks like. '
      + 'If a few lines were meant, the rest of the diff is unintended.');
  }
  const deleted = r.files.filter((f) => f.deleted);
  if (deleted.length) notes.push(`DELETED: ${deleted.map((f) => f.file).join(', ')}.`);
  const gen = r.files.filter((f) => f.generated);
  if (gen.length) {
    notes.push('GENERATED OR BUILT FILES in the change set: '
      + gen.map((f) => `${f.file} (${f.generated})`).join(', ')
      + ' — these are usually produced by a command rather than edited.');
  }
  const big = r.files.filter((f) => f.big && !f.rewrite && !f.untracked);
  if (big.length) notes.push(`LARGE: ${big.map((f) => `${f.file} (${f.added + f.removed} lines)`).join(', ')}.`);
  if (r.huge) notes.push(`The change set is ${r.totalLines} lines. If the task was small, most of this was not asked for.`);
  if (r.hadExpectation) {
    const surprise = r.files.filter((f) => f.unexpected);
    if (surprise.length) {
      notes.push(`NOT CHANGED BY THIS SESSION: ${surprise.map((f) => f.file).join(', ')} — these differ from the `
        + 'last commit but are not files LAIN wrote. They may have been dirty before this session started.');
    }
    if (r.missing.length) {
      // "No change" is two observations, not one: the write matched the committed bytes, or git never looks at the path at all
      notes.push(`WRITTEN BUT NOT DIFFERENT: ${r.missing.join(', ')} — LAIN wrote these and git reports no change `
        + 'for them: either the write produced the same bytes that were already there, or the path is not one '
        + 'git tracks (ignored, or outside this directory).');
    }
  }
  if (notes.length) lines.push('', 'WORTH A SECOND LOOK', ...notes.map((n) => `  ${n}`));
  return lines.join('\n');
}

module.exports = {
  review, describe, status, numstat,
  GENERATED, BIG_FILE_LINES, BIG_TOTAL_LINES, REWRITE_FRACTION,
};
