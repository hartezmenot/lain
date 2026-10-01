'use strict';

/**
 * LLAMA.CPP — a llama-server LAIN starts, owns, health-checks and stops.
 *
 *     model chosen → ensure() → llama-server (owned, registered) → /health → ready
 *
 * ONE SERVER PER MODEL CONFIGURATION, REUSED. A request never spawns a server:
 * `ensure` returns the healthy one already serving this exact configuration
 * (file, projector, context, GPU layers, threads), and starts one only when
 * none is. By default one LAIN-owned server runs at a time (`maxServers`,
 * cfg.local.llamacpp.maxServers): a second model is a CONTROLLED SWITCH — the
 * current server is stopped only when no request is in flight on it.
 *
 * RESOURCES. Before starting, the need is estimated from the file sizes the
 * header scan already knows (weights + projector, plus a stated KV-cache
 * allowance) against the machine's free memory. A start that would not fit is
 * refused with the numbers, not attempted. What is MEASURED afterwards is the
 * server process's working set — reported as process memory, never as VRAM.
 *
 * OWNERSHIP. Every server is registered in runtimeregistry.js (pid + start
 * time, policy onOwnerExit: 'stop'). Only servers LAIN started are ever
 * stopped; another llama-server on this machine is not LAIN's and is never
 * touched, looked up by name, or killed.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const servers = new Map();   // key -> server record
const ADAPTER_VERSION = 'llamacpp-adapter/1';

function root(app) { return (app && app._sibling) || app; }
function settings(app) { const c = (root(app) && root(app).cfg) || {}; return (c.local && c.local.llamacpp) || {}; }

const whichMemo = new Map();   // `${PATH}|${name}` -> path | null, this process
function which(name) {
  const k = `${process.env.PATH || ''}|${name}`;
  if (whichMemo.has(k)) { const hit = whichMemo.get(k); if (!hit || fs.existsSync(hit)) return hit; whichMemo.delete(k); }
  const found = whichUncached(name);
  whichMemo.set(k, found);
  return found;
}
function whichUncached(name) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) { const p = path.join(dir, name + ext); try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  }
  return null;
}

/** llama-server: configured path first, then PATH. */
function binary(app) {
  const s = settings(app);
  if (s.server) return fs.existsSync(s.server) ? s.server : null;
  return process.env.LAIN_ISOLATED === '1' ? null : which('llama-server');
}
function cliBinary(app) { const s = settings(app); return s.cli ? (fs.existsSync(s.cli) ? s.cli : null) : (process.env.LAIN_ISOLATED === '1' ? null : which('llama-cli')); }

let versionCache = null;
/**
 * THE SERVER'S VERSION — the same binary always answers the same, so it is asked
 * once per binary (path, size, time), not once per LAIN start: `--version` was a
 * blocking process launch on every CLI start (Phase 8.2). Kept in the config home.
 */
