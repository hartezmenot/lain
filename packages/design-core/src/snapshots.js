'use strict';

/**
 * UNDO AND REDO ARE FILE PATCHES, NOT COMMITS. Each Design commit records, per file, the exact bytes before and after
 * (and their hashes). Undo writes the before-bytes back only if the file is still exactly what that commit wrote —
 * a file changed since (by the person, the Agent, an editor) is never overwritten: the undo says so and stops.
 */

const fs = require('fs');
const path = require('path');
const { sha1 } = require('./text');

const MAX = 100;

class Snapshots {
  constructor(dir) {
    this.dir = dir || null;
    this.undo = []; this.redo = [];
    if (this.dir) {
      try { const s = JSON.parse(fs.readFileSync(path.join(this.dir, 'stack.json'), 'utf8')); this.undo = s.undo || []; this.redo = s.redo || []; } catch { /* a fresh stack */ }
    }
  }

  save() {
    if (!this.dir) return;
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(path.join(this.dir, 'stack.json'), JSON.stringify({ undo: this.undo, redo: this.redo })); } catch { /* in memory still */ }
  }

  /** A commit happened: `files` [{rel, before, after}]. A new commit clears Redo. */
  push(label, files, created = []) {
    const entry = {
      id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), label,
      files: files.map((f) => ({ rel: f.rel, before: f.before, after: f.after, beforeSha: sha1(f.before), afterSha: sha1(f.after) })),
      // FILES THIS COMMIT CREATED (an inserted asset): Undo removes them, Redo puts the same bytes back.
      created: created.map((b) => ({ rel: b.rel, b64: Buffer.from(b.bytes).toString('base64') })),
    };
    this.undo.push(entry); if (this.undo.length > MAX) this.undo.shift();
    this.redo = [];
    this.save();
    return entry;
  }

  list() { return { undo: this.undo.map((e) => ({ id: e.id, at: e.at, label: e.label, files: e.files.map((f) => f.rel) })).reverse(), redo: this.redo.map((e) => ({ id: e.id, label: e.label })).reverse() }; }

  /** Undo (or redo) one entry through `write(rel, text, expectSha)`. */
  step(root, which, write) {
    const from = which === 'undo' ? this.undo : this.redo;
    const to = which === 'undo' ? this.redo : this.undo;
    const e = from[from.length - 1];
    if (!e) return { ok: false, why: `nothing to ${which}` };
    // EVERY FILE MUST STILL BE WHAT THE ENTRY LEFT, before any is written.
    for (const f of e.files) {
      let cur = null;
      try { cur = fs.readFileSync(path.join(root, f.rel), 'utf8'); } catch { cur = null; }
      const want = which === 'undo' ? f.afterSha : f.beforeSha;
      if (cur == null || sha1(cur) !== want) return { ok: false, stale: true, why: `${f.rel} changed since "${e.label}" — nothing was ${which === 'undo' ? 'undone' : 'redone'}` };
    }
    for (const f of e.files) {
      const r = write(f.rel, which === 'undo' ? f.before : f.after, which === 'undo' ? f.afterSha : f.beforeSha);
      if (r && r.ok === false) return r;
    }
    for (const c of e.created || []) {
      const abs = path.join(root, c.rel); const bytes = Buffer.from(c.b64, 'base64');
      try {
        if (which === 'undo') { if (fs.existsSync(abs) && fs.readFileSync(abs).equals(bytes)) fs.unlinkSync(abs); }
        else if (!fs.existsSync(abs)) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, bytes); }
      } catch { /* the text files are the record; an asset left behind is harmless */ }
    }
    from.pop(); to.push(e); this.save();
    return { ok: true, label: e.label, files: e.files.map((f) => f.rel) };
  }

  /** Restore to just before a given entry (undo every newer one, in order). */
  restore(root, id, write) {
    const i = this.undo.findIndex((e) => e.id === id);
    if (i < 0) return { ok: false, why: `no snapshot ${id}` };
    const done = [];
    while (this.undo.length > i) {
      const r = this.step(root, 'undo', write);
      if (!r.ok) return { ...r, done };
      done.push(r.label);
    }
    return { ok: true, done };
  }
}

module.exports = { Snapshots };
