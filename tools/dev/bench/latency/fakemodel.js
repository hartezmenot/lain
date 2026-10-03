'use strict';

/**
 * A ZERO-LATENCY OPENAI-COMPATIBLE MODEL, for measuring what NOEMA adds.
 *
 * Answers `/v1/chat/completions` (SSE) and `/v1/models` immediately. Whatever time a request spends between
 * "submit" and "this server saw it", or between "this server finished" and "Noema finished", is Noema's — the
 * model contributes ~0 ms. Every request is logged with `performance.now()` so an in-process bench shares the
 * clock with the code it measures.
 *
 * Scenarios (chosen per request from the conversation, so one server serves every case):
 *   - last message is the user's and contains TOOL:<name> <json>  → one tool call, then (after the tool result) "done"
 *   - otherwise                                                   → "OK"
 */

const http = require('http');
const { performance } = require('perf_hooks');

function sse(res, chunks, usage) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  if (usage) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
}

function textChunks(text) {
  return [
    { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
    { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text } }] },
    { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
}

function toolChunks(name, args) {
  return [
    { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name, arguments: '' } }] } }] },
    { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
    { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

function textOf(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => (p && (p.text || '')) || '').join('');
  return '';
}

function start({ port = 0, delayMs = 0 } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    const arrived = performance.now();
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const parsed = (() => { try { return JSON.parse(body || '{}'); } catch { return {}; } })();
      const entry = { url: req.url, arrived, bytes: Buffer.byteLength(body), tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0, toolBytes: parsed.tools ? JSON.stringify(parsed.tools).length : 0, messages: Array.isArray(parsed.messages) ? parsed.messages.length : 0 };
      log.push(entry);
      const finish = () => {
        if (/\/models$/.test(req.url)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'bench-model', object: 'model' }] }));
          entry.sent = performance.now();
          return;
        }
        const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
        const last = msgs[msgs.length - 1] || {};
        const usage = { prompt_tokens: Math.round(entry.bytes / 4), completion_tokens: 3, total_tokens: Math.round(entry.bytes / 4) + 3 };
        // The ask is the LAST user message carrying TOOL:; once any tool result follows it, the task is done.
        let ask = -1;
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !/^<(lain|noema)-/.test(textOf(msgs[i])) && /TOOL:\w+/.test(textOf(msgs[i]))) { ask = i; break; }
        const answered = ask >= 0 && msgs.slice(ask + 1).some((x) => x.role === 'tool' || (x.role === 'assistant' && x.tool_calls));
        const m = ask >= 0 && !answered ? /TOOL:(\w+)\s+(\{.*?\})/s.exec(textOf(msgs[ask])) : null;
        if (m) sse(res, toolChunks(m[1], JSON.parse(m[2])), usage);
        else sse(res, textChunks(answered ? 'done' : 'OK'), usage);
        void last;
        if (process.env.FAKE_DUMP) process.stderr.write(`${JSON.stringify(msgs.map((x) => [x.role, textOf(x).slice(0, 80), Boolean(x.tool_calls)]))}\n`);
        entry.sent = performance.now();
      };
      if (delayMs) setTimeout(finish, delayMs); else finish();
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({ port: server.address().port, log, close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }) });
  }));
}

module.exports = { start };

if (require.main === module) {
  start({ port: Number(process.argv[2]) || 0 }).then((s) => process.stdout.write(`fake model on ${s.port}\n`));
}
