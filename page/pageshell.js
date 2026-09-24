'use strict';

/**
 * THE WORKSPACE SHELL — the menubar, the seven primary tabs, the quota bar.
 *
 * ------------------------------------------------------------------------
 * SEVEN SURFACES, ALWAYS ONE CLICK AWAY.
 *
 *     HOME | IDE | CHAT | BOT | MODEL | SESSION | SETTINGS
 *
 * The tab bar never goes away, so IDE → CHAT → MODEL → IDE never passes
 * through Home. Which tab shows is UI state (this file's `tab`); what each
 * tab shows is Core's. Entering IDE or CHAT on an engineering session also
 * tells Core which VIEW of the session is in front (POST /api/view/select),
 * because Core keys the workspace panels and plan handoff on it.
 *
 * ------------------------------------------------------------------------
 * ONE ACCOUNTS STORE. `LAIN.accounts` is the only client copy of
 * POST /api/accounts. The quota popover, the Model view and Home's search all
 * read it; the compact quota bar reads the polled `S.usage`, which is the same
 * Core owner (usagewindows.js) at a cheaper grain. Nothing keeps a third copy.
 *
 * ------------------------------------------------------------------------
 * THE QUOTA BAR SHOWS ONLY WHAT A PROVIDER SAID. A percentage appears when a
 * response through that route carried rate-limit headers; otherwise the bar
 * is empty and the number reads "n/a", and the popover says why.
 */

const HTML = `
<header id="menubar">
  <div class="menus" id="menus" role="menubar">
    <button class="mb brand" data-menu="lain">LAIN</button>
    <button class="mb" data-menu="file">File</button>
    <button class="mb" data-menu="edit">Edit</button>
    <button class="mb" data-menu="view">View</button>
    <button class="mb" data-menu="help">Help</button>
  </div>
  <span class="spacer"></span>
  <button class="topsearch" id="topSearch" title="Search LAIN or ask the BOT (Ctrl+K)"><span id="topSearchIc"></span><span class="ts-t">Search LAIN or ask BOT…</span><span class="kbd">Ctrl K</span></button>
  <span class="spacer"></span>
  <span class="conn" id="conn"></span>
  <button class="quota" id="quota" aria-haspopup="dialog">
    <span class="q-model" id="quotaModel">—</span>
    <span class="q-bar"><span class="q-fill" id="quotaFill"></span></span>
    <span class="q-pct" id="quotaPct">—</span>
  </button>
</header>
<nav id="tabs" role="tablist" aria-label="LAIN workspace">
  <button class="gtab" role="tab" data-tab="home" id="tabHome">Home</button>
  <button class="gtab" role="tab" data-tab="ide" id="tabIde">IDE</button>
  <button class="gtab" role="tab" data-tab="chat" id="tabChat">Chat</button>
  <button class="gtab" role="tab" data-tab="bot" id="tabBot">Bot</button>
  <button class="gtab" role="tab" data-tab="model" id="tabModel">Model</button>
  <button class="gtab" role="tab" data-tab="session" id="tabSession">Session</button>
  <button class="gtab" role="tab" data-tab="settings" id="tabSettings">Settings</button>
</nav>
<div class="menu" id="menuDrop" hidden role="menu"></div>`;

