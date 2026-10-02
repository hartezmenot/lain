'use strict';

/**
 * USAGE — what was consumed, kept per request, readable by any dimension.
 *
 * ------------------------------------------------------------------------
 * TWO DIFFERENT QUESTIONS, NEVER ONE NUMBER.
 *
 *   CONSUMPTION   what LAIN's requests used — tokens in/out, cache read/write,
 *                 reasoning, latency, tool calls, tool schema, fixed prompt.
 *                 From the receipts below. Keyed by account INSTANCE.
 *   LIMITS        how much of a provider's window is used — the provider's own
 *                 figures (accountinstances.js / usagewindows.js). Shown per
 *                 window; never derived from token counts, never averaged.
 *
 * ------------------------------------------------------------------------
 * A USAGE RECEIPT is one finished request (modelrequest.close → record):
 *
 *   id, at, source         'lain' for LAIN's own requests; 'runtime:<kind>' for
 *                          usage a runtime reported about its own work (imported,
 *                          never double counted — a different id space)
 *   dimensions             project, session, task, model, provider, account, role
 *   tokens                 as the provider reported them; a figure it did not
 *                          report is null ("not reported"), never 0
 *   cost                   costUsd only when the PROVIDER stated it (actual).
 *                          An estimate is computed at read time, only from prices
 *                          the person configured (usage.prices), and says so.
 *
 * NO PROMPT, NO REPLY, NO KEY. Identity and accounting only.
 *
 * Kept in <configDir>/usage/receipts-YYYY-MM.jsonl; read back deduplicated by id,
 * through usageindex.js (Phase 8.1): each file is parsed once per process and then
 * only its appended tail; hourly aggregates are kept in usage/index-v1.json.
 */

const fs = require('fs');
const path = require('path');

const DIMS = Object.freeze(['project', 'session', 'task', 'model', 'provider', 'account', 'role', 'day', 'source', 'via', 'origin']);

/**
 * WHAT STARTED A REQUEST (the Origin filter): a person in Chat, the BOT, the
 * Coding Agent, a scheduled / recurring assistant task, a watch, or Telegram.
 * Explicit when the caller knows it (modelrequest `origin`); otherwise read
 * from the role — never from a model name.
 */
const ORIGIN = Object.freeze({ chat: 'Interactive Chat', bot: 'BOT', agent: 'Agent', scheduled: 'Scheduled', recurring: 'Recurring', watch: 'Watch', telegram: 'Telegram', serve: 'LAIN Server (external app)', machinery: 'LAIN machinery' });
function originOf(rec, role) {
  if (rec.origin && ORIGIN[rec.origin]) return ORIGIN[rec.origin];
  if (role === 'chat') return ORIGIN.chat;
  if (role === 'bot') return ORIGIN.bot;
  if (role === 'machinery' || role === 'aux' || role === 'external') return ORIGIN.machinery;
  return ORIGIN.agent;
}

/**
 * WHERE A REQUEST WENT, as a person names it (the Source filter): an API, a
 * local runtime, an agent runtime or a website session. Derived from the
 * transport and runtime on the record — never from a model name.
 */
function viaOf(rec) {
  const rt = rec.runtime || (rec.receipt && rec.receipt.runtime && rec.receipt.runtime.id) || null;
  if (rec.transport === 'local') return rt === 'ollama' ? 'Local · Ollama' : 'Local · llama.cpp';
  if (rec.transport === 'runtime') return ({ 'claude-code': 'Runtime · Claude Code', opencode: 'Runtime · OpenCode', zcode: 'Runtime · ZCode', codex: 'Runtime · Codex' })[rt] || `Runtime · ${rt || 'unknown'}`;
  if (rec.transport === 'website') return rec.connection === 'chatgpt-web' || rec.provider === 'chatgpt-web' ? 'Website · ChatGPT Chat' : `Website · ${rec.provider || rec.connection || ''}`;
  return 'API';
}

function dir() { return path.join(require('./config').configDir(), 'usage'); }
function fileFor(at) { const d = new Date(at || Date.now()); return path.join(dir(), `receipts-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`); }

