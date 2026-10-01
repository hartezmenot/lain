'use strict';

/**
 * THE EXTENSION HOST SUPERVISOR — Core's side of every running extension.
 *
 *     LAIN Core ── manager.js ──IPC── host.js (one Node process per extension)
 *                     │                 └─ the extension's own code
 *                     └─ permission bridge: every workspace read/write, file
 *                        search and edit the extension asks for is checked
 *                        against its GRANT here, inside the workspace only
 *
 * ------------------------------------------------------------------------
 * PERMISSIONS, AND ONLY THE ENFORCEABLE ONES (extensions.js stores the grant):
 *
 *   read       the extension may read project files (vscode.workspace.fs /
 *              openTextDocument, and Node's own fs via --allow-fs-read)
 *   write      it may change project files (applyEdit, fs.writeFile — and
 *              --allow-fs-write on the workspace). Its edits are recorded in
 *              the provenance ledger as EXTENSION.
 *   processes  it may start programs (--allow-child-process) — what a language
 *              server or a formatter binary needs
 *
 * The open documents it is told about need no grant: they are what is on
 * screen. NETWORK CANNOT BE RESTRICTED by the Node runtime LAIN ships with, so
 * it is not offered as a permission; the Extensions view says plainly that
 * extension code can reach the network.
 *
 * ------------------------------------------------------------------------
 * CRASHES AND HANGS stay inside the host. An exit is a CRASHED state with a
 * restart (at most 3 in 2 minutes, then STOPPED with the reason); a command
 * that does not answer in COMMAND_TIMEOUT_MS is a HUNG host, which is stopped
 * and restarted. LAIN itself never waits on an extension.
 *
 * OWNERSHIP: every host is recorded in runtimeregistry.js (purpose
 * 'extension-host', stopped when LAIN exits), never found by process name.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');

const COMMAND_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 20_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 120_000;
const MAX_LOG = 300;
const HOST = require.resolve('./host');

const STATE = Object.freeze({ STARTING: 'STARTING', RUNNING: 'RUNNING', CRASHED: 'CRASHED', HUNG: 'HUNG', STOPPED: 'STOPPED', FAILED: 'FAILED' });

const hosts = new Map();   // key `${scope}:${id}` -> host record

function project(app) {
  try { const p = require('../sessionviews').project(app.session); return p.attached && !p.missing ? app.session.cwd : null; } catch { return null; }
}
function extDir(entry, app) {
  const root = require('../extensions').rootFor(entry.scope, { project: project(app) });
  return root ? path.join(root, entry.dir) : null;
}
function readPkg(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; } }
function storageDir(id) { const d = path.join(require('../config').configDir(), 'extension-storage', id.replace(/[^\w.-]/g, '_')); fs.mkdirSync(d, { recursive: true }); return d; }
function stateFile(id) { return path.join(storageDir(id), 'state.json'); }
function inside(root, p) {
  if (!root || !p) return null;
  const abs = path.resolve(root, String(p));
  const rel = path.relative(root, abs);
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;
}

/** The grant as stored, normalised. Nothing is granted by default. */
function grantOf(entry) {
  const g = (entry && entry.grant) || {};
  return { read: g.read === true, write: g.write === true, processes: g.processes === true };
}

/** What an extension could use in LAIN, from its manifest — before it runs. */
/**
 * HOW MUCH OF THIS EXTENSION WORKS IN LAIN — FULL, PARTIAL or UNSUPPORTED, with
 * the rows that decide it. `scan` is surface.scanExtension: the vscode APIs its
 * code references that LAIN does not provide are listed by name, before it runs.
 */
