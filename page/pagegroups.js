'use strict';

/**
 * EDITOR GROUPS — split right, split down, move an editor between groups.
 *
 *   Explorer | Editor group 1 | Editor group 2 | BOT / AGENT
 *
 * ------------------------------------------------------------------------
 * GROUP 1 IS THE EXISTING EDITOR. pagesource.js keeps the open buffers (body,
 * dirty state, hash) and group 1's tabs; pageeditor.js owns its Monaco editor.
 * Nothing about group 1 changes when a split is added — every caller that
 * opens a file, reveals a line or reports the selection still talks to it.
 *
 * GROUPS 2+ ARE MORE VIEWS OF THE SAME BUFFERS. Each has its own tab strip, its
 * own active editor and its own Monaco instance, showing the SAME Monaco model
 * group 1 uses for that file (LAIN.editor.modelFor). An edit typed in any group
 * is one edit to one buffer: the dirty dot, Save and provenance see one file.
 *
 * The BOT / AGENT pane is not an editor group and never becomes one.
 *
 * WINDOW STATE, NOT CORE STATE. Which files sit in which group is presentation;
 * it is remembered in this window's storage (pagehouse.js focus workspace) and
 * restored with the tabs. "This" — the Selection Core resolves — is reported
 * from whichever group has focus (pageeditor.js report).
 *
 * Needs Monaco: with the plain-text fallback editor there is one group, and
 * the split commands say so.
 */
