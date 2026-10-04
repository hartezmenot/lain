'use strict';

/**
 * THE DESIGN RUNTIME — the small script the Design preview server adds to the SERVED copy of a page (never to the
 * project's files). It reports what is on the page by `data-lain-id` (rects and layout facts, for the canvas and for
 * layout-aware drags), turns clicks into selections in Design mode, draws the VIRTUAL cursor and click ripple so the
 * person can watch a test, performs virtual input when the window drives the test, and records what an action changed
 * (DOM, console errors, URL) as an observation. It talks to the window by postMessage and to tests over CDP.
 */

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template, object-shorthand -- runs in the page, any browser */
function client() {
  if (window.__lainDesign) return;
  var mode = 'design';
  var drawSel = true;   // the Design window draws its own selection (with handles) over the frame
  var errors = [];
  var changes = { added: 0, removed: 0, attributes: 0, text: 0 };
  var parentOrigin = '*';
  var origError = console.error;
  console.error = function () { try { errors.push(Array.prototype.map.call(arguments, String).join(' ').slice(0, 300)); } catch (e) { /* never break the page */ } return origError.apply(console, arguments); };
  window.addEventListener('error', function (e) { errors.push(String(e.message || e).slice(0, 300)); });
  window.addEventListener('unhandledrejection', function (e) { errors.push(('unhandled rejection: ' + (e.reason && e.reason.message || e.reason)).slice(0, 300)); });
  try {
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        if (m.target && m.target.closest && m.target.closest('[data-lain-overlay]')) return;
        if (m.type === 'childList') { var own = function (n) { return n.nodeType === 1 && n.hasAttribute('data-lain-overlay'); }; changes.added += Array.prototype.filter.call(m.addedNodes, function (n) { return !own(n); }).length; changes.removed += Array.prototype.filter.call(m.removedNodes, function (n) { return !own(n); }).length; } else if (m.type === 'attributes') changes.attributes += 1; else changes.text += 1;
      });
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch (e) { /* an old engine: no change counts */ }

  function post(type, data) { try { if (window.parent !== window) window.parent.postMessage(Object.assign({ lainDesign: 1, type: type }, data || {}), parentOrigin); } catch (e) { /* closed */ } }
  function el(id) { return document.querySelector('[data-lain-id="' + id + '"]'); }
  function rectOf(n) { var r = n.getBoundingClientRect(); return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }; }
  function nums(cs, a, b, c, d) { return { top: parseFloat(cs[a]) || 0, right: parseFloat(cs[b]) || 0, bottom: parseFloat(cs[c]) || 0, left: parseFloat(cs[d]) || 0 }; }
  function translateOf(cs) {
    var t = String(cs.translate || 'none'); if (t === 'none') return { x: 0, y: 0 };
    var p = t.split(/\s+/); return { x: parseFloat(p[0]) || 0, y: parseFloat(p[1]) || 0 };
  }
  function containingOf(n, cs) {
    if (cs.position === 'fixed') return { x: window.scrollX, y: window.scrollY, w: window.innerWidth, h: window.innerHeight };
    var p = n.offsetParent || document.documentElement;
    var r = rectOf(p); var pcs = getComputedStyle(p);
    // THE PADDING BOX is what top/left are measured from.
    var b = nums(pcs, 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth');
    return { x: r.x + b.left, y: r.y + b.top, w: r.w - b.left - b.right, h: r.h - b.top - b.bottom };
  }
  function layoutOf(id) {
    var n = el(id); if (!n) return null;
    var cs = getComputedStyle(n); var par = n.parentElement; var pcs = par ? getComputedStyle(par) : null;
    var sibs = par ? Array.prototype.filter.call(par.children, function (c) { return c.hasAttribute('data-lain-id'); }).map(function (c) { return { id: c.getAttribute('data-lain-id'), rect: rectOf(c) }; }) : [];
    return {
      id: id, tag: n.tagName.toLowerCase(), rect: rectOf(n), position: cs.position, display: cs.display,
      parentDisplay: pcs ? pcs.display : null, flexDirection: pcs ? pcs.flexDirection : null,
      margin: nums(cs, 'marginTop', 'marginRight', 'marginBottom', 'marginLeft'), padding: nums(cs, 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'),
      containing: containingOf(n, cs), translate: translateOf(cs), siblings: sibs,
      parent: par && par.hasAttribute('data-lain-id') ? { id: par.getAttribute('data-lain-id'), rect: rectOf(par), padding: nums(pcs, 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft') } : null,
      style: { color: cs.color, backgroundColor: cs.backgroundColor, fontSize: cs.fontSize, opacity: cs.opacity, borderRadius: cs.borderRadius, gap: cs.gap, padding: cs.padding, transform: cs.transform, width: cs.width, height: cs.height },
    };
  }
  function measure() {
    return Array.prototype.map.call(document.querySelectorAll('[data-lain-id]'), function (n) {
      return { id: n.getAttribute('data-lain-id'), tag: n.tagName.toLowerCase(), rect: rectOf(n), visible: n.getClientRects().length > 0 };
    });
  }

  // ---- the overlay: hover, selection, the virtual cursor --------------------------------------------------------
  var box = null; var hov = null; var sel = null; var cur = null;
  function overlay() {
    if (box && box.isConnected) return;
    box = document.createElement('div'); box.setAttribute('data-lain-overlay', '1');
    box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    var mk = function (css) { var d = document.createElement('div'); d.style.cssText = 'position:fixed;display:none;box-sizing:border-box;pointer-events:none;' + css; box.appendChild(d); return d; };
    hov = mk('border:1px solid rgba(155,138,251,.9);background:rgba(155,138,251,.08);');
    sel = mk('border:2px solid #9B8AFB;');
    cur = mk('width:18px;height:18px;margin:-2px 0 0 -2px;transition:left .25s ease,top .25s ease;background:no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 18 18%27%3E%3Cpath d=%27M2 1l13 7-6 1.5L6 16z%27 fill=%27%23111%27 stroke=%27%23fff%27 stroke-width=%271.4%27/%3E%3C/svg%3E");');
    (document.body || document.documentElement).appendChild(box);
  }
  function place(d, n) { if (!n) { d.style.display = 'none'; return; } var r = n.getBoundingClientRect(); d.style.display = 'block'; d.style.left = r.left + 'px'; d.style.top = r.top + 'px'; d.style.width = r.width + 'px'; d.style.height = r.height + 'px'; }
  function ripple(x, y) {
    overlay();
    var r = document.createElement('div');
    r.style.cssText = 'position:fixed;left:' + (x - 12) + 'px;top:' + (y - 12) + 'px;width:24px;height:24px;border-radius:50%;border:2px solid #9B8AFB;pointer-events:none;transition:transform .35s ease,opacity .35s ease;';
    box.appendChild(r);
    requestAnimationFrame(function () { r.style.transform = 'scale(1.8)'; r.style.opacity = '0'; });
    setTimeout(function () { r.remove(); }, 450);
  }
  function cursor(x, y, click) { overlay(); cur.style.display = 'block'; cur.style.left = x + 'px'; cur.style.top = y + 'px'; if (click) ripple(x, y); }

  function target(n) { while (n && n.nodeType === 1 && !n.hasAttribute('data-lain-id')) n = n.parentElement; return n && n.nodeType === 1 ? n : null; }
  document.addEventListener('mousemove', function (e) { if (mode !== 'design') return; overlay(); var t = target(e.target); place(hov, t); post('hover', { id: t && t.getAttribute('data-lain-id') }); }, true);
  // LIVE MODE RECORDS what the person clicks and types, so "Run test" can replay it without the model.
  function stepTarget(n) {
    var t = target(n); var id = t && t.getAttribute('data-lain-id');
    var txt = n && n.closest ? ((n.closest('a,button,[role=button]') || {}).innerText || '').trim() : '';
    return n && n.id ? { selector: '#' + n.id } : (txt && txt.length < 40 ? { text: txt } : (id ? { node: id } : null));
  }
  document.addEventListener('click', function (e) { if (mode === 'live' && !e.lainVirtual && e.isTrusted) post('record', { step: { action: 'click', target: stepTarget(e.target) } }); }, true);
  document.addEventListener('change', function (e) { if (mode === 'live' && e.isTrusted && e.target && 'value' in e.target) post('record', { step: { action: 'type', target: stepTarget(e.target), text: String(e.target.value).slice(0, 200) } }); }, true);
  ['click', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'submit'].forEach(function (k) {
    document.addEventListener(k, function (e) {
      if (mode !== 'design' || e.lainVirtual) return;
      e.preventDefault(); e.stopPropagation();
      if (k === 'click') { var t = target(e.target); overlay(); if (drawSel) place(sel, t); post('select', { id: t && t.getAttribute('data-lain-id'), x: e.clientX, y: e.clientY, shift: e.shiftKey }); }
    }, true);
  });

  // ---- virtual input (when the window drives a test; a headless test sends trusted CDP events instead) ------------
  function find(t) {
    if (!t) return null;
    if (t.id) return el(t.id);
    if (t.selector) return document.querySelector(t.selector);
    if (t.text) { var all = document.querySelectorAll('a,button,[role=button],[data-lain-id]'); for (var i = 0; i < all.length; i++) if ((all[i].innerText || all[i].getAttribute('aria-label') || '').trim() === t.text) return all[i]; }
    return null;
  }
  function centre(n) { var r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function fire(n, type, p, extra) {
    var Ctor = /^pointer/.test(type) ? (window.PointerEvent || MouseEvent) : /^key/.test(type) ? KeyboardEvent : MouseEvent;
    var ev = new Ctor(type, Object.assign({ bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, view: window }, extra || {}));
    ev.lainVirtual = true; n.dispatchEvent(ev); return ev;
  }
  function act(a) {
    var prev = mode; mode = 'live';
    try {
      if (a.action === 'click' || a.action === 'tap') {
        var n = find(a.target) || (a.x != null ? document.elementFromPoint(a.x, a.y) : null);
        if (!n) return { ok: false, why: 'nothing to click there' };
        var p = a.x != null ? { x: a.x, y: a.y } : centre(n); cursor(p.x, p.y, true);
        fire(n, 'pointerdown', p); fire(n, 'mousedown', p); fire(n, 'pointerup', p); fire(n, 'mouseup', p);
        var c = fire(n, 'click', p);
        if (!c.defaultPrevented) { var link = n.closest && n.closest('a[href]'); if (link) location.href = link.href; }
        return { ok: true, at: p };
      }
      if (a.action === 'type') {
        var f = find(a.target) || document.activeElement; if (!f) return { ok: false, why: 'nowhere to type' };
        f.focus(); cursor(centre(f).x, centre(f).y, false);
        for (var i = 0; i < String(a.text || '').length; i++) { var ch = a.text[i]; fire(f, 'keydown', centre(f), { key: ch }); if ('value' in f) f.value += ch; f.dispatchEvent(new Event('input', { bubbles: true })); fire(f, 'keyup', centre(f), { key: ch }); }
        return { ok: true };
      }
      if (a.action === 'move' || a.action === 'hover') {
        var hn = find(a.target); var hp = hn ? centre(hn) : { x: a.x, y: a.y }; cursor(hp.x, hp.y, false);
        if (hn) { fire(hn, 'pointerover', hp); fire(hn, 'mouseover', hp); fire(hn, 'pointermove', hp); fire(hn, 'mousemove', hp); }
        return { ok: true, at: hp };
      }
      if (a.action === 'press') {
        var kt = document.activeElement || document.body; var key = String(a.key || 'Enter');
        fire(kt, 'keydown', centre(kt), { key: key }); fire(kt, 'keyup', centre(kt), { key: key });
        if (key === 'Enter' && kt.form && kt.form.requestSubmit) kt.form.requestSubmit();
        return { ok: true };
      }
      if (a.action === 'scroll') { var sn = find(a.target); if (sn) sn.scrollBy(a.dx || 0, a.dy == null ? 300 : a.dy); else window.scrollBy(a.dx || 0, a.dy == null ? 300 : a.dy); return { ok: true }; }
      if (a.action === 'longpress') {
        var ln = find(a.target); if (!ln) return { ok: false, why: 'nothing to press there' };
        var lp = centre(ln); cursor(lp.x, lp.y, true); fire(ln, 'pointerdown', lp); fire(ln, 'mousedown', lp);
        setTimeout(function () { fire(ln, 'pointerup', lp); fire(ln, 'mouseup', lp); }, a.ms || 650);
        return { ok: true, at: lp, settleExtra: (a.ms || 650) };
      }
      if (a.action === 'drag' || a.action === 'swipe') {
        var dn = find(a.target); if (!dn) return { ok: false, why: 'nothing to drag there' };
        var d0 = centre(dn); var tn = a.to ? find(a.to) : null; var d1 = tn ? centre(tn) : { x: d0.x + (a.dx || 0), y: d0.y + (a.dy || 0) };
        cursor(d0.x, d0.y, false); fire(dn, 'pointerdown', d0); fire(dn, 'mousedown', d0);
        for (var k = 1; k <= 8; k++) { var mp = { x: d0.x + (d1.x - d0.x) * k / 8, y: d0.y + (d1.y - d0.y) * k / 8 }; fire(document.elementFromPoint(mp.x, mp.y) || dn, 'pointermove', mp, { buttons: 1 }); fire(document.elementFromPoint(mp.x, mp.y) || dn, 'mousemove', mp, { buttons: 1 }); }
        var up = document.elementFromPoint(d1.x, d1.y) || dn; fire(up, 'pointerup', d1); fire(up, 'mouseup', d1); cursor(d1.x, d1.y, false);
        return { ok: true, at: d1 };
      }
      if (a.action === 'goto') { location.href = a.url; return { ok: true }; }
      return { ok: false, why: 'unknown action ' + a.action };
    } finally { mode = prev; }
  }
  function mark() { changes = { added: 0, removed: 0, attributes: 0, text: 0 }; errors = []; return true; }
  function observe() { return { url: location.pathname + location.search, title: document.title, changes: changes, errors: errors.slice(0, 10) }; }

  window.addEventListener('message', function (e) {
    var d = e.data; if (!d || !d.lainDesign) return;
    parentOrigin = e.origin && e.origin !== 'null' ? e.origin : '*';
    if (d.type === 'mode') { mode = d.mode === 'live' ? 'live' : 'design'; if (d.drawSel === false) drawSel = false; if (mode === 'live' && hov) { place(hov, null); place(sel, null); } }
    else if (d.type === 'select') { overlay(); if (drawSel) place(sel, d.id ? el(d.id) : null); }
    else if (d.type === 'measure') post('measured', { seq: d.seq, nodes: measure(), layout: d.id ? layoutOf(d.id) : null, scroll: { x: window.scrollX, y: window.scrollY }, doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight } });
    else if (d.type === 'act') {
      mark(); var r = act(d.action);
      // A STEP THAT NAVIGATES reports from the next page (the window waits for its 'ready'); others after they settle.
      try { sessionStorage.setItem('__lainActSeq', String(d.seq)); } catch (e2) { /* none */ }
      setTimeout(function () { try { sessionStorage.removeItem('__lainActSeq'); } catch (e3) { /* none */ } post('acted', { seq: d.seq, result: r, observation: observe() }); }, (d.settleMs || 350) + ((r && r.settleExtra) || 0));
    }
    else if (d.type === 'cursor') cursor(d.x, d.y, Boolean(d.click));
  });
  try {
    var es = new EventSource('/__lain/events');
    es.onmessage = function (m) { if (m.data === 'reload') { try { sessionStorage.setItem('__lainScroll', String(window.scrollY)); } catch (e) { /* none */ } location.reload(); } };
  } catch (e) { /* no reload channel */ }
  try { var sy = sessionStorage.getItem('__lainScroll'); if (sy) { sessionStorage.removeItem('__lainScroll'); window.scrollTo(0, Number(sy)); } } catch (e) { /* none */ }

  window.__lainDesign = { measure: measure, layoutOf: layoutOf, act: act, cursor: cursor, mark: mark, observe: observe, setMode: function (m) { mode = m; } };
  var pendingSeq = null; try { pendingSeq = sessionStorage.getItem('__lainActSeq'); sessionStorage.removeItem('__lainActSeq'); } catch (e) { pendingSeq = null; }
  post('ready', { url: location.pathname, title: document.title, actSeq: pendingSeq ? Number(pendingSeq) : null, observation: observe() });
}

/** The runtime as served: an IIFE. */
function source() { return `(${client.toString()})();\n`; }

module.exports = { source };
