'use strict';

/**
 * THE CLIENT'S CORE — transport, the poll, the render loop, and the one
 * conversation block every surface shows.
 *
 * ------------------------------------------------------------------------
 * IT HOLDS UI STATE AND NOTHING ELSE.
 *
 * Every FACT — sessions, the conversation, changes, models, usage, the
 * workspace — arrives from Core's `/api/state` and is re-rendered from it.
 * `S` is the last read; nothing here keeps a second model of a session.
 *
 * ------------------------------------------------------------------------
 * ONE CONVERSATION, SHOWN WHERE IT IS NEEDED.
 *
 * The BOT is one entity. Its conversation block (#convo: the stream, the cards
 * a turn raises, the composer) exists ONCE in the document and is moved into
 * whichever surface is showing it — the Chat view's centre or the IDE's BOT
 * panel. One textarea, one stream, one set of handlers: there is no second
 * composer that could hold different text or send to a different place.
 *
 * ------------------------------------------------------------------------
 * EMITTED FROM A REAL FUNCTION'S SOURCE (`client.toString()`), like
 * pagecontract.js, so nothing in it needs template-literal escaping.
 */

/** The conversation block. Parked here, mounted by the shell into a surface. */
const HTML = `
<div id="convoPark" hidden>
  <div class="convo" id="convo">
    <div class="convo-head" id="convoHead">
      <div class="ch-title"><span class="proj" id="proj"></span><span class="goal" id="goal"></span></div>
      <span class="spacer"></span>
      <span class="status" id="crumbStatus" hidden><span class="sdot" id="crumbDot"></span><span id="crumbWord"></span></span>
      <button class="btn small" id="crumbStop" hidden>Stop</button>
    </div>
    <div id="handoffCard" class="card handoff" hidden></div>
    <div id="askCard" class="card" hidden></div>
    <div id="computerCard" class="card computer" hidden></div>
    <div id="coworkObjects" class="objects" hidden></div>
    <div id="coworkJobs" hidden></div>
    <div class="stream" id="stream"></div>
    <div id="notice" hidden></div>
    <div class="act" id="act" hidden><span class="dot" id="actDot"></span><span id="actText"></span><span class="clock" id="actClock"></span></div>
    <div class="composer">${require('../chat/composer').HTML}
    </div>
  </div>
</div>`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN = window.LAIN || {};
  var S = null;
  // THE TIMER IS THE FALLBACK: Core wakes the window the moment its state moves (ipc.wake), so this only catches what
  // nothing announced. 4 s, not 1.5 s — every read is a full state build on Core's event loop.
  var ui = { busy: false, pollMs: 4000, mode: 'chat' };
  var renderers = [];
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function fmtElapsed(ms) {
    var t = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(t / 60), s = t % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  /** A model id as a person reads it: the last path segment. */
  function shortModel(id) {
    var s = String(id || '');
    var cut = s.lastIndexOf('/');
    return cut >= 0 ? s.slice(cut + 1) : s;
  }
  function timeOf(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }
  function untilText(ms) {
    if (!ms) return '';
    var d = ms - Date.now();
    if (d <= 0) return 'now';
    var m = Math.round(d / 60000);
    if (m < 60) return 'in ' + m + ' min';
    var h = Math.round(m / 60);
    if (h < 48) return 'in ' + h + ' h';
    return 'in ' + Math.round(h / 24) + ' days';
  }
  var MARK = { RUNNING: '●', WAITING: '◐', DONE: '✓', STOPPED: '!', IDLE: '○' };

  // ---- talking to Core -------------------------------------------------
  //
  // The native host relays a route call over its private pipe to Core
  // (native/host.cs, harnessapp/ipc.js). A few verbs are the HOST's own —
  // the folder picker, the tray tooltip, hiding the window — because they are
  // operating-system presentation, not authority. Everything else is Core.
  var desk = (window.chrome && window.chrome.webview) ? window.chrome.webview : null;
  var waiting = {};
  var seq = 0;
  if (desk) {
    desk.addEventListener('message', function (ev) {
      var m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.wake) { poll(); return; }
      // A CLICKED ASSISTANT NOTIFICATION (native/host.cs Remind): navigation only.
      if (m.nav && typeof m.nav === 'object') { try { if (window.LAIN.nav) window.LAIN.nav.go(m.nav.tab || 'bot', { section: m.nav.section, task: m.nav.task }); } catch (e) { /* the page is still loading */ } return; }
      // THE WINDOW WAS MAXIMISED OR RESTORED (native/host.cs, the page's own title bar): presentation only.
      if (m.win && typeof m.win === 'object') { try { if (window.LAIN.win) window.LAIN.win.update(m.win); if (m.win.min === false && window.LAIN.poll) window.LAIN.poll(); } catch (e) { /* the page is still loading */ } return; }
      if (m.id == null) return;
      var done = waiting[m.id];
      if (!done) return;
      delete waiting[m.id];
      done(m);
    });
  }
  function post(msg, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var timer = setTimeout(function () { delete waiting[id]; reject(new Error('the desktop host did not answer')); }, timeoutMs || 120000);
      waiting[id] = function (m) {
        clearTimeout(timer);
        if (m.error) return reject(new Error(m.error));
        resolve(m.body);
      };
      msg.id = id;
      desk.postMessage(msg);
    });
  }
  async function api(path, body) {
    if (!desk) throw new Error('this page is not running inside LAIN Desktop');
    return post({ method: body === undefined ? 'GET' : 'POST', path: path, body: body || {} });
  }
  /** A verb the native host answers itself. Null when this host predates it. */
  async function hostCall(verb, args) {
    if (!desk) return null;
    try {
      var r = await post(Object.assign({ host: verb }, args || {}), 15 * 60000);
      return r && typeof r === 'object' && r.host === verb ? r : null;
    } catch (e) { return null; }
  }

  /** A short line in the corner, for a surface that has no conversation in it. */
  function toast(text, bad) {
    if (!text) return;
    var box = $('toasts');
    var t = el('div', 'toast' + (bad ? ' bad' : ''), text);
    box.appendChild(t);
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 300); }, bad ? 7000 : 4000);
  }

  function notice(text, bad) {
    var n = $('notice');
    // THE NOTICE LIVES IN THE CONVERSATION. When no conversation is on screen
    // (Home, Model, Settings, the IDE's start screen) it would be invisible,
    // so the same sentence goes to the corner instead.
    if (text && !$('convo').offsetParent) { toast(text, bad); return; }
    if (!text) { n.hidden = true; n.textContent = ''; return; }
    n.hidden = false;
    n.className = 'note' + (bad ? ' bad' : '');
    n.textContent = text;
  }

  // ---- popovers and dialogs --------------------------------------------
  //
  // A STACK, ANCHORED TO LIVE ELEMENTS. A popover used to replace whatever was
  // open before it measured its anchor — so a chooser opened FROM a row inside
  // the ⚙ popover measured a button that had just been removed from the page.
  // A detached element's rectangle is all zeros, and the clamp then put the
  // chooser at (8, 6): the upper-left corner of the window.
  //
  // Now a popover opened from inside another one is a CHILD level: the parent
  // stays, the child sits beside it at the row it came from, and closing the
  // child returns to the parent. Every level keeps its anchor and is re-placed
  // on resize; a level whose anchor has left the page closes rather than
  // guessing a position. The root level keeps the id `pop`.
  var pops = [];         // [{ p, anchor, build, opts, rect }]
  var lastRect = typeof WeakMap === 'function' ? new WeakMap() : null;
  function rectOf(anchor) {
    if (anchor && anchor.isConnected) {
      var r = anchor.getBoundingClientRect();
      if (r.width || r.height) { if (lastRect) lastRect.set(anchor, r); return r; }
    }
    return lastRect && anchor ? lastRect.get(anchor) || null : null;
  }
  function levelHolding(node) {
    for (var i = pops.length - 1; i >= 0; i--) if (pops[i].p.contains(node)) return i;
    return -1;
  }
  /** Where a level goes: beside its parent for a child, above/below its anchor for a root. */
  function place(lv, depth) {
    var p = lv.p, M = 8, G = 6;
    var vw = window.innerWidth, vh = window.innerHeight;
    var r = rectOf(lv.anchor);
    p.style.maxHeight = '';
    if (!r) return false;
    var w = p.offsetWidth, h = p.offsetHeight, left, top;
    if (depth > 0 && pops[depth - 1]) {
      // A CHILD: beside the parent popover, level with the row it came from.
      var pr = pops[depth - 1].p.getBoundingClientRect();
      left = pr.right + G;
      if (left + w > vw - M) left = pr.left - G - w;
      if (left < M) left = Math.max(M, Math.min(pr.left, vw - w - M));
      if (h > vh - 2 * M) { p.style.maxHeight = (vh - 2 * M) + 'px'; h = p.offsetHeight; }
      top = r.top;
      if (top + h > vh - M) top = vh - M - h;
    } else {
      // A ROOT: below the anchor when it fits, above when that has more room.
      var above = r.top - G - M, below = vh - r.bottom - G - M;
      var up = lv.opts.prefer === 'above' ? (h <= above || above >= below) : (h > below && above > below);
      var room = up ? above : below;
      if (h > room) { p.style.maxHeight = Math.max(120, room) + 'px'; h = p.offsetHeight; }
      top = up ? r.top - G - h : r.bottom + G;
      left = lv.opts.alignRight ? r.right - w : r.left;
    }
    p.style.left = Math.max(M, Math.min(left, vw - w - M)) + 'px';
    p.style.top = Math.max(M, Math.min(top, vh - h - M)) + 'px';
    p.dataset.side = depth > 0 ? 'beside' : (top < r.top ? 'above' : 'below');
    return true;
  }
  function popover(anchor, build, opts) {
    opts = opts || {};
    // A TOGGLE: the anchor that opened the root level closes it again.
    if (opts.toggle && pops.length && pops[0].anchor === anchor) { closePop(); return null; }
    // WHICH LEVEL THIS IS. The same anchor again replaces its own level (a
    // picker's "searching…" becoming its results); an anchor inside an open
    // popover opens the next level; anything else starts a new stack.
    var depth = -1;
    for (var i = 0; i < pops.length; i++) if (pops[i].anchor === anchor) depth = i;
    if (depth < 0) { var inside = anchor && anchor.isConnected ? levelHolding(anchor) : -1; depth = inside >= 0 ? inside + 1 : 0; }
    closeFrom(depth);
    var p = el('div', 'pop' + (depth ? ' sub' : '') + (opts.cls ? ' ' + opts.cls : ''));
    p.id = depth ? 'pop-' + depth : 'pop';
    p.setAttribute('role', 'dialog');
    build(p);
    document.body.appendChild(p);
    var lv = { p: p, anchor: anchor, build: build, opts: opts };
    pops.push(lv);
    if (!place(lv, depth)) {
      // NO ANCHOR TO MEASURE — never a corner. Centre it, where it is at least
      // plainly a question, and say so for the tests.
      p.style.left = Math.max(8, (window.innerWidth - p.offsetWidth) / 2) + 'px';
      p.style.top = Math.max(8, (window.innerHeight - p.offsetHeight) / 3) + 'px';
      p.dataset.side = 'unanchored';
    }
    if (anchor && anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
    watch();
    return p;
  }
  function closeFrom(depth) {
    while (pops.length > Math.max(0, depth)) {
      var lv = pops.pop();
      lv.p.remove();
      if (lv.anchor && lv.anchor.setAttribute) lv.anchor.setAttribute('aria-expanded', 'false');
    }
    if (!pops.length) clearInterval(watchTimer);
  }
  // POINTERDOWN, NOT MOUSEDOWN: Monaco cancels the pointer event, and a
  // cancelled pointerdown suppresses the compatibility mousedown — so a click
  // in the editor never reached a mousedown listener and the popover stayed.
  //
  // ONE LISTENER, FOR THE LIFE OF THE WINDOW. It used to be added when a
  // popover opened (deferred a tick, so the opening click did not close it)
  // and removed when the last one closed — and a close/open pair inside one
  // tick could leave it removed while a popover was showing (seen: the ⚙
  // popover stayed open over a click in the editor). Now it is always there
  // and acts only when something is open. A press on the root level's own
  // anchor is left to that anchor's click, which toggles.
  function onAway(e) {
    if (!pops.length) return;
    if (levelHolding(e.target) >= 0) return;
    var a = pops[0].anchor;
    if (a && a.contains && a.contains(e.target)) return;
    closePop();
  }
  window.addEventListener('pointerdown', onAway, true);
  function closePop() { closeFrom(0); }
  /** Close the top level only — a choice made in a child returns to its parent. */
  function popBack(focusAnchor) {
    var lv = pops[pops.length - 1];
    if (!lv) return;
    closeFrom(pops.length - 1);
    if (focusAnchor !== false && lv.anchor && lv.anchor.isConnected && lv.anchor.focus) lv.anchor.focus();
  }
  /** Redraw the levels that asked to follow state (the ⚙ popover after a choice). */
  function popRefresh() {
    pops.forEach(function (lv, i) {
      if (!lv.opts.refresh) return;
      lv.p.textContent = '';
      lv.build(lv.p);
      place(lv, i);
    });
  }
  // ---- SURVIVING A RESIZE, A ZOOM AND A DISPLAY-SCALE CHANGE -------------------
  //
  // An anchor moves for more reasons than a window resize: the display scale
  // changes (dragging the window to another monitor, Windows scaling, WebView
  // zoom), the BOT panel changes width, a layout media query flips. None of
  // those is guaranteed to fire `resize` on the element that matters. So while
  // a popover is open its anchor is WATCHED — its rectangle, the viewport and
  // the device pixel ratio — and every level is re-placed when any of them
  // moves. An anchor the layout has hidden (zero size) closes its level rather
  // than leaving a popover pointing at nothing.
  function replaceAll() {
    for (var i = 0; i < pops.length; i++) {
      var a = pops[i].anchor;
      if (!a || !a.isConnected) { closeFrom(i); return; }
      var r = a.getBoundingClientRect();
      if (!r.width && !r.height) { closeFrom(i); return; }
      place(pops[i], i);
    }
  }
  var watchKey = '', watchTimer = 0;
  function watchSig() {
    var a = pops.length ? pops[0].anchor : null;
    var r = a && a.isConnected ? a.getBoundingClientRect() : null;
    return [window.innerWidth, window.innerHeight, window.devicePixelRatio,
      r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',') : 'x'].join('|');
  }
  function watch() {
    clearInterval(watchTimer);
    if (!pops.length) return;
    watchKey = watchSig();
    watchTimer = setInterval(function () {
      if (!pops.length) { clearInterval(watchTimer); return; }
      var k = watchSig();
      if (k !== watchKey) { watchKey = k; replaceAll(); }
    }, 150);
  }
  window.addEventListener('resize', replaceAll);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', replaceAll);
  // A DPI change: the media query for the CURRENT ratio stops matching.
  (function dpr() {
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)');
    var once = function () { replaceAll(); dpr(); };
    if (mq.addEventListener) mq.addEventListener('change', once, { once: true });
  }());
  // THE KEYBOARD: Escape closes one level and returns focus to what opened it;
  // the arrows move between a popover's choices.
  document.addEventListener('keydown', function (e) {
    if (!pops.length) return;
    var lv = pops[pops.length - 1];
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); popBack(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT' && e.key === 'ArrowUp') return;
    var items = Array.prototype.filter.call(lv.p.querySelectorAll('button:not([disabled])'), function (b) { return b.offsetParent !== null; });
    if (!items.length) return;
    var at = items.indexOf(document.activeElement);
    if (at < 0 && !lv.p.contains(document.activeElement)) return;
    e.preventDefault();
    var next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
    items[next].focus();
  }, true);

  /**
   * AN IN-WINDOW DIALOG. A browser prompt() is a foreign grey box in a native
   * application; this is the same question in LAIN's own surface.
   * fields: [{ key, label, value, placeholder, action: { label, run } }]
   */
  function dialog(o) {
    return new Promise(function (resolve) {
      var back = el('div', 'dlg-back');
      var box = el('div', 'dlg');
      box.setAttribute('role', 'dialog');
      box.appendChild(el('h3', '', o.title || 'LAIN'));
      if (o.text) box.appendChild(el('p', '', o.text));
      // A READ DOOR'S ANSWER (the focus packet, who changed what): text to read, as it came.
      if (o.pre) {
        var pre = el('pre', 'dlg-pre', o.pre);
        pre.style.cssText = 'max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:11.5px;line-height:1.45;background:var(--surface-raised);border:1px solid var(--separator);border-radius:6px;padding:10px;margin:8px 0';
        box.appendChild(pre);
        box.style.width = 'min(860px,92vw)';
      }
      // A DIALOG WITH ITS OWN CONTENT (an account's details): the caller draws into it.
      if (typeof o.build === 'function') {
        var holder = el('div', 'dlg-build');
        holder.style.cssText = 'max-height:64vh;overflow:auto;margin:6px 0 4px';
        try { o.build(holder); } catch (e) { holder.textContent = String(e.message || e); }
        box.appendChild(holder);
        box.style.width = 'min(720px,92vw)';
      }
      var inputs = {};
      (o.fields || []).forEach(function (f) {
        var row = el('label', 'dlg-field');
        row.appendChild(el('span', '', f.label));
        var line = el('div', 'dlg-line');
        // A CHOICE (`type: 'select'`, `options: [[value, label], …]`) — read back as its value, like a text field.
        var inp = document.createElement(f.type === 'select' ? 'select' : 'input');
        if (f.type === 'select') (f.options || []).forEach(function (op) { inp.appendChild(new Option(op[1], op[0])); });
        if (f.type === 'password') { inp.type = 'password'; inp.autocomplete = 'off'; }
        inp.value = f.value || '';
        if (f.type !== 'select') { inp.placeholder = f.placeholder || ''; inp.spellcheck = false; }
        line.appendChild(inp);
        if (f.action) {
          var b = el('button', 'btn small', f.action.label);
          b.type = 'button';
          b.onclick = async function () { var v = await f.action.run(inp.value); if (v) inp.value = v; };
          line.appendChild(b);
        }
        row.appendChild(line);
        box.appendChild(row);
        inputs[f.key] = inp;
      });
      var acts = el('div', 'dlg-actions');
      var cancel = el('button', 'btn', o.cancel || 'Cancel');
      var go = el('button', 'btn ' + (o.danger ? 'danger-fill' : 'primary'), o.ok || 'OK');
      var finish = function (v) { back.remove(); document.removeEventListener('keydown', key, true); if (openFinish === finish) openFinish = null; resolve(v); };
      openFinish = finish;
      var collect = function () {
        if (!o.fields) return true;
        var out = {};
        Object.keys(inputs).forEach(function (k) { out[k] = inputs[k].value; });
        return out;
      };
      var key = function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); finish(o.fields ? null : false); }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); finish(collect()); }
      };
      cancel.onclick = function () { finish(o.fields ? null : false); };
      go.onclick = function () { finish(collect()); };
      if (o.cancel !== null) acts.appendChild(cancel);
      // A THIRD ANSWER (e.g. "Use Eco" beside Continue / Cancel): resolves to its value.
      if (o.extra) { var ex = el('button', 'btn', o.extra.label); ex.onclick = function () { finish(o.extra.value); }; acts.appendChild(ex); }
      acts.appendChild(go);
      box.appendChild(acts);
      back.appendChild(box);
      back.addEventListener('mousedown', function (e) { if (e.target === back) finish(o.fields ? null : false); });
      document.body.appendChild(back);
      document.addEventListener('keydown', key, true);
      setTimeout(function () { var first = box.querySelector('input') || go; first.focus(); if (first.select) first.select(); }, 0);
    });
  }
  var openFinish = null;
  /** Close the dialog that is open (its caller's promise resolves false). */
  function closeDialog() { if (openFinish) openFinish(false); }
  function confirmBox(text, o) { return dialog(Object.assign({ title: 'LAIN', text: text }, o || {})); }

  // ---- sessions: the verbs, once -----------------------------------------
  async function newSession(lane) {
    var r = await api('/api/session/new', { lane: lane || 'engineering', inherit: false });
    if (!r.ok) { notice(r.why, true); return null; }
    notice('');
    await poll();
    return r;
  }
  async function selectSession(id) {
    var r = await api('/api/session/select', { id: id });
    if (!r.ok) { notice(r.why, true); return false; }
    notice('');
    await poll();
    return true;
  }
  async function closeSession(id) {
    var r = await api('/api/session/close', { id: id });
    if (!r.ok) return notice(r.why, true);
    notice(r.stillRunning ? 'Closed the view. That session is still working.' : '');
    await poll();
  }
  async function deleteSession(s) {
    var what = (s.project || 'this conversation') + (s.title ? ' — ' + s.title : '');
    var yes = await confirmBox('Delete ' + what + '? The conversation and its history are removed permanently.', { ok: 'Delete', danger: true });
    if (!yes) return;
    var r = await api('/api/session/delete', { id: s.id });
    if (!r.ok) return notice(r.why, true);
    await poll();
  }
  function allSessions() {
    if (!S || !S.sessions) return [];
    return (S.sessions.engineering || []).map(function (s) { return Object.assign({ lane: 'engineering' }, s); })
      .concat((S.sessions.cowork || []).map(function (s) { return Object.assign({ lane: 'cowork' }, s); }))
      .sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  }

  // ---- the conversation ----------------------------------------------------
  /**
   * WHAT A SURFACE SHOWS. Chat: its own thread, and the Coding Agent's work
   * asked for from Chat (`via: 'chat'`). The IDE: the Coding thread, split
   * between the BOT and AGENT sub-tabs by who the message went to or came from.
   */
  function isAgentMsg(m) { return m.to === 'agent' || m.by === 'agent' || m.by === 'handoff'; }
  /** THE LANE this block shows: 'chat' (Chat lane) or 'coding' (Coding Agent lane — in Chat or the IDE). */
  function lane() { return ui.mode === 'chat' ? 'chat' : 'coding'; }
  function pane() { return null; }
  function visibleMessages() {
    var all = (S && S.conversation) || [];
    if (!S || S.current.lane === 'cowork') return all;
    var want = lane();
    return all.filter(function (m) { return (m.thread || 'coding') === want; });
  }

  /** "This requires code changes. Move to Agent?" — Core's proposal, answered once. */
  function proposalCard(pr) {
    var c = el('div', 'card propose');
    c.id = 'proposeCard';
    c.appendChild(el('p', 'pq', 'This requires code changes. Move to Agent?'));
    c.appendChild(el('p', 'pt', pr.task || pr.text));
    var row = el('div', 'choices');
    var go = el('button', 'btn primary', 'Move to Agent');
    var stay = el('button', 'btn', 'Stay with BOT');
    var answer = async function (accept) {
      go.disabled = stay.disabled = true;
      var r = await api('/api/agent/proposal', { id: pr.id, accept: accept });
      if (!r.ok) { go.disabled = stay.disabled = false; notice(r.why, true); return; }
      if (accept && L.botpane) L.botpane.show('agent');
      poll();
    };
    go.onclick = function () { answer(true); };
    stay.onclick = function () { answer(false); };
    row.appendChild(go);
    row.appendChild(stay);
    c.appendChild(row);
    return c;
  }

  /** Prose with fenced code blocks drawn as code. Text only; never markup. */
  function body(text) {
    var box = el('div', 'body');
    var parts = String(text || '').split('```');
    parts.forEach(function (part, i) {
      if (i % 2 === 0) { if (part) box.appendChild(el('div', 'prose', part.replace(/^\n+|\n+$/g, ''))); return; }
      var nl = part.indexOf('\n');
      var lang = nl > 0 ? part.slice(0, nl).trim() : '';
      var code = nl >= 0 ? part.slice(nl + 1) : part;
      var pre = el('pre', 'code', code.replace(/\n$/, ''));
      if (lang) pre.setAttribute('data-lang', lang);
      box.appendChild(pre);
    });
    return box;
  }

  function renderStream() {
    var box = $('stream');
    var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    var msgs = visibleMessages();
    var pr = S.journey && S.journey.proposal;
    var showPr = pr && ui.mode === 'ide' && pane() === 'bot' ? pr : null;
    var sig = JSON.stringify([ui.mode, S.current.id, msgs.length, msgs.length ? msgs[msgs.length - 1].text.length : 0, S.plans && S.plans.prompt, showPr && showPr.id, S.journey && S.journey.agent && S.journey.agent.running, L.work ? L.work.sig(S) : '']);
    if (box.dataset.sig === sig && !L.plan.dirty) return;
    box.dataset.sig = sig;
    box.textContent = '';
    var sup = L.work ? L.work.items(S, lane()) : [];
    // AN EMPTY LANE centres its greeting and the input together (pagecomposer.js CSS).
    var cv = $('convo'); if (cv) cv.classList.toggle('is-empty', !msgs.length && !sup.length);
    if (!msgs.length && !sup.length) {
      var empty = el('div', 'stream-empty');
      var other = ((S.conversation || []).length - msgs.length);
      var ag = lane() === 'coding';
      if (L.icon) { var ei = el('div', 'se-ic'); ei.appendChild(L.icon(ag ? 'code' : 'chat', 44)); empty.appendChild(ei); }
      empty.appendChild(el('div', 'se-title', ag ? 'Talk to the Coding Agent directly.' : 'How can I help you today?'));
      empty.appendChild(el('div', 'se-sub', ag
        ? '\u201cRename this function.\u201d \u201cRun the tests.\u201d \u201cWhy did you change this?\u201d \u2014 it works in this project. A broad change is offered planning in Chat first.'
        : 'Ask questions, brainstorm, plan features or review work. A plan made here goes to the Coding Agent when you send it.'));
      if (other > 0) empty.appendChild(el('div', 'se-sub', other + ' message' + (other === 1 ? ' is' : 's are') + ' in the other lane of this session.'));
      box.appendChild(empty);
    }
    var supAt = function (x) { return typeof x.at === 'number' ? x.at : Date.parse(x.at || '') || 0; };
    var queue = sup.filter(function (x) { return !x.last; }).sort(function (a, b) { return supAt(a) - supAt(b); });
    var flushUntil = function (t) { while (queue.length && supAt(queue[0]) <= t) queue.shift().nodes.forEach(function (n) { box.appendChild(n); }); };
    var lastAgent = -1; var lastUser = -1; var lastAsst = -1;
    msgs.forEach(function (m, i) { if (m.role === 'assistant' && m.by === 'agent') lastAgent = i; if (m.role === 'user') lastUser = i; else lastAsst = i; });
    var running = Boolean(S.header && S.header.status && /RUNNING|WAITING|QUEUED/.test(String(S.header.status.state || ''))) || Boolean(L.live && L.live.active());
    msgs.forEach(function (m, i) {
      flushUntil(Date.parse(m.at || '') || 0);
      var wrap = el('div', 'msg ' + m.role);
      var chat = lane() === 'chat';
      var name = m.role === 'user' ? (m.by === 'handoff' ? 'Plan \u2192 Coding Agent' : 'You')
        : (chat ? 'LAIN' : 'Coding Agent');
      // THE WHO-LINE: a small mark, the name, the time (the wide layout shows the mark; the sidecar a caps heading).
      var who = el('div', 'who');
      who.appendChild(el('span', 'av'));
      who.appendChild(el('span', 'nm', name));
      if (m.by === 'handoff') wrap.className += ' handoff';
      if (m.by === 'agent') wrap.className += ' agent';
      if (m.provenance) who.appendChild(el('span', 'prov', m.provenance.label));
      if (m.at) who.appendChild(el('span', 'at', timeOf(m.at)));
      wrap.appendChild(who);
      // THE BODY AND ITS ACTIONS (chat/live.js): prose and code blocks; Copy · Edit · Retry · Continue on hover.
      wrap.appendChild(L.live ? L.live.body(m.text) : body(m.text));
      if (L.live) {
        L.live.decorate(wrap, m, { lastUser: i === lastUser, lastAssistant: i === lastAsst && lastAsst > lastUser, running: running });
        if (i === lastAsst && lastAsst > lastUser && !running) L.live.summaryFor(wrap);
      }
      box.appendChild(wrap);
    });
    flushUntil(Infinity);
    sup.filter(function (x) { return x.last; }).forEach(function (x) { x.nodes.forEach(function (n) { box.appendChild(n); }); });
    if (showPr) box.appendChild(proposalCard(showPr));
    var plan = lane() === 'chat' ? L.plan.buildCard(S) : null;
    if (plan) box.appendChild(plan);
    L.plan.dirty = false;
    // THE LIVE TURN goes last — the same node every time; it updates itself from Core's events (chat/live.js).
    if (L.live) L.live.mount(box);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function renderActivity() {
    var h = S.harness, row = $('act');
    // THE LIVE TURN ALREADY SAYS WHAT IS HAPPENING (chat/live.js): one place, never two lines for one fact.
    if (L.live && L.live.active()) { row.hidden = true; return; }
    if (!h || !h.task) { row.hidden = true; return; }
    var a = h.activity || {};
    var state = String(a.state || h.task.state || '');
    if (/^IDLE$/.test(String(a.state || '')) && !/PASSED|FAILED|VERIFYING|BLOCKED/.test(String(h.task.state || ''))) { row.hidden = true; return; }
    row.hidden = false;
    $('actDot').className = 'dot' + (/RUNNING|READING|WRITING|THINKING|EXECUTING|OBSERVING|VERIFYING/.test(state) ? ' run'
      : /PASSED/.test(h.task.state) ? ' ok' : /FAILED|ERROR/.test(state + h.task.state) ? ' bad' : /WAITING|BLOCKED/.test(state) ? ' warn' : '');
    $('actText').textContent = [state.toLowerCase(), a.action, a.target].filter(Boolean).join('  ·  ') || h.task.title || '';
  }

  function renderHead() {
    var cur = S.current;
    var p = S.workspace && S.workspace.project;
    var name = cur.lane === 'cowork' ? 'Conversation' : (p && p.attached ? p.name : (S.header && S.header.title) || 'New conversation');
    $('proj').textContent = name;
    $('proj').className = 'proj' + (cur.projectMissing ? ' gone' : '');
    $('proj').title = cur.projectMissing ? 'This session’s project is no longer at ' + (cur.cwd || 'its recorded path') : (p && p.attached ? p.root : '');
    var sub = cur.projectMissing ? 'its project folder is missing'
      : (cur.lane === 'cowork' && cur.cowork && cur.cowork.source && cur.cowork.source !== 'harness' ? 'from ' + cur.cowork.source
        : (S.header && S.header.title && p && p.attached ? S.header.title : ''));
    $('goal').textContent = sub ? '·  ' + sub : '';
    var h = S.header || {}, st = h.status || {};
    var row = $('crumbStatus');
    if (!st.state || st.state === 'IDLE' || st.state === 'DONE') { row.hidden = true; $('crumbStop').hidden = true; return; }
    row.hidden = false;
    var level = st.state === 'FAILED' ? 'bad' : (st.state === 'WAITING' || st.state === 'QUEUED' || st.state === 'NEEDS_INPUT') ? 'warn' : 'working';
    row.className = 'status ' + level;
    $('crumbDot').textContent = level === 'working' ? '●' : level === 'bad' ? '!' : '◐';
    var bits = [st.state.charAt(0) + st.state.slice(1).toLowerCase().replace(/_/g, ' ')];
    if (typeof st.elapsed === 'number' && st.elapsed > 0) bits.push(fmtElapsed(st.elapsed));
    if (st.summary) bits.push(st.summary);
    $('crumbWord').textContent = bits.join('  ·  ');
    $('crumbStop').hidden = !h.canStop;
  }

  function renderComposer() {
    var eng = S.current.lane === 'engineering';
    var coding = lane() === 'coding';
    var c = eng && S.composer ? S.composer[coding ? 'coding' : 'chat'] : null;
    $('ask').placeholder = coding ? 'Message the Coding Agent\u2026' : (eng ? 'Message LAIN\u2026' : 'Message LAIN, or attach files to work on\u2026');
    $('composerHint').textContent = coding && c && !c.canSend ? 'add a project folder to start coding' : '';
  }

  // ---- sending -------------------------------------------------------------
  async function send(textOverride, extraIn) {
    var t = (textOverride != null ? String(textOverride) : $('ask').value).trim();
    if (!t || ui.busy || !S) return;
    ui.busy = true;
    $('send').disabled = true;
    notice('');
    // SLASH CONTROLS change Core state and never reach a model (remotecontrols.js); other /commands are Core's own.
    if (t.charAt(0) === '/' && t.indexOf('\n') < 0) {
      var cr = null;
      try { cr = await api('/api/controls/run', { text: t }); } catch (e) { cr = null; }
      if (cr && cr.ok) {
        ui.busy = false; $('send').disabled = false;
        var res = cr.result || {};
        if (res.text) toast(res.text.split('\n').slice(0, 6).join('  \u00b7  '), res.ok === false);
        if (res.navigate && L.nav) L.nav.go(res.navigate.tab);
        if (textOverride == null) { $('ask').value = ''; $('ask').style.height = 'auto'; }
        poll();
        return;
      }
    }
    var bodyOut = { text: t };
    if (S.current.lane === 'engineering') bodyOut.view = lane() === 'coding' ? 'coding' : 'chat';
    // WHAT THE INPUT BAR ADDS: in the IDE, that it came from the IDE, the
    // routing mode and which context chips were closed (pagecomposer.js).
    if (L.composer) Object.assign(bodyOut, L.composer.extra(), extraIn || {});
    var r;
    try { r = await api('/api/turn', bodyOut); } catch (e) { r = { ok: false, why: e.message }; }
    ui.busy = false;
    $('send').disabled = false;
    if (!r.ok) {
      if (r.projectRequired) { if (L.work) L.work.projectMenu(null, { reason: r.why }); return; }
      return notice(r.why, true);
    }
    // LAIN ANSWERED ITSELF: a supervised Chat message (the Agent is working) or an offer
    // (plan first?) — both land in the stream from Core state; the text is kept.
    if (r.offer || r.supervised) { if (textOverride == null) { $('ask').value = ''; $('ask').style.height = 'auto'; } poll(); return; }
    if (textOverride == null) { $('ask').value = ''; $('ask').style.height = 'auto'; }
    if (L.composer) L.composer.afterSend();
    poll();
  }

  // ---- the frame -------------------------------------------------------------
  function render() {
    if (!S) return;
    renderHead();
    renderStream();
    renderActivity();
    renderComposer();
    for (var i = 0; i < renderers.length; i++) {
      try { renderers[i](S, ui); } catch (e) { if (window.console) console.error('render', e); }
    }
  }

  // ONE READ IN FLIGHT (2026-10-01): a burst of wakes (a streaming turn) used to start a full /api/state per wake, all
  // overlapping on Core's event loop. Now a poll asked for while one is running becomes ONE trailing read.
  var polling = null; var pollAgain = false; var firstState = false;
  // STARTUP MARKS (perf83 reads them): boot → shown → first-state, on the page's own clock.
  function mark(n) { try { performance.mark(n); } catch (e) { /* no timeline */ } }
  async function poll() {
    if (polling) { pollAgain = true; return polling; }
    polling = (async function () {
      do {
        pollAgain = false;
        try {
          var r = await api('/api/state');
          if (r && r.ok) { S = r.state; render(); if (!firstState) { firstState = true; mark('lain:first-state'); } }
        } catch (e) { /* Core restarting; the next poll is the reconnect */ }
      } while (pollAgain);
    })();
    try { await polling; } finally { polling = null; }
  }

  /** Put the conversation block into a surface, and say which thread it shows. */
  function mountConvo(host, mode) {
    var c = $('convo');
    if (!host) { $('convoPark').appendChild(c); return; }
    if (c.parentNode !== host) host.appendChild(c);
    if (ui.mode !== mode) { ui.mode = mode; $('stream').dataset.sig = ''; if (S) render(); }
  }

  function boot() {
    mark('lain:boot');
    // THE BOX GROWS WITH WHAT IS TYPED, then scrolls: ~200 px in Chat, ~120 px in the IDE sidecar.
    $('ask').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.closest('.bp-convo') ? 120 : 200, this.scrollHeight) + 'px';
    });
    $('ask').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $('crumbStop').onclick = async function () {
      $('crumbStop').disabled = true;
      var r = await api('/api/interrupt', {});
      $('crumbStop').disabled = false;
      if (r && !r.ok) notice(r.why, true);
      poll();
    };
    try { sessionStorage.removeItem('lain.session'); } catch (e) { /* storage unavailable */ }
    var deps = { api: api, notice: notice, poll: poll, render: render, ui: ui };
    L.boots.forEach(function (b) { try { b(deps); } catch (e) { if (window.console) console.error('boot', e); } });
    $('app').hidden = false;
    mark('lain:shown');
    poll();
    // IDLE COST (Gate 3 §93): the snapshot is read every 1.5 s while the window is seen, every 15 s while it is
    // hidden (the tray, minimised) — Core notifies natively meanwhile — and at once when it comes back.
    var lastPoll = Date.now();
    setInterval(function () {
      var minimised = Boolean(L.win && typeof L.win.state === 'function' && L.win.state().min);
      var gap = document.hidden || minimised ? 15000 : ui.pollMs;
      if (Date.now() - lastPoll < gap - 50) return;
      lastPoll = Date.now();
      poll();
    }, ui.pollMs);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { lastPoll = Date.now(); poll(); } });
  }

  Object.assign(L, {
    boots: L.boots || [],
    boot: boot,
    api: function () { return api.apply(null, arguments); },
    hostCall: hostCall,
    state: function () { return S; },
    ui: function () { return ui; },
    poll: poll, render: render, notice: notice, el: el, $: $,
    popover: popover, closePop: closePop, popBack: popBack, popRefresh: popRefresh, popDepth: function () { return pops.length; }, dialog: dialog, closeDialog: closeDialog, confirm: confirmBox, toast: toast,
    onRender: function (fn) { renderers.push(fn); },
    onBoot: function (fn) { L.boots.push(fn); },
    send: send, mountConvo: mountConvo,
    sessions: { create: newSession, select: selectSession, close: closeSession, remove: deleteSession, all: allSessions, MARK: MARK },
    fmt: { elapsed: fmtElapsed, model: shortModel, time: timeOf, until: untilText },
  });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, js, client };
