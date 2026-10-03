'use strict';

/** Configuration. Owned by the App instance — `load()` returns a fresh object every call and this module holds no cached state. */

const fs = require('fs');
const os = require('os');
const path = require('path');

function configDir() {
  return require('./home').resolve();
}
function configFile() { return path.join(configDir(), 'config.json'); }
function sessionsDir() { return path.join(configDir(), 'sessions'); }

const DEFAULTS = {
  model: null,          // null = "not chosen yet", never a fake default
  provider: null,
  /** 0 = NO LIMIT, and that is now the default. */
  maxSteps: 0,
  stream: true,
  /** WHETHER LAIN TAKES THE TERMINAL'S MOUSE. */
  mouse: false,
};

/** The step ceiling LAIN used to impose on itself, before the default became "no limit". */
const LEGACY_MAX_STEPS = 30;

/** A SAVED `maxSteps: 30` IS LAIN'S OLD OPINION, NOT THE USER'S CHOICE. */
function retireLegacyStepLimit(saved) {
  if (Number(saved.maxSteps) === LEGACY_MAX_STEPS) {
    const out = { ...saved };
    delete out.maxSteps;
    return out;
  }
  return saved;
}

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { saved = {}; }
  markKnown(saved);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const retired = require('./retired');
  if (!purgedCaches) { purgedCaches = true; retired.purgeCaches(path.join(configDir(), 'catalog')); }
  return retired.prune({ ...DEFAULTS, ...retireLegacyStepLimit(saved) });
}
let purgedCaches = false;

function save(cfg) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configFile();
  // ANOTHER PROCESS'S CHANGE IS KEPT (Phase 8.3): the whole config is written, so a key another LAIN changed
  // since this one last looked is taken in first — unless this process changed that same key too.
  if (changedOnDisk()) mergeExternal(cfg);
  const tmp = file + '.tmp';
  const text = JSON.stringify(cfg, null, 2);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  markKnown(JSON.parse(text));
  return file;
}

/** WAS THE FILE CHANGED BY ANOTHER PROCESS? */
let known = null;   // { file, sig, content } — what this process last read or wrote
function statOf() { try { const st = fs.statSync(configFile()); return `${st.mtimeMs}:${st.size}`; } catch { return 'none'; } }
function markKnown(content = undefined) { known = { file: configFile(), sig: statOf(), content: content === undefined ? (known && known.content) || null : content }; }
function changedOnDisk() { if (!known || known.file !== configFile()) return false; return statOf() !== known.sig; }

/** THREE-WAY: base = what this process last knew; disk = now; mine = in memory. */
function mergeExternal(cfg) {
  let disk;
  try { disk = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return []; }
  const base = (known && known.content) || {};
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  const taken = [];
  const take = (holder, baseHolder, diskHolder, k, label) => {
    if (same(diskHolder[k], baseHolder[k])) return;            // the other process did not change it
    if (!same(holder[k], baseHolder[k])) return;               // this process changed it too: ours stands
    if (diskHolder[k] === undefined) delete holder[k]; else holder[k] = diskHolder[k];
    taken.push(label);
  };
  for (const k of new Set([...Object.keys(disk), ...Object.keys(base)])) {
    if (k === 'connections' && disk.connections && typeof disk.connections === 'object') {
      if (!cfg.connections || typeof cfg.connections !== 'object') cfg.connections = {};
      const b = (base.connections && typeof base.connections === 'object') ? base.connections : {};
      for (const id of new Set([...Object.keys(disk.connections), ...Object.keys(b)])) take(cfg.connections, b, disk.connections, id, `connections.${id}`);
      continue;
    }
    take(cfg, base, disk, k, k);
  }
  markKnown(disk);
  return taken;
}

module.exports = { DEFAULTS, load, save, configDir, configFile, sessionsDir, changedOnDisk, markKnown, mergeExternal,
  LEGACY_MAX_STEPS, retireLegacyStepLimit };
