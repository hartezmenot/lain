'use strict';

/**
 * LAIN AS A LOCAL MODEL SERVER — `lain --serve` (Phase 8.1).
 *
 *     external client (Cursor, Continue, a script …)
 *        │  OpenAI-compatible  POST /v1/chat/completions · GET /v1/models
 *        │  Anthropic-compatible POST /v1/messages (text and tools)
 *        ▼
 *     this server ── provider.chat ── modelrequest (the ONE envelope: trace,
 *        │                           usage receipt, origin "serve")
 *        ▼
 *     the LAIN connection / account / runtime the alias names
 *
 * THE PROVIDER'S SECRETS NEVER LEAVE LAIN. A client authenticates to LAIN with
 * a LOCAL LAIN access token (kept in the Windows secret store); the upstream
 * key is resolved inside LAIN at send time and is never in a response, a
 * header or a log.
 *
 * LOOPBACK BY DEFAULT (127.0.0.1). Listening on any other address needs
 * `server.allowRemote` set explicitly, and says so.
 *
 * LOGICAL ROUTES (Phase 8.3): `lain/<provider>/<model>` — `lain/codex/gpt-6-sol`,
 * `lain/claude/opus` — for every model of every provider family in LAIN's one
 * intelligence fabric (or only those in `server.expose`). The provider family's
 * ACCOUNT POLICY chooses the backing account underneath, exactly as it does for a
 * session; a client never names, and is never shown, an OAuth identity. With
 * `server.pinnable: true` an advanced client may append `@<account alias>` to use
 * one named backing account. The older `lain/<model>` aliases still resolve.
 * An OpenAI `reasoning_effort` is honoured only when the model declares that level.
 *
 * NOT A SECOND ROUTER AND NOT A STATE OWNER: no sessions, no tools of LAIN's
 * are run for the client; a request in is one model request out, recorded.
 */

const http = require('http');
const crypto = require('crypto');

const DEFAULTS = Object.freeze({ host: '127.0.0.1', port: 20790, startWithLain: false, expose: 'all', allowRemote: false });
const TOKEN_REF = 'cred:lain-serve:token';
const LOOPBACK = /^(127\.0\.0\.1|localhost|::1)$/;
const MAX_BODY = 8 * 1024 * 1024;

let running = null;   // { server, host, port, startedAt, requests, app }

function root(app) { return (app && app._sibling) || app; }
function cfgOf(app) { const r = root(app); return (r && r.cfg) || {}; }
function settings(app) { return { ...DEFAULTS, ...(cfgOf(app).server || {}) }; }

// ---- the local access token ----------------------------------------------------------
function token({ create = true } = {}) {
  const creds = require('./credentials');
  let t = creds.resolve(TOKEN_REF);
  if (!t && create) {
    t = `lain_${crypto.randomBytes(24).toString('base64url')}`;
    const r = creds.store(TOKEN_REF, t, { kind: 'token' });
    if (!r.ok) throw new Error(r.why || 'the secret store refused the token');
  }
  return t || null;
}
function regenerate() { require('./credentials').remove(TOKEN_REF); return token({ create: true }); }
function tokenInfo() { const d = require('./credentials').describe(TOKEN_REF); return { present: Boolean(d && d.present), masked: d ? d.masked : null }; }
function authorized(req) {
  const want = token({ create: false });
  if (!want) return false;
  const h = String(req.headers.authorization || '');
  const got = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-api-key'] || '');
  const a = Buffer.from(got); const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- aliases ------------------------------------------------------------------------
function catalog(app) { return require('./appcatalog').catalog(root(app)); }
/** A provider family's name in a route: its id, or (an API source) its label as a slug. */
function familySlug(f) { return f.id.startsWith('api:') ? String(f.label).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '') : f.id; }
/** THE LOGICAL ROUTES — lain/<provider>/<model>, one per model of every provider family. */
function familyAliases(app) {
  const s = settings(app);
  const exposeList = Array.isArray(s.expose) ? new Set(s.expose.map(String)) : null;
  const out = [];
  for (const f of require('./fabric/index').families(app)) {
    if (!f.accounts.some((a) => a.usable)) continue;
    for (const m of f.models) {
      const alias = `lain/${familySlug(f)}/${m.id}`;
      if (exposeList && !exposeList.has(alias)) continue;
      out.push({ alias, family: f.id, model: m.id, efforts: m.efforts, context: null });
    }
  }
  return out;
}
function aliases(app) {
  const s = settings(app);
  const cat = catalog(app);
  const exposeList = Array.isArray(s.expose) ? new Set(s.expose.map(String)) : null;
  const legacy = cat.models.filter((m) => !exposeList || exposeList.has(`lain/${m.id}`) || exposeList.has(m.id)).map((m) => ({ alias: `lain/${m.id}`, model: m.id, context: m.ctx || null }));
  return [...familyAliases(app), ...legacy];
}
/**
 * AN ALIAS → the provider request. A logical route resolves through the family's
 * policy (the same resolver a session uses); `effort` must be a level the model declares.
 */
