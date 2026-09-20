'use strict';

/**
 * BOT CONNECTIONS — the second view of the Cowork / Bot lane.
 *
 * ------------------------------------------------------------------------
 * A REAL FLOW OVER A REAL CONTRACT, docs/HARNESS_UI_CONTRACT.md section 9 and
 * src/harnessapp/botroutes.js. Telegram is set up from this window (token,
 * candidates, approve); Discord and WhatsApp read secrets from the
 * environment and this panel only shows their state and what is missing.
 *
 * ------------------------------------------------------------------------
 * NEVER POLLED. Reading connection state may start LAIN's messaging runtime
 * (the supervisor holds the credential), so `POST /api/bot/connections` is
 * called only when this view is opened or explicitly refreshed — never on
 * the ordinary 1.5s state poll every other panel rides.
 *
 * ------------------------------------------------------------------------
 * THE TOKEN NEVER PERSISTS CLIENT-SIDE. It lives in the input for as long as
 * it takes to press Connect, is sent once, and the field is cleared the
 * moment a response arrives — success or failure.
 *
 * NO BACKTICKS ANYWHERE BELOW, comments included — one template literal, same
 * rule as every other page*.js file.
 */

const CSS = `
/* WHILE THE BOT VIEW IS SHOWING, the Cowork resting surface (stream,
   composer, objects, the empty-lane card) is hidden the same way a lane
   mismatch already hides them — see pagecowork.js renderLane. */
main.bot-view .stream,main.bot-view .composer,main.bot-view .drawers,
main.bot-view .drawer,main.bot-view .act,main.bot-view .objects,
main.bot-view #askCard,main.bot-view #computerCard,main.bot-view #laneEmpty,
main.bot-view #coworkJobs{display:none!important}
.bot-panel{padding:16px 22px;overflow-y:auto}
.bot-empty{color:var(--faint);font-size:12.5px;padding:20px 0}
.bot-refresh{float:right;color:var(--accent);font-size:12px}
.botcard{background:var(--surface);border-radius:var(--radius);padding:14px 16px;margin-bottom:12px}
.botcard .head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.botcard .head b{font-size:13.5px;font-weight:600}
.botcard .cst{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dim);margin-left:auto}
.botcard .cst .sdot{font-size:9px}
.botcard .cst.CONNECTED{color:var(--ok)}
.botcard .cst.AUTH_REQUIRED,.botcard .cst.CONNECTING{color:var(--warn)}
.botcard .cst.FAILED{color:var(--bad)}
.botcard .summary{color:var(--dim);font-size:12.5px;margin-bottom:10px}
.botcard .checks{margin:8px 0;font-size:12px;color:var(--faint)}
.botcard .checks div{padding:2px 0}
.botcard .connect{display:flex;gap:8px;margin-top:6px}
.botcard .connect input{background:var(--bg);border-radius:var(--radius);padding:7px 10px;font-family:var(--mono);font-size:12.5px}
.botcard .candidates{margin-top:10px;border-top:1px solid var(--line);padding-top:10px}
.botcard .candrow{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12.5px}
.botcard .candrow .id{font-family:var(--mono);color:var(--dim);flex:1}
.botcard .userrow{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12.5px;color:var(--dim)}
`;

const HTML = `
<div class="bot-panel" id="botPanel" hidden></div>
`;

