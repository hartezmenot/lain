'use strict';

/**
 * SESSION — previous work, and the way back into it.
 *
 * ------------------------------------------------------------------------
 * EVERY SESSION CORE KNOWS, GROUPED BY WHEN IT WAS LAST TOUCHED. The rows are
 * S.sessions (sessionindex.js — the same summaries `/resume` prints), so this
 * view and the terminal cannot disagree about what a session was.
 *
 * RESTORE IS POST /api/session/select, and then the surface the session
 * belongs in: the IDE when it has a project attached, Chat otherwise. What
 * comes back is what Core keeps — the conversation, its project, its model
 * choices, its changes, plan and handoff. The detail pane shows those facts for
 * the session in front and, for any other, only what the index records: a
 * duration, a token count or a test tally Core does not store is not drawn.
 */

const HTML = `
<section class="view sessv split" id="vSession" data-view="session" hidden>
  <div class="snav-col slist">
    <input id="sessFilter" class="cr-filter" placeholder="Filter sessions" autocomplete="off" spellcheck="false">
    <div id="sessList"></div>
  </div>
  <div class="spane" id="sessPane"></div>
</section>`;

const CSS = `
.sessv{grid-template-columns:360px minmax(0,1fr)}
.slist{padding:12px 8px}
.slist .cr-filter{width:100%;margin:0 0 6px}
.srow{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:10px;width:100%;text-align:left;padding:8px 8px;border-radius:var(--radius-s);align-items:start}
.srow:hover{background:var(--surface)}
.srow[aria-selected=true]{background:var(--accent-weak)}
.srow .t{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;padding-top:1px}
.srow .m{min-width:0}
.srow .m b{display:block;font-size:12.5px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.srow .m span{display:block;font-size:12px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.srow .r{font-size:11px;color:var(--faint);text-align:right;white-space:nowrap}
.srow .r .sdot{font-size:9px}
.sd-facts{display:grid;grid-template-columns:150px 1fr;gap:8px 14px;font-size:13px;max-width:720px;margin:6px 0 20px}
.sd-facts dt{color:var(--faint)} .sd-facts dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.sd-actions{display:flex;gap:8px;flex-wrap:wrap}
.sd-files{max-width:720px}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var selected = null;

  function dayGroup(ms) {
    if (!ms) return 'Earlier';
    var now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= start) return 'Today';
    if (ms >= start - 86400000) return 'Yesterday';
    if (ms >= start - 6 * 86400000) return 'This week';
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
  }

  async function open(s) {
    if (!s.current) { var ok = await L.sessions.select(s.id); if (!ok) return; }
    var S = L.state();
    var attached = S && S.current.lane === 'engineering' && S.workspace && S.workspace.project && S.workspace.project.attached;
    L.nav.go(attached ? 'ide' : 'chat');
  }

  function list(S) {
    var box = $('sessList');
    var q = ($('sessFilter').value || '').trim().toLowerCase();
    var rows = L.sessions.all().filter(function (s) { return !q || ((s.title || '') + ' ' + (s.project || '') + ' ' + (s.source || '')).toLowerCase().indexOf(q) >= 0; });
    if (!selected || !rows.some(function (s) { return s.id === selected; })) {
      var cur = rows.filter(function (s) { return s.current; })[0];
      selected = cur ? cur.id : (rows[0] ? rows[0].id : null);
    }
    var sig = JSON.stringify([q, selected, rows.map(function (s) { return [s.id, s.title, s.status, s.at, s.current, s.live]; })]);
    if (box.dataset.sig === sig) return rows;
    box.dataset.sig = sig;
    box.textContent = '';
    if (!rows.length) box.appendChild(el('div', 'empty', q ? 'No session matches.' : 'No sessions yet.'));
    var group = null;
    rows.forEach(function (s) {
      var g = dayGroup(s.at);
      if (g !== group) { group = g; box.appendChild(el('div', 'cr-group', g)); }
      var b = el('button', 'srow');
      b.setAttribute('aria-selected', String(s.id === selected));
      b.appendChild(el('span', 't', L.fmt.time(s.at)));
      var m = el('span', 'm');
      m.appendChild(el('b', '', s.lane === 'engineering' && s.project ? s.project : (s.source && s.source !== 'harness' ? s.source : 'Chat')));
      m.appendChild(el('span', '', s.title || '(untitled)'));
      b.appendChild(m);
      var r = el('span', 'r');
      if (s.status) { var d = el('span', 'sdot ' + s.status, L.sessions.MARK[s.status] || ''); r.appendChild(d); r.appendChild(document.createTextNode(' ' + s.status.toLowerCase())); }
      else r.textContent = s.turns ? s.turns + ' turns' : '';
      b.appendChild(r);
      b.onclick = function () { selected = s.id; draw(); };
      b.ondblclick = function () { open(s); };
      box.appendChild(b);
    });
    return rows;
  }

  function detail(S, rows) {
    var pane = $('sessPane');
    var s = rows.filter(function (x) { return x.id === selected; })[0];
    var sig = JSON.stringify([s, s && s.current ? [S.changes, S.plan, S.models, S.harness && S.harness.verification, S.workspace && S.workspace.project] : null]);
    if (pane.dataset.sig === sig) return;
    pane.dataset.sig = sig;
    pane.textContent = '';
    if (!s) { pane.appendChild(el('div', 'missing', 'Choose a session.')); return; }
    pane.appendChild(el('h2', '', s.title || '(untitled)'));
    pane.appendChild(el('div', 'sub', (s.at ? new Date(s.at).toLocaleString() : s.when) + (s.current ? '  ·  in front now' : s.live ? '  ·  open in this LAIN' : '')));
    var dl = el('dl', 'sd-facts');
    var put = function (k, v) { if (v == null || v === '') return; dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); };
    put('Kind', s.lane === 'cowork' ? 'Conversation with files' + (s.source && s.source !== 'harness' ? ' · from ' + s.source : '') : 'Chat / IDE');
    put('Project', s.lane === 'engineering' ? (s.cwd || s.project) : '');
    put('Turns', String(s.turns || 0));
    put('Status', s.state && s.state.state ? s.state.state.toLowerCase().replace(/_/g, ' ') + (s.state.summary ? ' — ' + s.state.summary : '') : (s.status ? s.status.toLowerCase() : 'resting'));
    if (s.current) {
      var m = S.models || {};
      put('BOT model', m.chat ? (m.chat.source !== 'lain' ? (m.chat.label || m.chat.source) + ' ' : '') + (L.fmt.model(m.chat.modelId) || '') : '');
      put('Coding Agent', m.coding ? L.fmt.model(m.coding.modelId) : '');
      put('Files changed', String((S.changes || []).length));
      if (S.plan) put('Plan', S.plan.done + ' of ' + S.plan.total + ' steps');
      var h = S.plans && S.plans.handoff;
      if (h) put('Handoff', h.state.toLowerCase());
      var v = S.harness && S.harness.verification;
      if (v) put('Verification', v.verdict.toLowerCase() + (v.passed ? ' · ' + v.passed + ' passed' : '') + (v.failed ? ' · ' + v.failed + ' failed' : ''));
    }
    pane.appendChild(dl);
    var acts = el('div', 'sd-actions');
    var restore = el('button', 'btn primary', s.current ? 'Go to it' : 'Restore session');
    restore.onclick = function () { open(s); };
    acts.appendChild(restore);
    if (s.live && !s.current) {
      var cl = el('button', 'btn', 'Close view');
      cl.title = 'The conversation is kept and any work in it carries on.';
      cl.onclick = function () { L.sessions.close(s.id); };
      acts.appendChild(cl);
    }
    if (!s.current) {
      var del = el('button', 'btn danger', 'Delete');
      del.onclick = function () { L.sessions.remove(s); };
      acts.appendChild(del);
    }
    pane.appendChild(acts);
    if (s.current && (S.changes || []).length) {
      pane.appendChild(el('h3', '', 'Touched files'));
      var f = el('div', 'sd-files');
      S.changes.forEach(function (c) {
        var r = el('div', 'row');
        r.appendChild(el('span', 'path', c.path));
        if (c.added) r.appendChild(el('span', 'add', '+' + c.added));
        if (c.removed) r.appendChild(el('span', 'del', '-' + c.removed));
        f.appendChild(r);
      });
      pane.appendChild(f);
    }
    if (!s.current) pane.appendChild(el('div', 'missing', 'Restoring brings back what LAIN keeps for a session: its conversation, project, model choices, changes, plan and handoff.'));
  }

  function render(S) {
    if (L.nav.tab() !== 'session') return;
    detail(S, list(S));
  }
  function draw() { var S = L.state(); if (S) { $('sessList').dataset.sig = ''; render(S); } }

  L.sessionView = { open: open };
  L.onBoot(function () {
    $('sessFilter').addEventListener('input', draw);
    L.nav.onShow('session', draw);
  });
  L.onRender(render);
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
