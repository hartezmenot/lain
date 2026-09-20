'use strict';

/**
 * THE COWORK / BOT LANE, AND THE LANE-AWARE WORK AREA.
 *
 * ------------------------------------------------------------------------
 * A FRONTEND OVER ASTRA'S CONTRACT, NOTHING MORE.
 *
 * Everything drawn here is `state.cowork` (cowork/runtime.js `project`): the
 * staged inputs, the current task and activity, a pending approval, background
 * jobs, the owned artifacts, the finished summary. Every action is one of the
 * existing `/api/cowork/*` routes. No Cowork behaviour lives in the page — what
 * a file transform does, who may read an artifact, which messaging source a
 * session came from — all of that is the backend's.
 *
 * OBJECT-ORIENTED, because Cowork work is about THINGS: a spreadsheet to clean,
 * an image to cut out, an email to answer. The resting surface is the objects
 * (what went in, what came out) above the same conversation and composer the
 * Chat/Coding lane uses — not a second chat.
 *
 * ------------------------------------------------------------------------
 * SESSIONS ARE SWITCHED HERE, through the same `App.adopt` the terminal uses
 * (`/api/session/resume`, `/api/session/new`), and a question a window-started
 * turn asks is answered here (`/api/ask/answer`). See sessionroutes.js.
 *
 * NO BACKTICKS in the emitted script: it is one template literal.
 */

const CSS = `
/* THE WORK COLUMN FLOWS: cards and object rows appear above the stream as they
   are needed, so a fixed grid of rows would hand the stretch to whichever card
   happened to be second. The stream is the one thing that grows. */
section.work{display:flex;flex-direction:column;min-height:0}
section.work .stream{flex:1;min-height:0}
.lane-empty{display:grid;place-items:center;flex:1;min-height:0;padding:40px}
.lane-empty .in{max-width:420px;text-align:left}
.lane-empty h2{font:600 15px/1.3 var(--sans);margin:0 0 8px}
.lane-empty p{color:var(--dim);margin:0 0 16px}
.objects{display:flex;flex-wrap:wrap;gap:8px;padding:10px 22px 0}
.obj{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:var(--radius);background:var(--surface);max-width:320px}
.obj .k{color:var(--faint);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.obj .n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.obj img{width:36px;height:36px;object-fit:cover;border-radius:4px}
.obj button{color:var(--accent);font-size:12px}
/* A CARD, NOT A COLOURED FLAG. The old left border read the whole objects lane
   as a warning strip even for an ordinary approval question; a plain surface
   with a small status dot in the heading carries the same information without
   painting every card amber. */
.card{margin:10px 22px 0;padding:12px 14px;border-radius:var(--radius);background:var(--surface)}
.card h4{margin:0 0 4px;font:600 13px/1.3 var(--sans);display:flex;align-items:center;gap:7px}
.card h4::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--warn);flex:none}
.card p{margin:0 0 10px;color:var(--dim);white-space:pre-wrap}
.card .choices{display:flex;gap:8px;flex-wrap:wrap}
.btn.primary{background:var(--accent);color:#0a1620}
.job{display:flex;gap:10px;align-items:center;padding:4px 22px;color:var(--dim);font-size:13px}
.job b{color:var(--ink);font-weight:500}
.aside-new{float:right;color:var(--accent);font-size:12px;letter-spacing:0;text-transform:none}
.pill{white-space:nowrap}
main.lane-mismatch .stream,main.lane-mismatch .composer,main.lane-mismatch .drawers,
main.lane-mismatch .drawer,main.lane-mismatch .act,main.lane-mismatch .objects{display:none!important}
/* ---- the computer, while LAIN is using it ---------------------------- */
/* Its own status dot is drawn in .head (colour reflects authorized/not) - the
   generic .card h4 dot would double up on it, so it is switched off here. */
.card.computer h4::before{content:none}
.card.computer .head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.card.computer .steps{margin:0 0 10px;color:var(--dim);font-size:13px}
.card.computer .steps div{display:flex;gap:8px}
.card.computer .steps .m{width:12px;color:var(--faint)}
.card.computer .steps .PASSED .m{color:var(--ok)}
.card.computer .steps .FAILED .m{color:var(--bad)}
.card.computer img{max-width:100%;border-radius:var(--radius);margin-bottom:10px}
`;

/** Placed inside section.work, above the stream. */
const HTML = `
      <div class="lane-empty" id="laneEmpty" hidden>
        <div class="in">
          <h2 id="laneEmptyTitle"></h2>
          <p id="laneEmptyText"></p>
          <button class="btn primary" id="laneEmptyGo"></button>
        </div>
      </div>
      <div id="askCard" class="card" hidden></div>
      <div id="computerCard" class="card computer" hidden></div>
      <div id="coworkObjects" class="objects" hidden></div>
      <div id="coworkJobs" hidden></div>
`;

