'use strict';

/**
 * THE SOURCE WORKSPACE — the tree, the tabs, the editor.
 *
 * ------------------------------------------------------------------------
 * NO BACKTICKS ANYWHERE BELOW, COMMENTS INCLUDED. Everything this file emits
 * lives inside one template literal, and a stray backtick ends it — producing
 * a page that composes perfectly and does not parse. That has now cost two
 * passes; there is a test (`the page is one self-contained document with valid
 * script`) that runs `new Function` over the result and catches it.
 *
 * ------------------------------------------------------------------------
 * THE HIGHLIGHTER IS DELIBERATELY SMALL.
 *
 * A real grammar-based highlighter is a dependency and a build step, and this
 * project has neither. What is here is a tokeniser that handles the four things
 * that actually make code readable at a glance — comments, strings, numbers,
 * keywords — and stops. It is honest about what it is: it will mis-colour a
 * regex containing a quote, and it will not pretend to parse TypeScript
 * generics.
 *
 * It is applied ONE LINE AT A TIME, over escaped text, and it never inserts
 * anything but its own spans. That is what keeps it safe: the file body is
 * escaped before the highlighter ever sees it, so nothing in a source file can
 * become markup.
 *
 * ------------------------------------------------------------------------
 * THE EDITOR IS A TEXTAREA UNDER A HIGHLIGHTED LAYER.
 *
 * The textarea is transparent and holds the real text, selection and caret; a
 * `<pre>` behind it, scrolled in lockstep, carries the colour. This is the
 * oldest trick for this and it is the right one here: the browser keeps
 * ownership of editing, IME, undo, spellcheck-off, accessibility and mobile
 * keyboards, and none of that has to be reimplemented. A contenteditable would
 * hand all of it back to us.
 */

/** The Source Workspace's own styles. */
const CSS = `
.srcTree{overflow:auto;padding:2px 0 8px;font-size:var(--fs-ide);height:100%}
.srcRow{display:flex;align-items:center;gap:6px;padding:2px 10px;margin:0 6px;border-radius:6px;cursor:pointer;white-space:nowrap;color:var(--text-secondary);line-height:21px}
.srcRow:hover{background:var(--hover);color:var(--text-primary)}
.srcRow.on{background:var(--selection);color:var(--text-primary)}
.srcRow.dir{color:var(--text-primary)}
.srcRow .tw{width:10px;color:var(--text-muted);flex:none;font-size:10px}
.srcRow .nm{overflow:hidden;text-overflow:ellipsis}
.srcRow .ch{width:6px;height:6px;border-radius:50%;background:var(--warning);flex:none;margin-left:auto}
.srcPane{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--surface-base);container-type:inline-size}
.srcPane > .srcEdit{flex:1}
/* THE TAB STRIP carries the editor's actions at its end (split, Preview, Coding Chat). */
.srcTabsRow{display:flex;align-items:stretch;background:var(--surface-base);border-bottom:1px solid var(--separator);min-height:40px;flex:none}
.srcTabsRow .srcTabs{flex:1;min-width:0;border-bottom:0}
.srcActs{display:flex;align-items:center;gap:2px;padding:0 8px;flex:none}
.sact{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-radius:6px;color:var(--text-muted);font-size:var(--fs-ide);white-space:nowrap}
.sact:hover{background:var(--surface-active);color:var(--text-primary)}
.sact[aria-pressed=true]{color:var(--text-primary);background:var(--surface-active)}
.sact.labelled{color:var(--text-secondary);box-shadow:inset 0 0 0 1px var(--separator)}
.sact.dim{opacity:.55}
/* A NARROW EDITOR keeps its actions as icons (their names stay in the tooltips). */
@container (max-width: 620px){.srcActs .sact > span{display:none}.srcActs{padding:0 4px}}
.srcTab.preview .nm{font-style:italic}
/* BREADCRUMBS — the file's place in the project, and the symbol the caret is in. Subtle. */
.srcCrumbs{display:flex;align-items:center;gap:5px;height:28px;padding:0 16px;border-bottom:1px solid var(--separator);font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;flex:none}
.srcCrumbs .cr.last{color:var(--text-secondary)}
.srcCrumbs .sep{opacity:.55}
.srcCrumbs .sym{color:var(--text-secondary)}
.srcPane .srcBar{display:none}
/* GIT, SUBTLY: a letter for a changed file, a tint for a folder holding changes. */
.srcRow .gs{margin-left:auto;font-size:10.5px;font-weight:700;width:14px;text-align:center;flex:none;opacity:.85}
.srcRow .gs.M,.srcRow .gs.R{color:var(--warning)} .srcRow .gs.U,.srcRow .gs.A{color:var(--positive)} .srcRow .gs.D,.srcRow .gs.X{color:var(--danger)}
.srcRow.gdir .nm{color:color-mix(in srgb,var(--warning) 70%,var(--text-primary))}
.tabmenu{min-width:220px;padding:6px}
.tabmenu button{display:flex;width:100%;padding:6px 10px;border-radius:6px;font-size:13px;color:var(--text-primary);text-align:left}
.tabmenu button:hover{background:var(--selection)}
.tabmenu .sep{height:1px;background:var(--separator);margin:4px 6px}
/* EDITOR TABS ARE BOXES WITH A CLOSE CONTROL — deliberately unlike the
   global tabs above them, which are underlined words. */
.srcTabs{display:flex;gap:2px;overflow-x:auto;background:transparent;border-bottom:1px solid var(--separator);min-height:40px;padding:0 4px;scrollbar-width:none}
.srcTabs::-webkit-scrollbar{display:none}

.srcTab{position:relative;display:flex;align-items:center;gap:8px;padding:0 8px 0 12px;height:40px;color:var(--text-muted);font-size:var(--fs-ide);white-space:nowrap;cursor:pointer;background:transparent;transition:color var(--t-hover) var(--ease),background var(--t-hover) var(--ease)}
.srcTab:hover{color:var(--text-secondary)}
.srcTab[aria-selected=true]{background:var(--surface-raised);color:var(--text-primary)}
.srcTab[aria-selected=true]::after{content:'';position:absolute;left:8px;right:8px;bottom:0;height:2px;border-radius:2px;background:var(--accent-primary)}
.srcTab .lg{font:700 9.5px/1 var(--mono);letter-spacing:.02em;color:var(--info)}
.srcTab .lg.js,.srcTab .lg.json{color:var(--warning)} .srcTab .lg.md{color:var(--accent-secondary)} .srcTab .lg.rs,.srcTab .lg.html{color:#E8875B} .srcTab .lg.css{color:var(--accent-primary)} .srcTab .lg.py{color:#6FA8DC}
.srcTab .dot{width:8px;height:8px;border-radius:50%;background:var(--accent-primary)}
.srcTab .x{color:var(--text-muted);font-size:14px;line-height:1;width:18px;height:18px;border-radius:4px;display:grid;place-items:center;opacity:0;transition:opacity var(--t-hover) var(--ease)}
.srcTab:hover .x,.srcTab[aria-selected=true] .x{opacity:1}
.srcTab .x:hover{color:var(--text-primary);background:var(--surface-active)}
.srcBar{display:flex;align-items:center;gap:10px;padding:0 12px;height:26px;border-bottom:1px solid var(--separator);font-size:11.5px;color:var(--text-muted)}
.srcBar .sp{flex:1}
.srcBar button{padding:1px 8px;border-radius:var(--radius-xs);color:var(--text-secondary);font-size:11.5px}
.srcBar button:hover{color:var(--text-primary);background:var(--surface-active)}
.srcBar button.act{color:var(--accent-primary)}
.srcEdit{position:relative;overflow:auto;background:var(--surface-base);min-height:0}
.srcEdit .wrap{position:relative;min-height:100%;display:flex}
.srcGut{flex:none;padding:10px 10px 10px 14px;text-align:right;color:var(--text-muted);min-width:52px;
        font:13px/1.6 var(--mono);user-select:none;background:var(--surface-base);position:sticky;left:0;z-index:2}
.srcGut div.hit{color:var(--accent-primary)}
.srcCode{position:relative;flex:1;min-width:0}
.srcCode pre,.srcCode textarea{margin:0;padding:10px 14px;font:var(--editor-size,13px)/1.6 var(--mono);
        white-space:pre;tab-size:2;border:0;overflow:visible}
.srcGut{font-size:var(--editor-size,13px)}
.srcCode pre{pointer-events:none;color:var(--text-primary)}
.srcCode textarea{position:absolute;inset:0;color:transparent;background:transparent;caret-color:var(--accent-primary);
        resize:none;width:100%;height:100%;outline:0}
.srcCode textarea::selection{background:#3b4270;color:transparent}
.srcCode .ln{display:block}
.srcCode .ln.hit{background:#1c2033}
.tk-c{color:#6b7080;font-style:italic}
.tk-s{color:#a6d69a}
.tk-n{color:#e0a86b}
.tk-k{color:#9aa6ff}
.tk-t{color:#d7a0e8}
.srcEmpty{position:absolute;inset:0;display:grid;place-items:center;color:var(--text-muted);font-size:13px;line-height:1.9;text-align:center}
.srcEmpty .kb{display:grid;grid-template-columns:auto auto;gap:4px 18px;text-align:left;margin-top:10px}
.srcEmpty .kb span:nth-child(odd){text-align:right;color:var(--text-secondary)}
.srcNote{padding:8px 14px;font-size:12px;color:var(--warning);border-bottom:1px solid var(--separator);background:var(--surface-base)}
.srcNote.bad{color:var(--danger)}
.srcNote button{margin-left:10px;color:var(--accent-primary);text-decoration:underline}
.quick{position:fixed;inset:0;background:#0008;z-index:60;display:flex;align-items:flex-start;justify-content:center;padding-top:11vh}
.quick .box{width:min(600px,90vw);background:var(--surface-base);border:1px solid var(--border-subtle);border-radius:10px;overflow:hidden;box-shadow:var(--shadow-float);padding:0}
.quick input{padding:12px 16px;font-size:14px;border-bottom:1px solid var(--separator)}
.quick .hits{max-height:50vh;overflow:auto;padding:6px}
.quick .hit{padding:6px 10px;font-size:12.5px;color:var(--text-secondary);cursor:pointer;font-family:var(--mono);border-radius:var(--radius-xs)}
.quick .hit:hover,.quick .hit[aria-selected=true]{background:var(--selection);color:var(--text-primary)}
`;

