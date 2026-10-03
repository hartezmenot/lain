'use strict';

/** THE EVIDENCE LEDGER — a cache, never a prison. */

const fs = require('fs');
const path = require('path');

/** Below this, re-reading is cheap and a steer would be worse than the tokens. */
const LARGE_FILE_LINES = 250;

const BODY_READS = new Set(['read_file']);
const MUTATORS = new Set(['write_file', 'edit_file']);

function stampFor(cwd, p) {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  try {
    const st = fs.statSync(abs);
    return { size: st.size, mtime: Math.floor(st.mtimeMs) };
  } catch {
    return null; // missing file: never guarded — the error IS the answer
  }
}

function isTargeted(input) {
  return Boolean(input && (input.offset != null || input.limit != null));
}

class EvidenceLedger {
  constructor(cwd = process.cwd(), owner = null) {
    this.cwd = cwd;
    /** WHICH SESSION THIS LEDGER BELONGS TO. */
    this.owner = owner;
    this.byPath = new Map(); // norm abs path -> { stamp, lines, reads, firstSeenAt }
  }

  _absOf(p) { return path.isAbsolute(p) ? p : path.resolve(this.cwd, p); }

  _key(p) {
    const abs = path.isAbsolute(p) ? p : path.resolve(this.cwd, p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }

  record(p, stamp, { lines = 0 } = {}) {
    if (!p || !stamp) return;
    const key = this._key(p);
    const prev = this.byPath.get(key);
    if (prev && prev.stamp.size === stamp.size && prev.stamp.mtime === stamp.mtime) {
      prev.reads += 1;
      prev.bodyPresent = true;      // read again: the body is back in context
      return;
    }
    this.byPath.set(key, { stamp, lines, reads: 1, firstSeenAt: Date.now(), bodyPresent: true });
  }

  /** THE BODY WENT; WHAT WE KNOW DID NOT. */
  /** A CONFIRMED RANGE of a file (a ranged read, or the window of a narrowed one) — what a handover can name exactly: `server.ts:1309-1368`. */
  noteRange(p, [from, to] = []) {
    if (!p || !(from > 0) || !(to >= from)) return;
    const stampNow = stampFor(this.cwd, p);
    if (!stampNow) return;
    if (!this.ranges) this.ranges = new Map();
    const key = this._key(p);
    const list = (this.ranges.get(key) || []).filter((r) => r.stamp.size === stampNow.size && r.stamp.mtime === stampNow.mtime);
    list.push({ from, to, stamp: stampNow });
    list.sort((a, b) => a.from - b.from);
    const merged = [];
    for (const r of list) {
      const last = merged[merged.length - 1];
      if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to); else merged.push({ ...r });
    }
    this.ranges.set(key, merged.slice(-12));
  }

  /** Confirmed ranges still valid against disk, as `rel:from-to` strings. */
  confirmedRanges(limit = 8) {
    const out = [];
    for (const [abs, list] of (this.ranges || new Map())) {
      const now = stampFor(this.cwd, abs);
      if (!now) continue;
      const rel = path.relative(this.cwd, abs).replace(/\\/g, '/');
      for (const r of list) if (r.stamp.size === now.size && r.stamp.mtime === now.mtime) out.push(`${rel}:${r.from}-${r.to}`);
    }
    return out.slice(-limit);
  }

  elide(p) {
    if (!p) return;
    const e = this.byPath.get(this._key(p));
    if (e) e.bodyPresent = false;
  }

  lookup(p, stamp) {
    if (!p || !stamp) return null;
    const e = this.byPath.get(this._key(p));
    if (!e) return null;
    if (e.stamp.size !== stamp.size || e.stamp.mtime !== stamp.mtime) return null; // changed → stale
    return e;
  }

  invalidate(p) {
    if (!p) return;
    this.byPath.delete(this._key(p));
  }

  size() { return this.byPath.size; }

