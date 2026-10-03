'use strict';

/** MAKING THE REPLAYED TRANSCRIPT FREE, ON THE ROUTE WHERE IT IS NOT. */

/** Model families whose caching must be asked for by hand. */
const EXPLICIT = /claude|sonnet|opus|haiku/i;

/** Does this route need `cache_control` spelled out? */
function needsExplicitCache(pc, cfg = {}) {
  // The resolved provider carries the override when one was configured;
  // `cfg` is accepted too so a caller that has one can pass it directly.
  const forced = (pc && pc.promptCache !== undefined) ? pc.promptCache : (cfg && cfg.promptCache);
  if (forced === false) return false;
  if (forced === true) return true;
  // The anthropic protocol has its own handling in provider.js and must not be
  // marked twice; there are only four breakpoints per request to spend.
  if (pc && pc.protocol === 'anthropic') return false;
  // OFF BY DEFAULT, BECAUSE IT WAS MEASURED AND IT DID NOTHING
  return false;
}

/** Lift a message's content into the one block that can carry the marker. */
function mark(msg) {
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

/** Place the breakpoints on an OpenAI-shaped message array. */
function applyToChat(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = messages.slice();

  const sys = out.findIndex((m) => m && m.role === 'system');
  if (sys >= 0) out[sys] = mark(out[sys]);

  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!m || m.role === 'tool' || m.role === 'system') continue;
    if (!m.content || (Array.isArray(m.content) && !m.content.length)) continue;
    out[i] = mark(m);
    break;
  }
  return out;
}

/** What an OpenAI-shaped endpoint said about caching. */
function usageFrom(u) {
  if (!u || typeof u !== 'object') return { cacheReadTokens: 0, cacheCreationTokens: 0, reported: false };
  const d = u.prompt_tokens_details || u.input_tokens_details || {};
  const read = d.cached_tokens || u.cached_tokens || u.cache_read_input_tokens || 0;
  const made = d.cache_creation_tokens || u.cache_creation_input_tokens || 0;
  // WHETHER THE PROVIDER SAID ANYTHING ABOUT CACHING AT ALL. A receipt with no
  // cache field is "not reported", which is not "cached = 0" (reqtrace.end).
  const reported = [d.cached_tokens, u.cached_tokens, u.cache_read_input_tokens, d.cache_creation_tokens, u.cache_creation_input_tokens].some((v) => v != null);
  // REASONING AS THE PROVIDER COUNTED IT (completion_tokens_details / output_tokens_details) — part of the output,
  // reported apart so a receipt can say `reasoning 7.4k`. Absent stays absent: never estimated from text.
  const r = (u.completion_tokens_details || u.output_tokens_details || {}).reasoning_tokens;
  return { cacheReadTokens: Number(read) || 0, cacheCreationTokens: Number(made) || 0, reported, ...(Number.isFinite(r) ? { reasoningTokens: r } : {}) };
}

module.exports = { needsExplicitCache, applyToChat, usageFrom, mark, EXPLICIT };