function compatibility(pkg, record = null, scan = null) {
  const c = (pkg && pkg.contributes) || {};
  const rows = [];
  const yes = (what) => rows.push({ ok: true, what });
  const no = (what, why) => rows.push({ ok: false, what, why });
  if (pkg && (pkg.main || pkg.browser)) {
    if (pkg.main) yes('runs its code (extension host, API 0.1)'); else no('runs its code', 'a web-only extension (browser entry); Noema runs Node extensions');
  }
  if (Array.isArray(c.commands) && c.commands.length) yes(`${c.commands.length} command(s)`);
  if (Array.isArray(c.snippets) && c.snippets.length) yes('snippets');
  if (c.configuration) yes('configuration defaults');
  if (Array.isArray(c.languages) && c.languages.length) yes(`${c.languages.length} language(s): file associations applied to the editor (colouring needs a grammar)`);
  if (c.grammars) no('TextMate grammars', 'not applied to the editor yet');
  if (c.themes) yes('color themes: editor colours, chosen in Settings › Appearance (read as data; no code runs)');
  if (c.views || c.viewsContainers) no('tree views / view containers', 'no view API in Noema');
  if (c.customEditors) no('custom editors', 'no custom editor API');
  if (c.debuggers) no('debuggers', 'debug adapters contributed by extensions are not wired; Noema attaches stdio debug adapters itself (Settings › Debugging)');
  if (c.keybindings) no('keybindings', 'contributed keybindings are not applied');
  if (c.menus) no('menus', 'contributed menus are not shown');
  const dependsOnClient = pkg && pkg.dependencies && (pkg.dependencies['vscode-languageclient'] || pkg.dependencies['vscode-languageserver']);
  if (dependsOnClient) no('language client', 'vscode-languageclient needs APIs Noema does not provide yet; Noema attaches language servers itself (Language Servers in Settings)');
  if (scan && scan.ok) {
    if (scan.missing.length) no(`${scan.missing.length} vscode API(s) its code references`, `not in Noema's API (static scan of ${scan.file}): ${scan.missing.slice(0, 12).join(', ')}${scan.missing.length > 12 ? ` (+${scan.missing.length - 12} more)` : ''}`);
    else if (scan.used.length) yes(`every vscode API its code references (${scan.used.length}, static scan)`);
  }
  if (record) {
    if (record.activation) rows.push(record.activation.ok ? { ok: true, what: 'activation' } : { ok: false, what: 'activation', why: record.activation.why });
    for (const api of [...record.unsupported]) rows.push({ ok: false, what: `vscode.${api}`, why: 'called at runtime; not in Noema\'s API' });
    if (record.diagnostics.size) rows.push({ ok: true, what: 'diagnostics' });
    for (const k of Object.keys(record.providers)) rows.push({ ok: true, what: `${k} provider` });
  }
  const bad = rows.filter((r) => !r.ok).length;
  const good = rows.filter((r) => r.ok).length;
  return { level: !good ? 'UNSUPPORTED' : bad ? 'PARTIAL' : 'FULL', rows, missingApis: scan && scan.ok ? scan.missing : [] };
}

// ---- the host process ---------------------------------------------------------------

function nodeArgs(dir, work, grant, storage) {
  const read = [path.dirname(HOST), dir, storage];
  const write = [storage];
  if (grant.read && work) read.push(work);
  if (grant.write && work) { write.push(work); if (!read.includes(work)) read.push(work); }
  // ONE FLAG PER PATH: Node 24 no longer reads a comma-separated list here, and
  // silently granting nothing is how every extension failed to load.
  const args = ['--permission', ...read.map((p) => `--allow-fs-read=${p}`), ...write.map((p) => `--allow-fs-write=${p}`)];
  if (grant.processes) args.push('--allow-child-process');
  return args;
}

function key(entry) { return `${entry.scope}:${entry.id}`; }

function recordFor(entry) {
  const k = key(entry);
  if (!hosts.has(k)) {
    hosts.set(k, {
      key: k, id: entry.id, scope: entry.scope, state: STATE.STOPPED, child: null, pid: null, seq: 0, pending: new Map(),
      commands: new Set(), providers: {}, diagnostics: new Map(), unsupported: new Set(), logs: [], messages: [],
      activation: null, restarts: [], why: '', startedAt: null, grant: null, runtimeId: null,
    });
  }
  return hosts.get(k);
}

function note(rec, level, text) {
  rec.logs.push({ at: Date.now(), level, text: String(text).slice(0, 2000) });
  if (rec.logs.length > MAX_LOG) rec.logs.splice(0, rec.logs.length - MAX_LOG);
}

