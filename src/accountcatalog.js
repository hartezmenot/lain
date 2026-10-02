'use strict';

/**
 * ACCOUNT FIRST (Phase 8.2) — WHICH ACCOUNT a request goes through, then which
 * model that account offers.
 *
 *     ACCOUNT  ─▶  MODEL  ─▶  EFFORT  ─▶  EXECUTION
 *
 * A model name alone never says who pays for a request: `gpt-6-sol` is offered
 * by the Codex accounts 9Router holds, by Orca inside 9Router, by an OpenAI API
 * key … Before this, the Chat lane stored the model only and `catalog.resolve`
 * took the FIRST route serving it. Every choice now names its account, and a
 * request is resolved through exactly that account or refused before it is sent.
 *
 * ------------------------------------------------------------------------
 * AN ACCOUNT IS A ROUTE LAIN CAN SEND THROUGH, named for what owns its sign-in:
 *
 *   OAuth · 9Router    <9router-conn>:<prefix>   a provider pool 9Router holds
 *                                                (Codex, Claude Code, Antigravity …)
 *   Runtime            runtime:<id>              a runtime's own sign-in
 *                                                (Claude Code, OpenCode, ZCode)
 *   Runtime (native)   runtime:codex:<instance>  one Codex home = one ChatGPT account
 *   API                <connection id>           an API key LAIN holds
 *   Local              local:llamacpp · local:ollama
 *
 * ------------------------------------------------------------------------
 * 9ROUTER CHOOSES INSIDE A POOL, AND LAIN SAYS SO. 9Router's chat endpoint
 * (0.5.91) does not let a client pin one of the accounts it holds for a
 * provider, and does not report which one answered: it picks by its own
 * strategy and falls over to the next on a limit. So a 9Router pool is ONE
 * account to LAIN — `pinned: false`, with that sentence on it — and a request
 * "through Codex · 9Router" is exactly that, never claimed to be one ChatGPT
 * login. A specific Codex login is a native Codex account (its own home).
 *
 * WHAT THIS READS: the catalog LAIN already built (connections.js discovery
 * cache — no network), the runtime registry and telemetry caches, and 9Router
 * adoption in config. Nothing here sends a request, and nothing secret is held.
 */

const fs = require('fs');
const path = require('path');

const KIND = Object.freeze({ OAUTH: 'oauth', RUNTIME: 'runtime', API: 'api', LOCAL: 'local', ROUTER: 'router' });

/**
 * 9ROUTER PROVIDER PREFIXES, as people know them. `oauth` pools are
 * subscriptions signed in inside 9Router; the rest are API providers 9Router
 * carries. `into` merges a prefix into another account (the Antigravity
 * sign-in serves both Gemini `ag/…` and Claude `agcc/…`).
 */
const NINE = Object.freeze({
  cc: { family: 'claude', name: 'Claude Code', oauth: true },
  cx: { family: 'codex', name: 'Codex', oauth: true },
  ag: { family: 'antigravity', name: 'Antigravity', oauth: true },
  agcc: { family: 'antigravity', name: 'Antigravity', oauth: true, into: 'ag' },
  gemini: { family: 'antigravity', name: 'Antigravity', oauth: true, into: 'ag' },   // Google's coding CLI is Antigravity (8.4.1)
  gh: { family: 'copilot', name: 'GitHub Copilot', oauth: true },
  kr: { family: 'kiro', name: 'Kiro', oauth: true },
  cu: { family: 'cursor', name: 'Cursor', oauth: true },
  qd: { family: 'qwen', name: 'Qwen Code', oauth: true },
  ocg: { family: 'opencode', name: 'OpenCode Go', oauth: true },
  oczen: { family: 'opencode', name: 'OpenCode Zen', oauth: false },
  openrouter: { family: 'router', name: 'OpenRouter', oauth: false },
  ollama: { family: 'local', name: 'Ollama (via 9Router)', oauth: false },
});

