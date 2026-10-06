'use strict';

/**
 * THE EDITOR PROFILE, APPLIED — Core's editor.json (editorprofile.js) into
 * the live Monaco editor.
 *
 *   settings      editor.updateOptions — only options Core validated
 *   keybindings   monaco.editor.addKeybindingRules, one chord each
 *   snippets      a completion provider per language ('*' = every language),
 *                 from an import and from enabled extensions
 *
 * Reloaded after an import, an extension change or "Clear imported"; the old
 * rules and providers are disposed first, so nothing is registered twice.
 */

function client() {
  var L = window.LAIN;
  var M = null, ed = null;
  var disposables = [];
  var last = null;

  var KEYS = {
    enter: 'Enter', escape: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete', insert: 'Insert',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', up: 'UpArrow', down: 'DownArrow', left: 'LeftArrow', right: 'RightArrow',
    '`': 'Backquote', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote',
    ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash',
  };

  /** "ctrl+shift+k" or a two-part "ctrl+k ctrl+c" → a Monaco keybinding number, or null. */
  function chord(text) {
    var seq = String(text || '').toLowerCase().trim().split(/ +/);
    if (seq.length === 2) {
      var first = one(seq[0]), second = one(seq[1]);
      return first == null || second == null ? null : M.KeyMod.chord(first, second);
    }
    return seq.length === 1 ? one(seq[0]) : null;
  }
  function one(text) {
    var parts = String(text || '').toLowerCase().split('+');
    var key = parts.pop();
    var mods = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === 'ctrl') mods |= M.KeyMod.CtrlCmd;
      else if (p === 'shift') mods |= M.KeyMod.Shift;
      else if (p === 'alt') mods |= M.KeyMod.Alt;
      else if (p === 'meta' || p === 'win' || p === 'cmd') mods |= M.KeyMod.WinCtrl;
      else return null;
    }
    var name = KEYS[key] || (/^[a-z]$/.test(key) ? 'Key' + key.toUpperCase() : /^[0-9]$/.test(key) ? 'Digit' + key : /^f([1-9]|1[0-9])$/.test(key) ? key.toUpperCase() : null);
    var code = name != null ? M.KeyCode[name] : undefined;
    return code == null ? null : (mods | code);
  }

  /** "minimap.enabled": false → { minimap: { enabled: false } } */
  function options(flat) {
    var out = {};
    Object.keys(flat || {}).forEach(function (k) {
      var path = k.split('.');
      var o = out;
      for (var i = 0; i < path.length - 1; i++) { o[path[i]] = o[path[i]] || {}; o = o[path[i]]; }
      o[path[path.length - 1]] = flat[k];
    });
    return out;
  }

  function snippetProvider(lang, list) {
    return M.languages.registerCompletionItemProvider(lang, {
      provideCompletionItems: function (model, pos) {
        var w = model.getWordUntilPosition(pos);
        var range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
        var out = [];
        list.forEach(function (s) {
          (s.prefix || []).forEach(function (p) {
            out.push({
              label: p, kind: M.languages.CompletionItemKind.Snippet, insertText: s.body,
              insertTextRules: M.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: s.from ? 'snippet · ' + s.from : 'snippet · ' + (s.name || ''), documentation: s.description || s.name || '', range: range,
            });
          });
        });
        return { suggestions: out };
      },
    });
  }

  function apply(data) {
    disposables.forEach(function (d) { try { d.dispose(); } catch (e) { /* already gone */ } });
    disposables = [];
    var p = (data && data.profile) || {};
    last = data;
    if (p.settings && Object.keys(p.settings).length) ed.updateOptions(options(p.settings));
    var rules = [];
    (p.keybindings || []).forEach(function (k) {
      var kb = chord(k.key);
      if (kb != null) rules.push({ keybinding: kb, command: k.command });
    });
    if (rules.length && M.editor.addKeybindingRules) {
      var r = M.editor.addKeybindingRules(rules);
      if (r && r.dispose) disposables.push(r);
    }
    var byLang = {};
    var merge = function (src) { Object.keys(src || {}).forEach(function (l) { byLang[l] = (byLang[l] || []).concat(src[l]); }); };
    merge(p.snippets);
    merge(data && data.extensionSnippets);
    var every = byLang['*'] || [];
    delete byLang['*'];
    if (every.length) M.languages.getLanguages().forEach(function (l) { disposables.push(snippetProvider(l.id, every)); });
    Object.keys(byLang).forEach(function (l) { disposables.push(snippetProvider(l, byLang[l])); });
  }

  async function reload() {
    if (!M || !ed) return null;
    var r = await L.api('/api/editor/profile', {});
    if (r && r.ok) apply(r);
    return r;
  }

  L.profile = {
    attach: function (monaco, editor) { M = monaco; ed = editor; reload(); },
    reload: reload,
    current: function () { return last; },
    chord: function (t) { return M ? chord(t) : null; },
  };
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { js, client };
