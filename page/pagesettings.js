'use strict';

/**
 * SETTINGS — the application's configuration, and the tools behind it.
 *
 * ------------------------------------------------------------------------
 * CORE'S SCHEMA, DRAWN. Sections and fields come from GET /api/settings
 * (src/settings.js); this file knows how to draw six field TYPES and calls the
 * two write routes. It never hard-codes a setting key or invents a control.
 *
 * WHERE EACH CORE SECTION LIVES IN THE WINDOW:
 *   GENERAL → General   NOTIFICATIONS → Notifications   PATHS → Storage
 *   PRIVACY → Privacy   CONNECTIONS → Integrations
 *   MODELS  → the Model view (model configuration is not buried here)
 *   messaging channels → the Bot view
 *
 * ------------------------------------------------------------------------
 * TOOLS: MCP AND SKILLS. `LAIN.tools` is the one client copy of
 * POST /api/mcp/servers and POST /api/skills; Home's search reads it too.
 * Server state is what Core reports (mcp.js, computermcp.js). Skills report
 * what the skill loader has — which in this build is none, and says so.
 *
 * Appearance, Editor and Shortcuts are frontend preferences, per machine,
 * kept in localStorage: losing one costs a re-click, nothing more.
 */

const HTML = `
<section class="view setv split" id="vSettings" data-view="settings" hidden>
  <nav class="snav-col" id="settingsNav"></nav>
  <div class="spane" id="settingsPane"></div>
</section>`;