/** The markup, in two parts: the tree goes in the IDE's explorer, the pane in its editor area. */
const TREE_HTML = `<div class="srcTree" id="srcTree"></div>`;
const PANE_HTML = `
<section class="srcPane" id="srcPanel">
  <div class="srcTabsRow"><div class="srcTabs" id="srcTabs" role="tablist" aria-label="Open editors"></div><div class="srcActs" id="srcActs"></div></div>
  <div class="srcCrumbs" id="srcCrumbs" hidden></div>
  <div class="srcBar">
    <span id="srcPath">no file open</span>
    <span class="sp"></span>
    <span id="srcLang"></span>
    <button id="srcFindBtn" title="Find in file (Ctrl+F)">Find</button>
    <button id="srcSave" class="act" title="Save (Ctrl+S)">Save</button>
  </div>
  <div class="srcEdit" id="srcEdit">
    <div class="srcNote" id="srcNote" hidden></div>
    <div class="wrap">
      <div class="srcGut" id="srcGut"></div>
      <div class="srcCode" id="srcCode">
        <pre id="srcHi"></pre>
        <textarea id="srcText" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"></textarea>
      </div>
    </div>
    <div class="srcEmpty" id="srcEmpty">
      <div>No file is open.<div class="kb"><span>Open file</span><span>Ctrl+P</span><span>Search Noema</span><span>Ctrl+K</span><span>Toggle panel</span><span>Ctrl+J</span><span>Terminal</span><span>Ctrl+&#96;</span></div></div>
    </div>
  </div>
</section>
<div class="quick" id="quick" hidden>
  <div class="box">
    <input id="quickQ" placeholder="Open file by name" autocomplete="off">
    <div class="hits" id="quickHits"></div>
  </div>
</div>
`;
const HTML = PANE_HTML;

/**
 * THE BEHAVIOUR.
 *
 * `api`, `notice` and `poll` are handed in by pagescript.js so there is exactly
 * one HTTP client, one notice surface and one poll loop in the page.
 */