function versionFile() { return path.join(require('../config').configDir(), 'local', 'llama-version.json'); }
function version(app) {
  const b = binary(app);
  if (!b) return null;
  if (versionCache && versionCache.bin === b) return versionCache.v;
  let st = null;
  try { st = fs.statSync(b); } catch { st = null; }
  const sig = st ? `${b}|${st.size}|${Math.floor(st.mtimeMs)}` : null;
  if (sig) {
    try { const j = JSON.parse(fs.readFileSync(versionFile(), 'utf8')); if (j && j.sig === sig) { versionCache = { bin: b, v: j.v }; return j.v; } } catch { /* ask it */ }
  }
  const sh = require('../drivers/cliexec').resolveShim(b);
  const r = spawnSync(sh.command, [...sh.prefix, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /version:\s*(\d+)\s*\(([0-9a-f]+)\)/i.exec(text);
  const v = m ? `b${m[1]} (${m[2]})` : (text.trim().split('\n')[0] || null);
  versionCache = { bin: b, v };
  if (sig && v) { try { fs.mkdirSync(path.dirname(versionFile()), { recursive: true }); fs.writeFileSync(versionFile(), JSON.stringify({ sig, v })); } catch { /* asked again next time */ } }
  return v;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function keyOf(cfg) { return JSON.stringify([cfg.file, cfg.projector || null, cfg.ctx || null, cfg.ngl == null ? null : cfg.ngl, cfg.threads || null]); }

/** The configuration a model runs with: its file, its projector, and its Advanced defaults. */
function configFor(app, model) {
  const s = settings(app);
  const per = (require('./modeldirs').list().settings || {})[model.file] || {};
  // CONTEXT: the person's setting; else the largest of 32k / 24k / 16k / 8k that the header allows
  // and free memory holds. LAIN's own BOT request (system prompt + tool schemas) is ~19k tokens, so
  // 8k is a last resort that says so on the first refused request.
  const cap = (n) => (model.contextLength ? Math.min(n, model.contextLength) : n);
  let ctx = cap(per.ctx || s.ctx || 32768);
  if (!per.ctx && !s.ctx) {
    for (const c of [32768, 24576, 16384, 8192]) { ctx = cap(c); if (estimate(model, { ctx, projector: model.projector || null }).total <= os.freemem() * 0.8) break; }
  }
  return { file: model.file, projector: model.projector || null, ctx, ngl: per.ngl != null ? per.ngl : (s.ngl != null ? s.ngl : null), threads: per.threads || s.threads || null, alias: model.id };
}

/** The estimate a start is checked against (bytes). */
function estimate(model, cfg) {
  const weights = model.sizeBytes || 0;
  let projector = 0;
  if (cfg.projector) { try { projector = fs.statSync(cfg.projector).size; } catch { projector = 0; } }
  // KV CACHE (f16): layers × ctx × kv-heads × (key + value width) × 2 bytes, from the header;
  // without the attention shape, a width-based allowance.
  const kv = model.blockCount && model.headCountKv && model.keyLength
    ? model.blockCount * cfg.ctx * model.headCountKv * (model.keyLength + (model.valueLength || model.keyLength)) * 2
    : (model.blockCount && model.embeddingLength ? model.blockCount * cfg.ctx * model.embeddingLength * 2 * 2 / 4 : 0);
  return { weights, projector, kv: Math.round(kv), total: Math.round(weights + projector + kv + 256 * 1024 * 1024) };
}

function view(s) {
  return {
    key: s.key, model: s.modelId, file: s.cfg.file, projector: s.cfg.projector, port: s.port, pid: s.pid, recordId: s.recordId,
    ctx: s.cfg.ctx, ngl: s.cfg.ngl, threads: s.cfg.threads, state: s.state, startedAt: s.startedAt, readyAt: s.readyAt,
    inflight: s.inflight, lastError: s.lastError, baseUrl: s.state === 'ready' ? `http://127.0.0.1:${s.port}/v1` : null,
    estimate: s.estimate, requests: s.requests,
  };
}

function status() { return [...servers.values()].map(view); }

async function health(port, { timeoutMs = 3000 } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.status === 200, status: r.status, body: j };
  } catch (e) { return { ok: false, status: 0, why: e.message }; }
}

/** STOP one LAIN-owned server (verified through the registry). Refuses while a request is in flight unless forced. */
function stop(key, { force = false } = {}) {
  const s = servers.get(key);
  if (!s) return { ok: false, why: 'no such Noema server' };
  if (s.inflight > 0 && !force) return { ok: false, why: `a request is in flight on ${path.basename(s.cfg.file)}` };
  s.state = 'stopping';
  let r = { ok: true };
  if (s.recordId) r = require('../runtimeregistry').stop(s.recordId);
  else if (s.child && !s.child.killed) { try { s.child.kill(); } catch { /* gone */ } }
  servers.delete(key);
  return { ok: r.ok !== false, pid: s.pid, why: r.why };
}

function stopAll() { let n = 0; for (const k of [...servers.keys()]) { if (stop(k, { force: true }).ok) n++; } return { stopped: n }; }

/**
 * ENSURE the model is served. Returns the ready server's view, or
 * { ok:false, why } — a model that cannot start is an answer, never a hang.
 */
async function ensure(app, modelId, { signal = null, startTimeoutMs = 180000, spawnFn = spawn } = {}) {
  const model = require('./modeldirs').byId(modelId);
  if (!model) return { ok: false, why: `${modelId} is not in any model directory Noema knows` };
  const cfg = configFor(app, model);
  const key = keyOf(cfg);
  const cur = servers.get(key);
  if (cur && cur.state === 'ready') {
    const h = await health(cur.port);
    if (h.ok) return { ok: true, reused: true, server: view(cur) };
    cur.state = 'failed'; cur.lastError = 'health check failed';
    stop(key, { force: true });
  } else if (cur && cur.state === 'starting') {
    return cur.ready;
  }
  const bin = binary(app);
  if (!bin) return { ok: false, why: 'llama-server is not installed (or not on PATH). Install llama.cpp, or set its path in Settings.' };

  // A CONTROLLED SWITCH: at most `maxServers` LAIN servers.
  const max = Math.max(1, Number(settings(app).maxServers) || 1);
  const others = [...servers.values()].filter((s) => s.key !== key);
  if (others.length >= max) {
    const idle = others.filter((s) => s.inflight === 0);
    if (idle.length < others.length - max + 1) return { ok: false, why: `another local model is answering a request; Noema will not stop it mid-request (${others.map((s) => path.basename(s.cfg.file)).join(', ')})` };
    for (const s of idle.slice(0, others.length - max + 1)) stop(s.key);
  }

  const est = estimate(model, cfg);
  const free = os.freemem();
  if (!settings(app).skipMemoryCheck && est.total > free * 0.92) {
    return { ok: false, why: `not enough free memory: this model needs about ${(est.total / 1073741824).toFixed(1)} GB (weights ${(est.weights / 1073741824).toFixed(1)} GB${est.projector ? `, projector ${(est.projector / 1073741824).toFixed(2)} GB` : ''}, context ${cfg.ctx}); ${(free / 1073741824).toFixed(1)} GB is free`, estimate: est };
  }

  const port = await freePort();
  const args = ['-m', cfg.file, '--host', '127.0.0.1', '--port', String(port), '-c', String(cfg.ctx), '--jinja', '-a', cfg.alias];
  if (cfg.projector) args.push('--mmproj', cfg.projector);
  if (cfg.ngl != null) args.push('-ngl', String(cfg.ngl));
  if (cfg.threads) args.push('-t', String(cfg.threads));
  const s = { key, modelId, cfg, port, pid: null, recordId: null, child: null, state: 'starting', startedAt: Date.now(), readyAt: null, inflight: 0, lastError: null, stderr: '', estimate: est, requests: 0 };
  servers.set(key, s);
  s.ready = (async () => {
    let child;
    // NO SHELL: a .cmd shim is resolved to the program it starts, so the pid is llama-server's own.
    const sh = require('../drivers/cliexec').resolveShim(bin);
    try { child = spawnFn(sh.command, [...sh.prefix, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { s.state = 'failed'; s.lastError = e.message; servers.delete(key); return { ok: false, why: e.message }; }
    s.child = child; s.pid = child.pid;
    child.on('error', (e) => { s.lastError = e.message; });
    const tail = (d) => { s.stderr = (s.stderr + d).slice(-8000); };
    if (child.stdout) child.stdout.on('data', tail);
    if (child.stderr) child.stderr.on('data', tail);
    s.recordId = require('../runtimeregistry').register(child, { purpose: 'llama-server', label: `llama.cpp · ${path.basename(cfg.file)}`, command: `${bin} ${args.join(' ')}`, policy: { onOwnerExit: 'stop' } });
    let exited = null;
    child.once('exit', (code) => { exited = code; if (servers.get(key) === s) { s.state = s.state === 'stopping' ? 'stopped' : 'exited'; if (s.state === 'exited') { s.lastError = s.lastError || lastLine(s.stderr) || `exited with code ${code}`; servers.delete(key); } } });
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (signal && signal.aborted) { stop(key, { force: true }); return { ok: false, why: 'cancelled while the model was loading' }; }
      if (exited !== null) return { ok: false, why: `llama-server exited while loading: ${s.lastError}` };
      // eslint-disable-next-line no-await-in-loop -- polling a local health endpoint, bounded by the deadline
      const h = await health(port, { timeoutMs: 1500 });
      if (h.ok) { s.state = 'ready'; s.readyAt = Date.now(); return { ok: true, reused: false, server: view(s) }; }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 500));
    }
    s.lastError = 'did not become healthy in time';
    stop(key, { force: true });
    return { ok: false, why: `llama-server did not become healthy within ${Math.round(startTimeoutMs / 1000)} s` };
  })();
  return s.ready;
}

function lastLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => /error|failed|unknown|unsupported/i.test(l));
  return (bad[bad.length - 1] || lines[lines.length - 1] || '').slice(0, 300);
}

/** Mark a request in flight on the server serving `modelId` (so a switch waits for it). */
function begin(modelId) { for (const s of servers.values()) if (s.modelId === modelId && s.state === 'ready') { s.inflight++; s.requests++; return () => { s.inflight = Math.max(0, s.inflight - 1); }; } return () => {}; }

/** Working set of a LAIN-owned server process, measured; null when unreadable. */
function processMemory(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const m = /"([\d.,\s]+)\s*K"\s*$/m.exec(String(r.stdout || '').trim());
      return m ? Number(m[1].replace(/[^\d]/g, '')) * 1024 : null;
    }
    const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(s);
    return m ? Number(m[1]) * 1024 : null;
  } catch { return null; }
}

/** The adapter's identity, part of an Agent verification key (localagent.js). */
function adapterKey(app) { return `${ADAPTER_VERSION}|${version(app) || 'unknown'}`; }

module.exports = { binary, cliBinary, version, ensure, stop, stopAll, status, begin, health, processMemory, configFor, estimate, adapterKey, ADAPTER_VERSION, _servers: servers };
