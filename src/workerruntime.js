'use strict';

/**
 * SPECIALIST PROCESSES — installed, enabled, warm, bounded (2026-09-23).
 *
 * A specialist (workers/manifest.json) is an OPTIONAL CAPABILITY: installed or
 * not, enabled `auto` or `off`. Normal work never names one; policy decides.
 * This module owns the process of each one per App: spawned lazily (or warmed
 * at start), one request at a time over JSON lines, a hard timeout per call,
 * killed at teardown. It holds no authority and makes no decision: callers
 * (locateassist.js, evidenceslice.js) ask one bounded question and get one
 * result or `null` — unavailable, timed out, failed — and carry on without it.
 *
 * WHERE THE MODEL LIVES (2026-09-23, later): in the WORKER HOST
 * (workerhost.js / workerhostmain.js), a detached process that keeps a loaded
 * model HOT between LAIN processes. This module decides and asks; the host
 * loads and answers. A worker that is not hot when a decision needs it gets
 * the availability deadline (AVAILABLE_WITHIN_MS) and is otherwise BYPASSED
 * for that decision — a local worker may shorten a turn, never lengthen it
 * because it is loading. `LAIN_WORKERHOST=off` (or cfg.workers.host = 'off')
 * keeps the old in-process lifetime, with the same bypass rule.
 *
 * Config (per user, never in the repo):
 *   cfg.workers.policy          'auto' (default) | 'off'
 *   cfg.workers.host            'on' (default) | 'off'
 *   cfg.workers.availableWithinMs   the availability deadline (default 100)
 *   cfg.workers.<id>.idleUnloadMs   unload a hot, idle worker after this (default: never)
 *   cfg.workers.laya.enabled    'auto' | 'off'
 *   cfg.workers.laya.python     the specialist runtime's python
 *   cfg.workers.laya.hfHome     the local model store for its weights
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'workers', 'manifest.json');

// ---- CHEAP ON THE HOT PATH ------------------------------------------------------
// `uses` is asked on every tool lookup (tools/index.js offers the geometry tool
// through it). Re-reading the manifest and stat-ing a model store on another
// drive each time put disk latency into every call — measured as a key-timing
// test failing under full-tier load. Both are cached briefly.
let manifestCache = null;
let manifestAt = 0;
function manifest() {
  if (manifestCache && Date.now() - manifestAt < 5000) return manifestCache;
  try { manifestCache = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).workers || {}; } catch { manifestCache = {}; }
  manifestAt = Date.now();
  return manifestCache;
}
const existsCache = new Map();
function exists(p) {
  const hit = existsCache.get(p);
  if (hit && Date.now() - hit.at < 30000) return hit.v;
  const v = fs.existsSync(p);
  existsCache.set(p, { v, at: Date.now() });
  return v;
}

function cfgOf(app) { return (app && app.cfg && app.cfg.workers) || {}; }

/** 'auto' | 'off' for every specialist at once; LAIN_WORKERS overrides for a run. */
function policyOf(app) { return String(process.env.LAIN_WORKERS || cfgOf(app).policy || 'auto').toLowerCase(); }

/** A worker's own switch: 'auto' (where its gate passed) | 'on' (forced, experiments) | 'off'. */
function enabledOf(app, id) {
  const m = manifest()[id] || {};
  const env = process.env[`LAIN_WORKER_${id.toUpperCase()}`];
  return String(env || (cfgOf(app)[id] || {}).enabled || m.enabled || 'off').toLowerCase();
}

/**
 * MAY THIS WORKER SERVE THIS USE? Installed, not switched off, and either its
 * recorded gate for THAT use passed or the person forced it on. A gate that
 * failed keeps an installed worker out of normal work — installed ≠ recruited.
 */
function uses(app, id, use) {
  // THE CHEAP ANSWERS FIRST: switches and the recorded gate, before any disk.
  if (policyOf(app) === 'off') return false;
  const en = enabledOf(app, id);
  if (en === 'off') return false;
  const m = manifest()[id] || {};
  const g = (m.gates || {})[use];
  if (en !== 'on' && !(en === 'auto' && g && g.pass)) return false;
  const w = info(app, id);
  return Boolean(w && w.usable);
}

