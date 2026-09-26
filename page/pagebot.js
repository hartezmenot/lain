'use strict';

/**
 * THE BOT VIEW — who the BOT is, where it can be reached, who may reach it,
 * and what it can do.
 *
 * ------------------------------------------------------------------------
 * ONE BOT, MANY CHANNELS. The desktop window, Telegram, Discord and WhatsApp
 * are doors into the same BOT; a conversation that arrives through any of
 * them is a Core session like any other (it shows in Chat and Session with
 * its source). Nothing here builds a second assistant per channel.
 *
 * ------------------------------------------------------------------------
 * A REAL FLOW OVER A REAL CONTRACT, src/harnessapp/botroutes.js. Telegram is
 * set up here (token, /start candidates, approve, revoke); Discord and
 * WhatsApp read secrets from the environment and this view shows their state
 * and what is missing.
 *
 * READ WHEN ASKED, NEVER POLLED. Reading connection state may start LAIN's
 * messaging runtime (the supervisor holds the credential), so
 * `POST /api/bot/connections` runs once shortly after launch, when this view
 * opens, and on Refresh — never on the 1.5s state poll.
 *
 * THE TOKEN NEVER PERSISTS CLIENT-SIDE: it lives in the field until Connect,
 * is sent once, and the field is cleared the moment an answer arrives.
 *
 * IDENTITY IS WHAT CORE HAS. The BOT's name is LAIN and its models are the
 * two role selections; this build of Core has no stored tone, language or
 * persona, so the view says so instead of drawing controls that save nothing.
 */

const HTML = `
<section class="view botv split" id="vBot" data-view="bot" hidden>
  <nav class="snav-col" id="botNav"></nav>
  <div class="spane" id="botPane"></div>
</section>`;

