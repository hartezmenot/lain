'use strict';

/**
 * HOME — the launcher, and the one search over everything LAIN knows.
 *
 * ------------------------------------------------------------------------
 * A WORKSPACE, NOT A LANDING PAGE. A greeting, a search box, the six surfaces
 * as large quiet tiles each carrying one live fact, then recent projects,
 * recent sessions and a handful of actions. Nothing here is decoration.
 *
 * ------------------------------------------------------------------------
 * THE SEARCH INDEXES WHAT ALREADY HAS AN OWNER.
 *
 *   surfaces, commands        this file (static)
 *   settings and their fields GET /api/settings (Core's schema)
 *   MCP servers, skills       LAIN.tools (POST /api/mcp/servers, /api/skills)
 *   providers, models, roles  LAIN.accounts (POST /api/accounts)
 *   bot channels              LAIN.bot (POST /api/bot/connections)
 *   projects                  POST /api/project/recent
 *   sessions                  S.sessions
 *   files                     POST /api/files/find, when a project is open
 *
 * Every result navigates to the owner's own surface. The last row is always
 * "Ask LAIN" — the BOT can answer anything the search can find, from the same
 * state (Core's lain_workspace tool).
 */

const HTML = `
<section class="view home" id="vHome" data-view="home" hidden>
  <div class="home-in">
    <h1 class="greet" id="greet">Hello.</h1>
    <p class="greet-sub">What would you like to do today?</p>
    <div class="hsearch" id="hsearchBox">
      <span class="hs-ic" id="hsIcon"></span>
      <input id="hsearch" placeholder="Ask LAIN anything or search…" autocomplete="off" spellcheck="false">
      <span class="kbd">Ctrl K</span>
      <div class="hresults" id="hresults" hidden></div>
    </div>
    <div class="home-grid">
      <div class="home-main">
        <div class="tiles" id="tiles"></div>
        <div class="home-cols">
          <div class="hcol"><h2>Recent projects</h2><div id="homeProjects" class="hlist"></div></div>
          <div class="hcol"><h2>Recent sessions</h2><div id="homeSessions" class="hlist"></div></div>
        </div>
      </div>
      <aside class="home-side">
        <div class="hcol"><h2>System status</h2><div id="homeStatus" class="hstatus"></div></div>
        <div class="hcol"><h2>Quick actions</h2><div id="homeActions" class="hlist"></div></div>
      </aside>
    </div>
  </div>
</section>
<div class="palette-back" id="palette" hidden>
  <div class="palette">
    <input id="paletteQ" placeholder="Search LAIN, or type > for commands" autocomplete="off" spellcheck="false">
    <div class="presults" id="presults"></div>
  </div>
</div>`;

