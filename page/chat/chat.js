'use strict';

/**
 * CHAT — the familiar conversation surface: one session, TWO LANES (2026-09-30).
 *
 *   ┌ rail ──────────┐┌──────────────────────────────────────────────────────────┐
 *   │ …rooms…        ││  [ ○ Chat | ● Coding Agent ]            Working · Task ⋯ │
 *   │ Conversations +││  Game Decoder UI ✎                                        │
 *   │ ┌ Game Decoder┐││  D:\projects\game-decoder                                 │
 *   │ └ Refine the… ┘││                                                           │
 *   │ MCP integration││        messages, in a centred reading column              │
 *   │ 2h ago         ││                                                           │
 *   │ …              ││      ╭ Message LAIN…                                  ╮   │
 *   │                ││      │ + @ /                  ◈ GPT-6 Sol  ◔  ⚡   ➜ │   │
 *   └────────────────┘└──────────────────────────────────────────────────────────┘
 *
 * CHAT is conversation, planning, research, review and supervision. The CODING
 * AGENT lane is the full coding chat — the implementation Agent in the same
 * layout, its task beside it. Both are threads of the SAME Core session
 * (sessionviews.js): one task, one plan, one project; switching restarts nothing.
 *
 * THE CONVERSATIONS LIVE IN THE RAIL (L.rail.room), under the rooms, always in
 * view on Chat — no drawer to find.
 *
 * WHILE THE AGENT WORKS AND CHAT IS IN FRONT, a compact live card says what it
 * is doing (phase, the step, the activity) with View Coding Agent and Pause. It
 * reads Core's state — the same poll every surface draws from — and never asks
 * a model anything. The Agent's transcript is not copied into Chat.
 *
 * THE CODING AGENT NEEDS A PROJECT FOLDER; Chat does not. With none attached the
 * lane says why and offers to bind THIS session to a folder.
 */

const HTML = `
<section class="view chatv" id="vChat" data-view="chat" hidden>
  <div class="cmain">
    <header class="chead" id="chatHead">
      <div class="ch-top">
        <div class="ch-lanes" id="chatLanes"></div>
        <span class="spacer"></span>
        <span class="ch-status" id="chatStatus"></span>
        <button class="u-btn sm ghost run-toggle" id="runToggle" hidden>Task</button>
        <button class="u-btn sm ghost" id="chatPreviewBtn" aria-pressed="false"><span id="chatPreviewIc"></span>Preview</button>
        <button class="u-ib" id="chatMore" aria-label="More"></button>
      </div>
      <div class="ch-id">
        <div class="ch-titlerow"><h1 class="ch-title" id="chatTitle">New conversation</h1><button class="u-ib ch-rename" id="chatRename" aria-label="Rename"></button></div>
        <button class="ch-proj" id="chatProj"></button>
      </div>
    </header>
    <div class="cbody" id="chatBody">
      <div class="chat-col">
        <div class="agent-live" id="agentLive" hidden></div>
        <div class="chat-main" id="chatHost"></div>
      </div>
      <aside class="runpanel" id="runPanel" hidden></aside>
      <aside class="pv-slot" id="pvSlotChat"></aside>
    </div>
    <div class="chat-sched" id="chatSched" hidden></div>
  </div>
</section>`;

