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
    if (selected !== NATIVE && (!selected || !rows.some(function (s) { return s.id === selected; }))) {
      var cur = rows.filter(function (s) { return s.current; })[0];
      selected = cur ? cur.id : (rows[0] ? rows[0].id : null);
    }
    var sig = JSON.stringify([q, selected, rows.map(function (s) { return [s.id, s.title, s.status, s.at, s.current, s.live]; })]);
    if (box.dataset.sig === sig) return rows;
    box.dataset.sig = sig;
    box.textContent = '';
    // NATIVE SESSIONS other runtimes own (Codex, Claude Code) — seen, never taken.
    var nb = el('button', 'srow');
    nb.setAttribute('aria-selected', String(selected === NATIVE));
    nb.setAttribute('data-native', '1');
    nb.appendChild(el('span', 't', ''));
    var nm = el('span', 'm'); nm.appendChild(el('b', '', 'Native sessions')); nm.appendChild(el('span', '', 'Codex, Claude Code — owned by their runtimes')); nb.appendChild(nm);
    nb.appendChild(el('span', 'r', ''));
    nb.onclick = function () { selected = NATIVE; native = null; draw(); };
    box.appendChild(nb);
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

  var NATIVE = '__native__', native = null, nativeLoading = false;
  function nativeDetail(pane) {
    pane.textContent = '';
    pane.dataset.sig = '';
    pane.appendChild(el('h2', '', 'Native sessions'));
    pane.appendChild(el('div', 'sub', 'Sessions Codex and Claude Code keep themselves. LAIN lists them; it does not change them. Resume one where it lives, or continue it as a new LAIN session.'));
    if (!native) {
      pane.appendChild(el('div', 'missing', 'Reading…'));
      if (!nativeLoading) { nativeLoading = true; L.api('/api/external/sessions', {}).then(function (r) { nativeLoading = false; native = r && r.ok ? r : { sessions: [], adapters: {}, errors: [{ why: (r && r.why) || 'could not read' }] }; if (selected === NATIVE) nativeDetail(pane); }); }
      return;
    }
    (native.errors || []).forEach(function (e) { pane.appendChild(el('div', 'note bad', (e.runtime || '') + ': ' + e.why)); });
    if (!native.sessions.length) pane.appendChild(el('div', 'missing', 'None visible. Codex sessions appear once a Codex account is signed in (Model › Accounts); OpenCode sessions for the open project appear once OpenCode is detected (Model › Runtimes).'));
    native.sessions.slice(0, 100).forEach(function (x) {
      var card = el('div', 'route');
      card.setAttribute('data-origin', x.origin);
      var h = el('div', 'rh'); h.appendChild(el('b', '', x.title)); card.appendChild(h);
      card.appendChild(el('div', 'missing', [x.runtime + (x.unofficial ? ' (unofficial listing)' : ''), x.cwd, x.updatedAt ? new Date(x.updatedAt).toLocaleString() : null, x.holder ? 'being written by ' + x.holder : null].filter(Boolean).join(' · ')));
      var acts = el('div', 'sd-actions');
      var acct = x.compatibleAccounts[0];
      if (x.compatibleAccounts.length > 1) {
        var sel = document.createElement('select');
        x.compatibleAccounts.forEach(function (a) { var o = document.createElement('option'); o.value = a; o.textContent = a; sel.appendChild(o); });
        sel.onchange = function () { acct = sel.value; };
        acts.appendChild(sel);
      }
      var ro = el('button', 'btn small', x.runtime === 'opencode' ? 'Resume in OpenCode' : 'Resume original');
      ro.onclick = async function () {
        var r = await L.api('/api/external/resume', { origin: x.origin, account: acct, cwd: x.cwd });
        if (!r.ok) return L.toast(r.why, true);
        var envs = Object.keys(r.env || {}).map(function (k) { return k + '=' + r.env[k]; }).join('  ');
        L.dialog({ title: 'Resume in ' + r.runtime, pre: (r.cwd ? 'cd "' + r.cwd + '"\n' : '') + (envs ? envs + '\n' : '') + r.command, text: 'Run this in a terminal — it ' + r.note + '.', ok: 'Close', cancel: 'Close' });
      };
      acts.appendChild(ro);
      if (x.runtime === 'codex' || x.runtime === 'opencode') {
        var ci = el('button', 'btn small primary', 'Continue in LAIN');
        ci.onclick = async function () {
          ci.disabled = true;
          var r = await L.api('/api/external/continue', { origin: x.origin, account: acct, cwd: x.cwd });
          ci.disabled = false;
          if (!r.ok) return L.toast(r.why, true);
          L.toast('A new LAIN session continues it (' + r.turns + ' turn(s) imported' + (r.truncated ? ', the earliest trimmed' : '') + '). The ' + (x.runtime === 'opencode' ? 'OpenCode session' : 'Codex thread') + ' is unchanged.');
          L.poll(); selected = r.session;
        };
        acts.appendChild(ci);
      }
      card.appendChild(acts);
      pane.appendChild(card);
    });
    var ad = native.adapters || {};
    pane.appendChild(el('div', 'missing', Object.keys(ad).map(function (k) { return k + ': ' + ad[k].level.toLowerCase() + ' (' + ad[k].via + ')'; }).join(' · ')));
  }
  function detail(S, rows) {
    var pane = $('sessPane');
    if (selected === NATIVE) { if (!pane.dataset.native) { pane.dataset.native = '1'; nativeDetail(pane); } return; }
    pane.dataset.native = '';
    var s = rows.filter(function (x) { return x.id === selected; })[0];
    var sp = S.journey || {};
    var sig = JSON.stringify([s, s && s.current ? [S.changes, S.plan, S.models, S.harness && S.harness.verification, S.workspace && S.workspace.project, sp.route, sp.agentTask && sp.agentTask.id, (sp.path || []).length] : null]);
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
      // ONE WORKING SESSION, ITS PATH (Core's journey.js): Chat → Agent → IDE →
      // a hand edit → BOT … — not seven separate sessions.
      if (sp.agentTask) put('Agent task', sp.agentTask.objective + ' · ' + String(sp.agentTask.state || '').toLowerCase() + (sp.agentTask.origin ? ' · began in ' + sp.agentTask.origin : ''));
      if (sp.route && sp.route.length) put('Path', sp.route.join(' → '));
    }
    pane.appendChild(dl);
    if (s.current && sp.path && sp.path.length) {
      var WORD = { surface: 'went to', bot: 'BOT answered', proposed: 'BOT asked: move to Agent?', moved: 'moved to the Agent', stayed: 'stayed with the BOT', 'agent.start': 'Coding Agent started', 'agent.end': 'Coding Agent finished', 'user.edit': 'you edited', focus: 'entered /focus', capability: 'BOT opened' };
      pane.appendChild(el('h3', '', 'What happened'));
      var tl = el('div', 'sd-files');
      sp.path.slice(-14).reverse().forEach(function (e) {
        var r = el('div', 'row');
        r.appendChild(el('span', 'at', new Date(e.at).toLocaleTimeString()));
        r.appendChild(el('span', 'path', (WORD[e.kind] || e.kind) + (e.surface ? ' ' + e.surface + (e.pane ? ' (' + e.pane + ')' : '') : '') + (e.path ? ' ' + e.path + (e.lines ? ':' + e.lines : '') : '') + (e.capability ? ' ' + e.capability : '') + (e.via ? ' · from ' + e.via : '')));
        tl.appendChild(r);
      });
      pane.appendChild(tl);
    }
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
  function draw() { var S = L.state(); if (S) { $('sessList').dataset.sig = ''; $('sessPane').dataset.native = ''; render(S); } }

  L.sessionView = { open: open };
  L.onBoot(function () {
    $('sessFilter').addEventListener('input', draw);
    // A SESSION NAMED BY THE HOUSE (house.js session.open): shown, not switched to.
    L.nav.onShow('session', function (o) { if (o && o.id) selected = o.id; draw(); });
  });
  L.onRender(render);
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
