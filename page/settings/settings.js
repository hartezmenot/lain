'use strict';

/**
 * SETTINGS — the application's configuration, and the tools behind it.
 *
 *   ┌ Settings ─────────────────────────────────────────────────────────────┐
 *   │ WORKSPACE      │  Appearance                                           │
 *   │  Appearance    │  ┌ plane ───────────────────────────────────────────┐ │
 *   │  Keymap        │  │ Colour palette · Display · Editor theme · Reset │ │
 *   │  …             │  └──────────────────────────────────────────────────┘ │
 *
 * CORE'S SCHEMA, DRAWN. Sections and fields come from GET /api/settings
 * (src/settings.js); this file draws six field TYPES and calls the two write
 * routes. It never hard-codes a setting key or invents a control.
 *
 *   GENERAL → General   NOTIFICATIONS → Notifications   PATHS → Storage
 *   PRIVACY → Security  CONNECTIONS → Integrations
 *   MODELS → the Model room · messaging channels → Settings › Assistant
 *
 * Appearance, Keymap and Agent Instructions are settings/prefs.js; GitHub is
 * settings/github.js; Router Server and Bots are settings/router.js; the
 * Advanced pages are workbench/devsettings.js. Every group is a flat plane.
 *
 * `L.tools` is the one client copy of POST /api/mcp/servers and POST /api/skills
 * (Home's status and the search read it; the MCP & Skills room manages them).
 */

const HTML = `
<section class="view setv" id="vSettings" data-view="settings" hidden>
  <div class="setv-head"><h1 class="u-title">Settings</h1><p class="u-sub">How LAIN looks, which keys it answers to, and what the Agent is told.</p></div>
  <div class="setbody">
    <nav class="setnav" id="settingsNav" aria-label="Settings pages"></nav>
    <div class="spane setpane" id="settingsPane"></div>
  </div>
</section>`;

