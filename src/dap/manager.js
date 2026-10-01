'use strict';

/**
 * THE DEBUGGER — Debug Adapter Protocol sessions for /focus (2026-09-25).
 *
 *     IDE Debug panel ─┐                      ┌─ debugpy (Python)
 *     house door ──────┼─ this manager ─ DAP ─┼─ any configured adapter
 *     (debug.context)  ┘                      └─ (dap.adapters in config)
 *
 * WHAT IT DOES: launch a program under an adapter, set breakpoints, continue,
 * step over / into / out, pause, read the call stack, scopes and variables,
 * evaluate watch and debug-console expressions, collect the program's output,
 * and terminate.
 *
 * ADAPTERS ARE FOUND, NOT DOWNLOADED. Python uses debugpy when the project's
 * Python (dap.python, or `python` on PATH) can import it; anything else is a
 * configured adapter `{ id, name, command, args, types, extensions, launch }`
 * that speaks DAP over stdio. Node's js-debug speaks DAP over a TCP port, not
 * stdio, and is not wired: a .js launch says so instead of pretending.
 *
 * OWNED AND ISOLATED. Every adapter process is recorded in runtimeregistry.js
 * (purpose 'debug-adapter', stopped with its owner and its project). An adapter
 * that crashes ends its session with the reason; LAIN and the editor carry on.
 *
 * DEBUG CONTEXT IS ASKED FOR, NEVER INJECTED. `context()` is the compact paused
 * state — the stop reason, the frame and location, the top of the stack, the
 * frame's variables, a few source lines — served through the `debug.context`
 * house door when the BOT or the person asks ("why is this null here?"). No
 * model turn receives debug state it did not request.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DapClient } = require('./client');

const STATE = Object.freeze({ STARTING: 'STARTING', RUNNING: 'RUNNING', PAUSED: 'PAUSED', ENDED: 'ENDED', FAILED: 'FAILED' });
const MAX_OUTPUT = 400;
const MAX_VARS = 60;
const MAX_FRAMES = 30;

function cfg(app) { return (app && ((app._sibling || app).cfg || app.cfg)) || {}; }
function project(app) {
  try { const p = require('../sessionviews').project(app.session); return p.attached && !p.missing ? app.session.cwd : null; } catch { return null; }
}

// ---- adapters ----------------------------------------------------------------------------

const pyCache = new Map();
const pyChecking = new Set();
/**
 * Is debugpy importable? `wait: false` (a status read — the Harness asks with every state poll) never blocks: the
 * first ask starts the check in the background and answers `checking`; the answer is cached when it lands. Starting a
 * debugger (`wait: true`) still needs the real answer and waits for it (2026-10-01: a blocking ~280 ms Python spawn
 * inside the first /api/state).
 */
