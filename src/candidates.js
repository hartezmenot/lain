'use strict';

/**
 * SUBAGENTS BUILD CANDIDATES; THE MAIN AGENT BUILDS THE PRODUCT (2026-09-23).
 *
 * ------------------------------------------------------------------------
 * THE INVARIANT. A subagent never writes the canonical project. Before this, a
 * FOUNDATION or IMPLEMENTER wrote the canonical tree directly under a write
 * lease: a faulty child could delete files outside its scope and nothing stood
 * between its tool calls and the person's project.
 *
 * Now every subagent that can change files or run commands works in an
 * ISOLATED WORKSPACE:
 *
 *   git project   a detached worktree seeded from the exact working state
 *                 (tracked + untracked, .gitignore respected) — abtest.js's
 *                 ref-less base commit; no branch, no stash, no index touched
 *   otherwise     a snapshot copy (dependency/build/VCS directories skipped)
 *
 * Dependency directories (node_modules, .venv) are linked, not copied, so a
 * test run works — they are the one shared thing, and are read in practice.
 *
 * ------------------------------------------------------------------------
 * WHAT COMES BACK IS A CANDIDATE, never a merge:
 *
 *   { id, role, objective, base, files:[{path, status, from, baseHash, after}],
 *     lines, verdict:{ok, reasons}, claim }
 *
 * checked BEFORE the main agent sees it (destructive-patch protection):
 *   - every changed path inside the declared writeScope, or REJECT;
 *   - a deletion only of a path named in ownedFiles, or REJECT;
 *   - a rename only when both ends are in scope, or REJECT;
 *   - binary changes and oversized patches REJECT (fail closed).
 *
 * The workspace is removed as soon as the candidate is harvested — no temp
 * worktree survives the delegate call.
 *
 * `integrate(id)` is the main agent's act. Each file goes through the SAME door
 * as the main agent's own writes (toolstep.run → mutation lifecycle →
 * checkpoint, undo, the inline Diff). A canonical file that changed since the
 * base is a CONFLICT and is not written. Nothing here merges on its own.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LINKED = ['node_modules', '.venv', 'venv'];
const SNAPSHOT_SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', 'out', 'target', '.lain', '.next', 'coverage', '__pycache__']);
const SNAPSHOT_MAX_FILE = 5 * 1024 * 1024;
const SNAPSHOT_MAX_FILES = 20000;
const MAX_LINES = 5000;
const MAX_FILES = 60;

function sha(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function norm(p) { return String(p || '').replace(/\\/g, '/'); }
const isBinary = (buf) => buf.includes(0);

function store(sessionId) { return path.join(require('./config').configDir(), 'candidates', String(sessionId || 'no-session')); }

function linkDeps(from, to) {
  for (const d of LINKED) {
    const src = path.join(from, d);
    const dst = path.join(to, d);
    try { if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst, 'junction'); } catch { /* tests may need an install; said by the child's own run */ }
  }
}

/** Walk the project for a snapshot: path → sha1. Bounded; skips dependency/VCS/build dirs. */
function manifest(root, keep = null) {
  const out = new Map();
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.size >= SNAPSHOT_MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SNAPSHOT_SKIP.has(e.name)) walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile() || (keep && !keep(r))) continue;
      const abs = path.join(dir, e.name);
      try { const st = fs.statSync(abs); if (st.size > SNAPSHOT_MAX_FILE) continue; out.set(r, sha(fs.readFileSync(abs))); } catch { /* unreadable: not part of the snapshot */ }
    }
  };
  walk(root, '');
  return out;
}

/**
 * AN ISOLATED WORKSPACE for one child. `cwd` inside it mirrors where the
 * session's cwd sits inside the project root.
 */