/** Start (or return) the host for one installed, enabled, code-bearing extension. */
async function start(app, entry) {
  const rec = recordFor(entry);
  if (rec.state === STATE.RUNNING || rec.state === STATE.STARTING) return rec.ready || { ok: true };
  if (!entry.enabled) return { ok: false, why: `${entry.id} is disabled` };
  const dir = extDir(entry, app);
  const pkg = dir ? readPkg(dir) : null;
  if (!pkg || !pkg.main) return { ok: false, why: `${entry.id} has no Node entry point to run` };
  if (!entry.run) return { ok: false, why: `${entry.id} has not been allowed to run — enable it to run from Extensions, with its permissions`, needsGrant: true };
  const grant = grantOf(entry);
  const work = project(app);
  const storage = storageDir(entry.id);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile(entry.id), 'utf8')); } catch { state = {}; }
  const profile = (() => { try { return require('../editorprofile').read(); } catch { return {}; } })();
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: storage, TMP: storage,
    LAIN_EXT: JSON.stringify({ id: entry.id, dir, main: pkg.main, pkg: { name: pkg.name, contributes: pkg.contributes, activationEvents: pkg.activationEvents || [] }, workspace: work, storage, state, settings: profile.settings || {} }),
  };
  rec.state = STATE.STARTING;
  rec.why = '';
  rec.grant = grant;
  rec.startedAt = Date.now();
  rec.commands = new Set((pkg.contributes && Array.isArray(pkg.contributes.commands) ? pkg.contributes.commands : []).map((c) => c.command));
  const child = fork(HOST, [], { execArgv: nodeArgs(dir, work, grant, storage), env, cwd: storage, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  rec.child = child;
  rec.pid = child.pid;
  rec.runtimeId = require('../runtimeregistry').register(child, {
    purpose: 'extension-host', label: `extension host · ${entry.id}`, project: work, command: `node exthost/host.js (${entry.id})`,
    policy: { onOwnerExit: 'stop', onProjectClose: entry.scope === 'workspace', restartOnCrash: true },
  });
  child.stdout.on('data', (d) => note(rec, 'info', String(d).trim()));
  child.stderr.on('data', (d) => note(rec, 'error', String(d).trim()));
  child.on('message', (m) => onMessage(app, rec, m));
  child.on('error', (e) => note(rec, 'error', `host error: ${e.message}`));
  child.on('exit', (code, signal) => onExit(app, rec, entry, code, signal));
  rec.ready = new Promise((resolve) => {
    rec._readyResolve = resolve;
    setTimeout(() => { if (rec.state === STATE.STARTING) { rec.why = 'the extension host did not start in time'; stopHost(rec, STATE.FAILED); resolve({ ok: false, why: rec.why }); } }, START_TIMEOUT_MS).unref();
  });
  return rec.ready;
}

function onExit(app, rec, entry, code, signal) {
  const was = rec.state;
  for (const [, p] of rec.pending) p.reject(new Error(`${rec.id}'s extension host stopped`));
  rec.pending.clear();
  rec.child = null;
  rec.pid = null;
  rec.diagnostics.clear();
  if (rec._readyResolve) { rec._readyResolve({ ok: false, why: rec.why || `the extension host exited (${code})` }); rec._readyResolve = null; }
  if (was === STATE.STOPPED || rec._stopping) { rec.state = rec._finalState || STATE.STOPPED; rec._stopping = false; rec._finalState = null; return; }
  rec.state = STATE.CRASHED;
  rec.why = `${rec.id} stopped unexpectedly (exit ${code == null ? signal : code})`;
  note(rec, 'error', rec.why);
  const now = Date.now();
  rec.restarts = rec.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
  if (rec.restarts.length >= MAX_RESTARTS) {
    rec.state = STATE.FAILED;
    rec.why = `${rec.id} stopped unexpectedly ${MAX_RESTARTS} times in 2 minutes — not restarting it. Restart it from Extensions when ready.`;
    return;
  }
  rec.restarts.push(now);
  setTimeout(() => { if (rec.state === STATE.CRASHED) start(app, freshEntry(app, entry) || entry).catch(() => {}); }, 500 * rec.restarts.length).unref();
}

function freshEntry(app, entry) {
  return require('../extensions').list({ project: project(app) }).find((e) => e.id === entry.id && e.scope === entry.scope) || null;
}

function stopHost(rec, final = STATE.STOPPED) {
  rec._stopping = true;
  rec._finalState = final;
  if (!rec.child) { rec.state = final; rec._stopping = false; return; }
  try { rec.child.disconnect(); } catch { /* already */ }
  const c = rec.child;
  setTimeout(() => { if (c.exitCode === null && c.signalCode === null) { try { c.kill(); } catch { /* gone */ } } }, 1500).unref();
}

function call(rec, method, params, timeoutMs = COMMAND_TIMEOUT_MS) {
  if (!rec.child || rec.state !== STATE.RUNNING) return Promise.reject(new Error(`${rec.id} is not running (${rec.state.toLowerCase()})`));
  const id = ++rec.seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      rec.pending.delete(id);
      // A HUNG EXTENSION: stopped and restarted; the caller is told, never left waiting.
      rec.why = `${rec.id} did not answer ${method} within ${Math.round(timeoutMs / 1000)}s — its host was restarted`;
      note(rec, 'error', rec.why);
      const child = rec.child;
      rec.state = STATE.HUNG;
      if (child) { try { child.kill(); } catch { /* gone */ } }
      reject(Object.assign(new Error(rec.why), { code: 'LAIN_EXT_HUNG' }));
    }, timeoutMs);
    rec.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    rec.child.send({ type: 'req', id, method, params });
  });
}

