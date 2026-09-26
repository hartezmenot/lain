'use strict';

/**
 * THE INPUT BAR — where the controls for a message live.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ [main.ts] [3 lines selected] [2 problems]     │  ← what the BOT will see
 *   │ Ask BOT about this project…                   │
 *   │ +   @                               ⚙    ↵    │
 *   └──────────────────────────────────────────────┘
 *
 * ------------------------------------------------------------------------
 * CONTEXT IS IMPLICIT, AND INSPECTABLE. In the IDE the BOT already receives
 * the file in front, the selection, the problems and the terminal (Core's
 * idecontext.js). The chips SAY so, and closing one takes that part out of the
 * next message — sent as `context:{…:false}`, honoured by Core. `@file` pins a
 * project file through Core's own pins (sessionviews.js), so a reference is
 * the same object the rest of LAIN already knows.
 *
 * ------------------------------------------------------------------------
 * THE ACTION BUTTON SAYS WHAT PRESSING IT WILL DO, derived from Core state
 * and the sub-tab in front:
 *
 *   BOT tab / Chat   send        ↵   a message will be sent
 *   AGENT tab        start       ▶   the Agent starts on what is typed
 *                    continue    ▶   the Agent resumes the task it carries
 *   any              processing  ◌■  LAIN is working — the square is the stop,
 *                                    always drawn, so it never reads as "loading"
 *
 * Nothing else: play never means "loading", and send never means "resume".
 *
 * ------------------------------------------------------------------------
 * THE MODELS LIVE BEHIND ⚙. BOT model, Coding Agent model, routing mode and
 * project context — the pickers are pagemodels.js's, the owners are Core's.
 */

const HTML = `
      <div class="box">
        <div class="chips" id="ctxChips"></div>
        <textarea id="ask" rows="1" placeholder="Ask LAIN…"></textarea>
        <div class="cbar">
          <button class="cbtn" id="addBtn" title="Add files or context" aria-label="Add"></button>
          <button class="cbtn at" id="atBtn" title="Reference context (@)" aria-label="Reference context">@</button>
          <button class="pill" id="attachPill" hidden>Attach</button>
          <input type="file" id="attachFile" multiple hidden>
          <span class="spacer"></span>
          <span class="hint" id="composerHint"></span>
          <button class="cbtn" id="gearBtn" title="BOT settings" aria-label="BOT settings"></button>
          <button class="send act-send" id="send" data-state="send" aria-label="Send"></button>
        </div>
      </div>`;

