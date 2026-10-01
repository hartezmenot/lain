'use strict';

/**
 * THE EXTENSION HOST — one VS Code extension, in its own Node process.
 *
 * ------------------------------------------------------------------------
 * WHAT RUNS HERE AND WHAT CANNOT.
 *
 * Core (manager.js) starts this file as a separate `node` process, one per
 * extension, under Node's permission model:
 *
 *   --permission --allow-fs-read=<this folder>,<the extension>[,<workspace>]
 *                --allow-fs-write=<its storage>[,<workspace>]
 *                [--allow-child-process]
 *
 * so what the person granted is enforced by the Node runtime, not by
 * convention: an extension without "workspace write" gets ERR_ACCESS_DENIED
 * from `fs.writeFile` on a project file, and one without "processes" cannot
 * spawn anything. It talks to Core only over the IPC channel below; it has no
 * access to Core's memory, LAIN's tools, the session or credentials.
 *
 * ------------------------------------------------------------------------
 * THE `vscode` MODULE IS A DECLARED SUBSET (see API_VERSION and SUPPORTED).
 * Anything outside it throws `LAIN_UNSUPPORTED vscode.<name>` at the moment it
 * is touched, and Core records it for the extension's compatibility report —
 * an unsupported API is never a silent no-op.
 */

const Module = require('module');
const path = require('path');

const API_VERSION = '0.1.0';
const ext = JSON.parse(process.env.LAIN_EXT || '{}');   // { id, dir, main, workspace, pkg, activationEvents }
let seq = 0;
const pending = new Map();
const handlers = { commands: new Map(), completion: [], hover: [], definition: [], formatting: [] };
const documents = new Map();
const docEvents = { open: [], change: [], save: [], close: [], activeEditor: [], config: [] };
let active = null;
let activated = false;
let activating = null;

// ---- the channel to Core -----------------------------------------------------------
function send(msg) { if (process.connected) process.send(msg); }
function request(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'req', id, method, params });
  });
}
function log(level, text) { send({ type: 'log', level, text: String(text).slice(0, 4000) }); }
function unsupported(name) {
  send({ type: 'unsupported', api: name });
  const e = new Error(`LAIN_UNSUPPORTED vscode.${name} is not available in Noema (extension API ${API_VERSION})`);
  e.code = 'LAIN_UNSUPPORTED';
  return e;
}
// Console output belongs to the extension's log, never to the protocol.
for (const [k, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error'], ['debug', 'debug']]) {
  console[k] = (...a) => log(level, a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' '));
}

