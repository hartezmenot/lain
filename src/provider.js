'use strict';

const finishMod = require('./finish');

/** The network boundary. */

const promptcache = require('./promptcache');
const progress = require('./streamprogress');
const { routeHeaders } = require('./routeheaders');
const errors = require('./errors');

const PROTOCOL = Object.freeze({ ANTHROPIC: 'anthropic', CHAT: 'chat', RESPONSES: 'responses', MOCK: 'mock', RUNTIME: 'runtime' });

/** Which endpoint serves this turn: the chosen account's exact catalog route (Phase 8.2), or an env-var key. */
function resolve(cfg = {}) {
  if (process.env.LAIN_PROVIDER === 'mock') {
    return { protocol: PROTOCOL.MOCK, provider: 'mock', connectionId: 'mock', model: cfg.model || 'mock-model', apiKey: 'mock', ctx: 200000, maxTokens: 4096 };
  }

  // A SELECTION ON A REMOVED ROUTER IS UNAVAILABLE, never silently rerouted to
  // another connection that happens to carry the same model name. See retired.js.
  const gone = require('./retired').selection(cfg);
  if (gone) return { protocol: null, provider: null, connectionId: gone.connection, model: cfg.model || null, apiKey: '', unavailable: gone };
  if (cfg._refusal) return { protocol: null, provider: null, connectionId: null, model: cfg.model || null, apiKey: '', unavailable: { kind: 'account', why: cfg._refusal.why, code: cfg._refusal.code || null } };

  // STRUCTURED SELECTION: {model, connection, effort} resolved through the catalog.
  if (cfg.model && (cfg.connections || /^(runtime|local):/.test(String(cfg.connection || '')))) {   // a runtime/local route needs no API connections configured at all
    const connections = require('./connections').fromConfig(cfg, cfg._evidence || {});
    const catalog = require('./appcatalog').catalogFor(connections);   // built once per distinct set (Phase 8.2)
    const r = require('./catalog').resolve(catalog, {
      model: cfg.model, connectionId: cfg.connection, effort: cfg.effort,
    });
    if (r.ok) {
      // baseConnectionId is the configured connection; connectionId may carry a routing namespace (e.g. `omniroute:openrouter`).
      const conn = connections.find((c) => c.id === (r.connection.baseConnectionId || r.connection.connectionId));
      if (conn) {
        const bound = require('./runtimebound').check({ conn, connectionId: r.connection.connectionId, model: r.model, upstreamId: r.upstreamId }); if (bound) return { protocol: null, provider: conn.provider, connectionId: conn.id, model: r.model, apiKey: '', unavailable: bound };
        const plan = require('./fabric/effortcaps').planFor({ conn, route: r, cfg, chat: PROTOCOL.CHAT });   // native level, profile default, or LAIN effort (no wire)
        return {
          protocol: conn.protocol || PROTOCOL.CHAT,
          provider: conn.provider,
          connectionId: conn.id,
          // THE ACCOUNT IT GOES THROUGH (accountcatalog.js), the one asked for, and the exact route.
          routeId: r.connection.connectionId, accountId: require('./accountcatalog').accountIdForRoute(r.connection.connectionId, conn), requestedAccount: cfg.account || null, family: cfg.family || null,
          model: r.upstreamId,
          canonicalModel: r.model,
          effort: plan ? plan.effort : r.effort, effortSource: plan ? plan.source : (r.effort || cfg.effort ? 'provider' : null), effortWire: plan ? plan.wire : null, effortExplicit: plan ? Boolean(plan.explicit) : Boolean(cfg.effort && cfg.effort !== 'auto'), lainEffort: plan && plan.source === 'lain' ? plan.lainEffort : null, reasoningEffort: plan ? (plan.source === 'provider' ? plan.effort : null) : (cfg.effort || null),   // a request FIELD on the Responses API (responsesapi.js)
          baseUrl: conn.baseUrl, credentialRef: conn.credentialRef || null,   // the key is read just before the request (chat → credentials.ensure), never to list
          get apiKey() { return conn.apiKey || (conn.via === 'bridge' ? 'bridge' : ''); }, set apiKey(v) { Object.defineProperty(this, 'apiKey', { value: v, writable: true, enumerable: true, configurable: true }); },   // read when a request is sent — never to draw a header (connections.js)
          ctx: ((conn.models || []).find((x) => x && x.id === r.model) || {}).ctx || conn.ctx || 128000,   // a local model's real window
          maxTokens: conn.maxTokens || ((conn.protocol === PROTOCOL.ANTHROPIC && /claude/i.test(r.upstreamId || r.model)) ? 32000 : 4096),   // a current Claude thinks inside max_tokens (audit F1); streamed, so safe
          // CARRIED FROM THE CONFIG, because the SENDER needs it and only `resolve` reads the config.
          promptCache: cfg.promptCache,
          headers: conn.headers || {},
          // RUNTIME (runtimeprovider.js): llama.cpp, Ollama, Claude Code, OpenCode, ZCode — which adapter, and its settings.
          runtime: conn.runtime || null, locality: conn.locality || null, adapterCfg: conn.runtime ? { local: cfg.local || {}, runtimes: cfg.runtimes || {}, accounts: { codex: { binary: ((cfg.accounts || {}).codex || {}).binary } } } : null,
        };
      }
    }
  }

  // A `cfg.providers` branch stood here.

  // Env-var fallback, so a bare API key works with no config file.
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      protocol: PROTOCOL.ANTHROPIC, provider: 'anthropic', connectionId: 'env:anthropic',
      model: cfg.model || 'claude-opus-5',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: process.env.ANTHROPIC_API_KEY,
      ctx: 200000, maxTokens: 32000, headers: {},
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      protocol: PROTOCOL.CHAT, provider: 'openai', connectionId: 'env:openai',
      model: cfg.model || 'gpt-5.5',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      ctx: 128000, maxTokens: 8192, headers: {},
    };
  }
  return { protocol: null, provider: null, connectionId: null, model: cfg.model || null, apiKey: '' };
}

