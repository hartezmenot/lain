'use strict';

/**
 * 9ROUTER AS A SOURCE (Phase 8.1) — adopt the accounts the person already
 * connected in 9Router (Antigravity, Claude, Codex, Kiro, Copilot …) instead of
 * signing in to them again.
 *
 *     LAIN → modelrequest → the 9Router connection (its OpenAI-compatible
 *     endpoint, usually http://127.0.0.1:20128/v1) → 9Router → the account
 *
 * 9ROUTER IS AUTH AND TRANSPORT, NOT LAIN'S BRAIN. LAIN keeps sessions, plans,
 * compaction, handover, tools and project state; 9Router only carries a request
 * to an account it already holds.
 *
 * NOTHING IS TAKEN FROM 9ROUTER. Discovery reads 9Router's model catalog — the
 * one LAIN's own connection to 9Router already discovered (connections.js cache,
 * fetched with the access key the person gave LAIN; 9Router 0.5.91 wants that
 * key even for `/v1/models`) — and groups it by the provider prefix 9Router
 * puts on every id (`ag/…` Antigravity, `cx/…` Codex …). Only with no LAIN
 * connection yet is 9Router asked directly (no key, no inference, no quota).
 * 9Router's dashboard API needs its own login and is never called; its data
 * folder (auth, db) is never read. OAuth tokens stay inside 9Router. Requests go
 * through the LAIN connection that points at 9Router, with the 9Router access
 * key the person gave LAIN (kept in the Windows secret store) when it wants one.
 *
 *   status(app)          installed? running? which LAIN connection is 9Router's?
 *   providers(app)       the providers 9Router serves, with model counts, adopted or not
 *   adopt(app, prefix)   add that provider as a LAIN source ("Source: 9Router")
 *   detach(app, prefix)  remove LAIN's reference — the account in 9Router is untouched
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'http://127.0.0.1:20128/v1';
const PORT = 20128;

/** 9Router's provider prefixes, as a person reads them. Unknown prefixes are shown as they are. */
const PREFIX = Object.freeze({
  ag: { label: 'Antigravity', provider: 'google', kind: 'account' },
  agcc: { label: 'Claude (Antigravity)', provider: 'anthropic', kind: 'account' },
  cc: { label: 'Claude Code', provider: 'anthropic', kind: 'account' },
  cx: { label: 'Codex', provider: 'openai', kind: 'account' },
  kr: { label: 'Kiro', provider: 'kiro', kind: 'account' },
  gh: { label: 'GitHub Copilot', provider: 'github', kind: 'account' },
  cu: { label: 'Cursor', provider: 'cursor', kind: 'account' },
  gemini: { label: 'Gemini CLI', provider: 'google', kind: 'account' },
  qd: { label: 'Qwen Code', provider: 'qwen', kind: 'account' },
  ocg: { label: 'OpenCode', provider: 'opencode', kind: 'account' },
  oczen: { label: 'OpenCode Zen', provider: 'opencode', kind: 'api' },
  openrouter: { label: 'OpenRouter', provider: 'openrouter', kind: 'api' },
  ollama: { label: 'Ollama', provider: 'ollama', kind: 'local' },
});

function root(app) { return (app && app._sibling) || app; }
function cfgOf(app) { const r = root(app); return (r && r.cfg) || {}; }
function nr(app) { const c = cfgOf(app); if (!c.ninerouter || typeof c.ninerouter !== 'object') c.ninerouter = {}; if (!c.ninerouter.adopted || typeof c.ninerouter.adopted !== 'object') c.ninerouter.adopted = {}; return c.ninerouter; }
function save(app) { try { require('./config').save(cfgOf(app)); } catch { /* in memory */ } try { require('./appcatalog').invalidate(); } catch { /* not loaded */ } }

function isNineRouterUrl(u) {
  try { const x = new URL(String(u || '')); return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(x.hostname) && Number(x.port) === PORT; } catch { return false; }
}

/**
 * THE LAIN CONNECTIONS THAT ARE 9ROUTERS — one rule, the account catalog's: a
 * connection declared `provider: '9router'`, or one at 9Router's own local
 * address. (This used to know only the address, so a 9Router the catalog listed
 * was "not connected" here, and adopting from it made a second connection.)
 */