// ---- value types --------------------------------------------------------------------
class Disposable {
  constructor(fn) { this._fn = fn; }
  static from(...d) { return new Disposable(() => d.forEach((x) => x && x.dispose && x.dispose())); }
  dispose() { if (this._fn) { const f = this._fn; this._fn = null; f(); } }
}
class EventEmitter {
  constructor() { this._l = new Set(); this.event = (fn, thisArg, subs) => { const b = thisArg ? fn.bind(thisArg) : fn; this._l.add(b); const d = new Disposable(() => this._l.delete(b)); if (Array.isArray(subs)) subs.push(d); return d; }; }
  fire(v) { for (const l of [...this._l]) { try { l(v); } catch (e) { log('error', `event listener: ${e && e.stack ? e.stack : e}`); } } }
  dispose() { this._l.clear(); }
}
class Uri {
  constructor(scheme, fsPath) { this.scheme = scheme; this.fsPath = fsPath; this.path = fsPath.replace(/\\/g, '/'); this.authority = ''; this.query = ''; this.fragment = ''; }
  static file(p) { return new Uri('file', path.resolve(String(p))); }
  static parse(s) { const t = String(s); return t.startsWith('file://') ? Uri.file(decodeURIComponent(t.slice(7).replace(/^\/([A-Za-z]:)/, '$1'))) : new Uri(t.split(':')[0] || 'file', t); }
  static joinPath(base, ...parts) { return Uri.file(path.join(base.fsPath, ...parts)); }
  with(o = {}) { return o.path ? Uri.file(o.path) : this; }
  toString() { return `file:///${this.path.replace(/^\//, '')}`; }
  toJSON() { return { scheme: this.scheme, fsPath: this.fsPath }; }
}
class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  translate(dl = 0, dc = 0) { return new Position(this.line + (typeof dl === 'object' ? dl.lineDelta || 0 : dl), this.character + (typeof dl === 'object' ? dl.characterDelta || 0 : dc)); }
  isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
  isEqual(o) { return this.line === o.line && this.character === o.character; }
}
class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); } else { this.start = a; this.end = b; }
  }
  get isEmpty() { return this.start.isEqual(this.end); }
  contains(p) { const q = p.start || p; return !q.isBefore(this.start) && !this.end.isBefore(q); }
}
class Selection extends Range { constructor(a, b, c, d) { super(a, b, c, d); this.anchor = this.start; this.active = this.end; } }
class Location { constructor(uri, range) { this.uri = uri; this.range = range instanceof Position ? new Range(range, range) : range; } }
const DiagnosticSeverity = Object.freeze({ Error: 0, Warning: 1, Information: 2, Hint: 3 });
class Diagnostic { constructor(range, message, severity = DiagnosticSeverity.Error) { this.range = range; this.message = message; this.severity = severity; this.source = undefined; this.code = undefined; } }
const CompletionItemKind = Object.freeze({ Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17, Folder: 18 });
class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
class CompletionList { constructor(items = [], isIncomplete = false) { this.items = items; this.isIncomplete = isIncomplete; } }
class MarkdownString { constructor(v = '') { this.value = v; } appendText(t) { this.value += t; return this; } appendMarkdown(t) { this.value += t; return this; } appendCodeblock(c, l = '') { this.value += `\n\`\`\`${l}\n${c}\n\`\`\`\n`; return this; } }
class Hover { constructor(contents, range) { this.contents = Array.isArray(contents) ? contents : [contents]; this.range = range; } }
class TextEdit {
  constructor(range, newText) { this.range = range; this.newText = newText; }
  static replace(r, t) { return new TextEdit(r, t); }
  static insert(p, t) { return new TextEdit(new Range(p, p), t); }
  static delete(r) { return new TextEdit(r, ''); }
}
class WorkspaceEdit {
  constructor() { this._e = new Map(); }
  _list(uri) { const k = uri.fsPath; if (!this._e.has(k)) this._e.set(k, []); return this._e.get(k); }
  replace(uri, range, text) { this._list(uri).push(new TextEdit(range, text)); }
  insert(uri, pos, text) { this._list(uri).push(TextEdit.insert(pos, text)); }
  delete(uri, range) { this._list(uri).push(TextEdit.delete(range)); }
  set(uri, edits) { this._e.set(uri.fsPath, edits.slice()); }
  entries() { return [...this._e.entries()].map(([k, v]) => [Uri.file(k), v]); }
  get size() { return this._e.size; }
}
class CancellationTokenSource { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }; } cancel() { this.token.isCancellationRequested = true; } dispose() {} }

// ---- documents (Core sends their text; the extension reads them here) -------------------
function makeDocument(d) {
  const lines = () => String(d.text).split(/\r?\n/);
  const offsets = () => { const o = [0]; const t = String(d.text); for (let i = 0; i < t.length; i++) if (t[i] === '\n') o.push(i + 1); return o; };
  return {
    uri: Uri.file(d.path), fileName: path.resolve(d.path), languageId: d.languageId || 'plaintext', version: d.version || 1,
    isDirty: false, isUntitled: false, isClosed: false, eol: 1,
    get lineCount() { return lines().length; },
    getText(range) {
      if (!range) return String(d.text);
      const o = offsets();
      const a = (o[range.start.line] || 0) + range.start.character;
      const b = (o[range.end.line] || 0) + range.end.character;
      return String(d.text).slice(a, b);
    },
    lineAt(n) { const ln = typeof n === 'number' ? n : n.line; const t = lines()[ln] || ''; return { lineNumber: ln, text: t, range: new Range(ln, 0, ln, t.length), isEmptyOrWhitespace: !t.trim(), firstNonWhitespaceCharacterIndex: t.length - t.trimStart().length }; },
    positionAt(off) { const o = offsets(); let l = 0; while (l + 1 < o.length && o[l + 1] <= off) l++; return new Position(l, off - o[l]); },
    offsetAt(p) { const o = offsets(); return (o[p.line] || 0) + p.character; },
    getWordRangeAtPosition(p) { const t = lines()[p.line] || ''; let s = p.character; let e = p.character; while (s > 0 && /\w/.test(t[s - 1])) s--; while (e < t.length && /\w/.test(t[e])) e++; return s === e ? undefined : new Range(p.line, s, p.line, e); },
    save() { return Promise.reject(unsupported('TextDocument.save')); },
  };
}