function isolate(app, label, contract = {}) {
  const ab = require('./abtest');
  const cwd = app.session.cwd;
  const top = ab.git(cwd, ['rev-parse', '--show-toplevel']);
  const hasHead = top.ok && ab.git(cwd, ['rev-parse', '--verify', 'HEAD']).ok;
  if (hasHead) {
    // BOTH SIDES REAL PATHS. git prints the long path; a cwd may be an 8.3 short
    // one (C:\Users\HARTEZ~1\…). Relating the two produced `../../..` and a
    // "workspace" cwd that pointed back INTO the canonical project.
    const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
    const root = real(path.resolve(top.out.trim()));
    const prefix = norm(path.relative(root, real(cwd)));
    if (prefix.startsWith('..') || path.isAbsolute(prefix)) return { ok: false, why: `the session directory is not inside its git root (${root})` };
    const base = ab.baseCommit(root);
    if (!base.ok) return { ok: false, why: base.why };
    const wt = ab.addWorktree(root, base.base, label);
    if (!wt.ok) return { ok: false, why: `could not create an isolated worktree: ${wt.why}` };
    linkDeps(root, wt.dir);
    // THE CANONICAL BYTES OF EVERYTHING IN SCOPE, NOW — what integration compares
    // against. Not the git blob: with autocrlf the working file differs from it.
    const scoped = manifest(root, (rel) => inScopeOf(contract, prefix, rel));
    return { ok: true, kind: 'worktree', root, base: base.base, dir: wt.dir, cwd: path.join(wt.dir, prefix), prefix, scoped };
  }
  // NOT A GIT PROJECT: a snapshot copy of what the manifest covers.
  const root = cwd;
  const before = manifest(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lain-sub-${label}-`));
  for (const rel of before.keys()) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dst);
  }
  linkDeps(root, dir);
  return { ok: true, kind: 'snapshot', root, base: null, dir, cwd: dir, manifest: before, prefix: '', scoped: before };
}

/** The base content hash of a canonical path, to detect a canonical change before integration. */
function baseHashOf(ws, rel) { return (ws.scoped && ws.scoped.get(rel)) || 'absent'; }

/**
 * LAIN'S OWN BOOKKEEPING is not the child's change. The read/write machinery
 * keeps project intelligence under `.lain/` (fingerprints, receipts), inside
 * the workspace too; counted, every candidate came back REJECTED as writing
 * outside its scope. It is never integrated.
 */
const OWN = /(^|\/)\.lain\//;

/** What the child changed, relative to the project root. */
function changes(ws) {
  return rawChanges(ws).filter((f) => !OWN.test(f.path) && !(f.from && OWN.test(f.from)));
}

function rawChanges(ws) {
  const out = [];
  if (ws.kind === 'worktree') {
    const ab = require('./abtest');
    ab.git(ws.dir, ['add', '-A']);
    const ns = ab.git(ws.dir, ['diff', '--cached', '--name-status', '-M', ws.base]);
    for (const row of ns.out.split('\n').filter(Boolean)) {
      const parts = row.split('\t');
      const code = parts[0][0];
      if (code === 'R') out.push({ status: 'R', from: norm(parts[1]), path: norm(parts[2]) });
      else out.push({ status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M', path: norm(parts[1]) });
    }
    return out;
  }
  const after = manifest(ws.dir);
  for (const [rel, h] of after) {
    if (LINKED.some((d) => rel === d || rel.startsWith(d + '/'))) continue;
    const was = ws.manifest.get(rel);
    if (!was) out.push({ status: 'A', path: rel });
    else if (was !== h) out.push({ status: 'M', path: rel });
  }
  for (const rel of ws.manifest.keys()) if (!after.has(rel)) out.push({ status: 'D', path: rel });
  return out;
}

/** Is a ROOT-relative path inside a contract's CWD-relative writeScope? */
function inScopeOf(contract, prefix, rel) {
  const leases = require('./leases');
  const r = norm(rel);
  const p = prefix ? norm(prefix).replace(/\/$/, '') + '/' : '';
  if (p && !r.startsWith(p)) return false;
  const local = r.slice(p.length);
  return (contract.writeScope || []).some((e) => leases.covers(e, local));
}

function lineDelta(a, b) {
  const x = String(a || '').split('\n');
  const y = String(b || '').split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return { added: y.length - i - j, removed: x.length - i - j };
}

/** Destructive-patch protection. Pure: the contract and the change list in, reasons out. */
function check(contract, files, prefix = '') {
  const inScope = (rel) => inScopeOf(contract, prefix, rel);
  const pre = prefix ? norm(prefix).replace(/\/$/, '') + '/' : '';
  const owned = new Set((contract.ownedFiles || []).map((o) => pre + norm(o).replace(/^\.\//, '')).filter((o) => !/[*?]/.test(o)));
  const reasons = [];
  for (const f of files) {
    if (!inScope(f.path)) reasons.push(`${f.path}: outside the declared writeScope`);
    if (f.status === 'D' && !owned.has(f.path)) reasons.push(`${f.path}: deleted, and deletion was not declared in ownedFiles`);
    if (f.status === 'R' && !inScope(f.from)) reasons.push(`${f.from} → ${f.path}: renamed from outside the writeScope`);
    if (f.binary) reasons.push(`${f.path}: binary change — integrate by hand`);
  }
  const lines = files.reduce((n, f) => n + (f.added || 0) + (f.removed || 0), 0);
  if (files.length > MAX_FILES) reasons.push(`${files.length} files changed (limit ${MAX_FILES})`);
  if (lines > MAX_LINES) reasons.push(`${lines} changed lines (limit ${MAX_LINES})`);
  return { ok: reasons.length === 0, reasons, lines };
}

/**
 * HARVEST the child's workspace into a stored candidate, then remove the
 * workspace. A role that may not write returns an EMPTY candidate whatever its
 * commands left behind (reported as discarded, never integrated).
 */
function harvest(app, ws, contract, { role = '', claim = '' } = {}) {
  const raw = changes(ws);
  const files = [];
  for (const f of raw) {
    const rec = { ...f, baseHash: baseHashOf(ws, f.status === 'R' ? f.from : f.path) };
    if (f.status === 'R') rec.baseHashTo = baseHashOf(ws, f.path);
    if (f.status !== 'D') {
      const buf = fs.readFileSync(path.join(ws.dir, f.path));
      rec.binary = isBinary(buf);
      rec.after = rec.binary ? null : buf.toString('utf8');
      const beforeAbs = path.join(ws.root, f.status === 'R' ? f.from : f.path);
      let before = '';
      try { before = f.status === 'A' ? '' : fs.readFileSync(beforeAbs, 'utf8'); } catch { before = ''; }
      Object.assign(rec, rec.binary ? { added: 0, removed: 0 } : lineDelta(before, rec.after));
    } else rec.removed = 0;
    files.push(rec);
  }
  const writes = require('./subagents').ROLES[role] && require('./subagents').ROLES[role].write;
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const cand = {
    id, role, objective: String(contract.objective || '').slice(0, 400), at: new Date().toISOString(),
    workspace: ws.kind, root: ws.root, base: ws.base,
    writeScope: contract.writeScope || [], ownedFiles: contract.ownedFiles || [],
    files: writes ? files : [], discarded: writes ? [] : files.map((f) => f.path),
    claim: String(claim || '').slice(0, 2000), state: 'PENDING',
  };
  cand.prefix = ws.prefix || '';
  cand.verdict = check(contract, cand.files, cand.prefix);
  cand.lines = cand.verdict.lines;
  if (cand.files.length) {
    try {
      const dir = store(app.session.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(cand), 'utf8');
    } catch { /* kept in memory for this process */ }
    app._candidates = app._candidates || new Map();
    app._candidates.set(id, cand);
  }
  return cand;
}

/** Remove the workspace. Always runs; a worktree is also pruned from git. */
function dispose(ws) {
  if (!ws || !ws.dir) return;
  // Unlink the dependency junctions FIRST, for either kind: a recursive removal
  // (ours, or git's worktree remove) that followed one would delete the
  // canonical node_modules.
  for (const d of LINKED) {
    const p = path.join(ws.dir, d);
    try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* not linked */ }
    try { if (fs.existsSync(p) && fs.realpathSync.native(p) !== p && fs.lstatSync(p).isDirectory()) fs.rmdirSync(p); } catch { /* a real directory stays for rmSync */ }
  }
  if (ws.kind === 'worktree') require('./abtest').cleanup(ws.root, [ws.dir]);
  else { try { fs.rmSync(ws.dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

function load(app, id) {
  const mem = app._candidates && app._candidates.get(id);
  if (mem) return mem;
  try { return JSON.parse(fs.readFileSync(path.join(store(app.session.id), `${id}.json`), 'utf8')); } catch { return null; }
}

/**
 * THE CANONICAL FILE'S LINE ENDINGS WIN. A worktree checkout may convert them
 * (core.autocrlf), so a child's edit arrived CRLF over an LF file and
 * integration rewrote every line (seen live, 2026-09-23). A new file is left
 * as the child wrote it.
 */
function eolLike(abs, text) {
  let cur = '';
  try { cur = fs.readFileSync(abs, 'utf8'); } catch { return text; }
  if (!/\n/.test(cur)) return text;
  const crlf = /\r\n/.test(cur);
  const lf = String(text).replace(/\r\n/g, '\n');
  return crlf ? lf.replace(/\n/g, '\r\n') : lf;
}

function currentHash(root, rel) {
  try { return sha(fs.readFileSync(path.join(root, rel))); } catch (e) { return e && e.code === 'ENOENT' ? 'absent' : 'unreadable'; }
}

/** A short, bounded account for the main agent: files, counts, verdict, and the first hunks. */
function describe(c, { hunkLines = 40 } = {}) {
  const lines = [`CANDIDATE ${c.id} · ${c.role} · ${c.files.length} file(s) · +${c.files.reduce((n, f) => n + (f.added || 0), 0)} -${c.files.reduce((n, f) => n + (f.removed || 0), 0)}`
    + ` · ${c.verdict.ok ? 'ACCEPTABLE' : 'REJECTED'} · ${c.state}`];
  for (const f of c.files) lines.push(`  ${f.status} ${f.status === 'R' ? `${f.from} → ` : ''}${f.path}  +${f.added || 0} -${f.removed || 0}`);
  for (const r of c.verdict.reasons) lines.push(`  ✗ ${r}`);
  if (c.discarded && c.discarded.length) lines.push(`  (${c.discarded.length} file(s) written by a read-only role's commands were discarded)`);
  let budget = hunkLines;
  for (const f of c.files) {
    if (budget <= 0 || f.after == null) break;
    let before = '';
    try { before = f.status === 'A' ? '' : fs.readFileSync(path.join(c.root, f.status === 'R' ? f.from : f.path), 'utf8'); } catch { before = ''; }
    const a = before.split('\n'); const b = f.after.split('\n');
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    const rem = a.slice(i, a.length - j).map((l) => `- ${l}`);
    const add = b.slice(i, b.length - j).map((l) => `+ ${l}`);
    const hunk = [...rem, ...add].slice(0, budget);
    if (!hunk.length) continue;
    lines.push(`  @@ ${f.path}:${i + 1}`, ...hunk.map((l) => `  ${l.slice(0, 160)}`));
    budget -= hunk.length;
  }
  return lines.join('\n');
}

/**
 * THE MAIN AGENT INTEGRATES. Each file is written through toolstep.run — the
 * same door, checkpoint and Diff as any write of its own. `only` limits it to
 * some files. A canonical file that moved since the base is a CONFLICT.
 */
async function integrate(ctx, id, { only = null } = {}) {
  const app = ctx && ctx.app;
  const c = app ? load(app, id) : null;
  if (!c) return { ok: false, why: `no candidate "${id}" in this session` };
  if (!c.verdict.ok) return { ok: false, why: `candidate ${id} was REJECTED: ${c.verdict.reasons.join('; ')}` };
  if (c.state === 'INTEGRATED') return { ok: false, why: `candidate ${id} is already integrated` };
  const toolstep = require('./toolstep');
  const want = only && only.length ? new Set(only.map(norm)) : null;
  const done = []; const conflicts = []; const failed = []; const mutated = [];
  const cwdRel = (rel) => path.relative(ctx.session.cwd, path.join(c.root, rel)) || rel;
  const write = async (name, input) => {
    const call = { id: `${id}-${done.length + failed.length}`, name, input };
    const { result } = await toolstep.run(call, { session: ctx.session, evidence: null, toolCtx: ctx });
    for (const m of result.mutated || []) mutated.push(m);
    return result;
  };
  for (const f of c.files) {
    if (want && !want.has(f.path)) continue;
    const src = f.status === 'R' ? f.from : f.path;
    if (currentHash(c.root, src) !== f.baseHash) { conflicts.push(`${src}: changed in the canonical tree since the candidate's base`); continue; }
    if (f.status === 'R' && currentHash(c.root, f.path) !== f.baseHashTo) { conflicts.push(`${f.path}: rename target changed since the base`); continue; }
    let r;
    // ANCHORED on the base hash just verified: the candidate was built on these
    // exact bytes, which is the inspection a blind-write guard asks for.
    const anchor = (h) => (h && h !== 'absent' && h !== 'unreadable' ? h : undefined);
    if (f.status === 'D') r = await write('delete_file', { path: cwdRel(f.path), _anchorSha1: anchor(f.baseHash) });
    else r = await write('write_file', { path: cwdRel(f.path), content: eolLike(path.join(c.root, src), f.after), _anchorSha1: anchor(f.status === 'R' ? f.baseHashTo : f.baseHash) });
    if (!r.isError && f.status === 'R') r = await write('delete_file', { path: cwdRel(f.from), _anchorSha1: anchor(f.baseHash) });
    (r.isError ? failed : done).push(r.isError ? `${f.path}: ${String(r.output).slice(0, 160)}` : f.path);
  }
  c.state = conflicts.length || failed.length ? (done.length ? 'PARTIAL' : c.state) : 'INTEGRATED';
  c.integrated = [...new Set([...(c.integrated || []), ...done])];
  try { fs.writeFileSync(path.join(store(app.session.id), `${c.id}.json`), JSON.stringify(c), 'utf8'); } catch { /* memory copy stands */ }
  return { ok: !conflicts.length && !failed.length, done, conflicts, failed, mutated, state: c.state };
}

function list(app) {
  const seen = new Map();
  try {
    const dir = store(app.session.id);
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) { try { const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); seen.set(c.id, c); } catch { /* skip */ } }
  } catch { /* none stored */ }
  for (const [k, v] of (app._candidates || new Map())) seen.set(k, v);
  return [...seen.values()];
}

module.exports = { isolate, harvest, dispose, check, integrate, describe, load, list, manifest, LINKED, MAX_LINES, MAX_FILES };
