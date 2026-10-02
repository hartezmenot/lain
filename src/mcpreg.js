'use strict';

/**
 * THE MCP REGISTRY — trust, health and lazy schemas over the servers integrations.js keeps (Phase CAP, 2026-10-02).
 *
 * TRUST IS THE PERSON'S. cfg.integrations.mcp[id].trust, set only in Settings › MCP or `/mcp trust` — never by a
 * server, a project file or a model:
 *   DISABLED   not offered, not callable
 *   READ_ONLY  tools the server annotates read-only run; every other tool is refused (not asked)
 *   ASK        (default) read-only tools run; every other tool asks the person first (an EXTERNAL effect)
 *   TRUSTED    every tool runs without asking
 * A server's annotations are ADVISORY: they can make a tool ask more (destructiveHint never skips a question), never
 * less than the person's level allows. A per-tool override (`tools: { name: 'allow'|'ask'|'deny' }`) wins over both.
 *
 * HEALTH, said as the model and the page see it: READY (connected), IDLE (enabled, not started — starts on first
 * use), UNAVAILABLE (failed: "capability unavailable: <why>"), DISABLED.
 *
 * LAZY SCHEMAS. Every tool of every server described on every request is what made twenty servers unusable. The
 * catalog (name, description, input schema) of each server is cached in <home>/mcp-catalog.json when it connects;
 * `search_capabilities` reads that, without starting anything, and `mcp_call` starts a server on first use. Only a
 * SMALL connected set (≤ EAGER_TOOLS tools and ≤ EAGER_BYTES of schema), or a server the person pinned, is described
 * natively. cfg.integrations.mcpSchemas = 'auto' (default) | 'eager' | 'lazy'.
 */

const fs = require('fs');
const path = require('path');

const TRUST = Object.freeze(['DISABLED', 'READ_ONLY', 'ASK', 'TRUSTED']);
const EAGER_TOOLS = 8;
const EAGER_BYTES = 6 * 1024;
const CONNECT_MS = 20000;

function integrations() { return require('./integrations'); }
function store(app) { return integrations().store(app); }
function trustOf(entry) { const t = String((entry && entry.trust) || 'ASK').toUpperCase(); return TRUST.includes(t) ? t : 'ASK'; }
function safeId(id) { return String(id).replace(/[^a-z0-9_]/gi, '_'); }
function nativeName(id, tool) { return `mcp__${safeId(id)}__${String(tool).replace(/[^a-z0-9_]/gi, '_')}`.slice(0, 64); }

// ---- the catalog cache ----------------------------------------------------------------------------------------------
function catalogFile() { return path.join(require('./home').resolve(), 'mcp-catalog.json'); }
let catalogMemo = null;
function readCatalog() {
  if (catalogMemo) return catalogMemo;
  try { catalogMemo = JSON.parse(fs.readFileSync(catalogFile(), 'utf8')) || {}; } catch { catalogMemo = {}; }
  return catalogMemo;
}
/** Remember what a server offered when it connected (integrations.connect calls this). */
function remember(id, tools) {
  const c = readCatalog();
  c[id] = { at: new Date().toISOString(), tools: (tools || []).slice(0, 500).map((t) => ({ name: String(t.name), description: String(t.description || '').slice(0, 600), inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} }, readOnly: Boolean(t.annotations && t.annotations.readOnlyHint), destructive: Boolean(t.annotations && t.annotations.destructiveHint) })) };
  try { fs.mkdirSync(path.dirname(catalogFile()), { recursive: true }); fs.writeFileSync(`${catalogFile()}.tmp`, JSON.stringify(c)); fs.renameSync(`${catalogFile()}.tmp`, catalogFile()); } catch { /* memory only */ }
}
function forget(id) { const c = readCatalog(); delete c[id]; try { fs.writeFileSync(catalogFile(), JSON.stringify(c)); } catch { /* memory only */ } }

/** A server's tools: live when connected, else what it offered last time. */
function toolsOf(id) {
  const live = integrations()._live.get(id);
  if (live && live.state === 'CONNECTED') return live.tools.map((t) => ({ name: String(t.name), description: String(t.description || ''), inputSchema: t.inputSchema || { type: 'object', properties: {} }, readOnly: Boolean(t.annotations && t.annotations.readOnlyHint), destructive: Boolean(t.annotations && t.annotations.destructiveHint) }));
  const c = readCatalog()[id];
  return c ? c.tools : [];
}