/** Everything known about one worker on this machine. */
function info(app, id) {
  const m = manifest()[id];
  if (!m) return null;
  const c = cfgOf(app)[id] || {};
  const policy = policyOf(app);
  const python = c.python || process.env.LAIN_WORKER_PYTHON || m.defaultPython || '';
  const store = c.hfHome || m.defaultStore || '';
  const adapter = c.adapter || (m.adapter ? path.join(ROOT, m.adapter) : '');
  const server = c.server || m.server || '';
  const gguf = c.gguf || m.gguf || '';
  let installed = false;
  if (m.status !== 'EXCLUDED' && m.runtime === 'python') installed = Boolean(python && exists(python) && adapter && exists(adapter) && store && exists(store));
  if (m.status !== 'EXCLUDED' && m.runtime === 'llama-server') installed = Boolean(server && exists(server) && gguf && exists(gguf));
  const enabled = policy !== 'off' && enabledOf(app, id) !== 'off';
  return { id, ...m, python, store, adapter, server, gguf, installed, enabled, policy, usable: installed && enabled };
}

function procs(app) { if (!app._workerProcs) app._workerProcs = new Map(); return app._workerProcs; }

// ---- the worker host: models that outlive this process (workerhostmain.js) -------

/**
 * THE AVAILABILITY DEADLINE. A worker that is still LOADING when a decision
 * needs it gets this long to become hot, and is otherwise BYPASSED for that
 * decision. Small on purpose: it is the most an optional worker may add to a
 * turn because it is loading. `cfg.workers.availableWithinMs` overrides it.
 */
const AVAILABLE_WITHIN_MS = 100;
function availableWithin(app) {
  const v = Number(cfgOf(app).availableWithinMs);
  return Number.isFinite(v) && v >= 0 ? v : AVAILABLE_WITHIN_MS;
}

/**
 * HOSTED unless switched off (`LAIN_WORKERHOST=off`, `cfg.workers.host = 'off'`),
 * in which case the worker lives and dies with this process, as it did before
 * the host existed.
 */
function hosted(app) {
  const v = String(process.env.LAIN_WORKERHOST || cfgOf(app).host || 'on').toLowerCase();
  return v !== 'off';
}

/** What the host needs to start a worker — paths and environment, nothing else. */
function spec(app, id, w = info(app, id)) {
  if (w.runtime === 'llama-server') {
    const port = Number((cfgOf(app)[id] || {}).port || w.port || 8093);
    return { runtime: 'llama-server', server: w.server, port,
      args: ['-m', w.gguf, '-c', String(w.ctx || 16384), '--host', '127.0.0.1', '--port', String(port), '-t', String(w.threads || 8), '--no-webui'] };
  }
  const hf = path.join(w.store, 'hf');
  return { runtime: 'python', python: w.python, adapter: w.adapter,
    env: { HF_HOME: fs.existsSync(hf) ? hf : w.store, USE_TF: '0', PYTHONIOENCODING: 'utf-8' } };
}

/**
 * START LOADING, DO NOT WAIT. Called when LAIN opens (for a worker policy will
 * use) and after a bypass. The load happens in the host; this process keeps
 * going. Answers nothing a turn could wait on.
 */
function prewarm(app, id) {
  const w = info(app, id);
  if (!w || !w.usable) return false;
  if (!hosted(app)) { if (!procs(app).has(id)) warm(app, id).catch(() => false); return true; }
  app._hostLoads = app._hostLoads || new Map();
  if (app._hostLoads.has(id)) return true;
  const p = require('./workerhost').load(id, spec(app, id, w), { idleUnloadMs: (cfgOf(app)[id] || {}).idleUnloadMs })
    .catch(() => null).finally(() => { if (app._hostLoads) app._hostLoads.delete(id); });
  app._hostLoads.set(id, p);
  return true;
}

// ---- the project index (layaindex.js): prepared off the hot path ------------------

/**
 * PREPARE THIS PROJECT FOR THE WORKER — at attach, never inside a task. Starts
 * the model if it is not loading yet, then asks the host to index the project;
 * the host builds after the model is hot, restores a persisted index instead of
 * rebuilding, and never restarts a build already running. Nothing here waits.
 * Hosted workers only: the index lives in the host, shared by every LAIN.
 */