// NO `zai` ACCOUNT FAMILY (2026-09-29): LAIN integrates Z.ai through its API — an `api` source named "Z.ai API".
const FAMILY = Object.freeze({
  claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', gemini: 'Gemini', copilot: 'GitHub Copilot',
  opencode: 'OpenCode', kiro: 'Kiro', cursor: 'Cursor', qwen: 'Qwen', local: 'Local', api: 'API', router: 'More in 9Router',
});
const FAMILY_ORDER = ['claude', 'codex', 'antigravity', 'gemini', 'copilot', 'opencode', 'kiro', 'cursor', 'qwen', 'local', 'api', 'router'];

/** An API endpoint named the way its owner names it. */
const API_HOSTS = [
  [/(^|\.)api\.openai\.com$/i, 'OpenAI API'],
  [/(^|\.)api\.anthropic\.com$/i, 'Anthropic API'],
  [/(^|\.)z\.ai$/i, 'Z.ai API'],
  [/(^|\.)bigmodel\.cn$/i, 'Zhipu API'],
  [/(^|\.)deepseek\.com$/i, 'DeepSeek API'],
  [/(^|\.)openrouter\.ai$/i, 'OpenRouter API'],
  [/(^|\.)generativelanguage\.googleapis\.com$/i, 'Gemini API'],
  [/(^|\.)mistral\.ai$/i, 'Mistral API'],
  [/(^|\.)groq\.com$/i, 'Groq API'],
  [/(^|\.)x\.ai$/i, 'xAI API'],
];

function root(app) { return (app && app._sibling) || app; }
function cfgOf(app) { const r = root(app); return (r && r.cfg) || {}; }

function hostOf(u) { try { return new URL(String(u || '')).host; } catch { return ''; } }
/** A connection to 9Router: its well-known local port, or declared as one (ninerouter.adopt creates provider '9router'). */
function isNine(conn) {
  if (conn && String(conn.provider || '').toLowerCase() === '9router') return true;
  try { return require('./ninerouter').isNineRouterUrl(conn && conn.baseUrl); } catch { return false; }
}

/** A provider named in the connection's own config, when the host does not say. */
const API_PROVIDERS = Object.freeze({ openai: 'OpenAI API', anthropic: 'Anthropic API', zai: 'Z.ai API', deepseek: 'DeepSeek API', openrouter: 'OpenRouter API', gemini: 'Gemini API', google: 'Gemini API', mistral: 'Mistral API', groq: 'Groq API', xai: 'xAI API' });

function apiLabel(conn) {
  const host = hostOf(conn.baseUrl);
  const bare = host.replace(/:\d+$/, '');
  if (/opencode\.ai$/i.test(bare)) return /\/go\b/i.test(String(conn.baseUrl)) ? 'OpenCode Go API' : 'OpenCode Zen API';
  for (const [re, label] of API_HOSTS) if (re.test(bare)) return label;
  const named = API_PROVIDERS[String(conn.provider || '').toLowerCase()];
  if (named) return named;
  if (/^(localhost|127\.|\[::1\])/i.test(host)) return `Local endpoint ${host}`;
  return host ? `${host} API` : conn.id;
}

/**
 * THE ACCOUNT A ROUTE BELONGS TO — pure, so provider.resolve can stamp a
 * request with it without an App. `route` is a catalog route connectionId,
 * `base` the configured connection it goes through.
 */
function accountIdForRoute(route, base) {
  const r = String(route || '');
  if (!r) return null;
  // A NATIVE CODEX ROUTE IS ITS ACCOUNT INSTANCE (one home = one ChatGPT sign-in).
  if (base && (base.runtime === 'codex' || base.runtime === 'claude-code' || base.runtime === 'antigravity') && base.instanceId) return base.instanceId;
  if (base && isNine(base) && r.startsWith(`${base.id}:`)) {
    // AN ACCESS TIER (`cl#free`, `orca#batch`) is a way to reach the same provider, not another account.
    const prefix = r.slice(base.id.length + 1).split('#')[0];
    const into = NINE[prefix] && NINE[prefix].into;
    return `${base.id}:${into || prefix}`;
  }
  if (base && base.id) return base.id;
  return r;
}

// ------------------------------------------------------------------ build --

