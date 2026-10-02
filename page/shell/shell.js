'use strict';

/**
 * THE FRAME — the navigation rail, the top bar (the window's own title bar), the
 * surface switcher and the window controls (2026-09-30 rebuild).
 *
 *   ┌ rail ─────────┐┌ top bar ─────────────────────────── ◔ 74% left ▾   ☾   ─ ▢ ✕ ┐
 *   │ LAIN • v2.0   ││                                                              │
 *   │───────────────││                                                              │
 *   │ ⌂ Home        ││                         the surface                          │
 *   │ ‹› IDE        ││                                                              │
 *   │ ▢ Chat        ││                                                              │
 *   │ ≋ Model       ││                                                              │
 *   │ ▥ Usage       ││                                                              │
 *   │ ⧉ Capabilities││                                                              │
 *   │ ⚙ Settings    ││                                                              │
 *   │ (the room's   ││                                                              │
 *   │  own list)    ││                                                              │
 *   │ ┌ Extensions ┐││                                                              │
 *   │ ┌ ◉ octoalice┐││                                                              │
 *   │ ✎ Feedback    ││                                                              │
 *   └───────────────┘└──────────────────────────────────────────────────────────────┘
 *
 * SEVEN ROOMS: HOME · IDE · CHAT · MODEL · USAGE · MCP & SKILLS · SETTINGS. The
 * rail is beside every room except the IDE, which has its own workbench (an
 * activity bar) and uses the top bar for the LAIN switcher and its menus.
 *
 * THE RAIL, top to bottom: the brand; the rooms; THE ROOM'S OWN LIST (Chat puts
 * its conversations here — L.rail.room); then Extensions, the GitHub identity
 * ABOVE Feedback. Expanded (icon + name) by default; icons only when Settings ›
 * Appearance › Navigation says so or the window is narrow.
 *
 * THE TOP BAR IS THE WINDOW'S TITLE BAR (native/host.cs Frame): empty space
 * drags the window, a double-click maximises, and the right end always carries
 * the USAGE TRACKER (shell/tracker.js), the light/dark switch and the window
 * buttons. On a host that keeps the system caption, the window buttons stay
 * hidden and nothing else changes.
 */

const HTML = `
<aside id="rail" aria-label="LAIN">
  <div class="rail-brand" data-drag="1">
    <span class="rb-mark" aria-hidden="true"><svg viewBox="0 0 16 16" width="18" height="18"><circle cx="7" cy="9" r="3.9" fill="none" stroke="#9B8AFB" stroke-width="1.8"/><circle cx="11" cy="5" r="2.9" class="rbm-cut"/><circle cx="11" cy="5" r="1.9" fill="#2DD4BF"/></svg></span><span class="rb-word">LAIN</span><span class="rb-ver" id="railVer"></span>
  </div>
  <nav id="tabs" role="tablist" aria-label="LAIN workspace" aria-orientation="vertical">
    <button class="gtab" role="tab" data-tab="home" id="tabHome">Home</button>
    <button class="gtab" role="tab" data-tab="ide" id="tabIde">IDE</button>
    <button class="gtab" role="tab" data-tab="chat" id="tabChat">Chat</button>
    <button class="gtab" role="tab" data-tab="model" id="tabModel">Model</button>
    <button class="gtab" role="tab" data-tab="usage" id="tabUsage">Usage</button>
    <button class="gtab" role="tab" data-tab="mcp" id="tabMcp">MCP &amp; Skills</button>
    <button class="gtab" role="tab" data-tab="settings" id="tabSettings">Settings</button>
  </nav>
  <div class="rail-room" id="railRoom" hidden></div>
  <span class="spacer"></span>
  <div class="rail-foot">
    <button class="rail-card" id="railExt"><span class="rcd-ic" id="railExtIc"></span><span class="rcd-b"><b>Extensions</b><small>Browse &amp; install extensions from community catalogs.</small></span><span class="rcd-car" id="railExtCar"></span></button>
    <button class="rail-gh" id="railGh" aria-haspopup="menu"><span class="gh-mark" id="railGhMark"></span><span class="gh-av" id="railGhAv"></span><span class="gh-t"><b id="railGhName">GitHub</b><small id="railGhSub">Connect an account</small></span><span class="gh-car" id="railGhCar"></span></button>
    <div class="rail-row">
      <button class="rail-small" id="railFeedback"><span class="rs-ic" id="railFeedbackIc"></span><span class="rs-t">Feedback</span></button>
      <button class="rail-exit" id="railExit" aria-label="Exit LAIN" data-tip="Exit LAIN"></button>
      <button class="rail-fold" id="railFold" aria-label="Collapse navigation"></button>
    </div>
  </div>
</aside>
<header id="topbar">
  <button class="surf" id="surfBtn" aria-haspopup="menu" aria-label="LAIN — go to another room (Alt+1…7)"><span class="rb-mark" aria-hidden="true"><svg viewBox="0 0 16 16" width="18" height="18"><circle cx="7" cy="9" r="3.9" fill="none" stroke="#9B8AFB" stroke-width="1.8"/><circle cx="11" cy="5" r="2.9" class="rbm-cut"/><circle cx="11" cy="5" r="1.9" fill="#2DD4BF"/></svg></span><span class="rb-word">LAIN</span><span class="rb-ver" id="surfVer"></span><span class="sf-car" id="surfCar"></span><span class="sf-name" id="surfName" hidden>IDE</span></button>
  <div class="menus" id="menus" role="menubar">
    <button class="mb" data-menu="file">File</button>
    <button class="mb" data-menu="edit">Edit</button>
    <button class="mb" data-menu="view">View</button>
    <button class="mb" data-menu="help">Help</button>
  </div>
  <span class="tb-drag" data-drag="1"></span>
  <button class="topsearch" id="topSearch" data-tip="Search LAIN (Ctrl+K)"><span id="topSearchIc"></span><span class="ts-t">Search files, symbols, or ask LAIN…</span><span class="kbd">Ctrl K</span></button>
  <span class="tb-drag" data-drag="1"></span>
  <span class="conn" id="conn"></span>
  <button class="tracker" id="tracker" aria-haspopup="dialog"><span class="trk-ring" id="trackerRing"></span><span class="trk-t" id="trackerText">Usage</span><span class="trk-x" id="trackerExtra"></span><span class="trk-car" id="trackerCar"></span></button>
  <button class="cubtn" id="cuBtn" aria-haspopup="dialog" data-on="false"><span class="cu-dot"></span><span class="cu-t">Computer</span></button>
  <button class="updbtn" id="updateBtn" hidden aria-haspopup="dialog"><span class="ud-ic" id="updateIc"></span><span class="ud-t">Update</span></button>
  <button class="tb-ib" id="themeBtn"></button>
  <div class="winctl" id="winctl" hidden>
    <button id="winMin" aria-label="Minimize"></button><button id="winMax" aria-label="Maximize"></button><button id="winClose" class="close" aria-label="Close"></button>
  </div>
</header>
<div class="win-edge" id="winEdge" hidden><i data-edge="topleft"></i><i data-edge="top"></i><i data-edge="topright"></i></div>
<div class="menu" id="menuDrop" hidden role="menu"></div>`;

