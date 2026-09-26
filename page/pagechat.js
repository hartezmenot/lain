'use strict';

/**
 * CHAT — conversation with the BOT, for everything that is not editing code.
 *
 * ------------------------------------------------------------------------
 * A CONVERSATION RAIL AND THE CONVERSATION. Research, planning, discussion,
 * questions and file work. Every conversation is a Core session: the rail is
 * S.sessions (both kinds — a chat started here and one that arrived from
 * Telegram are the same BOT), and choosing one is POST /api/session/select.
 *
 * ------------------------------------------------------------------------
 * CHAT → IDE IS CORE'S HANDOFF, NOT A PASTE.
 *
 * "Continue in IDE" accepts a plan (planhandoff.js): the plan is frozen and
 * Core builds a brief — requirements, constraints, files, project facts,
 * evidence — and prefills the Coding composer from it. When the BOT's reply
 * already reads as a plan, Core has drafted it and the card in the stream
 * offers the same step. Nothing moves to the IDE until the person says so.
 */

const HTML = `
<section class="view chatv" id="vChat" data-view="chat" hidden>
  <aside class="chat-rail">
    <div class="cr-top">
      <button class="btn primary block" id="newChat"><span id="newChatIc"></span>New chat</button>
      <input id="chatFilter" class="cr-filter" placeholder="Filter conversations" autocomplete="off" spellcheck="false">
      <button class="btn small block" id="chatSchedBtn">Schedules</button>
    </div>
    <div class="cr-list" id="sessions"></div>
    <div class="cr-foot" id="chatProjects"></div>
  </aside>
  <div class="chat-main" id="chatHost"></div>
  <div class="chat-sched" id="chatSched" hidden></div>
</section>`;