function indexProject(app, id, root) {
  const w = info(app, id);
  if (!w || !w.usable || !root || !hosted(app)) return false;
  const host = require('./workerhost');
  host.load(id, spec(app, id, w), { idleUnloadMs: (cfgOf(app)[id] || {}).idleUnloadMs })
    .then(() => host.send({ op: 'index', id, root }))
    .catch(() => null);
  return true;
}

/** The project index as the host sees it — diagnostics (`/workers status`) and benchmarks. */
async function projectIndex(app, id, root = null) {
  if (!hosted(app) || !require('./workerhost').endpoint()) return null;
  const r = await require('./workerhost').send({ op: 'index_status', id, ...(root ? { root } : {}) });
  return r && r.ok ? r : null;
}

/** FOR BENCHMARKS ONLY: block until this project's index settles. Never called from a turn. */
async function waitProjectIndex(app, id, root, timeoutMs = 20 * 60 * 1000) {
  return require('./workerhost').send({ op: 'index_wait', id, root, timeoutMs }, { timeoutMs: timeoutMs + 5000 });
}

// ---- measurements (benchmark / diagnostics only) -------------------------------

/**
 * PER WORKER, KEPT APART FROM THE FLAGSHIP'S USAGE: calls, real inferences,
 * result-cache hits and misses, cold load, warm inference times, tokens in and
 * out (the worker's own tokenizer where it has one), resident memory.
 */
function stats(app, id) {
  if (!app._workerStats) app._workerStats = {};
  if (!app._workerStats[id]) {
    app._workerStats[id] = {
      calls: 0, inferences: 0, cacheHits: 0, cacheMisses: 0, cacheLookupUs: [], coldLoadMs: null, memoryMB: null,
      inferenceMs: [], totalInferenceMs: 0, tokensIn: 0, tokensOut: 0, outputChars: 0, failures: 0,
    };
  }
  return app._workerStats[id];
}

/** Resident memory of a process, in MB, or null. */
function memoryMB(pid) {
  if (!pid) return null;
  try {
    const { execFileSync } = require('child_process');
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', treeMemoryPs(pid)], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      const bytes = Number(String(out).trim());
      return bytes ? Math.round(bytes / 1048576) : null;
    }
    const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim());
    return kb ? Math.round(kb / 1024) : null;
  } catch { return null; }
}

// THE PROCESS TREE, not the pid: a venv's python.exe is a launcher whose
// CHILD holds the model (the launcher itself is a few MB).
function treeMemoryPs(pid) {
  return `$t=@(${Number(pid)});$all=Get-CimInstance Win32_Process|?{$_.ProcessId -ne $PID};do{$n=$all|?{$t -contains $_.ParentProcessId -and $t -notcontains $_.ProcessId}|%{$_.ProcessId};$t+=$n}while($n);($all|?{$t -contains $_.ProcessId}|Measure-Object WorkingSetSize -Sum).Sum`;
}

/** The same measurement without blocking the event loop — the worker host must keep answering while it measures. */
function memoryMBAsync(pid) {
  if (!pid) return Promise.resolve(null);
  const { execFile } = require('child_process');
  const [cmd, args] = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-Command', treeMemoryPs(pid)]]
    : ['ps', ['-o', 'rss=', '-p', String(pid)]];
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 }, (err, out) => {
      const n = Number(String(out || '').trim());
      if (err || !n) return resolve(null);
      resolve(Math.round(process.platform === 'win32' ? n / 1048576 : n / 1024));
    });
  });
}

// ---- the result cache: same question about the same state, zero inference ------

const CACHE_MAX = 200;
function cacheOf(app) { if (!app._workerCache) app._workerCache = new Map(); return app._workerCache; }

// ---- runtimes ---------------------------------------------------------------------

