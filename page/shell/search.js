'use strict';

/**
 * ONE SEARCH OVER EVERYTHING LAIN KNOWS — the Ctrl K palette, and the index
 * Home's search box shares (`L.search`).
 *
 * THE INDEX IS WHAT ALREADY HAS AN OWNER:
 *
 *   rooms, commands           this file (static), the IDE's commands, the editor's
 *                             actions, running extensions' commands, Core's doors
 *   settings and their fields GET /api/settings (Core's schema)
 *   MCP servers, skills       L.tools
 *   providers, accounts,      L.intel (POST /api/intel/families) — the one fabric;
 *   quota windows, models     models by name through POST /api/intel/search
 *   assistant, channels       L.assistant, L.bot
 *   projects                  POST /api/project/recent
 *   sessions                  L.sessions
 *   files                     POST /api/files/find, when a project is open
 *
 * Every result opens its owner's surface. The last row is always "Ask LAIN".
 */

const HTML = `
<div class="palette-back" id="palette" hidden>
  <div class="palette" role="dialog" aria-label="Search LAIN">
    <input id="paletteQ" placeholder="Search LAIN, or type > for commands" autocomplete="off" spellcheck="false">
    <div class="presults" id="presults"></div>
  </div>
</div>`;

const CSS = `
.rgroup{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);padding:8px 10px 3px}
.res{display:flex;align-items:center;gap:10px;width:100%;padding:6px 10px;border-radius:var(--radius-sm);text-align:left;font-size:13px;color:var(--text-primary)}
.res .rp{color:var(--text-muted);font-size:11.5px;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}
.res .ri{color:var(--text-muted);display:flex;flex:none}
.res .rt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.res[aria-selected=true],.res:hover{background:var(--selection)}
.res[aria-selected=true] .ri{color:var(--accent-primary)}
.palette-back{position:fixed;inset:0;z-index:60;background:color-mix(in srgb,var(--canvas) 60%,transparent);display:flex;justify-content:center;align-items:flex-start;padding-top:12vh}
.palette{width:min(620px,calc(100vw - 32px));background:var(--surface-raised);border-radius:var(--radius-md);box-shadow:var(--shadow-float),0 0 0 1px var(--border-subtle);overflow:hidden}
.palette input{padding:12px 16px;font-size:14px;border-bottom:1px solid var(--separator)}
.presults{max-height:52vh;overflow-y:auto;padding:4px}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var recent = null;
  var settingsSchema = null;
  var fileHits = { q: null, rows: [] };
  var modelHits = { q: null, rows: [] };

  // ---- scoring: every query word must begin a word in the haystack ---------------------------------------
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim(); }
  function score(q, hay) {
    var qs = norm(q).split(' ').filter(Boolean);
    if (!qs.length) return 0;
    var words = norm(hay).split(' ');
    var joined = norm(hay).replace(/ /g, '');
    var total = 0;
    for (var i = 0; i < qs.length; i++) {
      var w = qs[i], best = 0;
      for (var j = 0; j < words.length; j++) {
        if (words[j] === w) { best = Math.max(best, 3); } else if (words[j].indexOf(w) === 0) best = Math.max(best, 2);
      }
      if (!best && joined.indexOf(w) >= 0) best = 1;
      if (!best) return 0;
      total += best;
    }
    return total;
  }

  var ROOMS = [
    ['home', 'Home', 'launcher search start'], ['ide', 'IDE', 'editor code project explorer files terminal'],
    ['chat', 'Chat', 'conversation research plan discuss coding agent'], ['model', 'Model', 'providers accounts oauth api quota models defaults local'],
    ['usage', 'Usage', 'tokens cost limits quota cache consumption'], ['mcp', 'MCP & Skills', 'servers tools skills integrations'],
    ['settings', 'Settings', 'preferences appearance editor notifications privacy'],
    ['bot', 'Assistant', 'channels telegram discord whatsapp permissions reminders schedules'], ['session', 'Sessions', 'history previous work restore'],
  ];
  var SETTINGS_PAGES = [
    ['general', 'General'], ['appearance', 'Appearance', 'theme palette typography zoom density'], ['editor', 'Editor', 'font size tab'], ['shortcuts', 'Shortcuts', 'keyboard keys'],
    ['notifications', 'Notifications'], ['integrations', 'Integrations', 'chrome extension github'], ['storage', 'Storage', 'paths folders sessions'],
    ['privacy', 'Privacy', 'trusted folders security'], ['extensions', 'Extensions', 'vscode extension host'], ['servers', 'Language Servers', 'lsp typescript pyright rust'],
    ['runtime', 'Runtime Processes', 'processes owned supervisor'], ['debugging', 'Debugging', 'debugger dap adapter'], ['about', 'About'],
  ];

  function commands() {
    return [
      { title: 'New Project', sub: 'IDE', icon: 'plus', kw: 'create folder workspace', run: function () { L.ide.newProject(); } },
      { title: 'Open Project', sub: 'IDE', icon: 'folder', kw: 'folder workspace', run: function () { L.ide.openProject(); } },
      { title: 'New Chat', sub: 'Chat', icon: 'chat', kw: 'conversation', run: function () { L.chat.newChat(); } },
      { title: 'Accounts', sub: 'Model', icon: 'model', kw: 'providers accounts policy fallback quota codex claude antigravity', run: function () { L.nav.go('model', { section: 'accounts' }); } },
      { title: 'Add account', sub: 'Model › Accounts', icon: 'link', kw: 'sign in oauth codex claude connect', run: function () { L.nav.go('model', { section: 'connect' }); } },
      { title: 'Import accounts', sub: 'Model › Setup', icon: 'link', kw: 'migrate router import', run: function () { L.nav.go('model', { section: 'import' }); } },
      { title: 'Add API key', sub: 'Model › API', icon: 'plus', kw: 'api key credential openai anthropic deepseek z.ai zai glm', run: function () { L.nav.go('model', { section: 'api' }); } },
      { title: 'Refresh quota', sub: 'Model', icon: 'refresh', kw: 'reload quota limits windows', run: function () { L.api('/api/intel/refresh', {}).then(function () { if (L.intel) L.intel.load(true); L.toast('Quota refreshed'); }); } },
      { title: 'Connect Telegram', sub: 'Settings › Assistant', icon: 'link', kw: 'bot token channel', run: function () { L.nav.go('bot', { section: 'connections' }); } },
      { title: 'Open File', sub: 'IDE · Ctrl+P', icon: 'files', kw: 'quick open', run: function () { L.nav.go('ide'); L.ide.quickOpen(); } },
      { title: 'Toggle Terminal', sub: 'IDE · Ctrl+`', icon: 'terminal', kw: 'shell console', run: function () { L.nav.go('ide'); L.ide.showPanel('TERMINAL'); } },
      { title: 'Keyboard shortcuts', sub: 'Settings', icon: 'keyboard', kw: 'keys', run: function () { L.nav.go('settings', { section: 'shortcuts' }); } },
    ].concat(ideCommands(), viewCommands(), lainCommands(), editorCommands(), extensionCommands());
  }

  // ---- THE IDE'S OWN COMMANDS ------------------------------------------------------------------------------
  function ideCommands() {
    var ide = function (f) { return function () { L.nav.go('ide'); setTimeout(f, 0); }; };
    var pane = function (p) { return ide(function () { L.ide.showPane(p, true); }); };
    var panel = function (p) { return ide(function () { L.ide.showPanel(p); }); };
    return [
      { title: 'LAIN: Open Preview', sub: 'Preview · Ctrl+Shift+V', icon: 'preview', kw: 'workshop dev server browser page run', run: function () { if (L.preview) L.preview.open(); } },
      { title: 'LAIN: Configure Preview…', sub: 'Preview', icon: 'preview', kw: 'dev server command port workshop', run: ide(function () { if (L.preview) L.preview.configure(); }) },
      { title: 'File: New File…', sub: 'IDE', icon: 'plus', kw: 'create', run: ide(function () { if (L.editor) L.editor.newFile(''); }) },
      { title: 'File: New Folder…', sub: 'IDE', icon: 'folder', kw: 'create directory', run: ide(function () { if (L.editor) L.editor.newFolder(''); }) },
      { title: 'File: Save', sub: 'IDE · Ctrl+S', icon: 'check', kw: 'write', run: ide(function () { L.source.save(false); }) },
      { title: 'File: Close Editor', sub: 'IDE · Ctrl+W', icon: 'close', kw: 'tab', run: ide(function () { L.source.closeActive(); }) },
      { title: 'File: Close All Editors', sub: 'IDE', icon: 'close', kw: 'tabs', run: ide(function () { L.source.closeMany(function () { return true; }); }) },
      { title: 'View: Explorer', sub: 'IDE · Ctrl+Shift+E', icon: 'files', kw: 'files tree', run: pane('explorer') },
      { title: 'View: Search', sub: 'IDE · Ctrl+Shift+F', icon: 'search', kw: 'find in files', run: pane('search') },
      { title: 'View: Source Control', sub: 'IDE · Ctrl+Shift+G', icon: 'changes', kw: 'git scm commit diff', run: pane('scm') },
      { title: 'View: Run and Debug', sub: 'IDE · Ctrl+Shift+D', icon: 'play', kw: 'debugger launch breakpoints', run: pane('run') },
      { title: 'View: Extensions', sub: 'IDE · Ctrl+Shift+X', icon: 'ext', kw: 'plugins', run: pane('extensions') },
      { title: 'View: Toggle Panel', sub: 'IDE · Ctrl+J', icon: 'panel', kw: 'bottom problems output terminal', run: ide(function () { L.ide.togglePanel(); }) },
      { title: 'View: Problems', sub: 'IDE · Ctrl+Shift+M', icon: 'warn', kw: 'diagnostics errors warnings', run: panel('PROBLEMS') },
      { title: 'View: Output', sub: 'IDE', icon: 'terminal2', kw: 'logs tasks dev server', run: panel('OUTPUT') },
      { title: 'View: Debug Console', sub: 'IDE', icon: 'terminal2', kw: 'debugger repl evaluate', run: panel('DEBUG') },
      { title: 'Terminal: New Terminal', sub: 'IDE · Ctrl+`', icon: 'terminal', kw: 'shell console', run: panel('TERMINAL') },
      { title: 'Git: Open Source Control', sub: 'IDE', icon: 'changes', kw: 'commit stage diff branch', run: pane('scm') },
      { title: 'Debug: Start Debugging', sub: 'IDE · F5', icon: 'play', kw: 'run launch', run: ide(function () { L.ide.showPane('run', true); L.ide.showPanel('DEBUG'); if (L.debug && L.debug.start) L.debug.start(); }) },
      { title: 'Coding Agent: Show / Hide Sidecar', sub: 'IDE · Ctrl+Alt+B', icon: 'code', kw: 'agent panel', run: ide(function () { L.ide.toggleBot(); }) },
      { title: 'Coding Agent: Open Full Coding Chat', sub: 'Chat', icon: 'spark', kw: 'agent conversation wide full', run: function () { if (L.chat && L.chat.openCoding) L.chat.openCoding(); else L.nav.go('chat'); } },
      { title: 'Route: Choose Provider…', sub: 'Model', icon: 'user', kw: 'account oauth subscription codex claude antigravity switch provider', run: function () { if (L.intel) L.intel.pickProvider(routeAnchor(), L.intel.laneNow(), { prefer: 'below', alignRight: true }); } },
      { title: 'Route: Choose Model…', sub: 'Model', icon: 'spark', kw: 'model switch', run: function () { if (L.intel) L.intel.pickModel(routeAnchor(), L.intel.laneNow(), { prefer: 'below', alignRight: true }); } },
      { title: 'MCP & Skills: Open', sub: 'MCP & Skills', icon: 'mcp', kw: 'servers tools skills integrations', run: function () { L.nav.go('mcp'); } },
    ];
  }
  /** The route chip on screen: the IDE's, else the rail's. */
  /** Where a route chooser opens from: the composer's model pill in view, else the usage tracker. */
  function routeAnchor() {
    var pills = document.querySelectorAll('[data-route-pill]');
    for (var i = 0; i < pills.length; i++) if (pills[i].offsetParent) return pills[i];
    return $('tracker');
  }

  function viewCommands() {
    if (!L.groups) return [];
    var g = function (f) { return function () { L.nav.go('ide'); setTimeout(f, 0); }; };
    return [
      { title: 'View: Split Editor Right', sub: 'IDE · Ctrl+\\', icon: 'panel', kw: 'split group side by side', run: g(L.groups.splitRight) },
      { title: 'View: Split Editor Down', sub: 'IDE', icon: 'panel', kw: 'split group below', run: g(L.groups.splitDown) },
      { title: 'View: Move Editor into Next Group', sub: 'IDE', icon: 'panel', kw: 'move tab group', run: g(L.groups.moveToNext) },
      { title: 'View: Focus Next Editor Group', sub: 'IDE', icon: 'panel', kw: 'focus group', run: g(L.groups.focusNext) },
      { title: 'View: Close Editor Group', sub: 'IDE', icon: 'close', kw: 'close group split', run: g(L.groups.closeGroup) },
    ];
  }

  // ---- "LAIN:" — Core's house doors, the same ones the assistant walks through ----------------------------
  function currentFile() { var f = L.source && L.source.current && L.source.current(); return f ? f.path : null; }
  function showRead(title, r) { if (r && r.ok !== false && r.text != null) L.dialog({ title: title, pre: String(r.text), ok: 'Close', cancel: 'Copy' }).then(function (v) { if (v === false && navigator.clipboard) navigator.clipboard.writeText(String(r.text)).catch(function () {}); }); }
  function lainCommands() {
    var inv = function (id, args) { return L.house.invoke(id, args); };
    return [
      { title: 'LAIN: Ask About Selection', sub: 'Focus', icon: 'chat', kw: 'question explain selection this', run: function () { inv('focus.ask_bot'); } },
      { title: 'LAIN: Move to Agent', sub: 'Focus', icon: 'spark', kw: 'coding agent pane task', run: function () { inv('focus.move_to_agent'); } },
      { title: 'LAIN: Pick UI Element', sub: 'Focus · preview', icon: 'preview', kw: 'workshop select element visual picker', run: function () { inv('focus.pick_element'); } },
      { title: 'LAIN: Who Changed This?', sub: 'Focus · provenance', icon: 'files', kw: 'provenance who wrote lines blame user agent', run: function () {
        var p = currentFile();
        inv('changes.who', p ? { path: p } : {}).then(function (r) { showRead(p ? 'Who changed ' + p : 'Who changed what', r); });
      } },
      { title: 'LAIN: Open Task in Chat', sub: 'Chat · same session', icon: 'chat', kw: 'conversation task continue', run: function () { inv('chat.open'); } },
      { title: 'LAIN: Open in /focus', sub: 'IDE · same task', icon: 'ide', kw: 'focus workspace task files', run: function () { inv('ide.enter_focus'); } },
      { title: 'LAIN: Restart Language Server', sub: 'IDE', icon: 'refresh', kw: 'lsp typescript pyright rust analyzer restart', run: function () {
        var p = currentFile();
        if (!p) { L.toast('Open a file first — its language decides which server restarts.', true); return; }
        inv('lsp.restart', { path: p }).then(function (r) { if (r && r.ok !== false) L.toast(r.text || 'restarted'); });
      } },
      { title: 'LAIN: Reconcile Project', sub: 'Architecture vs disk', icon: 'check', kw: 'architecture drift missing damaged reconcile', run: function () { inv('project.reconcile').then(function (r) { showRead('Reconcile project', r); }); } },
    ];
  }

  function editorCommands() {
    var ed = L.editor && L.editor.editor && L.editor.editor();
    if (!ed || !ed.getSupportedActions || L.nav.tab() !== 'ide') return [];
    return ed.getSupportedActions().filter(function (a) { return a.label; }).slice(0, 400).map(function (a) {
      return { title: a.label, sub: 'Editor', icon: 'ide', kw: 'editor ' + a.id, run: function () { L.editor.focus(); a.run(); } };
    });
  }

  var extCmds = [];
  function refreshExtCommands() {
    L.api('/api/exthost/status', {}).then(function (r) {
      extCmds = [];
      ((r && r.extensions) || []).forEach(function (x) {
        if (x.state !== 'RUNNING') return;
        (x.commands || []).forEach(function (id) {
          extCmds.push({ title: (x.commandTitles && x.commandTitles[id]) || id, sub: 'Extension · ' + (x.name || x.id), icon: 'plug', kw: 'extension command ' + id,
            run: function () { L.api('/api/exthost/command', { id: id, args: [] }).then(function (o) { if (o && o.ok === false) L.toast(o.why, true); }); } });
        });
      });
    }, function () { extCmds = []; });
  }
  function extensionCommands() { return extCmds.slice(0, 200); }

  /** THE FABRIC: providers, their accounts, and the windows each reported — what remains, never inferred. */
  function fabricEntries(out) {
    var fams = (L.intel && L.intel.families()) || [];
    fams.forEach(function (f) {
      var where = f.kind === 'api' ? 'api' : f.kind === 'local' ? 'local' : 'accounts';
      out.push({ group: 'Model', title: f.label, sub: 'Model › ' + (where === 'api' ? 'API' : where === 'local' ? 'Local' : 'Accounts') + ' · ' + f.accounts.length + ' account' + (f.accounts.length === 1 ? '' : 's'), icon: 'model',
        kw: 'provider ' + f.id + ' ' + f.kind, run: function () { L.nav.go('model', { section: where, item: f.id }); } });
      f.accounts.forEach(function (a) {
        var w = a.quota && a.quota[0];
        var rem = w ? L.kit.remainingOf(w) : null;
        out.push({ group: 'Accounts', title: f.label + ' · ' + a.name, sub: 'Model › Accounts' + (rem != null ? ' · ' + L.kit.winLabel(w.label) + ' ' + rem + '% remaining' : ''), icon: 'user',
          kw: 'account ' + [a.id, a.name, f.label, a.identity && a.identity.email].join(' '), run: function () { L.nav.go('model', { section: 'accounts', item: f.id }); } });
        (a.quota || []).forEach(function (q) {
          var r = L.kit.remainingOf(q);
          out.push({ group: 'Usage', title: f.label + ' · ' + a.name + ' · ' + L.kit.winLabel(q.label), sub: 'Usage › Limits · ' + (r != null ? r + '% remaining' : 'not reported'), icon: 'usage',
            kw: 'quota limit window reset ' + f.id, run: function () { L.nav.go('usage', { section: 'windows' }); } });
        });
      });
    });
    modelHits.rows.forEach(function (m) {
      out.push({ group: 'Models', title: m.label, sub: 'Model › Models' + (m.familyLabel ? ' · ' + m.familyLabel : ''), icon: 'spark', kw: m.id, run: function () { L.nav.go('model', { section: 'models', item: m.id }); } });
    });
  }

  var extList = null, extLoading = false;
  function entries() {
    var out = [];
    ROOMS.forEach(function (s) { out.push({ group: 'Go to', title: s[1], sub: '', icon: s[0] === 'bot' ? 'bot' : s[0] === 'session' ? 'session' : s[0], kw: s[2], run: function () { L.nav.go(s[0]); } }); });
    SETTINGS_PAGES.forEach(function (p) { out.push({ group: 'Settings', title: 'Settings › ' + p[1], icon: 'settings', kw: p[1] + ' ' + (p[2] || ''), run: function () { L.nav.go('settings', { section: p[0] }); } }); });
    ((settingsSchema && settingsSchema.sections) || []).forEach(function (sec) {
      (sec.fields || []).forEach(function (f) {
        out.push({ group: 'Settings', title: f.label, sub: 'Settings › ' + sec.label, icon: 'settings', kw: sec.label + ' ' + f.key,
          run: function () { L.nav.go(sec.id === 'MODELS' ? 'model' : sec.id === 'CONNECTIONS' && f.key === 'connections.messaging' ? 'bot' : 'settings', { section: L.settings ? L.settings.pageOf(sec.id) : null }); } });
      });
    });
    var tools = L.tools ? L.tools.get() : null;
    ((tools && tools.servers) || []).forEach(function (m) {
      out.push({ group: 'MCP', title: m.name + ' MCP server', sub: 'MCP & Skills · ' + m.state.toLowerCase().replace(/_/g, ' '), icon: 'plug', kw: 'mcp server tools ' + m.id + ' ' + (m.tools || []).join(' '),
        run: function () { L.nav.go('mcp', { section: 'mcp', item: m.id }); } });
      (m.tools || []).slice(0, 40).forEach(function (t) { out.push({ group: 'MCP', title: t, sub: m.name + ' tool', icon: 'plug', kw: 'tool mcp', run: function () { L.nav.go('mcp', { section: 'mcp', item: m.id }); } }); });
    });
    out.push({ group: 'MCP', title: 'Skills', sub: 'MCP & Skills', icon: 'spark', kw: 'skill packages', run: function () { L.nav.go('mcp', { section: 'skills' }); } });
    fabricEntries(out);
    var bd = L.bot && L.bot.get ? L.bot.get() : null;
    ['Telegram', 'Discord', 'WhatsApp'].forEach(function (p) {
      var row = bd && (bd.platforms || []).filter(function (x) { return x.platform === p.toLowerCase(); })[0];
      var st = row ? (row.status || row.state || '').toLowerCase().replace(/_/g, ' ') : '';
      out.push({ group: 'Assistant', title: p, sub: 'Settings › Assistant' + (st ? ' · ' + st : ''), icon: 'bot', kw: 'channel messaging integration ' + st, run: function () { L.nav.go('bot', { section: 'connections' }); } });
    });
    [['overview', 'Usage overview'], ['tokens', 'Token usage by project, session, model, account'], ['windows', 'Provider limits'], ['cost', 'Cost'], ['efficiency', 'Context efficiency — cache']].forEach(function (u) {
      out.push({ group: 'Usage', title: u[1], sub: 'Usage', icon: 'usage', kw: 'usage consumption ' + u[0], run: function () { L.nav.go('usage', { section: u[0] }); } });
    });
    if (!extList && !extLoading) { extLoading = true; L.api('/api/extensions/list', {}).then(function (r) { extList = (r && r.ok && r.extensions) || []; extLoading = false; }, function () { extLoading = false; }); }
    (extList || []).forEach(function (e) {
      out.push({ group: 'Extensions', title: e.name, sub: 'IDE › Extensions · ' + e.id + ' ' + e.version + (e.enabled ? '' : ' · disabled'), icon: 'plug', kw: 'extension ' + e.id + ' ' + e.publisher, run: function () { L.nav.go('ide'); if (L.ide && L.ide.showPane) L.ide.showPane('extensions'); } });
    });
    if (L.assistant) L.assistant.searchEntries().forEach(function (e) { out.push(e); });
    ((recent && recent.recent) || []).forEach(function (p) {
      out.push({ group: 'Projects', title: p.name, sub: p.root, icon: 'folder', kw: p.root, run: function () { L.ide.open(p.root); } });
    });
    if (L.sessions) L.sessions.all().forEach(function (s) {
      out.push({ group: 'Sessions', title: s.title || '(untitled)', sub: [s.project, s.when].filter(Boolean).join(' · '), icon: 'session', kw: (s.project || '') + ' ' + (s.source || ''), run: function () { L.sessionView.open(s); } });
    });
    commands().forEach(function (c) { out.push(Object.assign({ group: 'Commands' }, c)); });
    fileHits.rows.forEach(function (f) { out.push({ group: 'Files', title: f.path.split('/').pop(), sub: f.path, icon: 'files', kw: f.path, run: function () { L.nav.go('ide'); L.source.openFile(f.path); } }); });
    return out;
  }

  var GROUP_ORDER = ['Go to', 'Commands', 'Assistant', 'Accounts', 'Usage', 'Settings', 'MCP', 'Model', 'Models', 'Extensions', 'Projects', 'Sessions', 'Files'];
  function search(q, onlyCommands) {
    var all = entries();
    if (onlyCommands) all = all.filter(function (e) { return e.group === 'Commands' || e.group === 'Go to'; });
    var rows = [];
    all.forEach(function (e) {
      var s = score(q, e.title + ' ' + (e.sub || '') + ' ' + (e.kw || ''));
      var t = score(q, e.title);
      if (s) rows.push({ e: e, s: s + t * 2 });
    });
    rows.sort(function (a, b) { return b.s - a.s; });
    var perGroup = {};
    rows = rows.filter(function (r) { perGroup[r.e.group] = (perGroup[r.e.group] || 0) + 1; return perGroup[r.e.group] <= (r.e.group === 'Models' ? 8 : 6); });
    var best = {};
    rows.forEach(function (r) { best[r.e.group] = Math.max(best[r.e.group] || 0, r.s); });
    rows.sort(function (a, b) {
      return (best[b.e.group] - best[a.e.group]) || (GROUP_ORDER.indexOf(a.e.group) - GROUP_ORDER.indexOf(b.e.group)) || (b.s - a.s);
    });
    return rows.map(function (r) { return r.e; });
  }

  /** Draw results into a box, with keyboard selection. Returns the chooser. */
  function drawResults(box, q, results, done) {
    box.textContent = '';
    var flat = [];
    var group = null;
    results.slice(0, 40).forEach(function (e) {
      if (e.group !== group) { group = e.group; box.appendChild(el('div', 'rgroup', group)); }
      flat.push(e);
      box.appendChild(resRow(e, flat.length - 1, done));
    });
    if (q && q.trim() && q.trim().charAt(0) !== '>') {
      box.appendChild(el('div', 'rgroup', 'Ask'));
      var ask = { group: 'Ask', title: 'Ask LAIN: “' + q.trim() + '”', icon: 'ask', run: function () { askLain(q.trim()); } };
      flat.push(ask);
      box.appendChild(resRow(ask, flat.length - 1, done));
    }
    if (!flat.length) box.appendChild(el('div', 'none', 'Type to search settings, models, accounts, MCP, projects, sessions and files.'));
    select(box, 0);
    return flat;
  }
  function resRow(e, i, done) {
    var b = el('button', 'res');
    b.setAttribute('data-i', i);
    var ic = el('span', 'ri'); ic.appendChild(L.icon(e.icon || 'arrow', 15)); b.appendChild(ic);
    b.appendChild(el('span', 'rt', e.title));
    if (e.sub) b.appendChild(el('span', 'rp', e.sub));
    b.onmousedown = function (ev) { ev.preventDefault(); };
    b.onclick = function () { done(); e.run(); };
    return b;
  }
  function select(box, i) {
    var rows = box.querySelectorAll('.res');
    Array.prototype.forEach.call(rows, function (r, j) { r.setAttribute('aria-selected', String(j === i)); if (j === i) r.scrollIntoView({ block: 'nearest' }); });
    box.dataset.sel = String(i);
  }
  function keyNav(e, box, flat, done) {
    var i = Number(box.dataset.sel || 0);
    if (e.key === 'ArrowDown') { e.preventDefault(); select(box, Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(box, Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (flat[i]) { done(); flat[i].run(); } }
  }

  function askLain(q) { L.nav.go('chat'); L.chat.ask(q); }

  /** What the index reads that is not in the poll — each at most once a minute. */
  var lastWarm = 0;
  function warm() {
    if (Date.now() - lastWarm < 60000) return;
    lastWarm = Date.now();
    L.api('/api/project/recent', {}).then(function (r) { if (r && r.ok) { recent = r; subs.forEach(function (fn) { fn(); }); } }, function () {});
    L.api('/api/settings').then(function (r) { if (r && r.ok) settingsSchema = r; }, function () {});
    if (L.intel) L.intel.load();
    if (L.tools && !L.tools.get()) L.tools.load();
  }
  /** Files and models are searched where they live, as the query is typed. */
  var fileSeq = 0, modelSeq = 0;
  function remote(q, then) {
    var S = L.state();
    var attached = S && S.workspace && S.workspace.project && S.workspace.project.attached;
    var usable = q && q.length >= 2 && q.charAt(0) !== '>';
    if (!usable) { fileHits = { q: q, rows: [] }; modelHits = { q: q, rows: [] }; return; }
    if (attached) {
      var f = ++fileSeq;
      L.api('/api/files/find', { q: q }).then(function (r) { if (f !== fileSeq) return; fileHits = { q: q, rows: ((r && r.matches) || []).slice(0, 8) }; then(); }, function () {});
    }
    var m = ++modelSeq;
    L.api('/api/intel/search', { query: q, limit: 8 }).then(function (r) {
      if (m !== modelSeq || !r || !r.ok) return;
      modelHits = { q: q, rows: (r.models || []).slice(0, 8).map(function (x) { var fam = L.intel && x.family ? L.intel.findFamily(x.family) : null; return { id: x.id, label: x.label, familyLabel: fam ? fam.label : '' }; }) };
      then();
    }, function () {});
  }

  // ---- the palette ------------------------------------------------------------------------------------------
  var palFlat = [];
  function palette(prefix) {
    warm();
    refreshExtCommands();
    $('palette').hidden = false;
    var q = $('paletteQ');
    q.value = prefix || '';
    palQuery();
    setTimeout(function () { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 0);
  }
  function closePalette() { $('palette').hidden = true; }
  function palQuery() {
    var raw = $('paletteQ').value;
    var cmdMode = raw.charAt(0) === '>';
    var q = cmdMode ? raw.slice(1) : raw;
    var box = $('presults');
    var res = q.trim() ? search(q, cmdMode) : (cmdMode ? commands().map(function (c) { return Object.assign({ group: 'Commands' }, c); }) : []);
    if (!q.trim() && !cmdMode) res = ROOMS.slice(0, 7).map(function (s) { return { group: 'Go to', title: s[1], icon: s[0], run: function () { L.nav.go(s[0]); } }; }).concat(commands().map(function (c) { return Object.assign({ group: 'Commands' }, c); }));
    palFlat = drawResults(box, cmdMode ? '>' : raw, res, closePalette);
  }

  var subs = [];
  L.search = {
    palette: palette, query: search, warm: warm, draw: drawResults, keyNav: keyNav, remote: remote, ask: askLain,
    recent: function () { return recent; }, onRecent: function (fn) { subs.push(fn); },
  };

  L.onBoot(function () {
    $('paletteQ').addEventListener('input', function () { palQuery(); remote(this.value, palQuery); });
    $('paletteQ').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closePalette(); return; }
      keyNav(e, $('presults'), palFlat, closePalette);
    });
    $('palette').addEventListener('mousedown', function (e) { if (e.target === this) closePalette(); });
  });
}

function js() { return `(${client.toString()})();`; }

module.exports = { HTML, CSS, js, client };
