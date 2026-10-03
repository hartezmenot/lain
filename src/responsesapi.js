'use strict';

/**
 * THE OPENAI RESPONSES API ADAPTER — provider.js's third wire protocol, kept in
 * its own file (provider.js is at the size guard). It shares provider.js's
 * transport (postSSE, sseLines) and yields the same normalized events.
 */

const finishMod = require('./finish');
const progress = require('./streamprogress');
const { routeHeaders } = require('./routeheaders');

/**
 * THE OPENAI RESPONSES API — the same events as `openaiChat`, so nothing above
 * this line knows which wire a turn used (no task orchestration is specific to
 * a vendor). Selected per connection: `protocol: 'responses'`.
 *
 * WHY IT EXISTS (2026-09-24). A reasoning model's EFFORT is a request field
 * here (`reasoning.effort`), and tool calling with reasoning is this API's
 * native shape. Chat Completions carries effort only as a catalog model-id
 * variant, and a route with no variants (gpt-6-luna) could not be given one.
 *
 *   system messages            → `instructions`
 *   user / assistant text      → input messages
 *   assistant tool_calls       → `function_call` items (call_id, name, arguments)
 *   tool results               → `function_call_output` items
 *
 * `store: false`: nothing is kept upstream; every request carries its whole
 * conversation, like the other two protocols. Usage is read from
 * `response.completed`; a cache figure the provider did not report stays
 * unreported (`cacheReported: false`), never 0.
 */
async function* responsesChat(pc, messages, opts) {
  const instructions = [];
  const input = [];
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => (b && (b.text || '')) || '').join('') : String(m.content || '');
    if (m.role === 'system') { if (text) instructions.push(text); continue; }
    if (m.role === 'tool') { input.push({ type: 'function_call_output', call_id: String(m.tool_call_id || ''), output: text }); continue; }
    if (m.role === 'assistant') {
      if (text) input.push({ role: 'assistant', content: text });
      for (const tc of m.tool_calls || []) {
        input.push({ type: 'function_call', call_id: String(tc.id), name: tc.name,
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) });
      }
      continue;
    }
    input.push({ role: 'user', content: text });
  }
  const payload = { model: pc.model, input, stream: true, store: false };
  if (instructions.length) payload.instructions = instructions.join('\n\n');
  const effort = pc.effort || pc.reasoningEffort || null;
  if (effort) payload.reasoning = { effort };
  if (opts && opts.wireOut) opts.wireOut.effort = effort || null;
  if (opts.tools && opts.tools.length) {
    payload.tools = opts.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
  }
  const { postSSE, sseLines } = require('./provider');
  const res = await postSSE(`${pc.baseUrl}/responses`, {
    authorization: `Bearer ${pc.apiKey}`, ...routeHeaders(pc, opts), ...pc.headers,
  }, payload, opts.signal, pc);

  const calls = new Map();   // output_index → { id, name, args }
  let stopRaw = null;
  let sawText = false;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheReported: false, reasoningTokens: null };
  const live = opts.live || null;
  for await (const j of sseLines(res, opts.signal, live)) {
    const t = j && j.type;
    if (t === 'response.output_text.delta' && j.delta) { sawText = true; yield { type: 'text', chunk: String(j.delta) }; continue; }
    if ((t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning_text.delta') && j.delta) { yield { type: 'reasoning', chunk: String(j.delta) }; continue; }
    if (t === 'response.output_item.added' && j.item && j.item.type === 'function_call') {
      calls.set(j.output_index, { id: j.item.call_id || j.item.id || `call_${j.output_index}`, name: j.item.name || '', args: j.item.arguments || '' });
      continue;
    }
    if (t === 'response.function_call_arguments.delta') {
      const c = calls.get(j.output_index);
      if (c) { c.args += String(j.delta || ''); progress.toolDelta(live, { name: c.name, bytes: c.args.length, index: j.output_index, calls: calls.size }); }
      continue;
    }
    if (t === 'response.output_item.done' && j.item && j.item.type === 'function_call') {
      // THE FINAL ITEM IS AUTHORITATIVE: arguments exactly as the model finished them.
      const c = calls.get(j.output_index) || {};
      calls.set(j.output_index, { id: j.item.call_id || c.id, name: j.item.name || c.name, args: typeof j.item.arguments === 'string' ? j.item.arguments : c.args || '' });
      continue;
    }
    if (t === 'response.output_item.done' && j.item && j.item.type === 'message' && !sawText) {
      // A route that sends the message whole, with no deltas.
      const whole = (j.item.content || []).map((p) => (p && p.type === 'output_text' ? p.text : '') || '').join('');
      if (whole) { sawText = true; yield { type: 'text', chunk: whole }; }
      continue;
    }
    if (t === 'response.completed' || t === 'response.incomplete' || t === 'response.failed') {
      const r = j.response || {};
      const u = r.usage || null;
      if (u) {
        usage.inputTokens = u.input_tokens || 0;
        usage.outputTokens = u.output_tokens || 0;
        const cached = u.input_tokens_details && u.input_tokens_details.cached_tokens;
        if (cached != null) { usage.cacheReadTokens = cached; usage.cacheReported = true; }
        // CACHE WRITES are their own figure where the provider states one (priced apart).
        const written = u.input_tokens_details && u.input_tokens_details.cache_write_tokens;
        if (written != null) usage.cacheCreationTokens = written;
        // THE EFFORT THE PROVIDER ACTUALLY RAN, which a route may override (observed:
        // `medium` asked, `max` served) — recorded, never assumed from the request.
        if (r.reasoning && r.reasoning.effort) usage.effortServed = r.reasoning.effort;
        const rt = u.output_tokens_details && u.output_tokens_details.reasoning_tokens;
        if (rt != null) usage.reasoningTokens = rt;
        yield { type: 'usage_live', ...usage };
      }
      if (t === 'response.failed') {
        const e = new Error(`response failed: ${(r.error && r.error.message) || 'no reason given'}`);
        e.status = 502;
        throw e;
      }
      stopRaw = t === 'response.incomplete' ? ((r.incomplete_details && r.incomplete_details.reason) === 'max_output_tokens' ? 'length' : 'content_filter') : null;
      continue;
    }
    if (t === 'error') {
      const e = new Error(`stream error: ${(j.error && j.error.message) || j.message || 'unknown'}`);
      e.status = (j.error && j.error.code === 'rate_limit_exceeded') ? 429 : 502;
      throw e;
    }
  }
  const out = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).filter((c) => c.name)
    .map((c) => ({ id: c.id, name: c.name, ...finishMod.parseArgs(c.args) }));
  if (out.length) yield { type: 'tool_calls', calls: out };
  if (!stopRaw) stopRaw = out.length ? 'tool_calls' : 'stop';
  yield { type: 'finish', reason: finishMod.normalize(stopRaw), raw: stopRaw };
  yield { type: 'usage', ...usage };
}


module.exports = { responsesChat };
