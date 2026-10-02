'use strict';

/**
 * HOME — where LAIN starts (2026-09-30, after the product mockups).
 *
 *   Good evening.
 *   What will you build today?
 *   [⌕ Ask LAIN anything or search projects, files, models…            Ctrl K]
 *   ┌ ● Current focus ───────────────────────┐ ┌ ⚡ Quick actions ─────────────┐
 *   │ game-decoder                     ◯      │ │ [+ New Project ›][▢ Start Chat›]│
 *   │ Continue the standalone decoder…  ╲╲    │ │ [‹› Open IDE  ›][≋ Models    ›]│
 *   │ [Open project] [Start a chat]           │ │ [⬡ Extensions ›][⑂ GitHub    ›]│
 *   └─────────────────────────────────────────┘ └───────────────────────────────┘
 *   ┌ ⏱ Recent projects ─────────── View all → ┐ ┌ ≋ System status ● operational ┐
 *   │ ▣ cheate  Continue the…  ● Coding Agent 2h│ │ Core · Providers · MCP · Ext. │
 *   └───────────────────────────────────────────┘ └───────────────────────────────┘
 *   ┌ Recent chats ──────┐ ┌ Explore extensions ─────────────┐ ┌ Tips ‹ › ┐
 *
 * FLAT PLANES ON THE CANVAS, one tinted (the focus). The GitHub identity lives
 * in the rail, above Feedback (shell/shell.js).
 *
 * EVERY FIGURE IS READ FROM ITS OWNER: the project and the work from Core's
 * polled state, providers from the fabric, MCP from L.tools, extensions from
 * Core's extension store (local reads — Home never searches a marketplace on
 * its own). Nothing is invented to fill a plane; an empty one says so.
 *
 * The search box is L.search (shell/search.js): the same index as Ctrl K.
 */

const HTML = `
<section class="view home" id="vHome" data-view="home" hidden>
  <div class="home-in">
    <h1 class="greet" id="greet">Hello<span class="gdot">.</span></h1>
    <p class="greet-sub" id="greetSub">What will you build today?</p>
    <div class="hsearch" id="hsearchBox">
      <span class="hs-ic" id="hsIcon"></span>
      <input id="hsearch" placeholder="Ask LAIN anything or search projects, files, models…" autocomplete="off" spellcheck="false">
      <span class="kbd">Ctrl K</span>
      <div class="hresults" id="hresults" hidden></div>
    </div>
    <div class="home-grid">
      <div class="u-plane hfocus" id="homeFocus" data-plane="focus"></div>
      <div class="u-plane hqa" data-plane="actions"><div class="hh"><span class="hh-ic" id="qaIc"></span><b>Quick actions</b></div><div id="homeActions" class="qgrid"></div></div>
      <div class="u-plane hproj" data-plane="projects"><div class="hh"><span class="hh-ic" id="rpIc"></span><b>Recent projects</b><button class="u-link" id="homeAllProjects">Open folder…</button></div><div id="homeProjects" class="hlist"></div></div>
      <div class="u-plane hstat" data-plane="status"><div class="hh"><span class="hh-ic" id="ssIc"></span><b>System status</b><span class="hh-ok" id="homeStatusSum"></span></div><div id="homeStatus" class="hstatus"></div></div>
      <div class="u-plane hchats" data-plane="chats"><div class="hh"><span class="hh-ic" id="rcIc"></span><b>Recent chats</b><button class="u-link" id="homeAllChats">View all →</button></div><div id="homeSessions" class="hlist compact"></div></div>
      <div class="u-plane hext" data-plane="extensions"><div class="hh"><span class="hh-ic" id="exIc"></span><b>Explore extensions</b><button class="u-link" id="homeAllExt">View all →</button></div><div id="homeExt" class="xgrid"></div></div>
      <div class="u-plane htips" data-plane="tips"><div class="hh"><span class="hh-ic" id="tpIc"></span><b>Tips</b><span class="tip-nav"><button class="u-ib" id="tipPrev" aria-label="Previous tip"></button><button class="u-ib" id="tipNext" aria-label="Next tip"></button></span></div><div id="homeTip" class="tipbody"></div></div>
    </div>
  </div>
</section>`;

