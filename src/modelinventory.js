'use strict';

/** ONE SEARCHABLE MODEL PROJECTION, PER VIEW — so a frontend never has to know what a catalog, a connection or a website model source is. */

const net = require('net');
const roles = require('./modelroles');

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
/** THE FABRIC'S FACTS of a lane (Phase 8.3): family › model › effort, policy, the backing account, a pending question. */
function fabricOf(l) {
  return { resolved: l.resolved, display: l.display, family: l.family, familyLabel: l.familyLabel, familyKind: l.familyKind, effort: l.effort, effortLabel: l.effortLabel, efforts: l.efforts, effortLabels: l.effortLabels, defaultEffort: l.defaultEffort, effortKnown: l.effortKnown, policy: l.policy, policyLabel: l.policyLabel, backing: l.backing, accountCount: l.accountCount, pending: l.pending };
}

function codingSelection(app) {
  const l = require('./sessionintel').lane(app, app.session, 'coding');
  return { modelId: l.model, connectionId: l.route, account: l.account, accountLabel: l.accountLabel, modelLabel: l.modelLabel, scope: l.modelScope, accountScope: l.accountScope, ok: l.ok, needs: l.needs, why: l.why, ...fabricOf(l) };
}

/** The Chat model: which source, and which model on it. */
function chatSelection(app) {
  const l = require('./sessionintel').lane(app, app.session, 'chat');
  return { source: 'lain', modelId: l.model, connectionId: l.route, account: l.account, accountLabel: l.accountLabel, modelLabel: l.modelLabel, scope: l.modelScope, accountScope: l.accountScope, ok: l.ok, needs: l.needs, why: l.why, ...fabricOf(l) };
}

function runtimeRows(app, lane) {
  const cat = (() => { try { return app.catalog(); } catch { return null; } })();
  const conns = connectionIndex(app);
  // THE CONNECTIONS AS THE TRANSPORT SEES THEM (base URLs), for the runtime-bound check below.
  const live = new Map((() => { try { return require('./appcatalog').connections(app); } catch { return []; } })().map((c) => [c.id, c]));
  const chosen = lane === LANE.CODING ? codingSelection(app) : chatSelection(app);
  // ONE READ of the runtime/local connections, not one per catalog row.
  const rtIndex = new Map();
  try { for (const rc of require('./runtimeconnections').connections(app)) for (const x of rc.models) rtIndex.set(x.id, { ...x, runtime: rc.runtime, locality: rc.locality, connectionId: rc.id }); } catch { /* no runtime rows */ }
  return {
    catalog: cat,
    rows: ((cat && cat.models) || []).map((m) => {
      const c = (m.connections || [])[0] || {};
      const base = conns.get(String(c.baseConnectionId || c.connectionId || '')) || {};
      const efforts = (m.connections || []).flatMap((x) => x.efforts || []);
      // A LOCAL OR RUNTIME ROUTE carries the roles it may fill (runtimeconnections.js).
      const rt = rtIndex.get(m.id) || null;
      // A RUNTIME-BOUND model on an HTTP route (runtimebound.js) is listed, but cannot be chosen there.
      const bound = !rt && (m.connections || []).length && (m.connections || []).every((x) => require('./runtimebound').check({ conn: live.get(String(x.baseConnectionId || x.connectionId || '')) || {}, connectionId: x.connectionId, model: m.id, upstreamId: x.upstreamId || m.id }));
      const extra = rt ? { roles: rt.roles, runtime: rt.runtime, displayName: rt.label || m.displayName || m.id, locality: rt.locality, entitlement: rt.entitlement || null, capabilities: { chat: true, coding: rt.roles.includes('AGENT'), tools: rt.locality === 'local' || rt.runtime === 'zcode', efforts: [] } }
        : bound ? { roles: [], availability: 'RUNTIME_BOUND', why: 'runtime-bound — use it through the OpenCode Runtime' } : {};
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
        ...extra,
      };
    }),
  };
}

/** The runtime-bound refusal for a resolved route (runtimebound.js), or null. */
function runtimeBound(app, r) {
  if (!r || !r.connection) return null;
  let conn = {};
  try { conn = require('./appcatalog').connections(app).find((c) => c.id === (r.connection.baseConnectionId || r.connection.connectionId)) || {}; } catch { conn = {}; }
  return require('./runtimebound').check({ conn, connectionId: r.connection.connectionId, model: r.model, upstreamId: r.upstreamId });
}