function debugpyFor(python, { wait = true } = {}) {
  if (pyCache.has(python)) return pyCache.get(python);
  if (!wait) {
    if (!pyChecking.has(python)) {
      pyChecking.add(python);
      const c = require('child_process').spawn(python, ['-c', 'import debugpy,sys;print(debugpy.__version__)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('error', () => { pyCache.set(python, { ok: false, why: `${python} was not found` }); pyChecking.delete(python); });
      c.on('close', (code) => { if (!pyCache.has(python)) pyCache.set(python, code === 0 ? { ok: true, why: `debugpy ${out.trim()}` } : { ok: false, why: 'debugpy is not installed for that Python (pip install debugpy)' }); pyChecking.delete(python); });
      c.unref();
    }
    return { ok: false, why: 'checking for debugpy…' };
  }
  let ok = false;
  let why = '';
  try {
    const r = spawnSync(python, ['-c', 'import debugpy,sys;print(debugpy.__version__)'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    ok = r.status === 0;
    why = ok ? `debugpy ${String(r.stdout).trim()}` : (r.error ? `${python} was not found` : 'debugpy is not installed for that Python (pip install debugpy)');
  } catch (e) { why = e.message; }
  const v = { ok, why };
  pyCache.set(python, v);
  return v;
}

/** The adapters this machine can run, each with whether it can start and why not. */
function adapters(app, { wait = true } = {}) {
  const c = cfg(app).dap || {};
  const out = [];
  for (const a of Array.isArray(c.adapters) ? c.adapters : []) {
    if (!a || !a.id || !a.command) continue;
    out.push({ id: String(a.id), name: a.name || a.id, command: String(a.command), args: (a.args || []).map(String), types: (a.types || []).map(String), extensions: (a.extensions || []).map(String), launch: a.launch || {}, configured: true, available: true, why: '' });
  }
  if (!out.some((a) => a.id === 'python')) {
    const python = c.python || 'python';
    const d = debugpyFor(python, { wait });
    out.push({ id: 'python', name: 'Python (debugpy)', command: python, args: ['-m', 'debugpy.adapter'], types: ['python'], extensions: ['.py'], launch: { type: 'python', console: 'internalConsole', justMyCode: true }, configured: false, available: d.ok, why: d.ok ? d.why : d.why });
  }
  if (!out.some((a) => a.extensions.includes('.js'))) {
    out.push({ id: 'node', name: 'Node (js-debug)', command: null, args: [], types: ['node'], extensions: ['.js', '.mjs', '.cjs', '.ts'], launch: {}, configured: false, available: false, why: 'js-debug speaks DAP over a TCP port; Noema attaches stdio adapters only — configure one in dap.adapters' });
  }
  return out;
}

function adapterFor(app, program, id = null) {
  const list = adapters(app);
  if (id) return list.find((a) => a.id === id) || null;
  const ext = path.extname(String(program || '')).toLowerCase();
  return list.find((a) => a.extensions.includes(ext)) || null;
}

// ---- breakpoints (kept per project, sent to every session) --------------------------------

const breakpoints = new Map();   // project root -> Map(abs file -> [{line, condition}])
function bpsOf(root) { if (!breakpoints.has(root)) breakpoints.set(root, new Map()); return breakpoints.get(root); }

// ---- sessions ------------------------------------------------------------------------------

const sessions = new Map();   // id -> record
let seq = 0;

function current(app) {
  const root = project(app);
  const list = [...sessions.values()].filter((s) => s.root === root);
  return list.filter((s) => s.state !== STATE.ENDED && s.state !== STATE.FAILED).pop() || list.pop() || null;
}

function note(rec, category, text) {
  rec.output.push({ at: Date.now(), category: category || 'console', text: String(text).slice(0, 4000) });
  if (rec.output.length > MAX_OUTPUT) rec.output.splice(0, rec.output.length - MAX_OUTPUT);
}

async function sendBreakpoints(rec, abs) {
  const list = bpsOf(rec.root).get(abs) || [];
  try {
    const r = await rec.client.request('setBreakpoints', { source: { path: abs, name: path.basename(abs) }, breakpoints: list.map((b) => ({ line: b.line, condition: b.condition || undefined })), sourceModified: false });
    rec.verified.set(abs, (r.breakpoints || []).map((b, i) => ({ line: b.line || list[i].line, verified: Boolean(b.verified), message: b.message || '' })));
  } catch (e) { note(rec, 'lain', `breakpoints in ${path.basename(abs)}: ${e.message}`); }
}

async function readPausedState(rec, threadId) {
  const c = rec.client;
  try {
    const t = await c.request('threads');
    rec.threads = (t.threads || []).map((x) => ({ id: x.id, name: x.name }));
    const tid = threadId || (rec.threads[0] && rec.threads[0].id);
    rec.threadId = tid;
    const st = await c.request('stackTrace', { threadId: tid, startFrame: 0, levels: MAX_FRAMES });
    rec.stack = (st.stackFrames || []).map((f) => ({ id: f.id, name: f.name, path: f.source && f.source.path ? f.source.path : null, line: f.line, col: f.column }));
    rec.frameId = rec.stack[0] ? rec.stack[0].id : null;
    rec.scopes = [];
    rec.variables = {};
    if (rec.frameId != null) {
      const sc = await c.request('scopes', { frameId: rec.frameId });
      rec.scopes = (sc.scopes || []).map((s) => ({ name: s.name, ref: s.variablesReference, expensive: Boolean(s.expensive) }));
      for (const s of rec.scopes.filter((x) => !x.expensive).slice(0, 2)) rec.variables[s.ref] = await variables(rec, s.ref);
    }
    rec.watchValues = {};
    for (const w of rec.watches) rec.watchValues[w] = await evaluate(rec, w, 'watch');
  } catch (e) { note(rec, 'lain', `reading the paused state: ${e.message}`); }
}

async function variables(rec, ref) {
  try {
    const r = await rec.client.request('variables', { variablesReference: ref });
    return (r.variables || []).slice(0, MAX_VARS).map((v) => ({ name: v.name, value: String(v.value).slice(0, 400), type: v.type || null, ref: v.variablesReference || 0 }));
  } catch (e) { return [{ name: '(error)', value: e.message, type: null, ref: 0 }]; }
}

async function evaluate(rec, expression, context = 'repl') {
  try {
    const r = await rec.client.request('evaluate', { expression: String(expression), frameId: rec.frameId != null ? rec.frameId : undefined, context });
    return { ok: true, value: String(r.result).slice(0, 2000), type: r.type || null, ref: r.variablesReference || 0 };
  } catch (e) { return { ok: false, value: e.message }; }
}

/** LAUNCH a program under its adapter. Resolves once the program is running or paused. */
async function start(app, { program, adapter = null, args = [], cwd = null, stopOnEntry = false } = {}) {
  const root = project(app);
  if (!root) return { ok: false, why: 'no project is open' };
  const abs = path.resolve(root, String(program || ''));
  const rel = path.relative(root, abs);
  if (!program || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, why: 'give a program inside the project' };
  if (!fs.existsSync(abs)) return { ok: false, why: `${rel} does not exist` };
  const a = adapterFor(app, abs, adapter);
  if (!a) return { ok: false, why: `no debug adapter for ${path.extname(abs) || 'this file'}` };
  if (!a.available) return { ok: false, why: `${a.name}: ${a.why}`, notInstalled: true };
  const prev = current(app);
  if (prev && prev.state !== STATE.ENDED && prev.state !== STATE.FAILED) await stop(app, prev.id);
  seq += 1;
  const rec = {
    id: `D${seq}`, root, adapter: a.id, adapterName: a.name, program: rel.split(path.sep).join('/'), state: STATE.STARTING, why: '',
    output: [], threads: [], stack: [], scopes: [], variables: {}, watches: (prev && prev.watches) || [], watchValues: {}, verified: new Map(),
    stopped: null, frameId: null, threadId: null, startedAt: Date.now(), client: null, pid: null,
  };
  sessions.set(rec.id, rec);
  const client = new DapClient({
    id: a.id, command: a.command, args: a.args, cwd: cwd ? path.resolve(root, cwd) : root,
    onLog: (t) => note(rec, 'adapter', t),
    onExit: (info) => {
      if (rec.state !== STATE.ENDED) { rec.state = rec.state === STATE.STARTING ? STATE.FAILED : STATE.ENDED; rec.why = rec.why || `the adapter stopped${info && info.code != null ? ` (exit ${info.code})` : info && info.error ? ` (${info.error})` : ''}`; }
    },
    onEvent: (event, body) => {
      if (event === 'output') note(rec, body.category, body.output);
      else if (event === 'stopped') { rec.state = STATE.PAUSED; rec.stopped = { reason: body.reason, description: body.description || null, threadId: body.threadId, at: Date.now() }; rec.pausing = readPausedState(rec, body.threadId); }
      else if (event === 'continued') { rec.state = STATE.RUNNING; rec.stopped = null; }
      else if (event === 'terminated' || event === 'exited') { if (event === 'exited') note(rec, 'lain', `program exited with code ${body.exitCode}`); rec.state = STATE.ENDED; rec.why = rec.why || (event === 'exited' ? `exited with code ${body.exitCode}` : 'terminated'); }
      else if (event === 'initialized') { rec.initializedSeen = true; if (rec.onInitialized) rec.onInitialized(); }
    },
  });
  rec.client = client;
  let child;
  try { child = client.start(); } catch (e) { rec.state = STATE.FAILED; rec.why = e.message; return { ok: false, why: e.message, session: view(rec) }; }
  rec.pid = child.pid;
  try {
    rec.runtimeId = require('../runtimeregistry').register(child, {
      purpose: 'debug-adapter', label: `${a.name} · ${rec.program}`, project: root, command: [a.command, ...a.args].join(' '),
      policy: { onOwnerExit: 'stop', onProjectClose: true },
    });
  } catch { /* the session still runs; it is simply not listed */ }
  try {
    await client.initialize();
    const initialized = new Promise((res) => { if (rec.initializedSeen) res(); else rec.onInitialized = res; });
    const launch = client.request('launch', { ...a.launch, request: 'launch', program: abs, args: (args || []).map(String), cwd: cwd ? path.resolve(root, cwd) : root, stopOnEntry: Boolean(stopOnEntry), name: `Noema: ${rec.program}` }, 60_000);
    launch.catch(() => {});
    await require('../deadline').race(Promise.race([initialized, launch.then(() => initialized)]), 30_000, () => { throw new Error('the adapter never became ready'); });
    for (const file of bpsOf(root).keys()) await sendBreakpoints(rec, file);
    if (client.capabilities.exceptionBreakpointFilters) { try { await client.request('setExceptionBreakpoints', { filters: [] }); } catch { /* optional */ } }
    if (client.capabilities.supportsConfigurationDoneRequest !== false) await client.request('configurationDone', {});
    await launch;
    if (rec.state === STATE.STARTING) rec.state = STATE.RUNNING;
    await settle(rec);
    return { ok: true, session: view(rec) };
  } catch (e) {
    rec.state = STATE.FAILED;
    rec.why = e.message;
    client.kill();
    return { ok: false, why: `${a.name}: ${e.message}`, session: view(rec) };
  }
}

/** Wait briefly for the first stop / end after an action, so the answer describes the new state. */
async function settle(rec, ms = 1500) {
  const end = Date.now() + ms;
  const from = rec.state;
  while (Date.now() < end && rec.state === from && rec.state === STATE.RUNNING) await new Promise((r) => setTimeout(r, 50));
  if (rec.pausing) { await rec.pausing; rec.pausing = null; }
}

function recOf(app, id) { return id ? sessions.get(String(id)) || null : current(app); }

async function control(app, action, { id = null } = {}) {
  const rec = recOf(app, id);
  if (!rec || !rec.client || rec.client.exited) return { ok: false, why: 'no debug session is running' };
  const tid = rec.threadId || (rec.stopped && rec.stopped.threadId) || (rec.threads[0] && rec.threads[0].id) || 1;
  const cmd = { continue: 'continue', next: 'next', stepIn: 'stepIn', stepOut: 'stepOut', pause: 'pause' }[action];
  if (!cmd) return { ok: false, why: `unknown action ${action}` };
  if (cmd !== 'pause' && rec.state !== STATE.PAUSED) return { ok: false, why: 'the program is not paused' };
  try {
    if (cmd !== 'pause') { rec.state = STATE.RUNNING; rec.stopped = null; }
    await rec.client.request(cmd, { threadId: tid });
    await settle(rec, cmd === 'continue' ? 2000 : 1500);
    return { ok: true, session: view(rec) };
  } catch (e) { return { ok: false, why: e.message, session: view(rec) }; }
}

/** Set the breakpoints of one file (1-based lines); sent to the running session too. */
async function setBreakpoints(app, file, lines = []) {
  const root = project(app);
  if (!root) return { ok: false, why: 'no project is open' };
  const abs = path.resolve(root, String(file));
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, why: 'that file is not inside the project' };
  const list = [...new Set((lines || []).map((l) => (typeof l === 'object' ? l : { line: l })).filter((b) => Number(b.line) > 0).map((b) => JSON.stringify({ line: Number(b.line), condition: b.condition || null })))].map((x) => JSON.parse(x)).sort((x, y) => x.line - y.line);
  if (list.length) bpsOf(root).set(abs, list); else bpsOf(root).delete(abs);
  const rec = current(app);
  if (rec && rec.client && !rec.client.exited && rec.state !== STATE.STARTING) await sendBreakpoints(rec, abs);
  return { ok: true, file: rel.split(path.sep).join('/'), breakpoints: list, verified: rec ? rec.verified.get(abs) || null : null };
}

function listBreakpoints(app) {
  const root = project(app);
  if (!root) return [];
  return [...bpsOf(root).entries()].map(([abs, list]) => ({ file: path.relative(root, abs).split(path.sep).join('/'), lines: list.map((b) => b.line), conditions: list.filter((b) => b.condition).map((b) => ({ line: b.line, condition: b.condition })) }));
}

async function evaluateIn(app, expression, { id = null, context = 'repl' } = {}) {
  const rec = recOf(app, id);
  if (!rec || !rec.client || rec.client.exited) return { ok: false, why: 'no debug session is running' };
  const r = await evaluate(rec, expression, context);
  if (context === 'repl') note(rec, 'repl', `> ${expression}\n${r.value}`);
  return { ...r, session: view(rec) };
}

async function expand(app, ref, { id = null } = {}) {
  const rec = recOf(app, id);
  if (!rec || !rec.client || rec.client.exited) return { ok: false, why: 'no debug session is running' };
  return { ok: true, variables: await variables(rec, Number(ref)) };
}

async function selectFrame(app, frameId, { id = null } = {}) {
  const rec = recOf(app, id);
  if (!rec || rec.state !== STATE.PAUSED) return { ok: false, why: 'the program is not paused' };
  rec.frameId = Number(frameId);
  try {
    const sc = await rec.client.request('scopes', { frameId: rec.frameId });
    rec.scopes = (sc.scopes || []).map((s) => ({ name: s.name, ref: s.variablesReference, expensive: Boolean(s.expensive) }));
    rec.variables = {};
    for (const s of rec.scopes.filter((x) => !x.expensive).slice(0, 2)) rec.variables[s.ref] = await variables(rec, s.ref);
  } catch (e) { return { ok: false, why: e.message }; }
  return { ok: true, session: view(rec) };
}

async function setWatches(app, watches = [], { id = null } = {}) {
  const rec = recOf(app, id);
  if (!rec) return { ok: false, why: 'no debug session' };
  rec.watches = (watches || []).map(String).filter(Boolean).slice(0, 20);
  rec.watchValues = {};
  if (rec.state === STATE.PAUSED) for (const w of rec.watches) rec.watchValues[w] = await evaluate(rec, w, 'watch');
  return { ok: true, session: view(rec) };
}

async function stop(app, id = null) {
  const rec = recOf(app, id);
  if (!rec || !rec.client) return { ok: true, already: true };
  if (!rec.client.exited) {
    try {
      if (rec.client.capabilities.supportsTerminateRequest) await rec.client.request('terminate', {}, 3000);
      else await rec.client.request('disconnect', { terminateDebuggee: true }, 3000);
    } catch { /* it is being stopped either way */ }
    setTimeout(() => rec.client.kill(), 1500).unref();
  }
  rec.state = STATE.ENDED;
  rec.why = rec.why || 'stopped by the person';
  return { ok: true, session: view(rec) };
}

async function stopAll() { for (const rec of sessions.values()) { try { await stop(null, rec.id); } catch { /* gone */ } } }

// ---- projections -----------------------------------------------------------------------------

/** A path as the project spells it — adapters report the real (long) path, the session may hold a short one. */
function rel(rec, p) {
  if (!p) return null;
  if (!rec.realRoot) { try { rec.realRoot = fs.realpathSync.native(rec.root); } catch { rec.realRoot = rec.root; } }
  for (const base of [rec.realRoot, rec.root]) {
    const r = path.relative(base, p);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/');
  }
  return p;
}

function view(rec) {
  if (!rec) return null;
  return {
    id: rec.id, adapter: rec.adapter, adapterName: rec.adapterName, program: rec.program, state: rec.state, why: rec.why, pid: rec.pid,
    stopped: rec.stopped, threads: rec.threads, frameId: rec.frameId,
    stack: rec.stack.map((f) => ({ ...f, path: rel(rec, f.path) })),
    scopes: rec.scopes.map((s) => ({ ...s, variables: rec.variables[s.ref] || null })),
    watches: rec.watches.map((w) => ({ expression: w, ...(rec.watchValues[w] || { ok: null, value: '' }) })),
    output: rec.output.slice(-200),
    breakpoints: [...rec.verified.entries()].map(([abs, list]) => ({ file: rel(rec, abs), list })),
  };
}

function status(app) {
  const rec = current(app);
  return { adapters: adapters(app, { wait: false }).map((a) => ({ id: a.id, name: a.name, available: a.available, why: a.why, configured: a.configured, extensions: a.extensions, types: a.types })), session: view(rec), breakpoints: listBreakpoints(app) };
}

/**
 * THE PAUSED STATE, COMPACT — for "why is this null here?". Only what a
 * question about the current stop needs: why it stopped, where, the frames above
 * it, the frame's variables and the lines around the stop. Bounded.
 */
function context(app) {
  const rec = current(app);
  if (!rec) return { ok: true, paused: false, text: 'No debug session is running.' };
  if (rec.state !== STATE.PAUSED) return { ok: true, paused: false, text: `Debug session ${rec.id} (${rec.program}) is ${rec.state.toLowerCase()}${rec.why ? `: ${rec.why}` : ''}.` };
  const top = rec.stack.find((f) => f.id === rec.frameId) || rec.stack[0] || null;
  const out = [`Paused (${rec.stopped ? rec.stopped.reason : 'paused'}${rec.stopped && rec.stopped.description ? `: ${rec.stopped.description}` : ''}) in ${rec.program} under ${rec.adapterName}.`];
  if (top) {
    out.push(`Frame: ${top.name} at ${rel(rec, top.path) || '?'}:${top.line}`);
    try {
      const lines = fs.readFileSync(top.path, 'utf8').split(/\r?\n/);
      const from = Math.max(0, top.line - 4);
      out.push('Source:', ...lines.slice(from, top.line + 2).map((l, i) => `${from + i + 1 === top.line ? '>' : ' '} ${String(from + i + 1).padStart(4)}  ${l}`));
    } catch { /* source not readable */ }
  }
  if (rec.stack.length > 1) out.push('Call stack:', ...rec.stack.slice(0, 8).map((f) => `  ${f.name} — ${rel(rec, f.path) || '?'}:${f.line}`));
  // ONE LINE PER VARIABLE: an adapter's grouping rows ("special variables") and a
  // name already shown in an inner scope are left out.
  const shown = new Set();
  for (const s of rec.scopes) {
    const vars = (rec.variables[s.ref] || []).filter((v) => !(v.value === '' && v.ref) && !shown.has(v.name));
    if (!vars.length) continue;
    for (const v of vars) shown.add(v.name);
    out.push(`${s.name}:`, ...vars.slice(0, 30).map((v) => `  ${v.name} = ${v.value.slice(0, 120)}${v.type ? ` (${v.type})` : ''}`));
  }
  if (rec.watches.length) out.push('Watches:', ...rec.watches.map((w) => `  ${w} = ${(rec.watchValues[w] || {}).value || '?'}`));
  return { ok: true, paused: true, session: rec.id, text: out.join('\n') };
}

/** Where the program is paused, or null — cheap (no adapter probing), for the per-turn packet. */
function pausedAt(app) {
  const rec = current(app);
  if (!rec || rec.state !== STATE.PAUSED || !rec.stack.length) return null;
  const top = rec.stack.find((f) => f.id === rec.frameId) || rec.stack[0];
  return { session: rec.id, program: rec.program, reason: rec.stopped ? rec.stopped.reason : 'paused', path: rel(rec, top.path), line: top.line, frame: top.name };
}

function _reset() { sessions.clear(); breakpoints.clear(); pyCache.clear(); }

module.exports = { STATE, adapters, start, control, setBreakpoints, listBreakpoints, evaluate: evaluateIn, expand, selectFrame, setWatches, stop, stopAll, status, context, pausedAt, _reset };
