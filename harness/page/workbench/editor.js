'use strict';

/**
 * THE IDE'S EDITOR — Monaco, the editor VS Code is built on, in LAIN's colours.
 *
 * ------------------------------------------------------------------------
 * WHO OWNS WHAT.
 *
 *   buffers, tabs, the tree, save     pagesource.js (LAIN.source) — unchanged
 *                                     owner; it asks this module to DRAW a file
 *   the bytes, encoding, line ending  Core (source.js) — decided from content
 *   definitions                       Core's project index + declaration scan
 *   problems                          Monaco's language services for the file
 *                                     in front, and Core's syntax checker for
 *                                     what was saved (diagnostics.js)
 *   what the person is looking at     reported to Core (POST /api/ide/context)
 *                                     so the BOT sees it without pasting
 *
 * ------------------------------------------------------------------------
 * VENDORED, NOT FETCHED BY THE PAGE. Monaco lives in `vendor/monaco` beside
 * index.html (webvendor.js fetched it once, pinned and verified). When it is
 * absent, `active()` is false and pagesource's built-in editor keeps working.
 */

const HTML = `
<div class="edsurface" id="edMonaco" hidden></div>
<div class="edimage" id="edImage" hidden><div class="ei-bar" id="edImageBar"></div><div class="ei-stage"><img id="edImageImg" alt=""></div></div>`;