function connections9(app) {
  const conns = cfgOf(app).connections || {};
  // PRESENCE ONLY — whether a key is configured, never the key (credentials stay with the transport).
  return Object.entries(conns).filter(([, c]) => c && (String(c.provider || '').toLowerCase() === '9router' || isNineRouterUrl(c.baseUrl)))
    .map(([id, c]) => ({ id, baseUrl: c.baseUrl, hasKey: Boolean(c.credentialRef || c.envKey || Object.prototype.hasOwnProperty.call(c, 'apiKey')) }));
}

/** The LAIN connection that points at 9Router (a named one, else the first), if the person has one. */
function connection(app, id = null) {
  const all = connections9(app);
  return (id ? all.find((c) => c.id === id) : all[0]) || null;
}

function installed() {
  if (process.env.LAIN_ISOLATED === '1') return process.env.LAIN_NINEROUTER_BIN ? { bin: process.env.LAIN_NINEROUTER_BIN } : null;
  const dirs = [path.join(process.env.APPDATA || '', 'npm'), ...String(process.env.PATH || '').split(path.delimiter)];
  for (const d of dirs) for (const n of ['9router.cmd', '9router']) { const p = path.join(d, n); try { if (fs.statSync(p).isFile()) return { bin: p }; } catch { /* next */ } }
  return null;
}

function baseUrl(app, connId = null) {
  const c = connection(app, connId);
  // ISOLATED (a test run): never the person's own 9Router at its default address.
  const fallback = process.env.LAIN_ISOLATED === '1' ? (process.env.LAIN_NINEROUTER_URL || '') : (process.env.LAIN_NINEROUTER_URL || DEFAULT_URL);
  return String((c && c.baseUrl) || nr(app).url || fallback).replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

async function get(url, timeoutMs = 5000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ctl.signal }); return { ok: r.ok, status: r.status, json: r.ok ? await r.json().catch(() => null) : null }; } catch (e) { return { ok: false, why: e.name === 'AbortError' ? 'no answer' : e.message }; } finally { clearTimeout(t); }
}

async function status(app, connId = null) {
  const inst = installed();
  const base = baseUrl(app, connId);
  if (!base) return { installed: false, running: false, url: '', connection: null, why: '9Router was not found on this machine' };
  const origin = base.replace(/\/v1$/, '');
  const h = await get(`${origin}/api/health`, 2500);
  const conn = connection(app, connId);
  return {
    installed: Boolean(inst), running: Boolean(h.ok), url: base,
    connection: conn ? { id: conn.id, hasKey: conn.hasKey } : null,
    why: h.ok ? '' : inst ? '9Router is installed but not running — start it (9router) and refresh' : '9Router was not found on this machine',
  };
}

/** THE PROVIDERS 9ROUTER SERVES — from LAIN's discovered catalog when it has one; no inference, no quota. */
async function providers(app, connId = null) {
  const conn = connection(app, connId);
  const cached = conn ? require('./connections').readCache(conn.id) : null;
  // A CONNECTION THAT DECLARES ITS MODELS (a configured list) is its own catalog.
  const declared = conn ? ((cfgOf(app).connections || {})[conn.id] || {}).models : null;
  let rows = cached && Array.isArray(cached.models) && cached.models.length ? cached.models
    : (Array.isArray(declared) && declared.length ? declared.map((m) => (typeof m === 'string' ? { id: m } : m)) : null);
  const st = rows ? { installed: Boolean(installed()), running: null, url: baseUrl(app, connId), connection: { id: conn.id, hasKey: conn.hasKey }, why: '', from: 'catalog' } : await status(app, connId);
  if (!rows) {
    if (!st.running) return { ok: false, status: st, providers: [], why: st.why };
    const r = await get(`${st.url}/models`, 8000);
    if (!r.ok || !r.json || !Array.isArray(r.json.data)) return { ok: false, status: st, providers: [], why: `9Router's model list did not answer (${r.status || r.why}) — connect Noema to 9Router with its access key first` };
    rows = r.json.data;
  }
  const groups = new Map();
  for (const m of rows) {
    const id = String(m.id || '');
    const i = id.indexOf('/');
    if (i <= 0) continue;
    const p = id.slice(0, i);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push({ id, name: id.slice(i + 1), context: m.context_length || (m.capabilities && m.capabilities.contextWindow) || null, tools: Boolean(m.capabilities && m.capabilities.tools), vision: Boolean(m.capabilities && m.capabilities.vision), reasoning: Boolean(m.capabilities && m.capabilities.reasoning) });
  }
  const adopted = nr(app).adopted;
  const out = [...groups.entries()].map(([prefix, models]) => {
    const k = PREFIX[prefix] || { label: prefix, provider: prefix, kind: 'unknown' };
    return { prefix, label: k.label, provider: k.provider, kind: k.kind, count: models.length, models: models.slice(0, 40), adopted: Boolean(adopted[prefix]), adoptedAt: adopted[prefix] ? adopted[prefix].at : null };
  }).sort((a, b) => Number(b.kind === 'account') - Number(a.kind === 'account') || b.count - a.count);
  return { ok: true, status: st, providers: out };
}

