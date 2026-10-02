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
.objects{display:flex;flex-wrap:wrap;gap:8px;padding:10px 22px 0}
.obj{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:var(--radius-sm);background:var(--surface-raised);border:1px solid var(--separator);max-width:320px}
.obj .k{color:var(--text-muted);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase}
.obj .n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.obj img{width:36px;height:36px;object-fit:cover;border-radius:4px}
.obj button{color:var(--accent-primary);font-size:12px}
.card{margin:10px 22px 0;padding:12px 14px;border-radius:var(--radius-sm);background:var(--surface-raised);border:1px solid var(--separator)}
.card h4{margin:0 0 4px;font:600 13px/1.3 var(--sans);display:flex;align-items:center;gap:7px}
.card h4::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--warning);flex:none}
.card p{margin:0 0 10px;color:var(--text-secondary);white-space:pre-wrap}
.card .choices{display:flex;gap:8px;flex-wrap:wrap}
.job{display:flex;gap:10px;align-items:center;padding:4px 22px;color:var(--text-secondary);font-size:13px}
.job b{color:var(--text-primary);font-weight:500}
.card.computer h4::before{content:none}
.card.computer .head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.card.computer .steps{margin:0 0 10px;color:var(--text-secondary);font-size:13px}
.card.computer .steps div{display:flex;gap:8px}
.card.computer .steps .m{width:12px;color:var(--text-muted)}
.card.computer .steps .PASSED .m{color:var(--positive)}
.card.computer .steps .FAILED .m{color:var(--danger)}
.card.computer img{max-width:100%;border-radius:var(--radius-sm);margin-bottom:10px}
`;

/** The cards and object rows live in the conversation block (pagescript.js). */
const HTML = '';

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
    // A PLAN TO BUILD (Core's exit_plan): the plan as an editable document; Build saves the edits and approves.
    if (q.plan) {
      var doc = document.createElement('textarea'); doc.className = 'plandoc'; doc.value = q.plan.text || ''; doc.spellcheck = false;
      card.appendChild(doc);
      var prow = el('div', 'choices');
      var build = el('button', 'btn primary', 'Build');
      build.onclick = async function () { var r = await api('/api/ask/answer', { id: q.id, answer: 'Approve', text: doc.value }); if (!r.ok) notice(r.why, true); await poll(); };
      var keep = el('button', 'btn', 'Keep planning');
      keep.onclick = function () { answer(q, 'Keep planning'); };
      prow.appendChild(build); prow.appendChild(keep);
      card.appendChild(prow);
      return;
    }
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

  /** An engineering conversation with nothing in it yet can become a file-work one. */
  function bindable(S) {
    return S.current.lane === 'engineering' && !(S.conversation || []).length && !(S.workspace && S.workspace.project && S.workspace.project.attached);
  }

  function render(S, ui) {
    renderAsk(S);
    renderComputer(S);
    renderObjects(S);
    // ATTACH IS FOR CHAT'S FILE WORK. It shows on a Cowork conversation, and on
    // an empty chat — where the first attachment binds it to Cowork through
    // Core's own route, so nobody has to choose a "lane" before starting.
    var attach = $('attachPill');
    if (attach) attach.hidden = !(ui.mode === 'chat' && ((S.cowork && S.cowork.active) || bindable(S)));
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
      attach.onclick = async function () {
        var S = LAIN.state();
        if (S && S.current.lane === 'engineering') {
          var r = await api('/api/cowork/bind', {});
          if (!r.ok) return notice(r.why, true);
          await poll();
        }
        picker.click();
      };
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