const CSS = `
.srcEdit{position:relative}
.edsurface{position:absolute;inset:0;z-index:3}
.edimage{position:absolute;inset:0;z-index:3;display:grid;grid-template-rows:auto 1fr;background:var(--canvas)}
.ei-bar{padding:6px 14px;font-size:11.5px;color:var(--text-muted);border-bottom:1px solid var(--separator)}
.ei-stage{overflow:auto;display:grid;place-items:center;background:repeating-conic-gradient(#15171b 0 25%,#1b1d22 0 50%) 0 0/16px 16px}
.ei-stage img{max-width:96%;max-height:96%;image-rendering:auto;box-shadow:0 0 0 1px var(--border-subtle)}
.srcRow.dim .nm{opacity:.55}
.srcRow.drop{background:var(--selection);box-shadow:inset 0 0 0 1px var(--accent-border)}
.monaco-editor .lain-hit{background:#8f9bff22}
.monaco-editor .lain-hit-gutter{border-left:2px solid var(--accent-primary)}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var M = null;               // the monaco namespace, once loaded
  var ed = null;              // the one editor instance
  var state = 'unloaded';     // unloaded | loading | ready | absent
  var models = {};            // path -> { model, view, rev, sub }
  var shown = null;           // path in front
  var hitDeco = [];
  var ctxTimer = 0;
  var lintOwner = 'lain';
  var coreMarkers = {};       // path -> markers from Core's syntax check

  function src() { return L.source; }
  function root() { var S = L.state(); return S && S.workspace && S.workspace.project ? S.workspace.project.root : ''; }

  // ---- loading ----------------------------------------------------------------------
  function load() {
    if (state !== 'unloaded') return;
    state = 'loading';
    var probe = new XMLHttpRequest();
    probe.open('GET', 'vendor/monaco/VERSION');
    probe.onload = function () {
      if (probe.status !== 200) { state = 'absent'; return; }
      var s = document.createElement('script');
      s.src = 'vendor/monaco/vs/loader.js';
      s.onerror = function () { state = 'absent'; };
      s.onload = function () {
        window.require.config({ paths: { vs: 'vendor/monaco/vs' } });
        window.require(['vs/editor/editor.main'], function () { M = window.monaco; init(); }, function () { state = 'absent'; });
      };
      document.head.appendChild(s);
    };
    probe.onerror = function () { state = 'absent'; };
    probe.send();
  }

  /**
   * THE EDITOR WEARS THE WORKBENCH'S PALETTE (2026-09-30): its background is the plane it sits on, its accents
   * the palette's, in light and dark. The theme id stays 'lain-dark' (the split and diff editors name it); it is
   * redefined whenever the appearance changes, and Monaco repaints every editor.
   */
  function tok(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  }
  function theme() {
    var light = document.documentElement.getAttribute('data-mode') === 'light';
    var bg = tok('--surface-base', light ? '#FFFFFF' : '#141B24');
    var raised = tok('--surface-raised', light ? '#F3F5F9' : '#1A2230');
    var active = tok('--surface-active', light ? '#E8ECF3' : '#232D3D');
    var text = tok('--text-primary', light ? '#141A23' : '#E7ECF3');
    var muted = tok('--text-muted', light ? '#8A94A6' : '#6E7888');
    var second = tok('--text-secondary', light ? '#4E596B' : '#A3ADBD');
    var border = tok('--border-subtle', light ? '#D9DEE7' : '#283243');
    var accent = tok('--accent-primary', light ? '#6D5AE6' : '#9B8AFB');
    var strip = function (h) { return h.replace('#', ''); };
    M.editor.defineTheme('lain-dark', {
      base: light ? 'vs' : 'vs-dark', inherit: true,
      rules: light ? [
        { token: 'comment', foreground: '8a94a6', fontStyle: 'italic' },
        { token: 'keyword', foreground: '5b48d6' },
        { token: 'string', foreground: '2f8a4c' },
        { token: 'number', foreground: 'b4631f' },
        { token: 'type', foreground: '0f8a80' },
        { token: 'type.identifier', foreground: '0f8a80' },
        { token: 'delimiter', foreground: '6b7384' },
        { token: 'tag', foreground: 'a23fbf' },
        { token: 'attribute.name', foreground: '5b48d6' },
        { token: 'variable', foreground: strip(text) },
      ] : [
        { token: 'comment', foreground: '6b7486', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'b3a6ff' },
        { token: 'string', foreground: '9fd99a' },
        { token: 'number', foreground: 'e8b27a' },
        { token: 'type', foreground: '6fdcca' },
        { token: 'type.identifier', foreground: '6fdcca' },
        { token: 'delimiter', foreground: '9aa4b5' },
        { token: 'tag', foreground: 'e79ad0' },
        { token: 'attribute.name', foreground: 'b3a6ff' },
        { token: 'variable', foreground: strip(text) },
      ],
      colors: {
        'editor.background': bg, 'editor.foreground': text,
        'editorLineNumber.foreground': muted, 'editorLineNumber.activeForeground': second,
        'editor.lineHighlightBackground': raised, 'editor.lineHighlightBorder': raised,
        'editor.selectionBackground': accent + '4D', 'editor.inactiveSelectionBackground': accent + '2E',
        'editorCursor.foreground': accent, 'editorIndentGuide.background1': border,
        'editorWidget.background': raised, 'editorWidget.border': border,
        'editorSuggestWidget.background': raised, 'editorSuggestWidget.selectedBackground': active,
        'input.background': active, 'focusBorder': accent + '59',
        'scrollbarSlider.background': border + '99', 'minimap.background': bg,
        'editorGutter.background': bg, 'editorError.foreground': tok('--danger', '#F16D7A'), 'editorWarning.foreground': tok('--warning', '#F2B84B'),
        'editorStickyScroll.background': bg, 'editorStickyScrollHover.background': raised,
      },
    });
    M.editor.setTheme('lain-dark');
  }

  /**
   * TYPESCRIPT / JAVASCRIPT AS A PROJECT WOULD HAVE IT: Node resolution, JSX,
   * JS allowed. Package types in node_modules are not loaded into the editor,
   * so "cannot find module 'react'" (2307/2792/7016) is not reported — a
   * missing RELATIVE module is still seen, because the files a file imports are
   * loaded as models (see `imports`).
   */
  function typescript() {
    var ts = M.languages.typescript;
    if (!ts) return;
    [ts.typescriptDefaults, ts.javascriptDefaults].forEach(function (d) {
      d.setCompilerOptions({
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs,
        allowJs: true, checkJs: false, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, allowSyntheticDefaultImports: true,
        allowNonTsExtensions: true, skipLibCheck: true, resolveJsonModule: true,
      });
      d.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [2307, 2792, 7016] });
      d.setEagerModelSync(true);
    });
  }

  /** Load the project files this file imports, so types resolve across files. */
  var importsDone = {};
  async function imports(f) {
    if (!/^(typescript|javascript)$/.test(f.mode || '') || importsDone[f.path]) return;
    importsDone[f.path] = true;
    var specs = [];
    var re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
    var m;
    while ((m = re.exec(f.body)) && specs.length < 30) specs.push(m[1]);
    if (!specs.length) return;
    var r = await L.api('/api/ide/resolve', { from: f.path, specs: specs });
    ((r && r.files) || []).forEach(function (x) { ensureModel(x.path); });
  }

  function init() {
    theme();
    // A NEW MODE OR PALETTE repaints the editor in it (tokens are applied first, then this reads them).
    if (L.appearance && L.appearance.onChange) L.appearance.onChange(function () { setTimeout(function () { if (M) theme(); }, 0); });
    typescript();
    var host = $('edMonaco');
    ed = M.editor.create(host, {
      theme: 'lain-dark', automaticLayout: true, fontFamily: '"Cascadia Code","Cascadia Mono",Consolas,monospace',
      fontSize: Number((function () { try { return localStorage.getItem('lain.editorSize') || '13'; } catch (e) { return '13'; } })()),
      fontLigatures: true, minimap: { enabled: true, scale: 1, renderCharacters: false }, scrollBeyondLastLine: false,
      renderWhitespace: 'selection', smoothScrolling: false, cursorBlinking: 'smooth', bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active' }, stickyScroll: { enabled: true }, tabSize: 2, detectIndentation: true, model: null,
    });
    // VS CODE'S KEYS, where the editor would otherwise swallow them.
    var K = M.KeyMod, C = M.KeyCode;
    ed.addCommand(K.CtrlCmd | C.KeyS, function () { src().save(false); });
    ed.addCommand(K.CtrlCmd | K.Shift | C.KeyS, function () { saveAs(); });
    ed.addCommand(K.CtrlCmd | C.KeyP, function () { src().quickOpen(); });
    ed.addCommand(K.CtrlCmd | K.Shift | C.KeyP, function () { L.search.palette('>'); });
    ed.addCommand(K.CtrlCmd | C.KeyW, function () { closeActive(); });
    ed.addCommand(K.CtrlCmd | C.Tab, function () { cycle(1); });
    ed.addCommand(K.CtrlCmd | K.Shift | C.Tab, function () { cycle(-1); });
    ed.addCommand(K.CtrlCmd | C.KeyB, function () { L.ide.toggleSide(); });
    ed.addCommand(K.CtrlCmd | C.KeyJ, function () { L.ide.togglePanel(); });
    ed.addCommand(K.CtrlCmd | C.Backquote, function () { L.ide.showPanel('TERMINAL'); });
    ed.addCommand(K.CtrlCmd | K.Shift | C.KeyF, function () { L.ide.showPane('search'); });
    ed.addCommand(K.CtrlCmd | K.Alt | C.KeyB, function () { L.ide.toggleBot(); });
    // NAVIGATION IS LAIN'S OWN ACTIONS — F12, Shift+F12, F2 — so they work for
    // every language, not only the ones with a Monaco service, and so they open
    // files through the IDE's buffers. They appear in F1 and the context menu.
    ed.addAction({ id: 'lain.goToDefinition', label: 'Go to Definition', keybindings: [C.F12], contextMenuGroupId: 'navigation', contextMenuOrder: 1, run: function () { goToDefinition(); } });
    ed.addAction({ id: 'lain.findReferences', label: 'Find All References', keybindings: [K.Shift | C.F12], contextMenuGroupId: 'navigation', contextMenuOrder: 2, run: function () { findReferences(); } });
    ed.addAction({ id: 'lain.renameSymbol', label: 'Rename Symbol', keybindings: [C.F2], contextMenuGroupId: '1_modification', contextMenuOrder: 1, run: function () { renameSymbol(); } });
    ed.addAction({ id: 'lain.askBot', label: 'Ask BOT about Selection', keybindings: [K.CtrlCmd | K.Shift | C.KeyL], contextMenuGroupId: 'lain', contextMenuOrder: 1, run: function () { if (L.ide && L.ide.askAboutSelection) L.ide.askAboutSelection(); } });
    ed.addAction({
      id: 'lain.formatDocument', label: 'Format Document', keybindings: [K.Shift | K.Alt | C.KeyF], contextMenuGroupId: '1_modification', contextMenuOrder: 2,
      run: function () {
        var a = ed.getAction('editor.action.formatDocument');
        if (!a) return;
        formatting = true;
        return Promise.resolve(a.run()).then(function () { formatting = false; }, function () { formatting = false; });
      },
    });
    // THE THEME PRESET AND PALETTE (pagekeymap.js) — the editor follows the window.
    if (L.keymap) L.keymap.applyEditor();
    ed.onDidChangeCursorSelection(function () { status(); report(); if (L.source && L.source.crumbs) L.source.crumbs(); });
    registerProviders();
    M.editor.onDidChangeMarkers(function () { if (L.ide && L.ide.problemsChanged) L.ide.problemsChanged(); report(); });
    // THE PERSON'S EDITOR PROFILE (Core's editor.json — imported VS Code /
    // Cursor settings, keys and snippets, plus extension snippets): pageprofile.js.
    if (L.profile) L.profile.attach(M, ed);
    extensionLanguages();
    state = 'ready';
    src().renderEditor();
  }

  /**
   * LANGUAGES EXTENSIONS DECLARE (contributes.languages): their file associations
   * reach the editor, so a .lt file opens as "lt". No grammar is applied — the
   * compatibility report says so (Core: exthost/manager.js).
   */
  function extensionLanguages() {
    L.api('/api/exthost/status', {}).then(function (r) {
      var known = {};
      M.languages.getLanguages().forEach(function (l) { known[l.id] = true; });
      ((r && r.extensions) || []).forEach(function (x) {
        if (!x.enabled) return;
        (x.languages || []).forEach(function (l) {
          if (known[l.id]) return;
          known[l.id] = true;
          M.languages.register({ id: l.id, extensions: l.extensions, filenames: l.filenames, aliases: l.aliases });
        });
      });
    }, function () { /* no extensions: nothing to associate */ });
  }

  // ---- languages: definitions and references from Core ------------------------------
  function relOf(uri) { return decodeURIComponent(String(uri.path || '').replace(/^\//, '')); }
  function uriOf(rel) { return M.Uri.from({ scheme: 'file', path: '/' + rel }); }

  function registerProviders() {
    var langs = M.languages.getLanguages().map(function (l) { return l.id; });
    // OPENING ANOTHER FILE from a peek or a Go to Definition goes through the
    // IDE's own buffers, so the tab, the tree and the save token stay right.
    if (M.editor.registerEditorOpener) {
      M.editor.registerEditorOpener({
        openCodeEditor: function (source, resource, where) {
          var line = where && (where.startLineNumber || where.lineNumber);
          src().openFile(relOf(resource), { line: line || 1 });
          return true;
        },
      });
    }
    langs.forEach(function (id) {
      M.languages.registerDefinitionProvider(id, {
        provideDefinition: async function (model, pos) {
          var w = model.getWordAtPosition(pos);
          if (!w) return [];
          var r = await L.api('/api/ide/definition', { name: w.word });
          if (!r || !r.ok) return [];
          var out = [];
          for (var i = 0; i < r.locations.length; i++) {
            var loc = r.locations[i];
            await ensureModel(loc.path);
            out.push({ uri: uriOf(loc.path), range: new M.Range(loc.line, 1, loc.line, 1) });
          }
          return out;
        },
      });
      M.languages.registerReferenceProvider(id, {
        provideReferences: async function (model, pos) {
          var w = model.getWordAtPosition(pos);
          if (!w) return [];
          var r = await L.api('/api/files/search', { query: w.word, wholeWord: true, caseSensitive: true });
          if (!r || !r.ok) return [];
          var out = [];
          for (var i = 0; i < r.files.length && out.length < 300; i++) {
            var f = r.files[i];
            await ensureModel(f.path);
            f.hits.forEach(function (h) { out.push({ uri: uriOf(f.path), range: new M.Range(h.line, h.col, h.line, h.col + h.len) }); });
          }
          return out;
        },
      });
    });
  }

  // ---- F12 / Shift+F12 / F2 ------------------------------------------------------------
  function tsWorkerFor(model) {
    var ts = M.languages.typescript;
    var lang = model.getLanguageId();
    if (!ts || (lang !== 'typescript' && lang !== 'javascript')) return null;
    return (lang === 'typescript' ? ts.getTypeScriptWorker : ts.getJavaScriptWorker)().then(function (get) { return get(model.uri); });
  }
  function lineAt(fileName, start) {
    var m = M.editor.getModel(M.Uri.parse(fileName));
    return m ? m.getPositionAt(start).lineNumber : 1;
  }

  async function goToDefinition() {
    var model = ed.getModel();
    var pos = ed.getPosition();
    if (!model || !pos) return;
    var w = model.getWordAtPosition(pos);
    try {
      var tw = tsWorkerFor(model);
      if (tw) {
        var worker = await tw;
        var defs = await worker.getDefinitionAtPosition(model.uri.toString(), model.getOffsetAt(pos));
        if (defs && defs.length && !/lib\..*\.d\.ts$/.test(defs[0].fileName)) {
          var target = relOf(M.Uri.parse(defs[0].fileName));
          await src().openFile(target, { line: lineAt(defs[0].fileName, defs[0].textSpan.start) });
          return;
        }
      }
    } catch (e) { /* fall through to the project index */ }
    if (!w) return;
    var r = await L.api('/api/ide/definition', { name: w.word });
    var locs = (r && r.locations) || [];
    if (!locs.length) { L.toast('No definition found for ' + w.word); return; }
    if (locs.length === 1) { src().openFile(locs[0].path, { line: locs[0].line }); return; }
    L.popover(document.getElementById('srcCrumbs').hidden ? document.getElementById('srcTabs') : document.getElementById('srcCrumbs'), function (p) {
      p.appendChild(el('h4', '', locs.length + ' definitions of ' + w.word));
      locs.forEach(function (x) {
        var b = el('button', 'opt', x.path + ':' + x.line);
        b.onclick = function () { L.closePop(); src().openFile(x.path, { line: x.line }); };
        p.appendChild(b);
      });
    });
  }

  function findReferences() {
    var model = ed.getModel();
    var pos = ed.getPosition();
    var w = model && pos && model.getWordAtPosition(pos);
    if (!w) return;
    if (L.ide && L.ide.searchFor) L.ide.searchFor(w.word, { wholeWord: true, caseSensitive: true, regex: false });
  }

  /**
   * RENAME: TypeScript/JavaScript through the language service, across every
   * loaded file — the edits land in open buffers, marked unsaved, for the
   * person to review and save. Other languages have no rename service here,
   * and a text replace is not a rename, so the work is offered to the Coding
   * Agent instead of guessed at.
   */
  async function renameSymbol() {
    var model = ed.getModel();
    var pos = ed.getPosition();
    var w = model && pos && model.getWordAtPosition(pos);
    if (!w) return;
    var tw = tsWorkerFor(model);
    if (!tw) {
      var go = await L.confirm('Rename "' + w.word + '" across the project? This language has no rename service in the editor, so the Coding Agent will do it and show the changes.', { ok: 'Ask the Coding Agent' });
      if (go && L.ide && L.ide.askBot) L.ide.askBot('Rename the symbol `' + w.word + '` (in ' + src().current().path + ') everywhere it is used in the project, and update all references.', 'agent');
      return;
    }
    var v = await L.dialog({ title: 'Rename ' + w.word, fields: [{ key: 'n', label: 'New name', value: w.word }], ok: 'Rename' });
    if (!v || !v.n || v.n === w.word) return;
    var worker = await tw;
    var locs = await worker.findRenameLocations(model.uri.toString(), model.getOffsetAt(pos), false, false, false);
    if (!locs || !locs.length) { L.toast('This symbol cannot be renamed here.', true); return; }
    var byFile = {};
    locs.forEach(function (l) { (byFile[l.fileName] = byFile[l.fileName] || []).push(l); });
    var files = Object.keys(byFile);
    for (var i = 0; i < files.length; i++) {
      var rel = relOf(M.Uri.parse(files[i]));
      await src().openFile(rel);
      var m = M.editor.getModel(M.Uri.parse(files[i]));
      if (!m) continue;
      var edits = byFile[files[i]].sort(function (a, b) { return b.textSpan.start - a.textSpan.start; }).map(function (l) {
        var a = m.getPositionAt(l.textSpan.start), b = m.getPositionAt(l.textSpan.start + l.textSpan.length);
        return { range: new M.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: v.n };
      });
      m.pushEditOperations([], edits, function () { return null; });
    }
    L.toast('Renamed ' + locs.length + ' occurrence' + (locs.length === 1 ? '' : 's') + ' in ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' \u2014 review and save.');
  }

  /** A model for a file not open in a tab, for peeks. Read-only until opened. */
  async function ensureModel(rel) {
    var uri = uriOf(rel);
    if (M.editor.getModel(uri)) return;
    var r = await L.api('/api/files/open', { path: rel });
    if (!r || !r.ok || r.kind !== 'text') return;
    if (!M.editor.getModel(uri)) M.editor.createModel(r.body, r.mode || undefined, uri);
  }

  // ---- drawing a file ------------------------------------------------------------------
  function active() { return state === 'ready'; }
  var formatting = false;
  /** How the save of this buffer is recorded: FORMATTER only when nothing but the formatter changed it. */
  function saveOrigin(path) {
    var buf = src().state().open.filter(function (x) { return x.path === path; })[0];
    if (!buf) return 'USER';
    var o = buf.formatted && !buf.typed ? 'FORMATTER' : 'USER';
    buf.formatted = false; buf.typed = false;
    return o;
  }

  function hideSurfaces() { $('edMonaco').hidden = true; $('edImage').hidden = true; }

  /** Draw `f`, or say this module does not (pagesource then uses its fallback). */
  /**
   * THE ONE MODEL FOR A FILE, shared by every editor group (pagegroups.js): an
   * edit typed in any group changes the one buffer. Created the way render()
   * creates it, with the same change listener.
   */
  function modelFor(f) {
    if (!M || !f) return null;
    if (!models[f.path]) {
      var uri = uriOf(f.path);
      var existing = M.editor.getModel(uri);
      var model = existing || M.editor.createModel(f.body, f.mode || undefined, uri);
      var cur = models[f.path] = { model: model, view: null, rev: f.rev || 0 };
      cur.sub = model.onDidChangeContent(function () {
        var buf = src().state().open.filter(function (x) { return x.path === f.path; })[0];
        if (!buf) return;
        buf.body = model.getValue();
        var dirty = buf.body !== buf.saved;
        if (dirty) { if (formatting) buf.formatted = true; else buf.typed = true; }
        if (dirty !== buf.dirty) { buf.dirty = dirty; src().renderTabs(); }
        report();
      });
    }
    return models[f.path].model;
  }

  function render(f) {
    if (state === 'unloaded') load();
    if (!f) { hideSurfaces(); shown = null; if (ed) ed.setModel(null); status(); report(); return active(); }
    if (f.kind === 'image') { showImage(f); return true; }
    if (!active()) { hideSurfaces(); return false; }
    $('edImage').hidden = true;
    $('edMonaco').hidden = false;
    var cur = models[f.path];
    if (!cur) {
      var uri = uriOf(f.path);
      var existing = M.editor.getModel(uri);
      var model = existing || M.editor.createModel(f.body, f.mode || undefined, uri);
      if (existing) { if (existing.getValue() !== f.body) existing.setValue(f.body); if (f.mode) M.editor.setModelLanguage(existing, f.mode); }
      cur = models[f.path] = { model: model, view: null, rev: f.rev || 0 };
      cur.sub = model.onDidChangeContent(function () {
        var buf = src().state().open.filter(function (x) { return x.path === f.path; })[0];
        if (!buf) return;
        buf.body = model.getValue();
        var dirty = buf.body !== buf.saved;
        // WHO MADE THIS EDIT, for Core's provenance ledger: the formatter
        // (while lain.formatDocument runs) or the person.
        if (dirty) { if (formatting) buf.formatted = true; else buf.typed = true; }
        if (dirty !== buf.dirty) { buf.dirty = dirty; src().renderTabs(); }
        report();
      });
    } else if ((f.rev || 0) !== cur.rev) {
      // THE FILE MOVED ON DISK (LAIN edited it) and the buffer was clean: the
      // model follows, as one undoable edit rather than a reset.
      cur.rev = f.rev || 0;
      cur.model.pushEditOperations([], [{ range: cur.model.getFullModelRange(), text: f.body }], function () { return null; });
    }
    if (shown !== f.path) {
      if (shown && models[shown]) models[shown].view = ed.saveViewState();
      ed.setModel(cur.model);
      if (cur.view) ed.restoreViewState(cur.view);
      shown = f.path;
      touched(f.path);
      imports(f);
    }
    status();
    report();
    return true;
  }

  async function showImage(f) {
    $('edMonaco').hidden = true;
    $('edImage').hidden = false;
    shown = f.path;
    var img = $('edImageImg');
    if (img.dataset.path === f.path) return;
    img.dataset.path = f.path;
    img.removeAttribute('src');
    $('edImageBar').textContent = f.path + ' \u00b7 reading\u2026';
    var r = await L.api('/api/files/raw', { path: f.path });
    if (!r || !r.ok) { $('edImageBar').textContent = f.path + ' \u00b7 ' + ((r && r.why) || 'cannot preview'); return; }
    img.onload = function () { $('edImageBar').textContent = f.path + ' \u00b7 ' + img.naturalWidth + '\u00d7' + img.naturalHeight + ' \u00b7 ' + Math.max(1, Math.round(r.size / 1024)) + ' KB'; };
    img.src = 'data:' + r.mime + ';base64,' + r.data;
  }

  function dispose(p) {
    var m = models[p];
    if (!m) return;
    if (m.sub) m.sub.dispose();
    if (shown === p && ed) { ed.setModel(null); shown = null; }
    m.model.dispose();
    delete models[p];
    delete coreMarkers[p];
  }

  function hits(f, lines) {
    if (!ed || !models[f.path]) return;
    hitDeco = ed.deltaDecorations(hitDeco, (lines || []).map(function (n) {
      return { range: new M.Range(n + 1, 1, n + 1, 1), options: { isWholeLine: true, className: 'lain-hit', linesDecorationsClassName: 'lain-hit-gutter' } };
    }));
    if (lines && lines.length) ed.revealLineInCenterIfOutsideViewport(lines[0] + 1);
  }

  function reveal(n, opts) {
    if (!ed) return;
    var line = Math.max(1, Number(n) || 1);
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    // A FILE OPENED TO SHOW SOMETHING (the owner of a picked element) leaves the keyboard where the person is.
    if (!(opts && opts.focus === false)) ed.focus();
  }

  function cursor() {
    if (!ed || !ed.getModel()) return null;
    var p = ed.getPosition();
    return p ? { line: p.lineNumber, col: p.column } : null;
  }

  function find(replace) {
    if (!ed) return;
    ed.focus();
    var a = ed.getAction(replace ? 'editor.action.startFindReplaceAction' : 'actions.find');
    if (a) a.run();
  }

  // ---- tabs --------------------------------------------------------------------------------
  function closeActive() { var st = src().state(); if (st.active >= 0) src().close(st.active); }
  function cycle(d) {
    var st = src().state();
    if (!st.open.length) return;
    src().activate((st.active + d + st.open.length) % st.open.length);
  }

  // ---- recent files, per project -------------------------------------------------------
  function recentKey() { return 'lain.recent.' + root().toLowerCase(); }
  function recent() { try { return JSON.parse(localStorage.getItem(recentKey()) || '[]'); } catch (e) { return []; } }
  function touched(p) {
    if (!root()) return;
    var list = recent().filter(function (x) { return x !== p; });
    list.unshift(p);
    try { localStorage.setItem(recentKey(), JSON.stringify(list.slice(0, 30))); } catch (e) { /* storage unavailable */ }
  }

  // ---- status bar facts ----------------------------------------------------------------
  function status() {
    var f = src().current();
    var c = cursor();
    var sel = ed && ed.getSelection();
    var n = sel && !sel.isEmpty() && ed.getModel() ? ed.getModel().getValueInRange(sel).length : 0;
    var pos = $('sbPos');
    if (pos) pos.textContent = f && f.kind === 'text' && c ? 'Ln ' + c.line + ', Col ' + c.col + (n ? ' (' + n + ' selected)' : '') : '';
  }

  // ---- problems ----------------------------------------------------------------------------
  function sev(s) { return s === 8 ? 'error' : s === 4 ? 'warning' : s === 2 ? 'info' : 'hint'; }
  /** Every problem LAIN knows about, file by file. */
  function problems() {
    var out = [];
    if (M) {
      M.editor.getModelMarkers({}).forEach(function (m) {
        var rel = relOf(m.resource);
        if (!models[rel]) return;
        out.push({ path: rel, line: m.startLineNumber, col: m.startColumn, severity: sev(m.severity), message: m.message, source: m.owner === lintOwner ? 'LAIN' : (m.source || m.owner) });
      });
    }
    Object.keys(coreMarkers).forEach(function (p) {
      if (M && models[p]) return;
      (coreMarkers[p] || []).forEach(function (m) { out.push(m); });
    });
    var rank = { error: 0, warning: 1, info: 2, hint: 3 };
    return out.sort(function (a, b) { return (rank[a.severity] - rank[b.severity]) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line); });
  }

  /** After a save: Core's syntax check of what is on disk. */
  async function checkSaved(p) {
    var r = await L.api('/api/files/check', { path: p });
    if (!r || !r.ok || r.inconclusive) { coreMarkers[p] = []; }
    else coreMarkers[p] = r.clean ? [] : [{ path: p, line: r.line || 1, col: 1, severity: 'error', message: r.message, source: 'LAIN' }];
    if (M && models[p]) {
      M.editor.setModelMarkers(models[p].model, lintOwner, coreMarkers[p].map(function (m) {
        return { severity: M.MarkerSeverity.Error, message: m.message, startLineNumber: m.line, startColumn: 1, endLineNumber: m.line, endColumn: 1000 };
      }));
    }
    if (L.ide && L.ide.problemsChanged) L.ide.problemsChanged();
  }

  // ---- what the BOT should know is on screen -------------------------------------
  function report() {
    clearTimeout(ctxTimer);
    ctxTimer = setTimeout(function () {
      var S = L.state();
      if (!S || !S.workspace || !S.workspace.project || !S.workspace.project.attached) return;
      // THE GROUP WITH FOCUS is what "this" refers to (pagegroups.js); group 1 otherwise.
      var fg = L.groups && L.groups.focused ? L.groups.focused() : null;
      var edx = fg ? fg.ed : ed;
      var f = fg ? (src().state().open.filter(function (x) { return x.path === fg.path; })[0] || src().current()) : src().current();
      var sel = edx && edx.getSelection();
      var model = edx && edx.getModel();
      var selection = null;
      if (sel && model && !sel.isEmpty()) selection = { text: model.getValueInRange(sel).slice(0, 6000), startLine: sel.startLineNumber, endLine: sel.endLineNumber, startCol: sel.startColumn, endCol: sel.endColumn };
      else if (!active() && f) {
        var t = $('srcText');
        if (t && t.selectionStart !== t.selectionEnd) {
          var before = t.value.slice(0, t.selectionStart);
          selection = { text: t.value.slice(t.selectionStart, t.selectionEnd).slice(0, 6000), startLine: before.split('\n').length, endLine: before.split('\n').length + t.value.slice(t.selectionStart, t.selectionEnd).split('\n').length - 1 };
        }
      }
      L.api('/api/ide/context', {
        file: f ? f.path : null, language: f ? (f.mode || f.language) : null, cursor: f ? cursor() : null, selection: selection,
        tabs: src().state().open.map(function (x) { return x.path; }),
        diagnostics: problems().slice(0, 40),
        terminal: L.terminal && L.terminal.activeId ? L.terminal.activeId() : null,
      }).catch(function () { /* the next change reports again */ });
    }, 700);
  }

  // ---- explorer: menu, drag to move, new file, Save As ------------------------------
  function parentOf(p) { var i = String(p).lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  async function askPath(title, value, ok) {
    var v = await L.dialog({ title: title, fields: [{ key: 'p', label: 'Path in the project', value: value }], ok: ok || 'OK' });
    return v && v.p && v.p.trim() ? v.p.trim().split('\\').join('/') : null;
  }
  async function afterChange(dir) { await src().reloadDir(dir || '.'); if (L.poll) L.poll(); }

  async function newFile(dir) {
    var p = await askPath('New File', dir ? dir + '/' : '', 'Create');
    if (!p) return;
    var r = await L.api('/api/files/create', { path: p, body: '' });
    if (!r.ok) return L.toast(r.why, true);
    await afterChange(parentOf(r.path));
    src().openFile(r.path);
  }
  async function newFolder(dir) {
    var p = await askPath('New Folder', dir ? dir + '/' : '', 'Create');
    if (!p) return;
    var r = await L.api('/api/files/mkdir', { path: p });
    if (!r.ok) return L.toast(r.why, true);
    await afterChange(parentOf(r.path));
  }
  async function renameEntry(e) {
    var p = await askPath('Rename', e.path, 'Rename');
    if (!p || p === e.path) return;
    await move(e, p);
  }
  async function move(e, to) {
    var dirty = src().state().open.filter(function (f) { return f.dirty && (f.path === e.path || f.path.indexOf(e.path + '/') === 0); });
    if (dirty.length) return L.toast('Save or close ' + dirty[0].path + ' before moving it.', true);
    var r = await L.api('/api/files/rename', { from: e.path, to: to });
    if (!r.ok) return L.toast(r.why, true);
    // OPEN BUFFERS FOLLOW THE FILE: closed at the old path, reopened at the new.
    var st = src().state();
    var reopen = [];
    for (var i = st.open.length - 1; i >= 0; i--) {
      var f = st.open[i];
      if (f.path === e.path || f.path.indexOf(e.path + '/') === 0) { reopen.push(r.path + f.path.slice(e.path.length)); dispose(f.path); st.open.splice(i, 1); }
    }
    if (st.active >= st.open.length) st.active = st.open.length - 1;
    src().renderTabs(); src().renderEditor();
    await afterChange('.');
    reopen.forEach(function (p) { src().openFile(p); });
  }
  async function removeEntry(e) {
    var yes = await L.confirm('Delete ' + e.path + '? It goes to the Recycle Bin.', { ok: 'Move to Recycle Bin', danger: true });
    if (!yes) return;
    var r = await L.api('/api/files/delete', { path: e.path });
    if (!r.ok) return L.toast(r.why, true);
    var st = src().state();
    for (var i = st.open.length - 1; i >= 0; i--) {
      var f = st.open[i];
      if (f.path === e.path || f.path.indexOf(e.path + '/') === 0) { dispose(f.path); st.open.splice(i, 1); }
    }
    if (st.active >= st.open.length) st.active = st.open.length - 1;
    src().renderTabs(); src().renderEditor();
    await afterChange(parentOf(e.path));
  }
  function copy(text) { L.api('/api/clipboard/write', { text: text }).then(function (r) { if (r && !r.ok) L.toast(r.why, true); }); }

  function treeMenu(e, ev) {
    ev.preventDefault();
    ev.stopPropagation();
    var dir = e.dir ? e.path : parentOf(e.path);
    var items = [
      ['New File\u2026', function () { newFile(dir); }],
      ['New Folder\u2026', function () { newFolder(dir); }],
      null,
      ['Rename\u2026', function () { renameEntry(e); }],
      ['Delete', function () { removeEntry(e); }],
      null,
      ['Copy Path', function () { copy(root() ? root().replace(/[\\/]$/, '') + '\\' + e.path.split('/').join('\\') : e.path); }],
      ['Copy Relative Path', function () { copy(e.path); }],
      null,
      // PREVIEW FROM THE PROJECT (Phase 8.2): the project's page, not only through the Agent.
      ['Open Preview', function () { if (L.preview && L.preview.open) L.preview.open(); }],
    ];
    var m = $('ctxMenu');
    m.textContent = '';
    items.forEach(function (it) {
      if (!it) { m.appendChild(el('div', 'sep')); return; }
      var b = el('button', '', it[0]);
      b.type = 'button';
      b.onclick = function () { m.hidden = true; it[1](); };
      m.appendChild(b);
    });
    m.hidden = false;
    var r = m.getBoundingClientRect();
    m.style.left = Math.min(ev.clientX, window.innerWidth - r.width - 6) + 'px';
    m.style.top = Math.min(ev.clientY, window.innerHeight - r.height - 6) + 'px';
  }

  var dragging = null;
  function decorateRow(row, e) {
    row.addEventListener('contextmenu', function (ev) { treeMenu(e, ev); });
    row.draggable = true;
    row.addEventListener('dragstart', function (ev) { dragging = e; ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', e.path); } catch (x) { /* fine */ } });
    row.addEventListener('dragend', function () { dragging = null; });
    if (e.dir) {
      row.addEventListener('dragover', function (ev) { if (dragging && dragging.path !== e.path) { ev.preventDefault(); row.classList.add('drop'); } });
      row.addEventListener('dragleave', function () { row.classList.remove('drop'); });
      row.addEventListener('drop', function (ev) {
        ev.preventDefault();
        row.classList.remove('drop');
        var d = dragging;
        dragging = null;
        if (!d || d.path === e.path || e.path.indexOf(d.path + '/') === 0) return;
        move(d, e.path + '/' + d.name);
      });
    }
  }

  async function saveAs() {
    var f = src().current();
    if (!f || f.kind !== 'text') return;
    var p = await askPath('Save As', f.path, 'Save');
    if (!p || p === f.path) return;
    var r = await L.api('/api/files/saveas', { path: p, body: f.body, encoding: f.encoding });
    if (!r.ok && r.exists) {
      if (!(await L.confirm(p + ' already exists. Replace it?', { ok: 'Replace', danger: true }))) return;
      r = await L.api('/api/files/saveas', { path: p, body: f.body, encoding: f.encoding, overwrite: true });
    }
    if (!r.ok) return L.toast(r.why, true);
    await afterChange(parentOf(r.path));
    src().openFile(r.path);
  }

  L.editor = {
    active: active, render: render, dispose: dispose, hits: hits, reveal: reveal, cursor: cursor, find: find,
    recent: recent, touched: touched, decorateRow: decorateRow, problems: problems, checkSaved: checkSaved,
    saveAs: saveAs, newFile: newFile, newFolder: newFolder, report: report, load: load,
    goToDefinition: goToDefinition, findReferences: findReferences, renameSymbol: renameSymbol,
    state: function () { return state; }, focus: function () { if (ed) ed.focus(); },
    monaco: function () { return M; }, editor: function () { return ed; }, saveOrigin: saveOrigin, modelFor: modelFor,
  };

  L.onBoot(function () {
    var box = $('srcEdit');
    var holder = document.createElement('div');
    holder.innerHTML = HTML_PLACEHOLDER;
    while (holder.firstChild) box.appendChild(holder.firstChild);
    document.addEventListener('keydown', function (e) {
      if (L.nav.tab() !== 'ide') return;
      var ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && (e.key === 'S' || e.key === 's')) { e.preventDefault(); saveAs(); }
      else if (ctrl && !e.shiftKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); find(true); }
      else if (ctrl && e.key === 'Tab') { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); }
    });
    L.nav.onShow('ide', function () { load(); });
  });
}

function js() {
  return `(${client.toString().replace('HTML_PLACEHOLDER', JSON.stringify(HTML))})();`;
}

module.exports = { HTML, CSS, js, client };
