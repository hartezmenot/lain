'use strict';

/**
 * RUNTIME AND LOCAL MODELS AS CONNECTIONS — so they are chosen, resolved,
 * traced, cancelled and counted exactly like every other model:
 *
 *   BOT / Agent ─▶ catalog ─▶ provider.chat (modelrequest envelope) ─▶ protocol 'runtime'
 *                                                                      └▶ runtimeprovider.js
 *
 * There is no second chat subsystem for local models or runtimes. Each source
 * contributes one connection whose models carry the ROLES they may fill
 * (modelroles.js) — a local model gets AGENT only after its compatibility test,
 * a runtime model only when its runtime executes agent work.
 *
 *   local:llamacpp      GGUF text models in the person's model directories
 *   local:ollama        what the Ollama service last listed
 *   runtime:<id>        models a runtime adapter can serve now (cached telemetry)
 *   runtime:codex:<n>   one native Codex account (its own home): the models Codex
 *                       listed for it at its last refresh — Chat / BOT through
 *                       codex exec (drivers/codexexec.js), never the Coding Agent
 *
 * Synchronous and cheap: reads caches and LAIN's own registries, never a network.
 */

const PROTOCOL = 'runtime';

function row(id, extra = {}) { return { id, root: id, ...extra }; }

function llamaConnection(app) {
  let models = [];
  try { models = require('./local/modeldirs').list().models; } catch { models = []; }
  if (!models.length) return null;
  const verify = require('./localagent');
  return {
    id: 'local:llamacpp', provider: 'llama.cpp', runtime: 'llamacpp', locality: 'local',
    models: models.map((m) => {
      const v = verify.current(app, m.id);
      return row(m.id, { label: `${m.modelName || m.name.replace(/\.gguf$/i, '')} · llama.cpp`, roles: ['CHAT', 'BOT', 'AUX', ...(m.vision ? ['VISION'] : []), ...(v && v.result === 'verified' ? ['AGENT'] : [])], ctx: (() => { try { return require('./local/llamacpp').configFor(app, m).ctx; } catch { return m.contextLength || null; } })() });
    }),
  };
}

function ollamaConnection(app) {
  let info = null;
  try { info = require('./local/ollama').cached(); } catch { info = null; }
  if (!info || !Array.isArray(info.models) || !info.models.length) return null;
  const verify = require('./localagent');
  return {
    id: 'local:ollama', provider: 'ollama', runtime: 'ollama', locality: 'local',
    models: info.models.map((m) => {
      const v = verify.current(app, m.id);
      return row(m.id, { label: `${m.name} · Ollama`, roles: m.embedding === true ? ['EMBEDDING'] : ['CHAT', 'BOT', 'AUX', ...(m.vision ? ['VISION'] : []), ...(v && v.result === 'verified' ? ['AGENT'] : [])], ctx: m.contextLength || null });
    }),
  };
}

function runtimeConnection(app, id, provider) {
  let models = [];
  try { models = require('./runtimeadapters').servableModels(app, id) || []; } catch { models = []; }
  if (!models.length) return null;
  return { id: `runtime:${id}`, provider, runtime: id, locality: 'runtime', models: models.map((m) => row(m.id, { label: m.label, roles: m.roles, entitlement: m.entitlement || null })) };
}

/** Native Codex accounts that are signed in and told LAIN their models (accountinstances.js). */
function codexConnections() {
  let recs = [];
  try { recs = require('./accountinstances').records(); } catch { recs = []; }
  return recs.filter((r) => r.driver_id === 'codex' && r.signedIn !== false && Array.isArray(r.models) && r.models.length).map((r) => ({
    id: `runtime:codex:${r.id}`, provider: 'openai', runtime: 'codex', locality: 'runtime', instanceId: r.id,
    models: r.models.map((m) => row(m.id, { label: m.label || m.id, roles: ['CHAT', 'BOT'], efforts: m.efforts || [], defaultEffort: m.defaultEffort || null })),
  }));
}

/**
 * CLAUDE ACCOUNTS LAIN holds, each with its own configuration directory (drivers/claudeaccount.js): one route
 * per signed-in account (runtime:claude-code:<instance>). The person's own default profile is the plain
 * `runtime:claude-code` route above; these are the accounts LAIN connected in addition — never the same directory.
 */
function claudeConnections() {
  let recs = [];
  try { recs = require('./accountinstances').records(); } catch { recs = []; }
  return recs.filter((r) => r.driver_id === 'claude-code' && r.signedIn !== false && Array.isArray(r.models) && r.models.length).map((r) => ({
    id: `runtime:claude-code:${r.id}`, provider: 'claude-code', runtime: 'claude-code', locality: 'runtime', instanceId: r.id,
    models: r.models.map((m) => row(m.id, { label: m.label || m.id, roles: ['CHAT', 'BOT', 'AGENT'] })),
  }));
}

