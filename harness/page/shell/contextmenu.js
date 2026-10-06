'use strict';

/**
 * THE CONTEXT MENU — the one input affordance the native window did not have.
 *
 * ------------------------------------------------------------------------
 * HOW THIS WAS FOUND, because it is the only part of the input audit that
 * turned up a real gap.
 *
 * The release window sets `AreDefaultContextMenusEnabled = false` (see
 * native/host.cs), which is right: WebView2's own menu offers Reload, View
 * source, Save as and Inspect, none of which belong in a native application.
 * But removing it removed Copy and Paste with it, so right-clicking in LAIN did
 * nothing at all.
 *
 * MEASURED ON THE RELEASE WINDOW, with real Windows input and no extension:
 * typing works, Ctrl+A works, Ctrl+C copies out, Ctrl+V pastes in — the
 * keyboard was never the gap. Right-click raised nothing. So this is LAIN's own
 * menu, with LAIN's own items, and nothing browser-shaped in it.
 *
 * ------------------------------------------------------------------------
 * CORE OWNS THE CLIPBOARD, NOT THE PAGE.
 *
 * `document.execCommand('paste')` is blocked in Chromium and
 * `navigator.clipboard.readText()` depends on a permission prompt this window
 * should never show. Both would be a second clipboard authority besides
 * `src/copy.js` — which is also the one place that strips invisible characters
 * on the way out (the sanitiser that exists because a pasted line with a zero
 * width space in it does not run). One clipboard, one sanitiser.
 */

const HTML = `
      <div class="ctxmenu" id="ctxMenu" hidden role="menu"></div>`;

const CSS = `
/* ---- the context menu -------------------------------------------------- */
.ctxmenu{position:fixed;z-index:80;min-width:170px;padding:5px;background:var(--surface-base);
         border:1px solid var(--separator);border-radius:var(--radius-sm);box-shadow:0 12px 34px #0009}
.ctxmenu button{display:block;width:100%;text-align:left;padding:6px 10px;border-radius:4px;font-size:13px}
.ctxmenu button:hover:not(:disabled){background:var(--surface-active)}
.ctxmenu button:disabled{color:var(--text-muted)}
.ctxmenu .sep{height:1px;margin:4px 6px;background:var(--separator)}`;

const SCRIPT = `
(function () {
  var api = null, notice = null;
  function $(id) { return document.getElementById(id); }

  function close() { var m = $('ctxMenu'); if (m) { m.hidden = true; m.textContent = ''; } }

  function item(label, enabled, run) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.disabled = !enabled;
    b.onclick = function () { close(); run(); };
    return b;
  }

  /** The editable field the click landed in, or null. */
  function fieldAt(node) {
    while (node && node !== document.body) {
      var t = (node.tagName || '').toLowerCase();
      if (t === 'textarea' || (t === 'input' && /^(text|search|url|email|password)$/.test(node.type || 'text'))) return node;
      node = node.parentNode;
    }
    return null;
  }

  function selectedText() { return String(window.getSelection ? window.getSelection() : ''); }

  async function copy(text) {
    if (!text) return;
    // CORE'S CLIPBOARD, which is also the only sanitiser. See src/copy.js.
    var r = await api('/api/clipboard/write', { text: text });
    if (!r.ok) notice(r.why, true);
  }

  async function paste(field) {
    var r = await api('/api/clipboard/read', {});
    if (!r.ok) return notice(r.why, true);
    var text = r.text || '';
    if (!text || !field) return;
    var s = field.selectionStart, e = field.selectionEnd;
    field.value = field.value.slice(0, s) + text + field.value.slice(e);
    var at = s + text.length;
    field.setSelectionRange(at, at);
    field.focus();
    // The composer grows with what is in it, and a paste is the biggest jump
    // it ever makes.
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function open(e) {
    var field = fieldAt(e.target);
    var sel = selectedText();
    var inField = Boolean(field);
    var fieldSel = inField && field.selectionStart !== field.selectionEnd;
    var text = fieldSel ? field.value.slice(field.selectionStart, field.selectionEnd) : sel;

    var m = $('ctxMenu');
    m.textContent = '';
    m.appendChild(item('Copy', Boolean(text), function () { copy(text); }));
    if (inField) {
      m.appendChild(item('Cut', fieldSel, function () {
        copy(text);
        field.value = field.value.slice(0, field.selectionStart) + field.value.slice(field.selectionEnd);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
      }));
      m.appendChild(item('Paste', true, function () { paste(field); }));
      m.appendChild(item('Select all', Boolean(field.value), function () { field.focus(); field.select(); }));
    } else if (sel) {
      m.appendChild(item('Select all', true, function () {
        var r = document.createRange();
        r.selectNodeContents(e.target.closest('.msg, #stream') || document.body);
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      }));
    }

    m.hidden = false;
    // PLACED SO IT STAYS ON SCREEN. A menu opened near the right or bottom edge
    // that runs off it is a menu with items nobody can reach.
    var r = m.getBoundingClientRect();
    m.style.left = Math.min(e.clientX, window.innerWidth - r.width - 6) + 'px';
    m.style.top = Math.min(e.clientY, window.innerHeight - r.height - 6) + 'px';
  }

  function boot(deps) {
    api = deps.api; notice = deps.notice;
    window.addEventListener('contextmenu', function (e) {
      e.preventDefault();          // release builds show none of their own
      open(e);
    });
    window.addEventListener('mousedown', function (e) {
      if (!$('ctxMenu').hidden && !$('ctxMenu').contains(e.target)) close();
    });
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    window.addEventListener('blur', close);
  }

  window.LAIN = window.LAIN || {};
  window.LAIN.menu = { boot: boot, close: close };
})();`;

module.exports = { HTML, CSS, SCRIPT };
