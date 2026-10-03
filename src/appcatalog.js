'use strict';

/** WHICH MODELS THIS APP CAN REACH — connections, the catalog, and discovery. */

const connectionsMod = require('./connections');
const catalogMod = require('./catalog');

/** Connections as currently configured, with real request evidence applied. */
const MEMO_MS = 1000;
function connections(app) {
  const now = Date.now();
  let sig;
  // A SHALLOW SIGNATURE (Phase 8.3): every connection's own settings and the SIZE of a declared model list — not the list itself.
  try { sig = JSON.stringify([shallow(app.cfg && app.cfg.connections), app.cfg && app.cfg.runtimes, app.cfg && app.cfg.local, app.cfg && app.cfg.accounts, app.connectionEvidence, generation]); } catch { sig = null; }
  const m = app._connMemo;
  if (sig && m && m.sig === sig && now - m.at < MEMO_MS) return m.value;
  const value = connectionsMod.fromConfig({ ...app.cfg, _evidence: app.connectionEvidence }, app.connectionEvidence);
  if (sig) app._connMemo = { sig, at: now, value };
  return value;
}
function shallow(conns) {
  if (!conns || typeof conns !== 'object') return conns || null;
  return Object.keys(conns).map((id) => { const c = conns[id] || {}; const o = {}; for (const k of Object.keys(c)) o[k] = k === 'models' && Array.isArray(c[k]) ? c[k].length : c[k]; return [id, o]; });
}
let generation = 0;
/** Something a listing depends on changed outside the config (a credential, a runtime). */
function invalidate() { generation += 1; }
/** Which invalidation this is — a memo elsewhere (runtimeconnections.js) is dropped with this one. */
function generationNow() { return generation; }

/** The canonical catalog: one row per MODEL, routes underneath. */
function signature(conns) {
  try {
    return conns.map((c) => {
      const ms = c.models || [];
      const first = ms.length ? String(ms[0].id || ms[0]) : '';
      const last = ms.length ? String(ms[ms.length - 1].id || ms[ms.length - 1]) : '';
      const roles = c.protocol === 'runtime' ? JSON.stringify(ms.map((m) => [m.id, m.roles])) : '';
      return [c.id, c.baseUrl || '', c.protocol || '', c.provider || '', c.readiness || '', ms.length, first, last, c.discoveredAt || 0, roles].join('\u0001');
    }).join('\u0002');
  } catch { return null; }
}
function catalog(app) {
  const conns = connections(app);
  const memo = app._catMemo;
  if (memo && memo.conns === conns) return memo.value;
  const sig = signature(conns);
  if (sig && memo && memo.sig === sig) { memo.conns = conns; return memo.value; }
  const value = catalogMod.build(conns);
  app._catMemo = { sig, conns, value };
  return value;
}

/** Make sure the catalog can answer before something needs it. */
async function ensureCatalog(app, { force = false, only = null, announce = true } = {}) {
  if (!app._discovered) app._discovered = new Set();
  return connectionsMod.discoverAll(connections(app), {
    force,
    only,
    done: app._discovered,
    signal: app.abort ? app.abort.signal : undefined,
    onProgress: announce ? (id) => app.transient('info', `discovering models from ${id}…`) : null,
  }).then((results) => {
    if (announce) {
      for (const r of results) {
        if (r.ok) app.transient('info', `${r.id}: ${r.count} model(s) advertised`);
        // A BROKEN SOURCE IS STATE ON THE SOURCE (catalogstate.js, shown in the picker), not a WARN block on every `/model`.
        else if (r.changed) app.transient('warn', require('./catalogstate').line(r.id, r.state));
      }
    }
    return results;
  });
}

/** THE CATALOG FOR A SET OF CONNECTIONS that is not an App's (provider.resolve over a turn's config). */
let setMemo = null;
function catalogFor(conns) {
  const sig = signature(conns);
  if (sig && setMemo && setMemo.sig === sig) return setMemo.value;
  const value = catalogMod.build(conns);
  setMemo = { sig, value };
  return value;
}

module.exports = {
  invalidate, generationNow, connections, catalog, catalogFor, ensureCatalog, signature };
