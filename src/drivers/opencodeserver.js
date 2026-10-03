'use strict';

/** THE OPENCODE SERVER — `opencode serve`, OpenCode's own v2 HTTP API, started and owned by LAIN. */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const IDLE_MS = 10 * 60 * 1000;
const CHAT_DENY = ['edit', 'write', 'patch', 'bash', 'webfetch', 'task'];

let exitHooked = false;   // one exit hook: LAIN's server never outlives the process that started it
let server = null;   // { bin, port, password, child, recordId, startedAt, lastUsed, ready }

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function auth(pw) { return `Basic ${Buffer.from(`opencode:${pw}`).toString('base64')}`; }

/** A request to the owned server. `directory` scopes it to a location, as the API expects. */
async function call(s, method, p, { body, directory, signal, timeoutMs = 30000 } = {}) {
  const url = `http://127.0.0.1:${s.port}${p}${directory ? `${p.includes('?') ? '&' : '?'}directory=${encodeURIComponent(directory)}` : ''}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    const r = await fetch(url, { method, headers: { authorization: auth(s.password), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { j = null; }
    if (!r.ok) { const e = new Error(`OpenCode server ${r.status}: ${(j && (j.message || j._tag)) || text.slice(0, 200)}`); e.status = r.status; throw e; }
    return j;
  } finally { clearTimeout(t); }
}

/** START (or reuse) the owned server. Returns the server record or throws with a reason. */
async function ensure(bin, { spawnFn, startTimeoutMs = 30000 } = {}) {
  if (server && server.bin === bin && server.child && server.child.exitCode === null) { server.lastUsed = Date.now(); await server.ready; return server; }
  if (server) stop();
  const port = await freePort();
  const password = crypto.randomBytes(24).toString('base64url');
  const sh = require('./cliexec').resolveShim(bin);
  const { spawn } = require('child_process');
  const child = (spawnFn || spawn)(sh.command, [...sh.prefix, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OPENCODE_SERVER_PASSWORD: password } });
  child.on('error', () => {});
  // The server prints its password; LAIN set it and never needs to read it back.
  if (child.stdout) child.stdout.resume();
  let stderr = '';
  if (child.stderr) child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  // NEVER WHAT KEEPS LAIN ALIVE: a CLI that is done exits; the registry (onOwnerExit: stop) and
  // teardown stop the server with it. Without this an idle server held the process for ten minutes.
  if (child.unref) child.unref();
  for (const st of [child.stdout, child.stderr]) if (st && st.unref) st.unref();
  if (!exitHooked) { exitHooked = true; process.once('exit', () => { try { stop(); } catch { /* already gone */ } }); }
  const recordId = require('../runtimeregistry').register(child, { purpose: 'runtime:opencode-server', label: 'opencode serve (LAIN)', command: `${bin} serve --hostname 127.0.0.1 --port ${port}`, policy: { onOwnerExit: 'stop' } });
  const s = { bin, port, password, child, recordId, startedAt: Date.now(), lastUsed: Date.now() };
  server = s;
  s.ready = (async () => {
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`opencode serve exited: ${require('../redact').text(stderr).trim().split('\n').pop() || child.exitCode}`);
      try { await call(s, 'GET', '/api/info', { timeoutMs: 2000 }); return s; } catch { /* not yet */ }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('opencode serve did not answer in time');
  })();
  s.ready.catch(() => { if (server === s) stop(); });
  scheduleIdle();
  await s.ready;
  return s;
}

let idleTimer = null;
function scheduleIdle() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = setInterval(() => { if (server && Date.now() - server.lastUsed > IDLE_MS && !server.busy) stop(); }, 60000);
  if (idleTimer.unref) idleTimer.unref();
}

function stop() {
  const s = server;
  server = null;
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  if (!s) return { ok: true, already: true };
  const r = s.recordId ? require('../runtimeregistry').stop(s.recordId) : { ok: true };
  if (!r.ok && s.child && s.child.exitCode === null) { try { s.child.kill(); } catch { /* gone */ } }
  return { ok: true, pid: s.child && s.child.pid };
}
function status() { return server ? { running: server.child && server.child.exitCode === null, port: server.port, pid: server.child && server.child.pid, startedAt: server.startedAt, lastUsed: server.lastUsed } : { running: false }; }

/** The models OpenCode serves, as it lists them (retries while the server is still loading providers). */
async function models(s, directory) {
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await call(s, 'GET', '/api/model', { directory });
    const list = (r && Array.isArray(r.data)) ? r.data : [];
    if (list.length) return list.map((m) => ({ providerID: m.providerID, id: m.id || m.modelID, name: m.name || m.id, tools: Boolean(m.capabilities && m.capabilities.tools), input: (m.capabilities && m.capabilities.input) || [] }));
    // eslint-disable-next-line no-await-in-loop
    await new Promise((x) => setTimeout(x, 500));
  }
  return [];
}

async function sessions(s, directory) {
  const r = await call(s, 'GET', '/api/session', { directory });
  return (r && Array.isArray(r.data) ? r.data : []).map((x) => ({ id: x.id, title: x.title || null, updated: x.time ? x.time.updated || x.time.created : null, model: x.model ? `${x.model.providerID}/${x.model.id}` : null, directory: x.location ? x.location.directory : null, outcome: x.outcome || null }));
}

async function messages(s, sessionId, directory) {
  const r = await call(s, 'GET', `/api/session/${encodeURIComponent(sessionId)}/message`, { directory });
  return (r && Array.isArray(r.data) ? r.data : []).filter((m) => m.type === 'user' || m.type === 'assistant').reverse()
    .map((m) => ({ role: m.type, text: m.type === 'user' ? String(m.text || '') : (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('') }));
}

/** ONE PROMPT through a real OpenCode session, streamed. */
async function* prompt(s, { text, model, mode = 'chat', cwd, signal = null, title = 'LAIN', agentShell = false }) {
  const [providerID, ...rest] = String(model || '').split('/');
  const modelRef = providerID && rest.length ? { providerID, id: rest.join('/') } : null;
  const directory = cwd;
  const deny = mode === 'chat' ? CHAT_DENY : (agentShell ? [] : ['bash', 'webfetch']);
  s.busy = true; s.lastUsed = Date.now();
  // THE EVENT STREAM FIRST, so no delta is missed.
  const ac = new AbortController();
  const queue = []; let wake = null; let streamErr = null;
  let connected; const isConnected = new Promise((r) => { connected = r; });
  const push = (e) => { connected(); queue.push(e); if (wake) { const w = wake; wake = null; w(); } };
  const url = `http://127.0.0.1:${s.port}/api/event?directory=${encodeURIComponent(directory)}`;
  (async () => {
    const r = await fetch(url, { headers: { authorization: auth(s.password) }, signal: ac.signal });
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const blk = buf.slice(0, i); buf = buf.slice(i + 2);
        const d = blk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (d) { try { push(JSON.parse(d)); } catch { /* not an event */ } }
      }
    }
  })().catch((e) => { if (!ac.signal.aborted) { streamErr = e; push({ type: '__end' }); } });
  let sid = null; let usage = null; let outcome = null;
  const onAbort = () => { if (sid) call(s, 'POST', `/api/session/${sid}/interrupt`, { body: {}, directory }).catch(() => {}); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    // THE STREAM IS LISTENING before anything is asked (the server emits as it goes; a late listener misses the start).
    await require('../deadline').race(isConnected, 5000);
    const created = await call(s, 'POST', '/api/session', { directory, body: { title, agent: 'build', ...(modelRef ? { model: modelRef } : {}), permissions: deny.map((a) => ({ action: a, resource: '*', effect: 'deny' })), location: { directory } } });
    sid = created.data.id;
    if (signal && signal.aborted) onAbort();
    await call(s, 'POST', `/api/session/${sid}/prompt`, { directory, body: { text: String(text) } });
    const t0 = Date.now();
    for (;;) {
      if (!queue.length) {
        // eslint-disable-next-line no-await-in-loop
        await require('../deadline').race(new Promise((r) => { wake = r; }), 15000);
        if (!queue.length) {
          // NO EVENT FOR A WHILE: ask the session itself (a stream can drop an event).
          // eslint-disable-next-line no-await-in-loop
          const info = await call(s, 'GET', `/api/session/${sid}`, { directory }).catch(() => null);
          if (info && info.data && info.data.outcome) { outcome = info.data.outcome; usage = info.data.tokens ? { tokens: info.data.tokens, cost: info.data.cost } : usage; break; }
          if (Date.now() - t0 > 30 * 60 * 1000) throw new Error('OpenCode did not finish within 30 minutes');
          continue;
        }
      }
      const e = queue.shift();
      if (e.type === '__end') { if (streamErr) throw streamErr; break; }
      const d = e.data || {};
      if (d.sessionID && d.sessionID !== sid) continue;
      if (e.type === 'session.text.delta' && d.delta) yield { type: 'text', chunk: String(d.delta) };
      else if (e.type === 'session.reasoning.delta' && d.delta) yield { type: 'reasoning', chunk: String(d.delta) };
      else if (/^session\.tool\.(started|called|running)$/.test(e.type)) yield { type: 'runtime_tool', name: d.tool || d.name || 'tool', input: d.input || null, id: d.callID || d.id || null };
      else if (e.type === 'session.usage.updated') usage = { tokens: d.tokens, cost: d.cost };
      else if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type)) { outcome = e.type.split('.').pop(); break; }
    }
    if (outcome === 'interrupted' || (signal && signal.aborted)) { const e = new Error('cancelled'); e.status = 499; e.cancelled = true; throw e; }
    if (outcome === 'failed') {
      const msgs = await call(s, 'GET', `/api/session/${sid}/message`, { directory }).catch(() => null);
      const err = msgs && (msgs.data || []).map((m) => m.error).find(Boolean);
      const e = new Error(`OpenCode: ${(err && err.message) || 'the session failed'}`); e.status = err && err.status === 403 ? 403 : 502; throw e;
    }
    const t = (usage && usage.tokens) || {};
    yield { type: 'finish', reason: 'stop', raw: outcome };
    yield {
      type: 'usage', inputTokens: t.input || 0, outputTokens: t.output || 0,
      cacheReadTokens: (t.cache && t.cache.read) || 0, cacheCreationTokens: (t.cache && t.cache.write) || 0, cacheReported: Boolean(t.cache),
      reasoningTokens: Number.isFinite(t.reasoning) ? t.reasoning : undefined,
      costUsd: usage && Number.isFinite(usage.cost) ? usage.cost : undefined, costBasis: 'reported by OpenCode for this session',
      runtime: { id: 'opencode', session: sid, model, via: 'opencode serve' },
    };
  } finally {
    ac.abort();
    if (signal) signal.removeEventListener('abort', onAbort);
    s.busy = false; s.lastUsed = Date.now();
  }
}

/** A scratch folder for BOT answers (no project), created once per process. */
let scratch = null;
function scratchDir() {
  if (!scratch) scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-opencode-chat-'));
  return scratch;
}

module.exports = { ensure, stop, status, call, models, sessions, messages, prompt, scratchDir, CHAT_DENY, _server: () => server };
