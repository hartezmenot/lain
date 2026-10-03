'use strict';

/** A FAKE `opencode` for tests: --version, models, auth list, session list/export, run --format json. */

const fs = require('fs');

const argv = process.argv.slice(2);
if (process.env.FAKE_OPENCODE_ARGS) fs.appendFileSync(process.env.FAKE_OPENCODE_ARGS, `${JSON.stringify(argv)}\n`);
const w = (s) => process.stdout.write(s);

if (argv[0] === '--version') { w('opencode v9.0.0\n'); process.exit(0); }
if (argv[0] === 'models') {
  w(['opencode/big-pickle', 'opencode/mimo-v2.6-flash-free', 'opencode-free/qwen3.6-plus-free', 'opencode-go/glm-5.3', 'opencode/gpt-6-luna', 'mylocal/some-model'].join('\n') + '\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'list') { w('OpenCode Go   API key                     stored\nmylocal       API key                     stored\n'); process.exit(0); }
if (argv[0] === 'session' && argv[1] === 'list') { w(JSON.stringify([{ id: 'ses_1', title: 'one', time: { updated: 1 } }])); process.exit(0); }
if (argv[0] === 'session' && argv[1] === 'export') {
  w(JSON.stringify({ info: { id: argv[2], model: { id: 'big-pickle', providerID: 'opencode' }, cost: 0, tokens: { input: 300, output: 12, reasoning: 4, cache: { read: 50, write: 0 } }, outcome: 'succeeded' }, messages: [] }));
  process.exit(0);
}
if (argv[0] === 'serve') serve();
else if (argv[0] === 'run') {
  const msg = argv[argv.length - 1];
  const sid = 'ses_fake1';
  if (argv.includes('--agent')) {
    // plan agent: text only
  } else w(`${JSON.stringify({ type: 'tool_use', sessionID: sid, part: { type: 'tool', tool: 'edit', callID: 'c1', state: { input: { path: 'a.js' } } } })}\n`);
  w(`${JSON.stringify({ type: 'text', sessionID: sid, part: { type: 'text', text: `OpenCode says: ${String(msg).split('\n').pop().slice(0, 40)}` } })}\n`);
  process.exit(0);
} else if (argv[0] !== 'serve') process.exit(2);

/**
 * `opencode serve` — the v2 API shape the bridge uses: Basic auth (opencode:$OPENCODE_SERVER_PASSWORD),
 * /api/info, /api/model (empty on the first call, like the real one while it loads), /api/session,
 * /api/session/:id(/prompt|/interrupt|/message), /api/event (SSE). The FREE-TIER RULE is modelled:
 * a free model in a session whose permissions deny EVERYTHING is refused, as OpenCode refuses it.
 * A prompt containing SLOW streams slowly; the build agent without chat denials emits a tool event.
 */
function serve() {
  const http = require('http');
  const port = Number(argv[argv.indexOf('--port') + 1]);
  const pw = process.env.OPENCODE_SERVER_PASSWORD || 'none';
  const good = `Basic ${Buffer.from(`opencode:${pw}`).toString('base64')}`;
  let modelCalls = 0;
  const sessions = new Map(); const listeners = new Set();
  const emit = (e) => { for (const res of listeners) res.write(`data: ${JSON.stringify(e)}\n\n`); };
  const MODELS = [{ id: 'big-pickle', providerID: 'opencode', name: 'Big Pickle', capabilities: { tools: true, input: ['text'] } }, { id: 'space-bunny-free', providerID: 'opencode-go', name: 'Space Bunny Free', capabilities: { tools: true, input: ['text', 'image'] } }, { id: 'glm-5.3', providerID: 'opencode-go', name: 'GLM 5.3', capabilities: { tools: true, input: ['text'] } }];
  http.createServer((req, res) => {
    if (req.headers.authorization !== good) { res.writeHead(401); res.end(); return; }
    const u = new URL(req.url, 'http://x');
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', async () => {
      const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const body = b ? JSON.parse(b) : {};
      const m = /^\/api\/session\/([^/]+)(\/(prompt|interrupt|message))?$/.exec(u.pathname);
      if (u.pathname === '/api/info') return json({ data: { version: '9.0.0' } });
      if (u.pathname === '/api/provider') return json({ data: [{ id: 'opencode', settings: { apiKey: 'public-SHOULD-NEVER-BE-READ' } }] });
      if (u.pathname === '/api/model') return json({ data: ++modelCalls > 1 ? MODELS.map((x) => ({ ...x, modelID: x.id })) : [] });
      if (u.pathname === '/api/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ type: 'server.connected' })}\n\n`); listeners.add(res); res.on('close', () => listeners.delete(res)); return undefined; }
      if (u.pathname === '/api/session' && req.method === 'GET') return json({ data: [...sessions.values()].map((s) => ({ id: s.id, title: s.title, time: { updated: 1 }, model: s.model, location: { directory: s.dir }, outcome: s.outcome })) });
      if (u.pathname === '/api/session' && req.method === 'POST') {
        const id = `ses_${Math.random().toString(36).slice(2, 10)}`;
        const s = { id, title: body.title, agent: body.agent, model: body.model, permissions: body.permissions || [], dir: body.location && body.location.directory, outcome: null, messages: [], tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
        sessions.set(id, s);
        if (process.env.FAKE_OPENCODE_SESSIONS) fs.appendFileSync(process.env.FAKE_OPENCODE_SESSIONS, `${JSON.stringify({ id, agent: s.agent, model: s.model, permissions: s.permissions, dir: s.dir })}\n`);
        return json({ data: { id, agent: s.agent, model: s.model } });
      }
      if (m && m[3] === 'prompt') {
        const s = sessions.get(m[1]);
        json({ data: { id: 'msg_u', type: 'user' } });
        s.messages.push({ type: 'user', text: body.text });
        const denyAll = s.permissions.some((p) => p.action === '*' && p.effect === 'deny');
        const free = /-free$|big-pickle/.test((s.model && s.model.id) || '');
        const sid = s.id; const D = (data) => ({ ...data, sessionID: sid });
        emit({ type: 'session.execution.started', data: D({}) });
        if (free && denyAll) { s.outcome = 'failed'; s.messages.push({ type: 'assistant', content: [], error: { type: 'provider.auth', message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode", status: 403 } }); emit({ type: 'session.execution.failed', data: D({}) }); return undefined; }
        const chat = s.permissions.some((p) => p.action === 'edit' && p.effect === 'deny');
        if (!chat) emit({ type: 'session.tool.started', data: D({ tool: 'edit', input: { filePath: 'a.js' } }) });
        // THE VERIFICATION PROBES: a plain READY; and real work — a file — only when the agent may edit.
        const want = /containing exactly the text (\S+)/.exec(body.text);
        if (want && !chat && s.dir && !/bad-agent/.test((s.model && s.model.id) || '')) fs.writeFileSync(require('path').join(s.dir, 'notes.txt'), want[1].replace(/\.$/, ''));
        if (/single word READY/.test(body.text)) { emit({ type: 'session.text.delta', data: D({ delta: 'READY' }) }); s.tokens = { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }; emit({ type: 'session.usage.updated', data: D({ tokens: s.tokens, cost: 0 }) }); s.outcome = 'succeeded'; emit({ type: 'session.execution.succeeded', data: D({}) }); return undefined; }
        const text = /SLOW/.test(body.text) ? Array.from({ length: 60 }, (_, i) => `n${i} `) : [`OpenCode (${(s.model && s.model.id) || 'default'}) says: `, String(body.text).split('\n').pop().slice(0, 40)];
        for (const t of text) {
          if (s.outcome === 'interrupted') return undefined;
          emit({ type: 'session.text.delta', data: D({ delta: t }) });
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, /SLOW/.test(body.text) ? 60 : 5));
        }
        s.tokens = { input: 900, output: 12, reasoning: 3, cache: { read: 200, write: 0 } };
        s.messages.push({ type: 'assistant', content: [{ type: 'text', text: text.join('') }] });
        emit({ type: 'session.usage.updated', data: D({ tokens: s.tokens, cost: 0 }) });
        s.outcome = 'succeeded';
        emit({ type: 'session.execution.succeeded', data: D({}) });
        return undefined;
      }
      if (m && m[3] === 'interrupt') { const s = sessions.get(m[1]); if (s) { s.outcome = 'interrupted'; emit({ type: 'session.execution.interrupted', data: { sessionID: s.id } }); } return json({ interrupted: true }); }
      if (m && m[3] === 'message') { const s = sessions.get(m[1]); return json({ data: s ? [...s.messages].reverse() : [] }); }
      if (m) { const s = sessions.get(m[1]); return json({ data: s ? { id: s.id, outcome: s.outcome, tokens: s.tokens, cost: 0 } : null }); }
      return json({ message: 'not found' }, 404);
    });
  }).listen(port, '127.0.0.1');
}
