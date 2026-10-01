'use strict';

/**
 * OLLAMA — a local runtime reached through its own documented HTTP API.
 *
 *   endpoint    cfg.local.ollama.endpoint, else OLLAMA_HOST, else
 *               http://127.0.0.1:11434 — a configured endpoint is used as
 *               given, never swapped for localhost
 *   installed   the `ollama` binary on PATH or in its Windows install folder
 *   running     GET /api/version answers
 *   models      GET /api/tags (+ POST /api/show per model for context and the
 *               capabilities Ollama itself reports) — only what it states
 *   requests    POST /api/chat, streamed, so the runtime's own counters come
 *               back: prompt_eval_count, eval_count, and the load / prompt /
 *               generation / total durations. Nothing provider-style (no cache
 *               figures) is invented; Ollama reports none.
 *
 * LAIN does not start, stop or restart an Ollama service it did not start.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ADAPTER_VERSION = 'ollama-adapter/1';

function root(app) { return (app && app._sibling) || app; }
function settings(app) { const c = (root(app) && root(app).cfg) || {}; return (c.local && c.local.ollama) || {}; }

function endpoint(app) {
  const s = settings(app);
  let e = s.endpoint || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  if (!/^https?:\/\//i.test(e)) e = `http://${e}`;
  return { url: e.replace(/\/+$/, ''), configured: Boolean(s.endpoint || process.env.OLLAMA_HOST) };
}

function binary() {
  if (process.env.LAIN_ISOLATED === '1') return null;
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  if (process.platform === 'win32') dirs.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Ollama'));
  for (const d of dirs) for (const ext of exts) { const p = path.join(d, `ollama${ext}`); try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  return null;
}

async function get(app, p, { timeoutMs = 4000, fetchFn = fetch } = {}) {
  // AN ISOLATED TEST RUN never reaches a real Ollama: only a configured (mock) endpoint.
  if (process.env.LAIN_ISOLATED === '1' && !endpoint(app).configured) return { ok: false, status: 0, why: 'no endpoint configured in an isolated run' };
  try {
    const r = await fetchFn(`${endpoint(app).url}${p}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, status: r.status, why: `HTTP ${r.status}` };
    return { ok: true, body: await r.json() };
  } catch (e) { return { ok: false, status: 0, why: (e && e.cause && e.cause.code) || e.message }; }
}
async function post(app, p, body, { timeoutMs = 8000, fetchFn = fetch } = {}) {
  if (process.env.LAIN_ISOLATED === '1' && !endpoint(app).configured) return { ok: false, status: 0, why: 'no endpoint configured in an isolated run' };
  try {
    const r = await fetchFn(`${endpoint(app).url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, status: r.status, why: `HTTP ${r.status}` };
    return { ok: true, body: await r.json() };
  } catch (e) { return { ok: false, status: 0, why: e.message }; }
}

function cacheFile() { return path.join(require('../config').configDir(), 'local', 'ollama.json'); }
function readCache() { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return null; } }
function writeCache(v) {
  try { fs.mkdirSync(path.dirname(cacheFile()), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(v, null, 2)); } catch { /* a cache */ }
  try { require('../appcatalog').invalidate(); } catch { /* not loaded */ }   // what Ollama serves changed (runtimeconnections.js)
}

/** The model list as Ollama states it, with /api/show detail where it answers. */
function mapModel(t, show) {
  const d = t.details || {};
  const info = (show && show.model_info) || {};
  const arch = info['general.architecture'] || null;
  const ctx = arch && info[`${arch}.context_length`] ? info[`${arch}.context_length`] : null;
  const caps = show && Array.isArray(show.capabilities) ? show.capabilities : null;
  return {
    id: `ollama/${t.name}`, name: t.name, family: d.family || null, families: d.families || null,
    parameterSize: d.parameter_size || null, quantization: d.quantization_level || null, format: d.format || null,
    sizeBytes: Number.isFinite(t.size) ? t.size : null, modifiedAt: t.modified_at ? Date.parse(t.modified_at) : null, digest: t.digest || null,
    contextLength: ctx, architecture: arch,
    capabilities: caps,                                  // as Ollama reports them, or null (older Ollama)
    vision: caps ? caps.includes('vision') : null,
    tools: caps ? caps.includes('tools') : null,
    embedding: caps ? caps.includes('embedding') : null,
  };
}

