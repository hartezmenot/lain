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
    <div class="composer">
      <div class="box"><textarea id="ask" rows="1" placeholder="Ask LAIN…"></textarea></div>
      <div class="tools">
        <button class="pill" id="attachPill" hidden title="Attach files to this conversation">Attach</button>
        <input type="file" id="attachFile" multiple hidden>
        <button class="pill" id="srcPill" title="Where the BOT answers from"><span class="st" id="srcDot"></span><span id="srcName">LAIN</span></button>
        <button class="pill" id="modelPill" title="The model answering here"><b id="modelName">no model</b></button>
        <span class="spacer"></span>
        <span class="hint" id="composerHint"></span>
        <button class="send" id="send">Send</button>
      </div>
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
  function popover(anchor, build, opts) {
    closePop();
    var p = el('div', 'pop' + (opts && opts.cls ? ' ' + opts.cls : ''));
    p.id = 'pop';
    build(p);
    document.body.appendChild(p);
    var r = anchor.getBoundingClientRect();
    var below = r.top < window.innerHeight / 2;
    var left = opts && opts.alignRight ? r.right - p.offsetWidth : r.left;
    p.style.left = Math.max(8, Math.min(left, window.innerWidth - p.offsetWidth - 8)) + 'px';
    p.style.top = (below ? Math.min(r.bottom + 6, window.innerHeight - p.offsetHeight - 8) : Math.max(8, r.top - p.offsetHeight - 6)) + 'px';
    setTimeout(function () { document.addEventListener('mousedown', onAway, true); }, 0);
    return p;
  }
  function onAway(e) { var p = $('pop'); if (p && !p.contains(e.target)) closePop(); }
  function closePop() {
    var p = $('pop');
    if (p) p.remove();
    document.removeEventListener('mousedown', onAway, true);
  }

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
  /** Which thread a surface shows: the IDE shows Coding, Chat shows Chat. */
  function visibleMessages() {
    var all = (S && S.conversation) || [];
    if (!S || S.current.lane === 'cowork') return all;
    var want = ui.mode === 'ide' ? 'coding' : 'chat';
    return all.filter(function (m) { return (m.thread || 'coding') === want; });
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
    var sig = JSON.stringify([ui.mode, S.current.id, msgs.length, msgs.length ? msgs[msgs.length - 1].text.length : 0, S.plans && S.plans.prompt]);
    if (box.dataset.sig === sig && !L.plan.dirty) return;
    box.dataset.sig = sig;
    box.textContent = '';
    if (!msgs.length) {
      var empty = el('div', 'stream-empty');
      var other = ((S.conversation || []).length - msgs.length);
      empty.appendChild(el('div', 'se-title', ui.mode === 'ide' ? 'Ask the BOT about this project, or tell it what to build.' : 'Ask LAIN anything.'));
      empty.appendChild(el('div', 'se-sub', other > 0
        ? other + ' earlier message' + (other === 1 ? ' is' : 's are') + ' in the ' + (ui.mode === 'ide' ? 'Chat' : 'IDE') + ' thread of this session.'
        : (ui.mode === 'ide' ? 'Questions are answered; implementation work is done by the Coding Agent in this project.' : 'Research, planning, discussion, files. When a plan is ready, continue it in the IDE.')));
      box.appendChild(empty);
    }
    msgs.forEach(function (m) {
      var wrap = el('div', 'msg ' + m.role);
      var who = el('div', 'who', m.role === 'user' ? 'You' : 'BOT');
      if (m.provenance) who.appendChild(el('span', 'prov', m.provenance.label));
      if (m.at) who.appendChild(el('span', 'at', timeOf(m.at)));
      wrap.appendChild(who);
      wrap.appendChild(body(m.text));
      box.appendChild(wrap);
    });
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
    // THE SOURCE/MODEL PILLS BELONG TO CHAT. In the IDE the models are set in
    // the BOT panel's own header, and a second pair here would be a second
    // place to change the same thing.
    $('srcPill').hidden = ide;
    $('modelPill').hidden = ide;
    $('composerHint').textContent = ide && c && !c.canSend ? 'open a project to start coding' : '';
  }

  // ---- sending -------------------------------------------------------------
  async function send(textOverride) {
    var t = (textOverride != null ? String(textOverride) : $('ask').value).trim();
    if (!t || ui.busy || !S) return;
    ui.busy = true;
    $('send').disabled = true;
    notice('');
    var bodyOut = { text: t };
    if (S.current.lane === 'engineering') bodyOut.view = ui.mode === 'ide' ? 'coding' : 'chat';
    var r;
    try { r = await api('/api/turn', bodyOut); } catch (e) { r = { ok: false, why: e.message }; }
    ui.busy = false;
    $('send').disabled = false;
    if (!r.ok) {
      if (r.projectRequired) return notice('Open a project in the IDE before coding.', true);
      return notice(r.why, true);
    }
    if (textOverride == null) { $('ask').value = ''; $('ask').style.height = 'auto'; }
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
    $('send').onclick = function () { send(); };
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
    popover: popover, closePop: closePop, dialog: dialog, confirm: confirmBox, toast: toast,
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
