'use strict';

/**
 * ADD, TEST AND REMOVE A PROVIDER ROUTE — from the window.
 *
 * NO SECOND PROVIDER ARCHITECTURE. `/api <key>` in the terminal already joins
 * the owners in the right order (apicommand.js): providers.js names where a key
 * goes, `store` writes it under `lain:<provider>` in the existing config and
 * registers it with redact.js, `discoverModels` proves it with a catalog read
 * (no tokens spent). This file is that join with the terminal's questions
 * replaced by a form's fields — and two rules learned the hard way elsewhere:
 *
 *   A KEY THAT DOES NOT WORK IS NOT KEPT. The terminal flow stores first and
 *   reports; a form submitted with a typo would leave a dead credential behind
 *   a row that looks configured. So a failed proof puts the previous entry back
 *   (or none), and the provider's own words are returned.
 *
 *   REMOVAL NEEDS A FRESH INTENT. A route id alone is not enough to delete it
 *   (a real account was lost to a blind delete in a router studied for this —
 *   see the final report). The first call returns what would go and a
 *   single-use token bound to that id; only the second call, within two
 *   minutes, removes it.
 *
 * NOTHING SECRET GOES BACK. Every answer carries the key's shape (`sk-…9f2a`)
 * at most — never the key, a header, or a URL with a query.
 */

const crypto = require('crypto');

function root(app) { return (app && app._sibling) || app; }
function bad(why, extra = {}) { return { ok: false, why: String(why), ...extra }; }

// WHERE EACH PROVIDER ISSUES KEYS — its own documented page, opened in the
// person's browser (native host `openExternal`). Only pages that are the
// provider's own and stable; a provider absent here simply gets no link rather
// than a guessed one.
const KEY_PAGES = Object.freeze({
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openrouter: 'https://openrouter.ai/keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  gemini: 'https://aistudio.google.com/app/apikey',
});

/** Where a key can go: the built-in endpoints, then the person's own. */
function choices(app) {
  const cfg = root(app).cfg || {};
  let list = [];
  try { list = require('../providers').choices(cfg); } catch { list = []; }
  return list.map((p) => ({
    id: p.id,
    label: p.label || p.id,
    protocol: p.protocol || 'chat',
    host: (() => { try { return p.baseUrl ? new URL(p.baseUrl).host : ''; } catch { return ''; } })(),
    needsBaseUrl: !p.baseUrl,
    known: Boolean(p.known),
    keysUrl: KEY_PAGES[p.id] || null,
  }));
}

/** Add (or re-key) a provider's API key, and keep it only if it works. */
async function addKey(app, { provider, key, baseUrl = '', protocol = '' } = {}) {
  const r = root(app);
  const api = require('../apicommand');
  const cred = String(key || '').trim();
  if (!cred) return bad('paste the API key');
  if (/\s/.test(cred) || cred.length < 8) return bad('that does not look like an API key (no spaces, at least 8 characters)');
  const pick = choices(r).find((p) => p.id === String(provider || ''));
  if (!pick) return bad('choose a provider');
  const url = String(baseUrl || '').trim();
  if (pick.needsBaseUrl || url) {
    const why = api.validBaseUrl(url);
    if (why) return bad(why);
  }
  const config = require('../config');
  const id = require('../providers').connectionIdFor(pick.id);
  const cfg = r.cfg;
  const before = cfg.connections && cfg.connections[id] ? { ...cfg.connections[id] } : null;
  api.store(r, config, { provider: pick.id, protocol: protocol || pick.protocol, baseUrl: url, credential: cred, connectionId: id });
  const found = await api.discoverModels(r, id);
  if (!found.ok) {
    const tried = cfg.connections[id];
    if (tried && tried.credentialRef && (!before || before.credentialRef !== tried.credentialRef)) require('../credentials').remove(tried.credentialRef);
    if (before) cfg.connections[id] = before; else delete cfg.connections[id];
    config.save(cfg);
    return bad(`${pick.label} did not accept it: ${found.error}`, { kept: false });
  }
  api.retire(before, cfg.connections[id]);
  try { await r.ensureCatalog({ announce: false, force: true }); } catch { /* the models appear on the next refresh */ }
  // THE SAFE COMPLETION EVENT (Phase 8.3) — what a CLI that opened the dashboard is told: an id, a name,
  // what it can do. Never the key.
  try { require('../fabric/store').event('source-added', { kind: 'api', id, name: pick.label, capabilities: { models: (found.models || []).length, chat: true }, replaced: Boolean(before) }); } catch { /* the registry reports on the next read */ }
  return { ok: true, connection: id, provider: pick.id, label: pick.label, key: api.shapeOf(cred), models: (found.models || []).length, replaced: Boolean(before) };
}

/** Prove a configured route still works — a catalog read, no tokens spent. */
async function test(app, { id } = {}) {
  const r = root(app);
  const conn = (r.connections() || []).find((c) => c.id === String(id || ''));
  if (!conn) return bad('no such connection');
  const found = await require('../apicommand').discoverModels(r, conn.id);
  return found.ok ? { ok: true, connection: conn.id, models: (found.models || []).length } : bad(found.error, { connection: conn.id });
}

// ---- removal, in two steps -------------------------------------------------
const INTENT_MS = 2 * 60_000;
const intents = new Map();   // token -> { id, at }

function impact(app, id) {
  const r = root(app);
  const cfg = r.cfg || {};
  const conn = (r.connections() || []).find((c) => c.id === id);
  const inv = (() => { try { return require('../modelinventory'); } catch { return null; } })();
  const uses = [];
  const serves = (modelId) => Boolean(conn && modelId && (conn.models || []).some((m) => (typeof m === 'string' ? m : m && m.id) === modelId));
  try { const co = inv && inv.codingSelection(r); if (co && (co.connectionId === id || (!co.connectionId && serves(co.modelId)))) uses.push('the Coding Agent model'); } catch { /* unknown */ }
  try { const ch = inv && inv.chatSelection(r); if (ch && ch.source === 'lain' && serves(ch.modelId)) uses.push('the BOT model'); } catch { /* unknown */ }
  return { connection: id, provider: conn ? conn.provider : null, models: conn ? (conn.models || []).length : 0, usedBy: uses, declared: Boolean(cfg.connections && cfg.connections[id]) };
}

/** Step one: what would go, and the token that allows it. Step two: remove. */
function remove(app, { id, token = null } = {}) {
  const r = root(app);
  const cid = String(id || '');
  const cfg = r.cfg || {};
  const entry = cfg.connections && cfg.connections[cid];
  if (!entry) return bad('that connection is not one Noema stores (an environment key is removed where it was set)');
  if (entry.via === 'bridge') return bad('a bridge holds its own sign-in; remove it in the bridge');
  const now = Date.now();
  for (const [t, v] of intents) if (now - v.at > INTENT_MS) intents.delete(t);
  if (!token) {
    const t = crypto.randomBytes(16).toString('hex');
    intents.set(t, { id: cid, at: now });
    return { ok: true, confirm: true, token: t, expiresInMs: INTENT_MS, impact: impact(r, cid) };
  }
  const intent = intents.get(String(token));
  intents.delete(String(token));
  if (!intent || intent.id !== cid) return bad('that confirmation has expired or was for another connection — ask again');
  if (entry.credentialRef) require('../credentials').remove(entry.credentialRef);
  delete cfg.connections[cid];
  require('../config').save(cfg);
  return { ok: true, removed: cid };
}

module.exports = { choices, addKey, test, remove, INTENT_MS };