  /** Called BEFORE a tool runs. */
  check(name, input) {
    if (!BODY_READS.has(name)) return null;
    const p = input && input.path;
    if (!p) return null;
    if (isTargeted(input)) return null;             // never guard a targeted read
    const stamp = stampFor(this.cwd, p);
    if (!stamp) return null;                        // missing file → let it error
    const e = this.lookup(p, stamp);
    if (!e) return null;                            // unseen or changed
    // THE BODY IS GONE, SO THE CLAIM IS GONE.
    if (!e.bodyPresent) return null;
    if (e.lines < LARGE_FILE_LINES) return null;    // small file: not worth a steer

    return {
      output:
        `[evidence] ${p} (${e.lines} lines) is unchanged since you read it earlier this session, `
        + `so re-reading it produces the same bytes. `
        + `If you need a specific part again, read a range: read_file {"path":"${p}","offset":<line>,"limit":<n>} — `
        + `ranged reads are always served. Otherwise continue from what you already have.`,
      fromEvidence: true,
    };
  }

  /** Called AFTER a tool ran. */
  observe(name, input, result) {
    const p = input && input.path;
    // EVERY SUCCESSFUL MUTATION IS NOTED ACROSS SESSIONS, not just invalidated
    // within this one. See `noteWrite` for the hole that closes.
    for (const abs of (result && result.mutated) || []) noteWrite(this.cwd, abs, this.owner);
    // A write retires every READ RECEIPT of the file too — see readreceipts.js.
    for (const abs of (result && result.mutated) || []) require('./readreceipts').invalidate(this, abs);
    if (MUTATORS.has(name)) { if (p) { this.invalidate(p); require('./readreceipts').invalidate(this, this._absOf(p)); } return; }
    for (const abs of (result && result.mutated) || []) this.invalidate(abs);
    if (!BODY_READS.has(name) || !p) return;
    if (result && result.isError) return;
    if (result && result.fromEvidence) return;      // don't re-record a substitution
    // A TARGETED read is not whole-file evidence.
    if (isTargeted(input)) {
      const nums = String((result && result.output) || '').match(/^\s*(\d+)\t/gm) || [];
      if (nums.length) this.noteRange(p, [Number(nums[0].trim()), Number(nums[nums.length - 1].trim())]);
      return;
    }
    const meta = (result && result.meta) || {};
    const stamp = meta.size != null && meta.mtimeMs != null
      ? { size: meta.size, mtime: meta.mtimeMs }
      : stampFor(this.cwd, p);
    if (!stamp) return;
    const lines = meta.lines != null ? meta.lines : String((result && result.output) || '').split('\n').length;
    this.record(p, stamp, { lines });
  }

  /** Persisted so `/resume` restores the session's evidence, not just its text. */
  toJSON() {
    return {
      files: [...this.byPath.entries()].map(([abs, e]) => ({ path: abs, ...e })),
      receipts: require('./readreceipts').toJSON(this),
      ranges: [...(this.ranges || new Map()).entries()].map(([abs, list]) => ({ path: abs, list })),
    };
  }

  static from(rows, cwd, owner = null) {
    // The owner travels with the rows.
    const l = new EvidenceLedger(cwd, owner);
    // TWO SHAPES ON DISK: a bare array (every session saved before read receipts)
    // and { files, receipts }. Both restore; neither is rewritten here.
    const shaped = rows && !Array.isArray(rows) && typeof rows === 'object';
    if (shaped) require('./readreceipts').restore(l, rows.receipts);
    if (shaped && Array.isArray(rows.ranges)) l.ranges = new Map(rows.ranges.filter((r) => r && r.path && Array.isArray(r.list)).map((r) => [r.path, r.list]));
    for (const r of Array.isArray(rows) ? rows : (shaped && Array.isArray(rows.files) ? rows.files : [])) {
      if (!r || !r.path || !r.stamp) continue;
      l.byPath.set(r.path, {
        stamp: r.stamp, lines: r.lines || 0, reads: r.reads || 1, firstSeenAt: r.firstSeenAt || Date.now(),
        // A resumed session restores the LEDGER, not the elided bodies.
        bodyPresent: r.bodyPresent !== false,
      });
    }
    return l;
  }