// ---- health ---------------------------------------------------------------------------------------------------------
function health(app, id) {
  const e = store(app).mcp[id];
  if (!e) return { state: 'UNAVAILABLE', why: 'no such server' };
  if (e.enabled === false || trustOf(e) === 'DISABLED') return { state: 'DISABLED', why: e.enabled === false ? 'disabled' : 'trust is DISABLED' };
  const c = integrations()._live.get(id);
  if (c && c.state === 'CONNECTED') return { state: 'READY', why: '' };
  if (c && (/FAIL|ERROR/.test(String(c.state)) || (c.state === 'DISCONNECTED' && c.why))) return { state: 'UNAVAILABLE', why: c.why || String(c.state).toLowerCase() };
  return { state: 'IDLE', why: 'not started — starts on first use' };
}
function unavailable(name, why) { return { output: `capability unavailable: ${name} — ${why}`, isError: true }; }

// ---- what the person allows -----------------------------------------------------------------------------------------
/** { allow, ask, why } for one tool of one server, from the person's trust (annotations only ever add a question). */
function policy(entry, tool) {
  const override = entry && entry.tools && entry.tools[tool.name];
  if (override === 'deny') return { allow: false, why: 'you denied this tool' };
  if (override === 'allow') return { allow: true, ask: false };
  if (override === 'ask') return { allow: true, ask: true };
  const t = trustOf(entry);
  if (t === 'DISABLED') return { allow: false, why: 'this server is DISABLED' };
  if (t === 'TRUSTED') return { allow: true, ask: Boolean(tool.destructive) };
  if (tool.readOnly && !tool.destructive) return { allow: true, ask: false };
  if (t === 'READ_ONLY') return { allow: false, why: 'this server is READ_ONLY and the tool is not marked read-only' };
  return { allow: true, ask: true };
}

/** Which servers' tools are described natively this turn: a small connected set, pinned servers, or none. */
function nativeServers(app) {
  const s = store(app);
  const mode = String((s.mcpSchemas || 'auto')).toLowerCase();
  const ready = Object.keys(s.mcp).filter((id) => health(app, id).state === 'READY');
  if (mode === 'lazy') return new Set(ready.filter((id) => s.mcp[id].pinned));
  if (mode === 'eager') return new Set(ready);
  let tools = 0; let bytes = 0;
  for (const id of ready) for (const t of toolsOf(id)) { tools += 1; bytes += JSON.stringify(t.inputSchema || {}).length + String(t.description || '').length; }
  if (tools <= EAGER_TOOLS && bytes <= EAGER_BYTES) return new Set(ready);
  return new Set(ready.filter((id) => s.mcp[id].pinned));
}

/** Are any servers reachable only through search_capabilities + mcp_call? */
function lazyActive(app) {
  const s = store(app);
  const native = nativeServers(app);
  return Object.keys(s.mcp).some((id) => !native.has(id) && !['DISABLED'].includes(health(app, id).state) && (toolsOf(id).length || health(app, id).state !== 'UNAVAILABLE'));
}

function textOf(r) {
  const text = ((r && r.content) || []).map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : p.type === 'resource' ? `[resource ${p.resource && p.resource.uri}]` : `[${p.type}]`)).join('\n');
  return require('./redact').text(text || JSON.stringify(r || {})).slice(0, 60000);
}

/** A native tool definition (tools/index.js) for one server tool, with the person's policy applied. */
function nativeTool(app, id, tool) {
  const s = store(app).mcp;
  const p = policy(s[id], tool);
  if (!p.allow) return null;
  const name = nativeName(id, tool.name);
  return {
    mutates: false,
    effect: p.ask ? 'EXTERNAL' : null,
    approval: p.ask ? (input) => ({ what: `MCP ${s[id].name} › ${tool.name}`, reason: `trust ${trustOf(s[id])}${tool.destructive ? ' · the server marks it destructive' : ''}`, details: JSON.stringify(input || {}).slice(0, 400) }) : null,
    schema: { name, description: `[MCP ${s[id].name}] ${String(tool.description || tool.name).slice(0, 900)}`, parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} } },
    async run(input) { return call(app, id, tool.name, input, { checked: true }); },
  };
}

/** The native tools for this turn (integrations.toolDefs delegates here). */
function toolDefs(app) {
  const out = {};
  for (const id of nativeServers(app)) for (const t of toolsOf(id)) { const d = nativeTool(app, id, t); if (d) out[d.schema.name] = d; }
  return out;
}

async function ensureConnected(app, id) {
  const h = health(app, id);
  if (h.state === 'READY') return { ok: true };
  if (h.state === 'DISABLED') return { ok: false, why: h.why };
  const r = await Promise.race([integrations().connect(app, id), new Promise((res) => setTimeout(() => res({ ok: false, why: `it did not start within ${CONNECT_MS / 1000}s` }), CONNECT_MS).unref())]);
  return r && r.ok ? { ok: true } : { ok: false, why: (r && r.why) || 'it did not start' };
}

/**
 * CALL ONE TOOL — the one path native tools and mcp_call share. `checked` = the gate already asked (native tools
 * carry their policy as effect/approval); mcp_call asks here, through the same approval door.
 */
