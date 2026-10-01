'use strict';

/**
 * WHICH MODELS THIS APP CAN REACH — connections, the catalog, and discovery.
 *
 * Split out of app.js when that file reached the architecture guard, and the
 * seam is the honest one: app.js orchestrates a SESSION — identify, submit,
 * complete, resume — and this answers a question about the OUTSIDE WORLD that
 * has nothing to do with any of it. It is the only place that decides which
 * connections exist, what they serve, and what the user is told while that is
 * being found out.
 *
 * Every function takes the app rather than being a method on it, so nothing
 * here can quietly acquire session state. They are re-exposed as App methods,
 * so no caller had to move with them.
 */

const connectionsMod = require('./connections');
const catalogMod = require('./catalog');

/**
 * Connections as currently configured, with real request evidence applied.
 *
 * MEMOISED (Phase 8.1 performance). The TUI asked for this on EVERY redraw and
 * status change (ui/projection.readiness), and each answer walked PATH, asked
 * llama-server its version and listed every runtime's models — a trivial turn
 * cost ~1.7 s of CPU. The answer is reused while the inputs it is built from are
 * unchanged (the connection/runtime/local config and the request evidence),
 * for at most one second so an installed runtime still appears promptly.
 */
const MEMO_MS = 1000;
function connections(app) {
  const now = Date.now();
  let sig;
  // A SHALLOW SIGNATURE (Phase 8.3): every connection's own settings and the SIZE of a declared model list —
  // not the list itself. Stringifying a thousand declared models on every lane read cost more than the lookup it
  // guarded (the window polls /api/state, and a poll resolves several lanes). A model list only changes through
  // discovery, whose writer calls invalidate().
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

/**
 * The canonical catalog: one row per MODEL, routes underneath.
 *
 * MEMOISED (Phase 8.2). A 9Router alone advertises ~1,100 models, and every
 * picker, status line and account lookup asked for a fresh build. The catalog
 * is a pure function of the connections, so it is rebuilt only when what it is
 * built from changes: a route's id, its model list (count, ends, discovery
 * time) or a runtime model's roles.
 */
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

/**
 * Make sure the catalog can answer before something needs it.
 *
 * A connection states WHERE it is; what it SERVES is discovered from it. With
 * no declared model list and no cache, `/models` had nothing to show and no
 * model could be selected — which took the whole product down, because
 * `provider.resolve` needs a model to resolve.
 *
 * The DECIDING and the FETCHING both live in connections.js. This is the
 * orchestration: which set to ask for, and what the user is told while it
 * happens. It is a catalog request, never a model call — no tokens and no
 * completion — it runs at most once per connection per launch, and the answer
 * is cached on disk for a day, so it is not a background poll in disguise.
 */
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
        // A BROKEN SOURCE IS STATE ON THE SOURCE (catalogstate.js, shown in the
        // picker), not a WARN block on every `/model`. One line, only when it
        // CHANGED, and never the provider's raw JSON — that stays on the record.
        else if (r.changed) app.transient('warn', require('./catalogstate').line(r.id, r.state));
      }
    }
    return results;
  });
}

/**
 * THE CATALOG FOR A SET OF CONNECTIONS that is not an App's (provider.resolve
 * over a turn's config). Status lines and dashboards resolve on every redraw;
 * a router's ~1,100-model catalog was rebuilt each time. Built once per set.
 */
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
