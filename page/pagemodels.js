'use strict';

/**
 * THE MODEL PICKERS — one per role, used wherever that role's model is shown.
 *
 * ------------------------------------------------------------------------
 * TWO ROLES, TWO PICKERS, ONE OWNER EACH.
 *
 *   BOT model      the Chat selection: a SOURCE (LAIN's runtime, or a signed-in
 *                  website such as ChatGPT.com) and a model on it.
 *                  POST /api/source/select · /api/source/models
 *   Coding Agent   the Coding selection: LAIN's runtime catalog only.
 *                  POST /api/models/search · /api/models/select {lane:'coding'}
 *
 * The Chat composer's pills, the IDE's BOT panel rows and the Model view's
 * role rows all open these same two pickers, so there is exactly one way to
 * change each role — and Core (modelinventory.js) is the only thing that
 * decides what a choice means. Nothing here hard-codes a provider or a model.
 */

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var CODING_PAGE = 40;

  function S() { return L.state(); }
  function sourceOf(id) {
    return ((S().sources && S().sources.sources) || []).filter(function (x) { return x.id === id; })[0] || null;
  }
  function dotClass(state) {
    return 'st' + (state === 'READY' ? ' ready' : state === 'AUTH_REQUIRED' ? ' auth' : (state === 'FAILED' || state === 'UNAVAILABLE') ? ' bad' : '');
  }

  /** The Chat composer's two pills: which source, which model. */
  function render(state) {
    var sel = state.sources ? state.sources.selected : 'lain';
    var s = sourceOf(sel);
    var chat = state.models && state.models.chat;
    $('srcName').textContent = s ? s.label : 'LAIN';
    $('srcDot').className = s ? dotClass(s.state) : 'st';
    $('modelName').textContent = L.fmt.model((s && s.model) || (chat && chat.modelId)) || 'no model';
    $('srcPill').title = s && s.why ? s.why : 'Where the BOT answers from';
  }

  function searchBox(p, placeholder) {
    var box = el('div', 'psearch');
    var input = document.createElement('input');
    input.placeholder = placeholder;
    box.appendChild(input);
    p.appendChild(box);
    return input;
  }

  // ---- BOT: source, then model -------------------------------------------------
  function sourceOpt(s, anchor) {
    var b = el('button', 'opt');
    b.setAttribute('aria-selected', String(s.chosen));
    var row1 = el('div', 'row1');
    row1.appendChild(el('span', dotClass(s.state)));
    row1.appendChild(el('span', '', s.label));
    b.appendChild(row1);
    var why = s.state === 'READY' ? (L.fmt.model(s.model) || 'no model chosen') : s.state === 'AUTH_REQUIRED' ? 'sign in required' : s.state === 'DISCONNECTED' ? 'not connected' : (s.why || s.state);
    b.appendChild(el('small', '', why));
    b.onclick = async function () {
      L.closePop();
      var r = await L.api('/api/source/select', { source: s.id });
      if (!r.ok) return L.notice(r.why, true);
      await L.poll();
      botModels(anchor);
    };
    return b;
  }
  function pickBot(anchor) {
    var all = (S().sources && S().sources.sources) || [];
    L.popover(anchor, function (p) {
      p.appendChild(el('h4', '', 'BOT model · where it answers from'));
      var input = searchBox(p, 'Search sources…');
      var list = el('div', '');
      p.appendChild(list);
      var draw = function (q) {
        list.textContent = '';
        var needle = (q || '').trim().toLowerCase();
        var match = function (s) { return !needle || s.label.toLowerCase().indexOf(needle) >= 0; };
        var runtime = all.filter(function (s) { return s.kind !== 'WEB' && match(s); });
        var web = all.filter(function (s) { return s.kind === 'WEB' && match(s); });
        if (runtime.length) { list.appendChild(el('h4', '', 'LAIN runtime')); runtime.forEach(function (s) { list.appendChild(sourceOpt(s, anchor)); }); }
        if (web.length) { list.appendChild(el('h4', '', 'Signed-in websites')); web.forEach(function (s) { list.appendChild(sourceOpt(s, anchor)); }); }
        if (!runtime.length && !web.length) list.appendChild(el('div', 'empty', 'no source matches'));
      };
      draw('');
      input.addEventListener('input', function () { draw(input.value); });
      setTimeout(function () { input.focus(); }, 0);
    });
  }

  /** The models on the BOT's chosen source — discovered, never hard-coded. */
  async function botModels(anchor) {
    var sel = S().sources ? S().sources.selected : 'lain';
    var s = sourceOf(sel);
    if (!s) return;
    if (sel === 'lain') return runtimePicker(anchor, 'chat');
    L.popover(anchor, function (p) { p.appendChild(el('h4', '', s.label + ' · reading models…')); });
    var r = await L.api('/api/source/models', { source: sel });
    if (!r.ok || !(r.models || []).length) {
      L.popover(anchor, function (p) {
        p.appendChild(el('h4', '', s.label));
        p.appendChild(el('div', 'empty', r.why || 'no models were returned'));
        if (r.authRequired || /sign in/i.test(r.why || '')) {
          var c = el('button', 'opt', 'Open ' + s.label + ' to sign in');
          c.appendChild(el('small', '', 'LAIN opens the window; you sign in there.'));
          c.onclick = async function () { L.closePop(); L.notice('Sign in in the window LAIN opened, then choose a model.'); await L.api('/api/source/connect', { source: sel }); L.poll(); };
          p.appendChild(c);
        }
      });
      return;
    }
    L.popover(anchor, function (p) {
      p.appendChild(el('h4', '', s.label + (r.cached ? ' · cached' : '')));
      var input = r.models.length > 6 ? searchBox(p, 'Search models…') : null;
      var list = el('div', '');
      p.appendChild(list);
      var draw = function (q) {
        list.textContent = '';
        var needle = (q || '').trim().toLowerCase();
        r.models.filter(function (m) { return !needle || (m.label || m.id).toLowerCase().indexOf(needle) >= 0; }).forEach(function (m) {
          var b = el('button', 'opt');
          b.setAttribute('aria-selected', String(m.id === s.model));
          b.appendChild(el('span', '', m.label || m.id));
          if (m.state && m.state !== 'AVAILABLE') b.appendChild(el('small', '', m.state));
          b.onclick = async function () {
            L.closePop();
            var sr = await L.api('/api/source/select', { source: sel, model: m.id });
            if (!sr.ok) return L.notice(sr.why, true);
            L.poll();
          };
          list.appendChild(b);
        });
        if (!list.childNodes.length) list.appendChild(el('div', 'empty', 'no model matches'));
      };
      draw('');
      if (input) { input.addEventListener('input', function () { draw(input.value); }); setTimeout(function () { input.focus(); }, 0); }
      var re = el('button', 'opt', 'Refresh from the account');
      re.onclick = async function () { L.closePop(); await L.api('/api/source/models', { source: sel, refresh: true }); botModels(anchor); };
      p.appendChild(re);
    });
  }

  /**
   * LAIN'S RUNTIME CATALOG, searched by Core (modelsearch.js — the same
   * ranking /models uses). `lane` is whose model it sets: 'coding' for the
   * Coding Agent, 'chat' for the BOT on LAIN's runtime. A catalog can hold
   * four digits of models, so the empty query asks for a first page only.
   */
  async function runtimePicker(anchor, lane, onPick) {
    var title = lane === 'coding' ? 'Coding Agent model' : 'BOT model · LAIN runtime';
    L.popover(anchor, function (p) { p.appendChild(el('h4', '', title + ' · searching…')); });
    var r = await L.api('/api/models/search', { lane: lane, query: '', limit: CODING_PAGE });
    if (!r.ok) { L.popover(anchor, function (p) { p.appendChild(el('div', 'empty', r.why || 'could not read models')); }); return; }
    L.popover(anchor, function (p) {
      p.appendChild(el('h4', '', title));
      var input = searchBox(p, 'Search ' + (r.total || r.rows.length) + ' models…');
      var list = el('div', '');
      p.appendChild(list);
      var choose = async function (row) {
        L.closePop();
        if (onPick) return onPick(row);
        var sr = lane === 'coding'
          ? await L.api('/api/models/select', { lane: 'coding', source: row.source, model: row.modelId, connectionId: row.connectionId })
          : await L.api('/api/source/select', { source: 'lain', model: row.modelId });
        if (!sr.ok) return L.notice(sr.why, true);
        L.poll();
        if (L.accounts) L.accounts.load();
      };
      var draw = function (rows, q) {
        list.textContent = '';
        rows.filter(function (m) { return m.modelId && (lane === 'chat' ? m.source === 'lain' : true); }).forEach(function (m) {
          var b = el('button', 'opt');
          b.setAttribute('aria-selected', String(m.selected));
          var row1 = el('div', 'row1');
          row1.appendChild(el('span', 'st' + (m.availability === 'AVAILABLE' ? ' ready' : m.authState === 'AUTH_REQUIRED' ? ' auth' : '')));
          row1.appendChild(el('span', '', m.displayName || m.modelId));
          b.appendChild(row1);
          if (m.provider) b.appendChild(el('small', '', m.provider + (m.routes > 1 ? ' · ' + m.routes + ' routes' : '')));
          b.onclick = function () { choose(m); };
          list.appendChild(b);
        });
        if (!list.childNodes.length) list.appendChild(el('div', 'empty', 'no model matches ' + JSON.stringify(q)));
      };
      draw(r.rows, '');
      var seq = 0;
      input.addEventListener('input', function () {
        var q = input.value, mine = ++seq;
        L.api('/api/models/search', { lane: lane, query: q, limit: CODING_PAGE }).then(function (rr) { if (mine === seq && rr.ok) draw(rr.rows, q); });
      });
      setTimeout(function () { input.focus(); }, 0);
    });
  }

  function pickCoding(anchor) { return runtimePicker(anchor, 'coding'); }

  /** Choose the DEFAULT for new sessions — Settings' own field, written through Core. */
  function pickDefault(anchor, role) {
    return runtimePicker(anchor, role === 'coding' ? 'coding' : 'chat', async function (row) {
      var r = role === 'coding'
        ? await L.api('/api/settings/update', { key: 'models.defaultCoding', value: { source: 'lain', modelId: row.modelId } })
        : await L.api('/api/settings/update', { key: 'models.defaultChat', value: { source: 'lain', modelId: row.modelId } });
      if (!r.ok) return L.toast(r.why, true);
      L.toast('Default ' + (role === 'coding' ? 'Coding Agent' : 'BOT') + ' model for new sessions: ' + L.fmt.model(row.modelId));
      if (L.accounts) L.accounts.load();
    });
  }

  L.models = { render: render, pickBot: pickBot, botModels: botModels, pickCoding: pickCoding, pickDefault: pickDefault };

  L.onBoot(function () {
    $('srcPill').onclick = function () { pickBot($('srcPill')); };
    $('modelPill').onclick = function () { botModels($('modelPill')); };
  });
  L.onRender(function (state) { render(state); });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { js, client };