const CSS = `
.home{overflow-y:auto}
.home-in{max-width:1180px;margin:0 auto;padding:52px 36px 40px}
.greet{font:600 26px/1.2 var(--sans);letter-spacing:-.01em;margin:0;color:var(--ink)}
.greet-sub{margin:4px 0 20px;color:var(--dim);font-size:15px}
.home-grid{display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:32px;margin-top:28px}
.home-side{display:grid;gap:26px;align-content:start}
.hstatus .srow2{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:var(--radius-s);width:100%;text-align:left}
.hstatus .srow2:hover{background:var(--surface)}
.hstatus .si{width:28px;height:28px;border-radius:7px;display:grid;place-items:center;background:var(--surface);color:var(--dim);flex:none}
.hstatus .sn{flex:1;min-width:0;font-size:13px}
.hstatus .sn small{display:block;color:var(--faint);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hstatus .sd{width:8px;height:8px;border-radius:50%;background:var(--faint);flex:none}
.hstatus .sd.ok{background:var(--ok)} .hstatus .sd.warn{background:var(--warn)} .hstatus .sd.bad{background:var(--bad)}
.hsearch{position:relative;display:flex;align-items:center;gap:10px;height:46px;padding:0 14px;background:var(--surface);border:1px solid var(--line2);border-radius:10px}
.hsearch:focus-within{border-color:var(--accent-line);box-shadow:0 0 0 3px var(--accent-weak)}
.hsearch input{font-size:15px}
.hs-ic{color:var(--faint);display:flex}
.kbd{flex:none;font-size:11px;color:var(--faint);border:1px solid var(--line2);border-radius:4px;padding:1px 6px}
.hresults{position:absolute;left:-1px;right:-1px;top:50px;z-index:30;background:var(--panel);border:1px solid var(--line2);border-radius:10px;box-shadow:var(--shadow);max-height:420px;overflow-y:auto;padding:6px}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0 0 34px}
.tile{display:flex;align-items:flex-start;gap:14px;padding:16px 18px;border-radius:10px;background:var(--panel);border:1px solid var(--line);text-align:left}
.tile:hover{border-color:var(--line2);background:var(--surface)}
.tile .ti{width:40px;height:40px;border-radius:9px;display:grid;place-items:center;background:var(--accent-weak);color:var(--accent);flex:none}
.tile .tn{font-size:14px;font-weight:600;letter-spacing:.04em}
.tile .tp{font-size:12px;color:var(--dim);margin-top:2px}
.tile .tf{font-size:11.5px;color:var(--faint);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile .tt{min-width:0}
.home-cols{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.hcol h2{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);font-weight:600;margin:0 0 8px}
.hlist .hrow{display:flex;align-items:center;gap:10px;width:100%;padding:7px 8px;border-radius:var(--radius-s);text-align:left;color:var(--dim);font-size:13px}
.hlist .hrow:hover{background:var(--surface);color:var(--ink)}
.hrow .ht{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hrow .ht small{display:block;color:var(--faint);font-size:11px;overflow:hidden;text-overflow:ellipsis}
.hrow .hm{flex:none;color:var(--faint);font-size:11px}
.hlist .none{color:var(--faint);font-size:12.5px;padding:7px 8px}
/* ---- results: the same rows in Home and in the palette ------------------ */
.rgroup{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);padding:8px 10px 4px}
.res{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;border-radius:var(--radius-s);text-align:left;font-size:13px;color:var(--ink)}
.res .rp{color:var(--faint);font-size:11.5px;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}
.res .ri{color:var(--faint);display:flex;flex:none}
.res .rt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.res[aria-selected=true],.res:hover{background:var(--accent-weak)}
.res[aria-selected=true] .ri{color:var(--accent)}
.palette-back{position:fixed;inset:0;z-index:60;background:#0008;display:flex;justify-content:center;align-items:flex-start;padding-top:11vh}
.palette{width:min(640px,92vw);background:var(--panel);border:1px solid var(--line2);border-radius:10px;box-shadow:var(--shadow);overflow:hidden}
.palette input{padding:13px 16px;font-size:14.5px;border-bottom:1px solid var(--line)}
.presults{max-height:52vh;overflow-y:auto;padding:6px}
@media (max-width: 1000px){.home-grid{grid-template-columns:minmax(0,1fr)}}
@media (max-width: 860px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.home-cols{grid-template-columns:1fr}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var recent = null;
  var settingsSchema = null;
  var fileHits = { q: null, rows: [] };

  // ---- the index ------------------------------------------------------------
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim(); }
  /** Every query word must begin a word in the haystack; "opus 5" finds "claude-opus-5". */
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

  var SURFACES = [
    ['home', 'Home', 'launcher search start'], ['ide', 'IDE', 'editor code project explorer files terminal'],
    ['chat', 'Chat', 'conversation research plan discuss'], ['bot', 'Bot', 'identity channels telegram discord whatsapp permissions allowlist capabilities'],
    ['model', 'Model', 'providers accounts oauth api quota usage models roles orchestration'], ['session', 'Session', 'history previous work restore'],
    ['settings', 'Settings', 'preferences configuration mcp skills notifications privacy'],
  ];
  var SETTINGS_PAGES = [
    ['general', 'General'], ['appearance', 'Appearance', 'theme density'], ['editor', 'Editor', 'font size tab'], ['shortcuts', 'Shortcuts', 'keyboard keys'],
    ['notifications', 'Notifications'], ['mcp', 'MCP', 'model context protocol servers tools computer'], ['skills', 'Skills'],
    ['integrations', 'Integrations', 'chrome extension'], ['storage', 'Storage', 'paths folders node sessions'], ['privacy', 'Privacy', 'trusted folders security'], ['about', 'About'],
  ];

  function commands() {
    return [
      { title: 'New Project', sub: 'IDE', icon: 'plus', kw: 'create folder workspace', run: function () { L.ide.newProject(); } },
      { title: 'Open Project', sub: 'IDE', icon: 'folder', kw: 'folder workspace', run: function () { L.ide.openProject(); } },
      { title: 'New Chat', sub: 'Chat', icon: 'chat', kw: 'conversation', run: function () { L.chat.newChat(); } },
      { title: 'Refresh models and accounts', sub: 'Model', icon: 'refresh', kw: 'reload catalog quota', run: function () { L.nav.go('model'); L.accounts.refresh(true); } },
      { title: 'Connect Telegram', sub: 'Bot › Connections', icon: 'link', kw: 'bot token', run: function () { L.nav.go('bot', { section: 'connections' }); } },
      { title: 'Open File', sub: 'IDE · Ctrl+P', icon: 'files', kw: 'quick open', run: function () { L.nav.go('ide'); L.ide.quickOpen(); } },
      { title: 'Toggle Terminal', sub: 'IDE · Ctrl+`', icon: 'terminal', kw: 'shell console', run: function () { L.nav.go('ide'); L.ide.showPanel('TERMINAL'); } },
      { title: 'Keyboard shortcuts', sub: 'Settings', icon: 'settings', kw: 'keys', run: function () { L.nav.go('settings', { section: 'shortcuts' }); } },
    ];
  }

  function entries() {
    var S = L.state() || {};
    var out = [];
    SURFACES.forEach(function (s) { out.push({ group: 'Go to', title: s[1], sub: '', icon: s[0], kw: s[2], run: function () { L.nav.go(s[0]); } }); });
    SETTINGS_PAGES.forEach(function (p) { out.push({ group: 'Settings', title: 'Settings › ' + p[1], icon: 'settings', kw: p[1] + ' ' + (p[2] || ''), run: function () { L.nav.go('settings', { section: p[0] }); } }); });
    ((settingsSchema && settingsSchema.sections) || []).forEach(function (sec) {
      (sec.fields || []).forEach(function (f) {
        out.push({ group: 'Settings', title: f.label, sub: 'Settings › ' + sec.label, icon: 'settings', kw: sec.label + ' ' + f.key,
          run: function () { L.nav.go(sec.id === 'MODELS' ? 'model' : sec.id === 'CONNECTIONS' && f.key === 'connections.messaging' ? 'bot' : 'settings', { section: L.settings ? L.settings.pageOf(sec.id) : null }); } });
      });
    });
    var tools = L.tools ? L.tools.get() : null;
    ((tools && tools.servers) || []).forEach(function (m) {
      out.push({ group: 'MCP', title: m.name + ' MCP server', sub: 'Settings › MCP · ' + m.state.toLowerCase().replace(/_/g, ' '), icon: 'plug', kw: 'mcp server tools ' + m.id + ' ' + (m.tools || []).join(' '),
        run: function () { L.nav.go('settings', { section: 'mcp', item: m.id }); } });
      (m.tools || []).slice(0, 40).forEach(function (t) { out.push({ group: 'MCP', title: t, sub: m.name + ' tool', icon: 'plug', kw: 'tool mcp', run: function () { L.nav.go('settings', { section: 'mcp', item: m.id }); } }); });
    });
    out.push({ group: 'Settings', title: 'Skills', sub: 'Settings › Skills', icon: 'spark', kw: 'skill packages', run: function () { L.nav.go('settings', { section: 'skills' }); } });
    var A = L.accounts.get();
    var roles = A.data && A.data.roles;
    if (roles) {
      [['bot', 'BOT model'], ['coding', 'Coding Agent model']].forEach(function (r) {
        var x = roles[r[0]];
        out.push({ group: 'Model', title: r[1] + ': ' + (L.fmt.model(x.modelId) || x.source || 'not set'), sub: 'Model › Roles', icon: 'model', kw: 'role assignment ' + (x.modelId || '') + ' ' + (x.source || ''), run: function () { L.nav.go('model', { section: 'roles' }); } });
      });
    }
    ((A.data && A.data.providers) || []).forEach(function (g) {
      out.push({ group: 'Model', title: g.label, sub: 'Model › Providers · ' + g.connections.length + ' route' + (g.connections.length === 1 ? '' : 's'), icon: 'model', kw: 'provider account ' + g.provider + ' ' + g.connections.map(function (c) { return c.id + ' ' + c.host; }).join(' '),
        run: function () { L.nav.go('model', { section: 'providers', item: g.provider }); } });
      g.connections.forEach(function (c) {
        c.models.forEach(function (m) {
          out.push({ group: 'Models', title: m, sub: 'Model › ' + g.label + (c.usage && c.usage.headline ? ' · ' + Math.round(c.usage.headline.percent) + '% used' : ''), icon: 'model', kw: g.label + ' ' + c.id,
            run: function () { L.nav.go('model', { section: 'providers', item: g.provider, model: m }); } });
        });
      });
    });
    ((A.data && A.data.sources) || []).filter(function (s) { return s.kind === 'WEB'; }).forEach(function (s) {
      out.push({ group: 'Model', title: s.label, sub: 'Model › Website accounts · ' + String(s.state).toLowerCase().replace(/_/g, ' '), icon: 'model', kw: 'account web sign in', run: function () { L.nav.go('model', { section: 'accounts' }); } });
    });
    ['Telegram', 'Discord', 'WhatsApp'].forEach(function (p) {
      out.push({ group: 'Bot', title: p, sub: 'Bot › Connections', icon: 'bot', kw: 'channel messaging integration', run: function () { L.nav.go('bot', { section: 'connections' }); } });
    });
    out.push({ group: 'Bot', title: 'Allowlist', sub: 'Bot › Permissions', icon: 'shield', kw: 'permissions approved users security access', run: function () { L.nav.go('bot', { section: 'permissions' }); } });
    ((recent && recent.recent) || []).forEach(function (p) {
      out.push({ group: 'Projects', title: p.name, sub: p.root, icon: 'folder', kw: p.root, run: function () { L.ide.open(p.root); } });
    });
    L.sessions.all().forEach(function (s) {
      out.push({ group: 'Sessions', title: s.title || '(untitled)', sub: [s.project, s.when].filter(Boolean).join(' · '), icon: 'session', kw: (s.project || '') + ' ' + (s.source || ''), run: function () { L.sessionView.open(s); } });
    });
    commands().forEach(function (c) { out.push(Object.assign({ group: 'Commands' }, c)); });
    fileHits.rows.forEach(function (f) { out.push({ group: 'Files', title: f.path.split('/').pop(), sub: f.path, icon: 'files', kw: f.path, run: function () { L.nav.go('ide'); L.source.openFile(f.path); } }); });
    return out;
  }

  var GROUP_ORDER = ['Go to', 'Commands', 'Settings', 'MCP', 'Model', 'Models', 'Bot', 'Projects', 'Sessions', 'Files'];
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
    rows.sort(function (a, b) {
      var ga = GROUP_ORDER.indexOf(a.e.group), gb = GROUP_ORDER.indexOf(b.e.group);
      var ba = Math.max.apply(null, rows.filter(function (r) { return r.e.group === a.e.group; }).map(function (r) { return r.s; }));
      var bb = Math.max.apply(null, rows.filter(function (r) { return r.e.group === b.e.group; }).map(function (r) { return r.s; }));
      return (bb - ba) || (ga - gb) || (b.s - a.s);
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
    if (!flat.length) box.appendChild(el('div', 'none', 'Type to search settings, models, MCP, projects, sessions and files.'));
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

  function askLain(q) {
    L.nav.go('chat');
    L.chat.ask(q);
  }

  /** Load what the index reads that is not in the poll. Each at most once a minute. */
  var lastWarm = 0;
  function warm() {
    if (Date.now() - lastWarm < 60000) return;
    lastWarm = Date.now();
    L.api('/api/project/recent', {}).then(function (r) { if (r && r.ok) { recent = r; renderHome(); } }, function () {});
    L.api('/api/settings').then(function (r) { if (r && r.ok) settingsSchema = r; }, function () {});
    if (!L.accounts.get().data) L.accounts.load();
    if (L.tools && !L.tools.get()) L.tools.load();
  }
  var fileSeq = 0;
  function files(q, then) {
    var S = L.state();
    var attached = S && S.workspace && S.workspace.project && S.workspace.project.attached;
    if (!attached || !q || q.length < 2 || q.charAt(0) === '>') { fileHits = { q: q, rows: [] }; return; }
    var mine = ++fileSeq;
    L.api('/api/files/find', { q: q }).then(function (r) {
      if (mine !== fileSeq) return;
      fileHits = { q: q, rows: ((r && r.matches) || []).slice(0, 8) };
      then();
    }, function () {});
  }

  // ---- Home's box -------------------------------------------------------------
  var homeFlat = [];
  function homeQuery() {
    var q = $('hsearch').value;
    var box = $('hresults');
    if (!q.trim()) { box.hidden = true; return; }
    box.hidden = false;
    homeFlat = drawResults(box, q, search(q), function () { box.hidden = true; $('hsearch').value = ''; });
  }

  // ---- the palette ------------------------------------------------------------
  var palFlat = [];
  function palette(prefix) {
    warm();
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
    var res = q.trim() ? search(q, cmdMode) : (cmdMode ? commands().map(function (c) { return Object.assign({ group: 'Commands' }, c); }) : search('', false));
    if (!q.trim() && !cmdMode) res = SURFACES.map(function (s) { return { group: 'Go to', title: s[1], icon: s[0], run: function () { L.nav.go(s[0]); } }; }).concat(commands().map(function (c) { return Object.assign({ group: 'Commands' }, c); }));
    palFlat = drawResults(box, cmdMode ? '>' : raw, res, closePalette);
  }

  // ---- the resting Home ------------------------------------------------------
  function greeting() {
    var h = new Date().getHours();
    return h < 5 ? 'Good night.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
  }
  function tileFacts(S) {
    var p = S.workspace && S.workspace.project;
    var sess = L.sessions.all();
    var live = sess.filter(function (s) { return s.live; }).length;
    var A = L.accounts.get();
    var u = S.usage && S.usage.coding;
    var h = u && u.reading && u.reading.headline;
    var tools = L.tools ? L.tools.get() : null;
    var bot = L.bot ? L.bot.summary() : '';
    return {
      ide: p && p.attached ? p.name + (p.sync && p.sync.running ? ' · understanding…' : ' is open') : 'Open or create a project',
      chat: (S.sessions && S.sessions.engineering ? S.sessions.engineering.length : 0) + ' conversations',
      bot: bot || 'Channels not read yet',
      model: u ? L.fmt.model(u.modelId) + (h ? ' · ' + Math.round(h.percent) + '% used' : '') : (A.loading ? 'refreshing…' : 'Providers and roles'),
      session: sess.length + ' sessions' + (live ? ' · ' + live + ' live' : ''),
      settings: tools && tools.servers ? 'MCP · ' + tools.servers.length + ' server' + (tools.servers.length === 1 ? '' : 's') + ' · Skills' : 'MCP, Skills, Editor, Privacy',
    };
  }
  /** One line per subsystem, each read from its owner; unknown stays unknown. */
  function renderStatus(S) {
    var box = $('homeStatus');
    var rows = [];
    var botData = L.bot ? L.bot.get() : null;
    var on = botData ? (botData.platforms || []).filter(function (p) { return p.state === 'CONNECTED'; }).length : null;
    rows.push(['bot', 'Bot', botData ? (on ? on + ' channel' + (on === 1 ? '' : 's') + ' connected' : 'desktop only') : 'not read yet', botData ? (on ? 'ok' : '') : '', 'bot']);
    var A = L.accounts.get();
    var provs = A.data ? A.data.providers || [] : null;
    var limited = provs ? provs.some(function (g) { return g.connections.some(function (c) { return c.availability && c.availability.rateLimited; }); }) : false;
    rows.push(['model', 'Models', A.loading ? 'refreshing\u2026' : provs ? provs.length + ' provider' + (provs.length === 1 ? '' : 's') + (limited ? ' \u00b7 rate limited' : ' configured') : 'not read yet', A.loading ? '' : provs ? (limited ? 'warn' : provs.length ? 'ok' : 'bad') : '', 'model']);
    var t = L.tools ? L.tools.get() : null;
    var live = t ? t.servers.filter(function (x) { return x.state === 'CONNECTED' || x.state === 'ACTIVE_BRIDGE'; }).length : 0;
    rows.push(['plug', 'MCP', t ? t.servers.length + ' server' + (t.servers.length === 1 ? '' : 's') + (live ? ' \u00b7 ' + live + ' connected' : '') : 'not read yet', t ? (live ? 'ok' : '') : '', 'settings']);
    var p = S.workspace && S.workspace.project;
    var sync = p && p.sync;
    rows.push(['ide', 'Project', p && p.attached ? p.name + (sync && sync.running ? ' \u00b7 understanding\u2026' : sync && sync.state ? ' \u00b7 ready' : '') : 'none open', p && p.attached ? (sync && sync.running ? 'warn' : 'ok') : '', 'ide']);
    var st = S.header && S.header.status;
    rows.push(['spark', 'Work', st && st.state && st.state !== 'IDLE' ? st.state.toLowerCase().replace(/_/g, ' ') + (st.summary ? ' \u00b7 ' + st.summary : '') : 'idle', st && (st.state === 'RUNNING' || st.state === 'VERIFYING') ? 'ok' : st && st.state === 'FAILED' ? 'bad' : '', 'session']);
    var sig = JSON.stringify(rows);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    rows.forEach(function (r) {
      var b = el('button', 'srow2');
      var i = el('span', 'si'); i.appendChild(L.icon(r[0], 15)); b.appendChild(i);
      var n = el('span', 'sn', r[1]); n.appendChild(el('small', '', r[2])); b.appendChild(n);
      b.appendChild(el('span', 'sd ' + r[3]));
      b.onclick = function () { L.nav.go(r[4], r[4] === 'settings' ? { section: 'mcp' } : null); };
      box.appendChild(b);
    });
  }

  function renderHome() {
    var S = L.state();
    if (!S || L.nav.tab() !== 'home') return;
    $('greet').textContent = greeting();
    var facts = tileFacts(S);
    var tiles = $('tiles');
    var sig = JSON.stringify(facts);
    if (tiles.dataset.sig !== sig) {
      tiles.dataset.sig = sig;
      tiles.textContent = '';
      var PURPOSE = { ide: 'Build, edit and run a project', chat: 'Research, plan and discuss', bot: 'Identity, channels, permissions', model: 'Providers, accounts and quota', session: 'Restore previous work', settings: 'Tools, Skills, MCP and more' };
      [['ide', 'IDE'], ['chat', 'Chat'], ['bot', 'Bot'], ['model', 'Model'], ['session', 'Session'], ['settings', 'Settings']].forEach(function (t) {
        var b = el('button', 'tile');
        var i = el('span', 'ti'); i.appendChild(L.icon(t[0], 21)); b.appendChild(i);
        var tt = el('span', 'tt');
        tt.appendChild(el('div', 'tn', t[1].toUpperCase()));
        tt.appendChild(el('div', 'tp', PURPOSE[t[0]]));
        tt.appendChild(el('div', 'tf', facts[t[0]]));
        b.appendChild(tt);
        b.onclick = function () { L.nav.go(t[0]); };
        tiles.appendChild(b);
      });
    }
    var projects = $('homeProjects');
    projects.textContent = '';
    var rp = (recent && recent.recent) || [];
    if (!rp.length) projects.appendChild(el('div', 'none', recent ? 'No projects yet.' : 'Reading…'));
    rp.slice(0, 5).forEach(function (p) {
      var b = el('button', 'hrow');
      b.appendChild(L.icon('folder', 15));
      var t = el('span', 'ht', p.name); t.appendChild(el('small', '', p.root)); b.appendChild(t);
      b.onclick = function () { L.ide.open(p.root); };
      projects.appendChild(b);
    });
    var ss = $('homeSessions');
    ss.textContent = '';
    var list = L.sessions.all().slice(0, 5);
    if (!list.length) ss.appendChild(el('div', 'none', 'No sessions yet.'));
    list.forEach(function (s) {
      var b = el('button', 'hrow');
      b.appendChild(L.icon(s.lane === 'cowork' ? 'chat' : 'session', 15));
      var t = el('span', 'ht', s.title || '(untitled)'); t.appendChild(el('small', '', [s.project, s.source].filter(Boolean).join(' · '))); b.appendChild(t);
      b.appendChild(el('span', 'hm', s.status ? s.status.toLowerCase() : s.when));
      b.onclick = function () { L.sessionView.open(s); };
      ss.appendChild(b);
    });
    renderStatus(S);
    var acts = $('homeActions');
    if (!acts.childNodes.length) {
      commands().slice(0, 5).forEach(function (c) {
        var b = el('button', 'hrow');
        b.appendChild(L.icon(c.icon, 15));
        b.appendChild(el('span', 'ht', c.title));
        b.onclick = c.run;
        acts.appendChild(b);
      });
    }
  }

  L.search = { palette: palette, query: search, warm: warm };

  L.onBoot(function () {
    $('hsIcon').appendChild(L.icon('search', 17));
    $('hsearch').addEventListener('input', function () { homeQuery(); files(this.value, homeQuery); });
    $('hsearch').addEventListener('focus', function () { warm(); if (this.value.trim()) homeQuery(); });
    $('hsearch').addEventListener('blur', function () { setTimeout(function () { $('hresults').hidden = true; }, 120); });
    $('hsearch').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { this.value = ''; $('hresults').hidden = true; return; }
      if (e.key === 'Enter' && !homeFlat.length && this.value.trim()) { askLain(this.value.trim()); return; }
      keyNav(e, $('hresults'), homeFlat, function () { $('hresults').hidden = true; $('hsearch').value = ''; });
    });
    $('paletteQ').addEventListener('input', function () { palQuery(); files(this.value, palQuery); });
    $('paletteQ').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closePalette(); return; }
      keyNav(e, $('presults'), palFlat, closePalette);
    });
    $('palette').addEventListener('mousedown', function (e) { if (e.target === this) closePalette(); });
    L.nav.onShow('home', function () { warm(); renderHome(); setTimeout(function () { $('hsearch').focus(); }, 0); });
    L.accounts.on(function () { $('tiles').dataset.sig = ''; renderHome(); });
  });
  L.onRender(function () { renderHome(); });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