// ---- the permission bridge: what the extension asks Core for -------------------------

function reply(rec, id, result, error = null, code = null) {
  if (!rec.child) return;
  rec.child.send(error ? { type: 'res', id, error: String(error), code } : { type: 'res', id, result });
}

async function onRequest(app, rec, m) {
  const work = project(app);
  const g = rec.grant || {};
  const need = (flag, what) => { if (!g[flag]) throw Object.assign(new Error(`DENIED: ${rec.id} is not allowed to ${what} (permission "${flag}" not granted)`), { code: 'LAIN_DENIED' }); };
  const p = m.params || {};
  switch (m.method) {
    case 'workspace.read':
    case 'fs.read': {
      need('read', 'read project files');
      const abs = inside(work, p.path);
      if (!abs) throw new Error('outside the workspace');
      const buf = fs.readFileSync(abs);
      return m.method === 'fs.read' ? { base64: buf.toString('base64') } : { text: buf.toString('utf8'), languageId: require('../harnessapp/source').language ? require('../harnessapp/source').language(abs) : null };
    }
    case 'fs.stat': {
      need('read', 'read project files');
      const abs = inside(work, p.path);
      if (!abs) throw new Error('outside the workspace');
      const st = fs.statSync(abs);
      return { type: st.isDirectory() ? 2 : 1, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs };
    }
    case 'fs.readDirectory': {
      need('read', 'read project files');
      const abs = inside(work, p.path) || (path.resolve(p.path || '') === path.resolve(work || '') ? work : null);
      if (!abs) throw new Error('outside the workspace');
      return { entries: fs.readdirSync(abs, { withFileTypes: true }).slice(0, 2000).map((e) => [e.name, e.isDirectory() ? 2 : 1]) };
    }
    case 'workspace.findFiles': {
      need('read', 'search project files');
      const { walk, globToRegExp } = require('../tools/search');
      const re = p.include ? globToRegExp(String(p.include)) : null;
      const out = [];
      for (const f of walk(work)) { if (!re || re.test(f.rel)) out.push(f.abs); if (out.length >= Math.min(Number(p.max) || 500, 2000)) break; }
      return { files: out };
    }
    case 'fs.write':
    case 'workspace.applyEdit': {
      need('write', 'change project files');
      const files = m.method === 'fs.write' ? [{ path: p.path, text: Buffer.from(p.base64 || '', 'base64').toString('utf8') }] : applyEdits(work, p.edits || []);
      const targets = files.map((f) => inside(work, f.path));
      if (targets.some((t) => !t)) throw new Error('outside the workspace');
      // THE EXTENSION'S EDIT IS A MUTATION LIKE ANY OTHER (actor TOOL, origin
      // extension:<id>): provenance, generation, GUG and PROJECT_DELTA follow.
      const r = await require('../mutation').change(app, {
        actor: 'TOOL', origin: `extension:${rec.id}`, name: m.method === 'fs.write' ? 'extension.fs.write' : 'extension.applyEdit', targets,
        write: () => { files.forEach((f, i) => fs.writeFileSync(targets[i], f.text)); return { ok: true }; },
      });
      if (r.ok === false) throw new Error(r.why || 'the edit was refused');
      return { ok: true, files: files.length };
    }
    case 'commands.execute': return executeCommand(app, p.id, p.args || [], { origin: `extension:${rec.id}` });
    case 'state.update': {
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(stateFile(rec.id), 'utf8')); } catch { cur = {}; }
      cur[p.key === 'workspace' ? 'workspace' : 'global'] = p.data || {};
      fs.writeFileSync(stateFile(rec.id), JSON.stringify(cur));
      return { ok: true };
    }
    default: throw new Error(`unknown request ${m.method}`);
  }
}

/** Apply a WorkspaceEdit's line/column edits to the files' current text. */
function applyEdits(work, list) {
  return list.map((f) => {
    const abs = inside(work, f.path);
    if (!abs) throw new Error('outside the workspace');
    let text = fs.readFileSync(abs, 'utf8');
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const off = ([l, c]) => (starts[l] != null ? starts[l] : text.length) + c;
    const edits = f.edits.map((e) => ({ a: off(e.start), b: off(e.end), t: String(e.text) })).sort((x, y) => y.a - x.a);
    for (const e of edits) text = text.slice(0, e.a) + e.t + text.slice(e.b);
    return { path: abs, text };
  });
}

