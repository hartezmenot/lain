'use strict';

/**
 * MEMORY (Simplify S8): `~/.lain/projects/<id>/memory/` — one fact per markdown file, and `MEMORY.md`, an index of
 * one line per fact that is loaded into every session's prompt for that project. The model saves a fact when the
 * person asks it to remember something or it learns something durable (the `memory` tool); `/memory` lists and edits.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INDEX = 'MEMORY.md';
const MAX_INDEX = 8000;
const MAX_FACT = 4000;

/** The project's id: its folder name and a short hash of its full path. */
function projectId(root) {
  const abs = path.resolve(String(root || process.cwd()));
  const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const base = path.basename(abs).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40) || 'project';
  return `${base}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}

function dir(root) { return path.join(require('./config').configDir(), 'projects', projectId(root), 'memory'); }

function slug(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }

/** Every fact: { name, file, text, line }. */
function list(root) {
  const d = dir(root);
  let files = [];
  try { files = fs.readdirSync(d).filter((f) => f.endsWith('.md') && f !== INDEX).sort(); } catch { return []; }
  return files.map((f) => {
    const text = (() => { try { return fs.readFileSync(path.join(d, f), 'utf8').trim(); } catch { return ''; } })();
    return { name: f.replace(/\.md$/, ''), file: path.join(d, f), text, line: text.split(/\r?\n/).find((l) => l.trim()) || '' };
  });
}

/** Rewrite MEMORY.md from the facts: one line each. */
function reindex(root) {
  const d = dir(root);
  const facts = list(root);
  const body = facts.map((x) => `- [${x.name}](${x.name}.md) — ${x.line.replace(/^#+\s*/, '').slice(0, 160)}`).join('\n');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, INDEX), facts.length ? `${body}\n` : '');
  return facts.length;
}

function save(root, name, fact) {
  const n = slug(name);
  if (!n) return { ok: false, why: 'a memory needs a short name' };
  const text = String(fact || '').trim();
  if (!text) return { ok: false, why: 'a memory needs the fact' };
  const d = dir(root);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${n}.md`), `${text.slice(0, MAX_FACT)}\n`);
  reindex(root);
  return { ok: true, name: n, file: path.join(d, `${n}.md`) };
}

function forget(root, name) {
  const f = path.join(dir(root), `${slug(name)}.md`);
  if (!fs.existsSync(f)) return { ok: false, why: `no memory "${name}"` };
  fs.rmSync(f, { force: true });
  reindex(root);
  return { ok: true };
}

/** The prompt section: the index, or '' when there is none. */
function section(root) {
  let idx = '';
  try { idx = fs.readFileSync(path.join(dir(root), INDEX), 'utf8').trim(); } catch { idx = ''; }
  if (!idx) return '';
  return `# Memory (this project)\n${idx.slice(0, MAX_INDEX)}\nEach line names a file in ${dir(root)}; read one when you need the whole fact.`;
}

module.exports = { projectId, dir, list, save, forget, reindex, section, INDEX };
