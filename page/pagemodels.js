'use strict';

/**
 * THE MODEL PICKERS — one per role, used wherever that role's model is shown.
 *
 * ------------------------------------------------------------------------
 * TWO ROLES, TWO PICKERS, ONE OWNER EACH.
 *
 *   BOT model      the Chat selection: a MODEL, on a SOURCE — LAIN's runtime
 *                  (accounts and API keys) or a signed-in website session such
 *                  as ChatGPT.com. The source is chosen separately (pickSource)
 *                  and is never listed as if it were a model.
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

  /** The Chat composer's source/model pills, where a page still has them. */
  function render(state) {
    if (!$('srcPill')) return;
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

  // ---- BOT: a MODEL, and underneath it the SOURCE it runs on ------------------
  //
  // A website session (ChatGPT.com) is not a model and never reads as one: the
  // BOT model chooser lists models, and says underneath which source they come
  // from — LAIN's runtime (your accounts and API keys) or a signed-in website
  // session. Changing the source is its own, nested chooser.

  /** Close the chooser a choice was made in: its own level only when it is nested. */
  function done() { if (L.popDepth() > 1) L.popBack(false); else L.closePop(); }
  function after() { return L.poll().then(function () { L.popRefresh(); }); }

  function sourceKind(s) { return s.kind === 'WEB' ? 'website session' : 'LAIN runtime'; }
  function sourceOpt(s) {
    var b = el('button', 'opt');
    b.setAttribute('aria-selected', String(s.chosen));
    var row1 = el('div', 'row1');
    row1.appendChild(el('span', dotClass(s.state)));
    row1.appendChild(el('span', '', s.label));
    b.appendChild(row1);
    var why = s.state === 'READY' ? (s.kind === 'WEB' ? 'signed in' : (L.fmt.model(s.model) ? 'model: ' + L.fmt.model(s.model) : 'ready')) : s.state === 'AUTH_REQUIRED' ? 'sign in required' : s.state === 'DISCONNECTED' ? 'not connected' : (s.why || s.state);
    b.appendChild(el('small', '', why));
    b.onclick = async function () {
      done();
      var r = await L.api('/api/source/select', { source: s.id });
      if (!r.ok) return L.notice(r.why, true);
      await after();
    };
    return b;
  }
  /** WHERE THE BOT'S MODEL RUNS — a source, not a model. */
  function pickSource(anchor) {
    var all = (S().sources && S().sources.sources) || [];
    L.popover(anchor, function (p) {
      p.appendChild(el('h4', '', 'CHAT source'));
      var runtime = all.filter(function (s) { return s.kind !== 'WEB'; });
      var web = all.filter(function (s) { return s.kind === 'WEB'; });
      if (runtime.length) {
        p.appendChild(el('div', 'pgroup', 'LAIN runtime \u00b7 your accounts and API keys'));
        runtime.forEach(function (s) { p.appendChild(sourceOpt(s)); });
      }
      if (web.length) {
        p.appendChild(el('div', 'pgroup', 'Website sessions \u00b7 CHAT ONLY \u00b7 never the BOT or the Agent'));
        web.forEach(function (s) { p.appendChild(sourceOpt(s)); });
      }
      if (!runtime.length && !web.length) p.appendChild(el('div', 'empty', 'no sources are configured'));
    }, { cls: 'srcpop' });
  }

  /** THE BOT'S MODEL — on whichever source is chosen; the source is shown underneath. */
  function pickBot(anchor) { return runtimePicker(anchor, 'bot'); }
  /** THE CHAT VIEW'S SOURCE AND MODEL — the only place ChatGPT Chat (CHAT ONLY) is offered. */
  function pickChat(anchor) {
    var sel = S().sources ? S().sources.selected : 'lain';
    if (sel === 'lain') return runtimePicker(anchor, 'chat');
    return botModels(anchor);
  }
  function sourceFooter(p) {
    var sel = S().sources ? S().sources.selected : 'lain';
    var s = sourceOf(sel);
    var b = el('button', 'opt srcfoot');
    b.appendChild(el('span', '', 'Source: ' + (s ? s.label : 'LAIN runtime')));
    b.appendChild(el('small', '', (s ? sourceKind(s) : 'LAIN runtime') + ' \u00b7 change\u2026'));
    b.onclick = function () { pickSource(b); };
    p.appendChild(b);
  }

  /** The models on the BOT's chosen website source — discovered, never hard-coded. */
  async function botModels(anchor) {
    var sel = S().sources ? S().sources.selected : 'lain';
    var s = sourceOf(sel);
    if (!s) return;
    if (sel === 'lain') return runtimePicker(anchor, 'chat');
    L.popover(anchor, function (p) { p.appendChild(el('h4', '', 'BOT model \u00b7 reading ' + s.label + '\u2026')); });
    var r = await L.api('/api/source/models', { source: sel });
    if (!anchor.isConnected) return;
    if (!r.ok || !(r.models || []).length) {
      L.popover(anchor, function (p) {
        p.appendChild(el('h4', '', 'BOT model'));
        p.appendChild(el('div', 'empty', r.why || 'no models were returned'));
        if (r.authRequired || /sign in/i.test(r.why || '')) {
          var c = el('button', 'opt', 'Open ' + s.label + ' to sign in');
          c.appendChild(el('small', '', 'An ordinary browser window opens; you sign in there, never in LAIN.'));
          c.onclick = async function () {
            L.closePop();
            var r = await L.api('/api/source/signin', { source: sel });
            if (!r.ok) return L.notice(r.why, true);
            L.notice('Sign in in the browser window that opened (nothing is attached to it). Close it when you are done, then choose a model.');
            L.poll();
          };
          p.appendChild(c);
        }
        sourceFooter(p);
      });
      return;
    }
    L.popover(anchor, function (p) {
      p.appendChild(el('h4', '', 'BOT model' + (r.cached ? ' \u00b7 cached' : '')));
      var input = r.models.length > 6 ? searchBox(p, 'Search models\u2026') : null;
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
            done();
            var sr = await L.api('/api/source/select', { source: sel, model: m.id });
            if (!sr.ok) return L.notice(sr.why, true);
            await after();
          };
          list.appendChild(b);
        });
        if (!list.childNodes.length) list.appendChild(el('div', 'empty', 'no model matches'));
      };
      draw('');
      if (input) { input.addEventListener('input', function () { draw(input.value); }); setTimeout(function () { input.focus(); }, 0); }
      var re = el('button', 'opt', 'Refresh from the account');
      re.onclick = async function () { await L.api('/api/source/models', { source: sel, refresh: true }); botModels(anchor); };
      p.appendChild(re);
      sourceFooter(p);
    });
  }

  /**
   * LAIN'S RUNTIME CATALOG, searched by Core (modelsearch.js — the same
   * ranking /models uses). `lane` is whose model it sets: 'coding' for the
   * Coding Agent, 'chat' for the BOT on LAIN's runtime. A catalog can hold
   * four digits of models, so the empty query asks for a first page only.
   */
  async function runtimePicker(anchor, lane, onPick) {
    var title = lane === 'coding' ? 'Coding Agent model' : lane === 'bot' ? 'BOT model' : 'CHAT model';
    var searchLane = lane === 'bot' ? 'chat' : lane;
    var ROLE = lane === 'coding' ? 'AGENT' : lane === 'bot' ? 'BOT' : 'CHAT';
    var group = function (m) { return m.locality === 'local' ? 'Local' : m.runtime ? 'Runtimes' : 'API'; };
    L.popover(anchor, function (p) { p.appendChild(el('h4', '', title + ' · searching…')); });
    var r = await L.api('/api/models/search', { lane: searchLane, query: '', limit: CODING_PAGE });
    // THE CHOOSER WAS CLOSED WHILE CORE SEARCHED — do not reopen it somewhere.
    if (!anchor.isConnected) return;
    if (!r.ok) { L.popover(anchor, function (p) { p.appendChild(el('div', 'empty', r.why || 'could not read models')); }); return; }
    L.popover(anchor, function (p) {
      p.appendChild(el('h4', '', title));
      var shown = r.rows.filter(function (m) { return m.modelId && m.source === 'lain'; }).length;
      var input = searchBox(p, shown ? 'Search models…' : 'Search…');
      var list = el('div', '');
      p.appendChild(list);
      var choose = async function (row) {
        done();
        if (onPick) return onPick(row);
        var sr = lane === 'coding'
          ? await L.api('/api/models/select', { lane: 'coding', source: row.source, model: row.modelId, connectionId: row.connectionId })
          : lane === 'bot'
            ? await L.api('/api/session/intel/set', { lane: 'bot', value: row.modelId, scope: 'session' })
            : await L.api('/api/source/select', { source: 'lain', model: row.modelId });
        if (!sr.ok) return L.notice(sr.why, true);
        await after();
        if (L.accounts) L.accounts.load();
      };
      var draw = function (rows, q) {
        list.textContent = '';
        // LAIN ROUTES ONLY (a website row is CHAT ONLY and lives in the CHAT source picker), grouped Local / Runtimes / API.
        var mine = rows.filter(function (m) { return m.modelId && m.source === 'lain'; });
        var order = { Local: 0, Runtimes: 1, API: 2 };
        mine.sort(function (a, b) { return order[group(a)] - order[group(b)]; });
        var lastGroup = null;
        mine.forEach(function (m) {
          if (group(m) !== lastGroup) { lastGroup = group(m); list.appendChild(el('div', 'pgroup', lastGroup)); }
          var allowed = !m.roles || m.roles.indexOf(ROLE) >= 0;
          var b = el('button', 'opt' + (allowed ? '' : ' off'));
          if (!allowed) { b.disabled = true; b.title = ROLE === 'AGENT' ? 'AGENT not verified — run its Agent test in MODEL › Local' : 'not a ' + ROLE + ' model'; }
          b.setAttribute('aria-selected', String(m.selected));
          var row1 = el('div', 'row1');
          row1.appendChild(el('span', 'st' + (m.availability === 'AVAILABLE' ? ' ready' : m.authState === 'AUTH_REQUIRED' ? ' auth' : '')));
          row1.appendChild(el('span', '', m.displayName || m.modelId));
          b.appendChild(row1);
          if (m.provider) b.appendChild(el('small', '', (m.locality === 'local' ? 'Local · no provider quota' : m.provider) + (m.routes > 1 ? ' · ' + m.routes + ' routes' : '') + (!allowed ? ' · ' + (ROLE === 'AGENT' ? 'AGENT not verified' : 'not ' + ROLE) : '')));
          b.onclick = function () { choose(m); };
          list.appendChild(b);
        });
        if (!list.childNodes.length) list.appendChild(el('div', 'empty', q ? 'no model matches ' + JSON.stringify(q) : 'no models are configured yet — add an account or API key in Model'));
      };
      draw(r.rows, '');
      if (lane === 'chat' && !onPick) sourceFooter(p);
      var seq = 0;
      input.addEventListener('input', function () {
        var q = input.value, mine = ++seq;
        L.api('/api/models/search', { lane: searchLane, query: q, limit: CODING_PAGE }).then(function (rr) { if (mine === seq && rr.ok) draw(rr.rows, q); });
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

  L.models = { render: render, pickBot: pickBot, pickChat: pickChat, pickSource: pickSource, botModels: botModels, pickCoding: pickCoding, pickDefault: pickDefault };

  L.onBoot(function () {
    // The pickers are opened from the input bar's settings (pagecomposer.js),
    // the IDE BOT panel and the Model view — never from a second set of pills.
  });
  L.onRender(function (state) { render(state); });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { js, client };