// A FILE'S MTIME, looked at no more than every 250 ms (Phase 8.3): a poll resolves several lanes, and each read
// of the account list asked the disk about the same four files. A writer in this process drops the memo itself.
const MTIMES = new Map();
function mtime(f) {
  const now = Date.now();
  const m = MTIMES.get(f);
  if (m && now - m.at < 250) return m.v;
  let v = 0;
  try { v = fs.statSync(f).mtimeMs; } catch { v = 0; }
  MTIMES.set(f, { v, at: now });
  return v;
}
/** A WRITER IN THIS PROCESS changed a watched file: the next read looks at the disk again. */
// (A GENERATION TOO: a per-account telemetry file — claude-code--<id>.json — is not one of the files the list is keyed on.)
let WRITES = 0;
function touched(f) { WRITES++; if (f) MTIMES.delete(f); else MTIMES.clear(); }
function telemetryFile(id) { try { return path.join(require('./config').configDir(), 'runtimes', `${id}.json`); } catch { return ''; } }
function telemetry(id) { try { return require('./runtimeadapters').cachedTelemetry(id); } catch { return null; } }

function windowsOf(limits) {
  if (!limits || !Array.isArray(limits.windows)) return null;
  const w = limits.windows.filter((x) => x && (x.usedPercent != null || x.resetsAt)).map((x) => ({
    id: x.id || null, windowMins: Number(x.windowMins || x.mins) || null,
    label: x.label || x.id || '', usedPercent: x.usedPercent == null ? null : Math.round(Number(x.usedPercent)), resetsAt: x.resetsAt || null, expired: Boolean(x.expired),
  }));
  return w.length ? w : null;
}

function names(app) { const a = cfgOf(app).accounts; return (a && a.names && typeof a.names === 'object') ? a.names : {}; }

/**
 * EVERY ACCOUNT, grouped by the company whose sign-in it is. Memoised on
 * everything it reads, so a picker, a status line or a redraw costs a lookup.
 */
function list(app) {
  const r = root(app);
  // ANOTHER LAIN CHANGED THE REGISTRY (the Harness added an API while this CLI runs): taken from disk first.
  try { require('./fabric/sync').sync(r); } catch { /* the memo below still answers */ }
  let conns = [];
  try { conns = require('./appcatalog').connections(r); } catch { conns = []; }
  let cat = null;
  try { cat = r.catalog(); } catch { cat = null; }
  const cfg = cfgOf(app);
  const sig = [cat, cfg.ninerouter, cfg.accounts, cfg.runtimes, mtime(safe(() => require('./accountinstances').file())),
    mtime(telemetryFile('claude-code')), mtime(telemetryFile('opencode')), mtime(telemetryFile('zcode')), WRITES];
  const m = r && r._acctMemo;
  if (m && m.cat === cat && JSON.stringify(sig.slice(1)) === m.rest) return m.value;
  const value = build(app, conns, cat);
  if (r) r._acctMemo = { cat, rest: JSON.stringify(sig.slice(1)), value };
  return value;
}
function safe(fn) { try { return fn(); } catch { return null; } }