// ---- configuration --------------------------------------------------------------------
function configuration(section) {
  const defaults = {};
  const props = ((ext.pkg && ext.pkg.contributes && ext.pkg.contributes.configuration) || {});
  const all = Array.isArray(props) ? props : [props];
  for (const c of all) for (const [k, v] of Object.entries((c && c.properties) || {})) defaults[k] = v && v.default;
  const user = ext.settings || {};
  const key = (k) => (section ? `${section}.${k}` : k);
  return {
    get(k, d) { const f = key(k); if (f in user) return user[f]; if (f in defaults) return defaults[f]; return d; },
    has(k) { const f = key(k); return f in user || f in defaults; },
    inspect(k) { const f = key(k); return { key: f, defaultValue: defaults[f], globalValue: user[f] }; },
    update() { return Promise.reject(unsupported('WorkspaceConfiguration.update')); },
  };
}

// ---- the `vscode` module --------------------------------------------------------------
function selectorMatches(sel, doc) {
  const list = Array.isArray(sel) ? sel : [sel];
  return list.some((s) => (typeof s === 'string' ? s === '*' || s === doc.languageId : (!s.language || s.language === doc.languageId || s.language === '*')));
}
function reg(list, selector, provider) { const h = { selector, provider }; list.push(h); return new Disposable(() => { const i = list.indexOf(h); if (i >= 0) list.splice(i, 1); }); }

