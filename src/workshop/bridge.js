'use strict';

/** THE PREVIEW FRAME'S BRIDGE (2026-09-30) — the small script the preview proxy (proxy.js) puts into the project's own page, so LAIN can inspect what it… */

const inspect = require('./inspect');

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- runs in the project's page, any browser */
function client() {
  if (window.__lainBridge || window.top === window) return;
  window.__lainBridge = true;
  var parentOrigin = null;
  var HOLD_MS = 280;
  var MOVE_TOL = 5;
  var DESCRIBE = null;   // replaced at serve time: function (el) → element description
  var MEASURE = null;    // replaced at serve time: function () → { url, viewport, elements }

  function okOrigin(o) { return o === 'https://lain.app' || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(o)); }
  function post(type, data) { if (parentOrigin) { try { window.parent.postMessage(Object.assign({ lain: 1, type: type }, data || {}), parentOrigin); } catch (e) { /* the window is gone */ } } }

  // ---- THE OVERLAY: drawn inside the page so it lines up at any zoom; skipped by the GUG measurement ------------------
  var box = null, hov = null, sel = null, rect = null, tip = null, handles = [];
  function overlay() {
    if (box && box.isConnected) return box;
    box = document.createElement('div');
    box.setAttribute('data-lain-overlay', '1');
    box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    var mk = function (css) { var d = document.createElement('div'); d.style.cssText = 'position:fixed;display:none;box-sizing:border-box;pointer-events:none;' + css; box.appendChild(d); return d; };
    hov = mk('border:1px solid rgba(155,138,251,.9);background:rgba(155,138,251,.10);border-radius:2px;');
    sel = mk('border:2px solid #9B8AFB;border-radius:3px;');
    rect = mk('border:1px dashed #2DD4BF;background:rgba(45,212,191,.10);');
    tip = mk('padding:2px 7px;border-radius:5px;background:#141B24;color:#E7ECF3;font:11px/1.5 ui-monospace,Consolas,monospace;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;');
    ['nw', 'ne', 'sw', 'se'].forEach(function (c) {
      var h = mk('width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid #9B8AFB;pointer-events:auto;cursor:' + (c === 'nw' || c === 'se' ? 'nwse' : 'nesw') + '-resize;');
      h.setAttribute('data-corner', c);
      h.addEventListener('pointerdown', startResize, true);
      handles.push(h);
    });
    window.__lainPickerBox = box;
    (document.body || document.documentElement).appendChild(box);
    return box;
  }
  function place(d, r) { d.style.display = 'block'; d.style.left = r.left + 'px'; d.style.top = r.top + 'px'; d.style.width = r.width + 'px'; d.style.height = r.height + 'px'; }
  function hide(d) { if (d) d.style.display = 'none'; }
  function label(el) {
    var t = el.tagName.toLowerCase();
    if (el.id) t += '#' + el.id;
    else if (el.classList && el.classList.length) t += '.' + [].slice.call(el.classList, 0, 2).join('.');
    var h = hints(el);
    return (h.component ? h.component + ' · ' : '') + t;
  }
  function showHover(el) {
    overlay();
    if (!el) { hide(hov); hide(tip); return; }
    var r = el.getBoundingClientRect();
    place(hov, r);
    tip.textContent = label(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    tip.style.display = 'block';
    tip.style.left = Math.max(2, r.left) + 'px';
    tip.style.top = (r.top > 24 ? r.top - 22 : r.bottom + 4) + 'px';
    tip.style.width = 'auto'; tip.style.height = 'auto';
  }
  var picked = null;
  function showSelected() {
    overlay();
    if (!picked || !picked.isConnected) { hide(sel); handles.forEach(hide); return; }
    var r = picked.getBoundingClientRect();
    place(sel, r);
    var pts = { nw: [r.left, r.top], ne: [r.right, r.top], sw: [r.left, r.bottom], se: [r.right, r.bottom] };
    handles.forEach(function (h) { var p = pts[h.getAttribute('data-corner')]; h.style.display = 'block'; h.style.left = (p[0] - 5) + 'px'; h.style.top = (p[1] - 5) + 'px'; h.style.width = '10px'; h.style.height = '10px'; });
  }

  // ---- WHAT THE FRAMEWORK KNOWS (dev builds only): component and source, as hints -----------------------------------
  function hints(el) {
    var out = { framework: null, component: null, file: null, line: null };
    try {
      for (var n = el, depth = 0; n && depth < 12; n = n.parentElement, depth++) {
        var ds = n.getAttribute && (n.getAttribute('data-lain-src') || n.getAttribute('data-source') || n.getAttribute('data-inspector-relative-path'));
        if (ds && !out.file) { var m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(ds); out.file = m[1]; out.line = m[2] ? Number(m[2]) : null; out.framework = out.framework || 'attribute'; }
        var keys = Object.keys(n);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
            var f = n[k];
            for (var g = f, hop = 0; g && hop < 30; g = g.return, hop++) {
              if (!out.file && g._debugSource) { out.file = g._debugSource.fileName; out.line = g._debugSource.lineNumber || null; }
              if (!out.component && g.type && typeof g.type === 'function') out.component = g.type.displayName || g.type.name || null;
              if (out.component && out.file) break;
            }
            out.framework = 'react';
            return out;
          }
        }
        if (n.__vueParentComponent) {
          var t = n.__vueParentComponent.type || {};
          out.framework = 'vue'; out.component = t.name || t.__name || null; out.file = out.file || t.__file || null;
          return out;
        }
        if (n.__vue__) { var o = n.__vue__.$options || {}; out.framework = 'vue'; out.component = o.name || null; out.file = out.file || o.__file || null; return out; }
        if (n.__svelte_meta && n.__svelte_meta.loc) { out.framework = 'svelte'; out.file = out.file || n.__svelte_meta.loc.file; out.line = out.line || (n.__svelte_meta.loc.line + 1); return out; }
      }
    } catch (e) { /* hints are optional */ }
    return out;
  }

  function describe(el) {
    var d = DESCRIBE ? DESCRIBE(el) : null;
    if (d) d.hints = hints(el);
    return d;
  }
  /** `restore`: the window re-selecting what was selected before a reload — told apart, so it disarms nothing. */
  function choose(el, restore) {
    picked = el;
    showSelected();
    var draft0 = { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) };
    picked.__lainOrig = picked.__lainOrig || { width: el.style.width, height: el.style.height, transform: el.style.transform };
    post('selected', { element: describe(el), measure: MEASURE ? MEASURE() : null, draft0: draft0, url: location.href, restore: Boolean(restore) });
  }

  // ---- THE GESTURE: hold, drag, release -------------------------------------------------------------------------------
  var armed = false;          // the toolbar's one-shot Inspect
  var press = null;           // { x, y, t, timer, holding, target }
  function swallow(e) { e.preventDefault(); e.stopImmediatePropagation(); }
  function elAt(x, y) {
    if (box) box.style.display = 'none';
    var el = document.elementFromPoint(x, y);
    if (box) box.style.display = '';
    return el && el.nodeType === 1 ? el : null;
  }
  /** THE REGION'S OWNER: from the element at the region's centre, up to the first ancestor that covers most of it. */
  function regionOwner(a, b) {
    var l = Math.min(a.x, b.x), t = Math.min(a.y, b.y), w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
    var el = elAt(l + w / 2, t + h / 2);
    while (el && el.parentElement && el !== document.body) {
      var r = el.getBoundingClientRect();
      var ix = Math.max(0, Math.min(r.right, l + w) - Math.max(r.left, l)), iy = Math.max(0, Math.min(r.bottom, t + h) - Math.max(r.top, t));
      if (ix * iy >= 0.8 * w * h) break;
      el = el.parentElement;
    }
    return el;
  }
  function down(e) {
    if (e.button !== 0 || (e.target && e.target.closest && e.target.closest('[data-lain-overlay]'))) return;
    if (armed) { swallow(e); return; }
    press = { x: e.clientX, y: e.clientY, holding: false, timer: setTimeout(function () {
      if (!press) return;
      press.holding = true;
      overlay();
      showHover(elAt(press.x, press.y));
      post('inspecting', {});
    }, HOLD_MS) };
  }
  function move(e) {
    if (armed) { showHover(elAt(e.clientX, e.clientY)); return; }
    if (!press) return;
    if (!press.holding) { if (Math.abs(e.clientX - press.x) > MOVE_TOL || Math.abs(e.clientY - press.y) > MOVE_TOL) { clearTimeout(press.timer); press = null; } return; }
    swallow(e);
    var far = Math.abs(e.clientX - press.x) > 8 || Math.abs(e.clientY - press.y) > 8;
    if (far) { place(rect, { left: Math.min(press.x, e.clientX), top: Math.min(press.y, e.clientY), width: Math.abs(e.clientX - press.x), height: Math.abs(e.clientY - press.y) }); showHover(regionOwner(press, { x: e.clientX, y: e.clientY })); }
    else { hide(rect); showHover(elAt(e.clientX, e.clientY)); }
  }
  function up(e) {
    if (armed) { swallow(e); armed = false; document.documentElement.style.cursor = ''; hide(hov); hide(tip); var t = elAt(e.clientX, e.clientY); if (t) choose(t); return; }
    if (!press) return;
    clearTimeout(press.timer);
    var p = press; press = null;
    if (!p.holding) return;
    swallow(e);
    // THE CLICK THIS PRESS WOULD HAVE MADE IS THE INSPECTION'S, NOT THE APPLICATION'S.
    var eat = function (ev) { swallow(ev); window.removeEventListener('click', eat, true); };
    window.addEventListener('click', eat, true);
    setTimeout(function () { window.removeEventListener('click', eat, true); }, 400);
    hide(rect); hide(hov); hide(tip);
    var far = Math.abs(e.clientX - p.x) > 8 || Math.abs(e.clientY - p.y) > 8;
    var t = far ? regionOwner(p, { x: e.clientX, y: e.clientY }) : elAt(p.x, p.y);
    if (t) choose(t);
  }
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('mousedown', function (e) { if (armed || (press && press.holding)) swallow(e); }, true);
  window.addEventListener('mouseup', function (e) { if (armed || (press && press.holding)) swallow(e); }, true);
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && (armed || press || picked)) { armed = false; press = null; document.documentElement.style.cursor = ''; hide(hov); hide(tip); hide(rect); post('cancelled', {}); } }, true);
  window.addEventListener('scroll', function () { if (picked) showSelected(); }, true);
  window.addEventListener('resize', function () { if (picked) showSelected(); });

  // ---- VISUAL RESIZE: a draft on the element itself, reported as a delta — never written anywhere -------------------------
  var rs = null;
  function startResize(e) {
    if (!picked) return;
    swallow(e);
    var r = picked.getBoundingClientRect();
    rs = { corner: e.target.getAttribute('data-corner'), x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    window.addEventListener('pointermove', resizing, true);
    window.addEventListener('pointerup', endResize, true);
  }
  function resizing(e) {
    if (!rs) return;
    swallow(e);
    var dx = e.clientX - rs.x, dy = e.clientY - rs.y;
    var w = Math.max(4, rs.w + (rs.corner.indexOf('e') >= 0 ? dx : -dx));
    var h = Math.max(4, rs.h + (rs.corner.indexOf('s') >= 0 ? dy : -dy));
    picked.style.width = Math.round(w) + 'px';
    picked.style.height = Math.round(h) + 'px';
    showSelected();
    post('draft', { w: Math.round(w), h: Math.round(h) });
  }
  function endResize(e) {
    swallow(e);
    window.removeEventListener('pointermove', resizing, true);
    window.removeEventListener('pointerup', endResize, true);
    rs = null;
    if (picked) post('draft', { w: Math.round(picked.getBoundingClientRect().width), h: Math.round(picked.getBoundingClientRect().height), done: true });
  }

  // ---- NAVIGATION, ERRORS: what the page did, told to the window ------------------------------------------------------
  function nav() { post('nav', { url: location.href, title: document.title }); }
  ['pushState', 'replaceState'].forEach(function (k) { var o = history[k]; history[k] = function () { var r = o.apply(this, arguments); setTimeout(nav, 0); return r; }; });
  window.addEventListener('popstate', nav);
  window.addEventListener('hashchange', nav);
  window.addEventListener('error', function (e) { post('error', { message: String(e.message || 'error').slice(0, 300), source: String(e.filename || '').slice(0, 200), line: e.lineno || null }); });
  window.addEventListener('unhandledrejection', function (e) { post('error', { message: 'unhandled rejection: ' + String((e.reason && e.reason.message) || e.reason || '').slice(0, 280) }); });

  // MODEL-OWNED INPUT (LAIN packaging pass, §L) — inside THIS page only The model's pointer and keyboard act here, on the preview's own document: no OS…
  var lastUser = 0;
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (t) { window.addEventListener(t, function (e) { if (e.isTrusted) lastUser = Date.now(); }, true); });
  function visible(e) { var r = e.getBoundingClientRect(); var style = getComputedStyle(e); return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; }
  /** A credential field (password, one-time code, card) — its value is never read, named or reported. */
  function secretField(e) { return e && (e.type === 'password' || /current-password|new-password|one-time-code|cc-number|cc-csc/.test((e.getAttribute && e.getAttribute('autocomplete')) || '')); }
  function accName(e) { var lab = e.labels && e.labels[0] ? e.labels[0].innerText : ''; return String(e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('alt') || lab || (secretField(e) ? '' : e.value) || e.innerText || e.textContent || e.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim(); }
  var ROLE = { button: 'button,[role=button],input[type=button],input[type=submit],input[type=reset]', link: 'a[href],[role=link]', textbox: 'input:not([type]),input[type=text],input[type=search],input[type=email],input[type=url],input[type=number],input[type=tel],textarea,[contenteditable=true],[role=textbox]', checkbox: 'input[type=checkbox],[role=checkbox],[role=switch]', tab: '[role=tab]', option: 'option,[role=option]', slider: 'input[type=range],[role=slider]', video: 'video', menuitem: '[role=menuitem]' };
  function resolve(t) {
    t = t || {};
    if (t.selector) { var s = null; try { s = document.querySelector(t.selector); } catch (x) { return { why: 'not a valid selector: ' + t.selector }; } return s ? { el: s } : { why: 'nothing matches ' + t.selector }; }
    if (t.text || t.name || t.role) {
      var want = String(t.text || t.name || '').toLowerCase();
      var pool = Array.prototype.slice.call(document.querySelectorAll(t.role && ROLE[t.role] ? ROLE[t.role] : (t.role ? '[role=' + t.role + ']' : 'button,a,[role],input,select,textarea,label,summary,li,h1,h2,h3,span,div,p,video')));
      var hits = pool.filter(function (e) { if (!visible(e)) return false; if (!want) return true; var n = accName(e).toLowerCase(); return n === want || (n.indexOf(want) >= 0 && n.length <= want.length + 40); });
      hits.sort(function (a, b) { var ea = accName(a).toLowerCase() === want ? 0 : 1, eb = accName(b).toLowerCase() === want ? 0 : 1; if (ea !== eb) return ea - eb; var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return ra.width * ra.height - rb.width * rb.height; });
      return hits[0] ? { el: hits[0], candidates: hits.length } : { why: 'no visible ' + (t.role || 'element') + (want ? ' named "' + (t.text || t.name) + '"' : '') };
    }
    if (typeof t.x === 'number' && typeof t.y === 'number') { var p = document.elementFromPoint(t.x, t.y); return p ? { el: p, point: { x: t.x, y: t.y } } : { why: 'nothing at ' + t.x + ',' + t.y }; }
    if (document.activeElement && document.activeElement !== document.body) return { el: document.activeElement };
    return { why: 'no target: give a selector, the visible text, a role and name, or a point' };
  }
  function about(e) { if (!e) return null; var r = e.getBoundingClientRect(); var sel = null; try { sel = DESCRIBE ? DESCRIBE(e).selector : null; } catch (x) { sel = null; } return { tag: e.tagName.toLowerCase(), selector: sel, name: accName(e).slice(0, 80), rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }; }
  function escapes(e, action, follows) {
    var a = e.closest ? e.closest('a[href]') : null;
    var lab = e.closest ? e.closest('label') : null;
    var fileInput = (e.tagName === 'INPUT' && e.type === 'file') || (lab && lab.control && lab.control.type === 'file');
    if (fileInput && (follows || /click|double|pointer_up/.test(action))) return 'that opens the system file picker — a system dialog is not the model\'s to control; ask the person to choose the file';
    if (a && (follows || /click|double|pointer_up/.test(action))) {
      if (a.hasAttribute('download')) return 'that link downloads a file — downloads leave the Preview';
      if (/^_blank$|^_top$/i.test(a.target || '')) return 'that link opens a new window — the model acts only inside the Preview';
      var u = null; try { u = new URL(a.href, location.href); } catch (x) { u = null; }
      if (u && u.origin !== location.origin && /^https?:/.test(u.protocol)) return 'that link leaves the project for ' + u.origin + ' — the model acts only inside the Preview';
      if (u && !/^https?:$/.test(u.protocol) && u.protocol !== 'javascript:') return 'that link hands off to another application (' + u.protocol + ')';
    }
    if (/type|key/.test(action) && (e.type === 'password' || /current-password|new-password|one-time-code|cc-number|cc-csc/.test(e.getAttribute && e.getAttribute('autocomplete') || ''))) return 'that is a credential field — credentials are entered by the person, never the model';
    return null;
  }
  function center(e) { var r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function mouse(e, type, pt, extra) {
    var o = Object.assign({ bubbles: true, cancelable: true, composed: true, view: window, clientX: pt.x, clientY: pt.y, button: 0, buttons: /down|move/.test(type) ? 1 : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }, extra || {});
    var Ctor = /^pointer/.test(type) && window.PointerEvent ? PointerEvent : /^wheel/.test(type) ? WheelEvent : MouseEvent;
    return e.dispatchEvent(new Ctor(type, o));
  }
  function key(e, type, k, mods) {
    var o = Object.assign({ key: k.key, code: k.code || k.key, bubbles: true, cancelable: true, composed: true }, mods || {});
    return e.dispatchEvent(new KeyboardEvent(type, o));
  }
  var KEYS = { enter: { key: 'Enter', code: 'Enter' }, tab: { key: 'Tab', code: 'Tab' }, escape: { key: 'Escape', code: 'Escape' }, esc: { key: 'Escape', code: 'Escape' }, space: { key: ' ', code: 'Space' }, backspace: { key: 'Backspace', code: 'Backspace' }, delete: { key: 'Delete', code: 'Delete' }, arrowup: { key: 'ArrowUp', code: 'ArrowUp' }, arrowdown: { key: 'ArrowDown', code: 'ArrowDown' }, arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' }, arrowright: { key: 'ArrowRight', code: 'ArrowRight' }, home: { key: 'Home', code: 'Home' }, end: { key: 'End', code: 'End' }, pageup: { key: 'PageUp', code: 'PageUp' }, pagedown: { key: 'PageDown', code: 'PageDown' } };
  function keyOf(name) { var n = String(name || ''); var k = KEYS[n.toLowerCase()]; if (k) return k; if (n.length === 1) return { key: n, code: /[a-z]/i.test(n) ? 'Key' + n.toUpperCase() : /\d/.test(n) ? 'Digit' + n : n }; if (/^f\d{1,2}$/i.test(n)) return { key: n.toUpperCase(), code: n.toUpperCase() }; return { key: n, code: n }; }
  function editable(e) { return e && (e.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.tagName)); }
  function insert(e, text) {
    e.focus();
    var done = false;
    try { done = document.execCommand('insertText', false, text); } catch (x) { done = false; }
    if (!done && /^(INPUT|TEXTAREA)$/.test(e.tagName)) {
      var proto = e.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      var set = Object.getOwnPropertyDescriptor(proto, 'value').set;
      var start = e.selectionStart != null ? e.selectionStart : e.value.length, end = e.selectionEnd != null ? e.selectionEnd : e.value.length;
      set.call(e, e.value.slice(0, start) + text + e.value.slice(end));
      try { e.setSelectionRange(start + text.length, start + text.length); } catch (x) { /* number inputs */ }
      e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }
  function focusables() { return Array.prototype.slice.call(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex],[contenteditable=true]')).filter(function (e) { return !e.disabled && e.tabIndex >= 0 && visible(e); }); }
  function settle(cb) {
    var quiet = null, last = Date.now(), t0 = Date.now();
    var mo = new MutationObserver(function () { last = Date.now(); });
    try { mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch (x) { /* detached */ }
    (function tick() { if (Date.now() - last > 150 || Date.now() - t0 > 1500) { mo.disconnect(); cb(); } else quiet = setTimeout(tick, 50); })();
  }
  /** The page as text for a model without vision: visible text and the interactive elements. Never a credential value. */
  function readPage(root) {
    var scope = root || document.body;
    var text = String(scope.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    var pool = Array.prototype.slice.call(scope.querySelectorAll('a[href],button,input,select,textarea,summary,video,audio,[role],[contenteditable=true]'));
    var els = []; var seen = 0;
    var TAGROLE = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button', VIDEO: 'video', AUDIO: 'audio' };
    var TYPEROLE = { checkbox: 'checkbox', radio: 'radio', range: 'slider', submit: 'button', button: 'button', reset: 'button', file: 'file', password: 'password' };
    pool.forEach(function (el) {
      if (!visible(el)) return;
      seen++;
      if (els.length >= 80) return;
      var role = el.getAttribute('role') || TAGROLE[el.tagName] || (el.tagName === 'INPUT' ? (TYPEROLE[el.type] || 'textbox') : el.tagName.toLowerCase());
      var sel = null; try { sel = DESCRIBE ? DESCRIBE(el).selector : null; } catch (x) { sel = null; }
      var o = { role: role, name: accName(el).slice(0, 80), selector: sel };
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !secretField(el)) o.value = String(el.value).slice(0, 80);
      if (el.disabled) o.disabled = true;
      els.push(o);
    });
    return { url: location.href, title: document.title, text: text.slice(0, 4000) + (text.length > 4000 ? '\n[…]' : ''), elements: els, more: Math.max(0, seen - els.length) };
  }
  function act(m) {
    var a = String(m.action || '');
    var dialogs = [];
    var orig = { alert: window.alert, confirm: window.confirm, prompt: window.prompt, open: window.open };
    // A PAGE DIALOG during the model's action is reported, never answered for the person: dismissed, and said.
    window.alert = function (t) { dialogs.push({ kind: 'alert', text: String(t).slice(0, 200) }); };
    window.confirm = function (t) { dialogs.push({ kind: 'confirm', text: String(t).slice(0, 200) }); return false; };
    window.prompt = function (t) { dialogs.push({ kind: 'prompt', text: String(t).slice(0, 200) }); return null; };
    window.open = function (u) { dialogs.push({ kind: 'window.open', text: 'blocked: ' + String(u || '').slice(0, 200) }); return null; };
    function reply(r) { window.alert = orig.alert; window.confirm = orig.confirm; window.prompt = orig.prompt; setTimeout(function () { window.open = orig.open; }, 0); settle(function () { post('acted', Object.assign({ id: m.id, url: location.href, title: document.title, focused: about(document.activeElement !== document.body ? document.activeElement : null), dialogs: dialogs }, r)); }); }
    try {
      // READ: what is on the page, as text — changes nothing.
      if (a === 'read') {
        var scope = m.target ? resolve(m.target) : null;
        if (scope && !scope.el) return reply({ ok: false, why: scope.why });
        return reply({ ok: true, page: readPage(scope ? scope.el : null) });
      }
      var hit = resolve(m.target);
      if (!hit.el && !/^(scroll|key|key_chord|type_text)$/.test(a)) return reply({ ok: false, why: hit.why });
      var e = hit.el || document.activeElement || document.body;
      var esc = escapes(e, a);
      if (esc) return reply({ ok: false, refused: true, why: esc, target: about(e) });
      if (/click|pointer|drag/.test(a) && e.scrollIntoView) e.scrollIntoView({ block: 'center', inline: 'center' });
      var pt = hit.point || center(e);
      if (a === 'pointer_move') { mouse(e, 'pointerover', pt); mouse(e, 'pointerenter', pt); mouse(e, 'mouseover', pt); mouse(e, 'pointermove', pt, { buttons: 0 }); mouse(e, 'mousemove', pt, { buttons: 0 }); return reply({ ok: true, target: about(e) }); }
      if (a === 'pointer_down') { mouse(e, 'pointerdown', pt); mouse(e, 'mousedown', pt); if (e.focus) e.focus(); return reply({ ok: true, target: about(e) }); }
      if (a === 'pointer_up') { mouse(e, 'pointerup', pt); mouse(e, 'mouseup', pt); return reply({ ok: true, target: about(e) }); }
      if (a === 'click' || a === 'double_click') {
        var n = a === 'double_click' ? 2 : 1;
        for (var i = 1; i <= n; i++) { mouse(e, 'pointerdown', pt, { detail: i }); mouse(e, 'mousedown', pt, { detail: i }); if (i === 1 && e.focus) e.focus(); mouse(e, 'pointerup', pt, { detail: i }); mouse(e, 'mouseup', pt, { detail: i }); mouse(e, 'click', pt, { detail: i }); }
        if (n === 2) mouse(e, 'dblclick', pt, { detail: 2 });
        return reply({ ok: true, target: about(e) });
      }
      if (a === 'drag') {
        var to = m.to || {}; var dest = to.selector || to.text || to.role ? resolve(to) : null;
        var end = dest && dest.el ? center(dest.el) : { x: pt.x + (Number(to.dx) || 0), y: pt.y + (Number(to.dy) || 0) };
        if (typeof to.x === 'number' && typeof to.y === 'number') end = { x: to.x, y: to.y };
        mouse(e, 'pointerdown', pt); mouse(e, 'mousedown', pt);
        var dt = null; if (e.draggable && window.DataTransfer) { dt = new DataTransfer(); e.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y })); }
        for (var s = 1; s <= 8; s++) { var p2 = { x: pt.x + (end.x - pt.x) * s / 8, y: pt.y + (end.y - pt.y) * s / 8 }; var over = document.elementFromPoint(p2.x, p2.y) || e; mouse(over, 'pointermove', p2); mouse(over, 'mousemove', p2); if (dt) over.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: p2.x, clientY: p2.y })); }
        var land = document.elementFromPoint(end.x, end.y) || e;
        if (dt) { land.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: end.x, clientY: end.y })); e.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); }
        mouse(land, 'pointerup', end); mouse(land, 'mouseup', end);
        return reply({ ok: true, target: about(e), dropped: about(land), to: { x: Math.round(end.x), y: Math.round(end.y) } });
      }
      if (a === 'scroll') {
        // THE PAGE, unless a target was named — then the nearest container of it that can actually scroll.
        var page = document.scrollingElement || document.documentElement;
        var box = page;
        if (m.target && hit.el) {
          for (var n = hit.el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
            var ov = getComputedStyle(n); if (/(auto|scroll)/.test(ov.overflowY + ov.overflowX) && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) { box = n; break; }
          }
        }
        var dy = Number(m.dy) || 0, dx = Number(m.dx) || 0;
        if (m.to === 'top') dy = -1e9; if (m.to === 'bottom') dy = 1e9;
        var before = { x: box.scrollLeft, y: box.scrollTop };
        mouse(box, 'wheel', center(box === document.scrollingElement ? document.body : box), { deltaX: dx, deltaY: dy });
        box.scrollBy({ left: dx, top: dy, behavior: 'instant' });
        return reply({ ok: true, scrolled: { from: before, to: { x: box.scrollLeft, y: box.scrollTop } } });
      }
      if (a === 'key' || a === 'key_chord') {
        var names = a === 'key_chord' ? String(m.keys || '').split('+') : [m.key];
        var mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
        var main = null;
        names.forEach(function (x) { var l = String(x).trim().toLowerCase(); if (l === 'ctrl' || l === 'control') mods.ctrlKey = true; else if (l === 'shift') mods.shiftKey = true; else if (l === 'alt') mods.altKey = true; else if (l === 'meta' || l === 'win' || l === 'cmd') mods.metaKey = true; else main = x; });
        var k = keyOf(String(main || '').trim());
        var target = hit.el && hit.el !== document.body ? hit.el : (document.activeElement || document.body);
        if (target !== document.activeElement && target.focus) target.focus();
        if ((k.key === 'Enter' || k.key === ' ') && !mods.ctrlKey && !mods.altKey && !mods.metaKey) { var escK = escapes(target, 'key', true); if (escK) return reply({ ok: false, refused: true, why: escK, target: about(target) }); }
        var go = key(target, 'keydown', k, mods);
        if (go && !mods.ctrlKey && !mods.altKey && !mods.metaKey) {
          if (k.key.length === 1 && editable(target)) insert(target, k.key);
          else if (k.key === 'Backspace' && editable(target)) { try { document.execCommand('delete'); } catch (x) { /* plain input */ } }
          else if (k.key === 'Enter' && target.form && target.tagName === 'INPUT') { try { target.form.requestSubmit(); } catch (x) { /* no form */ } }
          else if (k.key === 'Tab') { var f = focusables(); var ix = f.indexOf(target); var nx = f[(ix + (mods.shiftKey ? -1 : 1) + f.length) % f.length]; if (nx) nx.focus(); }
          else if ((k.key === ' ' || k.key === 'Enter') && /^(BUTTON|A|SUMMARY)$/.test(target.tagName)) target.click();
        }
        key(target, 'keyup', k, mods);
        return reply({ ok: true, key: names.join('+'), target: about(target) });
      }
      if (a === 'type_text') {
        var into = hit.el && editable(hit.el) ? hit.el : (editable(document.activeElement) ? document.activeElement : null);
        if (!into) return reply({ ok: false, why: 'no text field is focused or named — target one (a selector, its label, or role "textbox")' });
        var esc2 = escapes(into, 'type'); if (esc2) return reply({ ok: false, refused: true, why: esc2, target: about(into) });
        if (m.replace) { try { into.select(); } catch (x) { /* contenteditable */ } }
        String(m.text || '').split('').forEach(function (ch) { var kk = keyOf(ch); if (key(into, 'keydown', kk)) insert(into, ch); key(into, 'keyup', kk); });
        into.dispatchEvent(new Event('change', { bubbles: true }));
        return reply({ ok: true, target: about(into), value: String(into.value != null ? into.value : into.innerText).slice(0, 200) });
      }
      return reply({ ok: false, why: 'unknown action ' + a });
    } catch (err) { return reply({ ok: false, why: 'the page threw: ' + String(err && err.message || err).slice(0, 200) }); }
  }
  function runAct(m) {
    // THE PERSON FIRST: if they touched the page in the last second, wait (up to 8 s) for them to stop.
    var waited = 0;
    (function go() {
      if (Date.now() - lastUser < 1000 && waited < 8000) { waited += 250; return setTimeout(go, 250); }
      if (Date.now() - lastUser < 1000) return post('acted', { id: m.id, ok: false, yielded: true, why: 'the person is using the Preview — the model waited 8 s and is yielding' });
      act(m);
    })();
  }

  // ---- THE CLOSED VOCABULARY FROM THE WINDOW -----------------------------------------------------------------------
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.lain !== 1 || !okOrigin(e.origin)) return;
    if (!parentOrigin || m.type === 'hello') parentOrigin = e.origin;
    if (m.type === 'hello') { post('ready', { url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight } }); return; }
    if (m.type === 'inspect') { armed = true; document.documentElement.style.cursor = 'crosshair'; overlay(); return; }
    if (m.type === 'cancel') { armed = false; document.documentElement.style.cursor = ''; hide(hov); hide(tip); return; }
    if (m.type === 'clear') { if (picked && picked.__lainOrig) { picked.style.width = picked.__lainOrig.width; picked.style.height = picked.__lainOrig.height; picked.style.transform = picked.__lainOrig.transform; } picked = null; showSelected(); return; }
    if (m.type === 'reset-draft') { if (picked && picked.__lainOrig) { picked.style.width = picked.__lainOrig.width; picked.style.height = picked.__lainOrig.height; picked.style.transform = picked.__lainOrig.transform; showSelected(); post('draft', { w: Math.round(picked.getBoundingClientRect().width), h: Math.round(picked.getBoundingClientRect().height), reset: true }); } return; }
    if (m.type === 'measure') { post('measured', { measure: MEASURE ? MEASURE() : null }); return; }
    if (m.type === 'select' && typeof m.selector === 'string') { var t = null; try { t = document.querySelector(m.selector); } catch (x) { t = null; } if (t) choose(t, Boolean(m.restore)); else post('gone', { selector: m.selector }); return; }
    if (m.type === 'back') { history.back(); return; }
    if (m.type === 'forward') { history.forward(); return; }
    // THE MODEL'S POINTER AND KEYBOARD, from Core's queue through the window (workshop/previewinput.js).
    if (m.type === 'act' && typeof m.id === 'string') { runAct(m); return; }
  });
}

/** THE SCRIPT AS SERVED: the bridge, with the Workshop's own element and GUG readers inside it. */
function script() {
  const describe = `function (el) { window.__lainPicked = el; try { return ${inspect.describeExpr(null)}; } finally { window.__lainPicked = null; } }`;
  // THE OVERLAY IS NOT THE PAGE: hidden while the page is measured, so the GUG never contains LAIN's own boxes.
  const measure = `function () { var b = window.__lainPickerBox, d = b ? b.style.display : ''; if (b) b.style.display = 'none'; try { return ${inspect.gugExpr(400)}; } catch (e) { return null; } finally { if (b) b.style.display = d; } }`;
  return `(${client.toString().replace('var DESCRIBE = null;', `var DESCRIBE = ${describe};`).replace('var MEASURE = null;', `var MEASURE = ${measure};`)})();`;
}

module.exports = { script, client };