async function call(app, id, toolName, input, { checked = false, ctx = null } = {}) {
  const s = store(app).mcp;
  const e = s[id];
  if (!e) return unavailable(`MCP ${id}`, 'no such server');
  const known = toolsOf(id).find((t) => t.name === toolName) || { name: toolName, readOnly: false, destructive: false };
  const p = policy(e, known);
  if (!p.allow) return { output: `DENIED MCP_TRUST: ${e.name} › ${toolName}: ${p.why}`, isError: true, denied: true };
  if (!checked && p.ask) {
    const v = await require('./gate').externalApproval(`mcp:${id}:${toolName}`, input, ctx || { app }, () => ({ what: `MCP ${e.name} › ${toolName}`, reason: `trust ${trustOf(e)}`, details: JSON.stringify(input || {}).slice(0, 400) }));
    if (!v.ok) return { output: v.output, isError: true, denied: true };
  }
  const c = await ensureConnected(app, id);
  if (!c.ok) return unavailable(`MCP ${e.name}`, c.why);
  const live = integrations()._live.get(id);
  if (!live.tools.some((t) => t.name === toolName)) return { output: `MCP ${e.name} has no tool "${toolName}" — search_capabilities lists what it offers`, isError: true };
  try {
    const r = await live.call(toolName, input || {});
    return { output: textOf(r), isError: Boolean(r && r.isError) };
  } catch (err) { return { output: `MCP ${e.name}: ${err.message}`, isError: true }; }
}

/** Search tool names and descriptions across servers — from the catalog, starting nothing. */
function search(app, query, { limit = 12 } = {}) {
  const s = store(app).mcp;
  const words = String(query || '').toLowerCase().split(/\W+/).filter((w) => w.length > 1 || /\d/.test(w));
  const hits = [];
  const servers = [];
  for (const id of Object.keys(s)) {
    const h = health(app, id);
    if (h.state === 'DISABLED') continue;
    const tools = toolsOf(id);
    servers.push({ id, name: s[id].name, state: h.state, why: h.why, tools: tools.length, trust: trustOf(s[id]) });
    for (const t of tools) {
      if (!policy(s[id], t).allow) continue;
      const hay = `${s[id].name} ${t.name} ${t.description}`.toLowerCase();
      const score = words.length ? words.reduce((n, w) => n + (t.name.toLowerCase().includes(w) ? 3 : 0) + (hay.includes(w) ? 1 : 0), 0) : 1;
      if (score > 0) hits.push({ server: id, serverName: s[id].name, tool: t.name, description: String(t.description || '').replace(/\s+/g, ' ').slice(0, 160), readOnly: t.readOnly, state: h.state, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), servers };
}

/** One tool's full description and input schema (search_capabilities detail). */
function describe(app, id, toolName) {
  const e = store(app).mcp[id];
  if (!e) return null;
  const t = toolsOf(id).find((x) => x.name === toolName);
  if (!t) return null;
  const p = policy(e, t);
  return { server: id, serverName: e.name, tool: t.name, description: t.description, inputSchema: t.inputSchema, readOnly: t.readOnly, allowed: p.allow, asks: Boolean(p.ask), health: health(app, id) };
}

/** Set the person's trust (Settings › MCP, `/mcp trust`). */
function setTrust(app, id, level, { tools = null } = {}) {
  const e = store(app).mcp[id];
  if (!e) return { ok: false, why: 'no such MCP server' };
  const t = String(level || '').toUpperCase();
  if (!TRUST.includes(t)) return { ok: false, why: `trust is one of ${TRUST.join(', ')}` };
  e.trust = t;
  if (tools && typeof tools === 'object') e.tools = Object.fromEntries(Object.entries(tools).filter(([, v]) => ['allow', 'ask', 'deny'].includes(v)));
  integrations().save(app);
  return { ok: true, id, trust: t };
}

/** Rows for the Harness page and `/mcp`: health, trust, how many tools, and what they cost per request. */
function rows(app) {
  const s = store(app);
  const native = nativeServers(app);
  return Object.keys(s.mcp).map((id) => {
    const tools = toolsOf(id);
    const bytes = tools.reduce((n, t) => n + JSON.stringify(t.inputSchema || {}).length + String(t.description || '').length + 40, 0);
    return { id, name: s.mcp[id].name, trust: trustOf(s.mcp[id]), pinned: Boolean(s.mcp[id].pinned), health: health(app, id), tools: tools.length, schemas: native.has(id) ? 'native' : 'lazy', impact: { perRequestTokens: native.has(id) ? Math.ceil(bytes / 4) : 0, catalogTokens: Math.ceil(bytes / 4) } };
  });
}

function clearMemo() { catalogMemo = null; }

module.exports = { TRUST, EAGER_TOOLS, EAGER_BYTES, trustOf, policy, health, nativeServers, lazyActive, toolDefs, call, search, describe, setTrust, rows, remember, forget, toolsOf, nativeName, clearMemo };
