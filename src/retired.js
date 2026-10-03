'use strict';

/** ROUTING SYSTEMS THIS PRODUCT NO LONGER SUPPORTS — one authority, every layer. */

const SYSTEMS = ['omniroute', 'tokenrouter'];

/** Connection ids pruned in this process, so a spread copy of the config (which drops `_retired`) still knows them. */
const REMOVED = new Map();

const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function systemOf(text) {
  const f = flat(text);
  if (!f) return null;
  return SYSTEMS.find((s) => f.includes(s)) || null;
}

/** Which removed system this connection belongs to, or null. */
function connectionSystem(id, c = {}) {
  const hit = systemOf(id) || systemOf(c && c.provider);
  if (hit) return hit;
  const base = String((c && c.baseUrl) || '');
  if (!base) return null;
  try {
    const host = systemOf(new URL(base).hostname);
    if (host) return host;
  } catch { /* not a URL — nothing to learn from it */ }
  return null;
}

/** A model id carrying a removed router's namespace (`omniroute:…`, `tokenrouter/…`). */
function modelSystem(modelId) {
  const m = /^([a-z0-9.-]+)[:/]/i.exec(String(modelId || ''));
  return m ? systemOf(m[1]) : null;
}

/** The config with removed connections taken out. */
function prune(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const removed = [];
  const conns = cfg.connections && typeof cfg.connections === 'object' ? cfg.connections : null;
  if (conns) {
    const kept = {};
    for (const [id, c] of Object.entries(conns)) {
      const sys = connectionSystem(id, c);
      if (sys) { removed.push({ id, system: sys }); REMOVED.set(id, sys); }
      else kept[id] = c;
    }
    if (removed.length) cfg = { ...cfg, connections: kept };
  }
  // THE OLD BROWSER DASHBOARD (deleted in S9): its keys leave the config on load.
  if (['dashAutostart', 'dashPassword', 'dashLan', 'dashPort'].some((k) => k in cfg)) { cfg = { ...cfg }; for (const k of ['dashAutostart', 'dashPassword', 'dashLan', 'dashPort']) delete cfg[k]; }
  Object.defineProperty(cfg, '_retired', { value: removed, enumerable: false, configurable: true, writable: true });
  return cfg;
}

/** Is the SELECTION itself on a removed system? */
function selection(cfg = {}) {
  const pruned = (cfg && cfg._retired) || [];
  const conn = cfg && cfg.connection;
  if (conn) {
    const was = pruned.find((r) => r.id === conn);
    const sys = (was && was.system) || REMOVED.get(conn) || connectionSystem(conn, (cfg.connections || {})[conn]);
    if (sys) return { system: sys, connection: conn, model: cfg.model || null };
  }
  const sys = modelSystem(cfg && cfg.model);
  if (sys) return { system: sys, connection: conn || null, model: cfg.model };
  return null;
}

function unavailableText(sel) {
  if (!sel) return '';
  const what = sel.model ? `"${sel.model}"` : 'The selected model';
  return `Unavailable · provider removed — ${what} was served by ${sel.connection || sel.system}, `
    + `a ${sel.system} route LAIN no longer supports. /model to choose another.`;
}

/** Delete on-disk catalog caches written for removed connections. Best effort. */
function purgeCaches(dir) {
  const fs = require('fs');
  const path = require('path');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (!systemOf(name.replace(/\.json$/, ''))) continue;
    try { fs.unlinkSync(path.join(dir, name)); n += 1; } catch { /* in use or gone */ }
  }
  return n;
}

module.exports = { SYSTEMS, connectionSystem, modelSystem, prune, selection, unavailableText, purgeCaches };