function build(app, conns, cat) {
  const cfg = cfgOf(app);
  const nm = names(app);
  const byId = new Map(conns.map((c) => [c.id, c]));
  const out = new Map();   // account id -> account
  const adopted = (cfg.ninerouter && cfg.ninerouter.adopted) || {};
  const put = (acct) => { if (!out.has(acct.id)) out.set(acct.id, { routes: [], modelCount: 0, ...acct }); return out.get(acct.id); };

  // ---- routes the catalog knows (API, 9Router pools, runtime, local) -----
  for (const model of (cat && cat.models) || []) {
    for (const route of model.connections || []) {
      const base = byId.get(route.baseConnectionId) || null;
      if (!base) continue;
      const id = accountIdForRoute(route.connectionId, base);
      let acct = out.get(id);
      if (!acct) acct = put(describe(app, id, route, base, adopted, nm));
      if (!acct.routes.includes(route.connectionId)) acct.routes.push(route.connectionId);
      acct.modelCount += 1;
    }
  }

  // ---- runtime accounts with no route yet (a native Codex home) ----------
  let instances = [];
  try { instances = require('./accountinstances').list(app).filter((v) => v.source_type === 'runtime'); } catch { instances = []; }
  for (const v of instances) {
    if (v.driver_id !== 'codex' && v.driver_id !== 'claude-code' && v.driver_id !== 'antigravity') continue;
    const claude = v.driver_id === 'claude-code';
    const agy = v.driver_id === 'antigravity';
    const id = v.id;
    const acct = out.get(id) || put({
      id, kind: KIND.RUNTIME, family: claude ? 'claude' : agy ? 'antigravity' : 'codex', name: nm[id] || v.display_name,
      auth: claude ? 'Runtime · Claude Code' : agy ? 'Runtime · Antigravity' : 'Runtime · Codex', source: claude ? 'Claude Code' : agy ? 'Antigravity' : 'Codex', base: null, pinned: true, adopted: true,
    });
    acct.ownership = v.ownership || null;
    acct.name = nm[id] || v.display_name || acct.name;   // a name, never the instance id a route was first keyed by
    acct.instanceId = v.id;
    if (agy) acct.verified = Boolean(v.verified_at);   // ONLY Antigravity's capabilities wait for a real execution
    acct.identity = v.identity ? { email: v.identity.email || null, plan: v.identity.planType || null } : null;
    acct.state = stateOfInstance(v);
    acct.quota = windowsOf(v.limits);
    acct.quotaAt = (v.limits && (v.limits.observedAt || v.limits.at)) || 0;
    acct.quotaBasis = (v.limits && (v.limits.basis || v.limits.reportedBy)) || null;
    const who = claude ? 'Claude Code' : agy ? 'Antigravity' : 'Codex';
    acct.quotaNote = acct.quota ? null : (v.limits_error || `${who} has not reported limits yet`);
    // ITS ROUTE (runtime:<driver>:<id>) EXISTS once it is signed in and the runtime has listed its models.
    if (!acct.routes.length) {
      acct.usable = false;
      acct.why = acct.state === 'READY' ? `${who} has not listed this account's models yet — Refresh it` : `not signed in — sign in with ${who}'s own sign-in to use it`;
    }
  }

  const list = [...out.values()].map((a) => finish(a));
  // TWO ACCOUNTS WITH ONE NAME (two keys for the same service) are told apart by their id.
  const seen = new Map();
  for (const a of list) seen.set(`${a.family}|${a.name}`, (seen.get(`${a.family}|${a.name}`) || 0) + 1);
  for (const a of list) if (seen.get(`${a.family}|${a.name}`) > 1 && !(names(app)[a.id])) a.name = `${a.name} · ${a.id.replace(/^lain:/, '')}`;
  list.sort((a, b) => (FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family)) || (Number(b.adopted) - Number(a.adopted)) || a.name.localeCompare(b.name));
  return { accounts: list, byId: new Map(list.map((a) => [a.id, a])), at: Date.now() };
}

function stateOfInstance(v) {
  const s = String(v.authentication_state || '').toUpperCase();
  if (s === 'AUTHENTICATED' || s === 'SIGNED_IN') return 'READY';
  if (/LOGIN|SIGN/.test(s)) return 'SIGN_IN';
  if (String(v.runtime_state || '') === 'NOT_INSTALLED') return 'NOT_INSTALLED';
  return s ? s : 'UNKNOWN';
}