function roleOf(rec) {
  if (rec.role) return { role: rec.role, derived: false };
  if (rec.transport === 'website') return { role: 'chat', derived: true };
  if (rec.reason === 'agent-test') return { role: 'machinery', derived: true };
  if (rec.reason === 'external-review') return { role: 'aux', derived: true };
  if (rec.reason === 'machinery') return { role: 'machinery', derived: true };
  return { role: 'agent', derived: true };
}
const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** A finished reqtrace record → a receipt row. */
function fromRecord(rec) {
  const r = rec.receipt || null;
  const role = roleOf(rec);
  return {
    v: 1, id: rec.id, at: rec.at || Date.now(), source: 'lain',
    tokens: r ? (r.estimated ? 'estimated' : (rec.transport === 'local' || rec.transport === 'runtime' ? 'runtime' : 'provider')) : 'not reported',
    transport: rec.transport || 'api', protocol: rec.protocol || '',
    project: rec.project || null, session: rec.session || null, task: rec.task || null,
    role: role.role, roleDerived: role.derived, origin: originOf(rec, role.role),
    model: rec.model || '', provider: rec.provider || '', account: rec.account || rec.connection || '', route: rec.route || null, requestedAccount: rec.requestedAccount || null,
    // THE LOGICAL ROUTE (Phase 8.3): provider family · logical model · effort — the backing account is `account`.
    family: rec.family || null, logicalModel: rec.logicalModel || null, effort: rec.effort || null,
    ok: rec.ok !== false, ms: n(rec.ms),
    input: r ? n(r.inputTokens) : null, output: r ? n(r.outputTokens) : null,
    cacheRead: r ? n(r.cacheReadTokens) : null, cacheWrite: r ? n(r.cacheCreationTokens) : null,
    reasoning: r ? n(r.reasoningTokens) : null, toolCalls: r ? n(r.toolCalls) : null,
    costUsd: r ? n(r.costUsd) : null,
    toolSchemaChars: n(rec.toolSchemaChars), toolCount: n(rec.toolCount), systemChars: n(rec.systemChars), messageChars: n(rec.messageChars),
    via: viaOf(rec), runtime: rec.runtime || (r && r.runtime ? r.runtime.id || null : null),
    local: r && r.local ? r.local : null,
    costBasis: r && r.costBasis ? r.costBasis : null,
    observed: r && r.observed ? r.observed : null,
  };
}

function append(row) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(fileFor(row.at), `${JSON.stringify(row)}\n`);
    require('./usageindex').noteAppended();
  } catch { /* measurement never ends a turn */ }
  return row;
}

/** LAIN's own request, finished. */
function record(rec) {
  if (!rec || !rec.id || rec.ok === null) return null;
  return append(fromRecord(rec));
}

/**
 * USAGE A RUNTIME REPORTED about work it did itself (a Codex thread's token
 * usage). Its own id space (`<source>:<id>`), so it can never be counted
 * twice against a LAIN request, and importing the same report again is a no-op.
 */
function importRuntime(source, rows = []) {
  if (!/^runtime:[a-z0-9_-]+$/.test(String(source))) throw new Error('a runtime source is runtime:<kind>');
  const seen = new Set(read({}).map((r) => r.id));
  let added = 0;
  for (const x of rows) {
    const id = `${source}:${x.id}`;
    if (!x.id || seen.has(id)) continue;
    seen.add(id);
    append({ v: 1, id, at: x.at || Date.now(), source, tokens: 'runtime', transport: 'runtime', protocol: '', project: x.project || null, session: x.session || null, task: null,
      role: x.role || 'external', roleDerived: !x.role, model: x.model || '', provider: x.provider || '', account: x.account || '', ok: true, ms: null,
      input: n(x.input), output: n(x.output), cacheRead: n(x.cacheRead), cacheWrite: n(x.cacheWrite), reasoning: n(x.reasoning), toolCalls: null, costUsd: null,
      toolSchemaChars: null, toolCount: null, systemChars: null, messageChars: null });
    added++;
  }
  return { added };
}

/** Rows in [from, to], oldest first, once per id — from the incremental index (usageindex.js). */
function read({ from = 0, to = Date.now() + 1 } = {}) {
  return require('./usageindex').rows({ from, to });
}