/** The runtime/local row (roles, runtime, locality) for a catalog model, or null for an API route. */
function runtimeRowFor(app, modelId, conn) {
  try { return require('./runtimeconnections').rowFor(app, modelId, conn ? (conn.baseConnectionId || conn.connectionId || null) : null); } catch { return null; }
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
    // CHATGPT CHAT (modelroles.CHATGPT_CHAT) is ONE row under its own name, with its LAIN alias as metadata and CHAT ONLY as its capability — whether or…
    const chatOnly = d.id === roles.CHATGPT_CHAT.source;
    const tag = { capabilityLabel: 'CHAT ONLY', roles: [roles.ROLE.CHAT], alias: chatOnly ? roles.CHATGPT_CHAT.alias : null, origin: chatOnly ? roles.CHATGPT_CHAT.origin : null };
    if (chatOnly) {
      out.push({
        source: d.id, provider: src.label, modelId: roles.CHATGPT_CHAT.alias, displayName: roles.CHATGPT_CHAT.label, ...tag,
        connectionId: null, routes: 1, capabilities: { chat: true, coding: false, tools: false, efforts: [] },
        availability: inv ? 'AVAILABLE' : 'UNDISCOVERED', authState: st.state || 'DISCONNECTED', locality: 'external',
        selected: chosen.source === d.id, why: st.why || '',
      });
    }
    if (!inv) {
      if (chatOnly) continue;
      out.push({
        source: d.id, provider: src.label, modelId: null, displayName: `${src.label} — models not discovered yet`, ...tag,
        connectionId: null, routes: 0, capabilities: { chat: true, coding: false, tools: false, efforts: [] },
        availability: 'UNDISCOVERED', authState: st.state || 'DISCONNECTED', locality: 'external',
        selected: false, discover: { route: 'POST /api/source/models', body: { source: d.id } }, why: st.why || '',
      });
      continue;
    }
    for (const m of inv) {
      // THE SITE'S OWN OPTIONS read under the source's name ("ChatGPT Chat ·
      // <option>"), never as a bare "GPT…" id that looks like API access.
      out.push({
        source: d.id, provider: src.label, modelId: m.id, displayName: `${roles.labelFor(d.id, src.label)} · ${m.label || m.id}`, ...tag, connectionId: null, routes: 1,
        capabilities: { chat: true, coding: false, tools: false, efforts: [] },
        availability: m.state || 'UNKNOWN', authState: st.state || 'UNKNOWN', locality: 'external',
        selected: chosen.source === d.id && chosen.modelId === m.id,
      });
    }
  }
  return out;
}

/** SEARCH. May read the catalog (a POST route); never opens a browser. */
async function search(app, { lane = LANE.CODING, query = '', limit = MAX_ROWS, account = null } = {}) {
  const which = lane === LANE.CHAT ? LANE.CHAT : LANE.CODING;
  try { await app.ensureCatalog({ announce: false }); } catch { /* an unreadable catalog yields no runtime rows */ }
  if (account) {
    const A = require('./accountcatalog');
    const acct = A.accountFor(app, account);
    const chosen = which === LANE.CODING ? codingSelection(app) : chatSelection(app);
    const rows = acct ? A.models(app, acct.id, { query, limit: 2000 }).filter((m) => (which === LANE.CODING ? m.coding : m.chat)).map((m) => ({
      source: 'lain', provider: acct.family, account: acct.id, accountName: acct.name, modelId: m.id, displayName: m.label, connectionId: m.route,
      routes: 1, capabilities: { chat: m.chat, coding: m.coding, tools: m.coding, efforts: m.efforts || [] }, roles: m.roles,
      availability: acct.usable ? 'AVAILABLE' : 'UNAVAILABLE', authState: acct.state, locality: acct.kind === 'local' ? 'local' : 'external',
      selected: chosen.account === acct.id && chosen.modelId === m.id,
    })) : [];
    return { lane: which, query: String(query || '').trim(), account: A.view(acct), selected: chosen, rows: rows.slice(0, Math.max(1, Math.min(2000, Number(limit) || MAX_ROWS))), total: rows.length };
  }
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

/** SELECT for one view of this session — ACCOUNT FIRST (Phase 8.2). */
async function select(app, { lane, source = 'lain', modelId, connectionId = null, account } = {}) {
  const which = lane === LANE.CHAT ? 'chat' : lane === LANE.CODING ? 'coding' : null;
  if (!which) return { ok: false, why: 'lane must be "chat" or "coding"' };
  const want = String(modelId || '').trim();
  // CHAT ONLY (modelroles.js): the website session and its alias never code.
  if (which === 'coding') { const gate = roles.check({ source, modelId: want }, roles.ROLE.AGENT); if (!gate.ok) return { ok: false, why: gate.why, code: gate.code }; }
  // THE WEBSITE SOURCES ARE RETIRED (Phase 8.1) — the alias included.
  if (roles.isChatAlias(want)) return { ok: false, code: 'retired', why: `${want} was ChatGPT Chat, a website source; the website sources are retired — choose an account and a model LAIN runs` };
  if (source && source !== 'lain') return { ok: false, code: 'retired', why: 'the website sources are retired — choose an account and a model LAIN runs' };
  const acct = account !== undefined ? (account || null) : (connectionId || undefined);
  const req = { lane: which };
  if (acct !== undefined) req.account = acct;
  if (want || acct === undefined) req.model = want || null;
  const r = await require('./sessionintel').choose(app, app.session, req);
  if (!r.ok) return { ok: false, why: r.why, code: r.code, offering: r.offering };
  return { ok: true, selected: which === 'coding' ? codingSelection(app) : chatSelection(app), lane: r.lane, needsModel: r.needsModel };
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
