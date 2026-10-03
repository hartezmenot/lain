'use strict';

/**
 * AGENTS.md — BEHAVIOURAL INSTRUCTION, NEVER AUTHORITY.
 *
 * Two files, read if present, in this order:
 *
 *     ~/.lain/AGENTS.md              the person's standing policies, every project
 *     <project>/.lain/AGENTS.md      this project's conventions
 *
 * The project file is stated second so a project convention reads after — and
 * therefore refines — a global one.
 *
 * ------------------------------------------------------------------------
 * WHAT IT IS FOR: worker discipline, no unrelated refactors, test workers stay
 * read-only, return evidence, ask for scope rather than take it, the
 * repository's own conventions.
 *
 * WHAT IT IS NOT: a guard. Nothing in the runtime consults these words before a
 * write. Scope is enforced by workorderguard.js, staleness by the mutation
 * transaction, verification by verifycontract.js — so a model that ignores an
 * AGENTS.md line can still not write outside a bounded order. The prompt says
 * so, beside the text, so no reader mistakes one for the other.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 16_000;

/** LAIN.md IS THE CANONICAL CONSTITUTION (discipline/constitution.js) — LAIN's, not any one provider's. */
function firstExisting(list) { for (const f of list) if (fs.existsSync(f)) return f; return list[0]; }

/** `~/.lain/LAIN.md` — or a Noema-era NOEMA.md / an older AGENTS.md while none exists (the home moved to ~/.lain). */
function homeFile() {
  const base = process.env.LAIN_AGENTS_HOME || os.homedir();
  return firstExisting([path.join(base, '.lain', 'LAIN.md'), path.join(base, '.lain', 'NOEMA.md'), path.join(base, '.lain', 'AGENTS.md'), path.join(base, '.noema', 'NOEMA.md'), path.join(base, '.noema', 'AGENTS.md')]);
}

/** `<project>/.lain/LAIN.md` — or an existing LAIN.md / AGENTS.md in the project's folder while none exists. */
function projectFile(root) {
  const meta = require('./projectmeta');
  const r = String(root || process.cwd());
  return firstExisting([meta.file(r, 'LAIN.md'), meta.file(r, 'NOEMA.md'), meta.file(r, 'AGENTS.md')]);
}

function readCapped(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const truncated = Buffer.byteLength(text) > MAX_BYTES;
  if (truncated) text = Buffer.from(text).subarray(0, MAX_BYTES).toString('utf8');
  return { file, text: text.trim(), truncated, mtime: Math.floor(st.mtimeMs) };
}

/** Both layers, as found. */
function load(root) {
  return { global: readCapped(homeFile()), project: readCapped(projectFile(root)) };
}

/** The prompt section, or '' when neither file exists or both are empty. */
function forPrompt(root) {
  const { global, project } = load(root);
  const parts = [];
  const where = (f) => `${path.basename(path.dirname(f.file))}/${path.basename(f.file)}`;
  if (global && global.text) parts.push(`## Global (~/${where(global)})\n${global.text}${global.truncated ? '\n[truncated]' : ''}`);
  if (project && project.text) parts.push(`## This project (${where(project)})\n${project.text}${project.truncated ? '\n[truncated]' : ''}`);
  if (!parts.length) return '';
  return '# Project constitution (LAIN.md)\n'
    + 'Follow these as working policy. They are instructions, not permissions: write scope, staleness and '
    + 'verification are enforced by LAIN at runtime whatever this text says.\n\n'
    + parts.join('\n\n');
}

// editing

const DEFAULT_FILE = path.join(__dirname, 'defaults', 'AGENTS.md');
const SCOPES = Object.freeze(['global', 'project']);