function resolveAlias(app, name, { effort = null } = {}) {
  const raw = String(name || '');
  const [route, pin] = raw.split('@');
  const fam = familyAliases(app).find((a) => a.alias === route);
  if (fam) {
    const F = require('./fabric/index');
    const f = F.family(app, fam.family);
    const m = f && f.byModel.get(fam.model);
    if (!m) return null;
    const caps = require('./fabric/effortcaps');
    const e = effort ? caps.norm(effort) : null;
    if (effort && (!e || !m.efforts.includes(e))) return { refused: `${m.label} ${m.efforts.length ? `offers ${m.efforts.map(caps.label).join(', ')}` : 'has no configurable effort'}` };
    let acct = null;
    if (pin) {
      // AN EXPLICIT BACKING ACCOUNT — only when configured, and only by the alias the person gave it.
      if (settings(app).pinnable !== true) return { refused: 'this Noema does not expose account pinning (server.pinnable)' };
      acct = f.accounts.find((a) => a.alias && a.alias.toLowerCase() === pin.toLowerCase()) || null;
      if (!acct) return { refused: `no account alias "${pin}" on ${f.label}` };
    } else {
      const r = require('./fabric/policy').resolve(app, { family: f.id, model: m.id, effort: e });
      if (!r.ok) return { refused: r.why };
      acct = r.account;
    }
    const x = m.accounts.find((a) => a.id === acct.id);
    if (!x) return { refused: `that account does not serve ${m.label}` };
    const pc = require('./provider').resolve({ ...cfgOf(app), model: x.catalogId, connection: x.route, account: acct.id, family: f.id, effort: e || undefined, _evidence: root(app).connectionEvidence });
    if (!pc || !pc.protocol || pc.unavailable) return null;
    return pc;
  }
  const id = raw.replace(/^lain\//, '');
  const list = aliases(app);
  if (!list.some((a) => a.model === id && !a.family)) return null;
  const pc = require('./provider').resolve({ ...cfgOf(app), model: id, connection: null, _evidence: root(app).connectionEvidence });
  if (!pc || !pc.protocol || pc.unavailable) return null;
  return pc;
}

// ---- wire conversions ---------------------------------------------------------------
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && (p.type === 'text' || p.type === 'input_text') ? p.text : '')).join('');
  return String(content == null ? '' : content);
}
function fromOpenAI(body) {
  const messages = (body.messages || []).map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: textOf(m.content) };
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) return { role: 'assistant', content: textOf(m.content), tool_calls: m.tool_calls.map((t) => ({ id: t.id, name: t.function && t.function.name, arguments: t.function && t.function.arguments })) };
    return { role: m.role === 'developer' ? 'system' : m.role, content: textOf(m.content) };
  });
  const tools = (body.tools || []).filter((t) => t && t.type === 'function' && t.function).map((t) => ({ name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } }));
  return { messages, tools };
}
function fromAnthropic(body) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: textOf(Array.isArray(body.system) ? body.system : String(body.system)) });
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    const parts = Array.isArray(m.content) ? m.content : [];
    const results = parts.filter((p) => p.type === 'tool_result');
    for (const r of results) messages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: textOf(r.content) });
    const uses = parts.filter((p) => p.type === 'tool_use');
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
    if (uses.length) messages.push({ role: 'assistant', content: text, tool_calls: uses.map((u) => ({ id: u.id, name: u.name, arguments: JSON.stringify(u.input || {}) })) });
    else if (text || !results.length) messages.push({ role: m.role, content: text });
  }
  const tools = (body.tools || []).map((t) => ({ name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } }));
  return { messages, tools };
}

async function* run(app, pc, messages, tools, signal) {
  const opts = { tools: tools.length ? tools : undefined, signal, origin: 'serve', role: 'external', trace: { reason: 'serve' }, maxTokens: undefined };
  yield* require('./provider').chat(pc, messages, opts);
}

// ---- HTTP ----------------------------------------------------------------------------
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function error(res, code, message, type = 'invalid_request_error') { send(res, code, { error: { message: require('./redact').text(String(message)), type } }); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('the body is not JSON')); } });
    req.on('error', reject);
  });
}

