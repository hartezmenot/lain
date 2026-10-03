'use strict';

/** THE AUTHENTICATED BROWSER PROFILE — a second browser purpose, kept apart from the first on purpose. */

const fs = require('fs');
const path = require('path');
const config = require('../config');

/** Where every web-model profile lives. One parent, so the boundary is checkable. */
function root() {
  return path.join(config.configDir(), 'webmodels');
}

/** A source id reduced to something that is definitely a single path segment. */
function slug(sourceId) {
  const s = String(sourceId || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) throw new Error('a web model profile needs a source id');
  return s;
}

/** THE PROFILE DIRECTORY FOR ONE SOURCE, and the only way to get one. */
function pathFor(sourceId) {
  const dir = path.join(root(), slug(sourceId));
  const parent = path.resolve(root());
  if (path.resolve(dir) === parent || !path.resolve(dir).startsWith(parent + path.sep)) {
    throw new Error(`refusing a web model profile outside ${parent}`);
  }
  return dir;
}

/** Make it, if it is not there. Returns the path either way. */
function ensure(sourceId) {
  const dir = pathFor(sourceId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** HAS SOMEBODY LOGGED IN HERE BEFORE? */
function used(sourceId) {
  const dir = pathFor(sourceId);
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch { return false; }
  for (const marker of ['Default', 'Local State']) {
    try { fs.statSync(path.join(dir, marker)); return true; } catch { /* try the next */ }
  }
  return false;
}

/** WHAT A STATUS VIEW MAY KNOW. */
function describe(sourceId) {
  let dir = null;
  try { dir = pathFor(sourceId); } catch { dir = null; }
  return {
    sourceId: String(sourceId || ''),
    profilePath: dir,
    everUsed: dir ? used(sourceId) : false,
  };
}

/** SIGN OUT, PROPERLY — the only destructive operation here, and it is the person's own. */
function forget(sourceId) {
  const dir = pathFor(sourceId);           // throws before removing anything outside root
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    return { ok: true, removed: dir };
  } catch (e) {
    return { ok: false, why: `could not remove the saved login: ${(e && e.message) || e}` };
  }
}

/** THE ASSERTION THAT THE TWO BROWSER PURPOSES HAVE NOT MERGED. */
function isolatedFrom(otherProfilePath) {
  const other = path.resolve(String(otherProfilePath || ''));
  const mine = path.resolve(root());
  if (!other) return { ok: true, why: '' };
  if (other === mine || other.startsWith(mine + path.sep) || mine.startsWith(other + path.sep)) {
    return { ok: false, why: `the verification profile ${other} overlaps the web-model profile root ${mine}` };
  }
  return { ok: true, why: '' };
}

module.exports = { root, pathFor, ensure, used, describe, forget, isolatedFrom, slug };
