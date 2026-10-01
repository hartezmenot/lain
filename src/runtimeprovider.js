'use strict';

/**
 * THE 'runtime' PROTOCOL — provider.chat's transport for local and runtime
 * models. Same event vocabulary as every other protocol (text, reasoning,
 * tool_calls, finish, usage), inside the same modelrequest envelope, so a
 * request to a local model is identified, traced, cancellable and counted
 * like any other.
 *
 *   llamacpp      ensure the owned llama-server for this model (reuse a healthy
 *                 one; a controlled switch otherwise), then its OpenAI-compatible
 *                 endpoint — with llama.cpp's own `timings` kept as local metrics
 *   ollama        Ollama's /api/chat (its own durations and counts)
 *   claude-code   the Claude Code program (runtimechat → claude -p, no tools)
 *   opencode      the OpenCode program (opencode run, plan agent)
 *   zcode         the ZCode runtime (workspace/generateText)
 *   codex         one native Codex account (codex exec in its own home — drivers/codexexec.js)
 */

async function* llamaChat(pc, messages, opts) {
  const llamacpp = require('./local/llamacpp');
  const ready = await llamacpp.ensure(opts.app || null, pc.model, { signal: opts.signal });
  if (!ready.ok) { const e = new Error(`llama.cpp: ${ready.why}`); e.status = 503; throw e; }
  const s = ready.server;
  const done = llamacpp.begin(pc.model);
  try {
    const provider = require('./provider');
    const inner = provider.openaiChat({ ...pc, protocol: 'chat', baseUrl: s.baseUrl, model: s.model, apiKey: 'local', headers: {} }, messages, opts);
    for await (const ev of inner) {
      if (ev && ev.type === 'usage') {
        const t = ev.timings || null;
        const local = { runtime: 'llama.cpp', server: { port: s.port, pid: s.pid, ctx: s.ctx, reused: ready.reused } };
        // THE MODEL LOAD this request waited for (a reused server loads nothing).
        if (!ready.reused && s.readyAt && s.startedAt) local.loadMs = s.readyAt - s.startedAt;
        if (t) {
          local.promptTokens = Number.isFinite(t.prompt_n) ? t.prompt_n : null;
          local.genTokens = Number.isFinite(t.predicted_n) ? t.predicted_n : null;
          local.promptMs = Number.isFinite(t.prompt_ms) ? Math.round(t.prompt_ms) : null;
          local.genMs = Number.isFinite(t.predicted_ms) ? Math.round(t.predicted_ms) : null;
          local.tokPerSec = Number.isFinite(t.predicted_per_second) ? Math.round(t.predicted_per_second * 10) / 10 : null;
          local.promptTokPerSec = Number.isFinite(t.prompt_per_second) ? Math.round(t.prompt_per_second * 10) / 10 : null;
          local.cachedTokens = Number.isFinite(t.cache_n) ? t.cache_n : null;
        }
        const { timings, ...rest } = ev;
        // NO PROVIDER CACHE: llama.cpp's prompt reuse (cache_n) is a local fact, kept in `local`, never as provider cache.
        yield { ...rest, cacheReadTokens: 0, cacheCreationTokens: 0, cacheReported: false, local };
        continue;
      }
      yield ev;
    }
  } finally { done(); }
}

async function* chat(pc, messages, opts = {}) {
  switch (pc.runtime) {
    case 'llamacpp': yield* llamaChat(pc, messages, opts); return;
    case 'ollama': yield* require('./local/ollama').chat(pc, messages, opts); return;
    case 'claude-code': yield* require('./drivers/claudecode').chat(pc, messages, opts); return;
    case 'opencode': yield* require('./drivers/opencoderun').chat(pc, messages, opts); return;
    case 'zcode': yield* require('./drivers/zcoderun').chat(pc, messages, opts); return;
    case 'codex': yield* require('./drivers/codexexec').chat(pc, messages, opts); return;
    case 'antigravity': yield* require('./drivers/antigravity').chat(pc, messages, opts); return;
    default: { const e = new Error(`no runtime adapter for '${pc.runtime}'`); e.status = 400; throw e; }
  }
}

module.exports = { chat };