const CSS = `
.home{overflow-y:auto;container-type:inline-size}
.home-in{max-width:1180px;margin:0 auto;padding:30px 36px 40px}
.greet{font:600 var(--fs-display)/1.1 var(--display);letter-spacing:-.02em;margin:0;color:var(--text-primary)}
.greet .gdot{color:var(--accent-primary)}
.greet-sub{margin:8px 0 20px;color:var(--text-secondary);font-size:var(--fs-lead)}
.hsearch{position:relative;display:flex;align-items:center;gap:12px;height:48px;padding:0 10px 0 16px;margin:0 0 20px;background:var(--surface-base);border-radius:var(--radius-md);box-shadow:inset 0 0 0 1px var(--border-subtle);transition:box-shadow var(--t-hover) var(--ease)}
.hsearch:focus-within{box-shadow:inset 0 0 0 1px var(--accent-border),0 0 0 3px color-mix(in srgb,var(--accent-primary) 10%,transparent)}
.hsearch input{flex:1;min-width:0;font-size:var(--fs-lead)}
.hsearch input::placeholder{color:var(--text-muted)}
.hs-ic{color:var(--text-muted);display:flex}
.hresults{position:absolute;left:0;right:0;top:54px;z-index:30;background:var(--surface-panel);border-radius:var(--radius-lg);box-shadow:var(--shadow-float),0 0 0 1px var(--border-subtle);max-height:420px;overflow-y:auto;padding:5px;animation:lain-drop var(--t-drop) var(--ease)}
.home-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px}
.home-grid > .u-plane + .u-plane{margin-top:0}
.hfocus{grid-column:span 7} .hqa{grid-column:span 5}
.hproj{grid-column:span 7} .hstat{grid-column:span 5}
.hchats{grid-column:span 4} .hext{grid-column:span 5} .htips{grid-column:span 3}
.home .u-plane{padding:16px 18px;border-radius:var(--radius-lg);box-shadow:inset 0 0 0 1px var(--separator)}
.hh{display:flex;align-items:center;gap:10px;margin:0 0 12px;min-height:26px}
.hh b{font-size:var(--fs-h3);font-weight:600;color:var(--text-primary)}
.hh .hh-ic{display:flex;color:var(--accent-primary)}
.hh .u-link{margin-left:auto;color:var(--text-secondary)}
.hh .u-link:hover{color:var(--text-primary);text-decoration:none}
.hh .hh-ok{margin-left:auto;display:inline-flex;align-items:center;gap:7px;font-size:var(--fs-small);color:var(--positive)}
.hh .hh-ok.warn{color:var(--warning)}

/* CURRENT FOCUS — the one tinted plane, with a quiet drawing on its right. */
.hfocus{position:relative;overflow:hidden;display:flex;flex-direction:column;min-height:226px;padding:20px 24px 22px;background:var(--plane-teal)}
.hfocus .fk{display:flex;align-items:center;gap:8px;font-size:var(--fs-small);color:var(--text-secondary);font-weight:500}
.hfocus .fk .u-dot{background:var(--accent-primary)}
.hfocus .ft{position:relative;font:600 26px/1.2 var(--display);letter-spacing:-.01em;margin:12px 0 6px;overflow-wrap:anywhere;color:var(--text-primary);max-width:62%}
.hfocus .fs{position:relative;font-size:var(--fs-lead);line-height:1.5;color:var(--text-secondary);max-width:min(52ch,62%)}
.hfocus .fstat{position:relative;display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:10px 0 0;font-size:var(--fs-small);color:var(--text-secondary);max-width:64%}
.hfocus .fstat span{display:inline-flex;align-items:center;gap:6px;min-width:0}
.hfocus .fstat span.path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hfocus .facts{position:relative;display:flex;gap:10px;flex-wrap:wrap;margin-top:auto;padding-top:20px}
.hfocus .facts .u-btn{padding:9px 16px;font-size:var(--fs-body)}
.hfocus .facts .u-btn:not(.pri){background:color-mix(in srgb,var(--canvas) 55%,transparent);box-shadow:inset 0 0 0 1px var(--border-subtle)}
.hfocus .facts .u-btn:not(.pri):hover{background:color-mix(in srgb,var(--canvas) 75%,transparent)}
.hfocus .fart{position:absolute;right:-6px;top:0;bottom:0;width:38%;pointer-events:none;color:var(--accent-secondary);opacity:.9}
.hfocus .fart svg{width:100%;height:100%}

/* QUICK ACTIONS — 2 × 3 raised tiles, each a door. */
.qgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.qtile{display:flex;align-items:center;gap:11px;min-width:0;height:48px;padding:0 12px 0 14px;border-radius:var(--radius-md);background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--separator);color:var(--text-primary);font-size:var(--fs-body);font-weight:500;text-align:left;transition:background var(--t-hover) var(--ease),transform var(--t-hover) var(--ease)}
.qtile:hover{background:var(--surface-active)}
.qtile:active{transform:scale(.98)}
.qtile .ic{color:var(--text-secondary);flex:none}
.qtile .ql{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qtile .car{color:var(--text-muted);display:flex;flex:none}
.qtile.q-pri{background:var(--accent-weak);box-shadow:inset 0 0 0 1px var(--accent-border)}
.qtile.q-pri .ic{color:var(--accent-primary)}
.hqa{container-type:inline-size}
@container (max-width: 400px){.qtile .car{display:none}.qtile{padding:0 10px;gap:8px}}

/* RECENT PROJECTS / CHATS — rows, hairline-separated. */
.hlist .hrow{display:grid;grid-template-columns:32px minmax(0,1fr) auto auto 28px;gap:12px;align-items:center;padding:8px 2px;border-radius:0;font-size:var(--fs-body);color:var(--text-primary)}
.hlist .hrow + .hrow{border-top:1px solid var(--separator)}
.hlist .hrow:hover{background:transparent}
.hlist .hrow:hover .ht > b{color:var(--accent-primary)}
.hlist .hrow .pic{width:32px;height:32px;border-radius:var(--radius-sm);display:grid;place-items:center;background:var(--secondary-weak);color:var(--accent-secondary)}
.hlist .hrow:nth-child(3n+2) .pic{background:var(--accent-weak);color:var(--accent-primary)} .hlist .hrow:nth-child(3n) .pic{background:color-mix(in srgb,var(--info) 14%,transparent);color:var(--info)}
.hlist .hrow .ht{min-width:0;display:flex;flex-direction:column}
.hlist .hrow .ht > b{font-size:var(--fs-body);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color var(--t-hover) var(--ease)}
.hlist .hrow .ht small{font-size:var(--fs-small);color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hlist .hrow .where{display:inline-flex;align-items:center;gap:7px;font-size:var(--fs-small);color:var(--text-secondary);white-space:nowrap}
.hlist .hrow .where .u-dot.run{background:var(--accent-primary);animation:lain-pulse 1.6s var(--ease) infinite}
.hlist .hrow .hm{font-size:var(--fs-small);color:var(--text-muted);white-space:nowrap;min-width:48px;text-align:right}
.hlist .hrow .more{width:28px;height:28px}
.hlist .none{padding:8px 0;font-size:var(--fs-body);color:var(--text-secondary)}
.hlist.compact .hrow{grid-template-columns:22px minmax(0,1fr) auto;gap:10px;padding:7px 2px}
.hlist.compact .hrow .pic{width:22px;height:22px;background:none!important;color:var(--text-secondary)!important}
.hlist.compact .hrow .ht > b{font-weight:500}

/* SYSTEM STATUS */
.hstatus .srow2{display:grid;grid-template-columns:34px minmax(0,1fr) auto 14px;gap:12px;align-items:center;width:100%;padding:8px 0;text-align:left}
.hstatus .srow2 + .srow2{border-top:1px solid var(--separator)}
.hstatus .si{width:34px;height:34px;border-radius:var(--radius-sm);display:grid;place-items:center;background:var(--surface-raised);color:var(--text-secondary)}
.hstatus .si.ok{background:var(--secondary-weak);color:var(--accent-secondary)} .hstatus .si.warn{background:var(--warning-weak);color:var(--warning)} .hstatus .si.bad{background:var(--danger-weak);color:var(--danger)}
.hstatus .sn{min-width:0;font-size:var(--fs-body);font-weight:500;color:var(--text-primary)}
.hstatus .sn small{display:block;font-size:var(--fs-small);font-weight:400;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hstatus .sv{display:inline-flex;align-items:center;gap:7px;font-size:var(--fs-small);color:var(--text-secondary);white-space:nowrap}
.hstatus .chev{color:var(--text-muted);display:flex}
.hstatus .srow2:hover .chev{color:var(--text-primary)}
.hstatus .srow2:hover .sn{color:var(--accent-primary)}

/* EXPLORE EXTENSIONS — small cards. */
.xgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.xcard{display:flex;flex-direction:column;gap:6px;min-height:118px;padding:12px;border-radius:var(--radius-md);background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--separator);text-align:left}
.xcard .xi{display:flex;align-items:center;gap:8px;min-width:0}
.xcard .xi .ic{color:var(--accent-secondary);flex:none}
.xcard .xi b{font-size:var(--fs-small);font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xcard small{font-size:var(--fs-caption);color:var(--text-secondary);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.xcard .u-btn{margin-top:auto;align-self:flex-start}
.xempty{font-size:var(--fs-small);color:var(--text-secondary);line-height:1.5}
.xempty .u-btn{margin-top:10px}

/* TIPS */
.tip-nav{margin-left:auto;display:flex;gap:2px}
.tip-nav .u-ib{width:26px;height:26px}
.tipbody{font-size:var(--fs-body);line-height:1.55;color:var(--text-secondary);animation:lain-fade var(--t-panel) var(--ease)}
.tipbody b{color:var(--text-primary);font-weight:600}
.tipbody .kbd{margin:0 2px}

@container (max-width: 1060px){.hchats{grid-column:span 6}.hext{grid-column:span 6}.htips{grid-column:span 12}}
@container (max-width: 860px){.hfocus,.hqa,.hproj,.hstat,.hchats,.hext,.htips{grid-column:span 12}.hfocus .ft,.hfocus .fs{max-width:none}.hfocus .fart{opacity:.35}}
@container (max-width: 560px){.home-in{padding:20px 16px 28px}.greet{font-size:26px}.qgrid{grid-template-columns:1fr}.hlist .hrow{grid-template-columns:32px minmax(0,1fr) auto}.hlist .hrow .where,.hlist .hrow .more{display:none}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var NS = 'http://www.w3.org/2000/svg';

  function greeting() {
    var h = new Date().getHours();
    return h < 5 ? 'Good night.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
  }
  /** A session's name as a person reads it — an empty one is a new conversation, not a sentence about tasks. */
  function titleOf(s) { var t = s && s.title; return !t || t === '(no task was ever started)' ? 'New conversation' : t; }
  function ago(ms) {
    if (!ms) return '';
    var d = Date.now() - ms;
    if (d < 60000) return 'now';
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    if (d < 7 * 86400000) return Math.floor(d / 86400000) + 'd ago';
    return new Date(ms).toLocaleDateString();
  }

  /** THE FOCUS PLANE'S DRAWING — a disc and a few fast strokes; LAIN-drawn, no artwork is bundled. */
  function focusArt() {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 320 220'); s.setAttribute('preserveAspectRatio', 'xMaxYMid slice'); s.setAttribute('aria-hidden', 'true');
    var add = function (tag, a) { var n = document.createElementNS(NS, tag); Object.keys(a).forEach(function (k) { n.setAttribute(k, a[k]); }); s.appendChild(n); return n; };
    add('circle', { cx: 236, cy: 86, r: 46, fill: 'currentColor', opacity: '.85' });
    add('circle', { cx: 236, cy: 86, r: 70, fill: 'none', stroke: 'currentColor', 'stroke-width': '1', opacity: '.18' });
    add('circle', { cx: 236, cy: 86, r: 96, fill: 'none', stroke: 'currentColor', 'stroke-width': '1', opacity: '.08' });
    // FAST STROKES toward the disc — motion, not a figure.
    [[96, 58, 96], [60, 88, 118], [118, 112, 64], [84, 138, 112], [140, 166, 92]].forEach(function (l, i) {
      add('path', { d: 'M' + l[0] + ' ' + l[1] + 'h' + l[2], stroke: 'currentColor', 'stroke-width': i % 2 ? '1.5' : '2.25', 'stroke-linecap': 'round', opacity: String(0.14 + (i % 3) * 0.1) });
    });
    add('path', { d: 'M150 200c34-20 72-24 118-12', stroke: 'currentColor', 'stroke-width': '1.5', fill: 'none', 'stroke-linecap': 'round', opacity: '.28' });
    return s;
  }

  // ---- CURRENT FOCUS: this conversation's project and where its work stands ---------------------------------------
  function renderFocus(S) {
    var box = $('homeFocus');
    var p = (S.workspace && S.workspace.project) || {};
    var W = S.workbench || {};
    var cur = L.sessions && L.sessions.all ? L.sessions.all().filter(function (s) { return s.current; })[0] : null;
    var title = p.attached ? p.name : 'No project yet';
    var sub = p.attached
      ? (cur && cur.title && cur.title !== '(no task was ever started)' ? cur.title : 'Attached to this conversation — Chat plans, the Coding Agent works in it.')
      : 'Start a chat, or open a project so the Coding Agent can work in it.';
    var sig = JSON.stringify([title, sub, W.status, W.running, p.root, p.github]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    var art = el('div', 'fart'); art.appendChild(focusArt()); box.appendChild(art);
    var k = el('div', 'fk'); k.appendChild(L.kit.dot(W.running ? 'acc' : '')); k.appendChild(document.createTextNode('Current focus')); box.appendChild(k);
    box.appendChild(el('div', 'ft', title));
    box.appendChild(el('div', 'fs', sub));
    if (p.attached) {
      var stt = el('div', 'fstat');
      var s1 = el('span', ''); s1.appendChild(L.kit.dot(W.running ? 'acc' : 'ok')); s1.appendChild(document.createTextNode(W.status || 'Idle')); stt.appendChild(s1);
      var s2 = el('span', 'path'); s2.appendChild(L.icon('folder', 14)); s2.appendChild(document.createTextNode(p.root || '')); s2.title = p.root || ''; stt.appendChild(s2);
      if (p.github) { var s3 = el('span', ''); s3.appendChild(L.icon('github', 14)); s3.appendChild(document.createTextNode(p.github)); stt.appendChild(s3); }
      box.appendChild(stt);
    }
    var acts = el('div', 'facts');
    if (p.attached) {
      acts.appendChild(L.kit.button('Continue in Chat', 'pri', function () { L.nav.go('chat'); }, 'chat'));
      acts.appendChild(L.kit.button('Open in IDE', '', function () { L.ide.open(p.root); }, 'ide'));
    } else {
      acts.appendChild(L.kit.button('Open project', 'pri', function () { L.ide.openProject(); }, 'folder'));
      acts.appendChild(L.kit.button('Start a chat', '', function () { L.nav.go('chat'); if (L.chat) L.chat.newChat(); }, 'chat'));
    }
    box.appendChild(acts);
  }

  // ---- RECENT PROJECTS: where each one was last worked on --------------------------------------------------------
  function sameDir(a, b) { return String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase(); }
  function projectMenu(anchor, p, latest) {
    L.kit.menu(anchor, [
      { label: 'Open in IDE', icon: 'ide', run: function () { L.ide.open(p.root); } },
      latest ? { label: 'Continue in Chat', note: latest.title, icon: 'chat', run: function () { L.sessions.select(latest.id).then(function () { L.nav.go('chat'); }); } } : null,
      { label: 'Copy path', icon: 'link', run: function () { try { navigator.clipboard.writeText(p.root); L.toast('Copied ' + p.root); } catch (e) { L.toast(p.root); } } },
    ], { alignRight: true });
  }
  function renderProjects() {
    var recent = L.search.recent();
    var box = $('homeProjects');
    var rp = ((recent && recent.recent) || []).slice(0, 5);
    var sessions = L.sessions ? L.sessions.all() : [];
    var rows = rp.map(function (p) {
      var mine = sessions.filter(function (s) { return s.cwd && sameDir(s.cwd, p.root); });
      var latest = mine[0] || null;
      var busy = mine.filter(function (s) { return s.live && (s.status === 'RUNNING' || s.status === 'VERIFYING'); })[0];
      return { p: p, latest: latest, busy: busy, at: Math.max(p.lastUsed || 0, latest && latest.at || 0) };
    });
    var sig = JSON.stringify([rows.map(function (r) { return [r.p.root, r.at, r.latest && r.latest.title, Boolean(r.busy)]; }), recent ? 1 : 0, Math.floor(Date.now() / 60000)]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    if (!rows.length) { box.appendChild(el('div', 'none', recent ? 'No projects yet — open a folder, create one, or clone one from GitHub.' : 'Reading…')); return; }
    rows.forEach(function (r) {
      var b = el('div', 'hrow');
      b.setAttribute('role', 'button');
      b.tabIndex = 0;
      var pic = el('span', 'pic'); pic.appendChild(L.icon('folder', 17)); b.appendChild(pic);
      var t = el('span', 'ht'); t.appendChild(el('b', '', r.p.name));
      t.appendChild(el('small', '', r.latest && r.latest.title && r.latest.title !== '(no task was ever started)' ? r.latest.title : r.p.root)); b.appendChild(t);
      var wh = el('span', 'where');
      wh.appendChild(L.kit.dot(r.busy ? 'acc run' : r.latest ? 'sec' : ''));
      wh.appendChild(document.createTextNode(r.busy ? 'Coding Agent' : r.latest ? 'Chat' : 'IDE'));
      b.appendChild(wh);
      b.appendChild(el('span', 'hm', ago(r.at)));
      var more = L.kit.iconButton('dots', 'More', function (a) { projectMenu(a, r.p, r.latest); });
      more.classList.add('more');
      b.appendChild(more);
      b.onclick = function (e) { if (e.target.closest('.more')) return; L.ide.open(r.p.root); };
      b.onkeydown = function (e) { if (e.key === 'Enter') L.ide.open(r.p.root); };
      box.appendChild(b);
    });
  }

  function renderChats() {
    var box = $('homeSessions');
    var sessions = L.sessions ? L.sessions.all().slice(0, 4) : [];
    var sig = JSON.stringify(sessions.map(function (s) { return [s.id, s.title, s.status, s.when]; }));
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    if (!sessions.length) { box.appendChild(el('div', 'none', 'No chats yet.')); return; }
    sessions.forEach(function (s) {
      var b = el('button', 'hrow');
      var pic = el('span', 'pic'); pic.appendChild(L.icon('chat', 16)); b.appendChild(pic);
      var t = el('span', 'ht'); t.appendChild(el('b', '', titleOf(s))); b.appendChild(t);
      b.appendChild(el('span', 'hm', s.status && s.status !== 'IDLE' ? s.status.toLowerCase() : ago(s.at)));
      b.onclick = function () { if (!s.current) L.sessions.select(s.id).then(function () { L.nav.go('chat'); }); else L.nav.go('chat'); };
      box.appendChild(b);
    });
  }

  // ---- SYSTEM STATUS ------------------------------------------------------------------------------------------------
  var ext = null, extAt = 0;
  function loadExt() {
    if (Date.now() - extAt < 60000) return;
    extAt = Date.now();
    Promise.all([L.api('/api/extensions/list', {}).catch(function () { return null; }), L.api('/api/extensions/discover', {}).catch(function () { return null; })]).then(function (rs) {
      ext = { installed: rs[0] && rs[0].ok ? rs[0].extensions || [] : null, found: rs[1] && rs[1].ok ? rs[1].found || [] : [] };
      renderHome();
    });
  }
  function renderStatus(S) {
    var box = $('homeStatus');
    var rows = [];
    var W = S.workbench || {};
    var st = S.header && S.header.status;
    var busy = W.running || (st && (st.state === 'RUNNING' || st.state === 'VERIFYING'));
    rows.push({ icon: 'cpu', title: 'Core service', sub: busy ? (W.status || 'Working') : 'LAIN is ready', tone: st && st.state === 'FAILED' ? 'bad' : 'ok', v: busy ? 'Working' : 'Online', vt: busy ? 'acc' : 'ok', go: ['chat'] });
    var fams = (L.intel && L.intel.families && L.intel.families()) || null;
    var accts = fams ? fams.reduce(function (a, f) { return a + (f.accounts || []).length; }, 0) : null;
    var usable = fams ? fams.reduce(function (a, f) { return a + (f.accounts || []).filter(function (x) { return x.usable; }).length; }, 0) : null;
    var setup = fams ? fams.reduce(function (a, f) { return a + (f.setup || []).length; }, 0) : 0;
    var route = (S.models && S.models.coding && S.models.coding.display) || {};
    rows.push({ icon: 'layers', title: 'Model providers', sub: accts == null ? 'Reading…' : accts ? accts + ' account' + (accts === 1 ? '' : 's') + ' connected' + (setup ? ' · ' + setup + ' need setup' : '') : 'No account connected yet',
      tone: accts ? (setup || !route.resolved ? 'warn' : 'ok') : 'warn', v: accts ? (usable ? 'Online' : 'Limited') : 'Set up', vt: accts && usable ? 'ok' : 'warn', go: ['model', { section: setup ? 'setup' : 'accounts' }] });
    var t = L.tools ? L.tools.get() : null;
    var live = t ? t.servers.filter(function (x) { return x.state === 'CONNECTED' || x.state === 'ACTIVE_BRIDGE'; }).length : 0;
    rows.push({ icon: 'plug', title: 'MCP', sub: t ? (t.servers.length ? live + ' of ' + t.servers.length + ' server' + (t.servers.length === 1 ? '' : 's') + ' connected' : 'No servers added') : 'Reading…', tone: t && live ? 'ok' : '', v: t && live ? 'Online' : t && t.servers.length ? 'Idle' : 'None', vt: t && live ? 'ok' : '', go: ['mcp'] });
    var n = ext && ext.installed ? ext.installed.length : null;
    rows.push({ icon: 'box', title: 'Extensions', sub: n == null ? 'Reading…' : n + ' installed', tone: n ? 'ok' : '', v: n ? 'Online' : 'None', vt: n ? 'ok' : '', go: ['ext'] });
    var attention = rows.filter(function (r) { return r.tone === 'warn' || r.tone === 'bad'; }).length;
    var sum = $('homeStatusSum');
    sum.className = 'hh-ok' + (attention ? ' warn' : '');
    sum.textContent = '';
    sum.appendChild(L.kit.dot(attention ? 'warn' : 'ok'));
    sum.appendChild(document.createTextNode(attention ? attention + ' need' + (attention === 1 ? 's' : '') + ' attention' : 'All systems operational'));
    var sig = JSON.stringify(rows);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    rows.forEach(function (r) {
      var b = el('button', 'srow2');
      var i = el('span', 'si ' + (r.tone || '')); i.appendChild(L.icon(r.icon, 18)); b.appendChild(i);
      var nm = el('span', 'sn', r.title); nm.appendChild(el('small', '', r.sub)); b.appendChild(nm);
      var v = el('span', 'sv'); v.appendChild(L.kit.dot(r.vt)); v.appendChild(document.createTextNode(r.v)); b.appendChild(v);
      var ch = el('span', 'chev'); ch.appendChild(L.icon('chevron', 14)); b.appendChild(ch);
      b.onclick = function () { L.nav.go(r.go[0], r.go[1] || null); };
      box.appendChild(b);
    });
  }

  // ---- EXPLORE EXTENSIONS: local only — found in VS Code / Cursor, or installed ------------------------------------------
  function renderExt() {
    var box = $('homeExt');
    var found = ext ? (ext.found || []).filter(function (f) { return !f.reused; }).slice(0, 4) : null;
    var sig = JSON.stringify([found && found.map(function (f) { return f.id; }), ext && ext.installed && ext.installed.length]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    if (!found) { box.appendChild(el('div', 'xempty', 'Reading…')); return; }
    if (!found.length) {
      var e = el('div', 'xempty', 'Search Open VSX, reuse what VS Code or Cursor already has, or install from Git or a folder.');
      e.appendChild(document.createElement('br'));
      e.appendChild(L.kit.button('Browse extensions', 'sm line', function () { L.nav.go('ext'); }, 'search'));
      box.style.display = 'block';
      box.appendChild(e);
      return;
    }
    box.style.display = '';
    found.forEach(function (f) {
      var c = el('div', 'xcard');
      var h = el('div', 'xi'); h.appendChild(L.icon('box', 16)); h.appendChild(el('b', '', f.name)); c.appendChild(h);
      c.appendChild(el('small', '', 'In ' + f.productLabel + ' · ' + (f.compatibility && f.compatibility.level === 'FULL' ? 'compatible' : 'needs an adapter')));
      c.appendChild(L.kit.button('Use in LAIN', 'sm line', function () { L.nav.go('ext', { focus: f.id }); }));
      box.appendChild(c);
    });
  }

  // ---- TIPS: true things about LAIN, one at a time -----------------------------------------------------------------
  var TIPS = [
    ['Type <b>/</b> in any composer to list LAIN’s controls — they change LAIN itself and never reach a model.'],
    ['<span class="kbd">Ctrl K</span> searches projects, files, commands, models and accounts from anywhere.'],
    ['<b>Chat</b> plans; the <b>Coding Agent</b> implements — the same session, one plan, one project.'],
    ['<span class="kbd">Alt 1</span>…<span class="kbd">Alt 7</span> switch between Home, IDE, Chat, Model, Usage, MCP & Skills and Settings.'],
    ['The ring at the top right is what remains of the active route’s quota. Click it for LAIN’s own usage and every reported window.'],
    ['Closing the window keeps LAIN in the tray: bots and running work carry on. Quit from the tray menu ends them.'],
  ];
  var tip = 0;
  try { tip = Number(localStorage.getItem('lain.home.tip') || 0) % TIPS.length; } catch (e) { tip = 0; }
  function renderTip(step) {
    if (step) { tip = (tip + step + TIPS.length) % TIPS.length; try { localStorage.setItem('lain.home.tip', String(tip)); } catch (e) { /* per viewer */ } }
    var b = $('homeTip');
    // Fixed strings from this file — no state is ever written as markup.
    b.innerHTML = TIPS[tip][0];
    b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
  }

  function renderHome() {
    var S = L.state();
    if (!S || L.nav.tab() !== 'home') return;
    var g = greeting();
    var gh = $('greet');
    if (gh.dataset.g !== g) { gh.dataset.g = g; gh.textContent = g.replace(/\.$/, ''); gh.appendChild(el('span', 'gdot', '.')); }
    renderFocus(S);
    renderProjects();
    renderChats();
    renderStatus(S);
    renderExt();
    loadExt();
    var acts = $('homeActions');
    if (!acts.childNodes.length) {
      [['New Project', 'plus', 'q-pri', function () { L.ide.newProject(); }],
        ['Start Chat', 'chat', '', function () { L.nav.go('chat'); if (L.chat) L.chat.newChat(); }],
        ['Open IDE', 'ide', '', function () { L.nav.go('ide'); }],
        ['Explore Models', 'layers', '', function () { L.nav.go('model', { section: 'models' }); }],
        ['Browse Extensions', 'box', '', function () { L.nav.go('ext'); }],
        ['From GitHub', 'github', '', function () { if (L.github) L.github.pick({ then: function () { L.nav.go('chat'); } }); else L.nav.go('settings', { section: 'github' }); }]].forEach(function (q) {
        var b = el('button', 'qtile ' + q[2]);
        b.appendChild(L.icon(q[1], 18));
        b.appendChild(el('span', 'ql', q[0]));
        var car = el('span', 'car'); car.appendChild(L.icon('chevron', 14)); b.appendChild(car);
        b.onclick = q[3];
        acts.appendChild(b);
      });
    }
  }

  // ---- Home's search box: the same index as Ctrl K -----------------------------------------------------------
  var homeFlat = [];
  function homeQuery() {
    var q = $('hsearch').value;
    var box = $('hresults');
    if (!q.trim()) { box.hidden = true; homeFlat = []; return; }
    box.hidden = false;
    homeFlat = L.search.draw(box, q, L.search.query(q), function () { box.hidden = true; $('hsearch').value = ''; });
  }

  L.onBoot(function () {
    $('hsIcon').appendChild(L.icon('search', 18));
    [['qaIc', 'bolt'], ['rpIc', 'clock'], ['ssIc', 'layers'], ['rcIc', 'chats'], ['exIc', 'box'], ['tpIc', 'bulb']].forEach(function (x) { $(x[0]).appendChild(L.icon(x[1], 18)); });
    $('tipPrev').appendChild(L.icon('back', 14)); $('tipNext').appendChild(L.icon('arrow', 14));
    $('tipPrev').onclick = function () { renderTip(-1); };
    $('tipNext').onclick = function () { renderTip(1); };
    renderTip(0);
    $('hsearch').addEventListener('input', function () { homeQuery(); L.search.remote(this.value, homeQuery); });
    $('hsearch').addEventListener('focus', function () { L.search.warm(); if (this.value.trim()) homeQuery(); });
    $('hsearch').addEventListener('blur', function () { setTimeout(function () { $('hresults').hidden = true; }, 120); });
    $('hsearch').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { this.value = ''; $('hresults').hidden = true; return; }
      if (e.key === 'Enter' && !homeFlat.length && this.value.trim()) { L.search.ask(this.value.trim()); return; }
      L.search.keyNav(e, $('hresults'), homeFlat, function () { $('hresults').hidden = true; $('hsearch').value = ''; });
    });
    L.nav.onShow('home', function () { L.search.warm(); renderHome(); setTimeout(function () { $('hsearch').focus(); }, 0); });
    L.search.onRecent(function () { renderHome(); });
    $('homeAllProjects').onclick = function () { L.ide.openProject(); };
    $('homeAllChats').onclick = function () { L.nav.go('chat'); };
    $('homeAllExt').onclick = function () { L.nav.go('ext'); };
  });
  L.onRender(function () { renderHome(); });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
