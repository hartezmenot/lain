'use strict';

/** WHICH MODELS ARE NEW TO YOU. */

const fs = require('fs');
const path = require('path');

const config = require('./config');

/** Do not carry an unbounded id list around; a refresh that adds this many is
 *  a first discovery, not news about three models. */
const MAX_TRACKED = 200;

function file() {
  return path.join(config.configDir(), 'new-models.json');
}

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { at: Number(j.at) || 0, ids: Array.isArray(j.ids) ? j.ids : [] };
  } catch { return { at: 0, ids: [] }; }
}

function write(state) {
  try {
    fs.mkdirSync(config.configDir(), { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file());
    return true;
  } catch { return false; }        // an unwritable config still runs
}

/** Record what a refresh just discovered. */
function record(added, { firstCatalog = false } = {}) {
  const ids = Array.isArray(added) ? added.filter(Boolean) : [];
  // "Everything is new" is true on a first discovery and tells you nothing, so
  // the marker stays off rather than painting a thousand rows.
  if (firstCatalog || ids.length > MAX_TRACKED) { write({ at: Date.now(), ids: [] }); return []; }
  write({ at: Date.now(), ids });
  return ids;
}

/** The current set, as a Set of ids. */
function all() {
  return new Set(read().ids);
}

function isNew(id) {
  return read().ids.includes(String(id));
}

/** You used it, so it is no longer news. */
function seen(id) {
  const state = read();
  const next = state.ids.filter((x) => x !== String(id));
  if (next.length === state.ids.length) return false;
  write({ at: state.at, ids: next });
  return true;
}

/** Forget everything. Used by `/api refresh` failures and by tests. */
function clear() { return write({ at: Date.now(), ids: [] }); }

module.exports = { record, all, isNew, seen, clear, file, MAX_TRACKED };