const CSS = `
/* ---- the chrome: menubar over the primary tabs ------------------------ */
#menubar{display:flex;align-items:center;gap:6px;height:32px;padding:0 10px 0 6px;background:var(--chrome);border-bottom:1px solid var(--line)}
.menus{display:flex;gap:1px}
.mb{padding:3px 9px;border-radius:var(--radius-s);color:var(--dim);font-size:12.5px}
.mb:hover,.mb[aria-expanded=true]{background:var(--raise);color:var(--ink)}
.mb.brand{font-weight:700;letter-spacing:.14em;font-size:11.5px;color:var(--ink);padding:3px 10px}
.conn{font-size:11.5px;color:var(--warn)}
.menu{position:fixed;z-index:70;min-width:230px;padding:5px;background:var(--panel);border:1px solid var(--line2);border-radius:var(--radius);box-shadow:var(--shadow)}
.menu button{display:flex;width:100%;align-items:center;gap:18px;padding:5px 10px;border-radius:var(--radius-s);font-size:12.5px;color:var(--ink);text-align:left}
.menu button:hover:not(:disabled){background:var(--accent-weak)}
.menu button:disabled{color:var(--faint)}
.menu button .k{margin-left:auto;color:var(--faint);font-size:11.5px;font-family:var(--sans)}
.menu .sep{height:1px;background:var(--line);margin:4px 6px}
/* ---- the global tabs: icon and word, an accent rule under the active one --
   The IDE's editor tabs are small filled boxes with a close control and sit
   lower, inside the editor. Two tab systems that look different cannot be
   mistaken for one another. */
#tabs{display:flex;align-items:stretch;gap:2px;height:36px;padding:0 10px;background:var(--chrome);border-bottom:1px solid var(--line)}
.gtab{position:relative;padding:0 13px;color:var(--faint);font-size:11.5px;font-weight:600;letter-spacing:.11em;text-transform:uppercase}
.gtab:hover{color:var(--ink)}
.gtab{display:flex;align-items:center;gap:7px}
.gtab .ic{opacity:.8}
.gtab[aria-selected=true]{color:var(--ink);background:linear-gradient(180deg,transparent,var(--accent-weak))}
.gtab[aria-selected=true] .ic{color:var(--accent);opacity:1}
.gtab[aria-selected=true]::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--accent)}
.topsearch{display:flex;align-items:center;gap:8px;width:min(420px,34vw);height:24px;padding:0 8px;border-radius:var(--radius-s);background:var(--surface);border:1px solid var(--line2);color:var(--faint);font-size:12px}
.topsearch:hover{border-color:var(--accent-line);color:var(--dim)}
.topsearch .ts-t{flex:1;text-align:left;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.topsearch .kbd{font-size:10.5px;padding:0 5px}
@media (max-width: 760px){.topsearch .ts-t,.topsearch .kbd{display:none}.topsearch{width:auto}.gtab .lbl{display:none}.gtab{padding:0 11px}.q-model{max-width:90px}.q-bar{width:44px}.mb{padding:3px 6px}}
@media (max-width: 520px){.q-model{display:none}.mb{padding:3px 4px;font-size:12px}.mb.brand{padding:3px 6px}#menubar{gap:3px;padding:0 6px 0 4px}}
#tabs{overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
#tabs::-webkit-scrollbar{display:none}
.gtab{flex:none}
#menubar{min-width:0}
.gtab .badge{display:inline-block;min-width:6px;height:6px;border-radius:50%;background:var(--accent);margin-left:6px;vertical-align:2px}
/* ---- the quota bar: model, bar, and the percentage ON THE RIGHT ---------- */
.quota{display:flex;align-items:center;gap:8px;height:24px;padding:0 9px;border-radius:var(--radius-s);color:var(--dim);font-size:11.5px}
.quota:hover{background:var(--raise);color:var(--ink)}
.q-model{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.q-bar{position:relative;width:74px;height:6px;border-radius:3px;background:var(--surface);overflow:hidden;box-shadow:inset 0 0 0 1px var(--line2)}
.q-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:var(--accent);border-radius:3px}
.q-fill.warn{background:var(--warn)} .q-fill.bad{background:var(--bad)}
.q-pct{min-width:30px;text-align:right;font-variant-numeric:tabular-nums;color:var(--ink)}
.q-pct.unknown{color:var(--faint)}
.qpop{width:400px;max-width:400px;padding:12px 14px}
.qpop h4{margin:0 0 10px}
.qpop .qsec{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:12px 0 6px}
.qrow{display:grid;grid-template-columns:minmax(0,1fr) 80px 40px;align-items:center;gap:8px;padding:4px 0;font-size:12.5px}
.qrow .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qrow .n small{display:block;color:var(--faint);font-size:11px}
.qrow .q-bar{width:auto}
.qrow .q-pct{font-size:12px}
.qgroup{font-size:12px;color:var(--dim);margin:8px 0 2px}
.qfoot{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line);font-size:11.5px;color:var(--faint)}
.qfoot .spacer{flex:1}
.qnote{font-size:11.5px;color:var(--faint);line-height:1.5}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var TABS = ['home', 'ide', 'chat', 'bot', 'model', 'session', 'settings'];
  var tab = 'home';
  var shows = {};
  var navSeq = null;
  var lastTip = '';

  // ---- the accounts store -------------------------------------------------
  var A = { data: null, loading: false, at: 0, why: '', subs: [] };
  function emit() { A.subs.forEach(function (fn) { try { fn(A); } catch (e) { /* one view never breaks another */ } }); }
  async function loadAccounts(refresh, force) {
    if (A.loading) return A.data;
    A.loading = true; A.why = ''; emit();
    try {
      var r = await L.api(refresh ? '/api/accounts/refresh' : '/api/accounts', refresh ? { force: Boolean(force) } : {});
      if (r && r.ok) { A.data = r; A.at = Date.now(); if (refresh && r.why) A.why = r.why; } else A.why = (r && r.why) || 'could not read accounts';
    } catch (e) { A.why = e.message; }
    A.loading = false;
    emit();
    return A.data;
  }
  L.accounts = {
    get: function () { return A; },
    load: function () { return loadAccounts(false); },
    refresh: function (force) { return loadAccounts(true, force); },
    on: function (fn) { A.subs.push(fn); return function () { A.subs = A.subs.filter(function (x) { return x !== fn; }); }; },
  };

  // ---- navigation -------------------------------------------------------
  function go(next, opts) {
    if (TABS.indexOf(next) < 0) return;
    L.closePop();
    closeMenu();
    tab = next;
    TABS.forEach(function (t) {
      var b = document.querySelector('.gtab[data-tab="' + t + '"]');
      if (b) b.setAttribute('aria-selected', String(t === tab));
      var v = $('v' + t.charAt(0).toUpperCase() + t.slice(1));
      if (v) v.hidden = t !== tab;
    });
    var S = L.state();
    // THE SESSION'S VIEW FOLLOWS THE TAB — Core keys the workspace and the
    // plan handoff on it. Navigation only: nothing runs.
    if (S && S.current && S.current.lane === 'engineering' && S.views && (tab === 'ide' || tab === 'chat')) {
      var want = tab === 'ide' ? 'coding' : 'chat';
      if (S.views.active !== want) L.api('/api/view/select', { view: want }).then(function () { L.poll(); }, function () { /* next poll */ });
    }
    (shows[tab] || []).forEach(function (fn) { try { fn(opts || {}); } catch (e) { if (window.console) console.error(e); } });
    L.render();
  }
  L.nav = {
    go: go,
    tab: function () { return tab; },
    onShow: function (t, fn) { (shows[t] = shows[t] || []).push(fn); },
  };

  // ---- the quota bar ------------------------------------------------------
  function roleInFront(S) {
    var h = S.header && S.header.status;
    var running = h && (h.state === 'RUNNING' || h.state === 'VERIFYING');
    var u = S.usage || {};
    if (running && u.last && Date.now() - u.last.at < 15 * 60000) return { key: 'last', u: u.last, model: u.last.canonicalModel || u.last.model, running: true };
    var key = tab === 'chat' ? 'chat' : 'coding';
    var r = u[key];
    if (!r) return null;
    var label = r.source && r.source !== 'lain' ? sourceLabel(S, r.source) : r.modelId;
    return { key: key, u: r, model: label, running: false };
  }
  function sourceLabel(S, id) {
    var list = (S.sources && S.sources.sources) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].label;
    return id;
  }
  function headlineOf(reading) { return reading && reading.headline ? reading.headline : null; }
  function levelOf(pct, avail) {
    if (avail && avail.rateLimited) return 'bad';
    if (pct == null) return '';
    return pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : '';
  }
  function paintBar(fill, pctEl, reading, avail) {
    var h = headlineOf(reading);
    var pct = h ? Math.round(h.percent) : null;
    fill.style.width = (pct == null ? (avail && avail.rateLimited ? 100 : 0) : Math.max(2, pct)) + '%';
    fill.className = 'q-fill ' + levelOf(pct, avail);
    pctEl.textContent = pct == null ? (avail && avail.rateLimited ? 'limit' : 'n/a') : pct + '%';
    pctEl.className = 'q-pct' + (pct == null ? ' unknown' : '');
    return { pct: pct, window: h ? h.label : null };
  }
  function renderQuota(S) {
    var f = roleInFront(S);
    var btn = $('quota');
    if (!f) { $('quotaModel').textContent = 'no model'; paintBar($('quotaFill'), $('quotaPct'), null, null); btn.title = 'No model is selected'; return; }
    $('quotaModel').textContent = L.fmt.model(f.model) || 'no model';
    var reading = f.u.reading || null;
    var shown = paintBar($('quotaFill'), $('quotaPct'), reading, f.u.availability);
    var why = shown.pct != null
      ? shown.pct + '% of the ' + shown.window + ' window used, as the provider reported ' + minutesAgo(reading.at)
      : (f.u.availability && f.u.availability.rateLimited ? 'Rate limited' + (f.u.availability.resumeAt ? ', clears ' + L.fmt.until(f.u.availability.resumeAt) : '')
        : 'This provider has not reported usage on a response yet');
    btn.title = (f.running ? 'Running now: ' : '') + (f.model || '') + ' — ' + why;
    var tip = 'LAIN · ' + L.fmt.model(f.model) + (shown.pct != null ? ' ' + shown.pct + '%' : '');
    if (tip !== lastTip) { lastTip = tip; L.hostCall('trayTip', { text: tip.slice(0, 63) }); }
  }
  function minutesAgo(at) {
    var m = Math.max(0, Math.round((Date.now() - (at || 0)) / 60000));
    return m < 1 ? 'just now' : m + ' min ago';
  }

  function qrow(name, sub, reading, avail) {
    var row = el('div', 'qrow');
    var n = el('div', 'n', name);
    if (sub) n.appendChild(el('small', '', sub));
    row.appendChild(n);
    var bar = el('span', 'q-bar'); var fill = el('span', 'q-fill'); bar.appendChild(fill);
    var pct = el('span', 'q-pct');
    row.appendChild(bar); row.appendChild(pct);
    paintBar(fill, pct, reading, avail);
    return row;
  }

  function windowSub(reading, avail) {
    if (avail && avail.rateLimited) return 'rate limited' + (avail.resumeAt ? ' · clears ' + L.fmt.until(avail.resumeAt) : '');
    var h = headlineOf(reading);
    if (!h) return 'usage not reported';
    return h.label + ' window' + (h.resetAt ? ' · resets ' + L.fmt.until(h.resetAt) : '') + ' · ' + minutesAgo(reading.at);
  }

  function openQuota() {
    var S = L.state();
    if (!S) return;
    var p = L.popover($('quota'), function (pop) { drawQuota(pop, S); }, { cls: 'qpop', alignRight: true });
    var off = L.accounts.on(function () { if (!document.body.contains(p)) { off(); return; } p.textContent = ''; drawQuota(p, L.state()); });
    if (!A.data && !A.loading) L.accounts.load();
  }

  function drawQuota(pop, S) {
    pop.appendChild(el('h4', '', 'Model quota usage'));
    var u = S.usage || {};
    pop.appendChild(el('div', 'qsec', 'In front now'));
    var f = roleInFront(S);
    if (f) pop.appendChild(qrow(L.fmt.model(f.model), (f.running ? 'running · ' : (f.key === 'chat' ? 'BOT · ' : 'Coding Agent · ')) + windowSub(f.u.reading, f.u.availability), f.u.reading, f.u.availability));
    var roles = [['chat', 'BOT'], ['coding', 'Coding Agent']];
    roles.forEach(function (r) {
      var x = u[r[0]];
      if (!x || (f && f.key === r[0])) return;
      var label = x.source && x.source !== 'lain' ? sourceLabel(S, x.source) : x.modelId;
      pop.appendChild(qrow(L.fmt.model(label) || 'not set', r[1] + ' · ' + windowSub(x.reading, x.availability), x.reading, x.availability));
    });
    pop.appendChild(el('div', 'qsec', 'All accounts'));
    var d = A.data;
    if (!d) pop.appendChild(el('div', 'qnote', A.loading ? 'Reading accounts…' : (A.why || 'Not read yet.')));
    else {
      var any = false;
      (d.providers || []).forEach(function (g) {
        g.connections.forEach(function (c) {
          any = true;
          pop.appendChild(qrow(g.label, c.id + ' · ' + windowSub(c.usage, c.availability), c.usage, c.availability));
          ((c.usage && c.usage.windows) || []).filter(function (w) { return w.percent != null && (!c.usage.headline || w.name !== c.usage.headline.name); }).forEach(function (w) {
            var fake = { at: c.usage.at, headline: w };
            pop.appendChild(qrow(' ' + w.label, w.resetAt ? 'resets ' + L.fmt.until(w.resetAt) : '', fake, null));
          });
        });
      });
      if (!any) pop.appendChild(el('div', 'qnote', 'No provider routes are configured.'));
    }
    pop.appendChild(el('div', 'qnote', 'Percentages are what each provider stated in its rate-limit headers on the last response through that route. A route that never states them shows —.'));
    var foot = el('div', 'qfoot');
    foot.appendChild(el('span', '', A.at ? 'Last refreshed ' + L.fmt.time(A.at) : 'Not refreshed yet'));
    foot.appendChild(el('span', 'spacer'));
    var m = el('button', 'btn small', 'Open Model');
    m.onclick = function () { L.closePop(); go('model'); };
    var rf = el('button', 'btn small primary', A.loading ? 'Refreshing…' : 'Refresh');
    rf.disabled = A.loading;
    rf.onclick = function () { L.accounts.refresh(true); };
    foot.appendChild(m); foot.appendChild(rf);
    pop.appendChild(foot);
  }

  // ---- the menubar --------------------------------------------------------
  var openMenuId = null;
  function menus() {
    var S = L.state() || {};
    var ide = tab === 'ide';
    var projectOpen = Boolean(S.workspace && S.workspace.project && S.workspace.project.attached);
    var cmd = function (label, key, run, enabled) { return { label: label, key: key || '', run: run, enabled: enabled !== false }; };
    return {
      lain: [
        cmd('About LAIN', '', function () { L.dialog({ title: 'LAIN', text: 'A persistent AI workspace. The Harness draws; LAIN Core owns every piece of state.', ok: 'Close', cancel: 'Diagnostics' }).then(function (v) { if (v === false) diagnostics(); }); }),
        cmd('Settings', 'Alt+7', function () { go('settings'); }),
        null,
        cmd('Hide to tray', '', function () { L.hostCall('hide', {}); }),
        cmd('Quit LAIN', '', async function () {
          if (await L.confirm('Quit LAIN? Bots, background jobs and any work in progress will stop.', { ok: 'Quit', danger: true })) L.api('/api/desktop/quit', {});
        }),
      ],
      file: [
        cmd('New Project…', 'Ctrl+Shift+N', function () { L.ide.newProject(); }),
        cmd('Open Project…', 'Ctrl+O', function () { L.ide.openProject(); }),
        cmd('New Chat', '', function () { L.chat.newChat(); }),
        null,
        cmd('Open File…', 'Ctrl+P', function () { go('ide'); L.ide.quickOpen(); }, projectOpen),
        cmd('Save', 'Ctrl+S', function () { L.source.save(false); }, ide && projectOpen),
        cmd('Close Editor', 'Ctrl+W', function () { L.ide.closeEditor(); }, ide && projectOpen),
      ],
      edit: [
        cmd('Undo', 'Ctrl+Z', function () { document.execCommand('undo'); }),
        cmd('Redo', 'Ctrl+Y', function () { document.execCommand('redo'); }),
        null,
        cmd('Find in File', 'Ctrl+F', function () { L.ide.find(); }, ide && projectOpen),
        cmd('Search LAIN', 'Ctrl+K', function () { L.search.palette(''); }),
        cmd('Command Palette', 'Ctrl+Shift+P', function () { L.search.palette('>'); }),
      ],
      view: TABS.map(function (t, i) { return cmd(t === 'ide' ? 'IDE' : t.charAt(0).toUpperCase() + t.slice(1), 'Alt+' + (i + 1), function () { go(t); }); })
        .concat([null,
          cmd('Toggle Explorer', 'Ctrl+B', function () { go('ide'); L.ide.toggleSide(); }, projectOpen),
          cmd('Toggle Panel', 'Ctrl+J', function () { go('ide'); L.ide.togglePanel(); }, projectOpen),
          cmd('Toggle BOT Panel', 'Ctrl+Alt+B', function () { go('ide'); L.ide.toggleBot(); }, projectOpen),
        ]),
      help: [
        cmd('Keyboard Shortcuts', '', function () { go('settings', { section: 'shortcuts' }); }),
        cmd('Diagnostics', '', function () { diagnostics(); }),
        cmd('Ask LAIN about LAIN', '', function () { go('chat'); var a = $('ask'); a.value = 'Where are the MCP settings, and which models are the BOT and the Coding Agent using?'; a.focus(); }),
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
    drop.style.top = (r.bottom + 2) + 'px';
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
      'Environment: ' + (e.kind === 'vm' ? 'VM' : 'Host'),
      'Browser: ' + (e.browser ? (e.browser.owned ? 'LAIN-owned Chromium ' : 'Borrowed browser ') + (e.browser.version || '') : (e.why || 'none')),
      'Running: ' + ((e.running || []).join(', ') || 'nothing'),
      'Session status: ' + (ex.word || 'READY') + (ex.detail ? ' — ' + ex.detail : ''),
    ];
    L.dialog({ title: 'Diagnostics', text: lines.join('\n'), ok: 'Close', cancel: 'Close' });
  }

  // ---- keys ---------------------------------------------------------------
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
    $('quota').onclick = openQuota;
    $('topSearchIc').appendChild(L.icon('search', 13));
    $('topSearch').onclick = function () { L.search.palette(''); };
    Array.prototype.forEach.call(document.querySelectorAll('.gtab'), function (b) { var t = el('span', 'lbl', b.textContent); b.textContent = ''; b.title = t.textContent; b.appendChild(L.icon(b.getAttribute('data-tab'), 15)); b.appendChild(t); });
    go('home');
    // ---- STARTUP REFRESH, NEVER IN THE WAY ---------------------------------
    // The window is already drawn from local state; accounts and their model
    // catalogs refresh behind it, then MCP and the bot's channels are read once.
    setTimeout(function () { L.accounts.refresh(false); }, 400);
    setTimeout(function () { if (L.tools) L.tools.load(); }, 900);
    setTimeout(function () { if (L.bot) L.bot.load(false); }, 3000);
    setInterval(function () { if (!A.loading) L.accounts.load(); }, 120000);
  });

  var lastState = '';
  L.onRender(function (S) {
    renderQuota(S);
    // CORE WENT AWAY: said once, quietly, in the chrome.
    $('conn').textContent = '';
    // A TURN FINISHED: usage may have moved, so the accounts view reads again.
    var st = S.header && S.header.status ? S.header.status.state : '';
    if (lastState === 'RUNNING' && st !== 'RUNNING' && !A.loading) L.accounts.load();
    lastState = st;
    // THE BOT ASKED THE WINDOW TO GO SOMEWHERE — applied once per request.
    var n = S.navigate;
    if (navSeq === null) navSeq = n ? n.seq : 0;
    else if (n && n.seq > navSeq) { navSeq = n.seq; go(n.surface, { section: n.section }); }
  });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