const CSS = `
/* ---- the left-nav + detail layout Bot, Model, Session and Settings share -- */
.split{display:grid;grid-template-columns:230px minmax(0,1fr);min-height:0}
.snav-col{background:var(--panel);border-right:1px solid var(--line);overflow-y:auto;padding:14px 8px}
.snav-col h5{margin:14px 10px 4px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:600}
.snav-col h5:first-child{margin-top:0}
.snav{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:6px 10px;border-radius:var(--radius-s);color:var(--dim);font-size:13px}
.snav:hover{color:var(--ink);background:var(--surface)}
.snav[aria-selected=true]{background:var(--accent-weak);color:var(--ink)}
.snav .sv{margin-left:auto;font-size:11px;color:var(--faint)}
.snav .sv.ok{color:var(--ok)} .snav .sv.warn{color:var(--warn)} .snav .sv.bad{color:var(--bad)}
.spane{overflow-y:auto;padding:26px 34px 40px;min-width:0}
.spane h2{font:600 17px/1.3 var(--sans);margin:0 0 4px}
.spane .sub{color:var(--faint);font-size:12.5px;margin:0 0 20px;max-width:720px}
.spane h3{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:600;margin:26px 0 8px}
.fields{max-width:760px}
.field{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:11px 0;border-top:1px solid var(--line)}
.field:first-child{border-top:0}
.field .lbl{font-size:13px}
.field .desc{color:var(--faint);font-size:11.5px;margin-top:2px}
.field .val{color:var(--dim);font-size:12.5px;flex:none;max-width:55%;text-align:right;overflow-wrap:anywhere}
.missing{color:var(--faint);font-size:12.5px;padding:10px 0}
.toggle{width:32px;height:18px;border-radius:9px;background:var(--raise);position:relative;flex:none;box-shadow:inset 0 0 0 1px var(--line2)}
.toggle::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--faint)}
.toggle[aria-checked=true]{background:var(--accent)}
.toggle[aria-checked=true]::after{left:16px;background:var(--accent-ink)}
/* ---- bot cards ------------------------------------------------------------ */
.botcard{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:12px;max-width:760px}
.botcard .head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.botcard .head b{font-size:13.5px;font-weight:600}
.cst{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dim);margin-left:auto}
.cst .sdot{font-size:9px}
.cst.CONNECTED{color:var(--ok)} .cst.AUTH_REQUIRED,.cst.CONNECTING{color:var(--warn)} .cst.FAILED{color:var(--bad)}
.botcard .summary{color:var(--dim);font-size:12.5px;margin-bottom:10px}
.botdiag{margin-top:10px;border-top:1px solid var(--line);padding-top:8px;font-size:12px}
.botdiag .dr{display:flex;gap:10px;padding:2px 0;min-width:0}
.botdiag .dk{flex:none;width:150px;color:var(--faint)}
.botdiag .dv{color:var(--dim);min-width:0;overflow-wrap:anywhere}
.botdiag .dr.bad .dv{color:var(--bad)}
.botcard .checks{margin:8px 0;font-size:12px;color:var(--faint)}
.botcard .connect{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap}
.botcard .connect input{flex:1;min-width:200px;background:var(--bg);border:1px solid var(--line2);border-radius:var(--radius-s);padding:6px 10px;font-family:var(--mono);font-size:12.5px}
.candrow,.userrow{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12.5px;border-top:1px solid var(--line)}
.candrow .id,.userrow .id{font-family:var(--mono);color:var(--dim);flex:1}
.caprow{display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:10px;padding:11px 0;border-top:1px solid var(--line);max-width:760px}
.caprow:first-of-type{border-top:0}
.caprow .ci{color:var(--accent)}
.caprow .cn{font-size:13px}
.caprow .cn small{display:block;color:var(--faint);font-size:11.5px;margin-top:2px}
.caprow .cs{font-size:12px;color:var(--faint)}
.caprow .cs.on{color:var(--ok)}
.caprow .cs.off{color:var(--faint)}
.caprow .cs.warn{color:var(--warn)}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var section = 'identity';
  var focusTask = null;
  var data = null;
  var loading = false;

  async function load(check) {
    if (loading) return;
    loading = true;
    draw();
    try {
      var r = await L.api('/api/bot/connections', { check: Boolean(check) });
      if (r && r.ok) data = r; else if (r) L.toast(r.why, true);
    } catch (e) { /* the view says it could not read */ }
    loading = false;
    draw();
    if (L.nav.tab() === 'home') L.render();
  }

  function platform(id) { return ((data && data.platforms) || []).filter(function (p) { return p.platform === id; })[0] || null; }
  function statusLabel(state) {
    return state === 'CONNECTED' ? 'Connected' : state === 'AUTH_REQUIRED' ? 'Needs re-authorization' : state === 'CONNECTING' ? 'Connecting…' : state === 'FAILED' ? 'Failed' : 'Not connected';
  }
  function summary() {
    if (!data) return '';
    var on = (data.platforms || []).filter(function (p) { return p.state === 'CONNECTED'; }).map(function (p) { return p.platform.charAt(0).toUpperCase() + p.platform.slice(1); });
    return on.length ? on.join(', ') + ' connected' : 'Desktop only · no channels connected';
  }

  // ---- nav ------------------------------------------------------------------
  function nav() {
    var box = $('botNav');
    box.textContent = '';
    var item = function (id, label, icon, side, cls) {
      var b = el('button', 'snav');
      b.appendChild(L.icon(icon, 15));
      b.appendChild(el('span', '', label));
      if (side) b.appendChild(el('span', 'sv ' + (cls || ''), side));
      b.setAttribute('aria-selected', String(section === id));
      b.onclick = function () { section = id; draw(); };
      box.appendChild(b);
    };
    box.appendChild(el('h5', '', 'Bot'));
    item('identity', 'Profile', 'bot');
    item('intelligence', 'Intelligence', 'model');
    item('connections', 'Channels', 'link', data ? String((data.platforms || []).filter(function (p) { return p.state === 'CONNECTED'; }).length) + ' on' : '');
    var tg = platform('telegram');
    item('permissions', 'Permissions', 'shield', tg && tg.candidates && tg.candidates.length ? tg.candidates.length + ' waiting' : '', 'warn');
    item('capabilities', 'Capabilities', 'spark');
    var A = L.assistant && L.assistant.get();
    item('assistant', 'Assistant', 'session', A ? String((A.upcoming || []).length + (A.recurring || []).length + (A.watches || []).length) + ' active' : '');
  }

  function field(pane, label, desc, value) {
    var f = el('div', 'field');
    var l = el('div', '');
    l.appendChild(el('div', 'lbl', label));
    if (desc) l.appendChild(el('div', 'desc', desc));
    f.appendChild(l);
    f.appendChild(typeof value === 'string' ? el('span', 'val', value) : value);
    pane.appendChild(f);
  }

  // ---- profile -------------------------------------------------------------------
  var profile = null;
  function identity(pane) {
    pane.appendChild(el('h2', '', 'Profile'));
    pane.appendChild(el('div', 'sub', 'How the BOT talks — in this window and on every connected channel. Style only: a profile grants no permission and enables no tool.'));
    if (!profile) { pane.appendChild(el('div', 'missing', 'Reading…')); L.api('/api/bot/profile', {}).then(function (r) { if (r && r.ok) { profile = r.profile; draw(); } }); return; }
    var f = el('div', 'fields');
    var inputs = {};
    var inp = function (key, label, desc, placeholder, area) {
      var i = document.createElement(area ? 'textarea' : 'input'); i.value = profile[key] || ''; i.placeholder = placeholder || ''; i.setAttribute('data-profile', key);
      if (area) { i.rows = 3; i.style.width = '100%'; } else i.style.width = '260px';
      inputs[key] = i; field(f, label, desc, i);
    };
    inp('name', 'Name', 'How the BOT refers to itself.', 'LAIN');
    inp('tone', 'Tone', 'e.g. concise and direct; warm; formal.', 'not set');
    inp('language', 'Language', '"auto" answers in the language it is addressed in.', 'auto');
    inp('behavior', 'Behaviour', 'Anything about how it should work with you — kept short; it is part of every BOT request.', 'not set', true);
    var chan = ['Desktop'].concat(((data && data.platforms) || []).filter(function (p) { return p.state === 'CONNECTED'; }).map(function (p) { return p.platform.charAt(0).toUpperCase() + p.platform.slice(1); }));
    field(f, 'Reachable through', data ? '' : 'Channel state is read when this view opens.', chan.join(', '));
    pane.appendChild(f);
    var save = el('button', 'btn small primary', 'Save profile');
    save.onclick = async function () {
      save.disabled = true;
      var vals = {}; Object.keys(inputs).forEach(function (k) { vals[k] = inputs[k].value; });
      var r = await L.api('/api/bot/profile/set', { values: vals });
      save.disabled = false;
      if (!r.ok) return L.toast(r.why, true);
      profile = r.profile; L.toast('Saved. The next BOT reply uses it.');
    };
    pane.appendChild(save);
  }

  // ---- intelligence ----------------------------------------------------------------
  var intel = null;
  function modelPick(anchor, lane, scope) {
    var F = L.fabric && L.fabric.get().data;
    var want = lane === 'bot' ? 'BOT' : 'AGENT';
    var rows = [];
    ((F && F.groups) || []).forEach(function (g) { g.rows.forEach(function (r) { if (r.modelId && (r.roles || []).indexOf(want) >= 0 && r.kind !== 'chat') rows.push(r); }); });
    var items = rows.map(function (r) { return { label: r.label, sub: r.via, run: async function () { var x = await L.api('/api/session/intel/set', { lane: lane, value: r.modelId, scope: scope }); if (!x.ok) return L.toast(x.why, true); L.toast((lane === 'bot' ? 'BOT' : 'Coding Agent') + (scope === 'global' ? ' default' : '') + ': ' + r.label); intel = null; if (L.fabric) L.fabric.load(); draw(); } }; });
    items.push({ label: 'API models…', sub: 'search every configured API model', run: function () { if (lane === 'bot') L.models.pickBot(anchor); else L.models.pickCoding(anchor); } });
    L.popover(anchor, function (p) {
      p.appendChild(el('h4', '', lane === 'bot' ? 'BOT model' : 'Coding Agent'));
      items.forEach(function (it) { var o = el('button', 'opt'); o.appendChild(el('span', '', it.label)); var sm = el('small', '', ' ' + it.sub); sm.style.color = 'var(--faint)'; o.appendChild(sm); o.onclick = function () { L.closePop(); it.run(); }; p.appendChild(o); });
    });
  }
  function intelligence(pane) {
    pane.appendChild(el('h2', '', 'Intelligence'));
    pane.appendChild(el('div', 'sub', 'Which model the BOT and the Coding Agent use by default. The gear in the composer overrides these for one session.'));
    if (!intel) { pane.appendChild(el('div', 'missing', 'Reading…')); L.api('/api/session/intel', {}).then(function (r) { if (r && r.ok) { intel = r; draw(); } }); if (L.fabric && !L.fabric.get().data) L.fabric.load(); return; }
    var i = intel.intel;
    var f = el('div', 'fields');
    var lbl = function (id) { var rows = (L.fabric && L.fabric.rows) ? L.fabric.rows() : []; var r = rows.filter(function (x) { return x.modelId === id; })[0]; return r ? r.label + ' · ' + r.via : (L.fmt.model(id) || 'not set'); };
    var b1 = el('button', 'btn small', lbl(i.bot.model) + ' ▾'); b1.setAttribute('data-intel', 'bot');
    b1.onclick = function () { modelPick(b1, 'bot', 'global'); };
    field(f, 'Default BOT model', 'Conversation, planning, channels. ChatGPT Chat is CHAT ONLY and never appears here. ' + (i.bot.scope !== 'global' ? '(This session overrides it: ' + i.bot.scope + '.)' : ''), b1);
    var b2 = el('button', 'btn small', lbl(i.coding.model) + ' ▾'); b2.setAttribute('data-intel', 'coding');
    b2.onclick = function () { modelPick(b2, 'coding', 'global'); };
    field(f, 'Default Coding Agent', 'Implementation work. Local models appear once their Agent test passes; a runtime (Claude Code, OpenCode) works with its own tools.', b2);
    var eff = document.createElement('select');
    (intel.efforts || []).forEach(function (e) { var op = document.createElement('option'); op.value = e; op.textContent = e; if (e === (i.reasoning.value || 'auto')) op.selected = true; eff.appendChild(op); });
    eff.onchange = async function () { var r = await L.api('/api/session/intel/set', { lane: 'reasoning', value: eff.value, scope: 'global' }); if (!r.ok) L.toast(r.why, true); intel = null; draw(); };
    field(f, 'Reasoning', 'Default effort where the model supports it.', eff);
    field(f, 'Fallback', 'What happens when a route fails.', 'Same model through another configured route, offered — LAIN never switches to a different model on its own.');
    pane.appendChild(f);
  }

  // ---- connections ---------------------------------------------------------------------
  // CHANNEL STATUS — the finer reading Core gives every channel (botconnect STATUS).
  var STATUS_LABEL = { CONFIGURED: 'Configured · not listening', CONNECTING: 'Connecting…', LISTENING: 'Listening', OPERATIONAL: 'Operational',
    DEGRADED: 'Degraded', ERROR: 'Error', DISCONNECTED: 'Disconnected' };
  var STATUS_CLASS = { OPERATIONAL: 'CONNECTED', LISTENING: 'CONNECTED', DEGRADED: 'CONNECTING', CONNECTING: 'CONNECTING', CONFIGURED: 'CONNECTING', ERROR: 'FAILED' };
  function ago(t) {
    if (!t) return '—';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago';
  }
  function receipt(r) {
    if (!r) return '—';
    return ago(r.at) + (r.ok ? '' : '  ✗ ' + (r.why || 'failed')) + (r.ok && r.why ? '  ' + r.why : '') + (r.rid ? '  · ' + r.rid : '');
  }
  // WHERE THE LAST MESSAGE STOPPED — every stage it reached, under its receipt id.
  function diagnostics(c) {
    var d = c.diagnostics || {};
    var box = el('div', 'botdiag');
    var row = function (k, v, bad) { var r = el('div', 'dr' + (bad ? ' bad' : '')); r.appendChild(el('span', 'dk', k)); r.appendChild(el('span', 'dv', v)); box.appendChild(r); };
    if (d.identity) row('Bot', '@' + (d.identity.username || d.identity.name || '?') + (d.identity.botId ? '  · id ' + d.identity.botId : ''));
    row('Transport', d.transport || '—');
    if (d.runtime) row('Runtime', 'link ' + (d.runtime.link || '?') + ' · ' + (d.runtime.leased ? 'mailbox leased by a gateway' : 'NO gateway holds the mailbox — nothing is polled') + ' · depth ' + d.runtime.mailboxDepth, !d.runtime.leased && c.configured);
    if (d.gateway) row('Gateway', d.gateway.running ? 'running (' + d.gateway.owner + ')' + (d.gateway.adapter ? ' · adapter ' + d.gateway.adapter : '') : 'not running', !d.gateway.running && c.configured);
    if (d.resume) row('At launch', d.resume.started ? 'started ' + ago(d.resume.at) : (d.resume.why || 'not started'));
    row('Last inbound', receipt(d.lastInbound));
    row('Last authorize', receipt(d.lastAuthorize), d.lastAuthorize && !d.lastAuthorize.ok);
    row('Last dispatch', receipt(d.lastDispatch), d.lastDispatch && !d.lastDispatch.ok);
    row('Last model response', receipt(d.lastModel), d.lastModel && !d.lastModel.ok);
    row('Last outbound', receipt(d.lastOutbound), d.lastOutbound && !d.lastOutbound.ok);
    row('Last round trip', d.lastRoundTrip ? ago(d.lastRoundTrip.at) + '  · ' + d.lastRoundTrip.rid : 'none yet');
    if (d.lastError) row('Last error', d.lastError.stage + ': ' + (d.lastError.why || 'failed') + '  (' + ago(d.lastError.at) + ')', true);
    if (d.lastMessage) {
      row('Last message ' + d.lastMessage.rid, d.lastMessage.path.map(function (p) { return p.stage + (p.ok ? ' ✓' : ' ✗'); }).join(' → ')
        + (d.lastMessage.stoppedAt ? '  — stopped at ' + d.lastMessage.stoppedAt.stage + (d.lastMessage.stoppedAt.why ? ': ' + d.lastMessage.stoppedAt.why : '') : ''), Boolean(d.lastMessage.stoppedAt));
    }
    return box;
  }

  function telegramCard(c) {
    var card = el('div', 'botcard');
    card.setAttribute('data-channel', 'telegram');
    card.setAttribute('data-status', c.status || '');
    var head = el('div', 'head');
    head.appendChild(L.icon('link', 16));
    head.appendChild(el('b', '', 'Telegram'));
    var cst = el('span', 'cst ' + (STATUS_CLASS[c.status] || c.state));
    cst.appendChild(el('span', 'sdot', '●'));
    cst.appendChild(el('span', '', STATUS_LABEL[c.status] || statusLabel(c.state)));
    head.appendChild(cst);
    card.appendChild(head);
    if (c.configured) {
      card.appendChild(el('div', 'summary', (c.identity ? '@' + (c.identity.username || c.identity.name) + '  ·  ' : '') + (c.summary || '')
        + (typeof c.allowedCount === 'number' ? '  ·  ' + c.allowedCount + ' authorized user' + (c.allowedCount === 1 ? '' : 's') : '')));
      var manage = el('div', 'connect');
      if (c.status === 'CONFIGURED') {
        var startB = el('button', 'btn small primary', 'Start messaging');
        startB.onclick = async function () { var r = await L.api('/api/bot/service', { action: 'start' }); if (!r.ok) L.toast(r.why, true); load(false); };
        manage.appendChild(startB);
      }
      if ((c.allowedUsers || []).length) {
        var test = el('button', 'btn small', 'Send test');
        test.onclick = async function () {
          test.disabled = true;
          var r = await L.api('/api/bot/telegram/test', {});
          test.disabled = false;
          L.toast(r.ok ? 'Test delivered · receipt ' + r.receipt : r.why, !r.ok);
          load(false);
        };
        manage.appendChild(test);
      }
      var check = el('button', 'btn small', 'Re-check');
      check.onclick = async function () { var r = await L.api('/api/bot/telegram/check', {}); if (!r.ok) L.toast(r.why, true); load(false); };
      var restart = el('button', 'btn small', 'Restart');
      restart.onclick = async function () { var r = await L.api('/api/bot/service', { action: 'restart' }); if (!r.ok) L.toast(r.why, true); load(false); };
      var disc = el('button', 'btn small danger', 'Disconnect');
      disc.onclick = async function () {
        if (!(await L.confirm('Disconnect Telegram? LAIN stops polling, deletes the credential it holds and clears every approved user. The token stays valid at Telegram until you revoke it with @BotFather.', { ok: 'Disconnect', danger: true }))) return;
        var r = await L.api('/api/bot/telegram/disconnect', {});
        if (!r.ok) return L.toast(r.why, true);
        L.toast('Disconnected. ' + (r.notRevoked || ''));
        load(false);
      };
      manage.appendChild(check); manage.appendChild(restart); manage.appendChild(disc);
      card.appendChild(manage);
      card.appendChild(diagnostics(c));
      return card;
    }
    if (c.summary) card.appendChild(el('div', 'summary', c.summary));
    var row = el('div', 'connect');
    var input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'Bot token from @BotFather';
    input.autocomplete = 'off';
    row.appendChild(input);
    var go = el('button', 'btn small primary', 'Connect');
    go.onclick = async function () {
      var token = input.value.trim();
      if (!token) return;
      go.disabled = true;
      var r = await L.api('/api/bot/telegram/connect', { token: token });
      input.value = '';
      go.disabled = false;
      if (!r.ok) return L.toast(r.why, true);
      load(false);
    };
    row.appendChild(go);
    card.appendChild(row);
    if (c.diagnostics && (c.diagnostics.lastInbound || c.diagnostics.lastError)) card.appendChild(diagnostics(c));
    return card;
  }

  function environmentCard(c, label) {
    var card = el('div', 'botcard');
    var head = el('div', 'head');
    head.appendChild(L.icon('link', 16));
    head.appendChild(el('b', '', label));
    var cst = el('span', 'cst ' + c.state);
    cst.appendChild(el('span', 'sdot', '●'));
    cst.appendChild(el('span', '', statusLabel(c.state)));
    head.appendChild(cst);
    card.appendChild(head);
    if (c.summary) card.appendChild(el('div', 'summary', c.summary));
    if (c.checks && c.checks.length) {
      var box = el('div', 'checks');
      c.checks.forEach(function (chk) { box.appendChild(el('div', '', chk.name + ': ' + chk.value)); });
      card.appendChild(box);
    }
    if (!c.configured) card.appendChild(el('div', 'summary', 'Configured through environment variables, then restart LAIN — see docs/BOT.md.'));
    return card;
  }

  function connections(pane) {
    pane.appendChild(el('h2', '', 'Connections'));
    pane.appendChild(el('div', 'sub', 'Channels the BOT can be reached on.' + (data && data.service ? '  Messaging service: ' + (data.service.running ? 'running' + (data.service.owner === 'external' ? ' in another LAIN process' : '') : 'stopped') + '.' : '')));
    if (!data) { pane.appendChild(el('div', 'missing', loading ? 'Reading connection state…' : 'Not read yet.')); return; }
    (data.platforms || []).forEach(function (c) {
      if (c.platform === 'telegram') pane.appendChild(telegramCard(c));
      else if (c.platform === 'discord') pane.appendChild(environmentCard(c, 'Discord'));
      else if (c.platform === 'whatsapp') pane.appendChild(environmentCard(c, 'WhatsApp'));
    });
  }

  // ---- permissions ------------------------------------------------------------------------
  function permissions(pane) {
    pane.appendChild(el('h2', '', 'Permissions'));
    pane.appendChild(el('div', 'sub', 'Who may talk to the BOT through a channel. Only accounts that messaged the bot can be approved — that is how LAIN knows the account is real. Nobody gets a reply until approved.'));
    if (!data) { pane.appendChild(el('div', 'missing', loading ? 'Reading…' : 'Not read yet.')); return; }
    var tg = platform('telegram');
    pane.appendChild(el('h3', '', 'Telegram allowlist'));
    var card = el('div', 'botcard');
    var users = (tg && tg.allowedUsers) || [];
    if (!users.length) card.appendChild(el('div', 'summary', 'No approved users.'));
    users.forEach(function (id) {
      var r = el('div', 'userrow');
      r.appendChild(el('span', 'id', id));
      var rv = el('button', 'btn small danger', 'Revoke');
      rv.onclick = async function () {
        if (!(await L.confirm('Revoke Telegram user ' + id + '? They can no longer message the BOT.', { ok: 'Revoke', danger: true }))) return;
        var x = await L.api('/api/bot/telegram/revoke', { senderId: id });
        if (!x.ok) return L.toast(x.why, true);
        load(false);
      };
      r.appendChild(rv);
      card.appendChild(r);
    });
    pane.appendChild(card);
    var cands = (tg && tg.candidates) || [];
    pane.appendChild(el('h3', '', 'Waiting for approval'));
    var c2 = el('div', 'botcard');
    if (!cands.length) c2.appendChild(el('div', 'summary', 'Nobody is waiting. Accounts that message the bot (for example /start) appear here.'));
    cands.forEach(function (cand) {
      var r = el('div', 'candrow');
      r.appendChild(el('span', 'id', cand.senderId));
      var ap = el('button', 'btn small primary', 'Approve');
      ap.onclick = async function () {
        var x = await L.api('/api/bot/telegram/approve', { senderId: cand.senderId });
        if (!x.ok) return L.toast(x.why, true);
        load(false);
      };
      r.appendChild(ap);
      c2.appendChild(r);
    });
    var chk = el('button', 'btn small', 'Check for new requests');
    chk.onclick = function () { load(true); };
    c2.appendChild(chk);
    pane.appendChild(c2);
    ['discord', 'whatsapp'].forEach(function (id) {
      var p = platform(id);
      if (p && typeof p.allowedCount === 'number') pane.appendChild(el('div', 'missing', id.charAt(0).toUpperCase() + id.slice(1) + ': ' + p.allowedCount + ' allowed user' + (p.allowedCount === 1 ? '' : 's') + ', set in the environment configuration.'));
    });
  }

  // ---- capabilities -----------------------------------------------------------------------
  function capabilities(pane) {
    var S = L.state() || {};
    pane.appendChild(el('h2', '', 'Capabilities'));
    pane.appendChild(el('div', 'sub', 'What the BOT can use, from the live state of each owner. The BOT chooses among them; nobody has to pick a worker.'));
    var cap = function (icon, name, detail, state, cls) {
      var r = el('div', 'caprow');
      var i = el('span', 'ci'); i.appendChild(L.icon(icon, 18)); r.appendChild(i);
      var n = el('div', 'cn', name); n.appendChild(el('small', '', detail)); r.appendChild(n);
      r.appendChild(el('span', 'cs ' + (cls || ''), state));
      pane.appendChild(r);
    };
    var code = S.models && S.models.coding;
    cap('ide', 'Coding Agent', code && code.modelId ? 'Runs on ' + L.fmt.model(code.modelId) + ' in an open project' : 'No model assigned', code && code.modelId ? 'On' : 'Off', code && code.modelId ? 'on' : 'off');
    var ws = S.workshop || {};
    cap('preview', 'Browser preview (Workshop)', ws.available ? 'A project-bound Chromium for previews and verification' : (ws.why || 'No browser is available'), ws.available ? 'Available' : 'Unavailable', ws.available ? 'on' : 'warn');
    var tools = L.tools ? L.tools.get() : null;
    var comp = tools && tools.servers ? tools.servers.filter(function (s) { return s.id === 'computer'; })[0] : null;
    cap('plug', 'Computer (MCP)', comp ? (comp.why || '') : 'Read from Settings › MCP', comp ? comp.state.toLowerCase().replace(/_/g, ' ') : '—', comp && comp.state === 'CONNECTED' ? 'on' : 'off');
    var mcpN = tools && tools.servers ? tools.servers.filter(function (s) { return s.state === 'CONNECTED'; }).length : null;
    cap('plug', 'MCP servers', tools && tools.servers ? tools.servers.length + ' configured · ' + mcpN + ' connected' : 'Read from Settings › MCP', mcpN ? 'On' : 'Off', mcpN ? 'on' : 'off');
    cap('spark', 'Skills', 'This build of LAIN Core has no skill loader — nothing is installed or loaded', 'Not in this build', 'off');
    cap('files', 'Files and images', 'Spreadsheets, documents and images attached in a Chat conversation; image reading needs a VISION model (e.g. a paired local projector)', 'In file conversations', 'on');
    cap('search', 'Web fetch', 'Plain HTTP reads for changelogs and docs — no browser, no cookies', 'On', 'on');
    cap('model', 'LAIN itself', 'Models, quota, MCP, settings — the BOT reads the same state this window shows, and can open views', 'On', 'on');
  }

  function draw() {
    if (L.nav.tab() !== 'bot') return;
    nav();
    var pane = $('botPane');
    pane.textContent = '';
    var top = el('div', '');
    top.style.cssText = 'float:right;display:flex;gap:6px';
    var rf = el('button', 'btn small', loading ? 'Refreshing…' : 'Refresh');
    rf.disabled = loading;
    rf.onclick = function () { load(true); };
    top.appendChild(rf);
    pane.appendChild(top);
    if (section === 'connections') connections(pane);
    else if (section === 'intelligence') intelligence(pane);
    else if (section === 'permissions') permissions(pane);
    else if (section === 'capabilities') capabilities(pane);
    else if (section === 'assistant' && L.assistant) { L.assistant.botPane(pane, { task: focusTask }); focusTask = null; }
    else identity(pane);
  }

  L.bot = { load: load, summary: summary, get: function () { return data; } };

  L.onBoot(function () {
    L.nav.onShow('bot', function (o) {
      if (o && o.section && /assistant|schedul|remind|watch/.test(o.section)) { section = 'assistant'; focusTask = o.task || null; }
      else if (o && o.section && /connection|telegram|discord|whatsapp/.test(o.section)) section = 'connections';
      else if (o && o.section && /perm|allow|secur/.test(o.section)) section = 'permissions';
      else if (o && o.section && /capab/.test(o.section)) section = 'capabilities';
      else if (o && o.section && /intel|model/.test(o.section)) section = 'intelligence';
      else if (o && o.section) section = 'identity';
      if (!data && !loading) load(false);
      draw();
    });
  });
  var lastSig = '';
  L.onRender(function (S) {
    if (L.nav.tab() !== 'bot') return;
    var sig = JSON.stringify([S.models, S.workshop && S.workshop.available]);
    if (sig !== lastSig && section !== 'connections' && section !== 'permissions' && section !== 'identity') { lastSig = sig; intel = null; draw(); }
  });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
