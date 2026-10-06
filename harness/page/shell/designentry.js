'use strict';

/**
 * LAIN DESIGN'S DOOR — the only Design code in the page. It asks Core whether Design is installed; when it is, it adds
 * the Design room to the rail, an "Open in Design" button to the Preview, and a dismissable chip after UI-change
 * requests. The Design surface itself (design/design.js, design/design.css) is loaded the first time the room opens,
 * and never when Design is not installed. Nothing here reaches the model: the chip is the window's own suggestion to
 * the person, decided here and shown here.
 */

const CSS = `
#vDesign{padding:0;overflow:hidden}
.dz-chip{position:fixed;right:22px;bottom:96px;z-index:60;display:flex;align-items:center;gap:8px;padding:8px 10px 8px 12px;border-radius:999px;background:var(--surface-raised,#1f1f27);box-shadow:0 6px 24px rgba(0,0,0,.28),inset 0 0 0 1px var(--border-subtle,#333);color:var(--text-primary);font-size:12.5px}
.dz-chip button{padding:4px 10px;border-radius:999px;background:var(--accent-primary,#9B8AFB);color:#fff;font-weight:600}
.dz-chip .dz-x{background:transparent;color:var(--text-muted);padding:2px 6px}
#wsDesign[hidden]{display:none}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var status = null;
  var loading = null;
  var mounted = false;
  var streak = 0;

  /** Load the Design surface once (design/design.css + design/design.js, served beside the page). */
  function ensureUI() {
    if (window.LAIN.designUI) return Promise.resolve(window.LAIN.designUI);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'design/design.css'; document.head.appendChild(link);
      var s = document.createElement('script'); s.src = 'design/design.js';
      s.onload = function () { if (window.LAIN.designUI) resolve(window.LAIN.designUI); else reject(new Error('the Design surface did not load')); };
      s.onerror = function () { loading = null; reject(new Error('the Design surface is not installed beside this window (design/)')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function open(opts) {
    if (!status || !status.installed) return;
    L.nav.go('design', opts || {});
  }

  function mount(opts) {
    var view = $('vDesign');
    if (!view) return;
    ensureUI().then(function (UI) {
      if (!mounted) { UI.mount(view, { api: L.api, hostCall: L.hostCall, notice: L.notice || function () {}, toast: L.toast || function () {}, icon: L.icon, openInIde: openInIde, status: status }); mounted = true; }
      UI.show(opts || {});
    }, function (e) { view.textContent = e.message; });
  }

  function openInIde(file, line) {
    L.nav.go('ide');
    if (L.source && L.source.openFile) L.source.openFile(file, { pin: true, line: line || null });
  }

  // ---- THE CHIP: two UI-change requests in a row, or a negative reaction to one --------------------------------
  var UI_WORDS = /\b(move|bigger|smaller|wider|narrower|taller|shorter|color|colour|align|center|centre|padding|margin|spacing|gap|font|bold|button|icon|layout|position|left|right|top|bottom|rounded|radius|shadow|animation|transition|dropdown|navbar|header|footer|ui|style|css)\b/i;
  var NEGATIVE = /\b(ugly|wrong|not what i|doesn'?t look|still (not|wrong|off|broken)|looks (bad|off|weird)|no,? (not|that)|that'?s not|worse)\b/i;
  function dismissed() { try { return localStorage.getItem('lain.design.chip') === 'off'; } catch (e) { return false; } }
  function chip() {
    if (!status || !status.installed || dismissed() || $('dzChip') || L.nav.tab() === 'design') return;
    var c = el('div', 'dz-chip'); c.id = 'dzChip';
    c.appendChild(el('span', '', 'Easier to do this by hand?'));
    var b = el('button', '', 'Open in Design'); b.onclick = function () { c.remove(); open(); }; c.appendChild(b);
    var x = el('button', 'dz-x', '×'); x.setAttribute('aria-label', 'Dismiss'); x.onclick = function () { c.remove(); try { localStorage.setItem('lain.design.chip', 'off'); } catch (e) { /* this time only */ } }; c.appendChild(x);
    document.body.appendChild(c);
  }
  function onSent(text) {
    var t = String(text || '');
    if (NEGATIVE.test(t) && streak > 0) { chip(); return; }
    streak = UI_WORDS.test(t) ? streak + 1 : 0;
    if (streak >= 2) chip();
  }

  L.design = { open: open, status: function () { return status; }, onSent: onSent, ensureUI: ensureUI };

  L.onBoot(function () {
    L.api('/api/design/status', {}).then(function (r) {
      status = r && r.ok ? r : null;
      if (!status || !status.installed || status.enabled === false) return;
      // THE ROOM: a rail tab after Chat, and its view.
      var tabs = $('tabs'); var after = $('tabChat');
      var b = el('button', 'gtab'); b.setAttribute('role', 'tab'); b.setAttribute('data-tab', 'design'); b.id = 'tabDesign';
      b.appendChild(L.icon('palette', 20)); var lbl = el('span', 'lbl', 'Design'); b.appendChild(lbl); b.setAttribute('aria-label', 'Design');
      b.onclick = function () { open(); };
      if (tabs) { if (after && after.nextSibling) tabs.insertBefore(b, after.nextSibling); else tabs.appendChild(b); }
      var main = document.querySelector('main') || document.body;
      var v = el('section', 'view'); v.id = 'vDesign'; v.setAttribute('data-view', 'design'); v.hidden = true; main.appendChild(v);
      if (L.nav.register) L.nav.register('design', 'Design');
      L.nav.onShow('design', mount);
      // THE PREVIEW'S DOOR.
      var pick = $('wsPick');
      if (pick && !$('wsDesign')) {
        var d = el('button', 'u-ib'); d.id = 'wsDesign'; d.setAttribute('aria-label', 'Open in Design'); d.setAttribute('data-tip', 'Open in Design');
        d.appendChild(L.icon('palette', 16)); d.onclick = function () { open(); };
        pick.parentNode.insertBefore(d, pick);
      }
      if (L.onSent) L.onSent(onSent);
    }, function () { /* an older Core: no Design */ });
  });
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js };
