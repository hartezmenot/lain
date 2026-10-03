'use strict';

/** CONNECTIONS — a provider is not a credential. */

const fs = require('fs');
// A resolved credential is registered the moment it is read, so every display
// surface is covered from the first listing onwards. See src/redact.js.
const redact = require('./redact');
const path = require('path');

const READINESS = Object.freeze({
  NONE: 'NONE',
  CREDENTIAL_FOUND: 'CREDENTIAL_FOUND',
  AUTHENTICATED: 'AUTHENTICATED',
  REQUEST_READY: 'REQUEST_READY',
});

const VIA = Object.freeze({ NATIVE: 'native', BRIDGE: 'bridge' });
const AUTH = Object.freeze({ API_KEY: 'api_key', OAUTH: 'oauth', NONE: 'none' });

const RANK = { REQUEST_READY: 0, AUTHENTICATED: 1, CREDENTIAL_FOUND: 2, NONE: 3 };

function readinessFor({ credentialPresent = false, expired = false, requestSucceeded = false, authFailed = false }) {
  if (requestSucceeded) return READINESS.REQUEST_READY;
  if (authFailed) return READINESS.CREDENTIAL_FOUND;
  if (!credentialPresent) return READINESS.NONE;
  if (expired) return READINESS.CREDENTIAL_FOUND;
  return READINESS.AUTHENTICATED;
}

// discovery

/** A day. A router's catalog moves, but not between two launches. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Bounded so a pathological endpoint cannot exhaust memory or the config dir. */
const MAX_DISCOVERED = 20_000;
const DISCOVER_TIMEOUT_MS = 15_000;

function cacheDir() {
  return path.join(require('./config').configDir(), 'catalog');
}

/** Connection ids are user-chosen; they are not automatically safe filenames. */
function cacheFile(id) {
  return path.join(cacheDir(), String(id).replace(/[^a-zA-Z0-9._-]/g, '_') + '.json');
}

/** Memoised cache reads. */
const _memo = new Map(); // file -> { mtimeMs, size, value }

function readCache(id) {
  const file = cacheFile(id);
  let st;
  try { st = fs.statSync(file); } catch { _memo.delete(file); return null; }
  const hit = _memo.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let value = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && Array.isArray(j.models)) value = { fetchedAt: Number(j.fetchedAt) || 0, models: j.models, source: j.source || null };
  } catch { value = null; }
  _memo.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

function writeCache(id, models, source) {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = cacheFile(id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), source: source || null, models }), 'utf8');
  fs.renameSync(tmp, file);
  // WHAT A CONNECTION SERVES JUST CHANGED: the memoised connection list and catalog are rebuilt on the next
  // read (appcatalog.js). Without this, a key added a moment ago listed no models — no account — for a second.
  try { require('./appcatalog').invalidate(); } catch { /* not loaded */ }
  return file;
}

function cacheAgeMs(id) {
  const c = readCache(id);
  return c ? Date.now() - c.fetchedAt : Infinity;
}

/** Normalise one `/v1/models` row into the record shape catalog.js consumes. */
function normalizeCatalogRow(row) {
  if (typeof row === 'string') return row.trim() ? { id: row.trim() } : null;
  if (!row || typeof row !== 'object') return null;
  const id = String(row.id || row.name || '').trim();
  if (!id) return null;
  const out = { id };
  // `root: <same as id>` is a router filling the field in rather than declaring an identity.
  if (row.root && String(row.root) !== id) out.root = String(row.root);
  if (row.parent) out.parent = String(row.parent);
  if (row.owned_by) out.owned_by = String(row.owned_by);
  else if (row.ownedBy) out.owned_by = String(row.ownedBy);
  return out;
}

