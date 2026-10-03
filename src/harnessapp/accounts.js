'use strict';

/** MODELS, PROVIDERS AND ACCOUNTS — the one projection the window's MODEL view, its quota popover and the BOT's own answers about LAIN all read. */

function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return ''; }
}

function providerLabel(id) {
  try {
    const p = require('../providers').byId(id);
    if (p && p.label) return p.label;
  } catch { /* fall through to the id */ }
  return String(id || 'unknown');
}

function availabilityOf(app, id) {
  const av = app.availability;
  if (!av || !(av.state instanceof Map) || !av.state.has(id)) return null;
  try {
    const a = av.get(id);
    return { status: a.status, reason: a.reason || '', rateLimited: av.limitActive(id), resumeAt: a.resumeAt || null };
  } catch { return null; }
}

/** The configured routes, grouped by provider, with everything known about each. */
function providers(app) {
  let conns = [];
  try { conns = require('../appcatalog').connections(app); } catch { conns = []; }
  const catalogstate = require('../catalogstate');
  const uw = require('../usagewindows');
  const groups = new Map();
  for (const c of conns) {
    // LOCAL AND RUNTIME ROUTES are shown under MODEL › Local and › Runtimes, not as providers.
    if (c.protocol === 'runtime') continue;
    const verdict = (() => { try { return c.baseUrl ? catalogstate.of(c) : null; } catch { return null; } })();
    const row = {
      id: c.id,
      via: c.via,
      auth: c.auth,
      protocol: c.protocol,
      host: hostOf(c.baseUrl),
      readiness: c.readiness,
      catalog: verdict ? { state: verdict.state, at: verdict.at || null } : null,
      discoveredAt: c.discoveredAt || null,
      models: (c.models || []).map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name)) || '')).filter(Boolean).slice(0, 400),
      modelCount: (c.models || []).length,
      availability: availabilityOf(app, c.id),
      usage: uw.forConnection(c.id),
    };
    const key = String(c.provider || c.id);
    if (!groups.has(key)) groups.set(key, { provider: key, label: providerLabel(key), connections: [] });
    groups.get(key).connections.push(row);
  }
  return [...groups.values()];
}

/** Website accounts (ChatGPT.com, Gemini) — status only, nothing launched. */
async function sources(app) {
  try {
    const v = await require('../modelsource/registry').overview(app);
    return v.sources.map((s) => ({ id: s.source, label: s.label, kind: s.kind, state: s.state, why: s.why || '', model: s.selected || null }));
  } catch { return []; }
}

/** THE ROLES a model is assigned to, as LAIN actually has them. */
function roles(app) {
  const inv = require('../modelinventory');
  const cfg = (app._sibling || app).cfg || {};
  const chat = inv.chatSelection(app);
  const coding = inv.codingSelection(app);
  // THE BOT IS NOT THE CHAT SOURCE (sessionintel.js): ChatGPT Chat is CHAT ONLY.
  let bot = null;
  try { const r = require('../sessionintel').resolve(app, app.session); bot = { source: 'lain', modelId: r.bot.model, scope: r.bot.scope }; } catch { bot = { source: 'lain', modelId: cfg.model || null, scope: 'default' }; }
  return {
    chat: { ...chat, label: 'CHAT', purpose: 'the CHAT view conversation', chatOnly: require('../modelroles').isWebSource(chat.source), sourceLabel: require('../modelroles').labelFor(chat.source, chat.source === 'lain' ? 'LAIN' : chat.source) },
    bot: { ...bot, label: 'BOT', purpose: 'conversation, questions, planning, deciding what to do' },
    coding: { ...coding, source: 'lain', label: 'Coding Agent', purpose: 'implementation, refactoring, debugging, tests' },
    defaults: {
      bot: cfg.defaultChat && cfg.defaultChat.source ? { source: cfg.defaultChat.source, modelId: cfg.defaultChat.model || null } : null,
      coding: cfg.model ? { source: 'lain', modelId: cfg.model } : null,
    },
  };
}

async function read(app) {
  return {
    at: Date.now(),
    providers: providers(app),
    sources: await sources(app),
    roles: roles(app),
    usage: require('./stateviews').usage(app),
    // HOW WORK IS SPLIT ACROSS MODELS.
    orchestration: { mode: 'SINGLE_PER_ROLE', available: ['SINGLE_PER_ROLE'] },
  };
}

/** REFRESH: re-discover what every configured route serves. */
async function refresh(app, { force = false, timeoutMs = 45_000 } = {}) {
  const started = Date.now();
  const work = (async () => {
    try { await app.ensureCatalog({ announce: false, force: Boolean(force) }); return { ok: true }; } catch (e) { return { ok: false, why: (e && e.message) || String(e) }; }
  })();
  const r = await require('../deadline').race(work, timeoutMs, () => ({ ok: false, why: `refresh did not finish within ${Math.round(timeoutMs / 1000)}s` }));
  return { ...(await read(app)), refreshed: r.ok, why: r.why || '', ms: Date.now() - started };
}

module.exports = { read, refresh, providers, roles, sources };
