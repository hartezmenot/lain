'use strict';

/**
 * THE WORKER HOST — the process that keeps a specialist model HOT between
 * LAIN processes (2026-09-23).
 *
 * ------------------------------------------------------------------------
 * WHY IT EXISTS. Laya's cold load is 30–80 s and its warm ranking is about
 * 0.2 s. Before this file the model lived inside the LAIN process: every
 * `lain` start paid the cold load again, and the first turn WAITED for it (up
 * to 90 s, measured at 32 s and 85 s in the A/B runs). A local worker may
 * shorten the critical path; it may never lengthen it because it is loading.
 *
 * So the model lives here, in one detached process per LAIN home that LAIN
 * starts and nobody has to manage by hand:
 *
 *   LAIN (CLI / Core) ──named pipe──▶ worker host ──stdin/stdout──▶ Laya (python)
 *                                                └──loopback http──▶ a llama-server worker (none since 2026-09-24)
 *
 * - NO NETWORK PORT of its own: a named pipe on Windows, a unix socket elsewhere.
 * - A SINGLETON BY CONSTRUCTION: the pipe name is derived from the host
 *   directory, and a second host that cannot listen on it exits.
 * - IT HOLDS NO AUTHORITY. It loads, answers one bounded request at a time,
 *   and unloads. It never decides whether a worker is used — LAIN's policy
 *   (workerruntime.uses) does — and it never retries a request.
 *
 * ------------------------------------------------------------------------
 * STATES, per worker:  UNLOADED → LOADING → HOT_IDLE ⇄ INFERENCING
 *                                     └──▶ FAILED        HOT_IDLE → UNLOADING → UNLOADED
 *
 * HOT_IDLE ≠ GENERATING. A hot worker holds memory and runs nothing: zero
 * inference tokens, no inference CPU.
 *
 * ------------------------------------------------------------------------
 * LIFECYCLE POLICY — deterministic, and every input is recorded:
 *
 * - LEASES. Every LAIN process that uses the host registers its pid. While
 *   any leased pid is alive the host stays up and its models stay hot.
 * - GRACE after the last client. A crashed or restarted LAIN inside the grace
 *   window finds the model still hot. The window is DERIVED FROM THE MEASURED
 *   RELOAD COST, not picked: max(2 min, 3 × the slowest load this host has
 *   measured). `LAIN_WORKERHOST_GRACE_MS` overrides it.
 * - MEMORY PRESSURE. When free system memory falls below the floor
 *   (`LAIN_WORKERHOST_MIN_FREE_MB`, default 1024) a HOT_IDLE worker is
 *   unloaded — never one that is answering — and a new load is refused
 *   until memory is back.
 * - IDLE UNLOAD while clients are alive is OFF unless a load asks for it
 *   (`idleUnloadMs`), because no measurement yet says what it should be.
 *   Idle durations and reload counts are recorded so it can be set from data.
 * - FAILURE. A worker that dies is FAILED. The host never restarts it by
 *   itself; a later `load` may, at most 3 times in 10 minutes. No retry loop.
 *
 * Every transition goes to `<dir>/events.jsonl`.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const layaindex = require('./layaindex');

const VERSION = 1;
const RESTARTS_MAX = 3;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const TICK_MS = Number(process.env.LAIN_WORKERHOST_TICK_MS) || 5000;

function argOf(k) { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : ''; }
const DIR = path.resolve(argOf('dir') || process.env.LAIN_WORKERHOST_DIR || '.');
const PIPE = require('./workerhost').pipeName(DIR);
const MIN_FREE_MB = Number(process.env.LAIN_WORKERHOST_MIN_FREE_MB) || 1024;
const GRACE_FORCED = Number(process.env.LAIN_WORKERHOST_GRACE_MS) || 0;
const startedAt = Date.now();

fs.mkdirSync(DIR, { recursive: true });
const EVENTS = path.join(DIR, 'events.jsonl');
function event(row) {
  try { fs.appendFileSync(EVENTS, JSON.stringify({ at: new Date().toISOString(), hostPid: process.pid, ...row }) + '\n'); } catch { /* measurement only */ }
}