/** A setup instruction, not a crash, and it costs zero requests. */
function credentialHint(pc, cfg = null) {
  if (pc.unavailable) return pc.unavailable.kind === 'runtime-bound' || pc.unavailable.kind === 'account' ? pc.unavailable.why : require('./retired').unavailableText(pc.unavailable);
  if (!pc.protocol) {
    const hasConnections = cfg && cfg.connections && Object.keys(cfg.connections).length > 0;
    if (hasConnections && !cfg.model) {
      return 'No model selected. /model to browse what your connections serve, or /model <name>.';
    }
    if (hasConnections && cfg.model) {
      return `Model "${cfg.model}" is not served by any configured connection. /model to pick one, or /provider refresh to re-read a route's catalog.`;
    }
    return `No provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or add an account or API key with \`lain model\` (settings: ${require('./config').configFile()}).`;
  }
  if (!(pc.credentialRef ? require('./credentials').present(pc.credentialRef) : pc.apiKey) && pc.protocol !== PROTOCOL.RUNTIME) return `No credential for provider '${pc.provider}'.`;   // presence only — a hint never decrypts a key; a runtime route holds no LAIN credential
  return null;
}

// ---------------------------------------------------------------- http ------

/** TIMEOUTS. Without these the CLI hangs forever on a bridge that accepts the TCP connection and then never answers — verified: 45s with no prompt back… */
/** TIME TO FIRST BYTE was 30s, and that is a real model's ordinary behaviour. */
const TTFB_TIMEOUT_MS = Number(process.env.LAIN_TTFB_TIMEOUT_MS) || 600_000;
/** SILENCE MID-REPLY, bounded at 180s (it was 60s). */
// Read per stream, so the bound can be set without reloading this module.
const inactivityMs = () => Number(process.env.LAIN_STREAM_TIMEOUT_MS) || 180_000;