function js() {
  return `
window.LAIN = window.LAIN || {};
LAIN.bot = (function () {
  'use strict';
  var api = null, notice = null, poll = null;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }

  var active = false;    // is the Bot sub-view the one showing
  var data = null;       // the last /api/bot/connections read
  var loading = false;

  async function load() {
    loading = true;
    draw();
    var r = await api('/api/bot/connections', { check: true });
    loading = false;
    if (!r.ok) { notice(r.why, true); return; }
    data = r;
    draw();
  }

  function statusLabel(state) {
    return state === 'CONNECTED' ? 'Connected'
      : state === 'AUTH_REQUIRED' ? 'Needs re-authorization'
      : state === 'CONNECTING' ? 'Connecting\\u2026'
      : state === 'FAILED' ? 'Failed'
      : 'Not connected';
  }

  function telegramCard(c) {
    var card = el('div', 'botcard');
    var head = el('div', 'head');
    head.appendChild(el('b', '', 'Telegram'));
    var cst = el('span', 'cst ' + c.state);
    cst.appendChild(el('span', 'sdot', '\\u25cf'));
    cst.appendChild(el('span', '', statusLabel(c.state)));
    head.appendChild(cst);
    card.appendChild(head);

    if (c.state === 'CONNECTED') {
      card.appendChild(el('div', 'summary',
        (c.identity ? '@' + (c.identity.username || c.identity.name) : 'Connected')
        + (typeof c.allowedCount === 'number' ? '  \\u00b7  ' + c.allowedCount + ' authorized user' + (c.allowedCount === 1 ? '' : 's') : '')));
      var manage = el('div', 'connect');
      var check = el('button', 'btn', 'Re-check');
      check.onclick = async function () { var r = await api('/api/bot/telegram/check', {}); if (!r.ok) notice(r.why, true); load(); };
      var restart = el('button', 'btn', 'Restart service');
      restart.onclick = async function () { var r = await api('/api/bot/service', { action: 'restart' }); if (!r.ok) notice(r.why, true); load(); };
      var disc = el('button', 'btn danger', 'Disconnect');
      disc.onclick = async function () {
        if (!window.confirm('Disconnect Telegram? This removes the stored credential and every approved user.')) return;
        var r = await api('/api/bot/telegram/disconnect', {});
        if (!r.ok) return notice(r.why, true);
        load();
      };
      manage.appendChild(check);
      manage.appendChild(restart);
      manage.appendChild(disc);
      card.appendChild(manage);
      (c.candidates || []).length && renderCandidates(card, c.candidates);
      return card;
    }

    if (c.state === 'AUTH_REQUIRED') {
      card.appendChild(el('div', 'summary', c.summary || 'Telegram rejected the stored token \\u2014 reconnect with a new one.'));
    } else if (c.summary) {
      card.appendChild(el('div', 'summary', c.summary));
    }

    // ---- THE CONNECT FLOW: token -> identity -> /start -> candidates -> approve
    var row = el('div', 'connect');
    var input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'Bot token from @BotFather';
    input.autocomplete = 'off';
    row.appendChild(input);
    var go = el('button', 'btn go', 'Connect');
    go.onclick = async function () {
      var token = input.value.trim();
      if (!token) return;
      go.disabled = true;
      var r = await api('/api/bot/telegram/connect', { token: token });
      // THE TOKEN NEVER STAYS IN THE FIELD, success or failure.
      input.value = '';
      go.disabled = false;
      if (!r.ok) return notice(r.why, true);
      notice('');
      load();
    };
    row.appendChild(go);
    card.appendChild(row);

    if (c.identity) {
      card.appendChild(el('div', 'summary', 'Connected as @' + (c.identity.username || c.identity.name)
        + '. Send /start to @' + (c.identity.username || c.identity.name) + ' from the account to approve.'));
      renderCandidates(card, c.candidates || []);
      var refresh = el('button', 'btn', 'Check for /start');
      refresh.onclick = load;
      card.appendChild(refresh);
    }
    return card;
  }

  function renderCandidates(card, candidates) {
    if (!candidates.length) return;
    var box = el('div', 'candidates');
    box.appendChild(el('div', 'summary', 'Waiting for approval'));
    candidates.forEach(function (cand) {
      var row = el('div', 'candrow');
      row.appendChild(el('span', 'id', cand.senderId));
      var approve = el('button', 'btn go', 'Approve');
      approve.onclick = async function () {
        var r = await api('/api/bot/telegram/approve', { senderId: cand.senderId });
        if (!r.ok) return notice(r.why, true);
        load();
      };
      row.appendChild(approve);
      box.appendChild(row);
    });
    card.appendChild(box);
  }

  /** Discord / WhatsApp: environment-configured, no token entry here. */
  function environmentCard(c, label) {
    var card = el('div', 'botcard');
    var head = el('div', 'head');
    head.appendChild(el('b', '', label));
    var cst = el('span', 'cst ' + c.state);
    cst.appendChild(el('span', 'sdot', '\\u25cf'));
    cst.appendChild(el('span', '', statusLabel(c.state)));
    head.appendChild(cst);
    card.appendChild(head);
    if (c.summary) card.appendChild(el('div', 'summary', c.summary));
    if (c.checks && c.checks.length) {
      var box = el('div', 'checks');
      c.checks.forEach(function (chk) { box.appendChild(el('div', '', chk.name + ': ' + chk.value)); });
      card.appendChild(box);
    }
    if (!c.configured) card.appendChild(el('div', 'summary', 'Set the required environment variables and restart LAIN \\u2014 see docs/BOT.md.'));
    return card;
  }

  function draw() {
    var box = $('botPanel');
    box.textContent = '';
    var refresh = el('button', 'bot-refresh', loading ? 'Refreshing\\u2026' : 'Refresh');
    refresh.disabled = loading;
    refresh.onclick = load;
    box.appendChild(refresh);
    if (!data) { box.appendChild(el('div', 'bot-empty', loading ? 'Reading connection state\\u2026' : '')); return; }
    (data.platforms || []).forEach(function (c) {
      if (c.platform === 'telegram') box.appendChild(telegramCard(c));
      else if (c.platform === 'discord') box.appendChild(environmentCard(c, 'Discord'));
      else if (c.platform === 'whatsapp') box.appendChild(environmentCard(c, 'WhatsApp'));
    });
  }

  /** Called from the shared render(); does nothing unless this view is showing. */
  function render(S, ui) {
    var showing = ui.lane === 'cowork' && active;
    $('botPanel').hidden = !showing;
  }

  function open() {
    active = true;
    $('botPanel').hidden = false;
    if (!data && !loading) load();
    else draw();
  }
  function close() {
    active = false;
    $('botPanel').hidden = true;
  }

  function boot(apiFn, noticeFn, pollFn) {
    api = apiFn; notice = noticeFn; poll = pollFn;
  }

  return { boot: boot, render: render, open: open, close: close, isActive: function () { return active; } };
})();
`;
}

module.exports = { CSS, HTML, js };