function describe(app, id, route, base, adopted, nm) {
  // RUNTIME AND LOCAL ROUTES (runtimeconnections.js)
  if (base.protocol === 'runtime') {
    if (base.locality === 'local') {
      const name = base.runtime === 'ollama' ? 'Ollama' : 'llama.cpp';
      return { id, kind: KIND.LOCAL, family: 'local', name: nm[id] || name, auth: 'Local', source: name, base: base.id, pinned: true, adopted: true, state: 'READY', quotaNote: 'a local model has no provider quota' };
    }
    const rt = base.runtime;
    if (rt === 'antigravity' && base.instanceId) {
      return { id, kind: KIND.RUNTIME, family: 'antigravity', name: nm[id] || base.instanceId, auth: 'Runtime · Antigravity', source: 'Antigravity', base: base.id, pinned: true, adopted: true, instanceId: base.instanceId, state: 'READY' };
    }
    if (rt === 'claude-code' && base.instanceId) {
      // ONE OF THE CLAUDE ACCOUNTS LAIN CONNECTED — its own configuration directory; the loop below fills in who it is.
      return { id, kind: KIND.RUNTIME, family: 'claude', name: nm[id] || base.instanceId, auth: 'Runtime · Claude Code', source: 'Claude Code', base: base.id, pinned: true, adopted: true, instanceId: base.instanceId, state: 'READY' };
    }
    if (rt === 'codex' && base.instanceId) {
      // THE INSTANCE LOOP BELOW FILLS IN WHO IT IS (identity, limits, state) — the same account id.
      return { id, kind: KIND.RUNTIME, family: 'codex', name: nm[id] || base.instanceId, auth: 'Runtime · Codex', source: 'Codex', base: base.id, pinned: true, adopted: true, instanceId: base.instanceId, state: 'READY' };
    }
    const tele = telemetry(rt) || {};
    const ident = tele.identity || null;
    if (rt === 'claude-code') {
      const plan = ident && ident.plan ? String(ident.plan).replace(/^\w/, (c) => c.toUpperCase()) : null;
      return {
        id, kind: KIND.RUNTIME, family: 'claude', name: nm[id] || (plan ? `Claude ${plan}` : 'Claude'),
        auth: 'Runtime · Claude Code', source: 'Claude Code', base: base.id, pinned: true, adopted: true, ownership: 'external_native',
        identity: ident ? { email: ident.email || null, plan: ident.plan || null } : null,
        state: ident && ident.signedIn === false ? 'SIGN_IN' : 'READY',
        quota: windowsOf(tele.limits), quotaAt: (tele.limits && tele.limits.at) || 0, quotaBasis: (tele.limits && tele.limits.basis) || null, quotaNote: tele.limits ? null : require('./drivers/claudeaccount').QUOTA_NOTE,
      };
    }
    if (rt === 'opencode') return { id, kind: KIND.RUNTIME, family: 'opencode', name: nm[id] || 'OpenCode', auth: 'Runtime · OpenCode', source: 'OpenCode', base: base.id, pinned: true, adopted: true, state: 'READY', quotaNote: 'OpenCode does not report limits for its models' };
    return { id, kind: KIND.RUNTIME, family: 'api', name: nm[id] || rt, auth: `Runtime · ${rt}`, source: rt, base: base.id, pinned: true, adopted: true, state: 'READY' };
  }
  // A 9ROUTER POOL
  if (isNine(base) && id !== base.id) {
    const prefix = id.slice(base.id.length + 1);
    const k = NINE[prefix] || { family: 'router', name: prefix, oauth: false };
    const took = Boolean(adopted[prefix] || Object.entries(NINE).some(([p, v]) => v.into === prefix && adopted[p]));
    return {
      id, kind: k.oauth ? KIND.OAUTH : KIND.ROUTER, family: k.oauth ? k.family : (k.family === 'local' ? 'router' : k.family),
      name: nm[id] || k.name, auth: k.oauth ? 'OAuth · 9Router' : 'Provider · 9Router', source: '9Router', base: base.id, prefix,
      pinned: false, adopted: took,
      note: k.oauth
        ? `9Router holds the ${k.name} sign-in and chooses which of its ${k.name} accounts answers; LAIN cannot pin one account through 9Router`
        : `a provider 9Router carries with its own key; 9Router chooses how it is reached`,
      state: stateOfBase(base), quotaNote: '9Router does not report account quota to LAIN',
    };
  }
  // AN API KEY LAIN HOLDS (or a keyless local endpoint)
  const uw = safe(() => require('./usagewindows').forConnection(base.id));
  const st = stateOfBase(base);
  return {
    id, kind: KIND.API, family: 'api', name: nm[id] || apiLabel(base), auth: base.via === 'bridge' ? 'Bridge' : 'API key', source: hostOf(base.baseUrl) || base.id,
    base: base.id, pinned: true, adopted: true, state: st, endpoint: String(base.baseUrl || ''),
    // A KEYED API WITHOUT A USABLE KEY IS NOT A ROUTE (2026-09-29): "Z.ai API · GLM 5.3 Flash" was offered —
    // and chosen — with no key behind it. It stays listed in MODEL › API, with the reason; it is never routed.
    ...(st === 'KEY_NEEDED' ? { usable: false, why: 'no API key — add one in MODEL › API' } : {}),
    ...(st === 'KEY_REFUSED' ? { usable: false, why: 'the provider refused this key, or it expired — replace it in MODEL › API' } : {}),
    quota: uw ? windowsOf(uw) : null, quotaAt: (uw && uw.at) || 0, quotaBasis: uw ? 'provider response headers' : null, quotaNote: uw ? null : 'limits appear after the provider reports them on a response',
  };
}

