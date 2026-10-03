'use strict';

/** PROVIDER DRIVERS — how LAIN reaches an account of a kind. */

const CAPABILITIES = Object.freeze(['BOT', 'CHAT', 'AGENT', 'AUX', 'VISION', 'EMBEDDING', 'EXTERNAL AGENT', 'RUNTIME ONLY']);
const SOURCE_TYPES = Object.freeze(['api', 'runtime', 'website']);

const drivers = new Map();

function register(d) {
  if (!d || typeof d !== 'object') throw new Error('a driver is an object');
  if (!/^[a-z][a-z0-9:._-]{1,40}$/.test(String(d.id || ''))) throw new Error('a driver id is lowercase letters, digits and : . _ -');
  if (drivers.has(d.id)) throw new Error(`driver ${d.id} is already registered`);
  if (!SOURCE_TYPES.includes(d.sourceType)) throw new Error(`driver ${d.id}: sourceType is one of ${SOURCE_TYPES.join(', ')}`);
  for (const c of d.capabilities || []) if (!CAPABILITIES.includes(c)) throw new Error(`driver ${d.id}: unknown capability ${c}`);
  if (d.sourceType !== 'api' && typeof d.create !== 'function') throw new Error(`driver ${d.id}: a runtime or website driver creates instance handles`);
  drivers.set(d.id, Object.freeze({ supportsMultipleInstances: true, capabilities: [], ...d }));
  return drivers.get(d.id);
}

function get(id) { ensure(); return drivers.get(String(id)) || null; }
function list() { ensure(); return [...drivers.values()]; }

/** What a person (or the BOT) may read about a driver. */
function describe(d) {
  return { id: d.id, displayName: d.displayName, provider: d.provider || null, sourceType: d.sourceType, capabilities: [...(d.capabilities || [])],
    supportsMultipleInstances: d.supportsMultipleInstances !== false, connection: d.connection || null, install: d.install || null };
}

let loaded = false;
function ensure() {
  if (loaded) return;
  loaded = true;
  register(require('./drivers/codex').driver);
  register(require('./drivers/claudeaccount').driver);
  register(require('./drivers/antigravity').driver);      // one private profile per Google account   // one configuration directory per Claude account
  for (const d of require('./drivers/runtimes').DRIVERS) if (d.id !== 'claude-code') register(d);
}

/** TESTS ONLY. */
function _reset() { drivers.clear(); loaded = false; }

module.exports = { register, get, list, describe, CAPABILITIES, SOURCE_TYPES, _reset };