// ---- workers ---------------------------------------------------------------

/** id → worker record. The record IS the state; `status` is a projection of it. */
const workers = new Map();

function record(id) {
  if (!workers.has(id)) {
    workers.set(id, {
      id, state: 'UNLOADED', spec: null, child: null, port: 0,
      seq: 0, waiting: new Map(), buf: '', pending: 0, queue: Promise.resolve(),
      loadStartedAt: 0, loadMs: null, loads: 0, unloads: [], failures: [], residentMB: null,
      hotSince: 0, lastUsedAt: 0, inferences: 0, idleSpans: [], lastError: '', ready: null,
      // THE PROJECT INDEX AXIS (layaindex.js): independent of the model's state.
      meta: null, projects: new Map(), indexJob: null, indexQueue: [],
    });
  }
  return workers.get(id);
}

function setState(w, state, why = '') {
  const from = w.state;
  if (from === state) return;
  const now = Date.now();
  // AN IDLE SPAN is recorded when a hot worker is asked something or unloaded:
  // how long it sat HOT_IDLE holding memory and doing nothing.
  if (from === 'HOT_IDLE') w.idleSpans.push(now - (w.lastUsedAt || w.hotSince || now));
  if (w.idleSpans.length > 200) w.idleSpans.splice(0, w.idleSpans.length - 200);
  w.state = state;
  if (state === 'HOT_IDLE' && from === 'LOADING') w.hotSince = now;
  event({ worker: w.id, from, to: state, why: why || undefined, loadMs: state === 'HOT_IDLE' && from === 'LOADING' ? w.loadMs : undefined });
}

function memoryMB(pid) { try { return require('./workerruntime').memoryMBAsync(pid); } catch { return Promise.resolve(null); } }

function recentFailures(w) { const since = Date.now() - RESTART_WINDOW_MS; return w.failures.filter((t) => t >= since).length; }

function fail(w, why) {
  if (w.state === 'UNLOADING' || w.state === 'UNLOADED') return;
  w.failures.push(Date.now());
  w.lastError = String(why || 'exited').slice(0, 300);
  for (const cb of w.waiting.values()) cb(null);
  w.waiting.clear();
  w.pending = 0;
  w.child = null;
  setState(w, 'FAILED', w.lastError);
}