/**
 * ADOPT: a provider 9Router already holds becomes a LAIN source. When LAIN has
 * no connection to 9Router yet, one is created (no key: the person adds the
 * 9Router access key if their 9Router requires one). Nothing is sent to a model.
 */
async function adopt(app, prefix, { key = null } = {}) {
  // THE ACCOUNT THE PERSON CLICKED — `<9Router connection>:<provider>` — names its 9Router exactly;
  // a bare provider ("cx") means the first 9Router LAIN knows.
  let p = String(prefix || '').trim();
  let connId = null;
  const named = connections9(app).find((c) => p.startsWith(`${c.id}:`));
  if (named) { connId = named.id; p = p.slice(named.id.length + 1); }
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(p)) return { ok: false, why: 'name a 9Router provider' };
  const list = await providers(app, connId);
  if (!list.ok) return { ok: false, why: list.why };
  const g = list.providers.find((x) => x.prefix === p) || list.providers.find((x) => x.prefix.split('#')[0] === p);
  if (!g) return { ok: false, why: `9Router does not serve "${p}" now — connect it in 9Router first` };
  const cfg = cfgOf(app);
  let conn = connection(app, connId);
  if (!conn) {
    if (!list.status.url) return { ok: false, why: '9Router was not found on this machine' };
    cfg.connections = cfg.connections || {};
    const id = 'lain:9router';
    cfg.connections[id] = { baseUrl: list.status.url, via: 'native', auth: 'api_key', provider: '9router' };
    if (key) {
      const creds = require('./credentials');
      const ref = creds.ref('lain-9router', 'api_key');
      const r = creds.store(ref, key);
      if (!r.ok) return { ok: false, why: r.why };
      cfg.connections[id].credentialRef = ref;
    }
    conn = { id, baseUrl: list.status.url, hasKey: Boolean(key) };
  }
  nr(app).adopted[p] = { at: new Date().toISOString(), label: g.label, connection: conn.id };
  // ONE SIGN-IN, ONE ADOPTION: Antigravity's Gemini (ag) and Claude (agcc) pools come together.
  for (const [k, v] of Object.entries(require('./accountcatalog').NINE)) {
    if ((v.into === p || (require('./accountcatalog').NINE[p] || {}).into === k) && !nr(app).adopted[k]) nr(app).adopted[k] = { at: new Date().toISOString(), label: v.name, connection: conn.id };
  }
  save(app);
  try { const r = root(app); if (r) r._acctMemo = null; } catch { /* next read rebuilds */ }
  return { ok: true, adopted: { prefix: p, label: g.label, connection: conn.id, models: g.count } };
}

/** DETACH: LAIN forgets this provider. The account inside 9Router is not touched. */
function detach(app, prefix) {
  const a = nr(app).adopted;
  const NINE = require('./accountcatalog').NINE;
  const family = Object.keys(a).filter((k) => k === prefix || (NINE[k] && NINE[k].into === prefix) || (NINE[prefix] && NINE[prefix].into === k));
  if (!family.length) return { ok: false, why: 'that provider is not adopted' };
  for (const k of family) delete a[k];
  save(app);
  try { const r = root(app); if (r) r._acctMemo = null; } catch { /* next read rebuilds */ }
  return { ok: true, detached: prefix, note: 'Removed from Noema only — the account stays connected in 9Router.' };
}

/** Adopted providers, for the MODEL view's Sources (no network). */
function adopted(app) {
  const conn = connection(app);
  return Object.entries(nr(app).adopted).map(([prefix, v]) => ({ prefix, label: v.label || (PREFIX[prefix] || {}).label || prefix, provider: (PREFIX[prefix] || {}).provider || prefix, connection: v.connection || (conn && conn.id) || null, at: v.at }));
}

module.exports = { status, providers, adopt, detach, adopted, connection, connections9, isNineRouterUrl, PREFIX, DEFAULT_URL };
