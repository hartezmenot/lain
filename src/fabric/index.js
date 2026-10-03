'use strict';

/** THE INTELLIGENCE FABRIC (Phase 8.3) — one Core-owned registry that the Harness, the CLI, Telegram and `lain --serve` all project. */

const store = require('./store');
const caps = require('./effortcaps');

function root(app) { return (app && app._sibling) || app; }

/** KINDS, by where a family is managed in the Model Dashboard. */
const KIND = Object.freeze({ OAUTH: 'oauth', RUNTIME: 'runtime', API: 'api', LOCAL: 'local' });
/** THE LIFECYCLE OF AN ACCOUNT (Phase 8.4) — five states that are never mixed in one list */
const LIFECYCLE = Object.freeze({ CONNECTED: 'CONNECTED', DISCOVERED: 'DISCOVERED', IMPORTED_PENDING_AUTH: 'IMPORTED_PENDING_AUTH', DISCONNECTED: 'DISCONNECTED', ERROR: 'ERROR' });

const FAMILY_LABEL = Object.freeze({ codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity', zai: 'Z.ai', opencode: 'OpenCode', local: 'Local', copilot: 'GitHub Copilot', kiro: 'Kiro', cursor: 'Cursor', qwen: 'Qwen' });

/** THE PROVIDER FAMILY ABOVE THE SOURCES (2026-09-30): one brand — OpenAI, Anthropic, Google… — may be reached several ways, each its own source with… */
const BRAND_LABEL = Object.freeze({ openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', zai: 'Z.ai', opencode: 'OpenCode', github: 'GitHub', deepseek: 'DeepSeek', openrouter: 'OpenRouter', mistral: 'Mistral', groq: 'Groq', xai: 'xAI', moonshot: 'Moonshot', alibaba: 'Alibaba', aws: 'Amazon', cursor: 'Cursor', local: 'Local', custom: 'Custom endpoints' });
const FAMILY_BRAND = Object.freeze({ codex: 'openai', claude: 'anthropic', antigravity: 'google', zai: 'zai', opencode: 'opencode', copilot: 'github', kiro: 'aws', cursor: 'cursor', qwen: 'alibaba', local: 'local' });
const API_HOSTS = [
  [/(^|\.)openai\.com$/i, 'openai'], [/(^|\.)anthropic\.com$/i, 'anthropic'], [/(^|\.)(googleapis\.com|google\.com)$/i, 'google'],
  [/(^|\.)(z\.ai|bigmodel\.cn)$/i, 'zai'], [/(^|\.)deepseek\.com$/i, 'deepseek'], [/(^|\.)openrouter\.ai$/i, 'openrouter'],
  [/(^|\.)mistral\.ai$/i, 'mistral'], [/(^|\.)groq\.com$/i, 'groq'], [/(^|\.)x\.ai$/i, 'xai'], [/(^|\.)(moonshot\.(ai|cn))$/i, 'moonshot'],
  [/(^|\.)(dashscope\.aliyuncs\.com|aliyuncs\.com)$/i, 'alibaba'], [/(^|\.)opencode\.ai$/i, 'opencode'],
];
/** The brand of a family: its own for a subscription or runtime family, the endpoint's host for an API source. Pure. */
function brandOf(familyId, endpoint) {
  if (!String(familyId || '').startsWith('api:')) return FAMILY_BRAND[familyId] || 'custom';
  let host = '';
  try { host = new URL(String(endpoint || '')).hostname; } catch { host = ''; }
  for (const [re, b] of API_HOSTS) if (host && re.test(host)) return b;
  return 'custom';
}
/** How a family is reached: 'subscription' (a sign-in), 'runtime' (a tool's own sign-in), 'api' (a key), 'local'. */
function sourceOf(kind) { return kind === KIND.OAUTH ? 'subscription' : kind === KIND.API ? 'api' : kind === KIND.LOCAL ? 'local' : 'runtime'; }
const FAMILY_KIND = Object.freeze({ codex: KIND.OAUTH, claude: KIND.OAUTH, antigravity: KIND.OAUTH, copilot: KIND.OAUTH, kiro: KIND.OAUTH, cursor: KIND.OAUTH, qwen: KIND.OAUTH, zai: KIND.RUNTIME, opencode: KIND.RUNTIME, local: KIND.LOCAL });
const ORDER = ['codex', 'claude', 'antigravity', 'zai', 'opencode', 'copilot', 'kiro', 'cursor', 'qwen', 'local'];

/** "personal@example.com" → "pe•••@example.com" — enough to recognise, not to copy. */
function mask(email) {
  const e = String(email || '');
  const at = e.indexOf('@');
  if (at < 1) return e ? `${e.slice(0, 2)}•••` : '';
  return `${e.slice(0, Math.min(2, at))}•••${e.slice(at)}`;
}

/** THE FAMILY A BACKING ACCOUNT BELONGS TO. */
/** ONE GOOGLE CODING ACCOUNT FAMILY (8.4.1): Google's individual coding CLI moved from Gemini CLI to Antigravity, so a Gemini OAuth record is an… */
const FAMILY_ALIAS = Object.freeze({ gemini: 'antigravity' });
const realFamily = (f) => FAMILY_ALIAS[f] || f;

function familyIdOf(a) {
  if (!a) return null;
  if (a.kind === 'local') return 'local';
  if (a.kind === 'runtime' && a.family && a.family !== 'api') return realFamily(a.family);
  // A SUBSCRIPTION POOL IMPORTED FROM A LOCAL ROUTER (adopted in 8.2) is capacity behind its own
  // family — Codex, Claude, Antigravity — until the migration replaces it with LAIN's own sign-in.
  if (a.kind === 'oauth' && a.family) return realFamily(a.family);
  // AN API ENDPOINT is ONE API source.
  return `api:${a.base || a.id}`;
}

/** Only accounts LAIN may use: a router pool nobody imported is a migration candidate, not capacity. */
function inFabric(a) { return a && !((a.kind === 'oauth' || a.kind === 'router') && !a.adopted); }

/** The LOGICAL model id: a router's namespace is where a model was reached, not its name. */
function logicalId(catalogId, route) {
  const ns = route && route.route ? String(route.route).split('#')[0] : null;
  const id = String(catalogId || '');
  return ns && id.toLowerCase().startsWith(`${ns.toLowerCase()}/`) ? id.slice(ns.length + 1) : id;
}

function cleanLabel(m, route) {
  const ns = route && route.route ? String(route.route).split('#')[0] : null;
  const bare = ns && m.id.toLowerCase().startsWith(`${ns.toLowerCase()}/`) ? m.id.slice(ns.length + 1) : null;
  try { return bare ? require('../catalog').displayName(bare) : (m.displayName || m.id); } catch { return m.displayName || m.id; }
}

// ------------------------------------------------------------------ build --

function inputs(app) {
  const r = root(app);
  let L = null;
  try { L = require('../accountcatalog').list(app); } catch { L = { accounts: [], byId: new Map() }; }
  let cat = null;
  try { cat = r.catalog(); } catch { cat = null; }
  let mc = '';
  try { mc = require('../modelcatalog').generation(); } catch { mc = ''; }
  return { L, cat, gen: `${store.generation()}|${mc}` };
}

function index(app) {
  const r = root(app);
  const { L, cat, gen } = inputs(app);
  const m = r && r._fabricMemo;
  // A LIMIT THAT HAS ENDED is not a limit: the index is rebuilt at the earliest reported end (validUntil).
  if (m && m.L === L && m.cat === cat && m.gen === gen && !(m.value.validUntil && Date.now() >= m.value.validUntil)) return m.value;
  const t0 = Date.now();
  const value = build(app, L, cat);
  value.buildMs = Date.now() - t0;
  if (r) r._fabricMemo = { L, cat, gen, value };
  return value;
}

function familyLabel(id, accounts, apiName) {
  if (id.startsWith('api:')) return apiName || id.slice(4);
  if (id === 'claude') {
    const plans = [...new Set(accounts.map((a) => a.identity && a.identity.plan).filter(Boolean).map((p) => String(p).toLowerCase()))];
    if (plans.length === 1) return `Claude ${plans[0].charAt(0).toUpperCase()}${plans[0].slice(1)}`;
  }
  return FAMILY_LABEL[id] || id;
}

/** WHERE AN ACCOUNT STANDS. */
function lifecycleOf(a, famKind) {
  if (a.kind === 'oauth') return LIFECYCLE.IMPORTED_PENDING_AUTH;
  if (famKind === KIND.OAUTH || famKind === KIND.RUNTIME) {
    const st = String(a.state || '');
    if (st === 'SIGN_IN') return LIFECYCLE.DISCONNECTED;
    if (st === 'NOT_INSTALLED' || st === 'UNREACHABLE') return LIFECYCLE.ERROR;
  }
  return LIFECYCLE.CONNECTED;
}

/** An internal id (`codex-6f46e3`) is never a name a person reads. */
const ID_LIKE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-[0-9a-f]{6}$/i;
const isId = (s) => ID_LIKE.test(String(s || ''));
function friendly(name, famId) { return isId(name) || !name ? (FAMILY_LABEL[famId] ? `${FAMILY_LABEL[famId]} account` : 'Account') : String(name); }

/** A QUOTA WINDOW, with its meaning stated (8.4.1). */
function normWindow(w) {
  const used = w.usedPercent == null ? null : Math.max(0, Math.min(100, Number(w.usedPercent)));
  const rem = w.remainingPercent == null ? null : Math.max(0, Math.min(100, Number(w.remainingPercent)));
  const usedPercent = used != null ? Math.round(used * 10) / 10 : rem != null ? Math.round((100 - rem) * 10) / 10 : null;
  const remainingPercent = rem != null ? Math.round(rem * 10) / 10 : used != null ? Math.round((100 - used) * 10) / 10 : null;
  return { id: w.id || null, windowMins: Number(w.windowMins || w.mins) || null, label: w.label, usedPercent, remainingPercent, reported: w.reported || (rem != null ? 'remaining' : used != null ? 'used' : null), resetsAt: w.resetsAt || null, credits: w.credits == null ? null : w.credits };
}

function backing(a, famId, reg, priority) {
  const aliasName = reg.aliases[a.id] || null;
  const email = a.identity && a.identity.email ? String(a.identity.email) : null;
  const q = reg.quota[a.id] || null;
  const limited = store.limitedNow(a.id);
  // A DISABLED ACCOUNT stays in its place, keeps everything, and is never chosen (store.setEnabled).
  const enabled = !(reg.disabled && reg.disabled[a.id]);
  // ONLY WHAT WAS REPORTED, AND THE NEWEST READING WINS (2026-10-02): the account's own telemetry and the store
  // (fabric/store.recordQuota — every adapter writes there) are two readings of ONE thing, never two answers.
  const own = a.quota && a.quota.length ? a.quota : null;
  const kept = q && Array.isArray(q.windows) && q.windows.length ? q.windows : null;
  const useKept = kept && (!own || (q.at || 0) > (a.quotaAt || 0));
  const windows = ((useKept ? kept : own) || []).map(normWindow);
  const quotaAt = useKept ? (q.at || null) : (a.quotaAt || null);
  const quotaSource = useKept ? (q.source || null) : (a.quotaBasis || null);
  return {
    id: a.id, family: famId, kind: a.kind, lifecycle: LIFECYCLE.CONNECTED, ownership: a.ownership || null,
    // A NAME A PERSON READS: what they called it, else the masked identity — never the raw address, never an internal id.
    name: aliasName || (email ? mask(email) : null) || friendly(a.name, famId),
    alias: aliasName, providerName: isId(a.name) ? null : a.name,
    identity: { email: email ? mask(email) : null, plan: (a.identity && a.identity.plan) || null },
    state: !enabled ? 'DISABLED' : limited ? 'LIMITED' : a.state, stateLabel: !enabled ? 'Disabled' : limited ? 'Limited' : a.stateLabel,
    enabled, usable: a.usable !== false && enabled, why: !enabled ? 'Disabled — kept, never used for new requests' : (a.why || ''),
    limited, quota: windows, quotaAt, quotaSource, quotaNote: windows.length ? null : (a.quotaNote || 'Not reported'),
    priority, modelCount: 0, instanceId: a.instanceId || null, base: a.base || null, endpoint: a.endpoint || null,
    // null = nothing to verify; false = signed in, not yet shown to answer (its capabilities are not advertised); true = it answered.
    verified: a.verified === undefined ? null : a.verified,
  };
}

function build(app, L, cat) {
  const reg = store.read();
  const r = root(app);
  // A ROUTE → ITS ACCOUNT, once.
  const routeAcct = new Map();
  for (const a of L.accounts) for (const rt of a.routes || []) routeAcct.set(rt, a);
  // RUNTIME ROWS (labels, roles, reported effort levels), once.
  const rows = new Map();
  let conns = [];
  try { conns = require('../runtimeconnections').connections(r); } catch { conns = []; }
  for (const c of conns) for (const x of c.models || []) rows.set(`${c.id}|${x.id}`, { ...x, runtime: c.runtime });
  const connById = new Map();
  try { for (const c of require('../appcatalog').connections(r)) connById.set(c.id, c); } catch { /* none */ }

  const fams = new Map();
  const famOf = (id, a) => {
    if (!fams.has(id)) {
      fams.set(id, {
        id, kind: id.startsWith('api:') ? KIND.API : (FAMILY_KIND[id] || KIND.RUNTIME),
        accounts: [], setup: [], models: new Map(), apiName: id.startsWith('api:') && a ? a.name.replace(/ · .*$/, '') : null,
        endpoint: id.startsWith('api:') && a ? (a.endpoint || null) : null,
      });
    }
    return fams.get(id);
  };
  const accountFamily = new Map();
  for (const a of L.accounts) {
    if (!inFabric(a)) continue;
    const fid = familyIdOf(a);
    const f = famOf(fid, a);
    const lc = lifecycleOf(a, f.kind);
    if (lc === LIFECYCLE.CONNECTED) { accountFamily.set(a.id, fid); f.accounts.push(a); continue; }
    // NOT CAPACITY: listed under "Finish setup", never routed, never counted.
    const who = a.identity && a.identity.email ? mask(String(a.identity.email)) : null;
    f.setup.push({
      id: a.id, lifecycle: lc, source: a.kind === 'oauth' ? 'pool' : 'account',
      name: reg.aliases[a.id] || (a.kind === 'oauth' ? `Imported ${FAMILY_LABEL[fid] || fid} accounts` : friendly(a.name, fid)),
      identityHint: who, instanceId: a.instanceId || null, ownership: a.ownership || null,
      state: lc === LIFECYCLE.IMPORTED_PENDING_AUTH ? 'REAUTH_REQUIRED' : String(a.state || lc),
      note: lc === LIFECYCLE.IMPORTED_PENDING_AUTH ? 'Imported account metadata — sign in with LAIN to finish. Not used until then.'
        : lc === LIFECYCLE.DISCONNECTED ? 'Signed out — sign in again to use it.' : (a.why || 'Its runtime is not reachable.'),
    });
  }
  // PLACEHOLDERS: accounts discovered by an import that still need LAIN's own sign-in.
  for (const [id, p] of Object.entries(reg.placeholders || {})) {
    if (!p || !p.family) continue;
    const pfam = realFamily(p.family);
    const f = famOf(pfam, null);
    f.setup.push({ id, ...p, family: pfam, lifecycle: LIFECYCLE.IMPORTED_PENDING_AUTH, source: 'placeholder', name: reg.aliases[id] || p.label || p.identityHint || 'Imported account', state: p.state || 'REAUTH_REQUIRED' });
  }

  // OLD SETUP ENTRIES (8.4.1): metadata that no longer needs finishing — a duplicate of another entry, of an account that is
  // already connected, or a router pool for a provider LAIN is connected to directly. Surfaced for review, never deleted.
  for (const f of fams.values()) {
    // A hint is either a raw address (a placeholder) or the masked one a pool shows — an account matches either way.
    const mail = new Set(f.accounts.flatMap((x) => (x.identity && x.identity.email ? [String(x.identity.email).toLowerCase(), mask(String(x.identity.email)).toLowerCase()] : [])));
    const seen = new Set();
    for (const p of f.setup) {
      const hint = p.identityHint ? String(p.identityHint).toLowerCase() : null;
      const key = `${p.source === 'pool' ? 'pool' : 'ph'}|${hint || ''}|${String(p.label || p.name || '').toLowerCase()}`;
      if (hint && mail.has(hint)) { p.obsolete = true; p.obsoleteWhy = 'This account is already connected.'; }
      else if (seen.has(key)) { p.obsolete = true; p.obsoleteWhy = 'A duplicate of another old setup entry.'; }
      else p.obsolete = false;
      seen.add(key);
    }
  }

  // THE ELIGIBILITY INDEX: family → logical model → account → {route, levels}.
  for (const mdl of (cat && cat.models) || []) {
    for (const route of mdl.connections || []) {
      const a = routeAcct.get(route.connectionId);
      if (!a || a.usable === false || !accountFamily.has(a.id)) continue;
      const fid = accountFamily.get(a.id);
      const f = fams.get(fid);
      const lid = logicalId(mdl.id, route);
      const base = route.baseConnectionId || route.connectionId;
      const row = rows.get(`${route.connectionId}|${mdl.id}`) || rows.get(`${base}|${route.upstreamId || mdl.id}`) || rows.get(`${base}|${mdl.id}`) || null;
      const conn = connById.get(base) || null;
      // RUNTIME-BOUND (runtimebound.js): listed only where its runtime serves it — never over HTTP.
      let entry = f.models.get(lid);
      if (!entry) {
        const roles = row ? (row.roles || []) : ['CHAT', 'BOT', 'AGENT'];
        entry = { id: lid, label: (row && row.label) || cleanLabel(mdl, route), roles: new Set(roles), accounts: new Map(), catalogIds: new Set() };
        f.models.set(lid, entry);
      } else if (row) for (const x of row.roles || []) entry.roles.add(x);
      entry.catalogIds.add(mdl.id);
      const ef = caps.forRoute({ family: fid, model: lid, row, route, conn, overrides: reg.efforts || null });
      // THE CATALOG ID THIS ACCOUNT IS REACHED BY (accountcatalog.routeFor takes it) — per account.
      entry.accounts.set(a.id, { route: route.connectionId, base, catalogId: mdl.id, upstreamId: route.upstreamId || mdl.id, levels: ef.levels, default: ef.default, source: ef.source });
    }
  }

  const out = [];
  for (const f of fams.values()) {
    const st = store.familyState(f.id);
    const order = st.order.filter((id) => f.accounts.some((a) => a.id === id));
    // NOT ORDERED BY THE PERSON: in the order they were connected (a new account joins at the end); never-stamped ones by name first.
    const rest = f.accounts.map((a) => a.id).filter((id) => !order.includes(id))
      .sort((x, y) => (store.seenAt(x) - store.seenAt(y)) || String(f.accounts.find((a) => a.id === x).name).localeCompare(String(f.accounts.find((a) => a.id === y).name)));
    const prio = [...order, ...rest];
    const accts = prio.map((id, i) => backing(f.accounts.find((a) => a.id === id), f.id, reg, i + 1));
    // TWO ACCOUNTS WITH ONE DEFAULT NAME (two imported pools) are told apart until the person names them.
    const seen = {};
    for (const a of accts) seen[a.name] = (seen[a.name] || 0) + 1;
    for (const a of accts) if (seen[a.name] > 1 && !a.alias) a.name = `${a.name} · ${String(a.base || a.id).replace(/^lain:/, '')}`;
    const models = [...f.models.values()].map((e) => {
      const levels = caps.order([...e.accounts.values()].flatMap((x) => x.levels));
      const defaults = [...new Set([...e.accounts.values()].map((x) => x.default).filter(Boolean))];
      const roles = [...e.roles];
      for (const id of e.accounts.keys()) { const b = accts.find((x) => x.id === id); if (b) b.modelCount += 1; }
      return {
        id: e.id, label: e.label, efforts: levels, defaultEffort: defaults.length === 1 ? defaults[0] : null,
        chat: roles.includes('CHAT') || roles.includes('BOT'), coding: roles.includes('AGENT'), roles,
        accounts: [...e.accounts.entries()].map(([id, x]) => ({ id, ...x })),
        catalogIds: [...e.catalogIds],
        search: `${e.id} ${e.label}`.toLowerCase(),
      };
    }).sort((a, b) => a.label.localeCompare(b.label));
    // WHAT THE PROVIDER'S OWN LISTING SAYS (modelcatalog.js): NEW since the last generation, or active. A model the
    // provider stopped reporting is listed apart (`unavailable`), never routable — its sessions stay readable.
    const MC = require('../modelcatalog');
    const statusOf = (m) => {
      if (!f.id.startsWith('api:')) return MC.status(f.id, m.id) || null;
      for (const x of m.accounts) { const s = MC.status(`api:${x.base}`, x.upstreamId || x.catalogId || m.id); if (s) return s; }
      return null;
    };
    for (const m of models) m.catalogStatus = statusOf(m);
    const unavailable = f.id.startsWith('api:') ? [] : MC.gone(f.id).filter((g) => !models.some((m) => m.id === g.id || m.catalogIds.includes(g.id)));
    // A MODEL IS FOUND BY ITS LOGICAL ID and by any catalog spelling an older choice stored.
    const byModel = new Map(models.map((x) => [x.id, x]));
    for (const x of models) for (const c of x.catalogIds) if (!byModel.has(c)) byModel.set(c, x);
    const label = familyLabel(f.id, f.accounts, f.apiName);
    const brand = brandOf(f.id, f.endpoint);
    out.push({
      id: f.id, label, kind: f.kind, endpoint: f.endpoint, brand, brandLabel: BRAND_LABEL[brand] || brand, source: sourceOf(f.kind),
      policy: st.policy, policyLabel: store.POLICY_LABEL[st.policy], pinned: st.pinned && accts.some((a) => a.id === st.pinned) ? st.pinned : null,
      accounts: accts, setup: f.setup, placeholders: f.setup.filter((p) => p.source === 'placeholder'),
      models, byModel, unavailable,
      usable: accts.some((a) => a.usable),
    });
  }
  out.sort((a, b) => {
    const ka = a.id.startsWith('api:') ? 100 : (ORDER.indexOf(a.id) < 0 ? 50 : ORDER.indexOf(a.id));
    const kb = b.id.startsWith('api:') ? 100 : (ORDER.indexOf(b.id) < 0 ? 50 : ORDER.indexOf(b.id));
    return (ka - kb) || a.label.localeCompare(b.label);
  });
  let validUntil = null;
  for (const f of out) for (const a of f.accounts) if (a.limited && a.limited.until && (!validUntil || a.limited.until < validUntil)) validUntil = a.limited.until;
  return { families: out, byId: new Map(out.map((f) => [f.id, f])), accountFamily, at: Date.now(), validUntil, modelCount: out.reduce((n, f) => n + f.models.length, 0) };
}

// --------------------------------------------------------------- queries --

function families(app) { return index(app).families; }
function family(app, id) { return index(app).byId.get(String(id || '')) || null; }
function familyOfAccount(app, accountId) {
  const I = index(app);
  const fid = I.accountFamily.get(String(accountId || ''));
  if (fid) return I.byId.get(fid) || null;
  // A ROUTE ID, or a base connection id, names its account through accountcatalog.
  try { const a = require('../accountcatalog').accountFor(app, accountId); return a ? I.byId.get(I.accountFamily.get(a.id)) || null : null; } catch { return null; }
}
function model(app, familyId, modelId) { const f = family(app, familyId); return f ? f.byModel.get(String(modelId || '')) || null : null; }

/** THE PROVIDER FAMILIES (§61): each brand once, with the sources it is reached by, by kind of connection — { id: 'openai', label: 'OpenAI'… */
function providerFamilies(app) {
  const groups = new Map();
  for (const f of families(app)) {
    if (!groups.has(f.brand)) groups.set(f.brand, { id: f.brand, label: f.brandLabel, subscription: [], api: [], runtime: [], local: [] });
    groups.get(f.brand)[f.source].push(f.id);
  }
  return [...groups.values()];
}

/** A family that offers `modelId` — the one whose index holds it, preferring a subscription family. */
function familiesOffering(app, modelId) { return families(app).filter((f) => f.byModel.has(String(modelId || ''))); }

/** THE ACCOUNTS THAT CAN SERVE (model, effort) in this family, in priority order — the eligibility index, read. */
function eligible(app, familyId, modelId, effort = null) {
  const f = family(app, familyId);
  const m = f && f.byModel.get(String(modelId || ''));
  if (!m) return [];
  const e = caps.norm(effort);
  return f.accounts.filter((a) => a.usable).map((a) => ({ a, x: m.accounts.find((y) => y.id === a.id) }))
    .filter(({ x }) => x && (!e || x.levels.includes(e) || (!x.levels.length && !m.efforts.length)))
    .map(({ a, x }) => ({ account: a, route: x.route, levels: x.levels, limited: a.limited }));
}

/** SEARCH THE INDEX — the model picker's and the Models tab's one query. */
function search(app, { query = '', family: fam = null, kind = null, capability = null, effort = null, available = false, lane = null, limit = 200 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  const out = [];
  let total = 0;
  for (const f of families(app)) {
    if (fam && f.id !== fam) continue;
    if (kind && f.kind !== kind) continue;
    for (const m of f.models) {
      if (capability === 'coding' || lane === 'coding') { if (!m.coding) continue; }
      if (capability === 'chat' || lane === 'chat') { if (!m.chat) continue; }
      if (effort && !m.efforts.length) continue;
      if (available && !m.accounts.some((x) => { const b = f.accounts.find((a) => a.id === x.id); return b && b.usable && !b.limited; })) continue;
      if (words.length && !words.every((w) => m.search.includes(w) || f.label.toLowerCase().includes(w))) continue;
      total += 1;
      if (out.length < limit) out.push({ family: f.id, familyLabel: f.label, kind: f.kind, ...modelView(m) });
    }
  }
  return { models: out, total };
}

// ----------------------------------------------------------------- views --

function modelView(m) {
  return { id: m.id, label: m.label, efforts: m.efforts, effortLabels: m.efforts.map(caps.label), defaultEffort: m.defaultEffort, chat: m.chat, coding: m.coding, accounts: m.accounts.map((x) => x.id), status: m.catalogStatus || 'active', isNew: m.catalogStatus === 'new' };
}
function accountView(a) {
  return { id: a.id, name: a.name, alias: a.alias, providerName: a.providerName, lifecycle: a.lifecycle, ownership: a.ownership || null, instanceId: a.instanceId || null, identity: a.identity, state: a.state, stateLabel: a.stateLabel, enabled: a.enabled !== false, usable: a.usable, why: a.why, limited: a.limited, quota: a.quota, quotaAt: a.quotaAt || null, quotaSource: a.quotaSource || null, quotaNote: a.quotaNote, priority: a.priority, modelCount: a.modelCount, kind: a.kind, endpoint: a.endpoint, instanceId: a.instanceId, verified: a.verified === undefined ? null : a.verified };
}
function familyView(f, { models = false } = {}) {
  return {
    id: f.id, label: f.label, kind: f.kind, endpoint: f.endpoint, brand: f.brand, brandLabel: f.brandLabel, source: f.source, policy: f.policy, policyLabel: f.policyLabel, pinned: f.pinned,
    accounts: f.accounts.map(accountView), accountCount: f.accounts.length,
    setup: f.setup.map((p) => ({ id: p.id, lifecycle: p.lifecycle, source: p.source, name: p.name, state: p.state, note: p.note || '', ownership: p.ownership || null, obsolete: Boolean(p.obsolete), obsoleteWhy: p.obsoleteWhy || null, identityHint: p.identityHint ? (p.identityHint.includes('@') && !p.identityHint.includes('•') ? mask(p.identityHint) : p.identityHint) : null, instanceId: p.instanceId || null, discoveredAt: p.discoveredAt || null })),
    placeholders: f.placeholders.map((p) => ({ id: p.id, name: p.name, state: p.state, note: p.note || '', identityHint: p.identityHint ? mask(p.identityHint) : null, discoveredAt: p.discoveredAt || null })),
    modelCount: f.models.length, usable: f.usable,
    enabledCount: f.accounts.filter((a) => a.enabled !== false).length, disabledCount: f.accounts.filter((a) => a.enabled === false).length,
    newModels: f.models.filter((m) => m.catalogStatus === 'new').length,
    quotaSummary: quotaSummary(f),
    unavailable: (f.unavailable || []).map((g) => ({ id: g.id, label: g.label, status: 'no-longer-reported', removedAt: g.removedAt })),
    ...(models ? { models: f.models.map(modelView) } : {}),
  };
}

/** "5-hour / Weekly quota available" — which windows the family's accounts report, no numbers invented. */
function quotaSummary(f) {
  const labels = [];
  for (const a of f.accounts) for (const w of a.quota) if (!labels.includes(w.label)) labels.push(w.label);
  return labels.length ? `${labels.join(' / ')} quota reported` : 'Quota not reported';
}

module.exports = { KIND, LIFECYCLE, FAMILY_LABEL, BRAND_LABEL, mask, familyIdOf, brandOf, sourceOf, index, families, family, familyOfAccount, model, familiesOffering, providerFamilies, eligible, search, modelView, accountView, familyView, quotaSummary };