/** Ask a connection what it serves. */
async function discover(conn, { signal, timeoutMs = DISCOVER_TIMEOUT_MS } = {}) {
  const base = String((conn && conn.baseUrl) || '').replace(/\/+$/, '');
  if (!base) return { ok: false, count: 0, error: 'this connection declares no baseUrl', url: '' };
  // Anthropic's native protocol serves its catalog at the same path; the only
  // difference is how the request authenticates.
  const url = `${base}/models`;
  const headers = { accept: 'application/json' };
  if (conn.apiKey) {
    if (conn.protocol === 'anthropic') {
      headers['x-api-key'] = conn.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.authorization = `Bearer ${conn.apiKey}`;
    }
  }

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) {
      // THE STATUS DECIDES WHAT THIS MEANS (catalogstate.js); the body is kept
      // whole for diagnostics and never becomes the sentence a person reads.
      let raw = '';
      try { raw = (await res.text()).slice(0, 2000); } catch { /* no body */ }
      return { ok: false, count: 0, url, status: res.status, raw, error: `${res.status} ${res.statusText}`.trim() };
    }
    const j = await res.json();
    const rows = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []));
    const models = [];
    const seen = new Set();
    for (const r of rows) {
      const m = normalizeCatalogRow(r);
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
      if (models.length >= MAX_DISCOVERED) break;
    }
    if (!models.length) return { ok: false, count: 0, url, error: 'the endpoint answered but advertised no models' };
    writeCache(conn.id, models, url);
    return { ok: true, count: models.length, models, url };
  } catch (e) {
    const why = ac.signal.aborted && !(signal && signal.aborted)
      ? `no answer within ${Math.round(timeoutMs / 1000)}s`
      : (e && e.message) || String(e);
    return { ok: false, count: 0, url, error: why };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** THE API ROOT, when a base URL was entered as a full endpoint. */
const ENDPOINT_TAIL = /\/(?:chat\/completions|completions|models|messages|responses)\/*$/i;
function apiRoot(base) {
  return String(base || '').replace(/\/+$/, '').replace(ENDPOINT_TAIL, '');
}

/** Connections whose model list is empty and whose cache is missing or stale. */
function needsDiscovery(connections = []) {
  return connections.filter((c) => c && c.baseUrl && !c.declaredModels && cacheAgeMs(c.id) > CACHE_TTL_MS);
}

/** Discover every route that needs it, in one pass. */
async function discoverAll(connections, { force = false, only = null, done = new Set(), onProgress = null, signal } = {}) {
  const wanted = only
    ? connections.filter((c) => c.id === only && c.baseUrl)
    : (force ? connections.filter((c) => c.baseUrl && !c.declaredModels) : needsDiscovery(connections));
  // A SOURCE WHOSE LAST ANSWER CANNOT CHANGE is not asked again: a rejected credential or an endpoint that does not enumerate models, with the SAME URL…
  const cs = require('./catalogstate');
  const todo = wanted.filter((c) => force || (!done.has(c.id) && !cs.suppressed(c)));

  const results = [];
  for (const c of todo) {
    done.add(c.id);
    if (onProgress) onProgress(c.id);
    // A catalog endpoint answering does not prove the CHAT endpoint works, so a
    // failure here is reported and deliberately never trips the request breaker.
    const r = await discover(c, { signal });
    const changed = cs.record(c, r);
    results.push({ id: c.id, ...r, state: r.ok ? cs.STATE.OK : cs.classify(r.status), changed });
  }
  return results;
}

/** Read connections out of config. */
function fromConfig(cfg = {}, evidence = {}) {
  const out = [];
  const declared = cfg.connections && typeof cfg.connections === 'object' ? cfg.connections : {};

  // NO SECRET IS READ TO LIST A CONNECTION (2026-10-01).
  for (const [id, c] of Object.entries(declared)) {
    if (!c || typeof c !== 'object') continue;
    if (require('./retired').connectionSystem(id, c)) continue;
    const ev = evidence[id] || {};
    const via = c.via === VIA.BRIDGE ? VIA.BRIDGE : VIA.NATIVE;
    const auth = c.auth || (via === VIA.BRIDGE ? AUTH.NONE : AUTH.API_KEY);
    // A bridge needs no LAIN credential at all — calling that "api_key" is a lie.
    const deferred = auth === AUTH.API_KEY && Boolean(c.credentialRef) && !require('./credentials').cached(c.credentialRef);
    const readKey = () => ((c.credentialRef ? require('./credentials').resolve(c.credentialRef) : '') || c.apiKey || (c.envKey ? process.env[c.envKey] : '') || '');
    const key = auth === AUTH.API_KEY && !deferred ? readKey() : '';
    // HELD BACK FROM EVERY DISPLAY SURFACE, FROM THE MOMENT IT IS READ --
    if (key) redact.register(key);
    const credentialPresent = via === VIA.BRIDGE ? true : Boolean(key) || (deferred && require('./credentials').present(c.credentialRef)) || auth === AUTH.OAUTH;
    // A declared list is the user stating what this route serves; discovery never overrules it.
    const declared = Array.isArray(c.models) && c.models.length ? c.models : null;
    const cached = declared ? null : readCache(id);
    const conn = {
      id,
      provider: c.provider || id,
      via,
      auth,
      protocol: c.protocol || 'chat',
      baseUrl: apiRoot(c.baseUrl),
      envKey: c.envKey || null,
      credentialRef: c.credentialRef || null,
      apiKey: key,
      models: declared || (cached ? cached.models : []),
      declaredModels: Boolean(declared),
      discoveredAt: cached ? cached.fetchedAt : null,
      // A DECLARED THINKING SWITCH (S12a, fabric/effortcaps.thinkingSwitch): 'enable_thinking' | 'thinking.type' | 'none'.
      ...(c.thinkingSwitch ? { thinkingSwitch: String(c.thinkingSwitch) } : {}),
      readiness: readinessFor({
        credentialPresent,
        expired: Boolean(ev.expired),
        requestSucceeded: Boolean(ev.requestSucceeded),
        authFailed: Boolean(ev.authFailed),
      }),
    };
    // (defined, not spread: a getter spread into a literal would run at once)
    if (deferred) {
      Object.defineProperty(conn, 'apiKey', {
        enumerable: true, configurable: true,
        get() { const v = readKey(); if (v) redact.register(v); Object.defineProperty(conn, 'apiKey', { value: v, writable: true, enumerable: true, configurable: true }); return v; },
        set(v) { Object.defineProperty(conn, 'apiKey', { value: v, writable: true, enumerable: true, configurable: true }); },
      });
    }
    out.push(conn);
  }

  // Environment-declared native routes, so a bare API key still works with no config file at all.
  const envRoutes = require('./providers').envRoutes();
  for (const r of envRoutes) {
    if (!process.env[r.envKey]) continue;
    if (out.some((c) => c.provider === r.provider && c.via === VIA.NATIVE)) continue;
    const ev = evidence[r.id] || {};
    // An env-declared key is exactly as secret as one written down. See above.
    redact.register(process.env[r.envKey]);
    const declared = (cfg.models && cfg.models[r.provider]) || null;
    const cached = declared && declared.length ? null : readCache(r.id);
    out.push({
      id: r.id, provider: r.provider, via: VIA.NATIVE, auth: AUTH.API_KEY,
      protocol: r.protocol, baseUrl: r.baseUrl, envKey: r.envKey,
      apiKey: process.env[r.envKey],
      models: (declared && declared.length ? declared : (cached ? cached.models : [])),
      declaredModels: Boolean(declared && declared.length),
      discoveredAt: cached ? cached.fetchedAt : null,
      readiness: readinessFor({ credentialPresent: true, requestSucceeded: Boolean(ev.requestSucceeded), authFailed: Boolean(ev.authFailed) }),
    });
  }

  // LOCAL AND RUNTIME MODELS (runtimeconnections.js): llama.cpp, Ollama and the runtimes that execute through their own programs — the same catalog, the…
  try { for (const c of require('./runtimeconnections').connections({ cfg }, { byConfig: true })) if (!out.some((x) => x.id === c.id)) out.push(c); } catch { /* a broken cache never costs the API routes */ }

  return out.sort((a, b) => (RANK[a.readiness] ?? 9) - (RANK[b.readiness] ?? 9));
}

/** Every authentication ROUTE for a provider, as `/oauth` shows it. */
function authRoutes(provider, connections = []) {
  const mine = connections.filter((c) => c.provider === provider);
  const rows = [];

  const oauth = mine.filter((c) => c.auth === AUTH.OAUTH);
  if (oauth.length) {
    for (const c of oauth) {
      rows.push({
        kind: 'oauth', label: `${provider} OAuth`, connectionId: c.id,
        status: c.readiness === READINESS.REQUEST_READY ? 'Connected (verified)'
          : c.readiness === READINESS.AUTHENTICATED ? 'Logged in' : 'Not logged in',
        action: 'Login', enabled: true,
        detail: 'A real OAuth route configured for this connection.',
      });
    }
  } else {
    rows.push({
      kind: 'oauth', label: `${provider} OAuth`, connectionId: null,
      status: 'OAUTH NOT AVAILABLE FOR THIS PROVIDER', action: null, enabled: false,
      detail: 'LAIN has no legitimate OAuth mechanism for this provider. It is not faked, and no protected flow is bypassed.',
    });
  }

  // A reachable bridge is a REAL, already-authenticated route and must be
  // offered before any "configure an API key" suggestion.
  for (const c of mine.filter((x) => x.via === VIA.BRIDGE)) {
    rows.push({
      kind: 'bridge', label: `${provider} via ${c.id}`, connectionId: c.id,
      status: c.readiness === READINESS.REQUEST_READY ? 'Connected (verified)' : 'Connected',
      action: 'Use', enabled: true,
      detail: `${c.models.length} model(s) — the bridge authenticates upstream itself; LAIN holds no credential for it.`,
    });
  }

  for (const c of mine.filter((x) => x.auth === AUTH.API_KEY)) {
    rows.push({
      kind: 'api_key', label: `${provider} API key`, connectionId: c.id,
      status: c.apiKey ? 'Configured' : 'Not configured',
      action: 'Configure', enabled: true,
      detail: c.envKey ? `Read from ${c.envKey}. Billed per token. This is NOT OAuth.` : 'Billed per token. This is NOT OAuth.',
    });
  }
  return rows;
}

/** Can this provider be used right now WITHOUT the user pasting an API key? */
function hasKeylessRoute(provider, connections = []) {
  return connections.some((c) => c.provider === provider
    && (c.via === VIA.BRIDGE || c.auth === AUTH.OAUTH)
    && (c.readiness === READINESS.AUTHENTICATED || c.readiness === READINESS.REQUEST_READY));
}

/** WHAT A FINISHED TURN PROVED ABOUT ITS ROUTE. */
function noteTurn(evidence, id, record) {
  if (!id || !evidence || !record) return evidence;
  const ev = evidence[id] || (evidence[id] = {});
  if (record.providerFailure) {
    if (record.providerFailure.kind === 'AUTH') ev.authFailed = true;
    return evidence;
  }
  if (record.usage.requests > 0 && !record.errors.some((e) => e.kind !== 'TOOL')) {
    ev.requestSucceeded = true;
    ev.authFailed = false;
  }
  return evidence;
}

module.exports = {
  READINESS, VIA, AUTH, fromConfig, authRoutes, readinessFor, hasKeylessRoute, noteTurn,
  discover, discoverAll, needsDiscovery, readCache, writeCache, cacheFile, cacheAgeMs,
  normalizeCatalogRow, CACHE_TTL_MS, MAX_DISCOVERED, apiRoot,
};