function stateOfBase(base) {
  const r = String(base.readiness || '').toUpperCase();
  if (r === 'AUTHENTICATED' || r === 'READY' || r === 'CONFIGURED' || r === 'REQUEST_READY') return 'READY';
  // NO CREDENTIAL AT ALL: a keyless endpoint (a bridge, `auth: none`) has nothing missing; a keyed API needs one.
  if (r === 'NONE') return base.via === 'bridge' || base.auth === 'none' ? 'READY' : 'KEY_NEEDED';
  // A CREDENTIAL THE PROVIDER REFUSED, or one that expired (connections.readinessFor).
  if (r === 'CREDENTIAL_FOUND') return 'KEY_REFUSED';
  if (/AUTH|KEY|EXPIRED/.test(r)) return 'SIGN_IN';
  return r || 'UNKNOWN';
}

const STATE_LABEL = Object.freeze({ READY: 'Ready', SIGN_IN: 'Sign-in needed', KEY_NEEDED: 'Key needed', KEY_REFUSED: 'Key refused', NOT_INSTALLED: 'Not installed', UNREACHABLE: 'Unreachable', UNKNOWN: 'Unknown' });

function finish(a) {
  return {
    usable: true, why: '', identity: null, quota: null, quotaNote: null, note: '', prefix: null, instanceId: null,
    ...a,
    familyLabel: FAMILY[a.family] || a.family,
    stateLabel: STATE_LABEL[a.state] || String(a.state || 'Unknown').replace(/_/g, ' ').toLowerCase(),
  };
}

// --------------------------------------------------------------- queries --

function find(app, id) { return list(app).byId.get(String(id || '')) || null; }

/** The account a stored route/connection id means — a route id, a base connection id, or an account id. */
function accountFor(app, idOrRoute) {
  const want = String(idOrRoute || '');
  if (!want) return null;
  const L = list(app);
  if (L.byId.has(want)) return L.byId.get(want);
  for (const a of L.accounts) if (a.routes.includes(want)) return a;
  return null;
}

/** The models an account offers, each with the exact route it is reached by. */
function models(app, accountId, { query = '', limit = 400 } = {}) {
  const acct = find(app, accountId);
  if (!acct) return [];
  let cat = null;
  try { cat = root(app).catalog(); } catch { cat = null; }
  const out = [];
  const rtRows = new Map();
  try { for (const rc of require('./runtimeconnections').connections(root(app))) for (const x of rc.models) rtRows.set(`${rc.id}|${x.id}`, x); } catch { /* none */ }
  for (const m of (cat && cat.models) || []) {
    const route = (m.connections || []).find((c) => acct.routes.includes(c.connectionId));
    if (!route) continue;
    const rt = rtRows.get(`${route.connectionId}|${m.id}`) || rtRows.get(`${baseOf(route)}|${route.upstreamId || m.id}`) || rtRows.get(`${baseOf(route)}|${m.id}`) || null;
    const roles = rt ? (rt.roles || []) : ['CHAT', 'BOT', 'AGENT'];
    const label = (rt && rt.label) || cleanLabel(m, route);
    out.push({
      id: m.id, label, route: route.connectionId, upstreamId: route.upstreamId || m.id,
      efforts: route.efforts || [], roles, coding: roles.includes('AGENT'), chat: roles.includes('CHAT') || roles.includes('BOT'),
    });
  }
  const q = String(query || '').trim().toLowerCase();
  const hit = q ? out.filter((x) => `${x.id} ${x.label}`.toLowerCase().includes(q)) : out;
  return hit.slice(0, Math.max(1, Math.min(2000, Number(limit) || 400)));
}