/** Compose the caller's abort signal with a deadline. */
function deadline(signal, ms) {
  const ac = new AbortController();
  const state = { timedOut: false };
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => { state.timedOut = true; ac.abort(); }, ms);
  state.signal = ac.signal;
  state.clear = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  };
  return state;
}

async function postSSE(url, headers, body, signal, route = null) {
  const d = deadline(signal, TTFB_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: d.signal,
    });
  } catch (e) {
    if (d.timedOut) {
      const err = new Error(`no response headers within ${Math.round(TTFB_TIMEOUT_MS / 1000)}s`);
      err.timedOut = true;
      // NOT RETRIABLE, deliberately.
      err.noResponse = true;
      throw err;
    }
    throw e;
  } finally {
    d.clear();
  }
  // THE ACCOUNT'S OWN USAGE READING, from the rate-limit headers the provider
  // sent with this response — refusals included. See src/usagewindows.js.
  if (route) require('./usagewindows').observe(route, res.headers);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 600); } catch { /* body already consumed */ }
    const err = new Error(`${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
    err.status = res.status;
    const ra = res.headers.get('retry-after');
    if (ra) err.retryAfter = Number(ra);
    throw err;
  }
  return res;
}

/** Yield complete SSE `data:` payloads from a fetch Response. */
async function* sseLines(res, signal = null, live = null) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    // CTRL+C MUST REACH THE SOCKET, NOT JUST THE SCREEN
    if (signal && signal.aborted) {
      try { await reader.cancel(); } catch { /* already gone */ }
      const e = new Error('cancelled');
      e.aborted = true;
      throw e;
    }
    let timer;
    const stall = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`stream inactive for ${Math.round(inactivityMs() / 1000)}s`); e.stalled = true;
        e.timedOut = true;
        reject(e);
      }, inactivityMs());
    });
    // The abort must be a RACER, not only a check at the top of the loop: a stream that has gone quiet is precisely when somebody reaches for Ctrl+C, and a…
    let onAbort = null;
    const cancelled = new Promise((_, reject) => {
      if (!signal) return;
      onAbort = () => { const e = new Error('cancelled'); e.aborted = true; reject(e); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let chunk;
    try {
      chunk = await Promise.race([reader.read(), stall, cancelled]);
    } catch (e) {
      // WHATEVER ENDED THE WAIT, the socket is released before the error leaves.
      try { await reader.cancel(); } catch { /* already gone */ }
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
    const { done, value } = chunk;
    if (done) break;
    // LIVENESS (streamprogress.js): a byte is a byte, keepalives included.
    if (live) progress.bytes(live, value ? value.length : 0);
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(payload); } catch { continue; /* keepalive or partial */ }
      if (live) progress.data(live);
      yield parsed;
    }
  }
}

// ----------------------------------------------------------- anthropic ------

function toAnthropic(messages) {
  const system = [];
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system') { system.push(String(m.content || '')); continue; }
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: String(m.tool_call_id || ''), content: String(m.content || '') };
      if (m.isError) block.is_error = true;
      // Parallel results belong in ONE user message; a bare user turn between
      // them is a 400.
      const prev = out[out.length - 1];
      const isResultTurn = prev && prev.role === 'user' && Array.isArray(prev.content)
        && prev.content.length && prev.content.every((p) => p.type === 'tool_result');
      if (isResultTurn) prev.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const content = [];
      if (String(m.content || '').trim()) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments || '{}') : (tc.arguments || {}); } catch { input = {}; }
        content.push({ type: 'tool_use', id: String(tc.id), name: String(tc.name), input });
      }
      out.push({ role: 'assistant', content });
      continue;
    }
    // NEVER TWO USER TURNS IN A ROW
    const prev = out[out.length - 1];
    if (m.role === 'user' && prev && prev.role === 'user' && Array.isArray(prev.content)) {
      prev.content.push({ type: 'text', text: String(m.content || '') });
      continue;
    }
    out.push({ role: m.role, content: String(m.content || '') });
  }
  return { system: system.join('\n\n'), messages: out };
}

/** MARK ONE MESSAGE AS A CACHE BOUNDARY. */
function withCacheBreakpoint(msg) {
  if (!msg) return msg;
  if (Array.isArray(msg.content)) {
    if (!msg.content.length) return msg;
    const content = msg.content.slice();
    content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
    return { ...msg, content };
  }
  if (typeof msg.content === 'string' && msg.content) {
    return { ...msg, content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }] };
  }
  return msg;
}

async function* anthropicChat(pc, messages, opts) {
  const { system, messages: rawBody } = toAnthropic(messages);
  // THE MOVING CACHE BREAKPOINT
  let body = rawBody;
  if (body.length) {
    body = body.slice();
    body[body.length - 1] = withCacheBreakpoint(body[body.length - 1]);
  }
  const payload = { model: pc.model, max_tokens: pc.maxTokens, stream: true, messages: body }; if (pc.effort && /^(low|medium|high|xhigh|max)$/.test(String(pc.effort)) && (pc.effortWire === 'output_config' || (!pc.effortWire && /claude/i.test(pc.model)))) payload.output_config = { effort: String(pc.effort) }; if (opts && opts.wireOut) opts.wireOut.effort = payload.output_config ? payload.output_config.effort : null;   // audit F2 + 2026-10-02: only a level the route declares (Claude; GLM on Z.ai's Anthropic endpoint)
  if (system) {
    // Cache the whole stable prefix.
    payload.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }
  if (opts.tools && opts.tools.length) {
    payload.tools = opts.tools.map((t, i) => {
      const def = {
        name: t.name, description: t.description,
        input_schema: t.parameters || { type: 'object', properties: {} },
      };
      // Tool schemas are the same object on every step of every turn — the single most stable part of the request — so the last one carries the boundary that…
      if (i === opts.tools.length - 1) def.cache_control = { type: 'ephemeral' };
      return def;
    });
  }
  const res = await postSSE(`${pc.baseUrl}/messages`, {
    'x-api-key': pc.apiKey,
    'anthropic-version': '2023-06-01',
    ...routeHeaders(pc, opts),
    ...pc.headers,
  }, payload, opts.signal, pc);

  const acc = [];
  // cacheReadTokens/cacheCreationTokens are the diagnostic that answers "is the cache actually working": a healthy tool-heavy turn should show cache…
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheReported: false };
  let stopRaw = null;
  const live = opts.live || null;
  for await (const j of sseLines(res, opts.signal, live)) {
    if (j.type === 'content_block_start' && j.content_block && j.content_block.type === 'redacted_thinking') yield { type: 'reasoning', chunk: '', hidden: true };
    if (j.type === 'content_block_start' && j.content_block && j.content_block.type === 'tool_use') {
      acc[j.index || 0] = { id: j.content_block.id, name: j.content_block.name, args: '' };
      progress.toolDelta(live, { name: j.content_block.name, bytes: 0, index: acc.filter(Boolean).length - 1, calls: acc.filter(Boolean).length });
    } else if (j.type === 'content_block_delta' && j.delta) {
      if (j.delta.text) yield { type: 'text', chunk: j.delta.text };
      if (j.delta.type === 'input_json_delta' && acc[j.index || 0]) {
        const t = acc[j.index || 0];
        t.args += j.delta.partial_json || '';
        progress.toolDelta(live, { name: t.name, bytes: t.args.length, index: acc.filter(Boolean).indexOf(t), calls: acc.filter(Boolean).length });
      }
      // VISIBLE THINKING streams as reasoning (shown while it arrives, never sent back); a signature is hidden reasoning.
      if (j.delta.type === 'thinking_delta' && j.delta.thinking) yield { type: 'reasoning', chunk: String(j.delta.thinking) };
      if (j.delta.type === 'signature_delta') yield { type: 'reasoning', chunk: '', hidden: true };
    } else if (j.type === 'message_start' && j.message && j.message.usage) {
      const u = j.message.usage;
      usage.inputTokens = u.input_tokens || 0;
      usage.cacheReadTokens = u.cache_read_input_tokens || 0;
      usage.cacheCreationTokens = u.cache_creation_input_tokens || 0;
      usage.cacheReported = u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null; usage.promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;   // Anthropic's input excludes the cache
      // THE ONLY GENUINELY LIVE NUMBER IN A REQUEST
      yield { type: 'usage_live', ...usage };
    } else if (j.type === 'message_delta') {
      if (j.usage) usage.outputTokens = j.usage.output_tokens || usage.outputTokens;
      if (j.delta && j.delta.stop_reason) stopRaw = j.delta.stop_reason;
    }
  }
  // WHY IT ENDED, and arguments exactly as they arrived (finish.js).
  const calls = acc.filter(Boolean).map((t) => ({ id: t.id, name: t.name, ...finishMod.parseArgs(t.args) }));
  if (calls.length) yield { type: 'tool_calls', calls };
  yield { type: 'finish', reason: finishMod.normalize(stopRaw), raw: stopRaw || null };
  yield { type: 'usage', ...usage };
}

// ---------------------------------------------------------------- chat ------
async function* openaiChat(pc, messages, opts) {
  const wire = messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content || '') };
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      return {
        role: 'assistant', content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) },
        })),
      };
    }
    return { role: m.role, content: String(m.content || '') };
  });
  // THE REPLAYED TRANSCRIPT, MADE CACHEABLE
  const cacheable = promptcache.needsExplicitCache(pc, (opts && opts.cfg) || {});
  const body = cacheable ? promptcache.applyToChat(wire) : wire;
  const payload = { model: pc.model, messages: body, stream: true, stream_options: { include_usage: true } };
  if (pc.effortWire === 'reasoning_effort' && pc.effort) payload.reasoning_effort = String(pc.effort);
  if (opts && opts.wireOut) opts.wireOut.effort = payload.reasoning_effort || null;   // native effort (GLM-5.3 on Z.ai), only as declared
  if (opts.tools && opts.tools.length) {
    payload.tools = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  const res = await postSSE(`${pc.baseUrl}/chat/completions`, {
    authorization: `Bearer ${pc.apiKey}`, ...routeHeaders(pc, opts), ...pc.headers,
  }, payload, opts.signal, pc);

  const acc = [];
  const inline = new (require('./inlinethink').InlineThink)();
  let stopRaw = null;
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheReported: false };
  const live = opts.live || null;
  for await (const j of sseLines(res, opts.signal, live)) {
    if (j.usage) {
      const before = usage.inputTokens;
      usage.inputTokens = j.usage.prompt_tokens || usage.inputTokens;
      usage.outputTokens = j.usage.completion_tokens || usage.outputTokens;
      // WITHOUT THIS, WHETHER CACHING WORKS IS UNANSWERABLE FROM INSIDE LAIN.
      const c = promptcache.usageFrom(j.usage);
      usage.cacheReadTokens = c.cacheReadTokens || usage.cacheReadTokens || 0;
      usage.cacheCreationTokens = c.cacheCreationTokens || usage.cacheCreationTokens || 0;
      usage.cacheReported = usage.cacheReported || c.reported; if (c.reasoningTokens != null) usage.reasoningTokens = c.reasoningTokens; usage.promptTokens = usage.inputTokens;   // prompt_tokens includes the cache
      // LIVE ONLY IF IT GENUINELY ARRIVED EARLY
      if (usage.inputTokens && usage.inputTokens !== before) yield { type: 'usage_live', ...usage };
    }
    if (j.timings && typeof j.timings === 'object') usage.timings = j.timings;   // llama.cpp's own counters → local metrics (runtimeprovider.js)
    if (j.choices && j.choices[0] && j.choices[0].finish_reason) stopRaw = j.choices[0].finish_reason;
    const d = j.choices && j.choices[0] && j.choices[0].delta;
    if (!d) continue;
    // Inline `<thinking>` in content is reasoning, not the answer (inlinethink.js).
    if (d.content) for (const ev of inline.push(d.content)) yield ev;
    // Reasoning (`reasoning_content` / `reasoning`) is its own event, never the answer; the screen folds it (ui/thoughtrow.js).
    const think = d.reasoning_content || d.reasoning;
    if (think) yield { type: 'reasoning', chunk: String(think) };
    for (const tc of d.tool_calls || []) {
      const i = tc.index || 0;
      if (!acc[i]) acc[i] = { id: tc.id || `call_${i}`, name: '', args: '' };
      if (tc.id) acc[i].id = tc.id;
      if (tc.function && tc.function.name) acc[i].name += tc.function.name;
      if (tc.function && tc.function.arguments) acc[i].args += tc.function.arguments;
      progress.toolDelta(live, { name: acc[i].name, bytes: acc[i].args.length, index: i, calls: acc.filter(Boolean).length });
    }
  }
  for (const ev of inline.flush()) yield ev;
  const calls = acc.filter((t) => t && t.name).map((t) => ({ id: t.id, name: t.name, ...finishMod.parseArgs(t.args) }));
  if (calls.length) yield { type: 'tool_calls', calls };
  yield { type: 'finish', reason: finishMod.normalize(stopRaw), raw: stopRaw || null };
  yield { type: 'usage', ...usage };
}

// ---------------------------------------------------------------- entry -----

/** ONE FUNNEL, AND EVERY REQUEST THROUGH IT IS RECORDED. */
async function* chat(pc, messages, opts = {}) {
  if (pc && pc.credentialRef) { try { await require('./credentials').ensure(pc.credentialRef); } catch { /* resolve() reads it on demand */ } }   // THIS request's key, read without blocking — listings never decrypt one
  // THE ONE REQUEST ENVELOPE (modelrequest.js) — the same as a website source's; the protocol below is only the transport.
  const mr = require('./modelrequest');
  const env = mr.openApi(pc, messages, opts);
  // THE RECEIPT THIS ATTEMPT RETURNED, or null — the last `usage` event the provider streamed.
  let receipt = null;
  let toolCalls = 0;
  const timing = require('./reqtiming').start();   // the trace: effort on the wire, where the time went (F6)
  opts = { ...opts, wireOut: timing.wireOut };
  const stamp = () => require('./reqtiming').stamp(timing, env.rec, receipt);
  try {
    const inner = pc.protocol === PROTOCOL.MOCK
      ? require('./mockprovider').chat(pc, messages, opts)
      : pc.protocol === PROTOCOL.ANTHROPIC
        ? anthropicChat(pc, messages, opts)
        : pc.protocol === PROTOCOL.CHAT
          ? openaiChat(pc, messages, opts)
          : pc.protocol === PROTOCOL.RESPONSES
            ? require('./responsesapi').responsesChat(pc, messages, opts)
            : pc.protocol === PROTOCOL.RUNTIME ? require('./runtimeprovider').chat(pc, messages, { ...opts, app: opts.app || (pc.adapterCfg ? { cfg: pc.adapterCfg } : null) }) : null;
    if (!inner) {
      const e = new Error(`no protocol for provider '${pc.provider}'`);
      e.status = 400;
      throw e;
    }
    for await (const ev of inner) {
      require('./reqtiming').see(timing, ev);
      if (ev && ev.type === 'usage') receipt = ev;
      if (ev && ev.type === 'tool_calls' && Array.isArray(ev.calls)) toolCalls += ev.calls.length;
      yield ev;
    }
    stamp();
    mr.close(env, { ok: true, usage: receipt ? { ...receipt, toolCalls } : null });
  } catch (e) {
    stamp();
    mr.close(env, { ok: false, status: e && e.status, failure: (e && e.message) || 'failed', usage: receipt ? { ...receipt, toolCalls } : null });
    throw e;
  }
}

// `sseLines` is exported as a TEST SEAM, and for one specific question: does a Ctrl+C reach the socket while a stream is open?
module.exports = { PROTOCOL, resolve, chat, credentialHint, routeHeaders, classify: errors.classify, sseLines, toAnthropic, postSSE, openaiChat };