/** PYTHON JSON-LINES WORKER (Laya): the load is the adapter's own `ping`, which loads the model. */
function startPython(w) {
  const s = w.spec;
  let child;
  try {
    child = spawn(s.python, [s.adapter], { env: { ...process.env, ...(s.env || {}) }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (e) { fail(w, `spawn: ${e.message}`); return; }
  w.child = child;
  child.stdout.on('data', (d) => {
    w.buf += d.toString('utf8');
    let nl;
    while ((nl = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, nl); w.buf = w.buf.slice(nl + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const cb = w.waiting.get(msg.id);
      if (cb) { w.waiting.delete(msg.id); cb(msg); }
    }
  });
  child.on('exit', (code) => { if (w.child === child) fail(w, `exited ${code}`); });
  child.on('error', (e) => { if (w.child === child) fail(w, e.message); });
  w.ready = sendPython(w, { op: 'ping' }, 15 * 60 * 1000).then((msg) => {
    // THE EMBEDDING IDENTITY the adapter reports — what stored vectors are keyed by.
    if (msg && msg.ok) w.meta = { model: msg.model || null, schema: msg.schema || null };
    return Boolean(msg && msg.ok);
  });
}

/**
 * ONE LINE TO THE PYTHON WORKER. The host's timeout ends the WAIT, not the
 * work: an abandoned request still finishes inside the worker (its embeddings
 * are then cached there), and its late answer is dropped. `pending` counts the
 * requests the worker is still working through, so the state stays
 * INFERENCING until the last one is done.
 */
function sendPython(w, req, timeoutMs) {
  const rid = ++w.seq;
  w.pending += 1;
  return new Promise((resolve) => {
    let settled = false;
    const done = (msg) => { if (!settled) { settled = true; resolve(msg); } };
    const t = setTimeout(() => done(null), timeoutMs);
    w.waiting.set(rid, (msg) => {
      clearTimeout(t);
      w.pending = Math.max(0, w.pending - 1);
      if (w.state === 'INFERENCING' && w.pending === 0) setState(w, 'HOT_IDLE');
      done(msg);
    });
    try { w.child.stdin.write(JSON.stringify({ ...req, id: rid }) + '\n'); } catch { clearTimeout(t); w.waiting.delete(rid); w.pending = Math.max(0, w.pending - 1); done(null); }
  });
}

/** LLAMA-SERVER WORKER (generic runtime): its own loopback port, polled until /health answers. */
function startLlama(w) {
  const s = w.spec;
  w.port = Number(s.port) || 8093;
  let child;
  try { child = spawn(s.server, s.args || [], { windowsHide: true, stdio: 'ignore' }); } catch (e) { fail(w, `spawn: ${e.message}`); return; }
  w.child = child;
  child.on('exit', (code) => { if (w.child === child) fail(w, `exited ${code}`); });
  child.on('error', (e) => { if (w.child === child) fail(w, e.message); });
  w.ready = (async () => {
    const until = Date.now() + 5 * 60 * 1000;
    while (w.child === child && Date.now() < until) {
      try { const r = await fetch(`http://127.0.0.1:${w.port}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch { /* loading */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })();
}

async function callLlama(w, req, timeoutMs) {
  const run = w.queue.then(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${w.port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ temperature: 0.6, top_p: 0.95, max_tokens: req.max_tokens || 6000, messages: req.messages || [] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = await res.json();
      const c = j.choices && j.choices[0];
      if (!c) return null;
      return { ok: true, text: (c.message && c.message.content) || '', finish: c.finish_reason,
        usage: { tokens_in: (j.usage && j.usage.prompt_tokens) || 0, tokens_out: (j.usage && j.usage.completion_tokens) || 0 } };
    } catch { return null; }
  });
  w.queue = run.catch(() => null);
  return run;
}

/**
 * START A LOAD, and return at once. The load finishes in the background; a
 * caller that must wait (a benchmark preparing an arm) asks `wait`.
 */
function load(id, spec, opts = {}) {
  const w = record(id);
  if (spec) w.spec = spec;
  if (opts.idleUnloadMs != null) w.idleUnloadMs = Number(opts.idleUnloadMs) || 0;
  if (['LOADING', 'HOT_IDLE', 'INFERENCING'].includes(w.state)) return { started: false, state: w.state };
  if (!w.spec) return { started: false, state: w.state, refused: 'no spec' };
  if (w.state === 'FAILED' && recentFailures(w) >= RESTARTS_MAX) {
    return { started: false, state: w.state, refused: `restart budget exhausted (${RESTARTS_MAX} failures in ${RESTART_WINDOW_MS / 60000} min)` };
  }
  const freeMB = Math.round(os.freemem() / 1048576);
  if (freeMB < MIN_FREE_MB) {
    event({ worker: id, refused: 'memory pressure', freeMB });
    return { started: false, state: w.state, refused: `memory pressure: ${freeMB} MB free < ${MIN_FREE_MB} MB` };
  }
  w.loads += 1;
  w.loadStartedAt = Date.now();
  w.loadMs = null;
  w.residentMB = null;
  w.lastError = '';
  setState(w, 'LOADING', w.loads > 1 ? `reload #${w.loads - 1}` : 'first load');
  if (w.spec.runtime === 'llama-server') startLlama(w); else startPython(w);
  if (!w.ready) return { started: false, state: w.state };
  const mine = w.child;
  w.ready.then((ok) => {
    if (w.child !== mine || w.state !== 'LOADING') return;
    if (!ok) { try { mine.kill(); } catch { /* gone */ } fail(w, 'load did not complete'); return; }
    w.loadMs = Date.now() - w.loadStartedAt;
    w.lastUsedAt = Date.now();
    setState(w, 'HOT_IDLE');
    // RESIDENT MEMORY, measured once the model is in — the whole process tree.
    memoryMB(mine.pid).then((mb) => { if (w.child === mine) w.residentMB = mb; });
  });
  return { started: true, state: w.state };
}

function unload(id, why = 'requested') {
  const w = workers.get(id);
  if (!w || !w.child) { if (w && w.state !== 'UNLOADED') setState(w, 'UNLOADED', why); return { state: w ? w.state : 'UNLOADED' }; }
  setState(w, 'UNLOADING', why);
  const child = w.child;
  w.child = null;
  for (const cb of w.waiting.values()) cb(null);
  w.waiting.clear();
  w.pending = 0;
  w.unloads.push({ at: Date.now(), why });
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* gone */ }
  setState(w, 'UNLOADED', why);
  return { state: 'UNLOADED' };
}

/**
 * ONE BOUNDED REQUEST, with the FAST RULE in front of it.
 *
 * HOT_IDLE / INFERENCING → answered. LOADING → wait at most `availableWithinMs`
 * (small) for it to become hot, else BYPASS. UNLOADED / FAILED → BYPASS at
 * once (the client may start a load for the NEXT decision). A bypass is an
 * answer, not an error: the caller carries on with its deterministic owner.
 */
async function call(id, req, { timeoutMs = 20000, availableWithinMs = 0 } = {}) {
  const w = workers.get(id);
  if (!w || !['LOADING', 'HOT_IDLE', 'INFERENCING'].includes(w.state)) return { ok: false, bypass: true, state: w ? w.state : 'UNLOADED' };
  if (w.state === 'LOADING') {
    const became = await Promise.race([
      w.ready.then(() => w.state !== 'LOADING'),
      new Promise((r) => setTimeout(() => r(false), Math.max(0, availableWithinMs))),
    ]);
    if (!became || !['HOT_IDLE', 'INFERENCING'].includes(w.state)) return { ok: false, bypass: true, state: w.state };
  }
  if (req.op === 'rank_project') return rankProject(w, req, timeoutMs);
  const t0 = Date.now();
  w.lastUsedAt = t0;
  setState(w, 'INFERENCING');
  const msg = w.spec.runtime === 'llama-server' ? await callLlama(w, req, timeoutMs) : await sendPython(w, req, timeoutMs);
  const ms = Date.now() - t0;
  w.lastUsedAt = Date.now();
  if (w.spec.runtime === 'llama-server' && w.state === 'INFERENCING') setState(w, 'HOT_IDLE');
  if (!msg) return { ok: false, timedOut: true, state: w.state, ms };
  if (req.op !== 'ping' && req.op !== 'clear') w.inferences += 1;
  return { ok: true, msg, ms, state: w.state };
}

function view(w) {
  const now = Date.now();
  return {
    id: w.id, state: w.state, runtime: w.spec ? w.spec.runtime : null, pid: w.child ? w.child.pid : null,
    loads: w.loads, reloads: Math.max(0, w.loads - 1), loadMs: w.loadMs,
    loadingForMs: w.state === 'LOADING' ? now - w.loadStartedAt : null,
    residentMB: w.residentMB, inferences: w.inferences, pending: w.pending,
    idleMs: w.state === 'HOT_IDLE' ? now - (w.lastUsedAt || w.hotSince) : null,
    idleSpans: w.idleSpans.slice(-20), unloads: w.unloads.slice(-10),
    failures: w.failures.length, recentFailures: recentFailures(w), lastError: w.lastError || null,
    embedIdentity: layaindex.embedKey(w.meta), indexing: w.indexJob ? w.indexJob.key : null,
    projects: [...w.projects.values()].map(projectView),
  };
}

// ---- the project index: the SECOND readiness axis (layaindex.js) --------------------
//
// MODEL HOT != PROJECT READY. A worker's model state (above) says whether its
// weights are resident; a PROJECT's index state says whether that project's
// files are already embedded:
//
//   ABSENT → BUILDING → READY ⇄ STALE_PARTIAL (a refresh of a usable index)
//                   └──▶ FAILED
//
// READY FOR TASK = model HOT_IDLE/INFERENCING AND index READY (or STALE_PARTIAL
// with no refresh running). The index is built HERE, in the background, when a
// project is attached — never inside a task's deadline. A task's Laya inference
// is then the QUERY embedding alone. While a build runs, the worker is busy and
// every ranking is BYPASSED at once (FAST never waits for optional embedding);
// the build carries on and the next task finds it ready.

const CACHE = layaindex.cacheRoot(DIR);
const EMBED_BATCH = 16;

function projectOf(w, root) {
  const key = layaindex.projectKey(root);
  if (!w.projects.has(key)) {
    w.projects.set(key, {
      key, root: path.resolve(root), state: 'ABSENT', generation: null, embedKey: null, dim: 0,
      byId: new Map(), vecs: new Map(), files: 0, done: 0, total: 0, builtAt: null, refreshedAt: null,
      rerun: false, queued: false, lastError: null, metrics: null, runs: 0,
    });
  }
  return w.projects.get(key);
}

function projectView(p) {
  return {
    key: p.key, root: p.root, state: p.state, files: p.files, progress: p.total ? { done: p.done, total: p.total } : null,
    generation: p.generation, embedIdentity: p.embedKey, dim: p.dim, builtAt: p.builtAt, refreshedAt: p.refreshedAt,
    queued: p.queued, lastError: p.lastError, runs: p.runs, metrics: p.metrics, lastBuild: p.lastBuild || null,
    usable: ['READY', 'STALE_PARTIAL'].includes(p.state) && p.vecs.size > 0,
  };
}

/** Ask for this project to be indexed. Returns at once; never restarts a build already running. */
function indexProject(w, root) {
  if (!root) return { started: false, refused: 'no project' };
  const p = projectOf(w, root);
  if (w.indexJob && w.indexJob.key === p.key) { p.rerun = true; return { started: false, project: projectView(p) }; }
  if (w.indexJob) {
    if (!w.indexQueue.includes(p.key)) w.indexQueue.push(p.key);
    p.queued = true;
    return { started: false, project: projectView(p) };
  }
  runIndex(w, p).catch((e) => event({ worker: w.id, indexError: String(e && e.message || e) }));
  return { started: true, project: projectView(p) };
}

async function runIndex(w, p) {
  w.indexJob = { key: p.key, startedAt: Date.now() };
  p.rerun = false;
  p.queued = false;
  p.runs += 1;
  const t0 = Date.now();
  const m = { considered: 0, indexed: 0, excluded: null, reused: 0, embedded: 0, removed: 0, restored: false, restoreMs: null, rejected: null,
    itemsMs: 0, embedMs: 0, batches: 0, tokensIn: 0, writeMs: null, cacheBytes: null, wallMs: 0, noop: false };
  const dir = layaindex.storeDir(CACHE, p.key);
  try {
    // THE MODEL FIRST: an index is built by the encoder it will be ranked with.
    if (w.state === 'LOADING' && w.ready) await w.ready;
    if (!['HOT_IDLE', 'INFERENCING'].includes(w.state) || !w.child) throw new Error(`model ${w.state}`);
    const key = layaindex.embedKey(w.meta);
    if (!key) throw new Error('the adapter reports no embedding identity (no embed op)');
    const ti = Date.now();
    const built = layaindex.items(p.root);
    m.itemsMs = Date.now() - ti;
    m.considered = built.considered;
    m.excluded = built.excluded;
    m.indexed = built.items.length;
    // A DIFFERENT ENCODER: nothing it produced before is comparable.
    if (p.embedKey && p.embedKey !== key) { p.byId = new Map(); p.vecs = new Map(); p.state = 'ABSENT'; p.embedKey = null; }
    if (p.state === 'READY' && p.generation === built.generation) { m.noop = true; return; }
    if (!p.vecs.size) {
      const rs = layaindex.readStore(dir, key);
      if (rs.ok) { p.byId = rs.byId; p.vecs = rs.vecs; p.dim = rs.dim; p.embedKey = key; m.restored = true; m.restoreMs = rs.ms; p.builtAt = Date.parse(rs.meta.writtenAt) || null; }
      else if (rs.why !== 'absent') m.rejected = rs.why;
    }
    const pl = layaindex.plan(p.byId, p.vecs, built.items);
    m.reused = pl.reuse.length;
    m.removed = pl.removed.length;
    for (const id of pl.removed) { p.byId.delete(id); p.vecs.delete(id); }
    if (pl.embed.length) p.state = p.vecs.size && p.embedKey === key ? 'STALE_PARTIAL' : 'BUILDING';
    p.total = pl.embed.length;
    p.done = 0;
    const te = Date.now();
    for (let i = 0; i < pl.embed.length; i += EMBED_BATCH) {
      const batch = pl.embed.slice(i, i + EMBED_BATCH);
      w.lastUsedAt = Date.now();
      setState(w, 'INFERENCING');
      const msg = await sendPython(w, { op: 'embed', texts: batch.map((b) => b.text) }, 10 * 60 * 1000);
      if (!msg || !msg.ok || !msg.dim) throw new Error(`embed failed${msg && msg.error ? `: ${msg.error}` : ''}`);
      const vs = layaindex.fromB64(msg.vectors, msg.dim);
      if (vs.length !== batch.length) throw new Error(`embed returned ${vs.length} vectors for ${batch.length} texts`);
      batch.forEach((it, j) => { p.byId.set(it.id, { contentHash: it.contentHash, textHash: it.textHash }); p.vecs.set(it.id, vs[j]); });
      p.dim = msg.dim;
      p.done += batch.length;
      m.embedded += batch.length;
      m.batches += 1;
      m.tokensIn += (msg.usage && msg.usage.tokens_in) || 0;
    }
    m.embedMs = Date.now() - te;
    p.embedKey = key;
    p.generation = built.generation;
    p.files = built.items.length;
    p.state = 'READY';
    p.refreshedAt = Date.now();
    if (!p.builtAt) p.builtAt = Date.now();
    p.lastError = null;
    if (m.embedded || m.removed || !m.restored) {
      const wr = layaindex.writeStore(dir, { key, dim: p.dim, root: p.root, projectKey: p.key, generation: p.generation, byId: p.byId, vecs: p.vecs, metrics: { ...m, wallMs: Date.now() - t0 } });
      m.writeMs = wr.ms;
      m.cacheBytes = wr.bytes;
    } else {
      try { m.cacheBytes = fs.statSync(path.join(dir, 'vectors.f32')).size + fs.statSync(path.join(dir, 'index.json')).size; } catch { /* measurement */ }
    }
  } catch (e) {
    p.lastError = String(e && e.message || e).slice(0, 300);
    // A FAILED REFRESH leaves a usable index usable (its stale files are never ranked).
    p.state = p.vecs.size && p.embedKey ? 'STALE_PARTIAL' : 'FAILED';
  } finally {
    p.total = 0;
    p.done = 0;
    m.wallMs = Date.now() - t0;
    p.metrics = m;
    // THE LAST RUN THAT DID WORK (built, restored, refreshed) — a later no-op check must not erase it.
    if (!m.noop) p.lastBuild = m;
    event({ worker: w.id, index: p.key, root: p.root, state: p.state, error: p.lastError || undefined, ...m, excluded: undefined });
    w.indexJob = null;
    if (p.rerun) setImmediate(() => indexProject(w, p.root));
    else if (w.indexQueue.length) { const next = w.projects.get(w.indexQueue.shift()); if (next) setImmediate(() => indexProject(w, next.root)); }
  }
}

/**
 * ONE TASK RANKING: the query's embedding (the only inference), then cosine over
 * the prepared vectors of the candidates Core chose. Not READY → BYPASS at once.
 */
async function rankProject(w, req, timeoutMs) {
  const p = w.projects.get(layaindex.projectKey(req.root || ''));
  const key = layaindex.embedKey(w.meta);
  let why = null;
  if (!p) why = 'INDEX_ABSENT';
  else if (w.indexJob) why = w.indexJob.key === p.key ? (p.state === 'STALE_PARTIAL' ? 'INDEX_REFRESHING' : 'INDEX_BUILDING') : 'INDEX_BUSY';
  else if (!['READY', 'STALE_PARTIAL'].includes(p.state) || !p.vecs.size) why = `INDEX_${p.state}`;
  else if (p.embedKey !== key) why = 'INDEX_WRONG_MODEL';
  if (why) {
    // NOT READY: bypassed now, and prepared for the next decision — never restarted.
    if (!w.indexJob && (!p || ['ABSENT', 'FAILED'].includes(p.state) || p.embedKey !== key)) indexProject(w, req.root);
    return { ok: false, bypass: true, state: why };
  }
  const t0 = Date.now();
  w.lastUsedAt = t0;
  setState(w, 'INFERENCING');
  const msg = await sendPython(w, { op: 'embed', texts: [String(req.query || '').slice(0, 600)] }, timeoutMs);
  const ms = Date.now() - t0;
  w.lastUsedAt = Date.now();
  if (!msg || !msg.ok || !msg.dim) return { ok: false, timedOut: !msg, state: w.state, ms };
  const [q] = layaindex.fromB64(msg.vectors, msg.dim);
  const tr = Date.now();
  const r = layaindex.rankCandidates(p.byId, p.vecs, q, Array.isArray(req.candidates) ? req.candidates : [], Number(req.k) || 8);
  w.inferences += 1;
  // FILES CHANGED since the index: this answer used only unchanged files; the
  // refresh runs AFTER it, so the next task sees the edit.
  if (req.generation && req.generation !== p.generation && !w.indexJob) setImmediate(() => indexProject(w, p.root));
  const u = msg.usage || {};
  return {
    ok: true, ms, state: w.state,
    msg: {
      ranked: r.ranked, n: r.scored, stale: r.stale.length, abstain: r.scored < 2, cosMs: Date.now() - tr,
      usage: { embedded: 1, tokens_in: u.tokens_in || 0, input_chars: u.input_chars || 0, output_chars: JSON.stringify(r.ranked).length },
      index: { state: p.state, generation: p.generation, files: p.files, queryOnly: true },
    },
  };
}

// ---- leases and the lifecycle tick ------------------------------------------------

const leases = new Map();   // pid → first seen
let noClientsSince = Date.now();

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function graceMs() {
  if (GRACE_FORCED) return GRACE_FORCED;
  const slowest = Math.max(0, ...[...workers.values()].map((w) => w.loadMs || 0));
  return Math.max(120000, 3 * slowest);
}

function tick() {
  for (const pid of leases.keys()) if (!alive(pid)) { leases.delete(pid); event({ leaseEnded: pid }); }
  const now = Date.now();
  if (leases.size) noClientsSince = 0; else if (!noClientsSince) noClientsSince = now;
  const freeMB = Math.round(os.freemem() / 1048576);
  for (const w of workers.values()) {
    if (w.state !== 'HOT_IDLE') continue;
    if (freeMB < MIN_FREE_MB) { unload(w.id, `memory pressure: ${freeMB} MB free < ${MIN_FREE_MB} MB`); continue; }
    if (w.idleUnloadMs && now - (w.lastUsedAt || w.hotSince) > w.idleUnloadMs) unload(w.id, `idle ${Math.round((now - w.lastUsedAt) / 1000)} s`);
  }
  if (noClientsSince && now - noClientsSince > graceMs()) shutdown(`no LAIN client for ${Math.round((now - noClientsSince) / 1000)} s (grace ${Math.round(graceMs() / 1000)} s)`);
}

let closing = false;
function shutdown(why) {
  if (closing) return;
  closing = true;
  for (const id of workers.keys()) unload(id, `host exit: ${why}`);
  event({ hostExit: why });
  try { server.close(); } catch { /* closing */ }
  try { const f = path.join(DIR, 'endpoint.json'); const v = JSON.parse(fs.readFileSync(f, 'utf8')); if (v.pid === process.pid) fs.unlinkSync(f); } catch { /* gone */ }
  setTimeout(() => process.exit(0), 300).unref();
}

// ---- the wire -------------------------------------------------------------------

async function handle(q) {
  if (q.client) { const pid = Number(q.client); if (pid && !leases.has(pid)) { leases.set(pid, Date.now()); event({ leaseStarted: pid }); } noClientsSince = 0; }
  switch (q.op) {
    case 'ping': return { ok: true, pid: process.pid, version: VERSION, uptimeMs: Date.now() - startedAt };
    case 'lease': return { ok: true, leases: leases.size };
    case 'status': {
      if (q.measure) {
        await Promise.all([...workers.values()].filter((w) => w.child && ['HOT_IDLE', 'INFERENCING'].includes(w.state))
          .map(async (w) => { const mb = await memoryMB(w.child.pid); if (mb) w.residentMB = mb; }));
      }
      return { ok: true, pid: process.pid, uptimeMs: Date.now() - startedAt, leases: [...leases.keys()], graceMs: graceMs(), minFreeMB: MIN_FREE_MB,
        freeMB: Math.round(os.freemem() / 1048576), workers: Object.fromEntries([...workers.values()].map((w) => [w.id, view(w)])) };
    }
    case 'load': return { ok: true, ...load(String(q.id), q.spec || null, q) };
    case 'wait': {
      // FOR A BENCHMARK OR A DIAGNOSTIC ONLY: block until the worker is hot (or failed).
      const w = workers.get(String(q.id));
      if (!w) return { ok: false, state: 'UNLOADED' };
      if (w.state === 'LOADING') await require('./deadline').race(w.ready, Number(q.timeoutMs) || 600000);
      return { ok: ['HOT_IDLE', 'INFERENCING'].includes(w.state), ...view(w) };
    }
    case 'call': return call(String(q.id), q.req || {}, q);
    case 'index': return { ok: true, ...indexProject(record(String(q.id)), String(q.root || '')) };
    case 'index_status': {
      const w = workers.get(String(q.id));
      const ps = w ? [...w.projects.values()] : [];
      const pick = q.root ? ps.filter((p) => p.key === layaindex.projectKey(q.root)) : ps;
      return { ok: true, model: w ? w.state : 'UNLOADED', embedIdentity: w ? layaindex.embedKey(w.meta) : null, indexing: w && w.indexJob ? w.indexJob.key : null, projects: pick.map(projectView) };
    }
    case 'index_wait': {
      // FOR A BENCHMARK OR A DIAGNOSTIC ONLY: block until this project's index settles.
      const w = workers.get(String(q.id));
      const key = layaindex.projectKey(q.root || '');
      const until = Date.now() + (Number(q.timeoutMs) || 600000);
      while (Date.now() < until) {
        const p = w && w.projects.get(key);
        if (p && !(w.indexJob && w.indexJob.key === key) && !p.rerun && ['READY', 'FAILED'].includes(p.state)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const p = w && w.projects.get(key);
      return { ok: Boolean(p && p.state === 'READY'), model: w ? w.state : 'UNLOADED', project: p ? projectView(p) : null };
    }
    case 'unload': return { ok: true, ...unload(String(q.id), q.why || 'requested') };
    case 'shutdown': shutdown(q.why || 'requested'); return { ok: true };
    default: return { ok: false, error: `unknown op ${q.op}` };
  }
}

const server = net.createServer((sock) => {
  let buf = '';
  sock.on('data', async (d) => {
    buf += d.toString('utf8');
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const line = buf.slice(0, nl);
    buf = '';
    let reply;
    try { reply = await handle(JSON.parse(line)); } catch (e) { reply = { ok: false, error: String(e && e.message || e).slice(0, 300) }; }
    try { sock.end(JSON.stringify(reply) + '\n'); } catch { /* client gone */ }
  });
  sock.on('error', () => { /* a client that went away */ });
});

server.on('error', (e) => {
  // ANOTHER HOST ALREADY OWNS THIS PIPE: that one serves, this one leaves.
  if (e && e.code === 'EADDRINUSE') process.exit(0);
  event({ hostError: String(e && e.message || e) });
  process.exit(1);
});

if (process.platform !== 'win32') { try { fs.unlinkSync(PIPE); } catch { /* none */ } }
server.listen(PIPE, () => {
  fs.writeFileSync(path.join(DIR, 'endpoint.json'), JSON.stringify({ pid: process.pid, pipe: PIPE, version: VERSION, startedAt: new Date(startedAt).toISOString() }));
  event({ hostStarted: PIPE, graceMs: graceMs(), minFreeMB: MIN_FREE_MB });
});
setInterval(tick, TICK_MS);
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { event({ hostError: String(e && e.stack || e).slice(0, 600) }); });