function onMessage(app, rec, m) {
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'ready':
      rec.state = STATE.RUNNING;
      rec.api = m.api;
      if (rec._readyResolve) { rec._readyResolve({ ok: true }); rec._readyResolve = null; }
      break;
    case 'res': {
      const p = rec.pending.get(m.id);
      if (!p) return;
      rec.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m.result);
      break;
    }
    case 'req':
      onRequest(app, rec, m).then((r) => reply(rec, m.id, r), (e) => { note(rec, 'warn', e.message); reply(rec, m.id, null, e.message, e.code || null); });
      break;
    case 'command': if (m.removed) rec.commands.delete(m.id); else rec.commands.add(m.id); break;
    case 'provider': rec.providers[m.kind] = (rec.providers[m.kind] || 0) + 1; break;
    case 'diagnostics':
      for (const f of m.files || []) rec.diagnostics.set(`${m.collection}\u0000${f.path}`, { collection: m.collection, path: f.path, items: (f.items || []).slice(0, 500) });
      rec.diagSeq = (rec.diagSeq || 0) + 1;
      break;
    case 'message':
      rec.messages.push({ at: Date.now(), level: m.level, text: String(m.text).slice(0, 500) });
      if (rec.messages.length > 50) rec.messages.shift();
      note(rec, m.level === 'error' ? 'error' : 'info', `message: ${m.text}`);
      break;
    case 'unsupported': rec.unsupported.add(String(m.api).slice(0, 120)); note(rec, 'warn', `unsupported API: vscode.${m.api}`); break;
    case 'activation': rec.activation = { ok: Boolean(m.ok), why: m.why || '' }; if (!m.ok) note(rec, 'error', `activation failed: ${m.why}`); break;
    case 'log': note(rec, m.level || 'info', m.text); break;
    case 'crash': rec.why = `${rec.id}: ${m.why}`; break;
    default: break;
  }
}

// ---- the public surface ------------------------------------------------------------------

function entries(app) {
  try { return require('../extensions').list({ project: project(app) }); } catch { return []; }
}

/** Start every enabled extension the person allowed to run. */
async function startAll(app) {
  const out = [];
  for (const e of entries(app)) if (e.enabled && e.run && e.code) out.push(await start(app, e).catch((x) => ({ ok: false, why: x.message })));
  return out;
}

/** Which extension answers a command id: running ones first, then declared ones. */
function owner(app, id) {
  for (const rec of hosts.values()) if (rec.commands.has(id) && rec.state === STATE.RUNNING) return rec;
  for (const e of entries(app)) {
    if (!e.enabled || !e.code) continue;
    const dir = extDir(e, app);
    const pkg = dir ? readPkg(dir) : null;
    const cmds = (pkg && pkg.contributes && Array.isArray(pkg.contributes.commands) ? pkg.contributes.commands : []).map((c) => c.command);
    if (cmds.includes(id)) return { entry: e };
  }
  return null;
}