/**
 * THE ROUTE THAT CARRIES `model` FOR `account` — or a refusal naming the
 * accounts that do offer it. Never another account's route.
 */
function routeFor(app, accountId, modelId) {
  const acct = find(app, accountId);
  if (!acct) return { ok: false, code: 'NO_ACCOUNT', why: `no account "${accountId}" is configured` };
  if (!acct.usable) return { ok: false, code: 'ACCOUNT_UNUSABLE', why: `${acct.name}: ${acct.why}`, account: acct };
  let cat = null;
  try { cat = root(app).catalog(); } catch { cat = null; }
  const m = cat && cat.byId && cat.byId.get(String(modelId || ''));
  if (!m) return { ok: false, code: 'NO_MODEL', why: `"${modelId}" is not in any account's catalog`, account: acct };
  const route = (m.connections || []).find((c) => acct.routes.includes(c.connectionId));
  if (!route) {
    const others = offering(app, m.id).filter((a) => a.id !== acct.id).map((a) => a.name);
    return { ok: false, code: 'NOT_OFFERED', why: `${acct.name} does not offer ${m.displayName || m.id}${others.length ? ` — it is offered by ${others.slice(0, 4).join(', ')}` : ''}`, account: acct };
  }
  // RUNTIME-BOUND (runtimebound.js): a model its provider serves only inside a runtime is listed, never sent over HTTP.
  const conn = safe(() => require('./appcatalog').connections(root(app)).find((c) => c.id === (route.baseConnectionId || route.connectionId))) || {};
  const bound = safe(() => require('./runtimebound').check({ conn, connectionId: route.connectionId, model: m.id, upstreamId: route.upstreamId || m.id }));
  if (bound) return { ok: false, code: 'runtime-bound', why: bound.why, account: acct };
  return { ok: true, account: acct, model: m.id, connectionId: route.connectionId, baseConnectionId: route.baseConnectionId || null, upstreamId: route.upstreamId || m.id };
}

/** The connection a route belongs to — `runtime:codex:<n>` has three parts, so never guess it from the id. */
function baseOf(route) { return (route && (route.baseConnectionId || String(route.connectionId || '').split(':').slice(0, 2).join(':'))) || null; }

/** THE ROUTER'S NAMESPACE IS THE ACCOUNT, already chosen: `cx/gpt-6-sol` reads "GPT 6 SOL" under Codex. */
function cleanLabel(m, route) {
  const ns = route && route.route ? String(route.route).split('#')[0] : null;
  const bare = ns && m.id.toLowerCase().startsWith(`${ns.toLowerCase()}/`) ? m.id.slice(ns.length + 1) : null;
  return bare ? require('./catalog').displayName(bare) : (m.displayName || m.id);
}

/** A model's name as its account shows it. */
function modelLabel(app, accountId, modelId) {
  let cat = null;
  try { cat = root(app).catalog(); } catch { cat = null; }
  const m = cat && cat.byId && cat.byId.get(String(modelId || ''));
  if (!m) return modelId ? String(modelId) : '';
  const acct = accountId ? find(app, accountId) : null;
  const route = acct ? (m.connections || []).find((c) => acct.routes.includes(c.connectionId)) : null;
  if (route) {
    const rt = safe(() => require('./runtimeconnections').rowFor(root(app), m.id, baseOf(route)));
    if (rt && rt.label) return rt.label;
  }
  return cleanLabel(m, route);
}

