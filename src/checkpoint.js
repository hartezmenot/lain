'use strict';

/** REVERSIBILITY. LAIN's changes must be recoverable without depending on the model remembering what it did. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** What the file looked like when LAIN finished with it. */
function digest(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

/** The fingerprint of a path right now, or null when it does not exist. */
function digestOf(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return digest(fs.readFileSync(p));
  } catch { return null; }
}

/** WHAT ONE PATH HOLDS RIGHT NOW: existence, bytes (bounded) and a content fingerprint. */
function snapshot(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { existed: false, bytes: null, fp: null };
    const bytes = st.size <= MAX_FILE_BYTES ? fs.readFileSync(p) : null;
    return { existed: true, bytes, fp: bytes ? digest(bytes).slice(0, 16) : `size:${st.size}:${Math.floor(st.mtimeMs)}` };
  } catch { return { existed: false, bytes: null, fp: null }; }
}

class Checkpoints {
  constructor(sessionId, cwd, { load = false } = {}) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.entries = []; // [{ id, turnId, at, files: [{ path, existed, bytes|null }] }]
    if (load) this.load();
  }

  dir() { return path.join(config.configDir(), 'checkpoints', this.sessionId); }

  /** Read this session's checkpoints back. */
  load() {
    let names = [];
    try { names = fs.readdirSync(this.dir()); } catch { return this; }
    const ordered = names
      .map((n) => ({ n, seq: Number(/^c(\d+)$/.exec(n) ? /^c(\d+)$/.exec(n)[1] : NaN) }))
      .filter((x) => Number.isFinite(x.seq))
      .sort((a, b) => a.seq - b.seq);

    for (const { n } of ordered) {
      const d = path.join(this.dir(), n);
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')); } catch { continue; }
      if (!manifest || !Array.isArray(manifest.files)) continue;
      const files = [];
      for (const f of manifest.files) {
        // READ WHEN ASKED (2026-10-02): a resumed session used to load every snapshot's bytes up front (18 MB for one real session).
        const rec = { path: f.path, existed: Boolean(f.existed), after: f.after || null };
        const blob = f.blob ? path.join(d, f.blob) : null;
        let loaded = false; let bytes = null;
        Object.defineProperty(rec, 'bytes', {
          enumerable: true,
          get() { if (!loaded) { loaded = true; if (blob) { try { bytes = fs.readFileSync(blob); } catch { bytes = null; } } } return bytes; },
          set(v) { loaded = true; bytes = v; },
        });
        files.push(rec);
      }
      if (files.length) this.entries.push({ id: manifest.id || n, turnId: manifest.turnId || null, at: manifest.at || null, files });
    }
    return this;
  }

  /** Capture prior bytes for the paths a mutating call is about to touch. */
  capture(turnId, absPaths) {
    const files = [];
    for (const abs of absPaths || []) {
      let existed = false;
      let bytes = null;
      try {
        const st = fs.statSync(abs);
        existed = st.isFile();
        if (existed && st.size <= MAX_FILE_BYTES) bytes = fs.readFileSync(abs);
      } catch { existed = false; }
      // `after` is filled in by settle() once the mutating call has run.
      files.push({ path: abs, existed, bytes, after: undefined });
    }
    if (!files.length) return null;
    // Derived from the HIGHEST id present, not from the count.
    const nextSeq = this.entries.reduce((max, e) => {
      const m = /^c(\d+)$/.exec(e.id);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0) + 1;
    const entry = { id: `c${nextSeq}`, turnId, at: new Date().toISOString(), files };
    this.entries.push(entry);
    this._persist(entry);
    return entry;
  }

  /** Record what each file looks like NOW — immediately after the mutating call that this checkpoint was captured for. */
  settle(entry) {
    if (!entry) return null;
    for (const f of entry.files) f.after = digestOf(f.path);
    this._persist(entry);
    return entry;
  }

  _persist(entry) {
    try {
      const d = path.join(this.dir(), entry.id);
      fs.mkdirSync(d, { recursive: true });
      const manifest = entry.files.map((f, i) => ({
        path: f.path, existed: f.existed, blob: f.bytes ? `${i}.blob` : null,
        after: f.after === undefined ? null : f.after,
      }));
      for (let i = 0; i < entry.files.length; i++) {
        if (entry.files[i].bytes) fs.writeFileSync(path.join(d, `${i}.blob`), entry.files[i].bytes);
      }
      fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id: entry.id, turnId: entry.turnId, at: entry.at, files: manifest }, null, 2), 'utf8');
    } catch { /* a checkpoint that cannot be written must not break the edit */ }
  }

  /** What changed since a checkpoint, by comparing bytes on disk now. */
  diff(entry) {
    const rows = [];
    for (const f of entry.files) {
      let now = null;
      let exists = false;
      try { const st = fs.statSync(f.path); exists = st.isFile(); if (exists) now = fs.readFileSync(f.path); } catch { exists = false; }
      let kind;
      if (!f.existed && exists) kind = 'created';
      else if (f.existed && !exists) kind = 'deleted';
      else if (f.existed && exists && f.bytes && !f.bytes.equals(now)) kind = 'modified';
      else if (f.existed && exists) kind = 'unchanged';
      else kind = 'absent';
      rows.push({ path: f.path, kind, beforeBytes: f.bytes ? f.bytes.length : 0, afterBytes: now ? now.length : 0 });
    }
    return rows;
  }

  /** Restore the most recent checkpoint. */
  undo() {
    const entry = this.entries[this.entries.length - 1];
    if (!entry) return { ok: false, error: 'nothing to undo' };

    const stale = entry.files.filter((f) => f.after != null && digestOf(f.path) !== f.after);
    if (stale.length) {
      const names = stale.map((f) => path.relative(this.cwd, f.path) || f.path);
      return {
        ok: false,
        stale: true,
        error: `${names.join(', ')} changed after LAIN last wrote to it. `
          + 'Undoing would discard that change too, so nothing was touched.',
      };
    }

    this.entries.pop();
    const restored = [];
    for (const f of entry.files) {
      try {
        if (!f.existed) {
          // It did not exist before: undoing a creation removes it.
          try { fs.rmSync(f.path, { force: true }); restored.push({ path: f.path, action: 'removed' }); } catch { /* already gone */ }
        } else if (f.bytes) {
          fs.mkdirSync(path.dirname(f.path), { recursive: true });
          fs.writeFileSync(f.path, f.bytes);
          restored.push({ path: f.path, action: 'restored' });
        } else {
          restored.push({ path: f.path, action: 'skipped (too large to snapshot)' });
        }
      } catch (e) {
        restored.push({ path: f.path, action: `failed: ${e.message}` });
      }
    }
    // Discard the snapshot on disk too, or a later resume would load it back and offer to undo the same edit a second time — re-applying stale bytes over…
    try { fs.rmSync(path.join(this.dir(), entry.id), { recursive: true, force: true }); } catch { /* already gone */ }
    return { ok: true, id: entry.id, restored };
  }

  list() {
    return this.entries.map((e) => ({ id: e.id, turnId: e.turnId, at: e.at, files: e.files.map((f) => f.path) }));
  }
}

module.exports = { Checkpoints, MAX_FILE_BYTES, snapshot };