const CSS = `
.setv{display:flex;flex-direction:column;min-height:0;height:100%}
.setv-head{padding:28px 32px 14px}
.setbody{flex:1;min-height:0;display:grid;grid-template-columns:212px minmax(0,1fr)}
.setnav{padding:0 10px 24px 22px;overflow-y:auto}
.setnav h5{margin:16px 10px 4px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);font-weight:600}
.setnav h5:first-child{margin-top:2px}
.setnav .snav{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:6px 10px;border-radius:var(--radius-sm);color:var(--text-secondary);font-size:13px}
.setnav .snav:hover{background:var(--hover);color:var(--text-primary)}
.setnav .snav[aria-selected=true]{background:var(--selection);color:var(--text-primary);font-weight:600}
.setnav .snav .go{margin-left:auto;color:var(--text-muted);font-size:12px}
.setpane{min-height:0;overflow-y:auto;padding:2px 32px 48px 18px}
.setpane > *{max-width:860px}
.setpane h2{font:600 17px/1.25 var(--display);margin:0 0 4px;color:var(--text-primary)}
.setpane .sub{font-size:13px;color:var(--text-secondary);margin:0 0 14px;max-width:68ch;line-height:1.5}
/* EVERY GROUP IS A PLANE. */
.setpane .fields,.setpane .u-group,.setpane .pf-sec{background:var(--surface-base);border-radius:var(--radius-md);padding:6px 18px;margin:0 0 12px}
.setpane .u-group{padding:14px 18px}
.setpane .u-group + .u-group{border-top:0;padding-top:14px}
.setpane .u-group > h4{font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);margin:0 0 8px}
.setpane .field{font-size:13px}
.setpane .fields > .field:first-child,.setpane .fields > h4 + .field{border-top:0}
.setpane .missing{font-size:12.5px;color:var(--text-muted)}
.setpane .palc{cursor:pointer;width:100%;display:grid;grid-template-columns:minmax(0,1fr) 24px;align-items:center;padding:9px 0}
.setpane .palc[aria-pressed=true] .u-nm{color:var(--text-primary)}
.setpane .palc .u-who{margin-top:2px}
.setpane .palc .sw{display:inline-flex;gap:0;border-radius:var(--radius-xs);overflow:hidden;flex:none}
.setpane .palc .sw i{width:14px;height:20px;display:block}
.setpane .palc .u-nm{gap:12px}
.setpane .u-ck{color:var(--accent-primary);display:grid;place-items:center;width:24px}
@media (max-width: 900px){.setbody{grid-template-columns:minmax(0,1fr)}.setnav{display:flex;flex-wrap:wrap;gap:4px;padding:6px 16px 10px;max-height:34vh;border-bottom:1px solid var(--separator)}.setnav h5{width:100%;margin:8px 4px 2px}.setnav .snav{width:auto}.setpane{padding:14px 16px 40px}.setv-head{padding:20px 16px 10px}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var page = 'appearance';
  var schema = null;
  var loading = false;
  var tools = null;
  var toolsLoading = false;

  var CORE_PAGE = { GENERAL: 'general', NOTIFICATIONS: 'notifications', PATHS: 'storage', PRIVACY: 'privacy', CONNECTIONS: 'integrations', MODELS: 'models' };
  function pageOf(id) { return CORE_PAGE[id] || 'general'; }
  function coreSection(p) {
    var id = Object.keys(CORE_PAGE).filter(function (k) { return CORE_PAGE[k] === p; })[0];
    return ((schema && schema.sections) || []).filter(function (s) { return s.id === id; })[0] || null;
  }

  function pref(k, d) { try { var v = localStorage.getItem('lain.' + k); return v == null ? d : v; } catch (e) { return d; } }
  function applyPrefs() {
    // DENSITY IS CORE'S (appearance.density); the editor size stays per machine.
    var ui = L.appearance && L.appearance.get();
    document.body.classList.toggle('compact', Boolean(ui && ui.density === 'compact'));
    document.documentElement.style.setProperty('--editor-size', pref('editorSize', '13') + 'px');
  }

  async function loadSchema() {
    loading = true;
    try { var r = await L.api('/api/settings'); if (r && r.ok) schema = r; else L.toast((r && r.why) || 'could not read settings', true); } catch (e) { /* shown as missing */ }
    loading = false;
    draw();
  }
  async function loadTools() {
    if (toolsLoading) return tools;
    toolsLoading = true;
    try {
      var m = await L.api('/api/mcp/servers', {});
      var k = await L.api('/api/skills', {});
      tools = { servers: (m && m.servers) || [], skills: k || { supported: false, skills: [] }, at: Date.now() };
    } catch (e) { /* the page says it could not read */ }
    toolsLoading = false;
    draw();
    return tools;
  }

  async function write(key, value) {
    var r = await L.api('/api/settings/update', { key: key, value: value });
    if (!r.ok) { L.toast(r.why, true); return false; }
    await loadSchema();
    return true;
  }
  async function act(key, action, arg) {
    var r = await L.api('/api/settings/action', { key: key, action: action, arg: arg || {} });
    if (!r.ok) { L.toast(r.why, true); return false; }
    await loadSchema();
    return true;
  }

  function field(pane, label, desc, node) {
    var f = el('div', 'field');
    var l = el('div', '');
    l.appendChild(el('div', 'lbl', label));
    if (desc) l.appendChild(el('div', 'desc', desc));
    f.appendChild(l);
    f.appendChild(node);
    pane.appendChild(f);
  }

  /** ONE RENDERER PER FIELD TYPE. Unsupported or read-only fields say so. */
  function fieldNode(f) {
    if (!f.supported) { var n = el('span', 'val', f.why || 'not supported on this build'); n.style.color = 'var(--text-muted)'; return n; }
    if (f.type === 'boolean') {
      var t = el('button', 'toggle');
      t.setAttribute('aria-checked', String(Boolean(f.value)));
      t.setAttribute('role', 'switch');
      t.disabled = !f.editable;
      t.onclick = function () { write(f.key, !f.value); };
      return t;
    }
    if (f.key === 'connections.messaging') { var b = el('button', 'btn small', 'Open Assistant › Channels'); b.onclick = function () { L.nav.go('bot', { section: 'connections' }); }; return b; }
    if (f.key === 'connections.webModels') { var w = el('button', 'btn small', 'Open Model'); w.onclick = function () { L.nav.go('model', { section: 'accounts' }); }; return w; }
    if (f.type === 'info' || f.type === 'link') {
      if (f.value && typeof f.value === 'object' && f.value.state) return el('span', 'val', String(f.value.state).toLowerCase().replace(/_/g, ' ') + (f.value.authorizedTabCount ? ' · ' + f.value.authorizedTabCount + ' tabs' : ''));
      return el('span', 'val', typeof f.value === 'string' ? f.value : (f.value == null ? '' : JSON.stringify(f.value)));
    }
    if (f.type === 'list') {
      var box = el('div', '');
      box.style.minWidth = '260px';
      var label = function (it) { return it && typeof it === 'object' ? (it.label || it.path || it.name || it.id || [it.source, it.state].filter(Boolean).join(' · ')) : String(it); };
      (Array.isArray(f.value) ? f.value : []).forEach(function (it) {
        var row = el('div', 'userrow');
        row.appendChild(el('span', 'id', label(it)));
        if (f.editable !== false && f.actions && f.actions.indexOf('forget') >= 0) {
          var rm = el('button', 'btn small', 'Forget');
          rm.onclick = function () { act(f.key, 'forget', { path: it && typeof it === 'object' ? (it.path || it.id) : it }); };
          row.appendChild(rm);
        }
        box.appendChild(row);
      });
      if (!box.childNodes.length) box.appendChild(el('span', 'val', 'none'));
      return box;
    }
    if (f.type === 'model') return el('span', 'val', f.value && (f.value.modelId || f.value.source) ? [f.value.source, f.value.modelId].filter(Boolean).join(' · ') : 'not set');
    var wrap = el('div', '');
    wrap.style.cssText = 'display:flex;gap:8px;align-items:center';
    wrap.appendChild(el('span', 'val', f.value == null || f.value === '' ? '(not set)' : String(f.value)));
    if (f.editable) {
      var ch = el('button', 'btn small', 'Change');
      ch.onclick = async function () {
        var fields = [{ key: 'v', label: f.label, value: f.value == null ? '' : String(f.value) }];
        if (f.type === 'directory') fields[0].action = { label: 'Choose…', run: function () { return L.ide.pickFolder(f.label); } };
        var v = await L.dialog({ title: f.label, fields: fields, ok: 'Save' });
        if (!v) return;
        if (f.type === 'integer') {
          var num = Number(v.v);
          if (!Number.isFinite(num)) return L.toast('enter a number', true);
          write(f.key, num);
        } else write(f.key, v.v);
      };
      wrap.appendChild(ch);
    }
    return wrap;
  }

  function core(pane, p, title, sub) {
    pane.appendChild(el('h2', '', title));
    if (sub) pane.appendChild(el('div', 'sub', sub));
    var sec = coreSection(p);
    if (!sec) { pane.appendChild(el('div', 'missing', loading || !schema ? 'Reading settings…' : 'Nothing in this section.')); return; }
    // A FIELD'S `group` (General › Startup) gets a titled block of its own; ungrouped fields share the first one.
    var box = null, cur;
    sec.fields.forEach(function (f) {
      if (!box || (f.group || '') !== cur) {
        cur = f.group || '';
        box = el('div', cur ? 'fields u-group' : 'fields');
        if (cur) { box.setAttribute('data-group', cur); box.appendChild(el('h4', '', cur)); }
        pane.appendChild(box);
      }
      field(box, f.label, f.restartRequired ? 'takes effect after LAIN restarts' : (f.why || ''), fieldNode(f));
    });
  }

  function about(pane) {
    pane.appendChild(el('h2', '', 'About'));
    pane.appendChild(el('div', 'sub', 'LAIN — a persistent AI workspace.'));
    var box = el('div', 'fields');
    var S = L.state() || {};
    var e = S.environment || {};
    field(box, 'This window', 'Presentation only. LAIN Core owns every piece of state.', el('span', 'val', 'LAIN'));
    field(box, 'Environment', '', el('span', 'val', e.kind === 'vm' ? 'VM' : 'Host'));
    field(box, 'Browser for previews', '', el('span', 'val', e.browser ? (e.browser.owned ? 'LAIN-owned Chromium ' : 'Borrowed browser ') + (e.browser.version || '') : (e.why || 'none')));
    field(box, 'Windows integration', '"Open with LAIN" for development files and "Open folder in LAIN" — registered for this user, never as a default.', el('span', 'val', 'lain --register-open-with'));
    pane.appendChild(box);
  }

  // [id, label, icon, elsewhere?] — an `elsewhere` entry opens another room (it is still found here).
  var NAV = [
    ['Workspace', [['appearance', 'Appearance', 'palette'], ['keymap', 'Keymap', 'keyboard'], ['general', 'General', 'settings'], ['notifications', 'Notifications', 'bell']]],
    ['Assistant', [['assistant', 'Assistant', 'bot', function () { L.nav.go('bot', { section: 'identity' }); }], ['bots', 'Bots & Channels', 'link']]],
    ['Agent', [['agents', 'Agent Instructions', 'book']]],
    ['Tools', [['extensions', 'Extensions', 'grid'], ['mcpskills', 'MCP & Skills', 'mcp', function () { L.nav.go('mcp'); }], ['integrations', 'Integrations', 'link']]],
    ['Accounts', [['github', 'GitHub', 'github'], ['accounts', 'Models', 'layers', function () { L.nav.go('model', { section: 'accounts' }); }], ['router', 'Router Server', 'server']]],
    // THE PROFESSIONAL TOOLING (workbench/devsettings.js): its real state, from Core.
    ['Advanced', function () { return (window.LAIN && LAIN.devSettings) ? LAIN.devSettings.PAGES.filter(function (p) { return p[0] !== 'extensions'; }) : []; }],
    ['System', [['privacy', 'Security', 'shield'], ['storage', 'Storage', 'folder'], ['about', 'About', 'home']]],
  ];
  function nav() {
    var box = $('settingsNav');
    box.textContent = '';
    NAV.forEach(function (g) {
      box.appendChild(el('h5', '', g[0]));
      (typeof g[1] === 'function' ? g[1]() : g[1]).forEach(function (it) {
        var b = el('button', 'snav');
        b.appendChild(L.icon(it[2], 15));
        b.appendChild(el('span', '', it[1]));
        b.setAttribute('aria-selected', String(page === it[0]));
        b.setAttribute('data-set', it[0]);
        if (it[3]) b.appendChild(el('span', 'go', '→'));
        b.onclick = it[3] ? it[3] : function () { page = it[0]; if (L.devSettings) L.devSettings.invalidate(page); if (page === 'github' && L.github) L.github.refresh(); draw(); };
        box.appendChild(b);
      });
    });
  }

  function draw() {
    if (L.nav.tab() !== 'settings') return;
    nav();
    var pane = $('settingsPane');
    var keep = pane.scrollTop;
    pane.textContent = '';
    if (page === 'general') core(pane, 'general', 'General', 'How LAIN runs on this machine.');
    else if (page === 'notifications') core(pane, 'notifications', 'Notifications', 'When LAIN may interrupt you. Only meaningful endings notify, and never while the window is in front.');
    else if (page === 'storage') { core(pane, 'storage', 'Storage', 'Where LAIN keeps projects, sessions and settings — and what it can clear.'); if (L.cacheCare) L.cacheCare.draw(pane); }
    else if (page === 'privacy') core(pane, 'privacy', 'Security', 'Folders LAIN may work in.');
    else if (page === 'integrations') core(pane, 'integrations', 'Integrations', 'Browser extension and account connections.');
    else if (L.prefs && L.prefs.draw(page, pane)) { /* appearance · keymap · agents: settings/prefs.js */ }
    else if (L.routerPrefs && L.routerPrefs.draw(page, pane)) { /* router server · bots & channels: settings/router.js */ }
    else if (page === 'github' && L.github) L.github.page(pane);
    else if (page === 'feedback' && L.feedback) L.feedback.page(pane);
    else if (L.devSettings && L.devSettings.draw(page, pane)) { /* workbench/devsettings.js */ }
    else about(pane);
    pane.scrollTop = keep;
  }

  L.settings = { pageOf: pageOf, draw: draw };
  L.tools = { load: loadTools, get: function () { return tools; } };

  L.onBoot(function () {
    applyPrefs();
    if (L.appearance) L.appearance.onChange(applyPrefs);
    L.nav.onShow('settings', function (o) {
      if (o && o.section) {
        var s = String(o.section).toLowerCase();
        if (/^(mcp|skills?)$/.test(s)) { L.nav.go('mcp', { section: s === 'mcp' ? 'mcp' : 'skills' }); return; }
        if (s === 'feedback') { if (L.feedback) L.feedback.open(); }
        page = /^(appearance|keymap|agents|github|router|bots)$/.test(s) ? s : /^(shortcuts|keys?)$/.test(s) ? 'keymap' : /server|serve/.test(s) ? 'router' : /bot/.test(s) ? 'bots' : /agents?\.md|instruction/.test(s) ? 'agents' : /^ext/.test(s) ? 'extensions' : /lsp|language/.test(s) ? 'servers' : /runtime|process/.test(s) ? 'runtime' : /focus/.test(s) ? 'focus' : /debug/.test(s) ? 'debugging'
          : /notif/.test(s) ? 'notifications' : /priv|trust|secur/.test(s) ? 'privacy'
            : /path|stor|folder/.test(s) ? 'storage' : /integr|chrome|connect/.test(s) ? 'integrations' : /appear|theme|palette/.test(s) ? 'appearance' : /editor/.test(s) ? 'appearance' : /about/.test(s) ? 'about' : 'general';
      }
      if (!schema && !loading) loadSchema();
      draw();
    });
  });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