const CSS = `
.edGroups{display:grid;min-height:0;min-width:0;gap:0}
.edGroups.right{grid-auto-flow:column;grid-auto-columns:minmax(0,1fr)}
.edGroups.down{grid-auto-flow:row;grid-auto-rows:minmax(0,1fr)}
.edGroups>.srcPane{min-height:0;min-width:0}
.edGroups.right>.srcPane+.srcPane{border-left:1px solid var(--line)}
.edGroups.down>.srcPane+.srcPane{border-top:1px solid var(--line)}
.grpPane{display:grid;grid-template-rows:auto 1fr;background:var(--bg)}
.grpPane.focused .srcTabs{box-shadow:inset 0 -1px 0 var(--accent-line)}
.grpHost{min-height:0;min-width:0;position:relative}
.srcTab.dragover{box-shadow:inset 2px 0 0 var(--accent)}
.srcTabs.dropzone{outline:1px dashed var(--accent-line);outline-offset:-2px}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var MAX_GROUPS = 4;
  var G = { dir: 'right', groups: [], focused: 0, seq: 1 };   // groups[0] is a stand-in for pagesource's own tabs

  function src() { return L.source; }
  function monacoOk() { return Boolean(L.editor && L.editor.active && L.editor.active() && L.editor.monaco && L.editor.monaco()); }
  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = String(x); return n; }
  function base(p) { return String(p).split('/').pop(); }

  /** The container holding group 1 (the existing #srcPanel) and the rest, created on first split. */
  function container() {
    var panel = document.getElementById('srcPanel');
    if (!panel) return null;
    if (panel.parentNode && panel.parentNode.classList.contains('edGroups')) return panel.parentNode;
    var wrap = el('div', 'edGroups ' + G.dir);
    panel.parentNode.insertBefore(wrap, panel);
    wrap.appendChild(panel);
    panel.addEventListener('mousedown', function () { setFocus(0); }, true);
    return wrap;
  }

  function group(i) { return i === 0 ? null : G.groups[i - 1] || null; }
  function count() { return 1 + G.groups.length; }

  // ---- group 1: pagesource's own tabs ----------------------------------------------
  function mainFile() { var f = src().current(); return f ? f.path : null; }
  function mainTabs() { return (src().state().open || []).map(function (f) { return f.path; }); }

  // ---- groups 2+ ------------------------------------------------------------------
  function create(paths, active) {
    if (count() >= MAX_GROUPS) { if (L.toast) L.toast('At most ' + MAX_GROUPS + ' editor groups.', true); return null; }
    var wrap = container();
    if (!wrap) return null;
    var g = { id: G.seq++, tabs: [], active: null, ed: null };
    var pane = el('section', 'srcPane grpPane');
    var tabs = el('div', 'srcTabs');
    var host = el('div', 'grpHost');
    pane.appendChild(tabs);
    pane.appendChild(host);
    wrap.appendChild(pane);
    g.pane = pane; g.tabsEl = tabs; g.host = host;
    var M = L.editor.monaco();
    g.ed = M.editor.create(host, { model: null, theme: 'lain-dark', automaticLayout: true, fontFamily: '"Cascadia Code",Consolas,monospace', fontSize: 13, minimap: { enabled: false } });
    g.ed.addCommand(M.KeyMod.CtrlCmd | M.KeyCode.KeyS, function () { if (g.active) src().saveFile(g.active); });
    g.ed.onDidFocusEditorText(function () { setFocus(G.groups.indexOf(g) + 1); });
    g.ed.onDidChangeCursorSelection(function () { if (L.editor.report) L.editor.report(); });
    dropTarget(tabs, g);
    G.groups.push(g);
    (paths || []).forEach(function (p) { addTab(g, p); });
    show(g, active || (paths && paths[0]) || null);
    setFocus(G.groups.length);
    persist();
    return g;
  }

  async function addTab(g, p, at) {
    if (!p) return;
    var i = g.tabs.indexOf(p);
    if (i >= 0) g.tabs.splice(i, 1);
    if (at == null || at > g.tabs.length) g.tabs.push(p); else g.tabs.splice(at, 0, p);
    renderTabs(g);
  }

  /** Show a file in group g: its buffer is opened in pagesource if it is not yet. */
  async function show(g, p) {
    if (!g) return;
    if (!p) { g.active = null; g.ed.setModel(null); renderTabs(g); return; }
    var buf = (src().state().open || []).filter(function (f) { return f.path === p; })[0];
    if (!buf) { var ok = await src().openFile(p, { background: true }); if (!ok) return; buf = (src().state().open || []).filter(function (f) { return f.path === p; })[0]; }
    if (!buf || buf.kind === 'image') { if (L.toast) L.toast(base(p) + ' cannot be shown in a split (not text).', true); return; }
    if (g.tabs.indexOf(p) < 0) g.tabs.push(p);
    if (g.active && g.views) g.views[g.active] = g.ed.saveViewState();
    g.active = p;
    g.ed.setModel(L.editor.modelFor(buf));
    g.views = g.views || {};
    if (g.views[p]) g.ed.restoreViewState(g.views[p]);
    renderTabs(g);
    persist();
  }

  function closeTab(g, p) {
    var i = g.tabs.indexOf(p);
    if (i < 0) return;
    g.tabs.splice(i, 1);
    if (g.active === p) show(g, g.tabs[Math.min(i, g.tabs.length - 1)] || null);
    renderTabs(g);
    if (!g.tabs.length) closeGroup(G.groups.indexOf(g) + 1);
    persist();
  }

  function renderTabs(g) {
    var bar = g.tabsEl;
    bar.textContent = '';
    g.tabs.forEach(function (p, i) {
      var buf = (src().state().open || []).filter(function (f) { return f.path === p; })[0];
      var t = el('div', 'srcTab');
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(p === g.active));
      t.title = p;
      t.draggable = true;
      if (buf && buf.dirty) t.appendChild(el('span', 'dot'));
      t.appendChild(el('span', '', base(p)));
      var x = el('span', 'x', '×');
      x.onclick = function (e) { e.stopPropagation(); closeTab(g, p); };
      t.appendChild(x);
      t.onclick = function () { show(g, p); setFocus(G.groups.indexOf(g) + 1); };
      dragSource(t, p, G.groups.indexOf(g) + 1, i);
      bar.appendChild(t);
    });
  }

  function closeGroup(i) {
    var g = group(i);
    if (!g) return;
    try { g.ed.setModel(null); g.ed.dispose(); } catch (e) { /* already gone */ }
    if (g.pane && g.pane.parentNode) g.pane.parentNode.removeChild(g.pane);
    G.groups.splice(i - 1, 1);
    setFocus(Math.min(G.focused, count() - 1));
    persist();
  }

  function setFocus(i) {
    G.focused = Math.max(0, Math.min(i, count() - 1));
    G.groups.forEach(function (g, k) { g.pane.classList.toggle('focused', k + 1 === G.focused); });
    if (L.editor && L.editor.report) L.editor.report();
  }

  // ---- drag to reorder, drag to another group ---------------------------------------
  var drag = null;
  function dragSource(t, p, gi, i) {
    t.addEventListener('dragstart', function (e) { drag = { p: p, from: gi, i: i }; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', p); } catch (x) { /* some hosts refuse */ } });
    t.addEventListener('dragover', function (e) { if (!drag) return; e.preventDefault(); t.classList.add('dragover'); });
    t.addEventListener('dragleave', function () { t.classList.remove('dragover'); });
    t.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); t.classList.remove('dragover'); if (drag) moveTo(drag, gi, i); drag = null; });
  }
  function dropTarget(bar, g) {
    bar.addEventListener('dragover', function (e) { if (!drag) return; e.preventDefault(); bar.classList.add('dropzone'); });
    bar.addEventListener('dragleave', function () { bar.classList.remove('dropzone'); });
    bar.addEventListener('drop', function (e) { e.preventDefault(); bar.classList.remove('dropzone'); if (drag) moveTo(drag, G.groups.indexOf(g) + 1, null); drag = null; });
  }
  function moveTo(d, toGroup, at) {
    if (toGroup === 0) {
      // Into group 1: pagesource opens and activates it; it leaves the split it came from.
      src().openFile(d.p);
      if (d.from > 0) closeTab(group(d.from), d.p);
      return;
    }
    var to = group(toGroup);
    if (!to) return;
    if (d.from === toGroup) { addTab(to, d.p, at); persist(); return; }
    addTab(to, d.p, at);
    show(to, d.p);
    if (d.from > 0) closeTab(group(d.from), d.p);
  }

  // ---- commands (the palette and the keyboard call these) ------------------------------
  function need() {
    if (monacoOk()) return true;
    if (L.toast) L.toast('Split editors need the full editor (Monaco); the plain-text editor has one group.', true);
    return false;
  }
  function focusedFile() { var g = group(G.focused); return g ? g.active : mainFile(); }
  function split(dir) {
    if (!need()) return;
    var p = focusedFile();
    if (!p) { if (L.toast) L.toast('Open a file first.', true); return; }
    if (G.groups.length && dir !== G.dir) { if (L.toast) L.toast('This window splits one way at a time — close the other groups to split ' + (dir === 'right' ? 'right' : 'down') + '.', true); return; }
    G.dir = dir;
    var wrap = container();
    if (wrap) wrap.className = 'edGroups ' + dir;
    create([p], p);
  }
  function moveToNext() {
    if (!need()) return;
    var p = focusedFile();
    if (!p) return;
    var from = G.focused;
    var to = from + 1 < count() ? from + 1 : 0;
    if (to === from || (to === 0 && from === 0)) { split(G.dir); if (from === 0) src().close((src().state().open || []).map(function (f) { return f.path; }).indexOf(p)); return; }
    moveTo({ p: p, from: from, i: null }, to, null);
    setFocus(to);
  }
  function focusNext() {
    if (count() < 2) return;
    var n = (G.focused + 1) % count();
    setFocus(n);
    var g = group(n);
    if (g) g.ed.focus(); else if (L.editor.focus) L.editor.focus();
  }

  // ---- restoration (pagehouse.js keeps it with the Focus workspace) ------------------
  function serialize() { return { dir: G.dir, groups: G.groups.map(function (g) { return { tabs: g.tabs.slice(0, 12), active: g.active }; }) }; }
  var restoring = false;
  function restore(data) {
    if (!data || !Array.isArray(data.groups) || !data.groups.length || G.groups.length || !monacoOk()) return;
    restoring = true;
    G.dir = data.dir === 'down' ? 'down' : 'right';
    var wrap = container();
    if (wrap) wrap.className = 'edGroups ' + G.dir;
    data.groups.slice(0, MAX_GROUPS - 1).forEach(function (d) { if (d && d.tabs && d.tabs.length) create(d.tabs, d.active); });
    restoring = false;
    setFocus(0);
  }
  function persist() { if (!restoring && L.focus && L.focus.saveGroups) L.focus.saveGroups(); }

  /** For pageeditor.report: the editor and file that have focus, when it is a split. */
  function focused() { var g = group(G.focused); return g && g.active ? { ed: g.ed, path: g.active } : null; }

  /** A buffer's dirty dot changed, or a file closed: keep the split tab strips honest. */
  function refresh() {
    var open = mainTabs();
    G.groups.slice().forEach(function (g) {
      g.tabs = g.tabs.filter(function (p) { return open.indexOf(p) >= 0; });
      if (g.active && open.indexOf(g.active) < 0) show(g, g.tabs[0] || null);
      if (!g.tabs.length) closeGroup(G.groups.indexOf(g) + 1); else renderTabs(g);
    });
  }

  L.groups = {
    splitRight: function () { split('right'); }, splitDown: function () { split('down'); },
    moveToNext: moveToNext, closeGroup: function () { if (G.focused > 0) closeGroup(G.focused); else if (L.toast) L.toast('The first editor group stays; close the others.', true); },
    focusNext: focusNext, focused: focused, serialize: serialize, restore: restore, refresh: refresh,
    count: count, state: function () { return { dir: G.dir, focused: G.focused, groups: [{ tabs: mainTabs(), active: mainFile() }].concat(G.groups.map(function (g) { return { tabs: g.tabs.slice(), active: g.active }; })) }; },
  };

  L.onBoot(function () {
    document.addEventListener('keydown', function (e) {
      if (L.nav.tab() !== 'ide') return;
      var ctrl = e.ctrlKey || e.metaKey;
      // VS Code's own keys: Ctrl+\ splits right, Ctrl+K Ctrl+\ is not reproduced.
      if (ctrl && !e.shiftKey && e.key === '\\') { e.preventDefault(); split('right'); }
    });
  });
  L.onRender(function () { if (G.groups.length) refresh(); });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { CSS, js, client };
