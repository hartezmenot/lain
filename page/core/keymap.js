'use strict';

/**
 * KEYMAP AND THEME PRESETS (Phase 8) — two independent choices.
 *
 *   KEYMAP  lain · vscode · cursor · jetbrains · custom
 *           One table of LAIN commands; each preset binds them to that
 *           editor's chords. The preset is authoritative: its chords are caught
 *           before any surface (the editor included) and run the command, so a
 *           JetBrains hand gets Shift+F6 for rename and Ctrl+Shift+A for actions.
 *           Custom = LAIN's chords with the person's own overrides
 *           (appearance.customKeys; null unbinds).
 *           EDITOR commands fire only while the code editor has focus.
 *
 *   THEME   lain · vscode · cursor · jetbrains · ext:<extension>/<theme>
 *           The code editor's and terminal's colours. Backgrounds follow the
 *           palette (so a Violet window has a Violet editor); token colours
 *           follow the preset; an extension's theme is read as data by Core
 *           (/api/themes/read — its code never runs).
 *
 * Neither changes the palette, the light/dark mode or the other: a VS Code
 * keymap under a JetBrains theme in LAIN Light is a valid combination.
 */

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;

  // ---- COMMANDS -------------------------------------------------------------------------------
  function ide(fn) { return function () { if (L.nav.tab() !== 'ide') L.nav.go('ide'); setTimeout(function () { fn(); }, 0); }; }
  function edAction(id) {
    return function () {
      var ed = L.editor && L.editor.editor && L.editor.editor();
      if (!ed) return;
      var a = ed.getAction(id);
      if (a) a.run(); else ed.trigger('keymap', id, null);
    };
  }
  var COMMANDS = [
    // id, label, group, run, scope ('global' | 'ide' — only in the IDE | 'editor' — only with the code editor focused)
    ['palette', 'Command palette', 'General', function () { L.search.palette('>'); }],
    ['search', 'Search everything', 'General', function () { L.search.palette(''); }],
    ['settings', 'Open Settings', 'General', function () { L.nav.go('settings'); }],
    ['project.new', 'New project', 'General', function () { L.ide.newProject(); }],
    ['project.open', 'Open project', 'General', function () { L.ide.openProject(); }],
    ['chat.new', 'New chat', 'Chat', function () { if (L.chat) { L.nav.go('chat'); L.chat.newChat(); } }],
    ['chat.focus', 'Focus Chat', 'Chat', function () { L.nav.go('chat'); if (L.chat) L.chat.lane('chat'); }],
    ['agent.focus', 'Focus Coding Agent', 'Chat', function () { if (L.nav.tab() === 'ide') { if (L.ide.center) L.ide.center('coding'); return; } L.nav.go('chat'); if (L.chat) L.chat.lane('agent'); }],
    ['quickOpen', 'Go to file', 'IDE', ide(function () { L.ide.quickOpen(); })],
    ['files.search', 'Find in files', 'IDE', function () { L.ide.showPane('search', true); }, 'ide'],
    ['explorer', 'Explorer', 'IDE', function () { L.ide.showPane('explorer'); }, 'ide'],
    ['scm', 'Source control', 'IDE', function () { L.ide.showPane('scm', true); }, 'ide'],
    ['sidebar', 'Toggle side bar', 'IDE', function () { L.ide.toggleSide(); }, 'ide'],
    ['panel', 'Toggle bottom panel', 'IDE', function () { L.ide.togglePanel(); }, 'ide'],
    ['terminal', 'Terminal', 'IDE', function () { L.ide.showPanel('TERMINAL'); }, 'ide'],
    ['agent.toggle', 'Show / hide Agent sidecar', 'IDE', function () { L.ide.toggleBot(); }, 'ide'],
    ['editor.close', 'Close editor', 'IDE', function () { L.ide.closeEditor(); }, 'ide'],
    ['editor.gotoDef', 'Go to definition', 'Editor', edAction('lain.goToDefinition'), 'editor'],
    ['editor.refs', 'Find references', 'Editor', edAction('lain.findReferences'), 'editor'],
    ['editor.rename', 'Rename symbol', 'Editor', edAction('lain.renameSymbol'), 'editor'],
    ['editor.format', 'Format document', 'Editor', edAction('lain.formatDocument'), 'editor'],
    ['editor.comment', 'Toggle line comment', 'Editor', edAction('editor.action.commentLine'), 'editor'],
    ['editor.deleteLine', 'Delete line', 'Editor', edAction('editor.action.deleteLines'), 'editor'],
    ['editor.duplicate', 'Duplicate line', 'Editor', edAction('editor.action.copyLinesDownAction'), 'editor'],
    ['editor.gotoLine', 'Go to line', 'Editor', edAction('editor.action.gotoLine'), 'editor'],
    ['editor.ask', 'Ask Noema about the selection', 'Editor', function () { if (L.ide && L.ide.askAboutSelection) L.ide.askAboutSelection(); }, 'editor'],
  ];
  var BY_ID = {};
  COMMANDS.forEach(function (c) { BY_ID[c[0]] = c; });

  var VSCODE = {
    palette: 'Ctrl+Shift+P', search: 'Ctrl+K', settings: 'Ctrl+,', 'project.new': 'Ctrl+Shift+N', 'project.open': 'Ctrl+O', 'chat.new': 'Ctrl+Alt+N', 'agent.focus': 'Ctrl+Alt+I',
    quickOpen: 'Ctrl+P', 'files.search': 'Ctrl+Shift+F', explorer: 'Ctrl+Shift+E', scm: 'Ctrl+Shift+G', sidebar: 'Ctrl+B', panel: 'Ctrl+J', terminal: 'Ctrl+`',
    'agent.toggle': 'Ctrl+Alt+B', 'editor.close': 'Ctrl+W',
    'editor.gotoDef': 'F12', 'editor.refs': 'Shift+F12', 'editor.rename': 'F2', 'editor.format': 'Shift+Alt+F', 'editor.comment': 'Ctrl+/',
    'editor.deleteLine': 'Ctrl+Shift+K', 'editor.duplicate': 'Shift+Alt+ArrowDown', 'editor.gotoLine': 'Ctrl+G', 'editor.ask': 'Ctrl+Shift+L',
  };
  var PRESETS = {
    lain: Object.assign({}, VSCODE, { palette: 'Ctrl+Shift+P', search: 'Ctrl+K', 'agent.focus': 'Ctrl+Shift+A', 'chat.focus': 'Ctrl+Shift+C' }),
    vscode: VSCODE,
    cursor: Object.assign({}, VSCODE, { 'agent.focus': 'Ctrl+I', 'chat.focus': 'Ctrl+L', 'editor.ask': 'Ctrl+Shift+L' }),
    jetbrains: {
      palette: 'Ctrl+Shift+A', search: 'Ctrl+Shift+Alt+N', settings: 'Ctrl+Alt+S', 'project.new': 'Ctrl+Alt+Shift+Insert', 'project.open': 'Ctrl+O', 'chat.new': 'Ctrl+Alt+N', 'agent.focus': 'Ctrl+Shift+Alt+A',
      quickOpen: 'Ctrl+Shift+N', 'files.search': 'Ctrl+Shift+F', explorer: 'Alt+1', scm: 'Ctrl+K', sidebar: 'Ctrl+Shift+F12', panel: 'Alt+4', terminal: 'Alt+F12',
      'agent.toggle': 'Alt+0', 'editor.close': 'Ctrl+F4',
      'editor.gotoDef': 'Ctrl+B', 'editor.refs': 'Alt+F7', 'editor.rename': 'Shift+F6', 'editor.format': 'Ctrl+Alt+L', 'editor.comment': 'Ctrl+/',
      'editor.deleteLine': 'Ctrl+Y', 'editor.duplicate': 'Ctrl+D', 'editor.gotoLine': 'Ctrl+G', 'editor.ask': 'Ctrl+Shift+L',
    },
  };
  var LABELS = { lain: 'Noema', vscode: 'VS Code', cursor: 'Cursor', jetbrains: 'JetBrains', custom: 'Custom' };

  function ui() { return (L.appearance && L.appearance.get()) || {}; }
  /** The binding table in force: command id → chord (or null). */
  function bindings(preset) {
    var p = preset || ui().keymap || 'lain';
    var base = Object.assign({}, PRESETS[p] || PRESETS.lain);
    if (p === 'custom') {
      base = Object.assign({}, PRESETS.lain);
      var own = ui().customKeys || {};
      Object.keys(own).forEach(function (k) { if (BY_ID[k]) base[k] = own[k]; });
    }
    return base;
  }

  /** "Ctrl+Shift+P" for a keydown — the same spelling the table uses. */
  function chordOf(e) {
    var k = e.key;
    if (/^(Control|Shift|Alt|Meta)$/.test(k)) return null;
    if (k === ' ') k = 'Space';
    else if (k.length === 1) {
      // Shifted symbols: name the key, not the character it typed.
      var byCode = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };
      if (byCode[e.code]) k = byCode[e.code];
      else if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
      else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
      else k = k.toUpperCase();
    }
    var parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    parts.push(k);
    return parts.join('+');
  }
  function norm(ch) {
    if (!ch) return '';
    var p = String(ch).split('+'); var key = p.pop();
    var mods = { Ctrl: 0, Shift: 0, Alt: 0 };
    p.forEach(function (m) { m = m.charAt(0).toUpperCase() + m.slice(1).toLowerCase(); if (m === 'Meta') m = 'Ctrl'; mods[m] = 1; });
    return ['Ctrl', 'Shift', 'Alt'].filter(function (m) { return mods[m]; }).concat([key.length === 1 ? key.toUpperCase() : key]).join('+');
  }
  function editorFocused() {
    var ed = L.editor && L.editor.editor && L.editor.editor();
    return Boolean(ed && ed.hasTextFocus && ed.hasTextFocus());
  }
  function typing(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && !(t.closest && t.closest('.monaco-editor')); }

  var recording = null;
  window.addEventListener('keydown', function (e) {
    if (recording) return;
    var ch = chordOf(e);
    if (!ch) return;
    // A plain key or Shift+key while typing is text, never a command.
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !/^(Shift\+)?F\d{1,2}$/.test(ch)) return;
    if (document.querySelector('.dlg-back')) return;   // a dialog owns the keyboard
    var b = bindings(); var n = norm(ch); var inEd = editorFocused();
    var hit = null;
    Object.keys(b).forEach(function (id) {
      if (hit || !b[id] || norm(b[id]) !== n) return;
      var c = BY_ID[id]; if (!c) return;
      if (c[4] === 'editor' && !inEd) return;
      if (c[4] === 'ide' && (L.nav.tab() !== 'ide' || !(L.ide.currentRoot && L.ide.currentRoot()))) return;
      if (c[4] !== 'editor' && typing(e.target) && !e.ctrlKey && !e.altKey) return;
      hit = c;
    });
    if (!hit) return;
    e.preventDefault(); e.stopPropagation();
    try { hit[3](); } catch (err) { if (window.console) console.error('keymap', hit[0], err); }
  }, true);

  // ---- THEME PRESETS: the editor's and terminal's colours ------------------------------------------
  var TOKENS = {
    lain: {
      dark: { comment: '6b7a80', keyword: '7fd4c4', string: 'a6d69a', number: 'e0a86b', type: '8fc1ff', tag: 'd7a0e8', attr: '9ad0c8', variable: 'e5eaec', delimiter: '93a1a6', regexp: 'e89a8a', fn: 'f0d78a' },
      light: { comment: '7b8a8f', keyword: '0f7b6c', string: '3d7a2a', number: 'b3541e', type: '2a5db0', tag: '8a3fa0', attr: '0f7b6c', variable: '1b2226', delimiter: '5b666b', regexp: 'b3401e', fn: '8a5a00' },
    },
    vscode: {
      dark: { comment: '6A9955', keyword: '569CD6', string: 'CE9178', number: 'B5CEA8', type: '4EC9B0', tag: '569CD6', attr: '9CDCFE', variable: '9CDCFE', delimiter: 'D4D4D4', regexp: 'D16969', fn: 'DCDCAA' },
      light: { comment: '008000', keyword: '0000FF', string: 'A31515', number: '098658', type: '267F99', tag: '800000', attr: 'E50000', variable: '001080', delimiter: '000000', regexp: '811F3F', fn: '795E26' },
    },
    cursor: {
      dark: { comment: '6D6D6D', keyword: '82D2CE', string: 'E394DC', number: 'EBC88D', type: '87C3FF', tag: '87C3FF', attr: 'AAA0FA', variable: 'D6D6DD', delimiter: 'D6D6DD', regexp: 'F8C762', fn: 'EFB080' },
      light: { comment: '8E8E90', keyword: '0F7B6C', string: 'B33C9E', number: 'A5670E', type: '2F5DCB', tag: '2F5DCB', attr: '6F4FD6', variable: '1F1F1F', delimiter: '3B3B3B', regexp: 'A5670E', fn: 'B25E14' },
    },
    jetbrains: {
      dark: { comment: '808080', keyword: 'CC7832', string: '6A8759', number: '6897BB', type: 'A9B7C6', tag: 'E8BF6A', attr: 'BABABA', variable: 'A9B7C6', delimiter: 'A9B7C6', regexp: '646695', fn: 'FFC66D' },
      light: { comment: '8C8C8C', keyword: '0033B3', string: '067D17', number: '1750EB', type: '000000', tag: '0033B3', attr: '174AD4', variable: '000000', delimiter: '080808', regexp: '264EFF', fn: '00627A' },
    },
  };
  function cssVar(n) { return (getComputedStyle(document.documentElement).getPropertyValue(n) || '').trim(); }
  function toHex(c) {
    c = String(c || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map(function (x) { return x + x; }).join('');
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
    if (m) return '#' + [m[1], m[2], m[3]].map(function (v) { return ('0' + Number(v).toString(16)).slice(-2); }).join('');
    // color-mix() and friends: let the browser resolve it.
    var probe = document.createElement('i'); probe.style.color = c; document.body.appendChild(probe);
    var r = getComputedStyle(probe).color; probe.remove();
    m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(r);
    return m ? '#' + [m[1], m[2], m[3]].map(function (v) { return ('0' + Number(v).toString(16)).slice(-2); }).join('') : null;
  }
  function surface() {
    return { bg: toHex(cssVar('--canvas')) || '#0B1B1F', panel: toHex(cssVar('--surface-base')) || '#10262B', raise: toHex(cssVar('--surface-active')) || '#173238', line: toHex(cssVar('--separator')) || '#1E3A40',
      ink: toHex(cssVar('--text-primary')) || '#E8EEF0', dim: toHex(cssVar('--text-secondary')) || '#9FB0B4', faint: toHex(cssVar('--text-muted')) || '#6F8388', accent: toHex(cssVar('--accent-primary')) || '#1ED6D0',
      hot: toHex(cssVar('--accent-tertiary')) || '#E8506A', ok: toHex(cssVar('--positive')) || '#5AAE84', warn: toHex(cssVar('--warning')) || '#D8A650' };
  }
  var imported = { id: null, theme: null };
  function builtinTheme(preset, mode) {
    var t = (TOKENS[preset] || TOKENS.lain)[mode === 'light' ? 'light' : 'dark'];
    var s = surface();
    return {
      base: mode === 'light' ? 'vs' : 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: t.comment, fontStyle: 'italic' }, { token: 'keyword', foreground: t.keyword }, { token: 'string', foreground: t.string },
        { token: 'number', foreground: t.number }, { token: 'type', foreground: t.type }, { token: 'type.identifier', foreground: t.type }, { token: 'delimiter', foreground: t.delimiter },
        { token: 'tag', foreground: t.tag }, { token: 'attribute.name', foreground: t.attr }, { token: 'variable', foreground: t.variable }, { token: 'regexp', foreground: t.regexp },
        { token: 'identifier', foreground: t.variable },
      ],
      colors: {
        'editor.background': s.bg, 'editor.foreground': s.ink, 'editorGutter.background': s.bg, 'minimap.background': s.bg,
        'editorLineNumber.foreground': s.faint, 'editorLineNumber.activeForeground': s.dim,
        'editor.lineHighlightBackground': s.panel, 'editor.lineHighlightBorder': s.panel,
        'editor.selectionBackground': s.accent + '40', 'editor.inactiveSelectionBackground': s.accent + '22',
        'editorCursor.foreground': s.accent, 'editorIndentGuide.background1': s.line,
        'editorWidget.background': s.panel, 'editorWidget.border': s.line, 'editorSuggestWidget.background': s.panel, 'editorSuggestWidget.selectedBackground': s.raise,
        'input.background': s.raise, focusBorder: s.accent + '66', 'scrollbarSlider.background': s.line + 'aa',
        'editorError.foreground': s.hot, 'editorWarning.foreground': s.warn,
      },
    };
  }
  function editorTheme() {
    var u = ui(); var mode = L.appearance ? L.appearance.mode() : 'dark';
    if (/^ext:/.test(u.theme || '') && imported.id === u.theme && imported.theme) {
      var t = imported.theme;
      return { base: t.base, inherit: true, rules: t.rules, colors: t.colors };
    }
    return builtinTheme(/^ext:/.test(u.theme || '') ? 'lain' : (u.theme || 'lain'), mode);
  }
  function terminalTheme() {
    var s = surface(); var light = L.appearance && L.appearance.mode() === 'light';
    var ansi = light
      ? { black: '#1b2226', red: '#c0392b', green: '#2e7d4f', yellow: '#9a6b00', blue: '#2a5db0', magenta: '#8a3fa0', cyan: '#0f7b6c', white: '#5b666b', brightBlack: '#7b8a8f', brightRed: '#e0503f', brightGreen: '#3c9a64', brightYellow: '#b58300', brightBlue: '#3b73d1', brightMagenta: '#a653c2', brightCyan: '#149c89', brightWhite: '#1b2226' }
      : { black: '#15171c', red: '#d9675f', green: '#5aae84', yellow: '#d8a650', blue: '#7c8cf8', magenta: '#c58af0', cyan: '#5fc3c9', white: '#c9ccd4', brightBlack: '#5b6070', brightRed: '#f08a82', brightGreen: '#7fd0a4', brightYellow: '#f0c77a', brightBlue: '#a3adff', brightMagenta: '#d9a9f5', brightCyan: '#8adbe0', brightWhite: '#ffffff' };
    return Object.assign({ background: s.bg, foreground: s.ink, cursor: s.accent, cursorAccent: s.bg, selectionBackground: s.accent + '55' }, ansi);
  }

  var termSubs = [];
  function applyEditor() {
    var M = L.editor && L.editor.monaco && L.editor.monaco();
    if (!M) return;
    try { M.editor.defineTheme('lain-ws', editorTheme()); M.editor.setTheme('lain-ws'); } catch (e) { if (window.console) console.error('editor theme', e); }
  }
  var applying = 0;
  async function applyAll() {
    var u = ui(); var n = ++applying;
    if (/^ext:/.test(u.theme || '') && imported.id !== u.theme) {
      var r = await L.api('/api/themes/read', { id: u.theme });
      if (n !== applying) return;
      imported = { id: u.theme, theme: r && r.ok ? r.theme : null };
      if (!(r && r.ok) && L.toast) L.toast((r && r.why) || 'that theme could not be read — using Noema’s', true);
    }
    // After the palette's CSS has landed (the tokens are read back from it).
    requestAnimationFrame(function () {
      applyEditor();
      var tt = terminalTheme();
      termSubs.forEach(function (fn) { try { fn(tt); } catch (e) { /* a closed terminal */ } });
    });
  }

  L.keymap = {
    COMMANDS: COMMANDS.map(function (c) { return { id: c[0], label: c[1], group: c[2], scope: c[4] || 'global' }; }),
    PRESETS: PRESETS, LABELS: LABELS, bindings: bindings, chordOf: chordOf, norm: norm,
    run: function (id) { var c = BY_ID[id]; if (c) c[3](); },
    record: function (on) { recording = Boolean(on); },
    /** Two commands on one chord in the table in force. */
    conflicts: function (preset) { var b = bindings(preset); var seen = {}; var out = []; Object.keys(b).forEach(function (id) { var k = norm(b[id]); if (!k) return; if (seen[k]) out.push([seen[k], id, b[id]]); else seen[k] = id; }); return out; },
    editorTheme: editorTheme, terminalTheme: terminalTheme, applyEditor: applyEditor,
    onTerminalTheme: function (fn) { termSubs.push(fn); },
  };
  L.onBoot(function () { if (L.appearance) L.appearance.onChange(function () { applyAll(); }); });
}

function js() { return `(${client.toString()})();`; }

module.exports = { js, client };