async function chatCompletions(app, req, res, body) {
  const pc = resolveAlias(app, body.model, { effort: body.reasoning_effort || null });
  if (!pc) return error(res, 404, `model "${body.model}" is not exposed by Noema — GET /v1/models lists the aliases`, 'model_not_found');
  if (pc.refused) return error(res, 400, pc.refused);
  const { messages, tools } = fromOpenAI(body);
  const ctl = new AbortController(); res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  const id = `chatcmpl-lain-${crypto.randomBytes(6).toString('hex')}`; const created = Math.floor(Date.now() / 1000);
  let text = ''; let calls = []; let usage = null; let finish = 'stop';
  try {
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (delta, fr = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: fr }] })}\n\n`);
      chunk({ role: 'assistant' });
      for await (const ev of run(app, pc, messages, tools, ctl.signal)) {
        if (ev.type === 'text' && ev.chunk) chunk({ content: ev.chunk });
        else if (ev.type === 'tool_calls') { calls = ev.calls; chunk({ tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } })) }); finish = 'tool_calls'; }
        else if (ev.type === 'usage') usage = ev;
      }
      chunk({}, finish);
      if (body.stream_options && body.stream_options.include_usage && usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage: { prompt_tokens: usage.inputTokens || 0, completion_tokens: usage.outputTokens || 0, total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0) } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    for await (const ev of run(app, pc, messages, tools, ctl.signal)) {
      if (ev.type === 'text' && ev.chunk) text += ev.chunk;
      else if (ev.type === 'tool_calls') { calls = ev.calls; finish = 'tool_calls'; }
      else if (ev.type === 'usage') usage = ev;
    }
    send(res, 200, {
      id, object: 'chat.completion', created, model: body.model,
      choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } })) } : {}) } }],
      usage: usage ? { prompt_tokens: usage.inputTokens || 0, completion_tokens: usage.outputTokens || 0, total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0) } : undefined,
    });
  } catch (e) {
    if (!res.headersSent) error(res, e.status && e.status >= 400 && e.status < 600 ? e.status : 502, e.message || 'the model request failed', 'upstream_error');
    else res.end();
  }
}

async function messagesApi(app, req, res, body) {
  const pc = resolveAlias(app, body.model);
  if (!pc) return send(res, 404, { type: 'error', error: { type: 'not_found_error', message: `model "${body.model}" is not exposed by Noema` } });
  if (pc.refused) return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: pc.refused } });
  if (body.stream) return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Noema serves /v1/messages without streaming; use stream: false or the OpenAI-compatible endpoint for streaming' } });
  const { messages, tools } = fromAnthropic(body);
  const ctl = new AbortController(); res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  let text = ''; let calls = []; let usage = null;
  try {
    for await (const ev of run(app, pc, messages, tools, ctl.signal)) {
      if (ev.type === 'text' && ev.chunk) text += ev.chunk;
      else if (ev.type === 'tool_calls') calls = ev.calls;
      else if (ev.type === 'usage') usage = ev;
    }
    send(res, 200, {
      id: `msg_lain_${crypto.randomBytes(6).toString('hex')}`, type: 'message', role: 'assistant', model: body.model,
      content: [...(text ? [{ type: 'text', text }] : []), ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input || {} }))],
      stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: (usage && usage.inputTokens) || 0, output_tokens: (usage && usage.outputTokens) || 0 },
    });
  } catch (e) { send(res, 502, { type: 'error', error: { type: 'api_error', message: require('./redact').text(String(e.message || 'the model request failed')) } }); }
}

function handler(app) {
  return async (req, res) => {
    running.requests += 1;
    const url = String(req.url || '').split('?')[0].replace(/^\/api\/v1\//, '/v1/');
    if (url === '/health') return send(res, 200, { ok: true, name: 'Noema' });
    if (!authorized(req)) return error(res, 401, 'a Noema access token is required (Authorization: Bearer lain_…) — Settings › Router Server shows it', 'authentication_error');
    try {
      if (req.method === 'GET' && url === '/v1/models') return send(res, 200, { object: 'list', data: aliases(app).map((a) => ({ id: a.alias, object: 'model', owned_by: 'lain', ...(a.context ? { context_length: a.context } : {}) })) });
      if (req.method === 'POST' && url === '/v1/chat/completions') return await chatCompletions(app, req, res, await readBody(req));
      if (req.method === 'POST' && url === '/v1/messages') return await messagesApi(app, req, res, await readBody(req));
      return error(res, 404, `Noema does not serve ${req.method} ${url}`, 'not_found');
    } catch (e) { if (!res.headersSent) error(res, 400, e.message); }
  };
}

/** START. Loopback unless allowRemote; a token is created on first start. */
function start(app, over = {}) {
  if (running) return Promise.resolve({ ok: true, already: true, ...status(app) });
  const s = { ...settings(app), ...over };
  const host = String(s.host || DEFAULTS.host);
  if (!LOOPBACK.test(host) && s.allowRemote !== true) return Promise.resolve({ ok: false, why: `listening on ${host} exposes Noema beyond this machine — set Router Server › allow remote access first` });
  try { token({ create: true }); } catch (e) { return Promise.resolve({ ok: false, why: e.message }); }
  return new Promise((resolve) => {
    const server = http.createServer();
    running = { server, host, port: Number(s.port) || DEFAULTS.port, startedAt: Date.now(), requests: 0, app };
    server.on('request', handler(app));
    server.once('error', (e) => { running = null; resolve({ ok: false, why: e.code === 'EADDRINUSE' ? `port ${s.port} is already in use` : e.message }); });
    server.listen(running.port, host, () => { running.port = server.address().port; resolve({ ok: true, ...status(app) }); });
  });
}

function stop() {
  if (!running) return Promise.resolve({ ok: true, stopped: false });
  const r = running; running = null;
  return new Promise((resolve) => { r.server.close(() => resolve({ ok: true, stopped: true })); r.server.closeAllConnections && r.server.closeAllConnections(); });
}

function status(app) {
  const s = settings(app);
  return {
    running: Boolean(running), host: running ? running.host : s.host, port: running ? running.port : s.port,
    url: running ? `http://${running.host === '::1' ? '[::1]' : running.host}:${running.port}/v1` : null,
    startedAt: running ? running.startedAt : null, requests: running ? running.requests : 0,
    startWithLain: Boolean(s.startWithLain), allowRemote: Boolean(s.allowRemote), expose: s.expose,
    token: tokenInfo(), protocols: ['OpenAI-compatible: GET /v1/models, POST /v1/chat/completions (streaming)', 'Anthropic-compatible: POST /v1/messages (non-streaming)'],
  };
}