/** Antigravity accounts LAIN holds — each its own private profile (drivers/antigravity.js): one route per signed-in account. */
function antigravityConnections() {
  let recs = [];
  try { recs = require('./accountinstances').records(); } catch { recs = []; }
  return recs.filter((r) => r.driver_id === 'antigravity' && r.signedIn !== false && Array.isArray(r.models) && r.models.length).map((r) => ({
    id: `runtime:antigravity:${r.id}`, provider: 'google', runtime: 'antigravity', locality: 'runtime', instanceId: r.id,
    // CAPABILITIES ONLY AFTER A REAL EXECUTION (a request through this account, or its test message): a sign-in proves an identity, not that it answers.
    // Coding is not advertised at all — no execution test for an Antigravity tool-using run exists yet.
    models: r.models.map((m) => row(m.id, { label: m.label || m.id, roles: r.verified_at ? ['CHAT', 'BOT'] : [], efforts: m.efforts || [], defaultEffort: m.defaultEffort || null })),
  }));
}

/**
 * Every runtime/local connection, in the shape connections.fromConfig produces.
 *
 * MEMOISED PER APP for up to a second, and dropped whenever the catalog's inputs
 * change (appcatalog.invalidate): the header names the model the next turn uses,
 * and naming a runtime's model asked for this list — which reads telemetry and
 * walks PATH — on every redraw. In a profiled task that was 2.4 s of 2.9 s of
 * the terminal's CPU (Phase 8.2).
 */
const MEMO_MS = 1000;
// ONE ENTRY PER CALLER (2026-10-01): a single slot was evicted on every call, because provider.resolve asks with no
// App and the header/turn ask with one — measured rebuilding on every resolve (~66 ms a turn on a real home).
const memos = new WeakMap();
let memoNull = null;   // { gen, sig, at, value }
const bySig = new Map();
function connections(app = null, { byConfig = false } = {}) {
  if (process.env.LAIN_NO_RUNTIME_CONNECTIONS === '1') return [];
  let gen = 0;
  try { gen = require('./appcatalog').generationNow(); } catch { gen = 0; }
  // THE CONFIGURATION IT IS BUILT FROM is part of the key (a runtime's binary, a disconnect, local dirs).
  const r = (app && app._sibling) || app;
  const c = (r && r.cfg) || {};
  let sig = null;
  try { sig = JSON.stringify([c.runtimes || null, c.local || null, (c.accounts && c.accounts.codex) || null]); } catch { sig = null; }
  const now = Date.now();
  // `byConfig`: the caller wraps a config in a fresh object on every call (connections.fromConfig), so identity can
  // never match — the configuration's own signature is the key.
  const memo = byConfig ? bySig.get(sig) : app && typeof app === 'object' ? memos.get(app) : memoNull;
  if (sig !== null && memo && memo.gen === gen && memo.sig === sig && now - memo.at < MEMO_MS) return memo.value;
  const value = build(app);
  const entry = { gen, sig, at: now, value };
  if (byConfig) { if (sig !== null) { bySig.set(sig, entry); if (bySig.size > 4) bySig.delete(bySig.keys().next().value); } } else if (app && typeof app === 'object') memos.set(app, entry); else memoNull = entry;
  return value;
}
function build(app) {
  // NO ZCODE ROUTE (2026-09-29): its models are served under ZCode's own Z.ai sign-in, and LAIN integrates Z.ai through its API only.
  const out = [llamaConnection(app), ollamaConnection(app),
    runtimeConnection(app, 'claude-code', 'claude-code'), runtimeConnection(app, 'opencode', 'opencode-runtime'), ...codexConnections(), ...claudeConnections(), ...antigravityConnections()].filter(Boolean);
  return out.map((c) => ({
    id: c.id, provider: c.provider, via: 'native', auth: 'none', protocol: PROTOCOL, runtime: c.runtime, locality: c.locality, instanceId: c.instanceId || null,
    baseUrl: '', envKey: null, credentialRef: null, apiKey: '',
    models: c.models, declaredModels: true, discoveredAt: null, readiness: 'AUTHENTICATED',
    ctx: 128000, maxTokens: 4096,
  }));
}

/** The row (with roles) for a model on a runtime/local connection, or null for an API route. */
function rowFor(app, modelId, connectionId = null) {
  for (const c of connections(app)) {
    if (connectionId && c.id !== connectionId) continue;
    const m = c.models.find((x) => x.id === modelId);
    if (m) return { ...m, connectionId: c.id, runtime: c.runtime, locality: c.locality, source: c.id };
  }
  return null;
}

module.exports = { PROTOCOL, connections, rowFor };
