'use strict';

/**
 * WRITE LEASES — who may change which files while work runs in parallel (§32, §60).
 *
 * A background job or a subagent that owns files A/B holds a lease on them.
 * Anything else — the foreground turn, another subagent — is refused a write to
 * A/B until the lease is released; independent files C/D are untouched. The
 * holder itself writes freely inside its lease.
 *
 * Entries use the work-order scope grammar (a path, a glob, `path::symbol`);
 * overlap between two scopes is decided conservatively, because a false
 * "overlaps" costs a partition, and a false "independent" costs a collision.
 */

const path = require('path');

const held = new Map();   // holderId -> { holder, scope:[entries], label, since }

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').split('::')[0];

function globRe(glob) {
  const g = norm(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i += 1; if (g[i + 1] === '/') i += 1; continue; }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += '[^/]'; continue; }
    re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`, 'i');
}

function covers(entry, rel) {
  const e = norm(entry);
  const r = norm(rel);
  if (!e) return false;
  if (/[*?]/.test(e)) return globRe(e).test(r);
  return e.toLowerCase() === r.toLowerCase() || r.toLowerCase().startsWith(`${e.toLowerCase().replace(/\/$/, '')}/`);
}

/** The fixed prefix of an entry, before any wildcard. */
const stem = (e) => norm(e).split(/[*?]/)[0];

/** Can two scope entries name the same file? Conservative. */
function entriesOverlap(a, b) {
  const x = norm(a); const y = norm(b);
  if (covers(x, y) || covers(y, x)) return true;
  const sx = stem(x).toLowerCase(); const sy = stem(y).toLowerCase();
  if (/[*?]/.test(x) && /[*?]/.test(y)) return sx.startsWith(sy) || sy.startsWith(sx);
  return false;
}

function scopesOverlap(a = [], b = []) {
  for (const x of a) for (const y of b) if (entriesOverlap(x, y)) return { a: x, b: y };
  return null;
}

/**
 * Take a lease. Refused when it overlaps another holder's — overlapping write
 * ownership is exactly what must not exist.
 */
function acquire(holder, scope = [], label = '') {
  const id = String(holder);
  for (const h of held.values()) {
    if (h.holder === id) continue;
    const hit = scopesOverlap(scope, h.scope);
    if (hit) return { ok: false, why: `${hit.a} overlaps ${h.label || h.holder}'s ${hit.b}`, holder: h.holder };
  }
  held.set(id, { holder: id, scope: [...scope], label: label || id, since: Date.now() });
  return { ok: true };
}

function release(holder) { return held.delete(String(holder)); }
function all() { return [...held.values()].map((h) => ({ ...h, scope: [...h.scope] })); }

/**
 * May `writer` (null = the foreground) write this path? Checked at the one tool door.
 * @returns {{ok:true}|{ok:false, why:string, holder:string}}
 */
function check(writer, absOrRel, cwd = process.cwd()) {
  const rel = path.isAbsolute(String(absOrRel)) ? path.relative(cwd, String(absOrRel)) : String(absOrRel);
  for (const h of held.values()) {
    if (writer && h.holder === String(writer)) continue;
    if (h.scope.some((e) => covers(e, rel))) {
      return { ok: false, why: `${norm(rel)} is owned by ${h.label} until it finishes`, holder: h.holder };
    }
  }
  return { ok: true };
}

function _reset() { held.clear(); }

module.exports = { acquire, release, check, all, covers, entriesOverlap, scopesOverlap, _reset };