const CSS = `
.chatv{position:relative;display:flex;flex-direction:column;min-height:0;height:100%;overflow:hidden;background:var(--canvas)}
.cmain{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0}

/* THE HEADER — the lanes, then the conversation's name and its project, aligned with the reading column. */
.chead{flex:none;width:100%;max-width:calc(var(--chat-col) + 64px);margin:0 auto;padding:6px 32px 10px}
.ch-top{display:flex;align-items:center;gap:8px;min-height:40px}
.ch-status{color:var(--text-secondary);font-size:var(--fs-small);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%}
.run-toggle[aria-pressed=true]{background:var(--selection);color:var(--text-primary)}
.ch-lanes .u-seg > button{padding:6px 16px;font-size:var(--fs-body)}
.ch-lanes .lane-dot{width:7px;height:7px;border-radius:50%;background:var(--accent-primary);margin-left:2px}
.ch-lanes .lane-dot.warn{background:var(--warning)}
.ch-lanes [aria-disabled=true]{opacity:.55}
.ch-id{margin-top:14px;min-width:0}
.ch-titlerow{display:flex;align-items:center;gap:6px;min-width:0}
.ch-title{font:600 var(--fs-h1)/1.2 var(--display);letter-spacing:-.01em;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary)}
.ch-rename{opacity:0;transition:opacity var(--t-hover) var(--ease)}
.ch-titlerow:hover .ch-rename,.ch-rename:focus-visible{opacity:1}
.ch-proj{display:flex;align-items:center;gap:7px;max-width:100%;margin-top:4px;color:var(--text-secondary);font-size:var(--fs-body)}
.ch-proj:hover{color:var(--text-primary)}
.ch-proj .pd{width:7px;height:7px;border-radius:50%;background:var(--positive);flex:none}
.ch-proj.none .pd{background:var(--text-muted)}
.ch-proj span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.cbody{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr)}
.cbody.with-panel{grid-template-columns:minmax(0,1fr) 300px}
/* THE PREVIEW BESIDE THE CONVERSATION (the same page the IDE shows): a plane on the right. */
#pvSlotChat{display:none}
.cbody.with-preview{grid-template-columns:minmax(0,1fr) minmax(380px,48%)}
.cbody.with-preview #pvSlotChat{display:block;margin:0 12px 12px 0}
.cbody.with-preview .runpanel{display:none}
#chatPreviewBtn[aria-pressed=true]{background:var(--accent-weak);color:var(--accent-primary)}
.chat-col{display:flex;flex-direction:column;min-height:0;min-width:0}
.chat-main{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0}
.chat-sched{overflow-y:auto;padding:24px 28px 40px;min-height:0;flex:1}
.lanetip{position:fixed;z-index:80;max-width:300px;padding:10px 12px;border-radius:var(--radius-md);background:var(--surface-panel);box-shadow:var(--shadow-float),0 0 0 1px var(--border-subtle);color:var(--text-primary);font-size:var(--fs-small);line-height:1.45;pointer-events:none;animation:lain-pop var(--t-pop) var(--ease)}

/* THE LIVE CARD: the Coding Agent is working and Chat is in front. */
.agent-live{flex:none;width:calc(100% - 64px);max-width:var(--chat-col);margin:2px auto 8px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 14px;align-items:center;padding:12px 14px 12px 12px;border-radius:var(--radius-lg);background:var(--plane-violet);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent-primary) 26%,transparent);animation:lain-drop var(--t-panel) var(--ease)}
.agent-live[hidden]{display:none}
.agent-live .al-ic{grid-row:1 / span 2;width:34px;height:34px;border-radius:var(--radius-sm);display:grid;place-items:center;background:var(--accent-weak);color:var(--accent-primary)}
.agent-live .al-ic .ic{animation:lain-pulse 1.6s var(--ease) infinite}
.agent-live .al-h{display:flex;align-items:baseline;gap:10px;min-width:0}
.agent-live .al-h b{font-size:var(--fs-body);font-weight:600;color:var(--text-primary)}
.agent-live .al-h span{font-size:var(--fs-small);color:var(--text-secondary);font-variant-numeric:tabular-nums}
.agent-live .al-d{font-size:var(--fs-small);color:var(--text-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-live .al-d i{font-style:normal;color:var(--text-primary)}
.agent-live .al-a{grid-row:1 / span 2;grid-column:3;display:flex;gap:6px}
.agent-live.paused{background:var(--plane-amber);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warning) 30%,transparent)}
.agent-live.paused .al-ic{background:var(--warning-weak);color:var(--warning)}
.agent-live.paused .al-ic .ic{animation:none}

/* THE CONVERSATIONS, IN THE RAIL. */
.cv-head{display:flex;align-items:center;gap:4px;padding:0 2px 8px 6px}
.cv-head b{flex:1;font-size:var(--fs-body);font-weight:600;color:var(--nav-text)}
.cv-head .u-ib{width:28px;height:28px;color:var(--nav-muted)}
.cv-head .cv-new{background:var(--surface-raised);color:var(--nav-text)}
.cv-head .cv-new:hover{background:var(--surface-active)}
.cv-search{display:flex;align-items:center;gap:8px;margin:0 0 8px;padding:0 10px;height:32px;border-radius:var(--radius-sm);background:var(--surface-base);box-shadow:inset 0 0 0 1px var(--separator);color:var(--nav-muted)}
.cv-search[hidden]{display:none}
.cv-search:focus-within{box-shadow:inset 0 0 0 1px var(--accent-border)}
.cv-search input{font-size:var(--fs-small);color:var(--nav-text)}
.cv-list{flex:1;min-height:0;overflow-y:auto;margin:0 -6px;padding:0 6px;scrollbar-width:thin}
.cv-sec{margin:12px 8px 4px;font-size:var(--fs-caption);font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--nav-muted)}
.cv-sec:first-child{margin-top:2px}
.sessrow{position:relative;display:flex;align-items:center;border-radius:var(--radius-md);transition:background var(--t-hover) var(--ease)}
.sessrow + .sessrow{margin-top:2px}
.sessrow:hover{background:color-mix(in srgb,var(--nav-text) 5%,transparent)}
.sessrow[aria-current=true]{background:color-mix(in srgb,var(--accent-primary) 10%,var(--surface-raised));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent-primary) 30%,transparent)}
.sess{flex:1;min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1px 8px;align-items:center;padding:8px 8px 8px 12px;text-align:left}
.sess .tt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--fs-body);color:var(--nav-text)}
.sess .ss{grid-column:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--fs-caption);color:var(--nav-muted)}
.sess .sdot{grid-row:1 / span 2;grid-column:2;width:7px;height:7px;border-radius:50%;background:var(--accent-primary)}
.sess .sdot.WAITING,.sess .sdot.NEEDS_INPUT{background:var(--warning)} .sess .sdot.FAILED{background:var(--danger)}
.sess .sdot.RUNNING,.sess .sdot.VERIFYING{animation:lain-pulse 1.6s var(--ease) infinite}
.sessx,.sessdel{position:absolute;top:50%;margin-top:-12px;width:24px;height:24px;border-radius:var(--radius-xs);display:none;place-items:center;color:var(--nav-muted);background:var(--surface-raised)}
.sessdel{right:6px} .sessx{right:32px}
.sessrow:hover .sessx,.sessrow:hover .sessdel{display:grid}
.sessx:hover,.sessdel:hover{background:var(--surface-active);color:var(--nav-text)}
.cv-foot{display:flex;gap:4px;padding-top:8px}
.cv-link{flex:1;padding:6px;border-radius:var(--radius-sm);color:var(--nav-muted);font-size:var(--fs-small)}
.cv-link:hover{background:color-mix(in srgb,var(--nav-text) 5%,transparent);color:var(--nav-text)}
.cv-link[aria-pressed=true]{color:var(--nav-text);background:var(--surface-raised)}
.cv-list .empty{padding:10px 8px;font-size:var(--fs-small);color:var(--nav-muted)}

@media (max-width: 1180px){.cbody.with-panel{grid-template-columns:minmax(0,1fr)} .cbody.with-panel .runpanel{display:none}}
@media (max-width: 760px){.chead{padding:6px 16px 8px}.ch-status{display:none}.agent-live{width:calc(100% - 24px)}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var lane = 'chat';
  var sched = false;
  var seg = null;

  function project() { var S = L.state(); return (S && S.workspace && S.workspace.project) || {}; }
  function agentAllowed() { var p = project(); return Boolean(p.attached && !p.missing); }

  /** SWITCH LANE — navigation only; Core is told which view is in front. */
  function setLane(next, opts) {
    if (next === 'agent' && !agentAllowed()) { L.work.projectMenu($('laneAgent'), { then: function () { setLane('agent'); } }); if (seg) seg.set(lane); return; }
    lane = next === 'agent' ? 'agent' : 'chat';
    if (sched) showSchedules(false);
    if (seg) seg.set(lane);
    L.mountConvo($('chatHost'), lane === 'agent' ? 'agent' : 'chat');
    var S = L.state();
    if (S && S.current && S.current.lane === 'engineering' && S.views) {
      var want = lane === 'agent' ? 'coding' : 'chat';
      if (S.views.active !== want) L.api('/api/view/select', { view: want }).then(function () { L.poll(); }, function () {});
    }
    layout();
    live(L.state() || {});
    if (L.composer) L.composer.cells();
    if (!(opts && opts.quiet)) setTimeout(function () { var a = $('ask'); if (a) a.focus(); }, 0);
  }

  // THE TASK PANEL IS SUBORDINATE: shown beside the Coding Agent lane on a wide window, hideable (per viewer).
  function runShown() { try { return localStorage.getItem('lain.chat.run') !== 'hidden'; } catch (e) { return true; } }
  function layout() {
    var wide = lane === 'agent' && runShown();
    // CLASSES, NOT THE CLASS NAME: the preview (workbench/workshop.js) keeps its own 'with-preview' here.
    $('chatBody').classList.toggle('with-panel', wide);
    $('runPanel').hidden = !wide;
    $('runToggle').hidden = lane !== 'agent';
    $('runToggle').setAttribute('aria-pressed', String(wide));
    if (wide) L.work.runPanel($('runPanel'));
  }

  function showSchedules(on, opts) {
    sched = Boolean(on);
    $('chatBody').hidden = sched;
    $('chatSched').hidden = !sched;
    var b = $('chatSchedBtn'); if (b) b.setAttribute('aria-pressed', String(sched));
    if (sched && L.assistant) { $('chatSched').textContent = ''; L.assistant.schedules($('chatSched'), opts || {}); L.assistant.load(); }
  }

  // ---- the header -------------------------------------------------------------------------------------------
  function renderHead(S) {
    var h = S.header || {};
    var p = project();
    $('chatTitle').textContent = S.current.lane === 'cowork' ? 'Conversation' : (h.title && h.title !== '(no task was ever started)' ? h.title : 'New conversation');
    var pb = $('chatProj');
    var sig = JSON.stringify([p.attached, p.root, p.github, p.name]);
    if (pb.dataset.sig !== sig) {
      pb.dataset.sig = sig;
      pb.textContent = '';
      pb.className = 'ch-proj' + (p.attached ? '' : ' none');
      pb.appendChild(el('span', 'pd'));
      pb.appendChild(el('span', '', p.attached ? p.root : (p.github ? p.github + ' · not cloned' : 'No project folder')));
      pb.setAttribute('data-tip', p.attached ? 'Project: ' + p.name + ' — move or remove' : 'Add a project to enable the Coding Agent');
    }
    var ok = agentAllowed();
    $('laneAgent').setAttribute('aria-disabled', String(!ok));
    var w = S.workbench || {};
    var dot = $('laneDot');
    dot.hidden = !(w.running || (w.offers || []).length || (w.findings || []).some(function (f) { return f.state === 'OPEN'; }));
    dot.className = 'lane-dot' + ((w.findings || []).some(function (f) { return f.state === 'OPEN' && f.blocking; }) || (w.quota && w.quota.state === 'QUOTA_PAUSED') || w.hostPaused ? ' warn' : '');
    $('chatStatus').textContent = w.status && w.status !== 'Idle' ? w.status : '';
    if (lane === 'agent' && !ok) setLane('chat', { quiet: true });
  }

  // ---- THE LIVE CARD (Core state only) --------------------------------------------------------------------------
  function live(S) {
    var box = $('agentLive');
    var w = S.workbench || {};
    var q = w.quota && w.quota.state === 'QUOTA_PAUSED';
    var show = lane === 'chat' && !sched && (w.running || q || w.hostPaused);
    if (!show) { if (!box.hidden) { box.hidden = true; box.dataset.sig = ''; } return; }
    var ph = w.phase || {};
    var ex = S.execution || {};
    var step = ph.current ? ph.current.text : '';
    var doing = w.running ? (ex.detail || (S.header && S.header.status && S.header.status.detail) || '') : (w.status || '');
    var sig = JSON.stringify([w.running, q, w.hostPaused, ph.current && ph.current.n, ph.total, step, doing]);
    if (box.dataset.sig === sig && !box.hidden) return;
    box.dataset.sig = sig;
    box.hidden = false;
    box.className = 'agent-live' + (w.running ? '' : ' paused');
    box.textContent = '';
    var ic = el('span', 'al-ic'); ic.appendChild(L.icon(w.running ? 'code' : 'pause', 17)); box.appendChild(ic);
    var hd = el('div', 'al-h');
    hd.appendChild(el('b', '', w.running ? 'Coding Agent working' : 'Coding Agent paused'));
    if (ph.current && ph.total) hd.appendChild(el('span', '', 'Phase ' + ph.current.n + ' / ' + ph.total));
    box.appendChild(hd);
    var d = el('div', 'al-d');
    if (step) d.appendChild(el('i', '', step));
    if (doing && doing !== step) d.appendChild(document.createTextNode((step ? ' · ' : '') + doing));
    if (!step && !doing) d.textContent = w.status || 'Working';
    d.title = d.textContent;
    box.appendChild(d);
    var a = el('div', 'al-a');
    a.appendChild(L.kit.button('View Coding Agent', 'sm line', function () { setLane('agent'); }));
    if (w.running) a.appendChild(L.kit.button('Pause', 'sm ghost', function () { L.api('/api/interrupt', {}).then(function () { L.poll(); }); }, 'pause'));
    else a.appendChild(L.kit.button('Continue', 'sm pri', function () { L.api('/api/workbench/continue', {}).then(function (r) { if (r && r.ok === false) L.toast(r.why, true); L.poll(); }); }, 'play'));
    box.appendChild(a);
  }

  // ---- THE CONVERSATIONS (in the rail) ----------------------------------------------------------------------------
  var filterOn = false;
  /** A session's name as a person reads it — an empty one is a new conversation. */
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
  function sessRow(s) {
    var row = el('div', 'sessrow');
    row.setAttribute('aria-current', String(Boolean(s.current)));
    var b = el('button', 'sess');
    b.appendChild(el('span', 'tt', titleOf(s)));
    var sub = s.live && s.status && s.status !== 'IDLE' && s.detail ? s.detail : [s.assigned ? s.project : '', ago(s.at) || s.when].filter(Boolean).join(' · ');
    b.appendChild(el('span', 'ss', sub || (s.current ? 'Open now' : '')));
    if (s.current || (s.status && s.status !== 'IDLE' && s.status !== 'DONE')) { var dot = el('span', 'sdot' + (s.status ? ' ' + s.status : '')); dot.title = s.status ? s.status.toLowerCase() + (s.detail ? ' · ' + s.detail : '') : 'open'; b.appendChild(dot); }
    b.title = (s.current ? 'The conversation you are viewing' : 'Open this conversation') + (s.cwd ? '\n' + s.cwd : '');
    b.onclick = function () { if (sched) showSchedules(false); if (!s.current) L.sessions.select(s.id); if (L.nav.tab() !== 'chat') L.nav.go('chat'); };
    row.appendChild(b);
    if (s.live && !s.current) { var x = el('button', 'sessx'); x.appendChild(L.icon('close', 13)); x.setAttribute('data-tip', 'Close this view — the conversation is kept and any work carries on'); x.onclick = function (ev) { ev.stopPropagation(); L.sessions.close(s.id); }; row.appendChild(x); }
    if (!s.current) { var del = el('button', 'sessdel'); del.appendChild(L.icon('trash', 13)); del.setAttribute('data-tip', 'Delete this conversation'); del.onclick = function (ev) { ev.stopPropagation(); L.sessions.remove(s); }; row.appendChild(del); }
    return row;
  }
  function drawRoom(box) {
    if (!box.querySelector('.cv-head')) {
      var hd = el('div', 'cv-head');
      hd.appendChild(el('b', '', 'Conversations'));
      var find = el('button', 'u-ib'); find.id = 'chatFind'; find.appendChild(L.icon('search', 15)); find.setAttribute('data-tip', 'Search conversations'); find.setAttribute('aria-label', 'Search conversations');
      find.onclick = function () { filterOn = !filterOn; $('chatFilterBox').hidden = !filterOn; if (filterOn) $('chatFilter').focus(); else { $('chatFilter').value = ''; list(true); } };
      hd.appendChild(find);
      var nw = el('button', 'u-ib cv-new'); nw.id = 'newChat'; nw.appendChild(L.icon('plus', 16)); nw.setAttribute('data-tip', 'New conversation'); nw.setAttribute('aria-label', 'New conversation');
      nw.onclick = newChat;
      hd.appendChild(nw);
      box.appendChild(hd);
      var sb = el('div', 'cv-search'); sb.id = 'chatFilterBox'; sb.hidden = true;
      sb.appendChild(L.icon('search', 13));
      var inp = el('input', ''); inp.id = 'chatFilter'; inp.placeholder = 'Search conversations'; inp.autocomplete = 'off'; inp.spellcheck = false;
      inp.addEventListener('input', function () { list(true); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { filterOn = false; sb.hidden = true; inp.value = ''; list(true); } });
      sb.appendChild(inp);
      box.appendChild(sb);
      var ls = el('div', 'cv-list'); ls.id = 'sessions'; box.appendChild(ls);
      var ft = el('div', 'cv-foot');
      var sc = el('button', 'cv-link', 'Schedules'); sc.id = 'chatSchedBtn'; sc.onclick = function () { if (L.nav.tab() !== 'chat') L.nav.go('chat'); showSchedules(!sched); };
      var hs = el('button', 'cv-link', 'All sessions'); hs.id = 'chatHistoryBtn'; hs.onclick = function () { L.nav.go('session'); };
      ft.appendChild(sc); ft.appendChild(hs);
      box.appendChild(ft);
    }
    list(false);
  }
  function list(force) {
    var box = $('sessions');
    if (!box) return;
    var q = ($('chatFilter') ? $('chatFilter').value : '').trim().toLowerCase();
    var all = L.sessions.all().filter(function (s) { return s.lane === 'engineering' || s.lane === 'cowork'; });
    var rows = all.filter(function (s) { return !q || ((s.title || '') + ' ' + (s.project || '') + ' ' + (s.source || '')).toLowerCase().indexOf(q) >= 0; });
    var sig = JSON.stringify([q, rows.map(function (s) { return [s.id, s.title, s.current, s.status, s.detail, s.when, s.live, s.project]; })]);
    if (!force && box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    if (!rows.length) { box.appendChild(el('div', 'empty', q ? 'No conversation matches.' : 'No conversations yet.')); return; }
    // WORKING NOW first — a conversation whose Agent is busy is where attention goes back to.
    var busy = rows.filter(function (s) { return s.live && s.status && s.status !== 'IDLE' && s.status !== 'DONE' && !s.current; });
    var rest = rows.filter(function (s) { return busy.indexOf(s) < 0; }).sort(function (a, b) { return (b.current ? 1 : 0) - (a.current ? 1 : 0) || (b.at || 0) - (a.at || 0); });
    if (busy.length) { box.appendChild(el('div', 'cv-sec', 'Working')); busy.forEach(function (s) { box.appendChild(sessRow(s)); }); box.appendChild(el('div', 'cv-sec', 'Recent')); }
    rest.forEach(function (s) { box.appendChild(sessRow(s)); });
  }

  // ---- actions --------------------------------------------------------------------------------------------------
  async function newChat() {
    L.nav.go('chat');
    var r = await L.sessions.create('engineering');
    if (r) { L.nav.go('chat'); setLane('chat'); }
  }
  function ask(q) { var a = $('ask'); a.value = q; L.send(); }
  async function rename() {
    var S = L.state() || {};
    var v = await L.dialog({ title: 'Rename conversation', fields: [{ key: 'title', label: 'Title', value: (S.header && S.header.title) || '' }], ok: 'Rename' });
    if (!v) return;
    var r = await L.api('/api/session/rename', { title: v.title });
    if (!r || !r.ok) return L.toast((r && r.why) || 'could not rename', true);
    L.poll();
  }
  function moreMenu() {
    var w = (L.state() || {}).workbench || {};
    L.kit.menu($('chatMore'), [
      { label: 'Rename', icon: 'pencil', run: rename },
      { label: project().attached ? 'Project · ' + project().name : 'Add project', note: 'move, remove, create or clone', icon: 'folder', run: function () { L.work.projectMenu($('chatProj')); } },
      { label: w.surface && w.surface.writer === 'cli' ? 'Take back from CLI' : 'Continue in CLI', note: 'the same task, handed to the terminal', icon: 'terminal', run: function () { L.work.continueInCli(); } },
      { label: 'Open in IDE', note: 'the editor, with the Coding Agent beside it', icon: 'ide', run: function () { if (L.ide && L.ide.openTask) L.ide.openTask(); else L.nav.go('ide'); } },
      { sep: true },
      { label: 'Schedules', note: 'reminders, recurring tasks, watches', icon: 'calendar', run: function () { showSchedules(true); } },
      { label: 'All sessions', note: 'history, external sessions', icon: 'session', run: function () { L.nav.go('session'); } },
    ], { alignRight: true });
  }

  function laneTip(show) {
    var t = document.getElementById('laneTip');
    if (!show || agentAllowed()) { if (t) t.remove(); return; }
    var p = project();
    if (!t) { t = el('div', 'lanetip'); t.id = 'laneTip'; document.body.appendChild(t); }
    t.textContent = p.github ? 'This GitHub project must be cloned locally before the Coding Agent can edit it.' : 'The Coding Agent works in a project folder. Choose a folder, create a project, or clone one from GitHub.';
    var r = $('laneAgent').getBoundingClientRect();
    t.style.left = Math.max(8, Math.min(window.innerWidth - 310, r.left)) + 'px';
    t.style.top = (r.bottom + 8) + 'px';
  }

  L.chat = {
    newChat: newChat, ask: ask,
    lane: function (v) { if (v) { L.nav.go('chat'); setLane(v); } return lane; },
    /** THE FULL CODING CHAT: the Coding Agent lane in the Chat layout — the same task and session. */
    openCoding: function () { L.nav.go('chat', { lane: 'agent' }); },
    schedules: showSchedules,
    continueInIde: function () { if (L.ide && L.ide.openTask) L.ide.openTask(); else L.nav.go('ide'); },
  };

  L.onBoot(function () {
    // THE LANES — one segmented control; the chosen one is a raised pill that slides.
    seg = L.kit.segmented([['chat', 'Chat', { dot: true }], ['agent', 'Coding Agent', { dot: true }]], lane, function (id) { setLane(id); }, { cls: 'lanes' });
    seg.setAttribute('aria-label', 'Session lanes');
    $('chatLanes').appendChild(seg);
    var lc = seg.querySelector('[data-seg=chat]'); lc.id = 'laneChat'; lc.setAttribute('data-lane', 'chat'); lc.classList.add('lane');
    var la = seg.querySelector('[data-seg=agent]'); la.id = 'laneAgent'; la.setAttribute('data-lane', 'agent'); la.classList.add('lane');
    var ld = el('span', 'lane-dot'); ld.id = 'laneDot'; ld.hidden = true; la.appendChild(ld);
    $('chatRename').appendChild(L.icon('pencil', 14));
    $('chatMore').appendChild(L.icon('dots', 18));
    $('chatRename').onclick = rename;
    $('chatMore').onclick = moreMenu;
    $('chatProj').onclick = function () { L.work.projectMenu($('chatProj')); };
    la.onmouseenter = function () { laneTip(true); };
    la.onmouseleave = function () { laneTip(false); };
    $('chatPreviewIc').appendChild(L.icon('preview', 14));
    // PREVIEW FROM CHAT: the project's page beside the conversation — the same preview the IDE shows.
    $('chatPreviewBtn').onclick = function () { if (L.workshop && L.workshop.isOpen()) L.workshop.close(); else if (L.preview && L.preview.open) L.preview.open(); else if (L.workshop) L.workshop.open(); };
    $('runToggle').onclick = function () { try { localStorage.setItem('lain.chat.run', runShown() ? 'hidden' : 'shown'); } catch (e) { /* per viewer */ } layout(); };
    L.rail.room('chat', drawRoom);
    L.nav.onShow('chat', function (o) {
      if (o && o.section === 'schedules') showSchedules(true, o);
      else if (o && (o.lane === 'agent' || o.section === 'agent')) setLane('agent');
      else setLane(lane, { quiet: false });
    });
  });
  L.onRender(function (S) {
    if (L.nav.tab() !== 'chat') return;
    if (!sched) L.mountConvo($('chatHost'), lane === 'agent' ? 'agent' : 'chat');
    renderHead(S);
    live(S);
    if (lane === 'agent' && runShown()) L.work.runPanel($('runPanel'));
  });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