const CSS = `
.chatv{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:0}
.chat-rail{display:flex;flex-direction:column;min-height:0;background:var(--panel);border-right:1px solid var(--line)}
.cr-top{padding:12px 12px 8px;display:grid;gap:8px}
.btn.block{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:7px 10px}
.cr-filter{background:var(--surface);border:1px solid var(--line2) !important;border-radius:var(--radius-s);padding:5px 9px;font-size:12.5px}
.cr-list{flex:1;min-height:0;overflow-y:auto;padding:4px 6px 10px}
.cr-group{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);padding:10px 8px 4px}
.sessrow{position:relative;display:flex;align-items:stretch;border-radius:var(--radius-s)}
.sessrow:hover{background:var(--surface)}
.sessrow[aria-current=true]{background:var(--raise)}
.sess{flex:1;min-width:0;text-align:left;padding:6px 8px}
.sess .p{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink)}
.sess .p .tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sess .w{font-size:11px;color:var(--faint);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sess .sdot{font-size:9px;flex:none}
.sdot.RUNNING{color:var(--accent)} .sdot.WAITING{color:var(--warn)} .sdot.STOPPED{color:var(--bad)} .sdot.DONE{color:var(--ok)} .sdot.IDLE{color:var(--faint)}
.src{display:inline-block;font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);background:var(--surface);border:1px solid var(--line2);border-radius:3px;padding:0 4px;flex:none}
.sessx,.sessdel{flex:none;width:22px;color:var(--faint);opacity:0;font-size:14px;line-height:1}
.sessrow:hover .sessx,.sessrow:hover .sessdel{opacity:1}
.sessx:hover{color:var(--ink)} .sessdel:hover{color:var(--bad)}
.cr-foot{border-top:1px solid var(--line);padding:8px 6px 10px;max-height:34%;overflow-y:auto}
.cr-foot h5{margin:2px 8px 4px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:600}
.chat-main{display:flex;flex-direction:column;min-height:0;min-width:0}
.chat-main .convo{flex:1}
.chat-main .stream,.chat-main .composer,.chat-main .convo-head{width:100%;max-width:880px;margin:0 auto}
.chat-main .objects,.chat-main .card{max-width:836px;margin-left:auto;margin-right:auto}
@media (max-width: 760px){.chatv{grid-template-columns:minmax(0,1fr)}.chat-rail{display:none}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var recent = null;
  // CHAT › SCHEDULES — the assistant's one task store (pageassistant.js), in place of the conversation.
  var sched = false;
  function showSchedules(on, opts) {
    sched = Boolean(on);
    $('chatHost').hidden = sched;
    $('chatSched').hidden = !sched;
    $('chatSchedBtn').setAttribute('aria-pressed', String(sched));
    $('chatSchedBtn').textContent = sched ? 'Back to conversation' : 'Schedules';
    if (sched && L.assistant) { $('chatSched').textContent = ''; L.assistant.schedules($('chatSched'), opts || {}); L.assistant.load(); }
  }

  function dayGroup(ms) {
    if (!ms) return 'Earlier';
    var d = new Date(ms), now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= start) return 'Today';
    if (ms >= start - 86400000) return 'Yesterday';
    if (ms >= start - 6 * 86400000) return 'This week';
    return 'Earlier';
  }

  function renderRail(S) {
    var box = $('sessions');
    var q = ($('chatFilter').value || '').trim().toLowerCase();
    var list = L.sessions.all().filter(function (s) {
      return !q || ((s.title || '') + ' ' + (s.project || '') + ' ' + (s.source || '')).toLowerCase().indexOf(q) >= 0;
    });
    var sig = JSON.stringify([q, list.map(function (s) { return [s.id, s.title, s.current, s.status, s.at, s.live]; })]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    if (!list.length) { box.appendChild(el('div', 'empty', q ? 'No conversation matches.' : 'No conversations yet. Ask something to start one.')); return; }
    var group = null;
    list.forEach(function (s) {
      var g = dayGroup(s.at);
      if (g !== group) { group = g; box.appendChild(el('div', 'cr-group', g)); }
      var row = el('div', 'sessrow');
      row.setAttribute('aria-current', String(Boolean(s.current)));
      var b = el('button', 'sess');
      var p = el('div', 'p');
      p.appendChild(el('span', 'tt', s.title || '(untitled)'));
      if (s.source && s.source !== 'harness') p.appendChild(el('span', 'src', s.source));
      if (s.status) { var dot = el('span', 'sdot ' + s.status, L.sessions.MARK[s.status] || ''); dot.title = s.status.toLowerCase() + (s.detail ? ' · ' + s.detail : ''); p.appendChild(dot); }
      b.appendChild(p);
      var w = [s.project && s.lane === 'engineering' ? s.project : (s.lane === 'cowork' ? 'files & tasks' : ''), s.state && s.state.state && s.state.state !== 'IDLE' ? s.state.state.toLowerCase() : s.when].filter(Boolean).join(' · ');
      b.appendChild(el('div', 'w', w));
      b.title = s.current ? 'The conversation you are viewing' : 'Open this conversation';
      b.onclick = function () { if (sched) showSchedules(false); if (!s.current) L.sessions.select(s.id); };
      row.appendChild(b);
      if (s.live && !s.current) {
        var x = el('button', 'sessx', '×');
        x.title = 'Close this view. The conversation is kept and any work in it carries on.';
        x.onclick = function (ev) { ev.stopPropagation(); L.sessions.close(s.id); };
        row.appendChild(x);
      }
      if (!s.current) {
        var del = el('button', 'sessdel', '⌦');
        del.title = 'Delete this conversation permanently.';
        del.onclick = function (ev) { ev.stopPropagation(); L.sessions.remove(s); };
        row.appendChild(del);
      }
      box.appendChild(row);
    });
  }

  function renderProjects() {
    var box = $('chatProjects');
    var rows = (recent && recent.recent) || [];
    box.hidden = !rows.length;
    if (box.dataset.n === String(rows.length)) return;
    box.dataset.n = String(rows.length);
    box.textContent = '';
    box.appendChild(el('h5', '', 'Projects'));
    rows.slice(0, 6).forEach(function (p) {
      var b = el('button', 'hrow');
      b.appendChild(L.icon('folder', 14));
      b.appendChild(el('span', 'ht', p.name));
      b.title = 'Open ' + p.root + ' in the IDE';
      b.onclick = function () { L.ide.open(p.root); };
      box.appendChild(b);
    });
  }

  /** The last thing the BOT said in this Chat thread — what a plan would be drafted from. */
  function lastReply(S) {
    var msgs = (S.conversation || []).filter(function (m) { return m.role === 'assistant' && (m.thread || 'coding') === 'chat'; });
    return msgs.length ? msgs[msgs.length - 1].text : '';
  }

  async function continueInIde() {
    var S = L.state();
    if (!S || S.current.lane !== 'engineering') return;
    var h = S.plans && S.plans.handoff;
    if (h && h.state === 'PREFILLED') { L.nav.go('ide'); return; }
    var id = S.plans && S.plans.prompt ? S.plans.prompt.planId : null;
    if (!id) {
      var text = lastReply(S);
      if (!text) { L.notice('Discuss the task first — the handoff is built from what was agreed here.', true); return; }
      var d = await L.api('/api/plan/draft', { text: text, title: (S.header && S.header.title) || null });
      if (!d.ok) { L.notice(d.why, true); return; }
      id = d.plan.id;
    }
    var r = await L.api('/api/plan/accept', { id: id });
    if (!r.ok) { L.notice(r.why, true); return; }
    await L.poll();
    L.nav.go('ide');
  }

  function renderToIde(S) {
    var b = $('toIde');
    if (!b) return;
    var eng = S.current.lane === 'engineering';
    var h = S.plans && S.plans.handoff;
    var pending = h && h.state === 'PREFILLED';
    var has = eng && (pending || lastReply(S));
    b.hidden = L.ui().mode !== 'chat' || !has;
    b.textContent = pending ? 'Open in IDE' : 'Continue in IDE';
    b.title = pending ? 'A handoff is waiting in the IDE' : 'Hand this discussion to the IDE as a structured task: goal, requirements, constraints and files';
  }

  async function newChat() {
    L.nav.go('chat');
    var r = await L.sessions.create('engineering');
    if (r) { L.nav.go('chat'); setTimeout(function () { $('ask').focus(); }, 0); }
  }

  function ask(q) {
    var a = $('ask');
    a.value = q;
    L.send();
  }

  L.chat = { newChat: newChat, ask: ask, continueInIde: continueInIde };

  L.onBoot(function () {
    $('newChatIc').appendChild(L.icon('plus', 15));
    $('newChat').onclick = newChat;
    $('chatFilter').addEventListener('input', function () { var S = L.state(); if (S) renderRail(S); });
    var head = $('convoHead');
    var btn = el('button', 'btn small', 'Continue in IDE');
    btn.id = 'toIde';
    btn.hidden = true;
    btn.onclick = continueInIde;
    head.insertBefore(btn, $('crumbStop'));
    $('chatSchedBtn').onclick = function () { showSchedules(!sched); };
    L.nav.onShow('chat', function (o) {
      if (o && o.section === 'schedules') showSchedules(true, o); else if (sched && !(o && o.section)) { /* stays where the person left it */ }
      L.api('/api/project/recent', {}).then(function (r) { if (r && r.ok) { recent = r; renderProjects(); } }, function () {});
      setTimeout(function () { $('ask').focus(); }, 0);
    });
  });
  L.onRender(function (S) {
    if (L.nav.tab() === 'chat') { if (!sched) L.mountConvo($('chatHost'), 'chat'); renderRail(S); }
    renderToIde(S);
  });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