const CSS = `
.composer .box{padding:8px 10px 6px}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 6px}
.chips:empty{display:none}
.chip{display:inline-flex;align-items:center;gap:5px;max-width:220px;padding:1px 4px 1px 7px;border-radius:4px;background:var(--raise);border:1px solid var(--line2);font-size:11.5px;color:var(--dim)}
.chip .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip .x{width:16px;height:16px;border-radius:3px;color:var(--faint);font-size:12px;line-height:1}
.chip .x:hover{color:var(--ink);background:var(--surface)}
.chip.off{opacity:.45;text-decoration:line-through}
.chip.pin{border-color:var(--accent-line);color:var(--ink)}
.cbar{display:flex;align-items:center;gap:2px;margin-top:6px}
.cbtn{width:26px;height:26px;border-radius:5px;display:grid;place-items:center;color:var(--faint);font-size:14px;font-weight:600}
.cbtn:hover{color:var(--ink);background:var(--raise)}
.cbtn.at{font-family:var(--mono);font-size:13px}
.act-send{width:28px;height:28px;padding:0;border-radius:6px;display:grid;place-items:center}
.act-send[data-state=start],.act-send[data-state=continue]{background:var(--ok);color:#06140c}
.act-send{position:relative}
.act-send[data-state=processing]{background:var(--raise);color:var(--accent);cursor:pointer}
.act-send[data-state=processing]:hover{background:var(--bad);color:#fff}
.act-send[data-state=processing]:hover .spin{border-color:#ffffff55;border-top-color:#fff}
.act-send .stopic{position:absolute;left:50%;top:50%;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:1.5px;background:currentColor}
.act-send .spin{position:absolute;left:50%;top:50%;width:20px;height:20px;margin:-10px 0 0 -10px}
.spin{width:14px;height:14px;border-radius:50%;border:2px solid #8f9bff44;border-top-color:var(--accent);animation:lainspin .8s linear infinite}
@keyframes lainspin{to{transform:rotate(360deg)}}
.gpop{width:min(320px,calc(100vw - 16px));padding:10px 12px}
.gpop .grow{display:grid;grid-template-columns:110px 1fr;align-items:center;gap:8px;padding:5px 0;font-size:12.5px}
.gpop .grow .gl{color:var(--faint)}
.gpop .grow .gv{justify-self:stretch;text-align:left;padding:4px 8px;border-radius:var(--radius-s);background:var(--surface);border:1px solid var(--line2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gpop .grow .gv:hover{border-color:var(--accent-line)}
.gpop .seg{display:flex;gap:2px;background:var(--surface);border-radius:var(--radius-s);padding:2px}
.gpop .seg button{flex:1;padding:3px 6px;border-radius:3px;font-size:11.5px;color:var(--dim)}
.gpop .seg button[aria-selected=true]{background:var(--raise);color:var(--ink)}
.gpop .gnote{font-size:11px;color:var(--faint);margin-top:6px;line-height:1.45}
.msg .who .role{color:var(--accent);letter-spacing:.06em}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var off = { file: false, selection: false, problems: false, terminal: false };

  function pref(k, d) { try { var v = localStorage.getItem('lain.bot.' + k); return v == null ? d : v; } catch (e) { return d; } }
  function setPref(k, v) { try { localStorage.setItem('lain.bot.' + k, v); } catch (e) { /* storage unavailable */ } }
  function ide() { return L.ui().mode === 'ide'; }
  function agentPane() { return ide() && L.botpane && L.botpane.current() === 'agent'; }

  // ---- what the next message carries ------------------------------------------------
  function extra() {
    var S = L.state();
    if (!ide() || !S || S.current.lane !== 'engineering') return {};
    var mode = pref('mode', 'auto');
    var ctx = pref('context', 'on') === 'on';
    var pane = agentPane() ? 'agent' : 'bot';
    return {
      from: 'ide',
      pane: pane,
      // The AGENT tab goes to the Agent; the BOT tab asks first ("auto") or
      // keeps everything with the BOT ("bot").
      route: pane === 'agent' ? 'agent' : (mode === 'bot' ? 'bot' : undefined),
      focus: pref('agentContext', 'focused') === 'focused',
      context: ctx ? { file: !off.file, selection: !off.selection, problems: !off.problems, terminal: !off.terminal } : { file: false, selection: false, problems: false, terminal: false },
    };
  }
  function afterSend() { off = { file: false, selection: false, problems: false, terminal: false }; chips(); }

  // ---- chips ------------------------------------------------------------------------
  function chip(label, key, title, cls, onX) {
    var c = el('span', 'chip' + (cls ? ' ' + cls : '') + (key && off[key] ? ' off' : ''));
    c.title = title || label;
    c.appendChild(el('span', 't', label));
    var x = el('button', 'x', key && off[key] ? '+' : '×');
    x.title = key ? (off[key] ? 'Include again' : 'Leave out of the next message') : 'Remove';
    x.onclick = function () { if (key) { off[key] = !off[key]; chips(); } else if (onX) onX(); };
    c.appendChild(x);
    return c;
  }
  var lastSig = '';
  function chips() {
    var box = $('ctxChips');
    if (!box) return;
    var S = L.state();
    var items = [];
    if (S && ide() && S.current.lane === 'engineering' && pref('context', 'on') === 'on') {
      var f = L.source && L.source.current();
      if (f) items.push(['file', f.path.split('/').pop(), 'The file in front: ' + f.path]);
      var E = L.editor && L.editor.editor && L.editor.editor();
      var sel = E && E.getSelection && E.getSelection();
      if (sel && !sel.isEmpty()) {
        var n = sel.endLineNumber - sel.startLineNumber + 1;
        items.push(['selection', n + ' line' + (n === 1 ? '' : 's') + ' selected', 'Lines ' + sel.startLineNumber + '-' + sel.endLineNumber]);
      }
      var c = L.panes ? L.panes.counts() : { errors: 0, warnings: 0 };
      if (c.errors + c.warnings) items.push(['problems', (c.errors ? c.errors + ' error' + (c.errors === 1 ? '' : 's') : '') + (c.errors && c.warnings ? ', ' : '') + (c.warnings ? c.warnings + ' warning' + (c.warnings === 1 ? '' : 's') : ''), 'Problems in the open files']);
      if (L.terminal && L.terminal.activeId && L.terminal.activeId()) items.push(['terminal', 'terminal output', 'The last output of the IDE terminal']);
    }
    var pins = (S && S.workspace && S.workspace.pins) || [];
    var sig = JSON.stringify([items, off, pins.map(function (p) { return p.path; })]);
    if (sig === lastSig) return;
    lastSig = sig;
    box.textContent = '';
    items.forEach(function (it) { box.appendChild(chip(it[1], it[0], it[2])); });
    pins.forEach(function (p) {
      box.appendChild(chip('@' + p.path.split('/').pop(), null, 'Pinned: ' + p.path + ' — its current contents go with every message', 'pin', async function () {
        await L.api('/api/files/unpin', { path: p.path });
        L.poll();
      }));
    });
  }

  // ---- @ and + ------------------------------------------------------------------------
  async function pickProjectFile(anchor, then) {
    L.popover(anchor, function (p) {
      p.appendChild(el('h4', '', 'Project file'));
      var box = el('div', 'psearch');
      var i = document.createElement('input');
      i.placeholder = 'Type to find a file';
      box.appendChild(i);
      p.appendChild(box);
      var list = el('div', '');
      p.appendChild(list);
      var draw = function (rows) {
        list.textContent = '';
        rows.slice(0, 20).forEach(function (path) {
          var b = el('button', 'opt', path);
          b.onclick = function () { L.closePop(); then(path); };
          list.appendChild(b);
        });
      };
      draw(L.editor ? L.editor.recent() : []);
      var seq = 0;
      i.oninput = function () {
        var mine = ++seq;
        L.api('/api/files/find', { q: i.value }).then(function (r) { if (mine === seq) draw(((r && r.matches) || []).map(function (m) { return m.path; })); });
      };
      setTimeout(function () { i.focus(); }, 0);
    });
  }
  async function pin(path) {
    var r = await L.api('/api/files/pin', { path: path });
    if (!r.ok) return L.toast(r.why, true);
    L.poll();
  }
  function attached() { var S = L.state(); return Boolean(S && S.current.lane === 'engineering' && S.workspace && S.workspace.project && S.workspace.project.attached); }

  function atMenu() {
    var S = L.state();
    L.popover($('atBtn'), function (p) {
      p.appendChild(el('h4', '', 'Reference'));
      var item = function (label, sub, run, enabled) {
        var b = el('button', 'opt', label);
        if (sub) b.appendChild(el('small', '', sub));
        b.disabled = enabled === false;
        b.onclick = function () { L.closePop(); run(); };
        p.appendChild(b);
      };
      var inc = function (k) { return function () { off[k] = false; setPref('context', 'on'); chips(); }; };
      if (ide()) {
        item('Current file', 'the file in front', inc('file'), Boolean(L.source && L.source.current()));
        item('Selection', 'the selected code', inc('selection'));
        item('Problems', 'errors and warnings in open files', inc('problems'));
        item('Terminal', 'the IDE terminal’s last output', inc('terminal'), Boolean(L.terminal && L.terminal.activeId && L.terminal.activeId()));
        item('Git changes', 'always included: the working tree state', function () { L.toast('The working tree (git status) goes with every coding turn.'); });
      }
      item('File…', attached() ? 'pin a project file to this conversation' : 'open a project first', function () { pickProjectFile($('atBtn'), pin); }, attached());
      item('Open files', 'pin every open tab', function () { (L.source ? L.source.state().open : []).filter(function (f) { return f.kind === 'text'; }).slice(0, 8).forEach(function (f) { pin(f.path); }); }, attached() && Boolean(L.source && L.source.state().open.length));
      item('Session', 'this conversation is always the context', function () { L.nav.go('session'); });
    });
  }
  function addMenu() {
    L.popover($('addBtn'), function (p) {
      p.appendChild(el('h4', '', 'Add'));
      var item = function (label, sub, run, enabled) {
        var b = el('button', 'opt', label);
        if (sub) b.appendChild(el('small', '', sub));
        b.disabled = enabled === false;
        b.onclick = function () { L.closePop(); run(); };
        p.appendChild(b);
      };
      item('Project file…', 'pin it to this conversation', function () { pickProjectFile($('addBtn'), pin); }, attached());
      if (ide()) item('Current selection', 'include what is selected', function () { off.selection = false; chips(); });
      var S = L.state();
      var canAttach = !ide() && S && ((S.cowork && S.cowork.active) || (S.current.lane === 'engineering' && !(S.conversation || []).length && !attached()));
      item('Files or images from disk…', canAttach ? 'to work on in this conversation' : 'in a new Chat conversation', function () {
        if (canAttach) { $('attachPill').click(); return; }
        L.chat.newChat().then(function () { setTimeout(function () { $('attachPill').click(); }, 300); });
      });
    });
  }

  // ---- ⚙ -----------------------------------------------------------------------------------
  //
  // ANCHORED TO THE GEAR, ABOVE THE INPUT (pagescript.js popover: flips below
  // when there is no room, re-placed on resize and display scaling), redrawn
  // in place after a choice (`refresh`). The choosers it opens are nested
  // levels beside it. It changes ASSIGNMENTS only; accounts and providers are
  // the Model view's.
  function gear() {
    L.popover($('gearBtn'), function (p) { drawGear(p); }, { cls: 'gpop', alignRight: true, prefer: 'above', refresh: true, toggle: true });
  }
  function sourceLabel(S) {
    var sel = S.sources ? S.sources.selected : 'lain';
    var s = ((S.sources && S.sources.sources) || []).filter(function (x) { return x.id === sel; })[0];
    if (!s || sel === 'lain') return 'LAIN runtime';
    return s.label + ' \u00b7 website session';
  }
  function drawGear(p) {
    var S = L.state() || {};
    var m = S.models || {};
    var agent = agentPane();
    p.appendChild(el('h4', '', agent ? 'Agent' : 'Session Intelligence'));
    var row = function (label, value, onClick, title) {
      var r = el('div', 'grow');
      r.appendChild(el('span', 'gl', label));
      var b = el('button', 'gv', value);
      if (title) b.title = title;
      b.setAttribute('aria-haspopup', 'dialog');
      b.onclick = function () { onClick(b); };
      r.appendChild(b);
      p.appendChild(r);
      return b;
    };
    var seg = function (label, key, opts, def) {
      var r = el('div', 'grow');
      r.appendChild(el('span', 'gl', label));
      var sg = el('div', 'seg');
      sg.setAttribute('role', 'radiogroup');
      sg.setAttribute('aria-label', label);
      opts.forEach(function (o) {
        var b = el('button', '', o[1]);
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-selected', String(pref(key, def) === o[0]));
        b.setAttribute('aria-checked', String(pref(key, def) === o[0]));
        b.title = o[2] || '';
        b.onclick = function () { setPref(key, o[0]); L.popRefresh(); chips(); };
        sg.appendChild(b);
      });
      r.appendChild(sg);
      p.appendChild(r);
    };
    var chat = m.chat || {};
    var codingLabel = (L.fmt.model(m.coding && m.coding.modelId) || 'not set') + ' \u25be';
    if (agent) {
      row('Coding Agent', codingLabel, function (b) { L.models.pickCoding(b); }, 'The Coding Agent model for this session');
      seg('Context', 'agentContext', [
        ['focused', 'Focused', 'Starts from a focused packet: the selected symbol and what references it, your recent hand-edits, and constraints'],
        ['standard', 'Standard', 'No focused packet; the Agent surveys the project itself'],
      ], 'focused');
      var pv = el('button', 'opt', 'What the Agent would be given \u2192');
      pv.onclick = function () { L.closePop(); previewPacket(); };
      p.appendChild(pv);
      p.appendChild(el('div', 'gnote', 'Changes the shared Coding Agent assignment \u2014 the same one Model, the IDE status bar and Chat show.'));
    } else {
      // THE BOT is its own model (a LAIN route); the CHAT view may consult a website
      // source — ChatGPT Chat is CHAT ONLY and is chosen only in the CHAT row.
      var bi = intel && intel.intel ? intel.intel.bot : null;
      var botModel = bi && bi.model ? L.fmt.model(bi.model) : (L.fmt.model(chat.source === 'lain' ? chat.modelId : null) || 'LAIN default');
      row('BOT model', botModel + ' \u25be', function (b) { L.models.pickBot(b); }, 'The BOT\u2019s model: local, runtime or API — never a website session');
      if (!ide()) row('CHAT source', sourceLabel(S) + (chat.source && chat.source !== 'lain' ? ' \u00b7 CHAT ONLY' : '') + ' \u25be', function (b) { L.models.pickSource(b); }, 'Where the CHAT view answers from: LAIN, or a signed-in website session (CHAT ONLY)');
      row('Coding Agent', codingLabel, function (b) { L.models.pickCoding(b); });
      if (ide()) {
        seg('Code changes', 'mode', [
          ['auto', 'Ask first', 'The BOT answers questions; for code changes it asks "Move to Agent?"'],
          ['bot', 'BOT only', 'Everything stays with the BOT, read-only'],
        ], 'auto');
        seg('Project context', 'context', [['on', 'On', 'The file in front, selection, problems and terminal go with the message'], ['off', 'Off', 'Only what you type and pin']], 'on');
      }
    }
    intelRows(p, row, agent);
    var add = el('button', 'opt', '+ Add account \u2192');
    add.onclick = function () { L.closePop(); L.nav.go('model', { section: 'add' }); };
    p.appendChild(add);
    var addl = el('button', 'opt', '+ Add local model \u2192');
    addl.onclick = function () { L.closePop(); L.nav.go('model', { section: 'local' }); };
    p.appendChild(addl);
    var addp = el('button', 'opt', 'Add provider (API key) \u2192');
    addp.onclick = function () { L.closePop(); L.keys.add(null); };
    p.appendChild(addp);
    var more = el('button', 'opt', 'Open MODEL \u2192');
    more.onclick = function () { L.closePop(); L.nav.go('model', { section: 'models' }); };
    p.appendChild(more);
  }

  // ---- SESSION INTELLIGENCE: account, reasoning, and which layer each came from (sessionintel.js)
  var intel = null, intelAt = 0;
  function loadIntel() {
    if (intel && Date.now() - intelAt < 3000) return;
    intelAt = Date.now();
    L.api('/api/session/intel', {}).then(function (r) { if (r && r.ok) { intel = r; L.popRefresh(); } });
  }
  var SCOPE = { session: 'this session', project: 'this project', global: 'default' };
  function scopeMenu(anchor, lane, field, value) {
    L.popover(anchor, function (q) {
      q.appendChild(el('h4', '', 'Keep it for\u2026'));
      [['session', 'This session only'], ['project', 'This project\u2019s default'], ['global', 'Default for everything']].forEach(function (o) {
        var b = el('button', 'opt', o[1]);
        b.onclick = async function () {
          L.closePop();
          var r = await L.api('/api/session/intel/set', { lane: lane, field: field, value: value, scope: o[0] });
          if (!r.ok) return L.toast(r.why, true);
          intel = null; loadIntel(); L.poll();
        };
        q.appendChild(b);
      });
      if (value !== null) {
        var clr = el('button', 'opt', 'Clear this session\u2019s override');
        clr.onclick = async function () { L.closePop(); await L.api('/api/session/intel/set', { lane: lane, field: field, value: null, scope: 'session' }); intel = null; loadIntel(); };
        q.appendChild(clr);
      }
    }, { cls: 'gpop', prefer: 'above' });
  }
  function intelRows(p, row, agent) {
    loadIntel();
    if (!intel) { p.appendChild(el('div', 'gnote', 'Reading this session\u2019s choices\u2026')); return; }
    var I = intel.intel;
    var acct = I.coding.account || 'any account serving it';
    row('Coding account', acct + ' \u25be', function (b) {
      L.popover(b, function (q) {
        q.appendChild(el('h4', '', 'Account for ' + (L.fmt.model(I.coding.model) || 'the Coding Agent')));
        (intel.codingAccounts || []).forEach(function (a) {
          var o = el('button', 'opt' + (a.usable ? '' : ' off'), a.name + (a.usable ? '' : ' \u2014 ' + a.why));
          o.disabled = !a.usable;
          o.onclick = function () { L.closePop(); scopeMenu(b, 'coding', 'account', a.id); };
          q.appendChild(o);
        });
        if (!(intel.codingAccounts || []).length) q.appendChild(el('div', 'gnote', 'No configured account serves this model.'));
      }, { cls: 'gpop', prefer: 'above' });
    }, 'Which account the Coding Agent\u2019s requests go through');
    row('Reasoning', I.reasoning.value + (I.reasoning.scope !== 'global' ? ' (' + SCOPE[I.reasoning.scope] + ')' : '') + ' \u25be', function (b) {
      L.popover(b, function (q) {
        q.appendChild(el('h4', '', 'Reasoning'));
        (intel.efforts || []).forEach(function (e) {
          var o = el('button', 'opt', e + (I.reasoning.value === e ? '  \u2713' : ''));
          o.onclick = function () { L.closePop(); scopeMenu(b, 'reasoning', 'effort', e); };
          q.appendChild(o);
        });
      }, { cls: 'gpop', prefer: 'above' });
    }, 'How much the model reasons before answering, where the route supports it');
    var lines = ['Coding Agent: ' + SCOPE[I.coding.scope], 'BOT: ' + SCOPE[I.bot.scope], 'Reasoning: ' + SCOPE[I.reasoning.scope]];
    p.appendChild(el('div', 'gnote', 'Session scope \u2014 ' + lines.join(' \u00b7 ') + (I.overrides.length ? '. Overridden here: ' + I.overrides.join(', ') + '.' : '. Nothing overridden.') + ' Global \u2192 project \u2192 session; the nearest wins.'));
    if (agent) return;
  }

  /** WHAT THE AGENT WOULD BE HANDED for the text in the box — computed by Core, sent nowhere. */
  async function previewPacket() {
    var t = ($('ask').value || '').trim() || 'the current task';
    var r = await L.api('/api/focus/packet', { task: t });
    if (!r.ok) return L.toast(r.why, true);
    var mm = r.metrics || {};
    L.dialog({
      title: 'Focused context',
      text: (mm.candidateFiles != null ? mm.filesSent + ' of ' + mm.candidateFiles + ' project files named \u00b7 ' + mm.symbols + ' symbol(s) \u00b7 ~' + mm.approxTokens + ' tokens (approximate)\n\n' : '') + r.text,
      ok: 'Close', cancel: 'Close',
    });
  }

  // ---- the action button ---------------------------------------------------------------
  function actionState(S) {
    var ui = L.ui();
    var h = S && S.header && S.header.status;
    var st = h && h.state;
    if (ui.busy || st === 'RUNNING' || st === 'VERIFYING' || st === 'QUEUED') return 'processing';
    var text = ($('ask').value || '').trim();
    if (agentPane()) {
      // THE AGENT TAB STARTS OR CONTINUES EXECUTION; it never "sends".
      var at = S && S.journey && S.journey.agentTask;
      if (!text && ((S.execution && S.execution.alert && S.execution.alert.resumable) || (at && at.state === 'ACTIVE'))) return 'continue';
      return 'start';
    }
    var pre = S && S.composer && S.composer.coding && S.composer.coding.prefill;
    if (ide() && pre && text && text === String(pre.text || '').trim()) return 'start';
    var alert = S && S.execution && S.execution.alert;
    if (!text && alert && alert.resumable) return 'continue';
    return 'send';
  }
  var drawn = '';
  function paintAction() {
    var S = L.state();
    var b = $('send');
    if (!b) return;
    var st = actionState(S);
    var canSend = (st !== 'send' && st !== 'start') || ($('ask').value || '').trim().length > 0;
    b.disabled = !canSend;
    if (drawn === st) return;
    drawn = st;
    b.setAttribute('data-state', st);
    b.textContent = '';
    if (st === 'processing') {
      b.appendChild(el('span', 'spin'));
      b.appendChild(el('span', 'stopic'));
      b.title = 'Working \u2014 click to stop';
      b.setAttribute('aria-label', 'Stop');
    } else if (st === 'start' || st === 'continue') {
      b.appendChild(L.icon('play', 14));
      b.title = st === 'start' ? (agentPane() ? 'Start the Agent on this' : 'Start the task') : 'Continue the task';
      b.setAttribute('aria-label', b.title);
    } else {
      b.appendChild(L.icon('enter', 15));
      b.title = 'Send (Enter)';
      b.setAttribute('aria-label', 'Send');
    }
  }
  async function act() {
    var st = actionState(L.state());
    if (st === 'processing') {
      var r = await L.api('/api/interrupt', {});
      if (r && !r.ok) L.notice(r.why, true);
      L.poll();
      return;
    }
    if (st === 'continue') { L.send('continue'); return; }
    L.send();
  }

  L.composer = { extra: extra, afterSend: afterSend, chips: chips, paint: paintAction, act: act, state: function () { return actionState(L.state()); } };

  L.onBoot(function () {
    $('addBtn').appendChild(L.icon('plus', 15));
    $('gearBtn').appendChild(L.icon('gear', 15));
    $('addBtn').onclick = addMenu;
    $('atBtn').onclick = atMenu;
    $('gearBtn').onclick = gear;
    $('send').onclick = act;
    $('ask').addEventListener('input', function () { paintAction(); });
    $('ask').addEventListener('keydown', function (e) {
      if (e.key === '@' && !this.value.trim()) { e.preventDefault(); atMenu(); }
    });
    setInterval(chips, 1200);
  });
  L.onRender(function () { chips(); paintAction(); });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
