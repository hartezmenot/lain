'use strict';

/** THE LANGUAGE SERVER MANAGER — deterministic language intelligence for /focus. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { LspClient, uriOf, pathOf } = require('./client');

const STATE = Object.freeze({ STARTING: 'STARTING', READY: 'READY', CRASHED: 'CRASHED', FAILED: 'FAILED', STOPPED: 'STOPPED' });
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 120_000;

const LANG_OF_EXT = Object.freeze({
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact',
  '.py': 'python', '.pyi': 'python', '.rs': 'rust', '.go': 'go', '.cs': 'csharp',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
});

/** How to find the usual servers. Order within an entry is preference. */
const CATALOGUE = Object.freeze([
  { id: 'typescript', name: 'TypeScript / JavaScript', languages: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'], commands: [['typescript-language-server', ['--stdio']]], install: { npm: ['typescript', 'typescript-language-server'] } },
  { id: 'python', name: 'Python (Pyright)', languages: ['python'], commands: [['pyright-langserver', ['--stdio']], ['basedpyright-langserver', ['--stdio']], ['pylsp', []]], install: { npm: ['pyright'] } },
  { id: 'rust', name: 'Rust (rust-analyzer)', languages: ['rust'], commands: [['rust-analyzer', []]] },
  { id: 'clangd', name: 'C / C++ (clangd)', languages: ['c', 'cpp'], commands: [['clangd', []]] },
  { id: 'go', name: 'Go (gopls)', languages: ['go'], commands: [['gopls', []]] },
  { id: 'csharp', name: 'C# (csharp-ls)', languages: ['csharp'], commands: [['csharp-ls', []]] },
]);

function toolsDir() { return path.join(require('../config').configDir(), 'tools'); }
function extraBins() {
  const list = [path.join(toolsDir(), 'node_modules', '.bin'), path.join(os.homedir(), '.cargo', 'bin')];
  if (process.platform === 'win32' && process.env.APPDATA) list.push(path.join(process.env.APPDATA, 'npm'));
  return list;
}

/** A command on PATH or in LAIN's own tool folders, or null. Never a guess. */
function which(cmd) {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = [...extraBins(), ...String(process.env.PATH || '').split(path.delimiter)];
  for (const d of dirs) {
    if (!d) continue;
    for (const e of exts) {
      const f = path.join(d, cmd + e);
      try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
    }
  }
  return null;
}

function cfg(app) { return (app && ((app._sibling || app).cfg || app.cfg)) || {}; }

/** The catalogue plus configured servers, each with whether it can be started. */
function servers(app) {
  const configured = (cfg(app).lsp && Array.isArray(cfg(app).lsp.servers)) ? cfg(app).lsp.servers : [];
  const out = [];
  for (const c of configured) {
    if (!c || !c.id || !c.command) continue;
    const found = which(String(c.command));
    out.push({ id: String(c.id), name: c.name || c.id, languages: (c.languages || []).map(String), extensions: (c.extensions || []).map(String), command: found, args: (c.args || []).map(String), initializationOptions: c.initializationOptions || null, configured: true, available: Boolean(found), why: found ? '' : `${c.command} was not found` });
  }
  for (const s of CATALOGUE) {
    if (out.some((o) => o.id === s.id)) continue;
    let found = null; let args = [];
    for (const [cmd, a] of s.commands) { const f = which(cmd); if (f) { found = f; args = a; break; } }
    out.push({ id: s.id, name: s.name, languages: s.languages, extensions: [], command: found, args, configured: false, available: Boolean(found), install: s.install || null, why: found ? '' : `not installed (${s.commands.map((c) => c[0]).join(' or ')})` });
  }
  return out;
}

function languageOf(p) { return LANG_OF_EXT[path.extname(String(p)).toLowerCase()] || null; }

/** THE PROJECT ROOT AS THE SERVER WILL SPELL IT: the real, long path. */
const realRoots = new Map();
function realOf(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }
function project(app) {
  let cwd = null;
  try { const p = require('../sessionviews').project(app.session); cwd = p.attached && !p.missing ? app.session.cwd : null; } catch { cwd = null; }
  if (!cwd) return null;
  if (!realRoots.has(cwd)) realRoots.set(cwd, realOf(cwd));
  return realRoots.get(cwd);
}
/** A file as the server knows it: under the real root, whatever spelling the caller used. */
function absOf(app, p) {
  const root = project(app) || '';
  const s = String(p);
  if (!path.isAbsolute(s)) return path.resolve(root, s);
  const cwd = app && app.session && app.session.cwd;
  if (cwd) { const rel = path.relative(cwd, s); if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return path.resolve(root, rel); }
  return fs.existsSync(s) ? realOf(s) : path.resolve(s);
}
/** A comparable key: Windows paths are case-insensitive (servers send c:\ for C:\). */
function keyOf(p) { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; }

// ---- running servers -------------------------------------------------------------------

const running = new Map();   // `${root}|${id}` -> record

function serverFor(app, p) {
  const lang = languageOf(p);
  const ext = path.extname(String(p)).toLowerCase();
  return servers(app).find((s) => s.available && (s.languages.includes(lang) || s.extensions.includes(ext))) || null;
}

function recordKey(root, id) { return `${root}|${id}`; }

/** WHAT A SERVER NEEDS TO BE TOLD AT START. */
function initOptions(s, root) {
  if (s.initializationOptions) return s.initializationOptions;
  if (s.id !== 'typescript' || !s.command) return undefined;
  if (fs.existsSync(path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js'))) return undefined;
  const beside = path.join(path.dirname(s.command), '..', 'typescript', 'lib', 'tsserver.js');
  return fs.existsSync(beside) ? { tsserver: { path: beside } } : undefined;
}

async function ensure(app, p) {
  const root = project(app);
  if (!root) return { ok: false, why: 'no project is open' };
  const s = serverFor(app, p);
  if (!s) {
    const lang = languageOf(p);
    const known = servers(app).find((x) => x.languages.includes(lang));
    return { ok: false, why: known ? `${known.name}: ${known.why}` : `no language server for ${lang || path.extname(String(p)) || 'this file'}`, notInstalled: Boolean(known) };
  }
  const k = recordKey(root, s.id);
  let rec = running.get(k);
  if (rec && (rec.state === STATE.READY || rec.state === STATE.STARTING)) return rec.ready;
  if (rec && rec.state === STATE.FAILED) return { ok: false, why: rec.why, failed: true };
  rec = rec || { key: k, id: s.id, name: s.name, root, state: STATE.STOPPED, diagnostics: new Map(), restarts: [], logs: [], why: '' };
  running.set(k, rec);
  rec.state = STATE.STARTING;
  rec.server = s;
  const client = new LspClient({
    id: s.id, command: s.command, args: s.args, cwd: root,
    onDiagnostics: (file, list) => { const k = keyOf(file); rec.diagnostics.set(k, list); (rec.diagFiles = rec.diagFiles || new Map()).set(k, path.resolve(file)); rec.diagSeq = (rec.diagSeq || 0) + 1; (rec.diagAt = rec.diagAt || new Map()).set(k, Date.now()); },
    onLog: (t) => { rec.logs.push({ at: Date.now(), text: String(t).slice(0, 1000) }); if (rec.logs.length > 200) rec.logs.shift(); },
    onExit: (info) => onExit(app, rec, info),
  });
  rec.client = client;
  const child = client.start();
  rec.pid = child.pid;
  rec.runtimeId = require('../runtimeregistry').register(child, {
    purpose: 'language-server', label: `${s.name}`, project: root, command: [s.command, ...s.args].join(' '),
    policy: { onOwnerExit: 'stop', onProjectClose: true, restartOnCrash: true },
  });
  rec.ready = client.initialize(root, initOptions(s, root)).then((caps) => {
    rec.state = STATE.READY;
    rec.capabilities = caps;
    rec.startedAt = Date.now();
    return { ok: true, id: s.id, capabilities: caps };
  }, (e) => {
    rec.why = `${s.name} failed to start: ${e.message}`;
    rec.state = STATE.FAILED;
    try { child.kill(); } catch { /* gone */ }
    return { ok: false, why: rec.why };
  });
  return rec.ready;
}

function onExit(app, rec, info) {
  if (rec._stopping) { rec.state = STATE.STOPPED; rec._stopping = false; return; }
  if (rec.state === STATE.FAILED) return;
  rec.state = STATE.CRASHED;
  rec.why = `${rec.name} stopped unexpectedly${info && info.code != null ? ` (exit ${info.code})` : info && info.error ? ` (${info.error})` : ''}`;
  rec.diagnostics.clear();
  const now = Date.now();
  rec.restarts = rec.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
  if (rec.restarts.length >= MAX_RESTARTS) { rec.state = STATE.FAILED; rec.why = `${rec.why} — ${MAX_RESTARTS} times in 2 minutes; not restarting it. Restart it from Settings › Language Servers.`; return; }
  rec.restarts.push(now);
  const opened = [...(rec.client ? rec.client.open.keys() : [])];
  setTimeout(async () => {
    if (rec.state !== STATE.CRASHED) return;
    running.delete(rec.key);
    const r = await ensure(app, path.join(rec.root, 'x' + (Object.keys(LANG_OF_EXT).find((e) => rec.server.languages.includes(LANG_OF_EXT[e])) || rec.server.extensions[0] || '.txt')));
    if (!r.ok) return;
    const fresh = running.get(rec.key);
    fresh.restarts = rec.restarts;
    for (const u of opened) { const p = pathOf(u); try { fresh.client.didOpen(p, fs.readFileSync(p, 'utf8'), languageOf(p)); } catch { /* gone */ } }
  }, 400 * rec.restarts.length).unref();
}

/** Make sure the server has this file (the saved text when the editor has not sent one). */
async function withFile(app, p) {
  const abs = absOf(app, p);
  const r = await ensure(app, abs);
  if (!r.ok) return { ...r, abs };
  const rec = running.get(recordKey(project(app), r.id));
  if (!rec.client.open.has(uriOf(abs))) {
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { return { ok: false, why: `cannot read ${p}` }; }
    rec.client.didOpen(abs, text, languageOf(abs));
  }
  return { ok: true, rec, abs };
}

/** OPEN THESE FILES IN THEIR SERVER — so a server without a project file (tsconfig, pyrightconfig …) still sees the files that mention a symbol before… */
async function prime(app, rels, { max = 80 } = {}) {
  const root = project(app);
  if (!root) return 0;
  let n = 0;
  for (const rel of (rels || []).slice(0, max)) {
    if (!serverFor(app, rel)) continue;
    const f = await withFile(app, rel);
    if (f.ok) n += 1;
  }
  return n;
}

/** Wait (bounded) until the server published diagnostics after `since` for these files. */
async function settle(app, rels, { since = 0, ms = 3000 } = {}) {
  const root = project(app);
  const want = (rels || []).map((r) => absOf(app, r));
  const end = Date.now() + ms;
  for (;;) {
    let fresh = true;
    for (const rec of running.values()) {
      if (rec.root !== root) continue;
      for (const w of want) if (rec.client && rec.client.open.has(uriOf(w)) && !((rec.diagAt || new Map()).get(keyOf(w)) > since)) fresh = false;
    }
    if (fresh || Date.now() > end) return fresh;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The editor's document events (open / change / save / close). */
async function document(app, { event, path: p, text }) {
  const root = project(app);
  if (!root || !languageOf(p) && !servers(app).some((s) => s.extensions.includes(path.extname(p)))) return { ok: true, skipped: true };
  const abs = absOf(app, p);
  const r = event === 'close' ? { ok: true } : await ensure(app, abs);
  if (!r.ok) return r;
  for (const rec of running.values()) {
    if (rec.root !== root || rec.state !== STATE.READY) continue;
    if (!(rec.server.languages.includes(languageOf(abs)) || rec.server.extensions.includes(path.extname(abs)))) continue;
    if (event === 'close') rec.client.didClose(abs);
    // A document the server never opened is OPENED, not changed: a change to an
    // unknown document is a protocol error some servers die of.
    else if (event === 'save') { if (text != null) { if (rec.client.open.has(uriOf(abs))) rec.client.didChange(abs, text); else rec.client.didOpen(abs, text, languageOf(abs)); } rec.client.didSave(abs); } else rec.client.didOpen(abs, text != null ? text : fs.readFileSync(abs, 'utf8'), languageOf(abs));
  }
  return { ok: true };
}

// ---- results, normalised to 1-based lines and columns ----------------------------------------

function lineText(file, line0) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/)[line0] || ''; } catch { return ''; }
}
function loc(root, l) {
  const uri = l.uri || l.targetUri;
  const r = l.range || l.targetSelectionRange || l.targetRange;
  if (!uri || !r) return null;
  const file = pathOf(uri);
  const rel = root ? path.relative(root, file).split(path.sep).join('/') : file;
  return { path: rel, abs: file, line: r.start.line + 1, col: r.start.character + 1, endLine: r.end.line + 1, endCol: r.end.character + 1, text: lineText(file, r.start.line).trim().slice(0, 200) };
}
function locs(root, res) { return (Array.isArray(res) ? res : res ? [res] : []).map((l) => loc(root, l)).filter(Boolean); }
function pos(line, col) { return { line: Math.max(0, Number(line) - 1), character: Math.max(0, Number(col) - 1) }; }
function td(abs) { return { uri: uriOf(abs) }; }
function markup(c) {
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(markup).join('\n');
  return c.value || '';
}

async function at(app, method, { path: p, line, col, extra = {} }, shape) {
  const f = await withFile(app, p);
  if (!f.ok) return f;
  const cap = f.rec.capabilities || {};
  const capName = { 'textDocument/definition': 'definitionProvider', 'textDocument/declaration': 'declarationProvider', 'textDocument/references': 'referencesProvider', 'textDocument/implementation': 'implementationProvider', 'textDocument/hover': 'hoverProvider', 'textDocument/completion': 'completionProvider', 'textDocument/signatureHelp': 'signatureHelpProvider', 'textDocument/prepareRename': 'renameProvider', 'textDocument/rename': 'renameProvider' }[method];
  if (capName && !cap[capName]) return { ok: false, why: `${f.rec.name} does not provide ${method.split('/')[1]}`, unsupported: true, server: f.rec.id };
  try {
    const res = await f.rec.client.request(method, { textDocument: td(f.abs), position: pos(line, col), ...extra });
    return { ok: true, server: f.rec.id, ...shape(res, f.rec.root) };
  } catch (e) {
    return { ok: false, why: e.message, server: f.rec.id };
  }
}

const definition = (app, q) => at(app, 'textDocument/definition', q, (r, root) => ({ locations: locs(root, r) }));
const declaration = (app, q) => at(app, 'textDocument/declaration', q, (r, root) => ({ locations: locs(root, r) }));
const implementation = (app, q) => at(app, 'textDocument/implementation', q, (r, root) => ({ locations: locs(root, r) }));
const references = (app, q) => at(app, 'textDocument/references', { ...q, extra: { context: { includeDeclaration: q.includeDeclaration !== false } } }, (r, root) => ({ locations: locs(root, r) }));
const hover = (app, q) => at(app, 'textDocument/hover', q, (r) => ({ contents: r ? markup(r.contents) : '' }));
const signatureHelp = (app, q) => at(app, 'textDocument/signatureHelp', q, (r) => ({ signatures: ((r && r.signatures) || []).map((s) => ({ label: s.label, documentation: markup(s.documentation) })), active: r ? r.activeSignature || 0 : 0 }));
const completion = (app, q) => at(app, 'textDocument/completion', q, (r) => ({ items: ((Array.isArray(r) ? r : (r && r.items) || [])).slice(0, 200).map((i) => ({ label: i.label, kind: i.kind, detail: i.detail || null, insertText: i.insertText || (i.textEdit && i.textEdit.newText) || null, documentation: markup(i.documentation) })) }));

async function documentSymbols(app, { path: p }) {
  const f = await withFile(app, p);
  if (!f.ok) return f;
  try {
    const res = await f.rec.client.request('textDocument/documentSymbol', { textDocument: td(f.abs) });
    const flat = [];
    const walk = (list, container) => {
      for (const s of list || []) {
        const r = s.selectionRange || s.range || (s.location && s.location.range);
        if (r) flat.push({ name: s.name, kind: s.kind, container: container || s.containerName || null, line: r.start.line + 1, col: r.start.character + 1 });
        if (s.children) walk(s.children, s.name);
      }
    };
    walk(res);
    return { ok: true, server: f.rec.id, symbols: flat };
  } catch (e) { return { ok: false, why: e.message }; }
}

async function workspaceSymbols(app, { query, language = null }) {
  const root = project(app);
  const probe = language ? `x${Object.keys(LANG_OF_EXT).find((e) => LANG_OF_EXT[e] === language) || '.js'}` : null;
  if (probe) { const r = await ensure(app, path.join(root || '', probe)); if (!r.ok) return r; }
  const out = [];
  for (const rec of running.values()) {
    if (rec.root !== root || rec.state !== STATE.READY || !(rec.capabilities || {}).workspaceSymbolProvider) continue;
    try {
      const res = await rec.client.request('workspace/symbol', { query: String(query || '') });
      for (const s of (res || []).slice(0, 200)) { const l = loc(root, s.location || s); if (l) out.push({ name: s.name, kind: s.kind, container: s.containerName || null, ...l, server: rec.id }); }
    } catch { /* one server's failure is not the answer */ }
  }
  return { ok: true, symbols: out };
}

/** CAN THIS BE RENAMED, AND WHAT EXACTLY? */
async function prepareRename(app, { path: p, line, col }) {
  const f = await withFile(app, p);
  if (!f.ok) return f;
  const cap = (f.rec.capabilities || {}).renameProvider;
  if (!cap) return { ok: false, why: `${f.rec.name} does not provide rename`, unsupported: true, server: f.rec.id };
  if (!(cap && cap.prepareProvider)) return { ok: true, server: f.rec.id, renameable: true, prepared: false };
  try {
    const r = await f.rec.client.request('textDocument/prepareRename', { textDocument: td(f.abs), position: pos(line, col) });
    if (!r) return { ok: true, server: f.rec.id, renameable: false, prepared: true, why: 'the language server says this cannot be renamed' };
    const range = r.range || (r.start ? r : null);
    return { ok: true, server: f.rec.id, renameable: true, prepared: true, placeholder: r.placeholder || null, range: range ? { line: range.start.line + 1, col: range.start.character + 1, endLine: range.end.line + 1, endCol: range.end.character + 1 } : null };
  } catch (e) { return { ok: false, why: e.message, server: f.rec.id }; }
}

/** Is the server for this file up right now (READY)? */
function readyFor(app, p) {
  const root = project(app);
  const s = serverFor(app, p);
  const rec = root && s ? running.get(recordKey(root, s.id)) : null;
  return Boolean(rec && rec.state === STATE.READY && rec.client && !rec.client.exited);
}

/** The diagnostics the servers published for these files (relative paths), now. */
function diagnosticsFor(app, rels) {
  const want = new Set((rels || []).map((r) => String(r).split('\\').join('/')));
  return diagnostics(app).filter((d) => want.has(d.path));
}

/** Is a server for this file's language available (installed or configured)? No process is started. */
function coverage(app, p) {
  const s = serverFor(app, p);
  if (s) return { available: true, id: s.id, name: s.name };
  const lang = languageOf(p);
  const known = servers(app).find((x) => x.languages.includes(lang));
  return { available: false, why: known ? `${known.name}: ${known.why}` : `no language server for ${lang || path.extname(String(p)) || 'this file'}` };
}

/** The edits a rename WOULD make — nothing is written here. */
async function rename(app, { path: p, line, col, newName }) {
  const f = await withFile(app, p);
  if (!f.ok) return f;
  const cap = (f.rec.capabilities || {}).renameProvider;
  if (!cap) return { ok: false, why: `${f.rec.name} does not provide rename`, unsupported: true };
  try {
    if (cap && cap.prepareProvider) {
      const prep = await f.rec.client.request('textDocument/prepareRename', { textDocument: td(f.abs), position: pos(line, col) });
      if (!prep) return { ok: false, why: 'the language server says this is not something that can be renamed' };
    }
    const we = await f.rec.client.request('textDocument/rename', { textDocument: td(f.abs), position: pos(line, col), newName: String(newName) });
    return { ok: true, server: f.rec.id, ...normalizeEdit(f.rec.root, we) };
  } catch (e) { return { ok: false, why: e.message }; }
}

function normalizeEdit(root, we) {
  const files = new Map();
  const add = (uri, edits) => {
    const abs = pathOf(uri);
    const list = files.get(abs) || [];
    for (const e of edits || []) list.push({ start: e.range.start, end: e.range.end, newText: e.newText });
    files.set(abs, list);
  };
  if (we && we.changes) for (const [uri, edits] of Object.entries(we.changes)) add(uri, edits);
  if (we && Array.isArray(we.documentChanges)) for (const dc of we.documentChanges) if (dc.textDocument && dc.edits) add(dc.textDocument.uri, dc.edits);
  const out = [...files.entries()].map(([abs, edits]) => ({ abs, path: root ? path.relative(root, abs).split(path.sep).join('/') : abs, edits }));
  return { files: out, count: out.reduce((n, f) => n + f.edits.length, 0) };
}

/** Apply normalised edits to disk text (bottom-up), returning the new text per file. */
function applyTo(text, edits) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const off = (p) => (starts[p.line] != null ? starts[p.line] : text.length) + p.character;
  let out = text;
  for (const e of edits.slice().sort((a, b) => off(b.start) - off(a.start))) out = out.slice(0, off(e.start)) + e.newText + out.slice(off(e.end));
  return out;
}

/** APPLY A RENAME the language server planned — through the ONE mutation transaction (mutation.js `change`). */
async function applyRename(app, plan, { actor = 'USER' } = {}) {
  const root = project(app);
  const files = [];
  for (const f of plan.files || []) {
    // WRITTEN AS THE SESSION SPELLS ITS PROJECT (provenance and the mutation
    // targets are keyed by it); only messages to the server use the real path.
    const abs = path.resolve(app.session.cwd, f.path);
    const rel = path.relative(app.session.cwd, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    files.push({ abs, rel: f.path, edits: f.edits });
  }
  const done = [];
  const r = await require('../mutation').change(app, {
    actor, origin: 'language-server', name: 'lsp.rename', targets: files.map((f) => f.abs), what: `rename (${plan.server || 'language server'})`,
    write: () => {
      for (const f of files) {
        const before = fs.readFileSync(f.abs, 'utf8');
        const after = applyTo(before, f.edits);
        if (after === before) continue;
        fs.writeFileSync(f.abs, after);
        done.push({ abs: f.abs, rel: f.rel, after });
      }
      return { ok: true, files: done.map((d) => d.rel) };
    },
  });
  for (const d of done) document(app, { event: 'save', path: d.abs, text: d.after }).catch(() => {});
  return { ok: r.ok !== false, files: done.map((d) => d.rel), why: r.why };
}

function diagnostics(app) {
  const root = project(app);
  const out = [];
  for (const rec of running.values()) {
    if (root && rec.root !== root) continue;
    for (const [k, list] of rec.diagnostics) {
      const file = (rec.diagFiles && rec.diagFiles.get(k)) || k;
      for (const d of list.slice(0, 500)) out.push({ server: rec.id, path: root ? path.relative(root, file).split(path.sep).join('/') : file, line: d.range.start.line + 1, col: d.range.start.character + 1, endLine: d.range.end.line + 1, endCol: d.range.end.character + 1, severity: ['error', 'error', 'warning', 'info', 'hint'][d.severity || 1] || 'info', message: String(d.message).slice(0, 500), code: d.code != null ? String(d.code) : null, source: d.source || rec.id });
    }
  }
  return out;
}

function status(app) {
  const root = project(app);
  const list = servers(app);
  const langs = new Set();
  try {
    const idx = require('../projectindex').fresh(root, { persist: false }).index;
    for (const f of Object.keys((idx && idx.files) || {})) { const l = languageOf(f); if (l) langs.add(l); }
  } catch { /* no project */ }
  return list.map((s) => {
    const rec = root ? running.get(recordKey(root, s.id)) : null;
    return {
      id: s.id, name: s.name, languages: s.languages, available: s.available, command: s.command, configured: s.configured, why: rec && rec.why ? rec.why : s.why,
      install: s.install || null, inProject: s.languages.some((l) => langs.has(l)),
      state: rec ? rec.state : null, pid: rec && rec.client && !rec.client.exited ? rec.pid : null,
      diagnostics: rec ? [...rec.diagnostics.values()].reduce((n, l) => n + l.length, 0) : 0,
      capabilities: rec && rec.capabilities ? Object.keys(rec.capabilities).filter((k) => /Provider$/.test(k) && rec.capabilities[k]).map((k) => k.replace(/Provider$/, '')) : [],
      logs: rec ? rec.logs.slice(-20) : [],
    };
  });
}

async function stop(app, id) {
  const root = project(app);
  const rec = running.get(recordKey(root, id));
  if (!rec) return { ok: true, already: true };
  rec._stopping = true;
  await rec.client.shutdown();
  rec.state = STATE.STOPPED;
  running.delete(rec.key);
  return { ok: true };
}

async function restart(app, id) {
  const root = project(app);
  const rec = running.get(recordKey(root, id));
  if (rec) { rec._stopping = true; try { await rec.client.shutdown(); } catch { /* gone */ } running.delete(rec.key); }
  const s = servers(app).find((x) => x.id === id);
  if (!s) return { ok: false, why: `no server ${id}` };
  const probe = Object.keys(LANG_OF_EXT).find((e) => s.languages.includes(LANG_OF_EXT[e])) || (s.extensions[0] || '.txt');
  return ensure(app, path.join(root || '', `x${probe}`));
}

async function stopAll() {
  for (const rec of running.values()) { rec._stopping = true; try { await rec.client.shutdown(); } catch { /* gone */ } }
  running.clear();
}

module.exports = {
  STATE, CATALOGUE, LANG_OF_EXT, servers, languageOf, which, ensure, document, definition, declaration, implementation, references,
  hover, signatureHelp, completion, documentSymbols, workspaceSymbols, prepareRename, rename, applyRename, applyTo, normalizeEdit, diagnostics, diagnosticsFor, coverage, prime, settle, readyFor,
  status, stop, restart, stopAll, absOf, keyOf, _running: running,
};