/** Run an extension command — the same path for the palette, the BOT and other extensions. */
async function executeCommand(app, id, args = [], { origin = 'user', timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const o = owner(app, id);
  if (!o) return { ok: false, why: `no enabled extension provides "${id}"` };
  let rec = o.entry ? recordFor(o.entry) : o;
  if (o.entry) {
    const s = await start(app, o.entry);
    if (!s.ok) return s;
    rec = recordFor(o.entry);
  }
  if (origin === 'bot' && rec.grant && rec.grant.write) {
    return { ok: false, why: `${rec.id} may change files, and the BOT does not edit — ask the Agent, or run the command yourself` };
  }
  try {
    const result = await call(rec, 'executeCommand', { id, args }, timeoutMs);
    return { ok: true, id, extension: rec.id, result };
  } catch (e) {
    return { ok: false, why: e.message, code: e.code || null, extension: rec.id };
  }
}

/** Tell running hosts about a document (open / change / save / close / active). */
function document(app, ev) {
  const res = [];
  for (const rec of hosts.values()) if (rec.state === STATE.RUNNING) res.push(call(rec, 'document', ev, 5000).catch(() => null));
  return Promise.all(res);
}

async function provide(app, kind, params) {
  const out = [];
  for (const rec of hosts.values()) {
    if (rec.state !== STATE.RUNNING || !rec.providers[kind]) continue;
    try { out.push({ extension: rec.id, ...(await call(rec, kind, params, 4000)) }); } catch (e) { out.push({ extension: rec.id, error: e.message }); }
  }
  return out;
}

function diagnostics() {
  const out = [];
  for (const rec of hosts.values()) {
    for (const d of rec.diagnostics.values()) for (const it of d.items) out.push({ extension: rec.id, path: d.path, ...it });
  }
  return out;
}

function status(app) {
  const byKey = new Map([...hosts.values()].map((r) => [r.key, r]));
  return entries(app).map((e) => {
    const rec = byKey.get(key(e)) || null;
    const dir = extDir(e, app);
    const pkg = dir ? readPkg(dir) : null;
    return {
      id: e.id, scope: e.scope, name: e.name, version: e.version, enabled: e.enabled, code: e.code, run: Boolean(e.run),
      grant: grantOf(e), state: rec ? rec.state : (e.run && e.enabled && e.code ? STATE.STOPPED : null), why: rec ? rec.why : '',
      pid: rec ? rec.pid : null, api: rec ? rec.api || null : null,
      commands: rec ? [...rec.commands] : ((pkg && pkg.contributes && pkg.contributes.commands) || []).map((c) => c.command),
      commandTitles: Object.fromEntries(((pkg && pkg.contributes && pkg.contributes.commands) || []).map((c) => [c.command, c.title || c.command])),
      providers: rec ? rec.providers : {}, diagnostics: rec ? [...rec.diagnostics.values()].reduce((n, d) => n + d.items.length, 0) : 0,
      unsupported: rec ? [...rec.unsupported] : [], messages: rec ? rec.messages.slice(-5) : [], logs: rec ? rec.logs.slice(-40) : [],
      compatibility: compatibility(pkg, rec, dir && pkg ? require('./surface').scanExtension(dir, pkg) : null),
      // DECLARED LANGUAGES, for the editor's file associations (no grammar is applied).
      languages: ((pkg && pkg.contributes && Array.isArray(pkg.contributes.languages)) ? pkg.contributes.languages : []).slice(0, 20)
        .filter((l) => l && typeof l.id === 'string').map((l) => ({ id: l.id, extensions: (l.extensions || []).map(String).slice(0, 20), filenames: (l.filenames || []).map(String).slice(0, 20), aliases: (l.aliases || []).map(String).slice(0, 5) })),
    };
  });
}

/** Allow an extension to run, with exactly these permissions (or stop allowing it). */
function allow(app, id, scope, { run = true, grant = {} } = {}) {
  const ext = require('../extensions');
  const root = ext.rootFor(scope, { project: project(app) });
  if (!root) return { ok: false, why: 'no project for a workspace extension' };
  const file = path.join(root, 'extensions.json');
  let reg;
  try { reg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, why: 'no extensions installed there' }; }
  const e = (reg.installed || []).find((x) => x.id === id);
  if (!e) return { ok: false, why: `${id} is not installed (${scope})` };
  e.run = Boolean(run);
  e.grant = { read: grant.read === true, write: grant.write === true, processes: grant.processes === true };
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(reg, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  const rec = hosts.get(`${scope}:${id}`);
  if (rec && rec.child) stopHost(rec);   // a changed grant takes effect on the next start
  return { ok: true, id, run: e.run, grant: e.grant };
}

function stop(app, id, scope) {
  const rec = hosts.get(`${scope}:${id}`);
  if (!rec) return { ok: true, already: true };
  stopHost(rec);
  return { ok: true };
}

async function restart(app, id, scope) {
  const e = entries(app).find((x) => x.id === id && x.scope === scope);
  if (!e) return { ok: false, why: `${id} is not installed` };
  const rec = recordFor(e);
  rec.restarts = [];
  if (rec.child) { stopHost(rec); await new Promise((r) => setTimeout(r, 300)); }
  rec.state = STATE.STOPPED;
  return start(app, e);
}

function stopAll() { for (const rec of hosts.values()) if (rec.child) stopHost(rec); }

/** For tests: forget in-memory records. */
function _reset() { stopAll(); hosts.clear(); }

module.exports = {
  STATE, COMMAND_TIMEOUT_MS, start, startAll, executeCommand, document, provide, diagnostics, status, allow, stop, restart, stopAll,
  compatibility, grantOf, nodeArgs, _reset, _hosts: hosts,
};