const CSS = `
/* ---- the frame: rail | top bar over the surface ------------------------------------------------------------ */
#app{--nav-w:var(--rail-w);display:grid;grid-template-columns:var(--nav-w) minmax(0,1fr);grid-template-rows:var(--topbar-h) minmax(0,1fr);height:100%;background:var(--canvas)}
/* FOLDING THE RAIL IS INSTANT (a column that animates reflows every surface each frame); the names fade in instead. */
#app[data-navw=expanded] .gtab .lbl,#app[data-navw=expanded] .rcd-b,#app[data-navw=expanded] .gh-t{animation:lain-fade var(--t-side) var(--ease)}
#app[data-navw=compact]{--nav-w:var(--rail-compact)}
#app[data-navw=none]{--nav-w:0px}
#app[data-navw=none] #rail{display:none}
#rail{grid-row:1 / span 2;grid-column:1;display:flex;flex-direction:column;min-height:0;background:var(--nav);color:var(--nav-text);box-shadow:inset -1px 0 0 var(--separator);overflow-x:hidden;overflow-y:auto;scrollbar-width:none}
#rail::-webkit-scrollbar{display:none}
#topbar{grid-column:2;grid-row:1}
#views{grid-column:2;grid-row:2}

/* ---- the rail ------------------------------------------------------------------------------------------ */
.rail-brand{flex:none;display:flex;align-items:center;gap:8px;height:var(--topbar-h);padding:0 22px;box-shadow:inset 0 -1px 0 var(--separator)}
.rb-word{font:600 16px/1 var(--display);letter-spacing:.34em;color:var(--nav-text)}
/* THE LAIN MARK — a violet ring with a teal point, cut from the surface it sits on (distribution/brand/lain.svg). */
.rb-mark{display:flex;flex:none}
.rb-mark .rbm-cut{fill:var(--nav)}
#topbar .rb-mark .rbm-cut{fill:var(--canvas)}
/* A NARROW WINDOW (or a high zoom) keeps the title bar to what it needs: the rail carries the mark. */
@media (max-width: 760px){#topbar .rb-mark{display:none}}
.rb-ver{margin-left:6px;font-size:var(--fs-caption);color:var(--nav-muted);white-space:nowrap}
#tabs{display:flex;flex-direction:column;gap:3px;padding:14px 12px 6px}
.gtab{position:relative;display:flex;align-items:center;gap:13px;width:100%;height:42px;padding:0 13px;border-radius:var(--radius-md);color:var(--nav-muted);font-size:var(--fs-lead);font-weight:500;text-align:left;white-space:nowrap;transition:background var(--t-hover) var(--ease),color var(--t-hover) var(--ease),box-shadow var(--t-hover) var(--ease)}
.gtab:hover{color:var(--nav-text);background:color-mix(in srgb,var(--nav-text) 5%,transparent)}
.gtab[aria-selected=true]{color:var(--nav-text);background:color-mix(in srgb,var(--accent-primary) 11%,var(--surface-raised));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent-primary) 36%,transparent)}
.gtab .ic{flex:none}
.gtab[aria-selected=true] .ic{color:var(--nav-text)}
.gtab .badge{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent-tertiary);margin-left:auto}
/* THE ROOM'S OWN LIST (Chat: Conversations) — between the rooms and the footer, scrolling on its own. */
.rail-room{display:flex;flex-direction:column;min-height:120px;flex:1 1 auto;margin-top:8px;padding:12px 12px 4px;box-shadow:inset 0 1px 0 var(--separator);overflow:hidden}
.rail-room[hidden]{display:none}
.rail-room ~ .spacer{display:none}
.rail-room[hidden] ~ .spacer{display:block}
.rail-foot{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px}
.rail-card{display:grid;grid-template-columns:24px minmax(0,1fr) 16px;gap:4px 10px;align-items:start;width:100%;padding:12px;border-radius:var(--radius-md);background:var(--surface-base);text-align:left;color:var(--nav-text);box-shadow:inset 0 0 0 1px var(--separator)}
.rail-card:hover{background:var(--surface-raised)}
.rail-card .rcd-ic{color:var(--nav-text);display:flex;padding-top:1px}
.rail-card b{display:block;font-size:var(--fs-body);font-weight:600}
.rail-card small{display:block;margin-top:3px;font-size:var(--fs-small);line-height:1.4;color:var(--nav-muted)}
.rail-card .rcd-car{color:var(--nav-muted);display:flex;padding-top:2px}
.rail-gh{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border-radius:var(--radius-md);background:var(--surface-base);text-align:left;color:var(--nav-text);box-shadow:inset 0 0 0 1px var(--separator)}
.rail-gh:hover,.rail-gh[aria-expanded=true]{background:var(--surface-raised)}
.gh-mark{display:flex;color:var(--nav-text);flex:none}
.gh-av{position:relative;width:32px;height:32px;border-radius:50%;flex:none;background:var(--surface-active) center/cover no-repeat;display:grid;place-items:center;font-size:var(--fs-small);font-weight:600;color:var(--nav-text)}
.gh-av::after{content:'';position:absolute;right:-1px;bottom:-1px;width:9px;height:9px;border-radius:50%;background:var(--positive);box-shadow:0 0 0 2px var(--surface-base);display:none}
.rail-gh.on .gh-av::after{display:block}
.rail-gh:not(.on) .gh-av{display:none}
.gh-t{min-width:0;flex:1;display:flex;flex-direction:column}
.gh-t b{font-size:var(--fs-body);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gh-t small{font-size:var(--fs-small);color:var(--nav-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gh-car{color:var(--nav-muted);display:flex;flex:none}
.rail-row{display:flex;align-items:center;gap:4px}
.rail-small{flex:1;display:flex;align-items:center;gap:12px;height:36px;padding:0 12px;border-radius:var(--radius-md);color:var(--nav-muted);font-size:var(--fs-body)}
.rail-small:hover{color:var(--nav-text);background:color-mix(in srgb,var(--nav-text) 5%,transparent)}
.rail-exit{width:32px;height:32px;border-radius:var(--radius-sm);display:grid;place-items:center;color:var(--nav-muted);flex:none}
.rail-exit:hover{color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent)}
#app[data-navw=compact] .rail-row{flex-direction:column}
/* THE MODEL DASHBOARD WINDOW (\`lain model\` — #dashboard=<section>): the Model room alone, no rail, no menus. */
body.dashboard-mode #app{--nav-w:0px}
body.dashboard-mode #rail,body.dashboard-mode #menus,body.dashboard-mode #topSearch,body.dashboard-mode #surfCar,body.dashboard-mode #updateBtn,body.dashboard-mode #cuBtn{display:none!important}
.rail-fold{width:32px;height:32px;border-radius:var(--radius-sm);display:grid;place-items:center;color:var(--nav-muted);opacity:0;transition:opacity var(--t-hover) var(--ease)}
.rail-foot:hover .rail-fold,.rail-fold:focus-visible{opacity:1}
.rail-fold:hover{color:var(--nav-text);background:color-mix(in srgb,var(--nav-text) 6%,transparent)}
/* COMPACT: icons only, names in tooltips. */
#app[data-navw=compact] .rail-brand{padding:0;justify-content:center}
#app[data-navw=compact] .rb-word{font-size:0;letter-spacing:0}
#app[data-navw=compact] .rb-word::before{content:'L';font-size:16px;font-weight:700;letter-spacing:0}
#app[data-navw=compact] .rb-ver,#app[data-navw=compact] .rail-room{display:none}
#app[data-navw=compact] #tabs{padding:14px 10px 6px}
#app[data-navw=compact] .gtab{justify-content:center;padding:0}
#app[data-navw=compact] .gtab .lbl,#app[data-navw=compact] .rs-t,#app[data-navw=compact] .rail-card .rcd-b,#app[data-navw=compact] .rail-card .rcd-car,#app[data-navw=compact] .gh-t,#app[data-navw=compact] .gh-car,#app[data-navw=compact] .gh-mark{display:none}
#app[data-navw=compact] .rail-foot{padding:10px 8px 12px;align-items:center}
#app[data-navw=compact] .rail-card{display:grid;place-items:center;grid-template-columns:1fr;width:44px;height:44px;padding:0}
#app[data-navw=compact] .rail-card .rcd-ic{padding:0}
#app[data-navw=compact] .rail-gh{justify-content:center;width:44px;height:44px;padding:0}
#app[data-navw=compact] .rail-gh:not(.on) .gh-mark{display:flex}
#app[data-navw=compact] .rail-row{flex-direction:column}
#app[data-navw=compact] .rail-small{justify-content:center;padding:0;width:44px}
#app[data-navw=compact] .rail-fold{opacity:1}

/* ---- the top bar: the window's own title bar --------------------------------------------------------------- */
#topbar{display:flex;align-items:center;gap:6px;height:var(--topbar-h);padding:0 8px 0 14px;background:var(--canvas);color:var(--text-primary);min-width:0;user-select:none}
#app[data-tab=ide] #topbar{padding-left:10px}
#app:not([data-tab=ide]) #surfBtn,#app:not([data-tab=ide]) #menus,#app:not([data-tab=ide]) #topSearch{display:none}
.tb-drag{flex:1;align-self:stretch;min-width:12px}
.surf{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 10px;border-radius:var(--radius-sm);color:var(--nav-text)}
.surf:hover,.surf[aria-expanded=true]{background:color-mix(in srgb,var(--nav-text) 7%,transparent)}
.surf .rb-word{font-size:14px;letter-spacing:.3em}
.surf .rb-ver{margin-left:2px}
.sf-car{color:var(--nav-muted);display:inline-flex}
.surfpop{min-width:236px;padding:5px}
.surfpop button{display:flex;align-items:center;gap:12px;width:100%;padding:7px 10px;border-radius:var(--radius-sm);font-size:var(--fs-body);color:var(--text-primary);text-align:left}
.surfpop button:hover{background:var(--hover)}
.surfpop button[aria-current=true]{background:var(--selection);font-weight:600}
.surfpop button .k{margin-left:auto;color:var(--text-muted);font-size:var(--fs-caption)}
.surfpop .sep{height:1px;background:var(--separator);margin:4px 6px}
.menus{display:flex;gap:1px;margin-left:4px}
.mb{padding:5px 10px;border-radius:var(--radius-sm);color:var(--nav-muted);font-size:var(--fs-small)}
.mb:hover,.mb[aria-expanded=true]{background:color-mix(in srgb,var(--nav-text) 8%,transparent);color:var(--nav-text)}
.conn{font-size:var(--fs-small);color:var(--warning);white-space:nowrap}
.conn:empty{display:none}
.menu{position:fixed;z-index:70;min-width:240px;padding:5px;background:var(--surface-panel);border-radius:var(--radius-md);box-shadow:var(--shadow-float),0 0 0 1px var(--border-subtle);animation:lain-drop var(--t-drop) var(--ease)}
.menu button{display:flex;width:100%;align-items:center;gap:18px;padding:6px 10px;border-radius:var(--radius-sm);font-size:var(--fs-body);color:var(--text-primary);text-align:left}
.menu button:hover:not(:disabled){background:var(--hover)}
.menu button:disabled{color:var(--text-muted)}
.menu button .k{margin-left:auto;color:var(--text-muted);font-size:var(--fs-caption)}
.menu .sep{height:1px;background:var(--separator);margin:4px 6px}
.topsearch{display:flex;align-items:center;gap:9px;width:min(460px,34vw);height:32px;padding:0 12px;border-radius:var(--radius-md);background:color-mix(in srgb,var(--nav-text) 6%,transparent);box-shadow:inset 0 0 0 1px var(--separator);color:var(--nav-muted);font-size:var(--fs-small)}
.topsearch:hover{background:color-mix(in srgb,var(--nav-text) 9%,transparent);color:var(--nav-text)}
.topsearch .ts-t{flex:1;text-align:left;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.topsearch .kbd{background:color-mix(in srgb,var(--nav-text) 9%,transparent);color:var(--nav-muted)}
.tb-ib{width:36px;height:36px;border-radius:var(--radius-md);display:grid;place-items:center;color:var(--text-secondary);flex:none}
.tb-ib:hover{background:var(--hover);color:var(--text-primary)}
.tb-ib:active{transform:scale(.94)}
/* THE WINDOW BUTTONS — drawn like the system's, built into the bar. */
.winctl{display:flex;align-items:center;gap:2px;margin-left:4px;flex:none}
.winctl[hidden]{display:none}
.winctl button{width:42px;height:32px;border-radius:var(--radius-sm);display:grid;place-items:center;color:var(--text-secondary)}
.winctl button:hover{background:var(--hover);color:var(--text-primary)}
.winctl button.close:hover{background:#C42B1C;color:#fff}
.winctl svg{width:10px;height:10px}
/* THE TOP EDGE: a resize handle the width of the window (the caption's own was removed). */
.win-edge{position:fixed;left:0;right:0;top:0;height:4px;z-index:300;display:flex}
.win-edge[hidden]{display:none}
.win-edge i{display:block;height:100%}
.win-edge i[data-edge=top]{flex:1;cursor:ns-resize}
.win-edge i[data-edge=topleft]{width:10px;cursor:nwse-resize}
.win-edge i[data-edge=topright]{width:10px;cursor:nesw-resize}

/* ---- a sub-surface says where it lives ----------------------------------------------------------------------- */

@media (max-width: 1180px){.topsearch{width:min(300px,26vw);min-width:120px}.tracker .trk-x{display:none}}
@media (max-width: 960px){.topsearch .ts-t,.topsearch .kbd{display:none}.topsearch{width:auto}.tracker .trk-x{display:none}}
@media (max-width: 720px){.menus .mb:not(:first-child){display:none}.rb-ver{display:none}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var TABS = ['home', 'ide', 'chat', 'model', 'usage', 'mcp', 'settings'];
  var NAMES = { home: 'Home', ide: 'IDE', chat: 'Chat', model: 'Model', usage: 'Usage', mcp: 'Capabilities', settings: 'Settings', bot: 'Assistant', session: 'Sessions', ext: 'Extensions' };
  // SUB-SURFACES live under a room: the assistant under Settings, sessions under Chat. Extensions has no room of its own.
  var SUB = { bot: 'settings', session: 'chat', ext: '' };
  var ALL = TABS.concat(Object.keys(SUB));
  var tab = 'home';
  var shows = {};
  var navSeq = null;
  var previewSeen = null;
  // THE MODEL DASHBOARD WINDOW (`lain model|account|api|local` from the CLI): #dashboard=<section>, the Model room only.
  var DASHBOARD = (function () { var m = /^#dashboard=([a-z]+)$/.exec(location.hash || ''); return m ? m[1] : null; })();

  // ---- navigation ------------------------------------------------------------------------------------------
  function go(next, opts) {
    if (ALL.indexOf(next) < 0) return;
    if (DASHBOARD && next !== 'model') return;   // the Model Dashboard window shows the Model room only
    if (next === 'ext' && !$('vExt')) next = 'ide';
    L.closePop();
    closeMenu();
    var prev = tab;
    tab = next;
    var lit = SUB[tab] !== undefined ? SUB[tab] : tab;
    ALL.forEach(function (t) {
      var b = document.querySelector('.gtab[data-tab="' + t + '"]');
      if (b) b.setAttribute('aria-selected', String(t === lit));
      var v = $('v' + t.charAt(0).toUpperCase() + t.slice(1));
      if (v) {
        v.hidden = t !== tab;
        // A ROOM ARRIVES (≈220 ms, opacity and a few pixels): the new one only, never on a re-render.
        if (t === tab && prev !== tab) { v.classList.remove('entering'); void v.offsetWidth; v.classList.add('entering'); }
      }
    });
    foldFor(tab);
    $('app').setAttribute('data-tab', lit || tab);
    $('surfName').textContent = NAMES[tab] || tab;
    var S = L.state();
    // THE SESSION'S VIEW FOLLOWS THE ROOM — Core keys the workspace and the plan handoff on it. Navigation only.
    if (S && S.current && S.current.lane === 'engineering' && S.views && (tab === 'ide' || tab === 'chat')) {
      var want = tab === 'ide' ? 'coding' : 'chat';
      if (S.views.active !== want) L.api('/api/view/select', { view: want }).then(function () { L.poll(); }, function () { /* next poll */ });
    }
    (shows[tab] || []).forEach(function (fn) { try { fn(opts || {}); } catch (e) { if (window.console) console.error(e); } });
    paintRoom();
    L.render();
  }
  // THE RAIL'S WIDTH: none in the IDE; the Navigation preference elsewhere (expanded by default); compact when narrow.
  function navPref() { return document.documentElement.getAttribute('data-nav') === 'compact' ? 'compact' : 'expanded'; }
  function foldFor(t) {
    var w = t === 'ide' ? 'none' : window.innerWidth <= 1000 ? 'compact' : navPref();
    $('app').setAttribute('data-navw', w);
    var f = $('railFold');
    if (f) { f.setAttribute('data-tip', w === 'compact' ? 'Show names in the navigation' : 'Show icons only'); f.setAttribute('aria-label', w === 'compact' ? 'Expand navigation' : 'Collapse navigation'); }
    Array.prototype.forEach.call(document.querySelectorAll('.gtab'), function (b) { if (w === 'compact') b.setAttribute('data-tip', NAMES[b.getAttribute('data-tab')]); else b.removeAttribute('data-tip'); });
  }
  function toggleRail() {
    var next = navPref() === 'expanded' ? 'compact' : 'expanded';
    if (L.appearance && L.appearance.set) L.appearance.set({ nav: next }).then(function () { foldFor(tab); });
    else { document.documentElement.setAttribute('data-nav', next); foldFor(tab); }
  }
  L.nav = {
    go: go,
    tab: function () { return tab; },
    onShow: function (t, fn) { (shows[t] = shows[t] || []).push(fn); },
  };

  // ---- THE ROOM'S OWN LIST IN THE RAIL (L.rail.room) --------------------------------------------------------
  var rooms = {};
  /** A room puts its own list in the rail: draw(box, S) is called when the room is in front and on each render. */
  function paintRoom() {
    var box = $('railRoom');
    var r = rooms[SUB[tab] !== undefined ? (SUB[tab] || tab) : tab];
    if (!r) { if (!box.hidden) { box.hidden = true; box.textContent = ''; box.removeAttribute('data-room'); } return; }
    if (box.getAttribute('data-room') !== r.id) { box.textContent = ''; box.setAttribute('data-room', r.id); }
    box.hidden = false;
    try { r.draw(box, L.state() || {}); } catch (e) { if (window.console) console.error(e); }
  }
  L.rail = { room: function (id, draw) { rooms[id] = { id: id, draw: draw }; if (tab === id) paintRoom(); } };

  // ---- THE GITHUB IDENTITY (above Feedback) ---------------------------------------------------------------------
  var gh = null;
  var ghAt = 0;
  function loadGithub(force) {
    if (!force && Date.now() - ghAt < 5 * 60000) return;
    ghAt = Date.now();
    L.api('/api/github/status', {}).then(function (r) { gh = r && r.ok ? r.github : null; paintGithub(); }, function () { /* keep the last */ });
  }
  /** Settings › GitHub calls this after a switch, a new account or a forgotten one. */
  L.shellGithub = function () { loadGithub(true); };
  function paintGithub() {
    var b = $('railGh');
    var on = Boolean(gh && gh.connected);
    b.classList.toggle('on', on);
    var user = on ? (gh.user || 'GitHub') : '';
    var who = on && gh.accounts && gh.accounts.length ? gh.accounts.filter(function (a) { return a.active; })[0] : null;
    var n = on && gh.accounts ? gh.accounts.length : 0;
    $('railGhName').textContent = on ? ((who && who.name) || gh.name || user) : 'GitHub';
    // THE KNOWN USERNAME, and how many accounts LAIN holds when there are several.
    $('railGhSub').textContent = on ? '@' + user + (n > 1 ? ' · ' + n + ' accounts' : '') : 'Connect an account';
    var av = $('railGhAv');
    var pic = on ? ((who && who.avatar) || gh.avatar || '') : '';
    av.style.backgroundImage = pic ? 'url("' + pic + '")' : '';
    av.textContent = pic ? '' : (user ? user.charAt(0).toUpperCase() : '');
    b.setAttribute('data-tip', on ? 'GitHub · ' + user + (gh.via === 'gh' ? ' · signed in with GitHub CLI' : '') : 'Connect GitHub to open repositories as projects');
  }
  function githubMenu() {
    var on = Boolean(gh && gh.connected);
    var items = [];
    if (on) {
      items.push({ header: 'GitHub' });
      var list = gh.accounts && gh.accounts.length ? gh.accounts : [{ id: gh.active, name: gh.name || gh.user, login: gh.user, active: true }];
      list.forEach(function (a) {
        items.push({ label: (a.name || a.login) + (a.login && a.name && a.name !== a.login ? ' · @' + a.login : ''), note: a.active ? 'Active in LAIN' + (a.viaLabel ? ' · ' + a.viaLabel : '') : 'Switch to this account' + (a.viaLabel ? ' · ' + a.viaLabel : ''), checked: Boolean(a.active),
          run: function () {
            if (a.active) return;
            // LAIN'S ACTIVE ACCOUNT ONLY: GitHub CLI's own account and every repository's bound account stay as they are.
            L.api('/api/github/switch', { id: a.id }).then(function (r) { if (!r || !r.ok) L.toast((r && r.why) || 'could not switch', true); else L.toast('GitHub: @' + a.login + ' is active in LAIN'); loadGithub(true); });
          } });
      });
      items.push({ sep: true });
      items.push({ label: 'Open repositories', icon: 'folderopen', run: function () { if (L.github && L.github.pick) L.github.pick(); else go('settings', { section: 'github' }); } });
      items.push({ label: 'Connect another account', icon: 'plus', run: function () { go('settings', { section: 'github' }); } });
      items.push({ label: 'Manage GitHub', icon: 'gear', run: function () { go('settings', { section: 'github' }); } });
    } else {
      items.push({ label: 'Connect GitHub', note: 'GitHub CLI, or a token scoped to the repositories you choose', icon: 'plus', run: function () { go('settings', { section: 'github' }); } });
    }
    L.kit.menu($('railGh'), items, { prefer: 'above', cls: 'ghpop' });
  }

  // ---- THE WINDOW (the page draws the title bar; native/host.cs Frame) ------------------------------------------
  var win = { own: false, max: false };
  var GLYPH = {
    min: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1"/></svg>',
    max: '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    restore: '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y="2.5" width="7" height="7" rx="1.1" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5V1.6c0-.6.5-1.1 1.1-1.1h4.8c.6 0 1.1.5 1.1 1.1v4.8c0 .6-.5 1.1-1.1 1.1h-.9" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    close: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" stroke-width="1"/></svg>',
  };
  function paintWin() {
    $('winctl').hidden = !win.own;
    $('winEdge').hidden = !win.own || win.max;
    $('winMax').innerHTML = win.max ? GLYPH.restore : GLYPH.max;
    $('winMax').setAttribute('aria-label', win.max ? 'Restore' : 'Maximize');
    $('winMax').setAttribute('data-tip', win.max ? 'Restore Down' : 'Maximize');
  }
  L.win = {
    update: function (s) { if (s && typeof s.min === 'boolean') win.min = s.min; if (s && typeof s.max === 'boolean') win.max = s.max; if (s && typeof s.own === 'boolean') win.own = s.own; paintWin(); },
    state: function () { return { own: win.own, max: win.max, min: Boolean(win.min) }; },
  };
  function winDo(what, extra) { return L.hostCall('win', Object.assign({ do: what }, extra || {})).then(function (r) { if (r) L.win.update(r); return r; }); }
  /** EMPTY TITLE-BAR SPACE MOVES THE WINDOW: Windows' own loop takes the press, so snapping works as anywhere. */
  function onBarDown(e) {
    if (!win.own || e.button !== 0) return;
    var t = e.target;
    if (!t.closest || !t.closest('[data-drag]')) return;
    if (t.closest('button,input,select,textarea,a,[role=menubar] *')) return;
    if (e.detail > 1) return;   // the second press of a double-click is the maximise, not a drag
    winDo('drag');
  }
  function onBarDouble(e) {
    if (!win.own) return;
    var t = e.target;
    if (!t.closest || !t.closest('[data-drag]') || t.closest('button,input,select,textarea,a')) return;
    winDo('max');
  }

  // ---- the IDE's menus -------------------------------------------------------------------------------------
  var openMenuId = null;
  function menus() {
    var S = L.state() || {};
    var ide = tab === 'ide';
    var projectOpen = Boolean(S.workspace && S.workspace.project && S.workspace.project.attached);
    var cmd = function (label, key, run, enabled) { return { label: label, key: key || '', run: run, enabled: enabled !== false }; };
    // THE KEYMAP PRESET IN FORCE names the chords (core/keymap.js); unbound → no hint.
    var kb = function (id, fallback) { if (!L.keymap) return fallback; var b = L.keymap.bindings()[id]; return b === undefined ? fallback : (b || ''); };
    return {
      lain: [
        cmd('About LAIN', '', function () { var v = (S.product && S.product.version) || ''; L.dialog({ title: 'LAIN' + (v ? ' ' + v : ''), text: 'A persistent AI workspace. The Harness draws; LAIN Core owns every piece of state.', ok: 'Close', cancel: 'Diagnostics' }).then(function (x) { if (x === false) diagnostics(); }); }),
        cmd('Settings', kb('settings', 'Alt+7'), function () { go('settings'); }),
        null,
        cmd('Close window', '', function () { L.hostCall('hide', {}); }),
        cmd('Exit LAIN', '', function () { if (L.update) L.update.exit(); }),
      ],
      file: [
        cmd('New Project…', kb('project.new', 'Ctrl+Shift+N'), function () { L.ide.newProject(); }),
        cmd('Open Project…', kb('project.open', 'Ctrl+O'), function () { L.ide.openProject(); }),
        cmd('New Chat', kb('chat.new', ''), function () { L.chat.newChat(); }),
        null,
        cmd('Open File…', kb('quickOpen', 'Ctrl+P'), function () { go('ide'); L.ide.quickOpen(); }, projectOpen),
        cmd('Save', 'Ctrl+S', function () { L.source.save(false); }, ide && projectOpen),
        cmd('Close Editor', kb('editor.close', 'Ctrl+W'), function () { L.ide.closeEditor(); }, ide && projectOpen),
      ],
      edit: [
        cmd('Undo', 'Ctrl+Z', function () { document.execCommand('undo'); }),
        cmd('Redo', 'Ctrl+Y', function () { document.execCommand('redo'); }),
        null,
        cmd('Find in File', 'Ctrl+F', function () { L.ide.find(); }, ide && projectOpen),
        cmd('Search LAIN', kb('search', 'Ctrl+K'), function () { L.search.palette(''); }),
        cmd('Command Palette', kb('palette', 'Ctrl+Shift+P'), function () { L.search.palette('>'); }),
      ],
      view: TABS.map(function (t, i) { return cmd(NAMES[t], 'Alt+' + (i + 1), function () { go(t); }); })
        .concat([null,
          cmd('Interface Scale +', 'Ctrl+=', function () { L.appearance.step(1); }),
          cmd('Interface Scale −', 'Ctrl+-', function () { L.appearance.step(-1); }),
          cmd('Reset Interface Scale', 'Ctrl+0', function () { L.appearance.step(0); }),
          cmd('Compact / Expanded Navigation', '', toggleRail),
          cmd(document.documentElement.getAttribute('data-mode') === 'light' ? 'Dark Mode' : 'Light Mode', '', function () { if (L.appearance.toggleMode) L.appearance.toggleMode(); }),
          null,
          cmd('Toggle Side Bar', kb('sidebar', 'Ctrl+B'), function () { go('ide'); L.ide.toggleSide(); }, projectOpen),
          cmd('Toggle Panel', kb('panel', 'Ctrl+J'), function () { go('ide'); L.ide.togglePanel(); }, projectOpen),
          cmd('Toggle Agent Sidecar', kb('agent.toggle', 'Ctrl+Alt+B'), function () { go('ide'); L.ide.toggleBot(); }, projectOpen),
        ]),
      help: [
        cmd('Keyboard Shortcuts', '', function () { go('settings', { section: 'shortcuts' }); }),
        cmd('Send Feedback…', '', function () { if (L.feedback) L.feedback.open(); }),
        cmd('Diagnostics', '', function () { diagnostics(); }),
      ],
    };
  }
  function openMenu(id, anchor) {
    var drop = $('menuDrop');
    drop.textContent = '';
    (menus()[id] || []).forEach(function (it) {
      if (!it) { drop.appendChild(el('div', 'sep')); return; }
      var b = el('button', '');
      b.appendChild(el('span', '', it.label));
      if (it.key) b.appendChild(el('span', 'k', it.key));
      b.disabled = !it.enabled;
      b.onclick = function () { closeMenu(); it.run(); };
      drop.appendChild(b);
    });
    drop.hidden = false;
    var r = anchor.getBoundingClientRect();
    drop.style.left = Math.min(r.left, window.innerWidth - drop.offsetWidth - 8) + 'px';
    drop.style.top = (r.bottom + 4) + 'px';
    Array.prototype.forEach.call(document.querySelectorAll('.mb'), function (m) { m.setAttribute('aria-expanded', String(m === anchor)); });
    openMenuId = id;
  }
  function closeMenu() {
    var d = $('menuDrop');
    if (d) d.hidden = true;
    openMenuId = null;
    Array.prototype.forEach.call(document.querySelectorAll('.mb'), function (m) { m.setAttribute('aria-expanded', 'false'); });
  }

  function diagnostics() {
    var S = L.state() || {};
    var e = (S.diagnostics && S.diagnostics.environment) || S.environment || {};
    var ex = S.execution || {};
    var lines = [
      'LAIN: ' + ((S.product && S.product.version) || 'unknown version'),
      'Environment: ' + (e.kind === 'vm' ? 'VM' : 'Host'),
      'Browser: ' + (e.browser ? (e.browser.owned ? 'LAIN-owned Chromium ' : 'Borrowed browser ') + (e.browser.version || '') : (e.why || 'none')),
      'Running: ' + ((e.running || []).join(', ') || 'nothing'),
      'Session status: ' + (ex.word || 'READY') + (ex.detail ? ' — ' + ex.detail : ''),
    ];
    L.dialog({ title: 'Diagnostics', text: lines.join('\n'), ok: 'Close', cancel: 'Close' });
  }

  /** THE SWITCHER (the IDE's LAIN mark): every room, and LAIN's own commands. */
  function openSwitcher() {
    var btn = $('surfBtn');
    L.popover(btn, function (p) {
      TABS.forEach(function (t, i) {
        var b = el('button', ''); b.appendChild(L.icon(t, 17)); b.appendChild(el('span', '', NAMES[t])); b.appendChild(el('span', 'k', 'Alt+' + (i + 1)));
        b.setAttribute('aria-current', String((SUB[tab] !== undefined ? SUB[tab] : tab) === t));
        b.onclick = function () { L.closePop(); go(t); };
        p.appendChild(b);
      });
      p.appendChild(el('div', 'sep'));
      menus().lain.forEach(function (it) {
        if (!it) { p.appendChild(el('div', 'sep')); return; }
        var b = el('button', ''); b.appendChild(el('span', '', it.label)); if (it.key) b.appendChild(el('span', 'k', it.key));
        b.onclick = function () { L.closePop(); it.run(); };
        p.appendChild(b);
      });
    }, { cls: 'gpop surfpop', toggle: true });
  }

  // ---- light / dark ---------------------------------------------------------------------------------------------
  function paintTheme() {
    var light = document.documentElement.getAttribute('data-mode') === 'light';
    var b = $('themeBtn');
    b.textContent = '';
    b.appendChild(L.icon(light ? 'moon' : 'sun', 18));
    b.setAttribute('data-tip', light ? 'Dark mode' : 'Light mode');
    b.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
  }

  function paintBrand(S) {
    var v = (S && S.product && S.product.version) || '';
    // "v2.0 alpha" — the release line; the whole version is in the tooltip and in About.
    var m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([a-z]+))?/i.exec(v);
    var shortV = m ? 'v' + m[1] + '.' + m[2] + (m[3] && m[3] !== '0' ? '.' + m[3] : '') + (m[4] ? ' ' + m[4] : '') : '';
    if ($('railVer').textContent !== shortV) { $('railVer').textContent = shortV; $('surfVer').textContent = shortV; $('railVer').title = v ? 'LAIN ' + v : ''; }
  }

  // ---- keys ------------------------------------------------------------------------------------------------
  function keys(e) {
    var k = e.key;
    var ctrl = e.ctrlKey || e.metaKey;
    if (e.altKey && !ctrl && /^[1-7]$/.test(k)) { e.preventDefault(); go(TABS[Number(k) - 1]); return; }
    if (ctrl && !e.shiftKey && (k === 'k' || k === 'K')) { e.preventDefault(); L.search.palette(''); return; }
    if (ctrl && e.shiftKey && (k === 'P' || k === 'p')) { e.preventDefault(); L.search.palette('>'); return; }
    if (ctrl && e.shiftKey && (k === 'N' || k === 'n')) { e.preventDefault(); L.ide.newProject(); return; }
    if (ctrl && !e.shiftKey && (k === 'o' || k === 'O')) { e.preventDefault(); L.ide.openProject(); return; }
    if (k === 'Escape' && openMenuId) closeMenu();
  }

  L.onBoot(function () {
    Array.prototype.forEach.call(document.querySelectorAll('.gtab'), function (b) {
      var t = el('span', 'lbl', b.textContent); b.textContent = '';
      b.appendChild(L.icon(b.getAttribute('data-tab'), 20)); b.appendChild(t);
      b.setAttribute('aria-label', t.textContent);
      b.onclick = function () { go(b.getAttribute('data-tab')); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('.mb'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); if (openMenuId === b.getAttribute('data-menu')) closeMenu(); else openMenu(b.getAttribute('data-menu'), b); };
      b.onmouseenter = function () { if (openMenuId && openMenuId !== b.getAttribute('data-menu')) openMenu(b.getAttribute('data-menu'), b); };
    });
    document.addEventListener('mousedown', function (e) {
      if (openMenuId && !$('menuDrop').contains(e.target) && !e.target.closest('.mb')) closeMenu();
    });
    document.addEventListener('keydown', keys);
    $('surfCar').appendChild(L.icon('down', 13));
    $('surfBtn').onclick = openSwitcher;
    $('topSearchIc').appendChild(L.icon('search', 14));
    $('railExtIc').appendChild(L.icon('box', 20));
    $('railExtCar').appendChild(L.icon('chevron', 15));
    $('railGhMark').appendChild(L.icon('github', 20));
    $('railGhCar').appendChild(L.icon('down', 15));
    $('railFeedbackIc').appendChild(L.icon('feedback', 18));
    $('railFold').appendChild(L.icon('sidebar', 16));
    $('railFold').onclick = toggleRail;
    $('railFeedback').onclick = function () { if (L.feedback) L.feedback.open(); };
    $('railExit').appendChild(L.icon('power', 17));
    $('railExit').onclick = function () { if (L.update) L.update.exit(); };
    $('updateIc').appendChild(L.icon('update', 15));
    $('updateBtn').onclick = function (e) { e.stopPropagation(); if (L.update) L.update.open($('updateBtn')); };
    $('cuBtn').onclick = function (e) { e.stopPropagation(); if (L.computer) L.computer.open($('cuBtn')); };
    $('railExt').onclick = function () { go('ext'); };
    $('railExt').setAttribute('data-tip', 'Extensions');
    $('railGh').onclick = function (e) { e.stopPropagation(); githubMenu(); };
    $('topSearch').onclick = function () { L.search.palette(''); };
    $('themeBtn').onclick = function () { if (L.appearance && L.appearance.toggleMode) L.appearance.toggleMode().then(paintTheme, paintTheme); };
    $('winMin').innerHTML = GLYPH.min; $('winMin').setAttribute('data-tip', 'Minimize');
    $('winClose').innerHTML = GLYPH.close; $('winClose').setAttribute('data-tip', 'Close — LAIN keeps running in the tray');
    $('winMin').onclick = function () { winDo('min'); };
    $('winMax').onclick = function () { winDo('max'); };
    $('winClose').onclick = function () { winDo('close'); };
    Array.prototype.forEach.call($('winEdge').children, function (i) {
      i.addEventListener('pointerdown', function (e) { if (e.button === 0) { e.preventDefault(); winDo('resize', { edge: i.getAttribute('data-edge') }); } });
    });
    document.addEventListener('pointerdown', onBarDown);
    document.addEventListener('dblclick', onBarDouble);
    // THE HOST SAYS WHETHER IT LEFT THE TITLE BAR TO THE PAGE (null: a host that predates it — the system caption stays).
    winDo('state');
    paintWin();
    paintTheme();
    if (L.appearance && L.appearance.onChange) L.appearance.onChange(function () { foldFor(tab); paintTheme(); });
    // THE DASHBOARD'S SECTION is applied once every room has booted (the Model room listens for it in its own boot).
    if (DASHBOARD) { document.body.classList.add('dashboard-mode'); go('model'); setTimeout(function () { go('model', { section: DASHBOARD }); }, 0); } else go('home');
    window.addEventListener('resize', function () { foldFor(tab); });
    // STARTUP REFRESH, NEVER IN THE WAY: the window is drawn from local state; the rest reads behind it.
    // THE PROVIDERS' CATALOGS are re-read once at start (Core appcatalog), then the fabric is drawn from them.
    setTimeout(function () { L.api('/api/accounts/refresh', { force: false }).then(function () { if (L.intel) L.intel.load(true); }, function () {}); }, 400);
    setTimeout(function () { if (L.intel) L.intel.load().then(function () { L.render(); }); }, 700);
    setTimeout(function () { if (L.tools) L.tools.load(); }, 900);
    setTimeout(function () { loadGithub(true); }, 1500);
    setTimeout(function () { if (L.bot) L.bot.load(false); }, 3000);
    setInterval(function () { if (L.intel) L.intel.load(true); }, 120000);
  });

  var lastState = '';
  L.onRender(function (S) {
    paintBrand(S);
    paintRoom();
    loadGithub(false);
    $('conn').textContent = '';
    // A TURN FINISHED: quota may have moved, so the families read again.
    var st = S.header && S.header.status ? S.header.status.state : '';
    if (lastState === 'RUNNING' && st !== 'RUNNING' && L.intel) L.intel.load(true);
    lastState = st;
    // CORE ASKED THE WINDOW TO GO SOMEWHERE (a door, `lain path`, /account add) — applied once per request.
    var n = S.navigate;
    // A WINDOW OPENED BY THE REQUEST honours it once if it is seconds old; an older one is history, not a request.
    var fresh = n && n.at && Date.now() - n.at < 15000;
    if (navSeq === null && !fresh) navSeq = n ? n.seq : 0;
    else if (n && n.seq > (navSeq || 0)) {
      navSeq = n.seq;
      if (!(n.capability && L.house && L.house.run(n.capability, n.args || {}))) go(n.surface, Object.assign({}, n.args || {}, { section: n.section }));
    }
    // `lain preview` WHILE THIS LAIN RUNS: the IDE with its Preview open — once per request, like navigate above.
    var pw = S.surface && S.surface.previewWanted;
    if (previewSeen === null) previewSeen = pw && Date.now() - pw < 15000 ? 0 : (pw || 0);
    if (pw && pw > previewSeen && !DASHBOARD) { previewSeen = pw; go('ide'); if (L.workshop && L.workshop.open) L.workshop.open(); }
    if (L.update) L.update.paint(S);
    if (L.computer) L.computer.paint(S);
  });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
