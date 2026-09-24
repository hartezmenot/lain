'use strict';
// Logging reverse proxy in front of LainRouter. Records, per request:
//   NNN-req.json    the exact body LAIN sent (headers: NOT recorded; auth never written)
//   NNN-res.raw     the exact bytes the router returned (SSE or JSON)
//   NNN-parsed.json the tool calls / text / finish reconstructed from those bytes
// mode 'forward' relays to the upstream; mode 'canned' answers locally (zero quota).
const http = require('http');
const fs = require('fs');
const path = require('path');

function parseSse(raw) {
  const out = { content: '', reasoningChars: 0, toolCalls: [], finish: null, usage: null, frames: 0 };
  const calls = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const line = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!line || line === '[DONE]') continue;
    let v; try { v = JSON.parse(line); } catch { continue; }
    out.frames++;
    if (v.usage) out.usage = v.usage;
    // THE RESPONSES API (typed events): text deltas, function-call items, the completed receipt.
    if (typeof v.type === 'string' && v.type.startsWith('response.')) {
      if (v.type === 'response.output_text.delta') out.content += v.delta || '';
      if (/reasoning/.test(v.type) && v.delta) out.reasoningChars += String(v.delta).length;
      if (v.type === 'response.output_item.done' && v.item && v.item.type === 'function_call') calls.push({ id: v.item.call_id, name: v.item.name, arguments: v.item.arguments });
      if (v.type === 'response.output_item.done' && v.item && v.item.type === 'reasoning') out.reasoningItems = (out.reasoningItems || 0) + 1;
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(v.type) && v.response) {
        out.usage = v.response.usage || out.usage;
        out.finish = v.type.slice(9);
        out.effort = v.response.reasoning || null;
        out.model = v.response.model || null;
      }
      continue;
    }
    for (const ch of v.choices || []) {
      const d = ch.delta || ch.message || {};
      if (typeof d.content === 'string') out.content += d.content;
      for (const k of ['reasoning', 'reasoning_content']) if (typeof d[k] === 'string') out.reasoningChars += d[k].length;
      for (const t of d.tool_calls || []) {
        const n = t.index != null ? t.index : calls.length;
        const c = calls[n] || (calls[n] = { id: '', name: '', arguments: '' });
        if (t.id) c.id = t.id;
        if (t.function && typeof t.function.name === 'string') c.name += t.function.name;
        if (t.function && typeof t.function.arguments === 'string') c.arguments += t.function.arguments;
      }
      if (ch.finish_reason) out.finish = ch.finish_reason;
    }
  }
  out.toolCalls = calls.filter(Boolean);
  return out;
}

function parseJson(raw) {
  try {
    const v = JSON.parse(raw);
    const m = (v.choices && v.choices[0] && v.choices[0].message) || {};
    return { content: m.content || '', toolCalls: (m.tool_calls || []).map((t) => ({ id: t.id, name: t.function && t.function.name, arguments: t.function && t.function.arguments })), finish: v.choices && v.choices[0] && v.choices[0].finish_reason, usage: v.usage || null };
  } catch { return { unparsed: true }; }
}

const CANNED_TEXT = 'DIAGNOSTIC CANNED REPLY.';
function cannedSse() {
  const id = 'canned';
  return [
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: CANNED_TEXT }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
    'data: [DONE]', '',
  ].join('\n\n');
}

function start({ dir, upstream = 'http://127.0.0.1:4570', mode = 'forward', cap = 30 }) {
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const isChat = req.method === 'POST' && /chat\/completions|\/responses/.test(req.url);
      if (!isChat) {
        // model listings etc. are not inference; answer/forward without counting
        if (mode === 'canned') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [] })); return; }
      }
      let idx = null;
      if (isChat) {
        n += 1; idx = String(n).padStart(3, '0');
        try { fs.writeFileSync(path.join(dir, `${idx}-req.json`), JSON.stringify(JSON.parse(body.toString('utf8')), null, 1)); } catch { fs.writeFileSync(path.join(dir, `${idx}-req.raw`), body); }
        if (n > cap) {
          const msg = JSON.stringify({ error: { message: `DIAGNOSTIC CAP ${cap} reached — request refused by the diagnostic proxy`, type: 'diagnostic_cap' } });
          fs.writeFileSync(path.join(dir, `${idx}-res.raw`), msg);
          log.push({ idx, refused: 'cap' });
          res.writeHead(400, { 'content-type': 'application/json' }); res.end(msg); return;
        }
      }
      if (mode === 'canned') {
        let stream = true; try { stream = JSON.parse(body.toString('utf8')).stream !== false; } catch { /* default */ }
        const out = stream ? cannedSse() : JSON.stringify({ id: 'canned', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: CANNED_TEXT }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        if (idx) { fs.writeFileSync(path.join(dir, `${idx}-res.raw`), out); log.push({ idx, canned: true }); }
        res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' }); res.end(out); return;
      }
      const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
      const t0 = Date.now();
      try {
        const up = await fetch(upstream + req.url, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
        const outHeaders = {}; up.headers.forEach((v, k) => { if (!['content-length', 'transfer-encoding', 'content-encoding', 'connection'].includes(k)) outHeaders[k] = v; });
        res.writeHead(up.status, outHeaders);
        const reader = up.body ? up.body.getReader() : null;
        const got = [];
        if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; got.push(Buffer.from(value)); res.write(value); }
        res.end();
        if (idx) {
          const raw = Buffer.concat(got);
          fs.writeFileSync(path.join(dir, `${idx}-res.raw`), raw);
          const text = raw.toString('utf8');
          const ct = String(up.headers.get('content-type') || '');
          const parsed = ct.includes('event-stream') ? parseSse(text) : parseJson(text);
          parsed.status = up.status; parsed.ms = Date.now() - t0;
          fs.writeFileSync(path.join(dir, `${idx}-parsed.json`), JSON.stringify(parsed, null, 1));
          log.push({ idx, status: up.status, ms: parsed.ms, finish: parsed.finish, tools: (parsed.toolCalls || []).map((c) => c.name) });
        }
      } catch (e) {
        if (idx) log.push({ idx, error: String(e.message) });
        try { res.writeHead(502); res.end(JSON.stringify({ error: { message: `diagnostic proxy: ${e.message}` } })); } catch { /* closed */ }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, count: () => n, log,
    close: () => new Promise((r) => server.close(() => r())),
  })));
}

module.exports = { start, parseSse, parseJson };
