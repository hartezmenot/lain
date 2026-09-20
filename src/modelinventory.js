'use strict';

/**
 * ONE SEARCHABLE MODEL PROJECTION, PER VIEW — so a frontend never has to know
 * what a catalog, a connection or a website model source is.
 *
 *     search(app, { lane: 'chat' | 'coding', query })
 *       → [{ source, provider, modelId, displayName, capabilities, availability,
 *            authState, locality, selected, connectionId }]
 *
 * ------------------------------------------------------------------------
 * EVERY ROW COMES FROM AN INVENTORY THAT ALREADY EXISTS. Nothing is hard-coded.
 *
 *   LAIN's runtime   the configured catalog (appcatalog.js) — both views
 *   ChatGPT.com /    the inventory the logged-in ACCOUNT reported last time it
 *   Gemini           was discovered (webmodel.js). Chat view only: a website is
 *                    consulted, it never codes. A source never discovered
 *                    contributes one row saying so, with its auth state, and
 *                    `POST /api/source/models` is how it gets discovered — a
 *                    search is not allowed to open a browser.
 *
 * The ranking is modelsearch.js's — the same algorithm `/models` uses — so the
 * terminal and the window agree about what "qwen 3.7" means.
 *
 * ------------------------------------------------------------------------
 * SELECTION IS PER VIEW AND PER SESSION.
 *
 *   chat    session.chatSource + session.sourceSelections (modelsource state).
 *           Choosing a runtime model for Chat records it on the session ONLY;
 *           it does not move the Coding model or the process default.
 *   coding  session.views.coding (sessionviews.js), resolved through the same
 *           catalog resolution `/model` uses so a Coding turn can reach it.
 */

const net = require('net');

const LANE = Object.freeze({ CHAT: 'chat', CODING: 'coding' });
const MAX_ROWS = 80;

function loopback(url) {
  try {
    const h = new URL(String(url)).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '::1' || h.endsWith('.localhost') || (net.isIP(h) === 4 && h.startsWith('127.'));
  } catch { return false; }
}

function connectionIndex(app) {
  const out = new Map();
  for (const c of (app.cfg && Array.isArray(app.cfg.connections) ? app.cfg.connections : [])) {
    if (c && c.id) out.set(String(c.id), c);
  }
  return out;
}

/** The Coding model this session actually runs with, and where it came from. */
function codingSelection(app) {
  const v = require('./sessionviews').views(app.session);
  if (v.coding.model) return { modelId: v.coding.model, connectionId: v.coding.connection || null, scope: 'session' };
  return { modelId: (app.cfg && app.cfg.model) || null, connectionId: (app.cfg && app.cfg.connection) || null, scope: 'default' };
}

/** The Chat model: which source, and which model on it. */
function chatSelection(app) {
  const registry = require('./modelsource/registry');
  const source = registry.selectedId(app);
  const picks = (app.session && app.session.sourceSelections) || {};
  const modelId = picks[source] || (source === 'lain' ? ((app.cfg && app.cfg.model) || null) : null);
  return { source, modelId, scope: picks[source] ? 'session' : 'default' };
}

function runtimeRows(app, lane) {
  const cat = (() => { try { return app.catalog(); } catch { return null; } })();
  const conns = connectionIndex(app);
  const chosen = lane === LANE.CODING ? codingSelection(app) : chatSelection(app);
  return {
    catalog: cat,
    rows: ((cat && cat.models) || []).map((m) => {
      const c = (m.connections || [])[0] || {};
      const base = conns.get(String(c.baseConnectionId || c.connectionId || '')) || {};
      const efforts = (m.connections || []).flatMap((x) => x.efforts || []);
      return {
        source: 'lain',
        provider: c.provider || null,
        modelId: m.id,
        displayName: m.displayName || m.id,
        connectionId: c.connectionId || null,
        routes: (m.connections || []).length,
        capabilities: { chat: true, coding: true, tools: true, efforts: [...new Set(efforts)] },
        availability: 'AVAILABLE',
        authState: 'CONFIGURED',
        locality: loopback(base.baseUrl) ? 'local' : 'external',
        selected: lane === LANE.CODING
          ? chosen.modelId === m.id
          : chosen.source === 'lain' && chosen.modelId === m.id,
      };
    }),
  };
}