  /** Compact, credential-free summary for a resume brief. */
  digest(limit = 8) {
    const all = [...this.byPath.entries()]
      .sort((a, b) => b[1].reads - a[1].reads || b[1].firstSeenAt - a[1].firstSeenAt)
      .slice(0, limit);
    if (!all.length && !this.confirmedRanges(1).length) return '';
    const label = ([abs, e]) => `  - ${path.basename(abs)} (${e.lines} lines${e.reads > 1 ? ` ×${e.reads}` : ''})`;
    const present = all.filter(([, e]) => e.bodyPresent !== false).map(label);
    // WHAT WAS READ, AND IS NO LONGER IN FRONT OF YOU
    const gone = all.filter(([, e]) => e.bodyPresent === false).map(label);
    const parts = [];
    if (present.length) parts.push('Already inspected this session (unchanged since):\n' + present.join('\n'));
    // CONFIRMED RANGES — exactly what is established, so the next model reads
    // only what is still missing instead of reacquiring the file (§15).
    const ranges = this.confirmedRanges(limit);
    if (ranges.length) parts.push('CONFIRMED READ (ranges, unchanged since):\n' + ranges.map((r) => `  - ${r}`).join('\n'));
    if (gone.length) {
      parts.push('NOT ESTABLISHED — read earlier, but the body has since been elided to fit the window; you no longer have it:\n'
        + gone.join('\n')
        + '\nFor these, check_symbols {list_symbols:true} gives the outline and read_symbol one definition; '
        + 'a ranged or whole read is still available if you actually need it.');
    }
    return parts.join('\n\n');
  }
}

/** HAS THIS FILE CHANGED SINCE LAIN READ IT, AND WHO CHANGED IT? */
function staleness(ledger, cwd, p) {
  const none = { stale: false, was: null, now: null };
  if (!ledger || !p) return none;
  let entry = null;
  try { entry = ledger.byPath.get(ledger._key(p)); } catch { entry = null; }
  if (!entry) return none;
  const now = stampFor(cwd, p);
  if (!now) return none;                       // gone: the write is the answer
  const was = entry.stamp;
  if (was.size === now.size && was.mtime === now.mtime) return none;
  return { stale: true, was, now };
}

/** The ledger a tool context carries, or null. One place that knows where it lives. */
function ledgerOf(ctx) {
  return (ctx && ctx.session && ctx.session.evidence) || null;
}

/** WHO WROTE WHAT, ACROSS EVERY SESSION IN THIS PROCESS. */
const MAX_WRITE_NOTES = 500;
const writes = new Map();   // key -> { stamp, by, at }

function worldKey(cwd, p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** Record that `by` mutated this path. Called from `observe` on every write. */
function noteWrite(cwd, p, by) {
  if (!p || !by) return;
  const key = worldKey(cwd, p);
  writes.delete(key);                       // re-insert so iteration order is age
  writes.set(key, { stamp: stampFor(cwd, p), by: String(by), at: Date.now() });
  while (writes.size > MAX_WRITE_NOTES) writes.delete(writes.keys().next().value);
}

/** Forget everything. For tests, and for a process starting a fresh run. */
function forgetWrites() { writes.clear(); }

/** HAS ANOTHER SESSION WRITTEN THIS FILE, WITH NOTHING IN OURS TO SAY SO? */
function foreignWrite(ledger, cwd, p, mine) {
  if (!p || !mine) return null;
  const note = writes.get(worldKey(cwd, p));
  if (!note || note.by === String(mine)) return null;
  try { if (ledger && ledger.byPath.get(ledger._key(p))) return null; } catch { /* no ledger */ }
  return note;
}

/** WAS THIS FILE EVER INSPECTED BY THE SESSION NOW ABOUT TO MUTATE IT? */
function noInspection(ledger, cwd, p, mine) {
  if (!ledger || !p) return null;
  let entry = null;
  try { entry = ledger.byPath.get(ledger._key(p)); } catch { entry = null; }
  if (entry) return null;                  // inspected: `staleness` answers first
  const now = stampFor(cwd, p);
  if (!now) return null;                   // absent: creation, not blindness
  if (mine) {
    const note = writes.get(worldKey(cwd, p));
    if (note && note.by === String(mine)
      && note.stamp && note.stamp.size === now.size && note.stamp.mtime === now.mtime) {
      return null;                         // ours, and untouched since
    }
  }
  return { now };
}

/** The identity a session mutates under. One place that decides what that is. */
function sessionIdOf(ctx) {
  return (ctx && ctx.session && ctx.session.id) || null;
}

module.exports = {
  EvidenceLedger, LARGE_FILE_LINES, stampFor, isTargeted, BODY_READS, MUTATORS,
  staleness, ledgerOf, noteWrite, forgetWrites, foreignWrite, noInspection, sessionIdOf,
  MAX_WRITE_NOTES,
};
