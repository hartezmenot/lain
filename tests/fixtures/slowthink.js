'use strict';

/**
 * A FAKE OPENAI-COMPATIBLE SERVER that thinks slowly, the shape GLM 5.3 on Z.ai streams: `reasoning_content` for
 * SLOWTHINK_MS, then the answer text. It logs every request's byte counts — `tools`, `system`, the effort sent — to
 * SLOWTHINK_LOG (one JSON line per request), so a test can measure what LAIN actually put on the wire.
 *
 *   node slowthink.js <port-file>       prints nothing; writes the port it bound to <port-file>
 *   SLOWTHINK_MS=8000                   how long to think (default 6000)
 *   SLOWTHINK_FIRST_BYTE_MS=1500        silence before the first byte (default 1200)
 *   SLOWTHINK_TOOL=1                    narration → read_file → answer
 *   SLOWTHINK_TOOL=2                    narration → read_file → narration → shell (with a description) → answer
 */

const http = require('http');
const fs = require('fs');

const portFile = process.argv[2];
const thinkMs = Number(process.env.SLOWTHINK_MS || 6000);
const firstByteMs = Number(process.env.SLOWTHINK_FIRST_BYTE_MS || 1200);
const log = process.env.SLOWTHINK_LOG || null;

const sse = (res, obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THOUGHT = 'The person wants me to look at the project. First I should understand the layout of the files, '
  + 'then decide which file matters.\nI will check the package file to see the scripts.\nThen I can answer briefly. ';

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) { res.writeHead(404); res.end(); return; }
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', async () => {
    const body = JSON.parse(b || '{}');
    const sys = (body.messages || []).find((m) => m.role === 'system');
    if (log) {
      fs.appendFileSync(log, `${JSON.stringify({
        at: Date.now(), tools: body.tools ? Buffer.byteLength(JSON.stringify(body.tools)) : 0, toolCount: (body.tools || []).length,
        toolNames: (body.tools || []).map((t) => t.function && t.function.name), system: sys ? Buffer.byteLength(String(sys.content)) : 0,
        systemHash: sys ? require('crypto').createHash('sha256').update(String(sys.content)).digest('hex').slice(0, 16) : '',
        toolsHash: require('crypto').createHash('sha256').update(JSON.stringify(body.tools || [])).digest('hex').slice(0, 16),
        effort: body.reasoning_effort || null, messages: (body.messages || []).length,
      })}\n`);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let closed = false;
    res.on('close', () => { closed = true; });
    await sleep(firstByteMs);
    const afterTool = (body.messages || []).some((m) => m.role === 'tool');
    const start = Date.now();
    let i = 0;
    while (!closed && Date.now() - start < thinkMs) {
      const word = THOUGHT.split(' ')[i % THOUGHT.split(' ').length];
      sse(res, { choices: [{ delta: { reasoning_content: `${word} ` } }] });
      i += 1;
      await sleep(60);
    }
    if (closed) return;
    const tools = (body.messages || []).filter((m) => m.role === 'tool').length;
    if (process.env.SLOWTHINK_TOOL === '2' && tools === 1) {
      sse(res, { choices: [{ delta: { content: 'Now I will run the test script to see what it prints.' } }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'shell', arguments: JSON.stringify({ command: 'node -v', description: 'print the node version' }) } }] } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 900, completion_tokens: 40 } });
    } else if (process.env.SLOWTHINK_TOOL && process.env.SLOWTHINK_TOOL !== '0' && !afterTool) {
      sse(res, { choices: [{ delta: { content: 'Let me read the package file first.' } }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'package.json' }) } }] } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 900, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: i } } });
    } else {
      for (const w of 'SLOWTHINK_ANSWER The project is small and has one script.'.split(' ')) { sse(res, { choices: [{ delta: { content: `${w} ` } }] }); await sleep(30); }
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: i } } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// IT LEAVES BY ITSELF after SLOWTHINK_IDLE_MS without a request (default 90 s), so a test can never orphan it.
let idle = null;
const rearm = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), Number(process.env.SLOWTHINK_IDLE_MS || 90000)); };
server.on('request', rearm);
server.listen(0, '127.0.0.1', () => { fs.writeFileSync(portFile, String(server.address().port)); rearm(); });