async function webRows(app) {
  const registry = require('./modelsource/registry');
  const chosen = chatSelection(app);
  const out = [];
  for (const d of registry.DECLARED) {
    if (d.kind !== registry.KIND.WEB) continue;
    const src = registry.get(app, d.id);
    if (!src) continue;
    // eslint-disable-next-line no-await-in-loop -- two sources, status never launches with open:false
    const st = await src.status({ open: false }).catch((e) => ({ state: 'FAILED', why: (e && e.message) || String(e) }));
    const inv = src._inventory && Array.isArray(src._inventory.models) ? src._inventory.models : null;
    if (!inv) {
      out.push({
        source: d.id, provider: src.label, modelId: null, displayName: `${src.label} — models not discovered yet`,
        connectionId: null, routes: 0, capabilities: { chat: true, coding: false, tools: false, efforts: [] },
        availability: 'UNDISCOVERED', authState: st.state || 'DISCONNECTED', locality: 'external',
        selected: false, discover: { route: 'POST /api/source/models', body: { source: d.id } }, why: st.why || '',
      });
      continue;
    }
    for (const m of inv) {
      out.push({
        source: d.id, provider: src.label, modelId: m.id, displayName: m.label || m.id, connectionId: null, routes: 1,
        capabilities: { chat: true, coding: false, tools: false, efforts: [] },
        availability: m.state || 'UNKNOWN', authState: st.state || 'UNKNOWN', locality: 'external',
        selected: chosen.source === d.id && chosen.modelId === m.id,
      });
    }
  }
  return out;
}

/** SEARCH. May read the catalog (a POST route); never opens a browser. */
async function search(app, { lane = LANE.CODING, query = '', limit = MAX_ROWS } = {}) {
  const which = lane === LANE.CHAT ? LANE.CHAT : LANE.CODING;
  try { await app.ensureCatalog({ announce: false }); } catch { /* an unreadable catalog yields no runtime rows */ }
  const rt = runtimeRows(app, which);
  let rows = rt.rows;
  if (which === LANE.CHAT) rows = rows.concat(await webRows(app));
  const q = String(query || '').trim();
  if (q) {
    // THE ONE RANKING. Adapt rows to what modelsearch reads, rank, map back.
    const shaped = rows.filter((r) => r.modelId).map((r) => ({
      id: `${r.source}::${r.modelId}`, displayName: r.displayName,
      connections: [{ provider: r.provider, connectionId: r.connectionId, route: r.source }], row: r,
    }));
    rows = require('./modelsearch').search({ models: shaped }, q, limit).map((m) => m.row);
  }
  return {
    lane: which,
    query: q,
    selected: which === LANE.CODING ? codingSelection(app) : chatSelection(app),
    rows: rows.slice(0, Math.max(1, Math.min(MAX_ROWS, Number(limit) || MAX_ROWS))),
    total: rows.length,
  };
}

/** SELECT a model for one view of this session. */
async function select(app, { lane, source = 'lain', modelId, connectionId = null } = {}) {
  const want = String(modelId || '').trim();
  if (lane === LANE.CODING) {
    if (source && source !== 'lain') return { ok: false, why: 'the Coding view runs on LAIN\'s runtime; a website model can be used in Chat' };
    const v = require('./sessionviews').views(app.session);
    if (!want) { v.coding.model = null; v.coding.connection = null; return { ok: true, selected: codingSelection(app) }; }
    try { await app.ensureCatalog({ announce: false }); } catch { /* resolved below */ }
    const cat = app.catalog();
    const r = require('./catalog').resolve(cat, { model: want, connectionId: connectionId || null, effort: (app.cfg && app.cfg.effort) || null });
    if (!r.ok) return { ok: false, why: `"${want}" is not served by any configured connection` };
    v.coding.model = r.model;
    v.coding.connection = r.connection ? (r.connection.baseConnectionId || r.connection.connectionId) : null;
    return { ok: true, selected: codingSelection(app) };
  }
  if (lane !== LANE.CHAT) return { ok: false, why: 'lane must be "chat" or "coding"' };
  const registry = require('./modelsource/registry');
  const chosen = registry.selectSource(app, String(source || 'lain'));
  if (!chosen.ok) return { ok: false, why: chosen.why };
  if (!want) return { ok: true, selected: chatSelection(app) };
  if (chosen.source === 'lain') {
    try { await app.ensureCatalog({ announce: false }); } catch { /* resolved below */ }
    const r = require('./catalog').resolve(app.catalog(), { model: want, connectionId: connectionId || null, effort: null });
    if (!r.ok) return { ok: false, why: `"${want}" is not served by any configured connection` };
    // THE SESSION'S CHAT PICK ONLY. The process default and Coding are untouched.
    app.session.sourceSelections = { ...(app.session.sourceSelections || {}), lain: r.model };
    return { ok: true, selected: chatSelection(app) };
  }
  const picked = await registry.selectModel(app, chosen.source, want);
  if (!picked.ok) return { ok: false, why: picked.why };
  return { ok: true, selected: chatSelection(app) };
}

/** The two selections, cheaply — for the session header and composer. */
function selections(app) {
  const registry = require('./modelsource/registry');
  const chat = chatSelection(app);
  const coding = codingSelection(app);
  return {
    chat: { ...chat, label: (registry.LABEL && registry.LABEL[chat.source]) || chat.source },
    coding: { ...coding, source: 'lain', label: 'LAIN' },
  };
}

module.exports = { LANE, search, select, selections, chatSelection, codingSelection, loopback };