const diagnosticCollections = new Map();
const vscode = {
  version: '1.90.0-lain',
  Disposable, EventEmitter, Uri, Position, Range, Selection, Location, Diagnostic, DiagnosticSeverity,
  CompletionItem, CompletionItemKind, CompletionList, MarkdownString, Hover, TextEdit, WorkspaceEdit, CancellationTokenSource,
  StatusBarAlignment: Object.freeze({ Left: 1, Right: 2 }),
  ConfigurationTarget: Object.freeze({ Global: 1, Workspace: 2, WorkspaceFolder: 3 }),
  commands: {
    registerCommand(id, fn, thisArg) {
      handlers.commands.set(id, thisArg ? fn.bind(thisArg) : fn);
      send({ type: 'command', id });
      return new Disposable(() => { handlers.commands.delete(id); send({ type: 'command', id, removed: true }); });
    },
    executeCommand(id, ...args) {
      if (handlers.commands.has(id)) return Promise.resolve(handlers.commands.get(id)(...args));
      return request('commands.execute', { id, args });
    },
    getCommands() { return Promise.resolve([...handlers.commands.keys()]); },
  },
  window: {
    showInformationMessage(m) { send({ type: 'message', level: 'info', text: String(m) }); return Promise.resolve(undefined); },
    showWarningMessage(m) { send({ type: 'message', level: 'warn', text: String(m) }); return Promise.resolve(undefined); },
    showErrorMessage(m) { send({ type: 'message', level: 'error', text: String(m) }); return Promise.resolve(undefined); },
    createOutputChannel(name) {
      const say = (t) => log('info', `[${name}] ${t}`);
      return { name, append: say, appendLine: say, clear() {}, show() {}, hide() {}, dispose() {}, replace: say };
    },
    get activeTextEditor() {
      if (!active) return undefined;
      const doc = documents.get(active.path);
      if (!doc) return undefined;
      const s = active.selection || { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };
      return {
        document: doc, selection: new Selection(s.startLine, s.startCol, s.endLine, s.endCol), selections: [new Selection(s.startLine, s.startCol, s.endLine, s.endCol)],
        edit(cb) { const we = new WorkspaceEdit(); cb({ replace: (r, t) => we.replace(doc.uri, r, t), insert: (p, t) => we.insert(doc.uri, p, t), delete: (r) => we.delete(doc.uri, r) }); return vscode.workspace.applyEdit(we); },
      };
    },
    onDidChangeActiveTextEditor: (fn) => { docEvents.activeEditor.push(fn); return new Disposable(() => {}); },
    setStatusBarMessage(t) { send({ type: 'message', level: 'status', text: String(t) }); return new Disposable(); },
  },
  workspace: {
    get workspaceFolders() { return ext.workspace ? [{ uri: Uri.file(ext.workspace), name: path.basename(ext.workspace), index: 0 }] : undefined; },
    get rootPath() { return ext.workspace || undefined; },
    get textDocuments() { return [...documents.values()]; },
    getConfiguration: configuration,
    onDidChangeConfiguration: (fn) => { docEvents.config.push(fn); return new Disposable(() => {}); },
    onDidOpenTextDocument: (fn) => { docEvents.open.push(fn); return new Disposable(() => {}); },
    onDidChangeTextDocument: (fn) => { docEvents.change.push(fn); return new Disposable(() => {}); },
    onDidSaveTextDocument: (fn) => { docEvents.save.push(fn); return new Disposable(() => {}); },
    onDidCloseTextDocument: (fn) => { docEvents.close.push(fn); return new Disposable(() => {}); },
    async openTextDocument(u) {
      const p = typeof u === 'string' ? u : u.fsPath;
      if (documents.has(path.resolve(p))) return documents.get(path.resolve(p));
      const r = await request('workspace.read', { path: p });
      const d = makeDocument({ path: p, text: r.text, languageId: r.languageId });
      documents.set(path.resolve(p), d);
      return d;
    },
    async findFiles(include, exclude, max) { const r = await request('workspace.findFiles', { include: String(include && include.pattern ? include.pattern : include), exclude: exclude ? String(exclude) : null, max }); return r.files.map((f) => Uri.file(f)); },
    async applyEdit(we) {
      const edits = we.entries().map(([u, list]) => ({ path: u.fsPath, edits: list.map((e) => ({ start: [e.range.start.line, e.range.start.character], end: [e.range.end.line, e.range.end.character], text: e.newText })) }));
      const r = await request('workspace.applyEdit', { edits });
      return Boolean(r && r.ok);
    },
    fs: {
      async readFile(u) { const r = await request('fs.read', { path: u.fsPath }); return Buffer.from(r.base64, 'base64'); },
      async writeFile(u, bytes) { await request('fs.write', { path: u.fsPath, base64: Buffer.from(bytes).toString('base64') }); },
      async stat(u) { return request('fs.stat', { path: u.fsPath }); },
      async readDirectory(u) { const r = await request('fs.readDirectory', { path: u.fsPath }); return r.entries; },
      delete() { return Promise.reject(unsupported('workspace.fs.delete')); },
    },
  },
  languages: {
    createDiagnosticCollection(name = ext.id) {
      const store = new Map();
      const push = () => send({ type: 'diagnostics', collection: name, files: [...store.entries()].map(([p, list]) => ({ path: p, items: list.map((d) => ({ line: d.range.start.line, col: d.range.start.character, endLine: d.range.end.line, endCol: d.range.end.character, message: String(d.message), severity: d.severity, source: d.source || name, code: d.code != null ? String(d.code.value || d.code) : null })) })) });
      const c = {
        name,
        set(uri, list) { if (Array.isArray(uri)) { for (const [u, l] of uri) store.set(u.fsPath, l || []); } else store.set(uri.fsPath, list || []); push(); },
        delete(uri) { store.delete(uri.fsPath); push(); },
        clear() { store.clear(); push(); },
        get(uri) { return store.get(uri.fsPath) || []; },
        has(uri) { return store.has(uri.fsPath); },
        forEach(fn) { store.forEach((l, p) => fn(Uri.file(p), l, c)); },
        dispose() { store.clear(); push(); diagnosticCollections.delete(name); },
      };
      diagnosticCollections.set(name, c);
      return c;
    },
    registerCompletionItemProvider(sel, provider, ...triggers) { send({ type: 'provider', kind: 'completion', selector: sel, triggers }); return reg(handlers.completion, sel, provider); },
    registerHoverProvider(sel, provider) { send({ type: 'provider', kind: 'hover', selector: sel }); return reg(handlers.hover, sel, provider); },
    registerDefinitionProvider(sel, provider) { send({ type: 'provider', kind: 'definition', selector: sel }); return reg(handlers.definition, sel, provider); },
    registerDocumentFormattingEditProvider(sel, provider) { send({ type: 'provider', kind: 'formatting', selector: sel }); return reg(handlers.formatting, sel, provider); },
    getLanguages() { return Promise.resolve([...new Set([...documents.values()].map((d) => d.languageId))]); },
  },
  env: { appName: 'Noema', appRoot: '', language: 'en', machineId: 'lain', uriScheme: 'lain', sessionId: String(process.pid) },
  extensions: { getExtension(id) { return id === ext.id ? { id, extensionPath: ext.dir, packageJSON: ext.pkg, isActive: activated } : undefined; }, get all() { return [vscode.extensions.getExtension(ext.id)]; } },
};