function startPython(app, id, w) {
  const hf = path.join(w.store, 'hf');
  let child;
  // A runtime that is not an executable (EFTYPE, EACCES) throws HERE, synchronously —
  // an unusable worker is null, never an exception in the caller's turn.
  try {
    child = spawn(w.python, [w.adapter], {
      env: { ...process.env, HF_HOME: fs.existsSync(hf) ? hf : w.store, USE_TF: '0', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch { return null; }
  const p = { kind: 'python', child, seq: 0, waiting: new Map(), buf: '', startedAt: Date.now(), warm: false, dead: false };
  child.stdout.on('data', (d) => {
    p.buf += d.toString('utf8');
    let nl;
    while ((nl = p.buf.indexOf('\n')) >= 0) {
      const line = p.buf.slice(0, nl); p.buf = p.buf.slice(nl + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const cb = p.waiting.get(msg.id);
      if (cb) { p.waiting.delete(msg.id); cb(msg); }
    }
  });
  const map = procs(app);
  const fail = () => { p.dead = true; for (const cb of p.waiting.values()) cb(null); p.waiting.clear(); map.delete(id); };
  child.on('exit', fail);
  child.on('error', fail);
  return p;
}

/**
 * A LLAMA-SERVER WORKER (Violetto): the patched server on a loopback port,
 * started with its model and polled until /health answers — that wait IS the
 * cold load, and it is measured as such.
 */
function startLlama(app, id, w) {
  const port = Number((cfgOf(app)[id] || {}).port || w.port || 8093);
  const args = ['-m', w.gguf, '-c', String(w.ctx || 16384), '--host', '127.0.0.1', '--port', String(port), '-t', String(w.threads || 8), '--no-webui'];
  let child;
  try { child = spawn(w.server, args, { windowsHide: true, stdio: 'ignore' }); } catch { return null; }
  const p = { kind: 'llama', child, port, startedAt: Date.now(), warm: false, dead: false, busy: Promise.resolve() };
  const map = procs(app);
  const fail = () => { p.dead = true; map.delete(id); };
  child.on('exit', fail);
  child.on('error', fail);
  p.ready = (async () => {
    const until = Date.now() + 5 * 60 * 1000;
    while (!p.dead && Date.now() < until) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) { p.healthy = true; return true; } } catch { /* loading */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })();
  return p;
}

/** Loaded and answering: python once its `ping` (the model load) has answered, llama-server once /health does. */
function ready(p) { return Boolean(p && !p.dead && (p.kind === 'llama' ? p.healthy : p.warm)); }

function start(app, id) {
  const w = info(app, id);
  if (!w || !w.usable) return null;
  const map = procs(app);
  if (map.has(id)) return map.get(id);
  const p = w.runtime === 'llama-server' ? startLlama(app, id, w) : startPython(app, id, w);
  if (p) map.set(id, p);
  return p;
}

function callPython(p, req, timeoutMs) {
  const rid = ++p.seq;
  return new Promise((resolve) => {
    const t = setTimeout(() => { p.waiting.delete(rid); resolve(null); }, timeoutMs);
    if (t.unref) t.unref();
    p.waiting.set(rid, (msg) => { clearTimeout(t); if (msg && msg.ok) p.warm = true; resolve(msg && msg.ok ? msg : null); });
    try { p.child.stdin.write(JSON.stringify({ ...req, id: rid }) + '\n'); } catch { clearTimeout(t); p.waiting.delete(rid); resolve(null); }
  });
}

/** One chat completion against the worker's own server; one at a time. */
function callLlama(p, req, timeoutMs) {
  const run = p.busy.then(async () => {
    if (!(await p.ready)) return null;
    if (req.op === 'ping') return { ok: true };
    try {
      const res = await fetch(`http://127.0.0.1:${p.port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ temperature: 0.6, top_p: 0.95, max_tokens: req.max_tokens || 6000, messages: req.messages || [] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = await res.json();
      const c = j.choices && j.choices[0];
      if (!c) return null;
      p.warm = true;
      return { ok: true, text: (c.message && c.message.content) || '', finish: c.finish_reason,
        usage: { tokens_in: (j.usage && j.usage.prompt_tokens) || 0, tokens_out: (j.usage && j.usage.completion_tokens) || 0 } };
    } catch { return null; }
  });
  p.busy = run.catch(() => null);
  return run;
}

/**
 * ONE BOUNDED REQUEST. Resolves with the worker's result, or null when the
 * worker is unusable, dead, or late — never throws, never retries.
 *
 * `cacheKey` — the caller's fingerprint of the STATE the question is about (a
 * file listing's stamps, a DOM snapshot, the geometry's numbers). The same key
 * returns the stored result with ZERO inference; a changed state is a new key,
 * so a stale answer cannot be served. The hit is marked `cached: true`.
 */
async function call(app, id, req, { timeoutMs = 20000, cacheKey = null, availableWithinMs = availableWithin(app) } = {}) {
  const st = stats(app, id);
  st.calls += 1;
  const key = cacheKey ? `${id}:${cacheKey}` : null;
  if (key) {
    const t0 = process.hrtime.bigint();
    const hit = cacheOf(app).get(key);
    st.cacheLookupUs.push(Number(process.hrtime.bigint() - t0) / 1000);
    if (hit) { st.cacheHits += 1; return { ...hit, cached: true }; }
    st.cacheMisses += 1;
  }
  let msg;
  let ms;
  if (hosted(app)) {
    const w = info(app, id);
    if (!w || !w.usable) { st.failures += 1; return null; }
    const t0 = Date.now();
    const r = await require('./workerhost').call(id, req, { timeoutMs, availableWithinMs });
    ms = Date.now() - t0;
    // A HOST THAT IS NOT THERE (still starting, killed) is one more way of not
    // being ready — the same bypass, and the same load for next time.
    if (r && !r.ok && /unreachable|closed the connection/.test(String(r.error || ''))) { r.bypass = true; r.state = 'UNAVAILABLE'; }
    if (r && r.bypass) {
      // NOT READY → BYPASSED FOR THIS DECISION, and a load started for the next
      // one. The caller carries on with its deterministic owner; nothing waits.
      st.bypasses = (st.bypasses || 0) + 1;
      (st.bypassStates = st.bypassStates || []).push(r.state);
      if (['UNLOADED', 'FAILED', 'UNAVAILABLE'].includes(r.state)) prewarm(app, id);
      return null;
    }
    if (!r || !r.ok) { st.failures += 1; if (r && r.timedOut) st.timeouts = (st.timeouts || 0) + 1; return null; }
    msg = r.msg;
    hostView(app).catch(() => null);   // residency/idle for settle(); never awaited
  } else {
    const p = start(app, id);
    if (!p || p.dead) { st.failures += 1; return null; }
    // THE SAME FAST RULE IN-PROCESS: a worker still loading gets the
    // availability deadline, then this decision goes without it. The load is
    // started (once) and carries on for the next decision.
    if (req.op !== 'ping' && !ready(p)) {
      if (!p.warming) p.warming = (p.kind === 'llama' ? callLlama(p, { op: 'ping' }, 10 * 60 * 1000) : callPython(p, { op: 'ping' }, 10 * 60 * 1000)).catch(() => null);
      const until = Date.now() + availableWithinMs;
      while (!ready(p) && !p.dead && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      if (!ready(p)) {
        st.bypasses = (st.bypasses || 0) + 1;
        (st.bypassStates = st.bypassStates || []).push(p.dead ? 'FAILED' : 'LOADING');
        return null;
      }
    }
    const t0 = Date.now();
    msg = p.kind === 'llama' ? await callLlama(p, req, timeoutMs) : await callPython(p, req, timeoutMs);
    ms = Date.now() - t0;
  }
  if (!msg) { st.failures += 1; return null; }
  if (req.op !== 'ping') {
    st.inferences += 1;
    st.inferenceMs.push(ms);
    st.totalInferenceMs += ms;
    const u = msg.usage || {};
    st.tokensIn += Number(u.tokens_in) || 0;
    st.tokensOut += Number(u.tokens_out) || 0;
    st.outputChars += Number(u.output_chars) || String(msg.text || '').length;
  }
  if (key && req.op !== 'ping') {
    const cache = cacheOf(app);
    cache.set(key, { ...msg, cachedAt: Date.now() });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return { ...msg, ms };
}

/**
 * LOAD THE MODEL so the first real request is warm. The first load's time is
 * recorded as the COLD LOAD (never folded into a per-call inference time), and
 * the process's resident memory right after it.
 */
async function warm(app, id) {
  const w = info(app, id);
  if (!w || !w.usable) return false;
  const st = stats(app, id);
  if (hosted(app)) {
    // A BENCHMARK OR DIAGNOSTIC WAIT — never called from a turn. The host
    // measured the load itself; an already-hot worker reports the load that
    // made it hot, and says it was already hot.
    const host = require('./workerhost');
    const before = await host.status();
    const was = before.ok && before.workers && before.workers[id] ? before.workers[id].state : 'UNLOADED';
    const l = await host.load(id, spec(app, id, w), { idleUnloadMs: (cfgOf(app)[id] || {}).idleUnloadMs });
    if (!l.ok && !l.state) return false;
    const r = await host.wait(id);
    if (!r.ok) { st.failures += 1; return false; }
    st.coldLoadMs = r.loadMs;
    st.alreadyHot = ['HOT_IDLE', 'INFERENCING'].includes(was);
    const m = await host.status({ measure: true });
    st.memoryMB = m.ok && m.workers && m.workers[id] ? m.workers[id].residentMB : null;
    return true;
  }
  const t0 = Date.now();
  const r = await call(app, id, { op: 'ping' }, { timeoutMs: 10 * 60 * 1000 });
  st.calls -= 1;   // a load is not a question
  if (r && st.coldLoadMs == null) {
    st.coldLoadMs = Date.now() - t0;
    const p = procs(app).get(id);
    st.memoryMB = memoryMB(p && p.child && p.child.pid);
  }
  return Boolean(r);
}

/**
 * STOP THIS PROCESS'S WORKERS. In-process workers die here. HOSTED workers
 * outlive the process by design and are only UNLOADED when the person asks
 * (`/workers off`, `/workers laya off` → `{ unload: true }`).
 */
function stop(app, { unload = false, ids = null } = {}) {
  for (const p of procs(app).values()) { try { p.child.kill(); } catch { /* gone */ } }
  procs(app).clear();
  if (unload && hosted(app) && require('./workerhost').endpoint()) {
    for (const id of ids || Object.keys(manifest())) require('./workerhost').unload(id, 'switched off by the person').catch(() => null);
  }
}

/**
 * At the end of a process: the measurements onto the session (saved with it),
 * then stop what this process owns. A hosted worker is NOT unloaded — the next
 * LAIN finds it hot. Its host-side state (load, residency, idle) is recorded
 * alongside, kept apart from this process's per-call numbers.
 */
function settle(app) {
  try {
    if (app && app.session && app._workerStats) {
      const out = JSON.parse(JSON.stringify(app._workerStats));
      for (const [id, v] of Object.entries(app._hostView || {})) if (out[id]) out[id].host = v;
      app.session.workerStats = out;
    }
  } catch { /* measurement only */ }
  stop(app);
}

/** Refresh the host's view of every worker (async, never on a turn's path). Null when no host runs. */
async function hostView(app, { measure = false } = {}) {
  if (!hosted(app) || !require('./workerhost').endpoint()) return null;
  const s = await require('./workerhost').status({ measure });
  if (!s.ok) return null;
  app._hostView = s.workers || {};
  return s;
}

function status(app) {
  return Object.keys(manifest()).map((id) => {
    const w = info(app, id);
    const p = procs(app).get(id);
    const h = (app._hostView || {})[id] || null;
    const state = h ? h.state : p ? (ready(p) ? 'HOT_IDLE' : p.dead ? 'FAILED' : 'LOADING') : 'UNLOADED';
    return {
      id, contract: w.contract, status: w.status || (w.installed ? 'INSTALLED' : 'NOT INSTALLED'), state, hosted: hosted(app), host: h,
      switch: enabledOf(app, id), enabled: w.enabled, running: ['LOADING', 'HOT_IDLE', 'INFERENCING'].includes(state), warm: ['HOT_IDLE', 'INFERENCING'].includes(state),
      gates: w.gates || {}, verdict: w.verdict || '', reason: w.reason || '',
    };
  });
}

module.exports = {
  manifest, info, uses, policyOf, enabledOf, call, warm, prewarm, stop, settle, status, stats, memoryMB, memoryMBAsync,
  hosted, spec, hostView, AVAILABLE_WITHIN_MS, indexProject, projectIndex, waitProjectIndex,
};