/** REFRESH: version, running models, installed models. Never starts anything. */
async function refresh(app, { fetchFn = fetch } = {}) {
  const ep = endpoint(app);
  const v = await get(app, '/api/version', { fetchFn });
  const out = { at: Date.now(), endpoint: ep.url, endpointConfigured: ep.configured, binary: binary(), running: v.ok, version: v.ok ? v.body.version || null : null, why: v.ok ? null : v.why, models: [], loaded: [] };
  if (!v.ok) { const prev = readCache(); writeCache({ ...out, models: (prev && prev.models) || [] }); return { ...out, models: (prev && prev.models) || [], stale: Boolean(prev && prev.models && prev.models.length) }; }
  const tags = await get(app, '/api/tags', { fetchFn });
  const list = tags.ok && Array.isArray(tags.body.models) ? tags.body.models : [];
  for (const t of list.slice(0, 200)) {
    // eslint-disable-next-line no-await-in-loop -- bounded list, local endpoint
    const sh = await post(app, '/api/show', { model: t.name }, { fetchFn });
    out.models.push(mapModel(t, sh.ok ? sh.body : null));
  }
  const ps = await get(app, '/api/ps', { fetchFn });
  out.loaded = ps.ok && Array.isArray(ps.body.models) ? ps.body.models.map((m) => ({ name: m.name, sizeBytes: m.size || null, vramBytes: Number.isFinite(m.size_vram) ? m.size_vram : null, expiresAt: m.expires_at ? Date.parse(m.expires_at) : null })) : [];
  writeCache(out);
  return out;
}

function cached() { return readCache(); }

// --------------------------------------------------------------- chat ------

/** LAIN messages → Ollama /api/chat messages. */
function toOllama(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', content: String(m.content || ''), tool_name: m.name || undefined };
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      return { role: 'assistant', content: String(m.content || ''), tool_calls: m.tool_calls.map((tc) => ({ function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? safeJson(tc.arguments) : (tc.arguments || tc.input || {}) } })) };
    }
    return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
  });
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

const NS = 1e6;
/** The runtime's own counters → a usage event's `local` block (ms, tokens/s). */
function metricsFrom(j) {
  const ms = (v) => (Number.isFinite(v) ? Math.round(v / NS) : null);
  const genMs = ms(j.eval_duration); const promptMs = ms(j.prompt_eval_duration);
  return {
    runtime: 'Ollama runtime',
    loadMs: ms(j.load_duration), promptMs, genMs, totalMs: ms(j.total_duration),
    promptTokens: Number.isFinite(j.prompt_eval_count) ? j.prompt_eval_count : null,
    genTokens: Number.isFinite(j.eval_count) ? j.eval_count : null,
    tokPerSec: genMs && j.eval_count ? Math.round((j.eval_count / (genMs / 1000)) * 10) / 10 : null,
    promptTokPerSec: promptMs && j.prompt_eval_count ? Math.round((j.prompt_eval_count / (promptMs / 1000)) * 10) / 10 : null,
  };
}

/**
 * ONE REQUEST, streamed (provider.js event vocabulary). `pc.model` is the
 * catalog id (`ollama/<name>`); the name after the prefix is what Ollama serves.
 */
async function* chat(pc, messages, opts = {}) {
  const name = String(pc.model || '').replace(/^ollama\//, '');
  const body = { model: name, messages: toOllama(messages), stream: true };
  if (opts.tools && opts.tools.length) body.tools = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const url = `${endpoint(opts.app || null).url}/api/chat`;
  const res = await (opts.fetchFn || fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: opts.signal || undefined });
  if (!res.ok) { const e = new Error(`Ollama answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`); e.status = res.status; throw e; }
  const calls = [];
  let last = null; let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.error) { const e = new Error(`Ollama: ${j.error}`); e.status = 500; throw e; }
      const m = j.message || {};
      if (m.thinking) yield { type: 'reasoning', chunk: String(m.thinking) };
      if (m.content) yield { type: 'text', chunk: String(m.content) };
      for (const tc of m.tool_calls || []) calls.push({ id: `call_${calls.length}`, name: tc.function && tc.function.name, input: (tc.function && tc.function.arguments) || {} });
      if (j.done) last = j;
    }
  }
  if (calls.length) yield { type: 'tool_calls', calls: calls.filter((c) => c.name) };
  yield { type: 'finish', reason: calls.length ? 'tool_use' : (last && last.done_reason === 'length' ? 'max_tokens' : 'stop'), raw: last ? last.done_reason || null : null };
  const local = last ? metricsFrom(last) : { runtime: 'Ollama runtime' };
  yield { type: 'usage', inputTokens: local.promptTokens || 0, outputTokens: local.genTokens || 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheReported: false, local };
}

function adapterKey(info) { return `${ADAPTER_VERSION}|${(info && info.version) || 'unknown'}`; }

module.exports = { endpoint, binary, refresh, cached, chat, toOllama, metricsFrom, mapModel, adapterKey, ADAPTER_VERSION };
