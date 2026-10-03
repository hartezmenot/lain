'use strict';

/** THE FRONTEND WORKSHOP BROWSER PROFILE — the THIRD browser purpose. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

/** Where every Workshop profile lives. One parent, so the boundary is checkable. */
function root() {
  return path.join(config.configDir(), 'workshop');
}

/** A project path reduced to one stable, safe path segment. */
function key(projectPath) {
  const abs = path.resolve(String(projectPath || ''));
  if (!abs) throw new Error('a workshop profile needs a project path');
  return crypto.createHash('sha256').update(abs).digest('hex').slice(0, 16);
}

/** THE PROFILE DIRECTORY FOR ONE PROJECT, and the only way to get one. */
function pathFor(projectPath) {
  const dir = path.join(root(), key(projectPath));
  const parent = path.resolve(root());
  if (!path.resolve(dir).startsWith(parent + path.sep)) {
    throw new Error(`refusing a workshop profile outside ${parent}`);
  }
  return dir;
}

function ensure(projectPath) {
  const dir = pathFor(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** THE ASSERTION THAT THE THREE PURPOSES HAVE NOT MERGED. */
function isolatedFrom(otherProfilePath) {
  const other = path.resolve(String(otherProfilePath || ''));
  const mine = path.resolve(root());
  if (!other) return { ok: true, why: '' };
  if (other === mine || other.startsWith(mine + path.sep) || mine.startsWith(other + path.sep)) {
    return { ok: false, why: `${other} overlaps the workshop profile root ${mine}` };
  }
  return { ok: true, why: '' };
}

/** What a status view may know. A path and a fact; never contents. */
function describe(projectPath) {
  let dir = null;
  try { dir = pathFor(projectPath); } catch { dir = null; }
  let used = false;
  try { used = Boolean(dir && fs.statSync(path.join(dir, 'Default')).isDirectory()); } catch { used = false; }
  return { projectPath: String(projectPath || ''), profilePath: dir, everUsed: used };
}

/** Remove one project's preview profile. Only reached when somebody asks. */
function forget(projectPath) {
  const dir = pathFor(projectPath);
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    return { ok: true, removed: dir };
  } catch (e) {
    return { ok: false, why: `could not remove the preview profile: ${(e && e.message) || e}` };
  }
}

module.exports = { root, key, pathFor, ensure, isolatedFrom, describe, forget };