const CSS = `
.mcpcard{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin-bottom:10px;max-width:820px}
.mcpcard .mh{display:grid;grid-template-columns:28px minmax(0,1fr) auto auto;gap:12px;align-items:center;width:100%;text-align:left;padding:12px 16px}
.mcpcard .mh .ci{color:var(--accent)}
.mcpcard .mh b{font-size:13.5px}
.mcpcard .mh small{display:block;color:var(--faint);font-size:11.5px;margin-top:1px}
.mcpcard .mb2{padding:0 16px 14px 56px}
.mcpcard dl{display:grid;grid-template-columns:130px 1fr;gap:4px 12px;font-size:12.5px;margin:0 0 10px}
.mcpcard dt{color:var(--faint)} .mcpcard dd{margin:0;overflow-wrap:anywhere}
.kbrow{display:grid;grid-template-columns:1fr 180px;gap:12px;padding:8px 0;border-top:1px solid var(--line);font-size:13px;max-width:640px}
.kbrow:first-of-type{border-top:0}
.kbrow kbd{font:11.5px var(--sans);color:var(--dim);background:var(--surface);border:1px solid var(--line2);border-radius:4px;padding:1px 7px;justify-self:end}
.seg{display:flex;gap:2px;background:var(--surface);border-radius:var(--radius-s);padding:2px}
.seg button{padding:3px 10px;border-radius:3px;font-size:12px;color:var(--dim)}
.seg button[aria-selected=true]{background:var(--raise);color:var(--ink)}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var page = 'general';
  var openItem = null;
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
  function setPref(k, v) { try { localStorage.setItem('lain.' + k, v); } catch (e) { /* private window */ } }
  function applyPrefs() {
    document.body.classList.toggle('compact', pref('density', 'comfortable') === 'compact');
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
    if (!f.supported) { var n = el('span', 'val', f.why || 'not supported on this build'); n.style.color = 'var(--faint)'; return n; }
    if (f.type === 'boolean') {
      var t = el('button', 'toggle');
      t.setAttribute('aria-checked', String(Boolean(f.value)));
      t.setAttribute('role', 'switch');
      t.disabled = !f.editable;
      t.onclick = function () { write(f.key, !f.value); };
      return t;
    }
    if (f.key === 'connections.messaging') { var b = el('button', 'btn small', 'Open Bot › Connections'); b.onclick = function () { L.nav.go('bot', { section: 'connections' }); }; return b; }
    if (f.key === 'connections.webModels') { var w = el('button', 'btn small', 'Open Model › Website accounts'); w.onclick = function () { L.nav.go('model', { section: 'accounts' }); }; return w; }
    if (f.type === 'info' || f.type === 'link') {
      if (f.value && typeof f.value === 'object' && f.value.state) return el('span', 'val', String(f.value.state).toLowerCase().replace(/_/g, ' ') + (f.value.authorizedTabCount ? ' · ' + f.value.authorizedTabCount + ' tabs' : ''));
      return el('span', 'val', typeof f.value === 'string' ? f.value : (f.value == null ? '' : JSON.stringify(f.value)));
    }
    if (f.type === 'list') {
      var box = el('div', '');
      box.style.minWidth = '280px';
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
    var box = el('div', 'fields');
    sec.fields.forEach(function (f) { field(box, f.label, f.restartRequired ? 'takes effect after LAIN restarts' : (f.why || ''), fieldNode(f)); });
    pane.appendChild(box);
  }

  function appearance(pane) {
    pane.appendChild(el('h2', '', 'Appearance'));
    pane.appendChild(el('div', 'sub', 'LAIN draws one theme: dark graphite with a single accent.'));
    var box = el('div', 'fields');
    field(box, 'Theme', 'The only theme LAIN draws.', el('span', 'val', 'LAIN Dark'));
    var seg = el('div', 'seg');
    ['comfortable', 'compact'].forEach(function (d) {
      var b = el('button', '', d.charAt(0).toUpperCase() + d.slice(1));
      b.setAttribute('aria-selected', String(pref('density', 'comfortable') === d));
      b.onclick = function () { setPref('density', d); applyPrefs(); draw(); };
      seg.appendChild(b);
    });
    field(box, 'Density', 'Row and padding spacing in lists.', seg);
    pane.appendChild(box);
  }
  function editor(pane) {
    pane.appendChild(el('h2', '', 'Editor'));
    pane.appendChild(el('div', 'sub', 'How the IDE editor draws code on this machine.'));
    var box = el('div', 'fields');
    var seg = el('div', 'seg');
    ['12', '13', '14', '15', '16'].forEach(function (n) {
      var b = el('button', '', n);
      b.setAttribute('aria-selected', String(pref('editorSize', '13') === n));
      b.onclick = function () { setPref('editorSize', n); applyPrefs(); draw(); };
      seg.appendChild(b);
    });
    field(box, 'Font size', 'Cascadia Code, then Consolas.', seg);
    field(box, 'Unsaved edits', 'A file LAIN changes on disk while you have unsaved edits is never overwritten; the editor says so and waits.', el('span', 'val', 'Always protected'));
    // AN IMPORTED PROFILE WINS OVER THE SIZE ABOVE (it is applied after), so say so.
    var cur = L.profile && L.profile.current && L.profile.current();
    var imp = cur && cur.profile && cur.profile.importedFrom;
    var go = el('button', 'btn small', 'Open Extensions');
    go.onclick = function () { L.nav.go('ide'); setTimeout(function () { L.ide.showPane('extensions', true); }, 0); };
    field(box, 'VS Code / Cursor', imp
      ? 'Imported from ' + imp.label + ' on ' + new Date(imp.at).toLocaleString() + ': ' + imp.settings + ' settings, ' + imp.keybindings + ' keybindings, ' + imp.snippets + ' snippets. Imported settings take precedence over the size above.'
      : 'Import editor settings, keybindings and snippets from VS Code or Cursor in the IDE’s Extensions pane. Their files are only read.', go);
    pane.appendChild(box);
  }
  function shortcuts(pane) {
    pane.appendChild(el('h2', '', 'Shortcuts'));
    pane.appendChild(el('div', 'sub', 'Familiar keys. The IDE keeps the editor conventions people already know.'));
    [['Search LAIN', 'Ctrl+K'], ['Command palette', 'Ctrl+Shift+P'], ['Switch to Home … Settings', 'Alt+1 … Alt+7'], ['New Project', 'Ctrl+Shift+N'], ['Open Project', 'Ctrl+O'],
      ['Open file (IDE)', 'Ctrl+P'], ['Save', 'Ctrl+S'], ['Find in file', 'Ctrl+F'], ['Close editor', 'Ctrl+W'], ['Toggle explorer', 'Ctrl+B'], ['Toggle panel', 'Ctrl+J'], ['Terminal', 'Ctrl+`'],
      ['Explorer / Search files', 'Ctrl+Shift+E / Ctrl+Shift+F'], ['Toggle BOT panel', 'Ctrl+Alt+B'], ['Send message', 'Enter'], ['New line in a message', 'Shift+Enter']].forEach(function (k) {
      var r = el('div', 'kbrow');
      r.appendChild(el('span', '', k[0]));
      r.appendChild(el('kbd', '', k[1]));
      pane.appendChild(r);
    });
  }

  function mcp(pane) {
    pane.appendChild(el('h2', '', 'MCP'));
    pane.appendChild(el('div', 'sub', 'Model Context Protocol servers LAIN can use. The BOT and the Coding Agent are offered a server’s tools only while it is connected, and every action still passes LAIN’s permission gate.'));
    if (!tools) { pane.appendChild(el('div', 'missing', toolsLoading ? 'Reading servers…' : 'Not read yet.')); return; }
    tools.servers.forEach(function (s) {
      var card = el('div', 'mcpcard');
      var h = el('button', 'mh');
      var ci = el('span', 'ci'); ci.appendChild(L.icon('plug', 18)); h.appendChild(ci);
      var n = el('span', ''); n.appendChild(el('b', '', s.name + (s.builtIn ? ' (built in)' : '')));
      n.appendChild(el('small', '', (s.tools && s.tools.length ? s.tools.length + ' tools · ' : '') + (s.usedBy && s.usedBy.length ? 'used by ' + s.usedBy.join(', ') : s.why || '')));
      h.appendChild(n);
      var cls = s.state === 'CONNECTED' || s.state === 'ACTIVE_BRIDGE' ? 'ok' : s.state === 'DISABLED' ? '' : 'warn';
      var st = el('span', 'pstate ' + cls); st.appendChild(el('span', 'sdot', '●')); st.appendChild(el('span', '', s.state.toLowerCase().replace(/_/g, ' ')));
      h.appendChild(st);
      h.appendChild(L.icon(openItem === s.id ? 'down' : 'chevron', 14));
      h.onclick = function () { openItem = openItem === s.id ? null : s.id; draw(); };
      card.appendChild(h);
      if (openItem === s.id) {
        var body = el('div', 'mb2');
        var dl = el('dl');
        var put = function (k, v) { if (!v) return; dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); };
        put('Status', s.state.toLowerCase().replace(/_/g, ' ') + (s.why ? ' — ' + s.why : ''));
        put('Transport', s.transport);
        put('Program', s.command || (s.builtIn ? 'LAIN’s own Computer MCP bridge' : ''));
        put('Enabled', s.enabled ? 'yes' : 'no');
        if (s.builtIn) put('Authorized', s.authorized ? 'yes — an active grant' : 'no active grant; LAIN asks before using the computer');
        put('Scope', 'This machine. One desktop bridge is connected at a time.');
        put('Used by', (s.usedBy || []).join(', ') || 'nothing while it is not connected');
        body.appendChild(dl);
        if (s.tools && s.tools.length) {
          var tl = el('div', 'mlist');
          s.tools.forEach(function (t) { tl.appendChild(el('span', 'mchip', t)); });
          body.appendChild(tl);
        } else body.appendChild(el('div', 'missing', 'Tools are listed once the server is connected and has said what it offers.'));
        card.appendChild(body);
      }
      pane.appendChild(card);
    });
    pane.appendChild(el('div', 'missing', 'Servers are declared under "mcp.servers" in LAIN’s config.json; each runs as a process that inherits no environment unless the config gives it one.'));
    var rf = el('button', 'btn small', toolsLoading ? 'Reading…' : 'Refresh');
    rf.onclick = loadTools;
    pane.appendChild(rf);
  }
  function skills(pane) {
    pane.appendChild(el('h2', '', 'Skills'));
    pane.appendChild(el('div', 'sub', 'Packaged instructions and tools the BOT can load for a kind of task.'));
    if (!tools) { pane.appendChild(el('div', 'missing', toolsLoading ? 'Reading…' : 'Not read yet.')); return; }
    var k = tools.skills || {};
    if (!k.supported) { pane.appendChild(el('div', 'missing', 'No skills are installed: ' + (k.why || 'this build has no skill loader') + '.')); return; }
    (k.skills || []).forEach(function (s) { pane.appendChild(el('div', 'field', s.name || s.id)); });
  }
  function about(pane) {
    pane.appendChild(el('h2', '', 'About'));
    pane.appendChild(el('div', 'sub', 'LAIN — a persistent AI workspace.'));
    var box = el('div', 'fields');
    var S = L.state() || {};
    var e = S.environment || {};
    field(box, 'Harness', 'This window: presentation only. LAIN Core owns every piece of state.', el('span', 'val', 'LAIN Harness 2.0'));
    field(box, 'Environment', '', el('span', 'val', e.kind === 'vm' ? 'VM' : 'Host'));
    field(box, 'Browser for previews', '', el('span', 'val', e.browser ? (e.browser.owned ? 'LAIN-owned Chromium ' : 'Borrowed browser ') + (e.browser.version || '') : (e.why || 'none')));
    pane.appendChild(box);
  }

  var NAV = [
    ['App', [['general', 'General', 'settings'], ['appearance', 'Appearance', 'spark'], ['editor', 'Editor', 'ide'], ['shortcuts', 'Shortcuts', 'arrow'], ['notifications', 'Notifications', 'ask']]],
    ['Tools', [['skills', 'Skills', 'spark'], ['mcp', 'MCP', 'plug'], ['integrations', 'Integrations', 'link']]],
    // THE PROFESSIONAL TOOLING (pagedevsettings.js): its real state, from Core.
    ['Development', function () { return (window.LAIN && LAIN.devSettings) ? LAIN.devSettings.PAGES : []; }],
    ['System', [['storage', 'Storage', 'folder'], ['privacy', 'Privacy', 'shield'], ['about', 'About', 'home']]],
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
        if (it[0] === 'mcp' && tools) b.appendChild(el('span', 'sv', String(tools.servers.length)));
        b.setAttribute('aria-selected', String(page === it[0]));
        b.onclick = function () { page = it[0]; openItem = null; if (L.devSettings) L.devSettings.invalidate(page); draw(); };
        box.appendChild(b);
      });
    });
    var mb = el('button', 'snav');
    mb.appendChild(L.icon('model', 15));
    mb.appendChild(el('span', '', 'Models → Model'));
    mb.onclick = function () { L.nav.go('model'); };
    box.appendChild(el('h5', '', 'Elsewhere'));
    box.appendChild(mb);
    var bb = el('button', 'snav');
    bb.appendChild(L.icon('bot', 15));
    bb.appendChild(el('span', '', 'Channels → Bot'));
    bb.onclick = function () { L.nav.go('bot', { section: 'connections' }); };
    box.appendChild(bb);
  }

  function draw() {
    if (L.nav.tab() !== 'settings') return;
    nav();
    var pane = $('settingsPane');
    var keep = pane.scrollTop;
    pane.textContent = '';
    if (page === 'general') core(pane, 'general', 'General', 'How LAIN runs on this machine.');
    else if (page === 'notifications') core(pane, 'notifications', 'Notifications', 'When LAIN may interrupt you. Only meaningful endings notify, and never while the window is in front.');
    else if (page === 'storage') core(pane, 'storage', 'Storage', 'Where LAIN keeps projects, sessions and settings.');
    else if (page === 'privacy') core(pane, 'privacy', 'Privacy', 'Folders LAIN may work in.');
    else if (page === 'integrations') core(pane, 'integrations', 'Integrations', 'Browser extension and account connections.');
    else if (page === 'appearance') appearance(pane);
    else if (page === 'editor') editor(pane);
    else if (page === 'shortcuts') shortcuts(pane);
    else if (page === 'mcp') mcp(pane);
    else if (page === 'skills') skills(pane);
    else if (L.devSettings && L.devSettings.draw(page, pane)) { /* drawn by pagedevsettings.js */ }
    else about(pane);
    pane.scrollTop = keep;
  }

  L.settings = { pageOf: pageOf, draw: draw };
  L.tools = { load: loadTools, get: function () { return tools; } };

  L.onBoot(function () {
    applyPrefs();
    L.nav.onShow('settings', function (o) {
      if (o && o.section) {
        var s = String(o.section).toLowerCase();
        page = /^ext/.test(s) ? 'extensions' : /lsp|language/.test(s) ? 'servers' : /runtime|process/.test(s) ? 'runtime' : /focus/.test(s) ? 'focus' : /debug/.test(s) ? 'debugging'
          : /mcp/.test(s) ? 'mcp' : /skill/.test(s) ? 'skills' : /short|key/.test(s) ? 'shortcuts' : /notif/.test(s) ? 'notifications' : /priv|trust|secur/.test(s) ? 'privacy'
          : /path|stor|folder/.test(s) ? 'storage' : /integr|chrome|connect/.test(s) ? 'integrations' : /appear|theme/.test(s) ? 'appearance' : /editor/.test(s) ? 'editor' : /about/.test(s) ? 'about' : 'general';
        openItem = o.item || null;
      }
      if (!schema && !loading) loadSchema();
      if (!tools && !toolsLoading && (page === 'mcp' || page === 'skills')) loadTools();
      draw();
    });
  });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
