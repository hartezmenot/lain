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
    <div class="composer">${require('./pagecomposer').HTML}
    </div>
  </div>
</div>`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN = window.LAIN || {};
  var S = null;
  var ui = { busy: false, pollMs: 1500, mode: 'chat' };
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
        pre.style.cssText = 'max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:11.5px;line-height:1.45;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:10px;margin:8px 0';
        box.appendChild(pre);
        box.style.width = 'min(860px,92vw)';
      }
      var inputs = {};
      (o.fields || []).forEach(function (f) {
        var row = el('label', 'dlg-field');
        row.appendChild(el('span', '', f.label));
        var line = el('div', 'dlg-line');
        var inp = document.createElement('input');
        inp.value = f.value || '';
        inp.placeholder = f.placeholder || '';
        inp.spellcheck = false;
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
      var finish = function (v) { back.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
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
      acts.appendChild(cancel);
      acts.appendChild(go);
      box.appendChild(acts);
      back.appendChild(box);
      back.addEventListener('mousedown', function (e) { if (e.target === back) finish(o.fields ? null : false); });
      document.body.appendChild(back);
      document.addEventListener('keydown', key, true);
      setTimeout(function () { var first = box.querySelector('input') || go; first.focus(); if (first.select) first.select(); }, 0);
    });
  }
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
  function pane() { return ui.mode === 'ide' && L.botpane ? (L.botpane.current() || 'bot') : null; }
  function visibleMessages() {
    var all = (S && S.conversation) || [];
    if (!S || S.current.lane === 'cowork') return all;
    if (ui.mode !== 'ide') return all.filter(function (m) { return (m.thread || 'coding') === 'chat' || (m.via === 'chat' && isAgentMsg(m)); });
    var p = pane();
    return all.filter(function (m) { return (m.thread || 'coding') === 'coding' && (p === 'agent' ? isAgentMsg(m) : !isAgentMsg(m)); });
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
    var sig = JSON.stringify([ui.mode, pane(), S.current.id, msgs.length, msgs.length ? msgs[msgs.length - 1].text.length : 0, S.plans && S.plans.prompt, showPr && showPr.id, S.journey && S.journey.agent && S.journey.agent.running]);
    if (box.dataset.sig === sig && !L.plan.dirty) return;
    box.dataset.sig = sig;
    box.textContent = '';
    if (!msgs.length) {
      var empty = el('div', 'stream-empty');
      var other = ((S.conversation || []).length - msgs.length);
      var ag = pane() === 'agent';
      empty.appendChild(el('div', 'se-title', ag ? 'The Coding Agent carries out changes here.' : ui.mode === 'ide' ? 'Ask the BOT about this project, or tell it what to build.' : 'Ask LAIN anything.'));
      empty.appendChild(el('div', 'se-sub', other > 0
        ? other + ' earlier message' + (other === 1 ? ' is' : 's are') + ' in the ' + (ui.mode === 'ide' ? 'Chat' : 'IDE') + ' thread of this session.'
        : (ag ? 'Describe the change and press \u25b6 \u2014 it edits, runs and tests in this project. The BOT tab stays available.' : ui.mode === 'ide' ? 'Questions are answered here; for code changes the BOT asks before moving the work to the Agent.' : 'Research, planning, discussion. Asking for a code change here runs the Coding Agent on the attached project.')));
      box.appendChild(empty);
    }
    var lastAgent = -1;
    msgs.forEach(function (m, i) { if (m.role === 'assistant' && m.by === 'agent') lastAgent = i; });
    msgs.forEach(function (m, i) {
      var wrap = el('div', 'msg ' + m.role);
      var chat = ui.mode !== 'ide';
      var name = m.role === 'user' ? (m.by === 'handoff' ? 'BOT \u2192 Coding Agent' : 'You')
        : m.by === 'agent' ? 'Coding Agent' : (chat ? 'LAIN' : 'BOT');
      var who = el('div', 'who', name);
      if (m.by === 'handoff') wrap.className += ' handoff';
      if (m.by === 'agent') wrap.className += ' agent';
      if (m.provenance) who.appendChild(el('span', 'prov', m.provenance.label));
      if (m.at) who.appendChild(el('span', 'at', timeOf(m.at)));
      wrap.appendChild(who);
      wrap.appendChild(body(m.text));
      // CHAT CODED: the same task continues in the IDE, not a copy of it.
      if (chat && i === lastAgent) {
        var fo = el('button', 'btn small focuslink', 'Open in /focus \u2192');
        fo.title = 'Continue this task in the IDE: its project, the AGENT tab and the files it changed';
        // THROUGH CORE'S DOOR (house.js ide.enter_focus): the move is recorded as a transfer, then the window follows.
        fo.onclick = function () { api('/api/house/run', { id: 'ide.enter_focus' }).then(function () { poll(); }, function () { L.focus.enter({}); }); };
        wrap.appendChild(fo);
      }
      box.appendChild(wrap);
    });
    if (showPr) box.appendChild(proposalCard(showPr));
    var plan = ui.mode === 'chat' ? L.plan.buildCard(S) : null;
    if (plan) box.appendChild(plan);
    L.plan.dirty = false;
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function renderActivity() {
    var h = S.harness, row = $('act');
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
    var ide = ui.mode === 'ide';
    var c = eng && S.composer ? S.composer[ide ? 'coding' : 'chat'] : null;
    $('ask').placeholder = ide ? ((c && c.placeholder) || 'Ask the BOT, or describe the change…') : (eng ? 'Ask, discuss or plan…' : 'Ask LAIN, or attach files to work on…');
    $('composerHint').textContent = ide && c && !c.canSend ? 'open a project to start coding' : '';
  }

  // ---- sending -------------------------------------------------------------
  async function send(textOverride, extraIn) {
    var t = (textOverride != null ? String(textOverride) : $('ask').value).trim();
    if (!t || ui.busy || !S) return;
    ui.busy = true;
    $('send').disabled = true;
    notice('');
    var bodyOut = { text: t };
    if (S.current.lane === 'engineering') bodyOut.view = ui.mode === 'ide' ? 'coding' : 'chat';
    // WHAT THE INPUT BAR ADDS: in the IDE, that it came from the IDE, the
    // routing mode and which context chips were closed (pagecomposer.js).
    if (L.composer) Object.assign(bodyOut, L.composer.extra(), extraIn || {});
    var r;
    try { r = await api('/api/turn', bodyOut); } catch (e) { r = { ok: false, why: e.message }; }
    ui.busy = false;
    $('send').disabled = false;
    if (!r.ok) {
      if (r.projectRequired) return notice('Open a project in the IDE before coding.', true);
      return notice(r.why, true);
    }
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

  async function poll() {
    try {
      var r = await api('/api/state');
      if (r && r.ok) { S = r.state; render(); }
    } catch (e) { /* Core restarting; the next poll is the reconnect */ }
  }

  /** Put the conversation block into a surface, and say which thread it shows. */
  function mountConvo(host, mode) {
    var c = $('convo');
    if (!host) { $('convoPark').appendChild(c); return; }
    if (c.parentNode !== host) host.appendChild(c);
    if (ui.mode !== mode) { ui.mode = mode; $('stream').dataset.sig = ''; if (S) render(); }
  }

  function boot() {
    $('ask').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(200, this.scrollHeight) + 'px';
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
    poll();
    setInterval(poll, ui.pollMs);
  }

  Object.assign(L, {
    boots: L.boots || [],
    boot: boot,
    api: function () { return api.apply(null, arguments); },
    hostCall: hostCall,
    state: function () { return S; },
    ui: function () { return ui; },
    poll: poll, render: render, notice: notice, el: el, $: $,
    popover: popover, closePop: closePop, popBack: popBack, popRefresh: popRefresh, popDepth: function () { return pops.length; }, dialog: dialog, confirm: confirmBox, toast: toast,
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
