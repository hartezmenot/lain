'use strict';

/**
 * THE MODEL / SOURCE PICKER — split out of pagescript.js (§19 of the guard:
 * "no module is a god object").
 *
 * ------------------------------------------------------------------------
 * WHAT IT OWNS.
 *
 * The composer's source pill (LAIN vs. a logged-in website) and its model
 * pill, and the two searchable popovers behind them. Nothing here decides
 * what a source or model IS — that is modelsource/registry.js, read fresh out
 * of `/api/state` and `/api/source/models` — this module only draws it and
 * sends the person's choice back through `/api/source/select`.
 *
 * SECTIONED BY KIND, NOT HARD-CODED. "Local" is anything that is not a
 * website account (LAIN's own runtime, whichever provider it is configured to
 * route to); "External" is a logged-in account such as ChatGPT.com or
 * Gemini.google.com. Adding a third kind needs no change here.
 *
 * NO BACKTICKS ANYWHERE BELOW, comments included — one template literal, same
 * rule as every other page*.js file.
 */

function js() {
  return `
window.LAIN = window.LAIN || {};
LAIN.models = (function () {
  'use strict';
  var api = null, notice = null, poll = null, S = null;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }

  function popover(anchor, build) {
    closePop();
    var p = el('div', 'pop');
    p.id = 'pop';
    build(p);
    document.body.appendChild(p);
    var r = anchor.getBoundingClientRect();
    p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8)) + 'px';
    p.style.top = Math.max(8, r.top - p.offsetHeight - 8) + 'px';
    setTimeout(function () { document.addEventListener('mousedown', onAway, true); }, 0);
  }
  function onAway(e) { var p = $('pop'); if (p && !p.contains(e.target)) closePop(); }
  function closePop() {
    var p = $('pop');
    if (p) p.remove();
    document.removeEventListener('mousedown', onAway, true);
  }

  function sourceOf(id) {
    return ((S.sources && S.sources.sources) || []).filter(function (x) { return x.id === id; })[0] || null;
  }

  /**
   * WHICH LANE THE COMPOSER IS ASKING FOR A MODEL IN. 'coding' only when an
   * engineering session is actually showing its Coding view — Coding is
   * LAIN-runtime-only there (docs/HARNESS_UI_CONTRACT.md section 4), so it
   * gets its own search rather than the source-then-model flow Chat uses.
   * Cowork and Chat both fall back to the source picker, unchanged.
   */
  function codingLane() {
    return Boolean(S.current && S.current.lane === 'engineering' && S.views && S.views.active === 'coding');
  }

  function render(state) {
    S = state;
    if (codingLane()) {
      // THE SOURCE PILL DOES NOT APPLY HERE — there is no source to pick when
      // Coding only ever talks to LAIN's own runtime.
      $('srcPill').hidden = true;
      var cm = S.models && S.models.coding;
      $('modelName').textContent = (cm && cm.label) || 'no model';
      $('srcDot').className = 'st';
      $('srcPill').title = '';
      return;
    }
    $('srcPill').hidden = false;
    var sel = S.sources ? S.sources.selected : 'lain';
    var s = sourceOf(sel);
    $('srcName').textContent = s ? s.label : 'LAIN';
    var dot = $('srcDot');
    dot.className = 'st' + (!s ? '' : s.state === 'READY' ? ' ready'
      : s.state === 'AUTH_REQUIRED' ? ' auth'
      : (s.state === 'FAILED' || s.state === 'UNAVAILABLE') ? ' bad' : '');
    $('modelName').textContent = (s && s.model) || 'no model';
    $('srcPill').title = s && s.why ? s.why : '';
  }

  /**
   * SOURCE ROW, one shape for the search list and each of its sections.
   *
   * The status dot reuses the same three colours as the composer pill and the
   * session rail — ready/green, auth-required/amber, failed-or-unavailable/red
   * — so "what does this state mean" is answered once for the whole product.
   */
  function sourceOpt(s) {
    var b = el('button', 'opt');
    b.setAttribute('aria-selected', String(s.chosen));
    var row1 = el('div', 'row1');
    var dot = el('span', 'st' + (s.state === 'READY' ? ' ready' : s.state === 'AUTH_REQUIRED' ? ' auth'
      : (s.state === 'FAILED' || s.state === 'UNAVAILABLE') ? ' bad' : ''));
    row1.appendChild(dot);
    row1.appendChild(el('span', '', s.label));
    b.appendChild(row1);
    // THE STATE IS SHOWN AND NEVER GUESSED AT: a website source that needs a
    // login says so here, which is the one thing a person can act on.
    var why = s.state === 'READY' ? (s.model || 'no model chosen')
      : s.state === 'AUTH_REQUIRED' ? 'sign in required'
      : s.state === 'DISCONNECTED' ? 'not connected'
      : (s.why || s.state);
    b.appendChild(el('small', '', why));
    b.onclick = async function () {
      closePop();
      notice('');
      var r = await api('/api/source/select', { source: s.id });
      if (!r.ok) return notice(r.why, true);
      await poll();
      if (s.kind === 'WEB') openModels();
    };
    return b;
  }

  /**
   * THE SOURCE PICKER — searchable, sectioned by KIND rather than one flat
   * list. Nothing here hard-codes a model or provider name — every row is
   * what modelsource/registry.js actually reports.
   */
  function openSources() {
    var all = (S.sources && S.sources.sources) || [];
    popover($('srcPill'), function (p) {
      var box = el('div', 'psearch');
      var input = document.createElement('input');
      input.placeholder = 'Search sources\\u2026';
      box.appendChild(input);
      p.appendChild(box);
      var list = el('div', '');
      p.appendChild(list);
      var draw = function (q) {
        list.textContent = '';
        var needle = (q || '').trim().toLowerCase();
        var match = function (s) { return !needle || s.label.toLowerCase().indexOf(needle) >= 0; };
        var runtime = all.filter(function (s) { return s.kind !== 'WEB' && match(s); });
        var web = all.filter(function (s) { return s.kind === 'WEB' && match(s); });
        if (runtime.length) {
          list.appendChild(el('h4', '', 'Local'));
          runtime.forEach(function (s) { list.appendChild(sourceOpt(s)); });
        }
        if (web.length) {
          list.appendChild(el('h4', '', 'External'));
          web.forEach(function (s) { list.appendChild(sourceOpt(s)); });
        }
        if (!runtime.length && !web.length) list.appendChild(el('div', 'empty', 'no source matches ' + JSON.stringify(q)));
      };
      draw('');
      input.addEventListener('input', function () { draw(input.value); });
      setTimeout(function () { input.focus(); }, 0);
    });
  }

  /**
   * THE MODEL LIST — DISCOVERED, never hard-coded.
   *
   * For LAIN it is the configured catalog; for a website source it is what THAT
   * LOGGED-IN ACCOUNT offers, read off the page. A list that cannot be read is
   * an explicit failure here, not an empty menu that reads as "no models".
   */
  async function openModels() {
    var sel = S.sources ? S.sources.selected : 'lain';
    var s = sourceOf(sel);
    if (!s) return;
    popover($('modelPill'), function (p) {
      p.appendChild(el('h4', '', s.label + ' \\u00b7 reading models\\u2026'));
    });
    var r = await api('/api/source/models', { source: sel });
    if (!r.ok || (!r.models || !r.models.length)) {
      popover($('modelPill'), function (p) {
        p.appendChild(el('h4', '', s.label));
        var b = el('div', 'empty', r.why || 'no models were returned');
        p.appendChild(b);
        if (r.authRequired || (r.why || '').match(/sign in/i)) {
          var c = el('button', 'opt', 'Open ' + s.label + ' to sign in');
          c.appendChild(el('small', '', 'LAIN opens the window; you log in there.'));
          c.onclick = async function () {
            closePop();
            notice('Opening ' + s.label + ' \\u2014 sign in in the window LAIN opened, then choose a model.');
            await api('/api/source/connect', { source: sel });
            poll();
          };
          p.appendChild(c);
        }
      });
      return;
    }
    popover($('modelPill'), function (p) {
      p.appendChild(el('h4', '', s.label + (r.cached ? ' \\u00b7 cached' : '')));
      var box = el('div', 'psearch');
      var input = document.createElement('input');
      input.placeholder = 'Search models\\u2026';
      box.appendChild(input);
      // A SEARCH BOX ONLY EARNS ITS SPACE PAST A HANDFUL OF ROWS. Below that
      // it is one more thing to click through before the same list is on
      // screen anyway.
      if (r.models.length > 6) p.appendChild(box);
      var list = el('div', '');
      p.appendChild(list);
      var draw = function (q) {
        list.textContent = '';
        var needle = (q || '').trim().toLowerCase();
        r.models.filter(function (m) {
          return !needle || (m.label || m.id).toLowerCase().indexOf(needle) >= 0;
        }).forEach(function (m) {
          var b = el('button', 'opt');
          b.setAttribute('aria-selected', String(m.id === s.model));
          b.appendChild(el('span', '', m.label || m.id));
          if (m.state && m.state !== 'AVAILABLE') b.appendChild(el('small', '', m.state));
          b.onclick = async function () {
            closePop();
            var sr = await api('/api/source/select', { source: sel, model: m.id });
            if (!sr.ok) return notice(sr.why, true);
            poll();
          };
          list.appendChild(b);
        });
        if (!list.childNodes.length) list.appendChild(el('div', 'empty', 'no model matches ' + JSON.stringify(q)));
      };
      draw('');
      input.addEventListener('input', function () { draw(input.value); });
      if (r.models.length > 6) setTimeout(function () { input.focus(); }, 0);
      var re = el('button', 'opt', 'Refresh from the account');
      re.onclick = async function () { closePop(); await api('/api/source/models', { source: sel, refresh: true }); openModels(); };
      p.appendChild(re);
    });
  }

  /**
   * CODING'S OWN PICKER — POST /api/models/search {lane:'coding'}, the LAIN
   * runtime catalog only, per docs/HARNESS_UI_CONTRACT.md section 4. One
   * search box, one list, no source step: there is only ever one source here.
   */
  // A CATALOG CAN RUN TO FOUR DIGITS OF ROWS (every model every configured
  // provider offers). Rendering all of them as DOM nodes is the search box
  // doing nothing; the route already accepts a limit, so the empty query
  // asks for a first page, not the whole catalog.
  var CODING_PAGE = 40;

  async function openCodingModels() {
    popover($('modelPill'), function (p) { p.appendChild(el('h4', '', 'Coding model \\u00b7 searching\\u2026')); });
    var r = await api('/api/models/search', { lane: 'coding', query: '', limit: CODING_PAGE });
    if (!r.ok) { popover($('modelPill'), function (p) { p.appendChild(el('div', 'empty', r.why || 'could not read models')); }); return; }
    popover($('modelPill'), function (p) {
      var box = el('div', 'psearch');
      var input = document.createElement('input');
      input.placeholder = 'Search ' + (r.total || r.rows.length) + ' models\\u2026';
      box.appendChild(input);
      p.appendChild(box);
      var list = el('div', '');
      p.appendChild(list);
      var choose = async function (row) {
        closePop();
        var sr = await api('/api/models/select', { lane: 'coding', source: row.source, model: row.modelId, connectionId: row.connectionId });
        if (!sr.ok) return notice(sr.why, true);
        poll();
      };
      var draw = function (rows, q) {
        list.textContent = '';
        rows.forEach(function (m) {
          var b = el('button', 'opt');
          b.setAttribute('aria-selected', String(m.selected));
          var row1 = el('div', 'row1');
          var dot = el('span', 'st' + (m.availability === 'AVAILABLE' ? ' ready' : m.authState === 'AUTH_REQUIRED' ? ' auth' : ''));
          row1.appendChild(dot);
          row1.appendChild(el('span', '', m.displayName || m.modelId));
          b.appendChild(row1);
          if (m.provider) b.appendChild(el('small', '', m.provider));
          b.onclick = function () { choose(m); };
          list.appendChild(b);
        });
        if (!rows.length) list.appendChild(el('div', 'empty', 'no model matches ' + JSON.stringify(q)));
      };
      draw(r.rows, '');
      var seq = 0;
      input.addEventListener('input', function () {
        var q = input.value, mine = ++seq;
        // A LATE RESPONSE TO AN EARLIER KEYSTROKE cannot be allowed to draw
        // over a newer one — sequence-guarded, not just debounced.
        api('/api/models/search', { lane: 'coding', query: q, limit: CODING_PAGE }).then(function (rr) {
          if (mine !== seq) return;
          if (rr.ok) draw(rr.rows, q);
        });
      });
      setTimeout(function () { input.focus(); }, 0);
    });
  }

  function boot(apiFn, noticeFn, pollFn) {
    api = apiFn; notice = noticeFn; poll = pollFn;
    $('srcPill').onclick = openSources;
    $('modelPill').onclick = function () { return codingLane() ? openCodingModels() : openModels(); };
  }

  return { boot: boot, render: render };
})();
`;
}

module.exports = { js };
