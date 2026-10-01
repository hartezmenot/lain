'use strict';

/**
 * A FAKE llama-server for tests: the command line LAIN passes (-m, --port, -a,
 * -c, --mmproj …), /health (503 while "loading", then 200), and an
 * OpenAI-compatible /v1/chat/completions stream with llama.cpp-style `timings`.
 *
 * FAKE_LLAMA_MODE=good     follows instructions, calls tools, continues from results
 * FAKE_LLAMA_MODE=notools  answers in text only (an Agent test must not pass)
 * FAKE_LLAMA_ARGS=<file>   records the argv it was started with
 */

const http = require('http');
const fs = require('fs');

const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stderr.write('version: 1234 (abcdef0)\nbuilt with a test\n'); process.exit(0); }
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const port = Number(arg('--port'));
const alias = arg('-a') || 'fake';
const mode = process.env.FAKE_LLAMA_MODE || 'good';
if (process.env.FAKE_LLAMA_ARGS) fs.writeFileSync(process.env.FAKE_LLAMA_ARGS, JSON.stringify(argv));
if (process.env.FAKE_LLAMA_FAIL) { process.stderr.write('error: unknown model architecture: limite\n'); process.exit(1); }
const loadedAt = Date.now() + Number(process.env.FAKE_LLAMA_LOAD_MS || 300);

function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

function reply(body) {
  const msgs = body.messages || [];
  const last = msgs[msgs.length - 1] || {};
  const text = String(last.content || '');
  const hasTools = Array.isArray(body.tools) && body.tools.length;
  if (last.role === 'tool') return { text: mode === 'good' ? `The secret word is ${/PAPAYA/.test(text) ? 'PAPAYA' : '?'}.` : 'I read a file.' };
  if (/exactly the single word READY/.test(text)) return { text: 'READY' };
  if (hasTools && /read_file tool/.test(text) && mode === 'good') return { call: { name: 'read_file', args: JSON.stringify({ path: 'notes.txt' }) } };
  const code = /access code is (ORCHID-[A-Z0-9]+)/i.exec(text);
  if (code) return { text: code[1] };
  if (/Count slowly/.test(text)) return { text: Array.from({ length: 200 }, (_, i) => `${i + 1}\n`).join(''), slow: true };
  return { text: `Hello from ${alias}.` };
}

http.createServer((req, res) => {
  if (req.url === '/health') {
    if (Date.now() < loadedAt) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"code":503,"message":"Loading model"}}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return;
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', async () => {
      const body = JSON.parse(b);
      const r = reply(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let closed = false;
      res.on('close', () => { closed = true; });
      if (r.call) {
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: r.call.name, arguments: r.call.args } }] } }] });
        sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        const chunks = r.slow ? r.text.match(/[\s\S]{1,4}/g) : [r.text];
        for (const c of chunks) {
          if (closed) return;
          sse(res, { choices: [{ delta: { content: c } }] });
          // eslint-disable-next-line no-await-in-loop
          if (r.slow) await new Promise((x) => setTimeout(x, 20));
        }
        sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      sse(res, { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 }, timings: { prompt_n: 42, prompt_ms: 120.5, prompt_per_second: 348.5, predicted_n: 7, predicted_ms: 70, predicted_per_second: 100, cache_n: 0 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