/** Accounts that offer a model (by canonical id). */
function offering(app, modelId) {
  let cat = null;
  try { cat = root(app).catalog(); } catch { cat = null; }
  const m = cat && cat.byId && cat.byId.get(String(modelId || ''));
  if (!m) return [];
  const L = list(app);
  const ids = new Set();
  for (const c of m.connections || []) for (const a of L.accounts) if (a.routes.includes(c.connectionId)) ids.add(a.id);
  return L.accounts.filter((a) => ids.has(a.id));
}

/**
 * THE MODEL TO USE WHEN AN ACCOUNT IS CHOSEN WITHOUT ONE — only a declared
 * one: the person's per-account default, the connection's own `default`, or
 * the only model it has. Otherwise null, and the caller asks.
 */
function defaultModel(app, accountId) {
  const acct = find(app, accountId);
  if (!acct) return null;
  const cfg = cfgOf(app);
  const mine = cfg.accounts && cfg.accounts.defaults && cfg.accounts.defaults[acct.id];
  const offered = models(app, acct.id, { limit: 2000 });
  if (mine && offered.some((x) => x.id === mine)) return mine;
  const conn = acct.base && cfg.connections && cfg.connections[acct.base];
  if (conn && conn.default) { const hit = offered.find((x) => x.id === conn.default || x.upstreamId === conn.default); if (hit) return hit.id; }
  return offered.length === 1 ? offered[0].id : null;
}

/** Rename an account for this person (display only). */
function rename(app, id, name) {
  const n = String(name || '').trim().slice(0, 60);
  const acct = find(app, id);
  if (!acct) return { ok: false, why: 'no such account' };
  const cfg = cfgOf(app);
  cfg.accounts = cfg.accounts || {};
  cfg.accounts.names = cfg.accounts.names || {};
  if (n) cfg.accounts.names[acct.id] = n; else delete cfg.accounts.names[acct.id];
  try { require('./config').save(cfg); } catch { /* in memory */ }
  return { ok: true };
}

/** A per-account default model (what choosing the account selects). */
function setDefaultModel(app, id, model) {
  const acct = find(app, id);
  if (!acct) return { ok: false, why: 'no such account' };
  // AN ALIAS (a spelling the catalog folded) is stored as the canonical id.
  let canon = model;
  try { const m = model && root(app).catalog().byId.get(model); if (m) canon = m.id; } catch { /* stored as given */ }
  if (model && !models(app, acct.id, { limit: 5000 }).some((x) => x.id === canon)) return { ok: false, why: `${acct.name} does not offer that model` };
  model = canon;
  const cfg = cfgOf(app);
  cfg.accounts = cfg.accounts || {};
  cfg.accounts.defaults = cfg.accounts.defaults || {};
  if (model) cfg.accounts.defaults[acct.id] = model; else delete cfg.accounts.defaults[acct.id];
  try { require('./config').save(cfg); } catch { /* in memory */ }
  return { ok: true };
}

/** The safe projection a window or a terminal draws. */
function view(a) {
  if (!a) return null;
  return {
    id: a.id, kind: a.kind, family: a.family, familyLabel: a.familyLabel, name: a.name, auth: a.auth, source: a.source,
    identity: a.identity, state: a.state, stateLabel: a.stateLabel, quota: a.quota, quotaAt: a.quotaAt || 0, quotaBasis: a.quotaBasis || null, quotaNote: a.quotaNote,
    pinned: a.pinned, note: a.note, adopted: a.adopted, usable: a.usable, why: a.why, modelCount: a.modelCount,
    prefix: a.prefix, base: a.base, endpoint: a.endpoint || null, instanceId: a.instanceId,
  };
}

/** A short "Codex · 9Router" / "Claude Pro" label for status lines. */
function label(a) { return a ? a.name + (a.kind === KIND.OAUTH || a.kind === KIND.ROUTER ? ' · 9Router' : '') : ''; }

module.exports = { touched, KIND, baseOf, NINE, FAMILY, list, find, accountFor, accountIdForRoute, models, modelLabel, routeFor, offering, defaultModel, rename, setDefaultModel, view, label };