function configure(app, patch = {}) {
  const cfg = cfgOf(app);
  const next = { ...settings(app) };
  if ('port' in patch) { const p = Number(patch.port); if (!Number.isInteger(p) || p < 1024 || p > 65535) return { ok: false, why: 'port is 1024–65535' }; next.port = p; }
  if ('host' in patch) { const h = String(patch.host || ''); if (!h) return { ok: false, why: 'give a host' }; next.host = h; }
  if ('allowRemote' in patch) next.allowRemote = patch.allowRemote === true;
  if ('startWithLain' in patch) next.startWithLain = patch.startWithLain === true;
  if ('expose' in patch) next.expose = patch.expose === 'all' ? 'all' : (Array.isArray(patch.expose) ? patch.expose.map(String) : next.expose);
  if (!LOOPBACK.test(next.host) && !next.allowRemote) return { ok: false, why: 'a non-loopback address needs allow remote access turned on (with the warning read)' };
  cfg.server = next;
  try { require('./config').save(cfg); } catch { /* in memory */ }
  return { ok: true, settings: next };
}

/** `lain --serve [--port N] [--host H]` — foreground, until Ctrl+C. */
async function cli(argv = []) {
  const { App } = require('./app');
  const app = new App({ out: process.stdout, interactive: false, cwd: process.cwd() });
  const over = {};
  const i = argv.indexOf('--port'); if (i >= 0) over.port = Number(argv[i + 1]);
  const h = argv.indexOf('--host'); if (h >= 0) over.host = argv[h + 1];
  const r = await start(app, over);
  if (!r.ok) { process.stderr.write(`noema --serve: ${r.why}\n`); return 1; }
  process.stdout.write(`Noema is serving on ${r.url}\n  models: GET ${r.url}/models (${aliases(app).length} aliases)\n  auth:   Authorization: Bearer <your Noema access token> (Settings › Router Server)\n  Ctrl+C stops it.\n`);
  await new Promise((resolve) => { const done = () => resolve(); process.once('SIGINT', done); process.once('SIGTERM', done); });
  await stop();
  process.stdout.write('Noema server stopped.\n');
  return 0;
}

module.exports = { start, stop, status, configure, cli, aliases, token, regenerate, tokenInfo, fromOpenAI, fromAnthropic, DEFAULTS, TOKEN_REF, resolveAlias };