/** Unknown members of the module and its namespaces fail loudly and are reported. */
function guard(obj, prefix) {
  return new Proxy(obj, {
    get(t, k) {
      if (typeof k === 'symbol' || k in t || k === 'then' || k === 'default' || k === '__esModule') return k === 'default' ? proxied : t[k];
      throw unsupported(prefix ? `${prefix}.${k}` : String(k));
    },
  });
}
for (const ns of ['commands', 'window', 'workspace', 'languages', 'env', 'extensions']) vscode[ns] = guard(vscode[ns], ns);
const proxied = guard(vscode, '');

// `require('vscode')` from the extension resolves to the subset above.
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return proxied;
  return realLoad.call(this, request, parent, isMain);
};

// ---- activation --------------------------------------------------------------------------
function memento(key) {
  const data = (ext.state && ext.state[key]) || {};
  return {
    get: (k, d) => (k in data ? data[k] : d),
    update: (k, v) => { data[k] = v; return request('state.update', { key, data }); },
    keys: () => Object.keys(data),
    setKeysForSync() {},
  };
}
async function activate() {
  if (activated) return true;
  if (activating) return activating;
  activating = (async () => {
    const main = path.resolve(ext.dir, ext.main || 'extension.js');
    let mod;
    try { mod = require(main); } catch (e) { send({ type: 'activation', ok: false, why: `could not load ${ext.main}: ${e && e.message}` }); throw e; }
    const context = {
      subscriptions: [], extensionPath: ext.dir, extensionUri: Uri.file(ext.dir),
      globalState: memento('global'), workspaceState: memento('workspace'),
      globalStorageUri: Uri.file(ext.storage), storageUri: Uri.file(ext.storage), logUri: Uri.file(ext.storage),
      globalStoragePath: ext.storage, storagePath: ext.storage, logPath: ext.storage,
      asAbsolutePath: (p) => path.join(ext.dir, p), extensionMode: 1,
      secrets: guard({}, 'ExtensionContext.secrets'),
      environmentVariableCollection: guard({}, 'ExtensionContext.environmentVariableCollection'),
    };
    try {
      if (typeof mod.activate === 'function') await mod.activate(context);
      activated = true;
      send({ type: 'activation', ok: true });
      return true;
    } catch (e) {
      send({ type: 'activation', ok: false, why: String((e && e.message) || e), unsupported: e && e.code === 'LAIN_UNSUPPORTED' });
      throw e;
    }
  })();
  return activating;
}