function js() {
  return `
window.LAIN = window.LAIN || {};
window.LAIN.source = (function () {
  'use strict';
  var api = null, notice = null, poll = null;
  var $ = function (id) { return document.getElementById(id); };

  var st = {
    open: [],          // [{path, body, saved, mtimeMs, language, dirty}]
    active: -1,
    expanded: {},      // path -> true
    tree: {},          // path -> entries
    hits: [],          // find/patch results, as line numbers
    patch: null,       // the last edit Noema made to an open file
    patchTimer: 0,
    quickSel: 0,
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
  }

  // ---- the small highlighter -------------------------------------------
  //
  // ONE LINE AT A TIME, over ALREADY-ESCAPED text. Order matters: comments and
  // strings are consumed first so a keyword inside either is not re-coloured.
  var KEYWORDS = {
    js: 'const let var function return if else for while class new await async import export from default try catch finally throw typeof instanceof this null true false undefined extends super yield delete in of do switch case break continue',
    ts: 'const let var function return if else for while class new await async import export from default try catch finally throw typeof instanceof this null true false undefined interface type enum implements public private protected readonly extends super as satisfies',
    css: 'important media supports keyframes import charset font-face root',
    html: 'html head body div span script style link meta title class id',
    json: 'true false null',
    md: '',
    py: 'def class return if elif else for while import from as try except finally raise with lambda None True False and or not in is pass break continue global nonlocal yield async await',
    rs: 'fn let mut const struct enum impl trait pub use mod match if else for while loop return self Self where async await move ref dyn crate super as in break continue',
    yaml: 'true false null yes no on off',
    sh: 'if then else elif fi for while do done case esac function return export local readonly source echo cd',
    text: '',
  };

  function kwRe(lang) {
    var words = (KEYWORDS[lang] || '').trim();
    if (!words) return null;
    // SPLIT ON A SPACE, not on a whitespace class: the KEYWORDS table above is
    // written with single spaces, so a class buys nothing and costs a
    // doubly-escaped regex LITERAL inside this emitted script — which reads, in
    // the source file, exactly like the lost-backslash corruption the
    // architecture guard exists to catch. Being unambiguous here is cheaper
    // than teaching that guard to tell the two apart.
    return new RegExp('\\\\b(' + words.split(' ').join('|') + ')\\\\b', 'g');
  }

  // BUILT FROM A STRING for the same reason: as a literal this needs four
  // backslashes to emit two, and that is indistinguishable in the source from
  // a regex that lost its escape.
  var NUMBER_RE = new RegExp('\\\\b(\\\\d+(?:\\\\.\\\\d+)?(?:px|em|rem|%|s|ms)?)\\\\b', 'g');

  /**
   * ONE PASS OVER THE RAW LINE, EMITTING ESCAPED TEXT AND SPANS.
   *
   * ---- WHY NOT CHAINED replace() CALLS, WHICH IS WHAT THIS WAS ----------
   *
   * The first version escaped the line and then ran five replacements over the
   * result. Each pass could see the markup the previous ones had emitted, and
   * the keyword pass duly matched the word "class" inside the span markup
   * an earlier pass had emitted, and wrapped it:
   *
   *     <span <span class="tk-k">class</span>="tk-n">1</span>
   *
   * Broken markup, from a highlighter, over the person's source code. No
   * amount of lookahead fixes it — the input to each pass is contaminated.
   *
   * A SINGLE PASS CANNOT HAVE THE BUG. The scanner walks the ORIGINAL text,
   * decides what each run is, and escapes it on the way out. Emitted markup is
   * never re-scanned because the scanner never looks at its own output.
   */
  function esc1(ch) {
    return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
  }

  function span(cls, text) { return '<span class="tk-' + cls + '">' + esc(text) + '</span>'; }

  function highlight(line, lang) {
    var src = String(line == null ? '' : line);
    var kw = KEYWORDS[lang] ? (' ' + KEYWORDS[lang] + ' ') : '';
    var lineComment = (lang === 'js' || lang === 'ts' || lang === 'rs' || lang === 'css') ? '//'
      : (lang === 'py' || lang === 'yaml' || lang === 'sh') ? '#' : null;
    var out = '';
    var i = 0;

    while (i < src.length) {
      var ch = src[i];

      // A COMMENT RUNS TO THE END OF THE LINE. Nothing after it is code, so
      // this is checked first and consumes the remainder.
      if (lineComment && src.substr(i, lineComment.length) === lineComment) {
        out += span('c', src.slice(i));
        break;
      }
      if ((lang === 'js' || lang === 'ts' || lang === 'css' || lang === 'rs') && src.substr(i, 2) === '/*') {
        var close = src.indexOf('*/', i + 2);
        var stop = close < 0 ? src.length : close + 2;
        out += span('c', src.slice(i, stop));
        i = stop;
        continue;
      }

      // A STRING. Consumed whole, escapes included, so a quote inside it
      // cannot end it early.
      if (ch === '"' || ch === "'" || ch === '\`') {
        var j = i + 1;
        while (j < src.length && src[j] !== ch) { j += (src[j] === '\\\\' ? 2 : 1); }
        out += span('s', src.slice(i, Math.min(j + 1, src.length)));
        i = Math.min(j + 1, src.length);
        continue;
      }

      // ---- CHARACTER TESTS, NOT REGEX LITERALS -------------------------
      //
      // Every backslash below would need doubling to survive the template
      // literal this file emits, and a doubled one reads in the source exactly
      // like the lost-backslash corruption the architecture guard hunts for.
      // Two escaping problems at once, in code whose whole job is scanning
      // characters — so it scans characters.
      var isAlpha = function (c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); };
      var isDigit = function (c) { return c >= '0' && c <= '9'; };
      var isWord = function (c) { return isAlpha(c) || isDigit(c) || c === '_' || c === '$' || c === '-'; };

      // A TAG NAME in markup.
      if (lang === 'html' && ch === '<') {
        var t = i + 1;
        if (src[t] === '/') t += 1;
        if (isAlpha(src[t])) {
          var tagStart = t;
          while (t < src.length && isWord(src[t])) t += 1;
          if (t > tagStart) { out += span('t', src.slice(i, t)); i = t; continue; }
        }
      }

      // A NUMBER, with an optional CSS unit.
      if (isDigit(ch)) {
        var n = i;
        while (n < src.length && (isDigit(src[n]) || src[n] === '.')) n += 1;
        var unit = ['px', 'rem', 'em', 'ms', '%', 's'];
        for (var u = 0; u < unit.length; u++) {
          if (src.substr(n, unit[u].length) === unit[u]) { n += unit[u].length; break; }
        }
        out += span('n', src.slice(i, n));
        i = n;
        continue;
      }

      // A WORD. Coloured only when the language's keyword table has it, and
      // matched on whole words by padding both sides with spaces.
      if (isAlpha(ch) || ch === '_' || ch === '$') {
        var e = i;
        while (e < src.length && isWord(src[e])) e += 1;
        var word = src.slice(i, e);
        out += (kw && kw.indexOf(' ' + word + ' ') >= 0) ? span('k', word) : esc(word);
        i = e;
        continue;
      }

      out += esc1(ch);
      i += 1;
    }
    return out;
  }

  // ---- rendering --------------------------------------------------------
  function current() { return st.active >= 0 ? st.open[st.active] : null; }

  // THE EDITOR SURFACE. LAIN.editor (pageeditor.js) takes a file when it can —
  // Monaco for text, a preview for an image — and this built-in editor is the
  // fallback when Monaco is not installed.
  function editorOwns() { return Boolean(window.LAIN && LAIN.editor && LAIN.editor.active()); }
  function renderEditor() {
    crumbs();
    var f = current();
    var E = window.LAIN && LAIN.editor;
    if (E && E.render(f)) {
      $('srcEmpty').hidden = Boolean(f);
      $('srcGut').hidden = true;
      $('srcCode').hidden = true;
      $('srcPath').textContent = f ? f.path : 'no file open';
      $('srcLang').textContent = f ? (f.mode || f.language || '') : '';
      return;
    }
    $('srcEmpty').hidden = Boolean(f);
    $('srcGut').hidden = !f;
    $('srcCode').hidden = !f;
    if (!f) { $('srcPath').textContent = 'no file open'; $('srcLang').textContent = ''; return; }
    $('srcPath').textContent = f.path;
    $('srcLang').textContent = f.language;
    if ($('srcText').value !== f.body) $('srcText').value = f.body;
    paint();
  }

  function paint() {
    var f = current();
    if (!f) return;
    if (editorOwns()) { LAIN.editor.hits(f, st.hits); return; }
    if (f.kind === 'image') return;
    var lines = f.body.split('\\n');
    var hit = {};
    st.hits.forEach(function (n) { hit[n] = true; });
    $('srcHi').innerHTML = lines.map(function (l, i) {
      return '<span class="ln' + (hit[i] ? ' hit' : '') + '">' + (highlight(l, f.language) || ' ') + '</span>';
    // JOINED WITH NOTHING: each line is already a block, so a newline between
    // them drew every line twice as tall as the textarea's and the gutter's.
    }).join('');
    $('srcGut').innerHTML = lines.map(function (l, i) {
      return '<div' + (hit[i] ? ' class="hit"' : '') + '>' + (i + 1) + '</div>';
    }).join('');
  }

  /** A SMALL LANGUAGE MARK for a tab, from the file's extension (TS, JS, {}, M↓…); none for the rest. */
  function langBadge(p) {
    var ext = (String(p).split('.').pop() || '').toLowerCase();
    var M = { ts: ['TS', 'ts'], tsx: ['TS', 'ts'], mts: ['TS', 'ts'], js: ['JS', 'js'], jsx: ['JS', 'js'], mjs: ['JS', 'js'], cjs: ['JS', 'js'], json: ['{}', 'json'], md: ['M↓', 'md'], rs: ['RS', 'rs'], py: ['PY', 'py'], css: ['#', 'css'], scss: ['#', 'css'], html: ['<>', 'html'], cs: ['C#', 'ts'], go: ['GO', 'md'] };
    return M[ext] || null;
  }
  function renderTabs() {
    if (window.LAIN && LAIN.groups && LAIN.groups.count() > 1) LAIN.groups.refresh();
    var bar = $('srcTabs');
    bar.textContent = '';
    st.open.forEach(function (f, i) {
      // AN EDITED PREVIEW TAB IS KEPT (VS Code's rule): it stops being replaceable.
      if (f.dirty && f.preview) f.preview = false;
      var t = document.createElement('div');
      t.className = 'srcTab' + (f.preview ? ' preview' : '');
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(i === st.active));
      var lg = langBadge(f.path);
      if (lg) { var b = document.createElement('span'); b.className = 'lg ' + lg[1]; b.textContent = lg[0]; t.appendChild(b); }
      var n = document.createElement('span');
      n.className = 'nm';
      n.textContent = f.path.split('/').pop();
      n.title = f.path;
      t.onclick = function () { st.active = i; st.hits = []; renderTabs(); renderEditor(); renderTree(); };
      t.ondblclick = function () { f.preview = false; renderTabs(); };
      t.onmousedown = function (e) { if (e.button === 1) { e.preventDefault(); close(i); } };
      t.oncontextmenu = function (e) { e.preventDefault(); e.stopPropagation(); tabMenu(i, t); };
      t.title = f.path + (f.preview ? '  (preview \u2014 double-click to keep open)' : '');
      t.appendChild(n);
      if (f.dirty) { var d = document.createElement('span'); d.className = 'dot'; d.title = 'Unsaved'; t.appendChild(d); }
      var x = document.createElement('span');
      x.className = 'x';
      x.textContent = '\\u00d7';
      x.onclick = function (e) { e.stopPropagation(); close(i); };
      t.appendChild(x);
      bar.appendChild(t);
    });
  }

  /** THE TAB'S MENU: close this, the others, to the right, all, the saved ones; copy its path; split. */
  function tabMenu(i, anchor) {
    var f = st.open[i];
    if (!f || !(window.LAIN && LAIN.popover)) return;
    LAIN.popover(anchor, function (p) {
      var item = function (label, run) { var b = document.createElement('button'); b.textContent = label; b.onclick = function () { LAIN.closePop(); run(); }; p.appendChild(b); };
      var sep = function () { var s = document.createElement('div'); s.className = 'sep'; p.appendChild(s); };
      item('Close', function () { close(i); });
      item('Close Others', function () { closeMany(function (x) { return x !== f; }); });
      item('Close to the Right', function () { var at = st.open.indexOf(f); closeMany(function (x) { return st.open.indexOf(x) > at; }); });
      item('Close Saved', function () { closeMany(function (x) { return !x.dirty; }); });
      item('Close All', function () { closeMany(function () { return true; }); });
      sep();
      item(f.preview ? 'Keep Open' : 'Keep Open (pinned)', function () { f.preview = false; renderTabs(); });
      item('Copy Path', function () { copyText(f.path); });
      item('Reveal in Explorer', function () { reveal(f.path); });
      if (LAIN.groups && LAIN.groups.splitRight) item('Split Right', function () { st.active = st.open.indexOf(f); renderTabs(); renderEditor(); LAIN.groups.splitRight(); });
    }, { cls: 'tabmenu' });
  }
  function copyText(t) {
    try { navigator.clipboard.writeText(t); if (LAIN.toast) LAIN.toast('Copied ' + t); }
    catch (e) { if (LAIN.api) LAIN.api('/api/clipboard/write', { text: t }).then(function () { if (LAIN.toast) LAIN.toast('Copied ' + t); }); }
  }
  /** Close every tab that pick() names; unsaved ones only after one question. */
  function closeMany(pick) {
    var victims = st.open.filter(pick);
    var dirty = victims.filter(function (x) { return x.dirty; });
    var go = function (withDirty) {
      victims.forEach(function (x) {
        if (x.dirty && !withDirty) return;
        var at = st.open.indexOf(x);
        if (at < 0) return;
        if (window.LAIN && LAIN.editor) LAIN.editor.dispose(x.path);
        st.open.splice(at, 1);
      });
      if (st.active >= st.open.length) st.active = st.open.length - 1;
      renderTabs(); renderEditor(); renderTree();
    };
    if (!dirty.length) { go(false); return; }
    LAIN.confirm(dirty.length + ' of these ' + (dirty.length === 1 ? 'has' : 'have') + ' unsaved changes (' + dirty.map(function (x) { return x.path; }).join(', ') + '). Close without saving?', { ok: 'Close without saving', cancel: 'Keep unsaved open', danger: true }).then(function (yes) { go(Boolean(yes)); });
  }
  /** Expand the tree down to a file and mark it. */
  async function reveal(p) {
    var parts = String(p).split('/');
    var acc = '';
    for (var k = 0; k < parts.length - 1; k++) {
      acc = acc ? acc + '/' + parts[k] : parts[k];
      if (!st.expanded[acc]) {
        var r = await api('/api/files/tree', { path: acc });
        if (!r.ok) break;
        st.tree[acc] = r.entries; st.expanded[acc] = true;
      }
    }
    renderTree();
    if (window.LAIN && LAIN.ide && LAIN.ide.showPane) LAIN.ide.showPane('explorer', true);
  }
  function collapseAll() { st.expanded = {}; renderTree(); }

  // ---- BREADCRUMBS ------------------------------------------------------------------
  //
  // The path, then the declaration the caret sits in (class \u203a method). The
  // symbol comes from a small indentation walk over the buffer — character
  // tests, no regex (see the note at the top of this file) — and is subtle on
  // purpose: a hint of where you are, not an outline.
  function isW(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$'; }
  function identAt(s) { var n = ''; for (var k = 0; k < s.length && isW(s[k]); k++) n += s[k]; return n; }
  var MODS = ['export ', 'default ', 'async ', 'static ', 'public ', 'private ', 'protected ', 'abstract ', 'pub ', 'override '];
  function declName(t) {
    var w = t;
    for (var guard = 0; guard < 6; guard++) { var hit = false; MODS.forEach(function (m) { if (w.indexOf(m) === 0) { w = w.slice(m.length); hit = true; } }); if (!hit) break; }
    var kws = ['class ', 'function ', 'function* ', 'def ', 'fn ', 'interface ', 'struct ', 'impl ', 'enum '];
    for (var k = 0; k < kws.length; k++) if (w.indexOf(kws[k]) === 0) return identAt(w.slice(kws[k].length).trim());
    if (w.indexOf('const ') === 0 || w.indexOf('let ') === 0 || w.indexOf('var ') === 0) {
      var rest = w.slice(w.indexOf(' ') + 1);
      var eq = rest.indexOf('=');
      if (eq < 0) return '';
      var rhs = rest.slice(eq + 1).trim();
      var fnish = rhs.indexOf('function') === 0 || ((rhs.indexOf('(') === 0 || rhs.indexOf('async') === 0) && rhs.indexOf('=>') > 0);
      return fnish ? identAt(rest.trim()) : '';
    }
    var id = identAt(w);
    if (!id || ['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'new', 'await', 'typeof'].indexOf(id) >= 0) return '';
    var after = w.slice(id.length).trim();
    var last = w.charAt(w.length - 1);
    return after.indexOf('(') === 0 && last === '{' ? id : '';
  }
  function symbolAt(f) {
    if (!f || f.kind !== 'text') return '';
    var pos = cursor();
    if (!pos) return '';
    // CHARACTER CODES, NOT ESCAPES: this script is emitted from a template literal.
    var NL = String.fromCharCode(10), TAB = String.fromCharCode(9);
    var lines = String(f.body || '').split(NL);
    var out = [];
    var indent = 1e9;
    for (var i = Math.min(pos.line, lines.length) - 1, seen = 0; i >= 0 && out.length < 3 && seen < 4000; i--, seen++) {
      var l = lines[i];
      var t = l.trim();
      if (!t) continue;
      var ind = 0;
      while (ind < l.length && (l[ind] === ' ' || l[ind] === TAB)) ind++;
      if (ind >= indent) continue;
      var nm = declName(t);
      if (nm) { out.unshift(nm); indent = ind; if (ind === 0) break; }
    }
    return out.join(' \u203a ');
  }
  var crumbRaf = 0;
  function crumbs() {
    if (crumbRaf) return;
    crumbRaf = window.requestAnimationFrame(function () {
      crumbRaf = 0;
      var box = $('srcCrumbs');
      if (!box) return;
      var f = current();
      if (!f) { box.hidden = true; box.textContent = ''; box.dataset.sig = ''; return; }
      var sym = symbolAt(f);
      var sig = f.path + '|' + sym;
      if (box.dataset.sig === sig && !box.hidden) return;
      box.dataset.sig = sig;
      box.hidden = false;
      box.textContent = '';
      var parts = f.path.split('/');
      var add = function (cls, text) { var s = document.createElement('span'); s.className = cls; s.textContent = text; box.appendChild(s); };
      parts.forEach(function (p, i) { if (i) add('sep', '\u203a'); add('cr' + (i === parts.length - 1 ? ' last' : ''), p); });
      if (sym) { add('sep', '\u203a'); add('sym', sym); }
      box.title = f.path + (sym ? '  \u203a  ' + sym : '');
    });
  }

  function close(i) {
    var f = st.open[i];
    var go = function () {
      if (window.LAIN && LAIN.editor && f) LAIN.editor.dispose(f.path);
      st.open.splice(i, 1);
      if (st.active >= st.open.length) st.active = st.open.length - 1;
      renderTabs(); renderEditor(); renderTree();
    };
    if (f && f.dirty) { LAIN.confirm(f.path + ' has unsaved changes. Close it without saving?', { ok: 'Close without saving', danger: true }).then(function (yes) { if (yes) go(); }); return; }
    go();
  }

  function renderTree() {
    var box = $('srcTree');
    box.textContent = '';
    // GIT, SUBTLY (Source Control's own status, read by pageidepanes.js — no extra git call here).
    var g = window.LAIN && LAIN.panes && LAIN.panes.git ? LAIN.panes.git() : null;
    var gm = {}; var gdirs = {};
    var LET = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: 'X', copied: 'C' };
    ((g && g.ok && g.files) || []).forEach(function (x) {
      gm[x.path] = LET[x.state] || 'M';
      var segs = String(x.path).split('/'); var acc = '';
      for (var k = 0; k < segs.length - 1; k++) { acc = acc ? acc + '/' + segs[k] : segs[k]; gdirs[acc] = true; }
    });
    var draw = function (dirPath, depth) {
      var entries = st.tree[dirPath] || [];
      entries.forEach(function (e) {
        var row = document.createElement('div');
        var cur = current();
        row.className = 'srcRow' + (e.dir ? ' dir' : '') + (!e.dir && cur && cur.path === e.path ? ' on' : '');
        row.style.paddingLeft = (10 + depth * 12) + 'px';
        var tw = document.createElement('span');
        tw.className = 'tw';
        tw.textContent = e.dir ? (st.expanded[e.path] ? '\\u25be' : '\\u25b8') : '';
        row.appendChild(tw);
        var nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = e.name;
        row.appendChild(nm);
        if (e.changed) { var c = document.createElement('span'); c.className = 'ch'; c.title = 'changed this session'; row.appendChild(c); }
        if (!e.dir && gm[e.path]) { var gs = document.createElement('span'); gs.className = 'gs ' + gm[e.path]; gs.textContent = gm[e.path]; gs.title = 'git: ' + gm[e.path]; row.appendChild(gs); }
        if (e.dir && gdirs[e.path]) row.className += ' gdir';
        if (e.dim) row.className += ' dim';
        // ONE CLICK PREVIEWS, a double-click (or an edit) keeps the tab — as every editor does.
        row.onclick = function () {
          if (e.dir) { toggle(e.path, depth); } else { openFile(e.path, { preview: true }); }
        };
        if (!e.dir) row.ondblclick = function () { openFile(e.path, { pin: true }); };
        // THE EXPLORER'S MENU AND DRAG TO MOVE live in pageeditor.js.
        if (window.LAIN && LAIN.editor) LAIN.editor.decorateRow(row, e);
        box.appendChild(row);
        if (e.dir && st.expanded[e.path]) draw(e.path, depth + 1);
      });
    };
    draw('.', 0);
  }

  async function toggle(p, depth) {
    if (st.expanded[p]) { st.expanded[p] = false; renderTree(); return; }
    var r = await api('/api/files/tree', { path: p });
    if (!r.ok) { notice(r.why, true); return; }
    st.tree[p] = r.entries;
    st.expanded[p] = true;
    renderTree();
  }

  async function loadRoot() {
    var r = await api('/api/files/tree', { path: '' });
    if (!r.ok) { notice(r.why, true); return; }
    st.tree['.'] = r.entries;
    // EVERY EXPANDED FOLDER IS READ AGAIN TOO: a file made outside Noema (a terminal, another
    // editor, git) appears where it was made — Refresh used to re-read the top level only.
    var open = Object.keys(st.expanded).filter(function (d) { return st.expanded[d]; });
    await Promise.all(open.map(async function (d) {
      var x = await api('/api/files/tree', { path: d });
      if (x && x.ok) st.tree[d] = x.entries; else st.expanded[d] = false;
    }));
    renderTree();
  }

  // ---- opening, saving --------------------------------------------------
  // ONE OPEN PER PATH IN FLIGHT. A double-click is a click (open as preview) and then a
  // double-click (keep it) 200 ms apart; the second arrived while the first was still
  // reading the file, found no tab yet, and opened the same file in a second tab.
  var opening = {};
  async function openFile(p, opts) {
    if (opening[p]) { try { await opening[p]; } catch (e) { /* the first open reports its own failure */ } }
    var at = -1;
    st.open.forEach(function (f, i) { if (f.path === p) at = i; });
    if (at >= 0) {
      if (opts && opts.pin) st.open[at].preview = false;
      st.active = at;
      st.hits = [];
      renderTabs(); renderEditor(); renderTree();
      if (opts && opts.line != null) gotoLine(opts.line, opts);
      return true;
    }
    var pending = api('/api/files/open', { path: p });
    opening[p] = pending;
    var r;
    try { r = await pending; } finally { if (opening[p] === pending) delete opening[p]; }
    if (!r.ok) { if (window.LAIN && LAIN.toast) LAIN.toast(r.why, true); else notice(r.why, true); return false; }
    // A FEW TABS, NOT DOZENS. The blueprint asks for "several open tabs, not
    // dozens": past eight, the oldest CLEAN one goes, because a dirty buffer
    // is unsaved work and closing it silently would destroy it.
    if (st.open.length >= 8) {
      var victim = -1;
      st.open.forEach(function (f, i) { if (victim < 0 && !f.dirty) victim = i; });
      if (victim >= 0) st.open.splice(victim, 1);
    }
    // THE BUILT-IN EDITOR IS A TEXTAREA, which turns CRLF into LF on its own;
    // it edits LF and the save writes the file's own line ending back. Monaco
    // keeps the file's line endings itself.
    var body = r.kind === 'image' ? '' : (editorOwns() || r.eol !== 'CRLF' ? r.body : String(r.body).split('\\r\\n').join('\\n'));
    st.open.push({
      path: r.path, body: body, saved: body, hash: r.hash, mtimeMs: r.mtimeMs,
      language: r.language, mode: r.mode || null, kind: r.kind || 'text', mime: r.mime || null,
      encoding: r.encoding || 'utf8', eol: r.eol || 'LF', dirty: false, rev: 0,
    });
    if (window.LAIN && LAIN.editor) LAIN.editor.touched(r.path);
    // A SPLIT EDITOR GROUP (pagegroups.js) opens the buffer without taking group 1's tab.
    if (opts && opts.background) { renderTabs(); return true; }
    // A PREVIEW TAB replaces the previous clean preview tab, in its place.
    var added = st.open[st.open.length - 1];
    added.preview = Boolean(opts && opts.preview);
    if (added.preview) {
      var old = -1;
      st.open.forEach(function (f, i) { if (f !== added && f.preview && !f.dirty) old = i; });
      if (old >= 0) {
        if (window.LAIN && LAIN.editor) LAIN.editor.dispose(st.open[old].path);
        st.open.splice(st.open.length - 1, 1);
        st.open.splice(old, 1, added);
        st.active = old;
        st.hits = [];
        renderTabs(); renderEditor(); renderTree();
        if (opts && opts.line != null) gotoLine(opts.line, opts);
        return true;
      }
    }
    st.active = st.open.length - 1;
    st.hits = [];
    renderTabs(); renderEditor(); renderTree();
    if (opts && opts.line != null) gotoLine(opts.line, opts);
    return true;
  }

  function gotoLine(n, opts) {
    var f = current();
    if (!f) return;
    if (editorOwns()) { LAIN.editor.reveal(n, opts); return; }
    var idx = Math.max(0, Math.min(f.body.split('\\n').length - 1, Number(n) - 1));
    st.hits = [idx];
    paint();
    var gut = $('srcGut').children[idx];
    if (gut) gut.scrollIntoView({ block: 'center' });
  }

  function note(text, bad, action) {
    var n = $('srcNote');
    if (!text) { n.hidden = true; n.textContent = ''; return; }
    n.hidden = false;
    n.className = 'srcNote' + (bad ? ' bad' : '');
    n.textContent = text;
    if (action) {
      var b = document.createElement('button');
      b.textContent = action.label;
      b.onclick = action.run;
      n.appendChild(b);
    }
  }

  async function save(force, target) {
    var f = target || current();
    if (!f || f.kind === 'image') return;
    var out = editorOwns() || f.eol !== 'CRLF' ? f.body : String(f.body).split('\\r\\n').join('\\n').split('\\n').join('\\r\\n');
    var r = await api('/api/files/save', {
      path: f.path, body: out, hash: f.hash, mtimeMs: f.mtimeMs, force: Boolean(force), encoding: f.encoding,
      origin: window.LAIN && LAIN.editor && LAIN.editor.saveOrigin ? LAIN.editor.saveOrigin(f.path) : 'USER',
    });
    if (r.stale) {
      // THE INTERESTING CASE, and the one this product creates constantly:
      // Noema edited the file while it was open. Both versions exist; the
      // person decides. Nothing is overwritten by default.
      note(r.why, true, {
        label: 'Reload from disk',
        run: function () { f.body = r.current; f.saved = r.current; f.hash = r.hash; f.mtimeMs = r.mtimeMs; f.dirty = false; f.rev = (f.rev || 0) + 1; note(''); renderTabs(); renderEditor(); },
      });
      return;
    }
    if (r.truncation) { note(r.why, true, { label: 'Save anyway', run: function () { save(true); } }); return; }
    if (!r.ok) { note(r.why || 'could not save', true); return; }
    f.saved = f.body; f.hash = r.hash; f.mtimeMs = r.mtimeMs; f.dirty = false;
    if (r.encoding) f.encoding = r.encoding;
    note('');
    // WHAT WAS SAVED IS CHECKED, by the same checker a model's edit gets.
    if (window.LAIN && LAIN.editor) LAIN.editor.checkSaved(f.path);
    if (window.LAIN && LAIN.prov) LAIN.prov.refresh(true);
    renderTabs();
    if (poll) poll();
  }

  /**
   * DID ANYTHING MOVE UNDER US? Called from the ordinary poll.
   *
   * A CLEAN buffer is reloaded silently — that is Noema editing a file the
   * person is watching, which is the feature. A DIRTY one is never touched;
   * it says so and waits, because the alternative is discarding typing.
   */
  // ONE QUESTION IN FLIGHT, AT MOST ONE A SECOND. Renders come in bursts (every
  // poll, every wake); the answer does not change that fast.
  var freshBusy = false, freshAt = 0;
  async function refresh(force) {
    if (!st.open.length || freshBusy) return;
    if (!force && Date.now() - freshAt < 1000) return;
    freshBusy = true; freshAt = Date.now();
    var r;
    try {
      r = await api('/api/files/freshness', {
        open: st.open.map(function (f) { return { path: f.path, hash: f.hash, mtimeMs: f.mtimeMs }; }),
      });
    } finally { freshBusy = false; }
    if (!r || !r.ok || !r.files) return;
    var repainted = false;
    for (var i = 0; i < r.files.length; i++) {
      var info = r.files[i];
      var f = st.open[i];
      if (!f || !info.changed || info.gone) continue;
      if (f.dirty) { if (i === st.active) note(f.path + ' changed on disk, and you have unsaved edits', true); continue; }
      var fresh = await api('/api/files/open', { path: f.path });
      if (!fresh.ok) continue;
      // ---- THE PATCH, NOT A SILENT SWAP ---------------------------------
      //
      // The blueprint asks the person to SEE what Noema changed:
      //     - opacity: 0.2
      //     + opacity: 0.5
      // Replacing the buffer and repainting would show the RESULT and hide the
      // CHANGE, which is the one thing worth watching. So the changed lines are
      // computed here and marked, and the patch is stated above the editor.
      //
      // NOT TOKEN-BY-TOKEN TYPING. This renders a real write event that already
      // happened, once, when it happened.
      var patch = diff(f.body, fresh.body);
      f.body = fresh.body; f.saved = fresh.body; f.hash = fresh.hash; f.mtimeMs = fresh.mtimeMs; f.rev = (f.rev || 0) + 1;
      st.patch = { path: f.path, at: Date.now(), lines: patch.changed, removed: patch.removed, added: patch.added };
      if (i === st.active) {
        st.hits = patch.changed;
        showPatch(patch, f.path);
      }
      repainted = true;
    }
    if (repainted) { renderTabs(); renderEditor(); }
  }

  /**
   * THE SMALLEST DIFF THAT ANSWERS THE QUESTION.
   *
   * A COMMON-PREFIX / COMMON-SUFFIX TRIM, not Myers. For the shape of edit that
   * actually happens here — a model changing one property, one line, one block —
   * it produces exactly the right answer for a few lines of code. It degrades
   * to "these N lines changed" on a large rewrite, which is also the honest
   * answer: nobody reads a 300-line inline patch.
   */
  function diff(before, after) {
    var a = String(before).split('\\n');
    var b = String(after).split('\\n');
    var head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    var tail = 0;
    while (tail < (a.length - head) && tail < (b.length - head)
           && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    var removed = a.slice(head, a.length - tail);
    var added = b.slice(head, b.length - tail);
    var changed = [];
    for (var i = 0; i < added.length; i++) changed.push(head + i);
    return { head: head, removed: removed, added: added, changed: changed };
  }

  function showPatch(patch, p) {
    if (!patch.removed.length && !patch.added.length) return;
    var n = $('srcNote');
    n.hidden = false;
    n.className = 'srcNote';
    n.textContent = '';
    var head = document.createElement('div');
    head.textContent = 'Noema edited ' + p + '  ·  line ' + (patch.head + 1);
    n.appendChild(head);
    var show = function (rows, sign, cls) {
      rows.slice(0, 6).forEach(function (l) {
        var d = document.createElement('div');
        d.className = cls;
        d.style.fontFamily = 'var(--mono)';
        d.textContent = sign + ' ' + l.trim();
        n.appendChild(d);
      });
    };
    show(patch.removed, '-', 'del');
    show(patch.added, '+', 'add');
    // IT FADES. A patch is news for a moment; leaving it above the editor for
    // the rest of the session makes it furniture.
    window.clearTimeout(st.patchTimer);
    st.patchTimer = window.setTimeout(function () { note(''); st.hits = []; paint(); }, 12000);
  }

  // ---- find -------------------------------------------------------------
  function find(q) {
    var f = current();
    st.hits = [];
    if (f && q) {
      var needle = q.toLowerCase();
      f.body.split('\\n').forEach(function (l, i) { if (l.toLowerCase().indexOf(needle) >= 0) st.hits.push(i); });
    }
    paint();
    if (st.hits.length) {
      var g = $('srcGut').children[st.hits[0]];
      if (g) g.scrollIntoView({ block: 'center' });
    }
    return st.hits.length;
  }

  // ---- quick open -------------------------------------------------------
  async function quick(q) {
    var r = await api('/api/files/find', { q: q });
    var box = $('quickHits');
    box.textContent = '';
    st.quickSel = 0;
    ((r && r.matches) || []).forEach(function (m, i) {
      var d = document.createElement('div');
      d.className = 'hit';
      d.setAttribute('aria-selected', String(i === 0));
      d.textContent = m.path;
      d.onclick = function () { closeQuick(); openFile(m.path); };
      box.appendChild(d);
    });
  }
  function openQuick() {
    $('quick').hidden = false; $('quickQ').value = ''; $('quickHits').textContent = ''; $('quickQ').focus();
    // RECENTLY OPENED FIRST, like every editor's Ctrl+P before anything is typed.
    var recent = (window.LAIN && LAIN.editor) ? LAIN.editor.recent() : [];
    st.quickSel = 0;
    recent.slice(0, 20).forEach(function (p, i) {
      var d = document.createElement('div');
      d.className = 'hit';
      d.setAttribute('aria-selected', String(i === 0));
      d.textContent = p;
      d.onclick = function () { closeQuick(); openFile(p); };
      $('quickHits').appendChild(d);
    });
  }
  function closeQuick() { $('quick').hidden = true; }

  // ---- wiring -----------------------------------------------------------
  function boot(apiFn, noticeFn, pollFn) {
    api = apiFn; notice = noticeFn; poll = pollFn;

    $('srcText').addEventListener('input', function () {
      var f = current();
      if (!f) return;
      f.body = this.value;
      f.dirty = f.body !== f.saved;
      paint();
      renderTabs();
    });
    // THE HIGHLIGHT LAYER FOLLOWS THE TEXTAREA, or the colour drifts off the
    // characters the moment anything scrolls.
    $('srcText').addEventListener('scroll', function () {
      $('srcHi').scrollTop = this.scrollTop;
      $('srcHi').scrollLeft = this.scrollLeft;
    });
    $('srcText').addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var s = this.selectionStart, en = this.selectionEnd;
        this.value = this.value.slice(0, s) + '  ' + this.value.slice(en);
        this.selectionStart = this.selectionEnd = s + 2;
        this.dispatchEvent(new Event('input'));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(false); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && !e.shiftKey) { e.preventDefault(); findPrompt(); }
    });
    // THE STATUS BAR'S Ln/Col follows the caret; it is painted by the IDE.
    ['keyup', 'click'].forEach(function (ev) { $('srcText').addEventListener(ev, function () { var sb = $('sbPos'); var c = cursor(); if (sb) sb.textContent = c ? 'Ln ' + c.line + ', Col ' + c.col : ''; crumbs(); }); });
    $('srcSave').onclick = function () { save(false); };
    $('srcFindBtn').onclick = findPrompt;
    $('quickQ').addEventListener('input', function () { quick(this.value); });
    $('quickQ').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeQuick();
      if (e.key === 'Enter') {
        var sel = $('quickHits').children[st.quickSel];
        if (sel) { closeQuick(); openFile(sel.textContent); }
      }
    });
    document.addEventListener('keydown', function (e) {
      // CTRL+P IS THE IDE'S, and only while a project is open in front of you.
      var inIde = LAIN.nav && LAIN.nav.tab() === 'ide' && loadedRoot;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'p' || e.key === 'P') && inIde) { e.preventDefault(); openQuick(); }
      if (e.key === 'Escape' && !$('quick').hidden) closeQuick();
    });
    $('quick').addEventListener('click', function (e) { if (e.target === this) closeQuick(); });
  }

  /**
   * THE IDE SAYS WHETHER THE EDITOR IS SHOWING, AND FOR WHICH PROJECT ROOT.
   * The root is Core's (S.workspace.project.root). A different root is a
   * different project: its tree is read fresh and the previous project's
   * buffers are closed — their paths are relative to a folder that is no
   * longer the one a save would write into. The IDE asks about unsaved work
   * before it opens another project, so nothing dirty reaches this point
   * unannounced.
   */
  var loadedRoot = null;
  function sync(open, root) {
    if (root && root !== loadedRoot) {
      st.open = []; st.active = -1; st.tree = {}; st.expanded = {}; st.hits = [];
      renderTabs(); renderEditor(); renderTree();
      loadedRoot = null;
    }
    if (open && root && loadedRoot !== root) { loadedRoot = root; loadRoot(); }
  }

  /** Line and column of the caret in the open file, 1-based, or null. */
  function cursor() {
    var f = current();
    if (!f) return null;
    if (editorOwns()) return LAIN.editor.cursor();
    if (f.kind === 'image') return null;
    var body = String(f.body == null ? '' : f.body);
    var t = $('srcText');
    var at = Math.min(t.selectionStart || 0, body.length);
    var before = body.slice(0, at);
    var nl = before.lastIndexOf('\\n');
    return { line: before.split('\\n').length, col: at - nl };
  }

  function closeActive() { if (st.active >= 0) close(st.active); }

  function findPrompt() {
    if (!current()) return;
    if (editorOwns()) { LAIN.editor.find(false); return; }
    LAIN.dialog({ title: 'Find in ' + current().path.split('/').pop(), fields: [{ key: 'q', label: 'Find', value: '' }], ok: 'Find' }).then(function (v) {
      if (!v || !v.q) return;
      var n = find(v.q);
      note(n ? n + ' line' + (n === 1 ? '' : 's') + ' match “' + v.q + '”' : 'no match for “' + v.q + '”', !n);
      window.clearTimeout(st.patchTimer);
      st.patchTimer = window.setTimeout(function () { note(''); }, 6000);
    });
  }

  return {
    boot: boot, loadRoot: loadRoot, openFile: openFile, gotoLine: gotoLine,
    refresh: refresh, renderTree: renderTree, find: find, save: save, diff: diff,
    state: function () { return st; },
    highlight: highlight, sync: sync, cursor: cursor, closeActive: closeActive,
    findPrompt: findPrompt, quickOpen: function () { openQuick(); },
    current: current, renderTabs: renderTabs, renderEditor: renderEditor, note: note,
    reloadDir: function (p) { var d = p && p !== '.' ? p : '.'; if (d === '.') return loadRoot(); st.expanded[d] = false; return toggle(d, 0); },
    activate: function (i) { if (i >= 0 && i < st.open.length) { st.active = i; st.hits = []; renderTabs(); renderEditor(); renderTree(); } },
    close: close, closeMany: closeMany, collapseAll: collapseAll, reveal: reveal, crumbs: crumbs, tabMenu: tabMenu,
    /** Save one buffer by path (a split editor group's Ctrl+S). */
    saveFile: function (p) { var f = st.open.filter(function (x) { return x.path === p; })[0]; return f ? save(false, f) : null; },
  };
})();
`;
}

module.exports = { CSS, HTML, TREE_HTML, PANE_HTML, js };