/** The same, parsing every file from the start (tests compare the index against it). */
function readRaw({ from = 0, to = Date.now() + 1 } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((f) => /^receipts-\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
  const lo = new Date(from); const loKey = `${lo.getUTCFullYear()}-${String(lo.getUTCMonth() + 1).padStart(2, '0')}`;
  const byId = new Map();
  for (const f of names) {
    if (f.slice(9, 16) < loKey) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir(), f), 'utf8'); } catch { continue; }
    for (const ln of text.split('\n')) {
      if (!ln) continue;
      let r; try { r = JSON.parse(ln); } catch { continue; }
      if (!r || !r.id || r.at < from || r.at > to) continue;
      byId.set(r.id, r);
    }
  }
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

function keyOf(r, dim) {
  if (dim === 'day') { const d = new Date(r.at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  if (dim === 'origin' && !r.origin) return originOf(r, r.role);   // receipts written before Origin existed
  return r[dim] == null || r[dim] === '' ? '(none)' : String(r[dim]);
}

/** A price the person configured, for this model, per 1M tokens (USD). */
function priceFor(cfg, model) {
  const prices = (cfg && cfg.usage && cfg.usage.prices) || {};
  if (prices[model]) return prices[model];
  for (const [k, v] of Object.entries(prices)) if (k.endsWith('*') && String(model).startsWith(k.slice(0, -1))) return v;
  return null;
}

function pct(sorted, p) { if (!sorted.length) return null; return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }

/** Sum a set of rows. Every figure says how many rows reported it. */
function sum(rows, cfg) {
  const s = { requests: rows.length, failed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, toolCalls: 0, toolSchemaChars: 0, systemChars: 0,
    reported: { tokens: 0, cache: 0, reasoning: 0, toolCalls: 0, cost: 0 }, cacheHits: 0, cacheMisses: 0,
    cost: { actualUsd: 0, actualRows: 0, estimatedUsd: 0, estimatedRows: 0, unpriced: 0, runtimeUsd: 0, runtimeRows: 0 }, latency: { avgMs: null, p50Ms: null, p95Ms: null },
    // ESTIMATED BY LAIN (a website session's sizes, chars/4) — never added to reported tokens.
    estimated: { rows: 0, input: 0, output: 0 },
    // A LOCAL RUNTIME'S OWN COUNTERS — speed and time, never provider cache.
    local: { rows: 0, genTokens: 0, genMs: 0, promptTokens: 0, promptMs: 0, loads: 0, loadMs: 0 },
    observed: { rows: 0, inChars: 0, outChars: 0 } };
  const ms = [];
  for (const r of rows) {
    if (!r.ok) s.failed++;
    if (r.observed) { s.observed.rows++; s.observed.inChars += r.observed.inChars || 0; s.observed.outChars += r.observed.outChars || 0; }
    if (r.local) {
      const l = r.local; s.local.rows++;
      if (Number.isFinite(l.genTokens) && Number.isFinite(l.genMs)) { s.local.genTokens += l.genTokens; s.local.genMs += l.genMs; }
      if (Number.isFinite(l.promptTokens) && Number.isFinite(l.promptMs)) { s.local.promptTokens += l.promptTokens; s.local.promptMs += l.promptMs; }
      if (Number.isFinite(l.loadMs)) { s.local.loads++; s.local.loadMs += l.loadMs; }
    }
    if (r.tokens === 'estimated') { s.estimated.rows++; s.estimated.input += r.input || 0; s.estimated.output += r.output || 0; if (r.ms != null) ms.push(r.ms); continue; }
    if (r.input != null || r.output != null) { s.reported.tokens++; s.input += r.input || 0; s.output += r.output || 0; }
    if (r.cacheRead != null || r.cacheWrite != null) {
      s.reported.cache++; s.cacheRead += r.cacheRead || 0; s.cacheWrite += r.cacheWrite || 0;
      if ((r.cacheRead || 0) > 0) s.cacheHits++; else s.cacheMisses++;
    }
    if (r.reasoning != null) { s.reported.reasoning++; s.reasoning += r.reasoning; }
    if (r.toolCalls != null) { s.reported.toolCalls++; s.toolCalls += r.toolCalls; }
    s.toolSchemaChars += r.toolSchemaChars || 0;
    s.systemChars += r.systemChars || 0;
    if (r.ms != null) ms.push(r.ms);
    // A RUNTIME'S OWN COST FIGURE (Claude Code's API-equivalent, OpenCode's session cost) is
    // kept apart from a provider's billed figure: it is what the runtime computed, not a charge.
    if (r.costUsd != null && r.costBasis) { s.cost.runtimeUsd += r.costUsd; s.cost.runtimeRows++; }
    else if (r.costUsd != null) { s.cost.actualUsd += r.costUsd; s.cost.actualRows++; }
    else if (r.input != null) {
      const p = priceFor(cfg, r.model);
      if (p) {
        s.cost.estimatedUsd += ((r.input || 0) * (p.input || 0) + (r.output || 0) * (p.output || 0) + (r.cacheRead || 0) * (p.cacheRead || 0) + (r.cacheWrite || 0) * (p.cacheWrite || 0)) / 1e6;
        s.cost.estimatedRows++;
      } else s.cost.unpriced++;
    }
  }
  ms.sort((a, b) => a - b);
  if (ms.length) s.latency = { avgMs: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length), p50Ms: pct(ms, 0.5), p95Ms: pct(ms, 0.95) };
  s.cost.actualUsd = Math.round(s.cost.actualUsd * 1e6) / 1e6;
  s.cost.estimatedUsd = Math.round(s.cost.estimatedUsd * 1e6) / 1e6;
  s.cost.runtimeUsd = Math.round(s.cost.runtimeUsd * 1e6) / 1e6;
  s.local.tokPerSec = s.local.genMs ? Math.round((s.local.genTokens / (s.local.genMs / 1000)) * 10) / 10 : null;
  s.local.promptTokPerSec = s.local.promptMs ? Math.round((s.local.promptTokens / (s.local.promptMs / 1000)) * 10) / 10 : null;
  s.local.avgLoadMs = s.local.loads ? Math.round(s.local.loadMs / s.local.loads) : null;
  s.cost.label = 'Estimated from configured prices';
  return s;
}

/** The rows matching every filter given ({ project, session, task, model, provider, account, role, via }). */
function filter(rows, f = {}) {
  const keys = Object.keys(f).filter((k) => DIMS.includes(k) && f[k] != null && f[k] !== '');
  if (!keys.length) return rows;
  return rows.filter((r) => keys.every((k) => keyOf(r, k) === String(f[k])));
}

/** Group rows by one dimension. */
function aggregate(rows, dim, cfg) {
  if (!DIMS.includes(dim)) throw new Error(`usage is grouped by ${DIMS.join(', ')}`);
  const groups = new Map();
  for (const r of rows) { const k = keyOf(r, dim); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  return [...groups.entries()].map(([key, rs]) => ({ key, ...sum(rs, cfg) })).sort((a, b) => (b.input + b.output) - (a.input + a.output));
}

/**
 * CONTEXT EFFICIENCY — LAIN's own reuse, apart from the provider's cache.
 *   provider cache   what the provider said it served from cache (receipts)
 *   fixed prompt     the system prompt re-sent on every request
 *   tool schema      what the offered tools cost per request (funnel or not)
 * The provider's cache and LAIN's reuse are different mechanisms and are
 * reported in different rows.
 */
function efficiency(rows) {
  const api = rows.filter((r) => r.source === 'lain' && r.transport === 'api');
  const cache = { reportedRows: 0, cachedTokens: 0, totalInput: 0 };
  for (const r of api) {
    const nm = require('./cacheledger').normalize(r.input == null ? null : { inputTokens: r.input, outputTokens: r.output, cacheReadTokens: r.cacheRead, cacheCreationTokens: r.cacheWrite, cacheReported: r.cacheRead != null || r.cacheWrite != null }, r.protocol === 'anthropic' ? 'anthropic' : 'chat');
    if (!nm.reported || nm.total == null) continue;
    cache.reportedRows++; cache.cachedTokens += nm.cached || 0; cache.totalInput += nm.total || 0;
  }
  const per = (k) => (api.length ? Math.round(api.reduce((a, r) => a + (r[k] || 0), 0) / api.length) : null);
  return {
    provider: { ...cache, hitRatio: cache.totalInput ? Math.round((cache.cachedTokens / cache.totalInput) * 1000) / 1000 : null, notReportedRows: api.length - cache.reportedRows },
    lain: { requests: api.length, avgSystemChars: per('systemChars'), avgToolSchemaChars: per('toolSchemaChars'), avgToolCount: per('toolCount'), avgMessageChars: per('messageChars') },
  };
}

module.exports = { ORIGIN, originOf, record, importRuntime, read, readRaw, aggregate, sum, efficiency, priceFor, fromRecord, filter, keyOf, viaOf, DIMS, dir };