// ---- requests from Core ---------------------------------------------------------------------
function asPlain(v) { try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch { return String(v); } }
function docFor(p) { return documents.get(path.resolve(p)); }
function mdText(c) { return (Array.isArray(c) ? c : [c]).map((x) => (typeof x === 'string' ? x : x && (x.value || x.language ? `${x.value}` : ''))).join('\n'); }

const METHODS = {
  async activate() { await activate(); return { activated: true, commands: [...handlers.commands.keys()] }; },
  async executeCommand({ id, args = [] }) {
    await activate();
    const fn = handlers.commands.get(id);
    if (!fn) throw new Error(`${ext.id} registered no command "${id}"`);
    return asPlain(await fn(...args));
  },
  document({ event, path: p, text, languageId, version, selection }) {
    const key = path.resolve(p);
    if (event === 'close') { const d = documents.get(key); documents.delete(key); if (d) docEvents.close.forEach((f) => f(d)); return {}; }
    const d = makeDocument({ path: p, text, languageId, version });
    const had = documents.has(key);
    documents.set(key, d);
    if (event === 'active') { active = { path: key, selection }; docEvents.activeEditor.forEach((f) => { try { f(vscode.window.activeTextEditor); } catch { /* listener */ } }); }
    const list = event === 'save' ? docEvents.save : (had && event !== 'open' ? docEvents.change : docEvents.open);
    for (const f of list) { try { f(event === 'change' ? { document: d, contentChanges: [] } : d); } catch (e) { log('error', `document listener: ${e && e.message}`); } }
    return {};
  },
  async completion({ path: p, line, col }) {
    const d = docFor(p);
    if (!d) return { items: [] };
    const out = [];
    for (const h of handlers.completion) {
      if (!selectorMatches(h.selector, d)) continue;
      const r = await h.provider.provideCompletionItems(d, new Position(line, col), new CancellationTokenSource().token, { triggerKind: 0 });
      const items = Array.isArray(r) ? r : (r && r.items) || [];
      for (const it of items.slice(0, 200)) out.push({ label: typeof it.label === 'string' ? it.label : it.label && it.label.label, kind: it.kind, detail: it.detail || null, insertText: typeof it.insertText === 'string' ? it.insertText : (it.insertText && it.insertText.value) || null, documentation: it.documentation ? mdText(it.documentation) : null });
    }
    return { items: out };
  },
  async hover({ path: p, line, col }) {
    const d = docFor(p);
    if (!d) return { contents: [] };
    const parts = [];
    for (const h of handlers.hover) {
      if (!selectorMatches(h.selector, d)) continue;
      const r = await h.provider.provideHover(d, new Position(line, col), new CancellationTokenSource().token);
      if (r) parts.push(mdText(r.contents));
    }
    return { contents: parts };
  },
  ping() { return { pong: true, activated, commands: [...handlers.commands.keys()] }; },
};

process.on('message', async (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'res') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code }));
    else p.resolve(m.result);
    return;
  }
  if (m.type === 'req') {
    const fn = METHODS[m.method];
    try {
      if (!fn) throw new Error(`unknown method ${m.method}`);
      const result = await fn(m.params || {});
      send({ type: 'res', id: m.id, result });
    } catch (e) {
      send({ type: 'res', id: m.id, error: String((e && e.message) || e), code: e && e.code });
    }
  }
});

process.on('uncaughtException', (e) => { log('error', `uncaught: ${e && e.stack ? e.stack : e}`); send({ type: 'crash', why: String((e && e.message) || e) }); setTimeout(() => process.exit(70), 50); });
process.on('unhandledRejection', (e) => { log('error', `unhandled rejection: ${e && e.stack ? e.stack : e}`); });
process.on('disconnect', () => process.exit(0));

send({ type: 'ready', api: API_VERSION, pid: process.pid });
const events = (ext.pkg && ext.pkg.activationEvents) || [];
if (events.includes('*') || events.includes('onStartupFinished') || events.some((e) => String(e).startsWith('workspaceContains:'))) {
  activate().catch(() => {});
}

module.exports = { API_VERSION };