function js() {
  return `
LAIN.cowork = (function () {
  'use strict';
  var api, notice, poll, uiOf;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  var previews = {};
  var W = { shot: null };   // the last frame the person asked for

  async function newSession(lane) {
    var r = await api('/api/session/new', { lane: lane });
    if (!r.ok) return notice(r.why, true);
    notice('');
    await poll();
  }

  async function resume(id) {
    var r = await api('/api/session/select', { id: id });
    if (!r.ok) return notice(r.why, true);
    notice('');
    await poll();
  }

  // CLOSE THE VIEW. The conversation is kept and anything running in it keeps
  // running — see sessionroutes.js. Deleting is a different, explicit route.
  async function closeSession(id) {
    var r = await api('/api/session/close', { id: id });
    if (!r.ok) return notice(r.why, true);
    notice(r.stillRunning ? 'Closed the view. That session is still working.' : '');
    await poll();
  }

  async function answer(q, value) {
    var r = await api('/api/ask/answer', { id: q.id, answer: value });
    if (!r.ok) notice(r.why, true);
    await poll();
  }

  function renderAsk(S) {
    var card = $('askCard');
    var q = S.ask;
    if (!q) { card.hidden = true; card.textContent = ''; return; }
    if (card.dataset.id === q.id && !card.hidden) return;
    card.dataset.id = q.id;
    card.textContent = '';
    card.hidden = false;
    card.appendChild(el('h4', '', q.title));
    if (q.question) card.appendChild(el('p', '', q.question));
    var row = el('div', 'choices');
    (q.options.length ? q.options : ['OK']).forEach(function (o, i) {
      var b = el('button', 'btn' + (i === 0 ? ' primary' : ''), o);
      b.onclick = function () { answer(q, q.options.length ? o : null); };
      row.appendChild(b);
    });
    card.appendChild(row);
  }

  async function preview(ref, img) {
    if (previews[ref]) { img.src = previews[ref]; return; }
    var r = await api('/api/cowork/artifact', { ref: ref });
    if (!r.ok) return;
    var a = r.artifact;
    previews[ref] = 'data:' + a.mime + ';base64,' + a.data;
    img.src = previews[ref];
  }

  async function download(ref) {
    var r = await api('/api/cowork/artifact', { ref: ref });
    if (!r.ok) return notice(r.why, true);
    var a = r.artifact;
    var bin = atob(a.data), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([bytes], { type: a.mime }));
    var link = document.createElement('a');
    link.href = url; link.download = a.name; document.body.appendChild(link); link.click();
    setTimeout(function () { URL.revokeObjectURL(url); link.remove(); }, 1000);
  }

  function objectChip(kind, item, isArtifact) {
    var c = el('div', 'obj');
    if (isArtifact && /^image\\//.test(item.mime || '')) {
      var img = document.createElement('img');
      img.alt = item.name;
      c.appendChild(img);
      preview(item.ref, img);
    }
    c.appendChild(el('span', 'k', kind));
    c.appendChild(el('span', 'n', item.name));
    if (isArtifact) {
      var d = el('button', '', 'Save');
      d.onclick = function () { download(item.ref); };
      c.appendChild(d);
    }
    c.title = item.name + (item.bytes ? '  ·  ' + Math.max(1, Math.round(item.bytes / 1024)) + ' KB' : '');
    return c;
  }

  function renderObjects(S) {
    var box = $('coworkObjects');
    var jobsBox = $('coworkJobs');
    var cw = S.cowork || {};
    box.textContent = ''; jobsBox.textContent = '';
    if (!cw.active) { box.hidden = true; jobsBox.hidden = true; return; }
    (cw.attachments || []).forEach(function (a) { box.appendChild(objectChip('input', a, false)); });
    (cw.artifacts || []).forEach(function (a) { box.appendChild(objectChip('result', a, true)); });
    box.hidden = !box.childNodes.length;
    (cw.jobs || []).filter(function (j) { return !j.primary && j.state && !/DONE|COMPLETED|CANCELLED|FAILED/.test(j.state); }).forEach(function (j) {
      var r = el('div', 'job');
      r.appendChild(el('b', '', j.label || 'background task'));
      r.appendChild(el('span', '', (j.activity || j.state || '').toLowerCase()));
      if (j.needsInput) {
        var a = el('button', 'btn', 'Answer');
        a.onclick = async function () {
          var text = window.prompt(j.label || 'Answer');
          if (text == null) return;
          var res = await api('/api/cowork/answer', { id: j.id, answer: text });
          if (!res.ok) notice(res.why, true);
          poll();
        };
        r.appendChild(a);
      }
      var x = el('button', 'btn', 'Stop');
      x.onclick = async function () { await api('/api/cowork/cancel', { id: j.id }); poll(); };
      r.appendChild(x);
      jobsBox.appendChild(r);
    });
    jobsBox.hidden = !jobsBox.childNodes.length;
  }

  /**
   * WHICH WORK AREA THE LANE SHOWS. The conversation belongs to the CURRENT
   * session; when the lane being looked at is not that session's lane, the work
   * area says so and offers the one action that makes sense, instead of showing
   * an engineering conversation under a Cowork heading.
   */
  function renderLane(S, ui) {
    var cur = S.current.lane;
    var mismatch = ui.lane !== cur;
    var empty = $('laneEmpty');
    // ONE SWITCH, ONE PLACE: the stream and the composer belong to the CURRENT
    // session, so on the other lane they are withheld — a prompt typed there
    // would silently land in a session of the wrong kind. Toggled on a class
    // rather than on each element's hidden flag, which their own renderers own.
    $('main').classList.toggle('lane-mismatch', mismatch);
    if (!mismatch) { empty.hidden = true; return; }
    empty.hidden = false;
    var co = ui.lane === 'cowork';
    $('laneEmptyTitle').textContent = co ? 'Cowork' : 'Chat / Coding';
    $('laneEmptyText').textContent = co
      ? 'Work on things — a spreadsheet to clean, an image to edit, an email to answer. Start a Cowork session, attach what you want worked on, and ask.'
      : 'An engineering session on this project: questions, code changes, verification. Start one, or open one from the list.';
    var go = $('laneEmptyGo');
    go.textContent = co ? 'New Cowork session' : 'New engineering session';
    go.onclick = function () { newSession(ui.lane); };
  }

  /**
   * THE COMPUTER, WHILE LAIN IS USING IT.
   *
   * What it is doing and what it has done, with two things a person may want:
   * SEE it, and STOP it. No reasoning, no coordinates, no live video — a frame
   * when it is asked for.
   */
  function renderComputer(S) {
    var card = $('computerCard');
    var c = S.computer;
    if (!c || !c.connected) { card.hidden = true; card.textContent = ''; W.shot = null; return; }
    var sig = JSON.stringify([c.authorized, c.steps, Boolean(W.shot)]);
    if (card.dataset.sig === sig) return;
    card.dataset.sig = sig;
    card.hidden = false;
    card.textContent = '';
    var head = el('div', 'head');
    head.appendChild(el('span', 'dot' + (c.authorized ? ' run' : ''), ''));
    head.appendChild(el('h4', '', 'Computer'));
    head.appendChild(el('span', 'hint', c.authorized ? (c.target || 'this machine') : 'not authorized'));
    card.appendChild(head);
    if (W.shot) { var img = document.createElement('img'); img.src = W.shot; card.appendChild(img); }
    var steps = el('div', 'steps');
    (c.steps || []).slice(-5).forEach(function (s) {
      var row = el('div', s.verdict || '');
      row.appendChild(el('span', 'm', s.verdict === 'PASSED' ? '\\u2713' : s.verdict === 'FAILED' ? '\\u2717' : '\\u25cb'));
      row.appendChild(el('span', '', s.text));
      steps.appendChild(row);
    });
    card.appendChild(steps);
    var row2 = el('div', 'choices');
    var view = el('button', 'btn', W.shot ? 'Refresh view' : 'View computer');
    view.onclick = async function () {
      var r = await api('/api/computer/view', {});
      if (!r.ok) return notice(r.why, true);
      W.shot = r.image;
      card.dataset.sig = '';
      poll();
    };
    var stop = el('button', 'btn', 'Stop');
    stop.onclick = async function () {
      var r = await api('/api/computer/stop', {});
      if (!r.ok) return notice(r.why, true);
      W.shot = null;
      notice('The computer is disconnected and the authorization is gone.');
      poll();
    };
    row2.appendChild(view);
    row2.appendChild(stop);
    card.appendChild(row2);
  }

  function render(S, ui) {
    renderLane(S, ui);
    renderAsk(S);
    renderComputer(S);
    renderObjects(S);
    var attach = $('attachPill');
    if (attach) attach.hidden = !(S.cowork && S.cowork.active && ui.lane === 'cowork');
  }

  function stage(file) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = async function () {
        var data = String(fr.result).split(',')[1] || '';
        var r = await api('/api/cowork/attachment', { name: file.name, mime: file.type, data: data });
        if (!r.ok) notice(r.why, true);
        resolve(r);
      };
      fr.readAsDataURL(file);
    });
  }

  function boot(apiFn, noticeFn, pollFn, uiFn) {
    api = apiFn; notice = noticeFn; poll = pollFn; uiOf = uiFn;
    var attach = $('attachPill'), picker = $('attachFile');
    if (attach && picker) {
      attach.onclick = function () { picker.click(); };
      picker.onchange = async function () {
        for (var i = 0; i < picker.files.length; i++) await stage(picker.files[i]);
        picker.value = '';
        poll();
      };
    }
  }

  // PERMANENT, AND ONLY EVER FROM AN EXPLICIT DELETE CONTROL THAT ASKED FIRST.
  // The server refuses a session with a turn running and refuses the terminal's
  // own — see sessionroutes.js.
  async function deleteSession(id) {
    var r = await api('/api/session/delete', { id: id });
    if (!r.ok) return notice(r.why, true);
    notice('Deleted.');
    await poll();
  }

  return { boot: boot, render: render, resume: resume, newSession: newSession, closeSession: closeSession, deleteSession: deleteSession };
})();
`;
}

module.exports = { CSS, HTML, js };