function defaultText() { try { return fs.readFileSync(DEFAULT_FILE, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } }
function defaultVersion() { const m = /version\s+(\d+)/.exec(defaultText().split('\n')[0] || ''); return m ? Number(m[1]) : null; }

function fileFor(scope, root) {
  if (!SCOPES.includes(scope)) return null;
  if (scope === 'project' && !root) return null;
  return scope === 'global' ? homeFile() : projectFile(root);
}

/** One scope, as it is on disk (or absent). */
function read(scope, root) {
  const file = fileFor(scope, root);
  if (!file) return { ok: false, why: scope === 'project' ? 'no project is attached' : 'scope is global or project' };
  let text = null; let mtime = null;
  try { text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); mtime = Math.floor(fs.statSync(file).mtimeMs); } catch { text = null; }
  const def = defaultText();
  return { ok: true, scope, file, exists: text != null, text: text == null ? '' : text, bytes: text == null ? 0 : Buffer.byteLength(text), maxBytes: MAX_BYTES,
    isDefault: text != null && text.trim() === def.trim(), modified: text != null && text.trim() !== def.trim(), mtime, defaultVersion: defaultVersion() };
}

function write(scope, root, text) {
  // EVERY WRITE GOES TO LAIN.md — a LAIN.md or AGENTS.md is read until then, never written again.
  const file = SCOPES.includes(scope) && (scope === 'global' || root) ? (scope === 'global' ? path.join(process.env.LAIN_AGENTS_HOME || os.homedir(), '.lain', 'LAIN.md') : require('./projectmeta').file(String(root), 'LAIN.md')) : null;
  if (!file) return { ok: false, why: scope === 'project' ? 'no project is attached' : 'scope is global or project' };
  const t = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  if (Buffer.byteLength(t) > MAX_BYTES) return { ok: false, why: `LAIN.md is at most ${MAX_BYTES} bytes (LAIN reads no more than that)` };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t);
  return { ok: true, ...read(scope, root) };
}

/** Line diff (LCS) — small files only; `-` removed, `+` added, ` ` kept. */
function diff(a, b) {
  const x = String(a || '').split('\n'); const y = String(b || '').split('\n');
  if (x.length * y.length > 400000) return [{ op: '~', text: 'the files are too large to compare line by line' }];
  const L = Array.from({ length: x.length + 1 }, () => new Int32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ op: ' ', text: x[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ op: '-', text: x[i] }); i++; } else { out.push({ op: '+', text: y[j] }); j++; }
  }
  while (i < x.length) out.push({ op: '-', text: x[i++] });
  while (j < y.length) out.push({ op: '+', text: y[j++] });
  return out;
}

/** What Reset would do: the diff from the current file to LAIN's default. */
function resetPreview(scope, root) {
  const cur = read(scope, root);
  if (!cur.ok) return cur;
  const d = diff(cur.text, defaultText());
  return { ok: true, scope, file: cur.file, exists: cur.exists, modified: cur.modified, needsConfirm: cur.modified, defaultVersion: defaultVersion(),
    diff: d, changes: d.filter((x) => x.op !== ' ').length };
}

/** Restore LAIN's default. A modified file needs `confirm`, and is kept as a backup. */
function reset(scope, root, { confirm = false } = {}) {
  const cur = read(scope, root);
  if (!cur.ok) return cur;
  if (cur.modified && !confirm) return { ok: false, needsConfirm: true, why: 'this AGENTS.md was edited — confirm to replace it with LAIN’s default (a backup is kept)' };
  let backup = null;
  if (cur.exists && cur.modified) {
    backup = `${cur.file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(cur.file, backup);
  }
  const w = write(scope, root, defaultText());
  return w.ok ? { ...w, backup } : w;
}

/** Which files are in force, in order, and the combined text the Agent receives. */
function effective(root) {
  const g = read('global', root);
  const p = root ? read('project', root) : { ok: false };
  const layers = [
    { scope: 'global', file: g.file, active: Boolean(g.exists && g.text.trim()), note: 'every project' },
    { scope: 'project', file: p.ok ? p.file : null, active: Boolean(p.ok && p.exists && p.text.trim()), note: p.ok ? 'this project — read after, so it refines the global file' : 'no project attached' },
  ];
  return { layers, prompt: forPrompt(root) };
}

module.exports = { load, forPrompt, homeFile, projectFile, MAX_BYTES, read, write, reset, resetPreview, effective, diff, defaultText, defaultVersion, SCOPES };
