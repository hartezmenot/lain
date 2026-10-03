'use strict';

/** CHECKPOINTS — a state you can get back to, not an archive you hope is right. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');

/** Directories never worth copying, and ruinous to copy. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '__pycache__', '.venv', 'venv']);
/** Refuse rather than spend minutes copying something enormous by surprise. */
const MAX_BYTES = 80 * 1024 * 1024;
const MAX_FILES = 5000;

function root() {
  return path.join(config.configDir(), 'backups');
}

function indexFile() {
  return path.join(root(), 'index.json');
}

/** Every checkpoint, newest first. Missing or unreadable reads as none. */
function list() {
  try {
    const j = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    const rows = Array.isArray(j) ? j : [];
    return rows.filter((r) => r && r.id).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  } catch { return []; }
}

function save(rows) {
  fs.mkdirSync(root(), { recursive: true });
  const f = indexFile();
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(rows, null, 2), 'utf8');
  fs.renameSync(`${f}.tmp`, f);
}

/** Walk a tree, refusing early if it is too large to copy sensibly. */
function survey(dir) {
  let bytes = 0;
  let files = 0;
  const out = [];
  const walk = (d, rel) => {
    if (bytes > MAX_BYTES || files > MAX_FILES) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(abs, r); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      bytes += st.size;
      files += 1;
      if (bytes > MAX_BYTES || files > MAX_FILES) return;
      out.push({ abs, rel: r });
    }
  };
  walk(dir, '');
  return { files: out, bytes, tooBig: bytes > MAX_BYTES || files > MAX_FILES };
}

/** The surroundings, recorded so a checkpoint says what world it came from. */
function surroundings() {
  const out = { config: null, v1: null };
  try {
    out.config = crypto.createHash('md5').update(fs.readFileSync(config.configFile())).digest('hex');
  } catch { out.config = null; }
  try {
    const { execFileSync } = require('child_process');
    out.v1 = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: path.join(require('os').homedir(), 'Documents', 'lain'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { out.v1 = null; }
  return out;
}

/** Take a checkpoint of `cwd`. */
function create(cwd, { label = '', reason = '', tests = null } = {}) {
  const seen = survey(cwd);
  if (seen.tooBig) {
    return {
      ok: false,
      why: `${path.basename(cwd)} is larger than a checkpoint should copy `
        + `(> ${Math.round(MAX_BYTES / 1024 / 1024)}MB or ${MAX_FILES} files). Nothing was written.`,
    };
  }
  const at = new Date();
  const id = `${at.toISOString().replace(/[-:T]/g, '').slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`;
  const dest = path.join(root(), id);
  for (const f of seen.files) {
    const to = path.join(dest, f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f.abs, to);
  }
  const stable = Boolean(tests && tests.failed === 0 && tests.passed > 0);
  const row = {
    id,
    at: at.toISOString(),
    cwd,
    label: String(label || '').slice(0, 80),
    reason: String(reason || '').slice(0, 200),
    tests: tests ? { passed: tests.passed, failed: tests.failed } : null,
    stable,
    files: seen.files.length,
    bytes: seen.bytes,
    ...surroundings(),
  };
  save([row, ...list()]);
  return { ok: true, row, dest };
}

/** Put `cwd` back to a checkpoint. */
function restore(cwd, id) {
  const row = list().find((r) => r.id === id);
  if (!row) return { ok: false, why: `no checkpoint "${id}"` };
  const from = path.join(root(), id);
  if (!fs.existsSync(from)) return { ok: false, why: `checkpoint ${id} has no stored files` };

  // A restore is a change, so it is itself checkpointed first.
  const safety = create(cwd, { label: 'before restore', reason: `restoring ${id}`, tests: null });

  let written = 0;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(abs, r); continue; }
      const to = path.join(cwd, r);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(abs, to);
      written += 1;
    }
  };
  walk(from, '');

  const now = survey(cwd);
  const restoredRels = new Set();
  const collect = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) collect(path.join(d, e.name), r);
      else restoredRels.add(r);
    }
  };
  collect(from, '');
  const extra = now.files.filter((f) => !restoredRels.has(f.rel)).map((f) => f.rel);

  return { ok: true, row, written, extra, safety: safety.ok ? safety.row : null };
}

module.exports = { list, create, restore, root, SKIP, MAX_BYTES, MAX_FILES };
