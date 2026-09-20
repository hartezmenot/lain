'use strict';

/**
 * SETTINGS — driven entirely by GET /api/settings (docs/HARNESS_UI_CONTRACT.md
 * section 10). Sections and fields come from Core; this file only knows how to
 * draw six field TYPES (boolean, integer, text/directory/file, list, model,
 * info/link) and how to call the two write routes. It never hard-codes a
 * setting key or invents a control Core did not report.
 *
 * Two tabs are pure frontend preference and stay client-only, because the
 * contract says so explicitly: "Not offered because no backend exists:
 * theme/accent" — Appearance's density toggle lives in localStorage, and
 * About is a fixed line plus a pointer to the diagnostics popover.
 *
 * NO BACKTICKS ANYWHERE BELOW, comments included — one template literal, same
 * rule as every other page*.js file.
 */

const HTML = `
<div class="settings" id="settings" hidden role="dialog" aria-modal="true" aria-label="Settings">
  <div class="box">
    <button class="iconbtn close" id="settingsClose" aria-label="Close settings">&#10005;</button>
    <nav class="sidenav">
      <h1>Settings</h1>
      <div id="settingsNav"></div>
    </nav>
    <div class="pane" id="settingsPane"></div>
  </div>
</div>
`;

function js() {
  return `
window.LAIN = window.LAIN || {};
LAIN.settings = (function () {
  'use strict';
  var api = null, notice = null, openBot = null;
  var section = null;      // a Core section id, or 'appearance' / 'about'
  var sections = null;     // the last GET /api/settings read
  var loading = false;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }

  // A PER-MACHINE PREFERENCE, not session state. Nothing polls this and no
  // other surface reads it, so localStorage is the right place for it -
  // unlike a session token, losing it costs nothing but a re-click.
  function density() {
    try { return localStorage.getItem('lain.density') === 'compact' ? 'compact' : 'comfortable'; }
    catch (e) { return 'comfortable'; }
  }
  function setDensity(v) {
    try { localStorage.setItem('lain.density', v); } catch (e) { /* private window, ignore */ }
    document.body.classList.toggle('compact', v === 'compact');
  }

  function field(pane, label, desc, valueNode) {
    var f = el('div', 'field');
    var l = el('div', '');
    l.appendChild(el('div', 'lbl', label));
    if (desc) l.appendChild(el('div', 'desc', desc));
    f.appendChild(l);
    f.appendChild(valueNode);
    pane.appendChild(f);
    return f;
  }

  async function write(key, value) {
    var r = await api('/api/settings/update', { key: key, value: value });
    if (!r.ok) { notice(r.why, true); return false; }
    await load();
    return true;
  }
  async function act(key, action, arg) {
    var r = await api('/api/settings/action', { key: key, action: action, arg: arg || {} });
    if (!r.ok) { notice(r.why, true); return false; }
    await load();
    return true;
  }

  /** ONE RENDERER PER FIELD TYPE. Unsupported or non-editable fields say so. */
  function fieldNode(f) {
    if (!f.supported) {
      var n = el('span', 'val', f.why || 'not supported on this build');
      n.style.color = 'var(--faint)';
      return n;
    }
    if (f.type === 'boolean') {
      var t = el('button', 'toggle');
      t.setAttribute('aria-checked', String(Boolean(f.value)));
      t.disabled = !f.editable;
      t.onclick = function () { write(f.key, !f.value); };
      return t;
    }
    if (f.type === 'info' || f.type === 'link') {
      var v = el('span', 'val', typeof f.value === 'string' ? f.value : (f.value == null ? '' : JSON.stringify(f.value)));
      // ONE NAMED EXCEPTION: the messaging connections field is a real
      // navigation into the Bot view this window already has, not an
      // external link — nothing here opens a URL.
      if (f.key === 'connections.messaging' && openBot) {
        var b = el('button', 'btn', 'Open Bot connections');
        b.onclick = openBot;
        return b;
      }
      return v;
    }
    if (f.type === 'list') {
      var box = el('div', '');
      // AN ITEM MAY BE A PLAIN VALUE (a trusted directory path) OR A ROW
      // OBJECT (a model source: {source, label, state, ...}). Never String()
      // an object — that is where "[object Object]" came from.
      var itemLabel = function (item) {
        if (item == null) return '';
        if (typeof item === 'object') return item.label || item.name || item.id || [item.source, item.state].filter(Boolean).join(' \\u00b7 ') || JSON.stringify(item);
        return String(item);
      };
      var itemKey = function (item) { return (item && typeof item === 'object') ? (item.path || item.id || itemLabel(item)) : item; };
      (Array.isArray(f.value) ? f.value : []).forEach(function (item) {
        var row = el('div', 'connrow');
        row.appendChild(el('div', 'name', itemLabel(item)));
        if (f.editable && f.actions && f.actions.indexOf('forget') >= 0) {
          var rm = el('button', 'btn', 'Forget');
          rm.onclick = function () { act(f.key, 'forget', { path: itemKey(item) }); };
          row.appendChild(rm);
        }
        box.appendChild(row);
      });
      if (!box.childNodes.length) box.appendChild(el('span', 'val', 'none'));
      return box;
    }
    if (f.type === 'model') {
      // A {source, modelId} pair. The composer's model pill is the real place
      // to change a SESSION's model; this shows the default new sessions get.
      var label = f.value && (f.value.modelId || f.value.source)
        ? [f.value.source, f.value.modelId].filter(Boolean).join(' \\u00b7 ') : 'not set';
      return el('span', 'val', label);
    }
    // integer, text, directory, file — one shape: the value, and Change if editable.
    var wrap = el('div', '');
    wrap.style.display = 'flex';
    wrap.style.gap = '8px';
    wrap.style.alignItems = 'center';
    wrap.appendChild(el('span', 'val', f.value == null || f.value === '' ? '(not set)' : String(f.value)));
    if (f.editable) {
      var change = el('button', 'btn', 'Change');
      change.onclick = function () {
        var next = window.prompt(f.label, f.value == null ? '' : String(f.value));
        if (next == null) return;
        if (f.type === 'integer') {
          var num = Number(next);
          if (!Number.isFinite(num)) return notice('enter a number', true);
          if (f.min != null && num < f.min) return notice('minimum is ' + f.min, true);
          if (f.max != null && num > f.max) return notice('maximum is ' + f.max, true);
          write(f.key, num);
        } else {
          write(f.key, next);
        }
      };
      wrap.appendChild(change);
    }
    return wrap;
  }

  function renderCoreSection(pane, sec) {
    pane.appendChild(el('h2', '', sec.label));
    if (!sec.fields || !sec.fields.length) { pane.appendChild(el('div', 'missing', 'nothing in this section yet')); return; }
    sec.fields.forEach(function (f) {
      var node = fieldNode(f);
      field(pane, f.label, f.restartRequired ? 'takes effect after LAIN restarts' : (f.why || ''), node);
    });
  }

  function renderAppearance(pane) {
    pane.appendChild(el('h2', '', 'Appearance'));
    pane.appendChild(el('div', 'sub', 'LAIN is dark by design; there is no second theme to switch to.'));
    field(pane, 'Theme', 'The only theme LAIN draws.', el('span', 'val', 'Dark'));
    var t = el('button', 'toggle');
    t.setAttribute('aria-checked', String(density() === 'compact'));
    t.onclick = function () {
      var next = density() === 'compact' ? 'comfortable' : 'compact';
      setDensity(next);
      t.setAttribute('aria-checked', String(next === 'compact'));
    };
    field(pane, 'Compact density', 'Tighter row and padding spacing across sessions and lists.', t);
  }

  function renderAbout(pane) {
    pane.appendChild(el('h2', '', 'About'));
    pane.appendChild(el('div', 'sub', 'LAIN'));
    pane.appendChild(el('div', 'missing', 'Diagnostics (host, environment, connection) live behind the i control in the header, not here.'));
  }

  function renderNav() {
    var nav = $('settingsNav');
    nav.textContent = '';
    var items = (sections || []).map(function (s) { return { id: s.id, label: s.label }; })
      .concat([{ id: 'appearance', label: 'Appearance' }, { id: 'about', label: 'About' }]);
    if (!section) section = items.length ? items[0].id : 'about';
    items.forEach(function (it) {
      var b = el('button', 'snav', it.label);
      b.setAttribute('aria-selected', String(it.id === section));
      b.onclick = function () { section = it.id; renderNav(); renderPane(); };
      nav.appendChild(b);
    });
  }

  function renderPane() {
    var pane = $('settingsPane');
    pane.textContent = '';
    if (loading && !sections) { pane.appendChild(el('div', 'missing', 'reading settings\\u2026')); return; }
    if (section === 'appearance') return renderAppearance(pane);
    if (section === 'about') return renderAbout(pane);
    var sec = (sections || []).filter(function (s) { return s.id === section; })[0];
    if (sec) renderCoreSection(pane, sec);
  }

  async function load() {
    loading = true;
    var r = await api('/api/settings');
    loading = false;
    if (!r || !r.ok) { notice((r && r.why) || 'could not read settings', true); return; }
    sections = r.sections || [];
    renderNav();
    renderPane();
  }

  function render() {
    if ($('settings').hidden) return;
    renderPane();
  }

  // FOCUS STAYS INSIDE THE DIALOG while it is open (docs' own accessibility
  // ask: keyboard navigation across action dialogs), and returns to whatever
  // opened it on close - a modal that lets Tab wander into the rail or the
  // composer behind it is not actually modal.
  var opener = null;
  function focusables() {
    return Array.prototype.slice.call($('settings').querySelectorAll('button, input, [tabindex]'))
      .filter(function (n) { return !n.disabled && n.offsetParent !== null; });
  }
  function trapTab(e) {
    if (e.key !== 'Tab' || $('settings').hidden) return;
    var items = focusables();
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function open() {
    opener = document.activeElement;
    $('settings').hidden = false;
    if (!sections) load(); else { renderNav(); renderPane(); }
    setTimeout(function () { var items = focusables(); if (items.length) items[0].focus(); }, 0);
  }
  function close() {
    $('settings').hidden = true;
    if (opener && typeof opener.focus === 'function') opener.focus();
    opener = null;
  }

  function boot(apiFn, noticeFn, openBotFn) {
    api = apiFn; notice = noticeFn; openBot = openBotFn || null;
    setDensity(density());
    $('settingsBtn').onclick = open;
    $('settingsClose').onclick = close;
    $('settings').addEventListener('click', function (e) { if (e.target === this) close(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('settings').hidden) return close();
      trapTab(e);
    });
  }

  return { boot: boot, open: open, close: close, render: render };
})();
`;
}

module.exports = { HTML, js };
