'use strict';

/**
 * THE COMPOSER — one box, the familiar one (2026-09-30 rewrite).
 *
 *   ╭──────────────────────────────────────────────────────────────╮
 *   │ [main.ts] [3 lines selected]              ← what goes along   │
 *   │ Message LAIN…                                                 │
 *   │                                                               │
 *   │ +  @  /                 ◈  GPT-6 Sol ▾   ◔▮  ⚡          ( ➜ ) │
 *   ╰──────────────────────────────────────────────────────────────╯
 *
 * THE MODEL IS READABLE TEXT; everything else is an icon. The provider (its
 * mark), the effort (a small level meter) and the execution profile (Normal ·
 * Fast · Eco, with the run strategy) are icons with a tooltip on hover and a
 * small curved popover on click — no row of "Provider ▾ Model ▾ Effort ▾"
 * boxes. The route is Core's canonical one (sessionintel `display`): whole, or
 * one "Select model".
 *
 * ONE COMPOSER, MOVED: Chat's, the full Coding Chat's and the IDE sidecar's are
 * the same textarea. Wide (Chat): about 840 px, at least ~80 px tall, growing to
 * ~200 px before it scrolls, radius 18. In the sidecar: compact — ~60 px, up to
 * ~120 px, IDE-scale type, radius 12.
 *
 * CONTEXT IS IMPLICIT, AND INSPECTABLE. In the IDE the chips say what goes with
 * the next message (the file in front, the selection, problems, terminal);
 * closing one leaves it out (`context:{…:false}`, honoured by Core). `@file`
 * pins a project file through Core's own pins.
 *
 * THE ACTION BUTTON SAYS WHAT PRESSING IT WILL DO: send (➜), start or continue
 * (▶, the Coding Agent), or stop (◌■) while LAIN works.
 */

const HTML = `
      <div class="box">
        <div class="chips" id="ctxChips"></div>
        <textarea id="ask" rows="1" placeholder="Message LAIN…"></textarea>
        <div class="cbar">
          <button class="cbtn" id="addBtn" aria-label="Add files or context"></button>
          <button class="cbtn at" id="atBtn" aria-label="Reference context">@</button>
          <button class="cbtn at sl" id="slashBtn" aria-label="Commands">/</button>
          <button class="pill" id="attachPill" hidden>Attach</button>
          <input type="file" id="attachFile" multiple hidden>
          <span class="hint" id="composerHint"></span>
          <span class="spacer"></span>
          <span class="croute" id="composerCells"></span>
          <button class="send act-send" id="send" data-state="send" aria-label="Send"></button>
        </div>
      </div>`;

const CSS = `
.composer{padding:8px 20px 14px;flex:none}
.composer .box{display:flex;flex-direction:column;background:var(--surface-base);border-radius:18px;padding:14px 12px 10px 16px;min-height:82px;box-shadow:inset 0 0 0 1px var(--border-subtle);transition:box-shadow var(--t-hover) var(--ease)}
.composer .box:focus-within{box-shadow:inset 0 0 0 1px var(--accent-border),0 0 0 3px color-mix(in srgb,var(--accent-primary) 10%,transparent)}
.composer textarea{display:block;flex:0 0 auto;resize:none;font-size:var(--fs-composer);line-height:1.5;min-height:24px;max-height:200px;padding:0 2px;color:var(--text-primary)}
.composer textarea::placeholder{color:var(--text-muted)}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 8px}
.chips:empty{display:none}
.chip{display:inline-flex;align-items:center;gap:5px;max-width:220px;padding:2px 4px 2px 8px;border-radius:var(--radius-sm);background:var(--surface-active);font-size:var(--fs-caption);color:var(--text-secondary)}
.chip .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip .x{width:16px;height:16px;border-radius:4px;color:var(--text-muted);font-size:12px;line-height:1}
.chip .x:hover{color:var(--text-primary);background:var(--surface-raised)}
.chip.off{opacity:.45;text-decoration:line-through}
.chip.pin{color:var(--text-primary);box-shadow:inset 0 0 0 1px var(--accent-border)}
.cbar{display:flex;align-items:center;gap:2px;margin-top:10px;min-width:0}
.cbar .hint{margin-left:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--fs-caption);color:var(--text-muted)}
.cbtn{width:30px;height:30px;border-radius:var(--radius-sm);display:grid;place-items:center;color:var(--text-muted);font-size:14px;font-weight:600;flex:none}
.cbtn:hover,.cbtn[aria-expanded=true]{color:var(--text-primary);background:var(--hover)}
.cbtn.at{font-family:var(--mono);font-size:13.5px}
.cbtn[hidden]{display:none}
/* THE ROUTE: the model as a readable pill; provider, effort and execution as icons. */
.croute{display:flex;align-items:center;gap:2px;min-width:0;margin-right:6px}
.rtc{display:flex;align-items:center;gap:2px;min-width:0}
.cell{position:relative;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 7px;border-radius:var(--radius-sm);color:var(--text-secondary);font-size:var(--fs-small);white-space:nowrap;flex:none;transition:background var(--t-hover) var(--ease),color var(--t-hover) var(--ease)}
.cell:hover,.cell[aria-expanded=true]{background:var(--hover);color:var(--text-primary)}
.cell .cl{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.cell .u-mark{width:16px;height:16px;color:currentColor}
.cell.model{padding:0 8px 0 11px;border-radius:999px;background:var(--surface-raised);color:var(--text-primary);font-weight:500;min-width:0;flex:0 1 auto;margin:0 2px}
.cell.model:hover,.cell.model[aria-expanded=true]{background:var(--surface-active)}
.cell.model .mt{min-width:0;overflow:hidden;text-overflow:ellipsis}
.cell.model .ic{color:var(--text-muted);flex:none}
.cell.model.need{color:var(--warning);background:var(--warning-weak)}
.cell .lvl{display:inline-flex;align-items:flex-end;gap:1.5px;height:11px;margin-left:-2px}
.cell .lvl i{width:2.5px;border-radius:1px;background:currentColor;opacity:.28}
.cell .lvl i:nth-child(1){height:4px} .cell .lvl i:nth-child(2){height:7.5px} .cell .lvl i:nth-child(3){height:11px}
.cell .lvl i.on{opacity:1}
.cell.exec[data-exec=FAST]{color:var(--warning)} .cell.exec[data-exec=ECO]{color:var(--positive)}
.cell.exec .q{font-size:var(--fs-caption);color:var(--text-muted)}
/* THE ACTION: a small accent square that says what it will do. */
.act-send{position:relative;flex:none;width:34px;height:34px;padding:0;border-radius:11px;display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--accent-primary);color:var(--on-accent);margin-left:2px;transition:background var(--t-hover) var(--ease),transform var(--t-hover) var(--ease)}
.act-send:hover:not(:disabled){background:color-mix(in srgb,var(--accent-primary) 86%,#fff 14%)}
.act-send:active:not(:disabled){transform:scale(.94)}
.act-send:disabled{background:var(--surface-active);color:var(--text-muted)}
.act-send .lbl{display:none}
.act-send[data-state=start],.act-send[data-state=continue]{width:auto;padding:0 13px}
.act-send[data-state=start] .lbl,.act-send[data-state=continue] .lbl{display:inline;font-size:var(--fs-small);font-weight:600}
.act-send[data-state=processing]{background:var(--surface-active);color:var(--accent-primary);cursor:pointer}
.act-send[data-state=processing]:hover{background:var(--danger);color:#fff}
.act-send[data-state=processing]:hover .spin{border-color:#ffffff55;border-top-color:#fff}
.act-send .stopic{position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:1.5px;background:currentColor}
.act-send .spin{position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px}
.intel-decision-slot{margin:0 0 8px}
.intel-decision-slot[hidden]{display:none}
/* THE SIDECAR: compact — IDE-scale type, ~60 px, up to ~120 px, radius 12. */
.bp-convo .composer{padding:6px 10px 10px}
.bp-convo .composer .box{border-radius:12px;padding:6px 6px 4px 11px;min-height:60px}
.bp-convo .composer textarea{font-size:var(--fs-sidecar);max-height:120px}
.bp-convo .chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin-bottom:6px}
.bp-convo .chips::-webkit-scrollbar{display:none}
.bp-convo .chip{flex:none}
.bp-convo .cbar{margin-top:2px}
.bp-convo .cbtn{width:26px;height:26px}
.bp-convo .cbtn.sl{display:none}
.bp-convo .cell{height:26px;padding:0 5px;font-size:var(--fs-caption)}
.bp-convo .cell.model{padding:0 6px 0 9px}
.bp-convo .act-send{width:28px;height:28px;border-radius:9px}
.bp-convo .act-send[data-state=start],.bp-convo .act-send[data-state=continue]{width:28px;padding:0}
.bp-convo .act-send[data-state=start] .lbl,.bp-convo .act-send[data-state=continue] .lbl{display:none}
.bp-convo .act-send .spin{width:18px;height:18px;margin:-9px 0 0 -9px}
.slashpop{width:min(440px,calc(100vw - 16px));padding:5px}
.slashpop .opt{display:flex;align-items:baseline;gap:12px;padding:6px 10px}
.slashpop .opt b{font-family:var(--mono);font-size:13px;color:var(--text-primary);min-width:92px}
.slashpop .opt span{color:var(--text-muted);font-size:12.5px}
.slashpop .opt[aria-selected=true]{background:var(--selection)}
/* THE MODE POPOVER: execution, run strategy and (in the IDE) what context goes along. */
.modepop{width:min(330px,calc(100vw - 16px));padding:12px 12px 8px}
.modepop h5{margin:0 0 8px;font-size:var(--fs-caption);font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted)}
.modepop h5:not(:first-child){margin-top:14px}
.modepop .u-seg{display:flex}
.modepop .u-seg > button{flex:1;justify-content:center}
.modepop .mnote{font-size:var(--fs-caption);color:var(--text-secondary);line-height:1.45;margin-top:6px}
.modepop .grow{display:grid;grid-template-columns:112px 1fr;align-items:center;gap:8px;padding:4px 0;font-size:var(--fs-small)}
.modepop .grow .gl{color:var(--text-secondary)}
.modepop .opt{display:flex;align-items:flex-start;gap:8px;width:100%;padding:6px 6px;border-radius:var(--radius-sm);font-size:var(--fs-body);color:var(--text-primary);text-align:left}
.modepop .opt:hover{background:var(--hover)}
.modepop .opt small{display:block;color:var(--text-muted);font-size:var(--fs-caption)}
.modepop .opt .ck{width:14px;flex:none;color:var(--accent-primary);margin-top:2px}
.modepop .mfoot{display:flex;gap:4px;flex-wrap:wrap;margin-top:10px;padding-top:8px;border-top:1px solid var(--separator)}
@media (max-width: 620px){.croute .cell.prov,.croute .cell.eff .lvl{display:none}}
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

  // ---- what the next message carries ------------------------------------------------------------------
  function extra() {
    var S = L.state();
    if (!ide() || !S || S.current.lane !== 'engineering') return {};
    var mode = pref('mode', 'auto');
    var ctx = pref('context', 'on') === 'on';
    var pane = agentPane() ? 'agent' : 'bot';
    return {
      from: 'ide',
      pane: pane,
      route: pane === 'agent' ? 'agent' : (mode === 'bot' ? 'bot' : undefined),
      focus: pref('agentContext', 'focused') === 'focused',
      context: ctx ? { file: !off.file, selection: !off.selection, problems: !off.problems, terminal: !off.terminal } : { file: false, selection: false, problems: false, terminal: false },
    };
  }
  function afterSend() { off = { file: false, selection: false, problems: false, terminal: false }; chips(); }

  // ---- chips ------------------------------------------------------------------------------------------
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

  // ---- @ and + ----------------------------------------------------------------------------------------------
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
      }
      item('File…', attached() ? 'pin a project file to this conversation' : 'open a project first', function () { pickProjectFile($('atBtn'), pin); }, attached());
      item('Open files', 'pin every open tab', function () { (L.source ? L.source.state().open : []).filter(function (f) { return f.kind === 'text'; }).slice(0, 8).forEach(function (f) { pin(f.path); }); }, attached() && Boolean(L.source && L.source.state().open.length));
    }, { prefer: 'above', toggle: true });
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
      if (!attached() && S && S.current.lane === 'engineering') item('Project folder…', 'bind this conversation to a folder', function () { L.work.projectMenu($('addBtn')); });
    }, { prefer: 'above', toggle: true });
  }

  /** The lane this composer writes to: Chat's, or the Coding Agent's (Coding Chat, the IDE). */
  function laneOf() { return L.ui().mode === 'chat' ? 'chat' : 'coding'; }
  function W() { var S = L.state(); return (S && S.workbench) || {}; }

  /** WHAT THE AGENT WOULD BE HANDED for the text in the box — computed by Core, sent nowhere. */
  async function previewPacket() {
    var t = ($('ask').value || '').trim() || 'the current task';
    var r = await L.api('/api/focus/packet', { task: t });
    if (!r.ok) return L.toast(r.why, true);
    var mm = r.metrics || {};
    L.dialog({
      title: 'Focused context',
      text: (mm.candidateFiles != null ? mm.filesSent + ' of ' + mm.candidateFiles + ' project files named · ' + mm.symbols + ' symbol(s) · ~' + mm.approxTokens + ' tokens (approximate)\n\n' : '') + r.text,
      ok: 'Close', cancel: 'Close',
    });
  }

  // ---- the action button ----------------------------------------------------------------------------------
  function actionState(S) {
    var ui = L.ui();
    var h = S && S.header && S.header.status;
    var st = h && h.state;
    if (ui.busy || st === 'RUNNING' || st === 'VERIFYING' || st === 'QUEUED') return 'processing';
    var text = ($('ask').value || '').trim();
    if (agentPane()) {
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
      b.setAttribute('data-tip', 'Working — click to stop');
      b.setAttribute('aria-label', 'Stop');
    } else if (st === 'start' || st === 'continue') {
      b.appendChild(L.icon('play', 13));
      b.appendChild(el('span', 'lbl', st === 'start' ? 'Start' : 'Continue'));
      b.setAttribute('data-tip', st === 'start' ? (agentPane() ? 'Start the Agent on this' : 'Start the task') : 'Continue the task');
      b.setAttribute('aria-label', b.getAttribute('data-tip'));
    } else {
      b.appendChild(L.icon('send', 16));
      b.setAttribute('data-tip', 'Send (Enter)');
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

  // ---- EXECUTION, STRATEGY AND CONTEXT: the mode icon's popover ---------------------------------------------------
  var PROFILE = {
    NORMAL: { word: 'Normal', icon: 'sliders', note: 'Balanced: runs the task through and verifies as it goes.' },
    FAST: { word: 'Fast', icon: 'bolt', note: 'Less narration, narrow context, direct implementation — verification kept.' },
    ECO: { word: 'Eco', icon: 'leaf', note: 'Fewer model calls: deterministic tools and cached evidence first.' },
  };
  var STRATEGY = [
    ['NORMAL', 'Normal', 'runs the task to completion; pauses only for a decision, quota or an explicit pause'],
    ['PHASED', 'Phased', 'the approved plan phase by phase, with a review after each'],
    ['LONG_CONTEXT', 'Long Context Phasing', 'phase after phase toward the whole objective, compacting between phases'],
  ];
  function effortNow() { var s = L.intel ? L.intel.sel(laneOf()) : {}; return s.effort || 'auto'; }
  function effortMenu(anchor) { if (L.intel) L.intel.pickEffort(anchor, laneOf()); }
  async function setProfile(p) {
    var r = await L.api('/api/workbench/profile', { profile: p });
    if (!r || !r.ok) return L.toast((r && r.why) || 'could not change the profile', true);
    if (r.queued) L.toast(p.charAt(0) + p.slice(1).toLowerCase() + ' applies at the Agent’s next checkpoint.');
    await L.poll();
    L.popRefresh();
  }
  function profileMenu(anchor) { modeMenu(anchor); }
  async function setStrategy(kind, review) {
    var r = await L.api('/api/workbench/strategy', { kind: kind, review: review || undefined });
    if (!r || !r.ok) return L.toast((r && r.why) || 'could not change the strategy', true);
    if (r.needsConfirm) {
      L.closePop();
      var o = r.offer;
      var v = await L.dialog({ title: 'Long Context Phasing', text: o.text + '\n\n' + o.estimate.text + (o.estimate.basis ? '\n(' + o.estimate.basis + ')' : '') + '\n\nLAIN continues the approved plan phase after phase, carrying its compact state between phases, and stops for decisions, scope changes, failures or quota.', ok: 'Continue', cancel: 'Cancel', extra: { label: 'Use Eco', value: 'eco' } });
      var choice = v === 'eco' ? 'eco' : v ? 'continue' : 'cancel';
      await L.api('/api/workbench/answer', { id: o.id, choice: choice });
    }
    await L.poll();
    L.popRefresh();
  }
  function strategyMenu(anchor) { modeMenu(anchor); }
  /**
   * THE MODE POPOVER — how LAIN runs: Execution (Normal · Fast · Eco), the run strategy, and in the IDE what
   * context goes with the message. Small, curved, redrawn in place after each choice.
   */
  function modeMenu(anchor) {
    L.popover(anchor, function (p) {
      var w = W();
      var coding = laneOf() === 'coding';
      // EXECUTION (Normal · Fast · Eco) — the session's profile, in either lane.
      var cur = w.profile || 'NORMAL';
      p.appendChild(el('h5', '', 'Execution'));
      var sg = L.kit.segmented(Object.keys(PROFILE).map(function (k) { return [k, PROFILE[k].word, { icon: PROFILE[k].icon }]; }), cur, function (k) { if (k !== cur) setProfile(k); });
      p.appendChild(sg);
      p.appendChild(el('div', 'mnote', PROFILE[cur].note + (w.pendingProfile ? ' ' + PROFILE[w.pendingProfile].word + ' is queued for the next checkpoint.' : '') + ' Separate from effort, which is how much the model reasons.'));
      if (coding) {
        var st = (w.strategy && w.strategy.kind) || 'NORMAL';
        p.appendChild(el('h5', '', 'Run strategy'));
        STRATEGY.forEach(function (x) {
          var b = el('button', 'opt');
          var ck = el('span', 'ck'); if (x[0] === st) ck.appendChild(L.icon('check', 14)); b.appendChild(ck);
          var t = el('span', ''); t.appendChild(el('span', '', x[1])); t.appendChild(el('small', '', x[2])); b.appendChild(t);
          b.setAttribute('aria-selected', String(x[0] === st));
          b.onclick = function () { if (x[0] !== st) setStrategy(x[0]); };
          p.appendChild(b);
        });
        if (st !== 'NORMAL') {
          var review = (w.strategy || {}).review;
          var rv = el('div', 'grow'); rv.appendChild(el('span', 'gl', 'Review'));
          rv.appendChild(L.kit.select(({ AUTOMATIC: 'Automatic', EVERY_PHASE: 'Every phase', EVERY_3: 'Every 3 phases', ONLY_PROBLEMS: 'Only problems' })[review] || 'Automatic',
            [['AUTOMATIC', 'Automatic'], ['EVERY_PHASE', 'Every phase'], ['EVERY_3', 'Every 3 phases'], ['ONLY_PROBLEMS', 'Only problems']].map(function (x) { return { label: x[1], checked: review === x[0], run: function () { setStrategy(st, x[0]); } }; })));
          p.appendChild(rv);
        }
      }
      if (ide()) {
        p.appendChild(el('h5', '', 'Context'));
        var seg = function (label, key, opts, def) {
          var r = el('div', 'grow');
          r.appendChild(el('span', 'gl', label));
          var s2 = L.kit.segmented(opts.map(function (o) { return [o[0], o[1]]; }), pref(key, def), function (v) { setPref(key, v); chips(); L.popRefresh(); });
          opts.forEach(function (o) { var b = s2.querySelector('[data-seg="' + o[0] + '"]'); if (b && o[2]) b.setAttribute('data-tip', o[2]); });
          r.appendChild(s2);
          p.appendChild(r);
        };
        seg('Project context', 'context', [['on', 'On', 'The file in front, selection, problems and terminal go with the message'], ['off', 'Off', 'Only what you type and pin']], 'on');
        if (agentPane()) seg('Agent context', 'agentContext', [['focused', 'Focused', 'A focused packet: the selected symbol and what references it, your recent hand-edits, constraints'], ['standard', 'Standard', 'The Agent surveys the project itself']], 'focused');
        else seg('Code changes', 'mode', [['auto', 'Ask first', 'Questions are answered; for code changes LAIN asks "Move to Agent?"'], ['bot', 'Read only', 'Everything stays read-only']], 'auto');
      }
      var foot = el('div', 'mfoot');
      if (agentPane()) foot.appendChild(L.kit.button('What the Agent would be given…', 'sm ghost', function () { L.closePop(); previewPacket(); }));
      foot.appendChild(L.kit.button('Accounts and models…', 'sm ghost', function () { L.closePop(); L.nav.go('model', { section: 'accounts' }); }));
      p.appendChild(foot);
    }, { cls: 'modepop', alignRight: true, prefer: 'above', refresh: true, toggle: true });
  }
  /** THE MODE ICON — execution at a glance (Normal · Fast · Eco); the popover holds the rest. */
  function execCell(w) {
    var p = w.profile || 'NORMAL';
    var P = PROFILE[p] || PROFILE.NORMAL;
    var b = el('button', 'cell exec');
    b.setAttribute('data-exec', p);
    b.setAttribute('data-cell', 'exec');
    var strat = (w.strategy && w.strategy.label) || 'Normal';
    var tip = laneOf() === 'coding' ? 'Execution · ' + P.word + (strat !== 'Normal' ? ' · ' + strat : '') + (w.pendingProfile ? ' → ' + PROFILE[w.pendingProfile].word + ' at the next checkpoint' : '') : 'Context and options';
    b.setAttribute('data-tip', tip);
    b.setAttribute('aria-label', tip);
    b.appendChild(el('span', 'cl', P.word));
    b.appendChild(L.icon(laneOf() === 'coding' ? P.icon : 'sliders', 16));
    if (w.pendingProfile) b.appendChild(el('span', 'q', '→'));
    b.onclick = function (e) { e.stopPropagation(); modeMenu(b); };
    return b;
  }

  // ---- THE ROUTE LINE -------------------------------------------------------------------------------------------
  function decisionHolder() {
    var box = $('ask') && $('ask').closest('.box');
    if (!box || !box.parentNode) return null;
    var h = box.parentNode.querySelector(':scope > .intel-decision-slot');
    if (!h) { h = el('div', 'intel-decision-slot'); h.hidden = true; box.parentNode.insertBefore(h, box); }
    return h;
  }
  var cellSig = '';
  function cells() {
    var box = $('composerCells');
    if (!box) return;
    var S = L.state();
    var mode = L.ui().mode;
    if (!S || S.current.lane !== 'engineering' || !L.intel) { if (box.childNodes.length) { box.textContent = ''; cellSig = ''; } return; }
    var w = W();
    var lane = laneOf();
    // AN ACCOUNT QUESTION (Ask / Pinned / no compatible account) sits above the composer until answered.
    var dh = decisionHolder();
    if (dh) L.intel.decision(dh, lane);
    var s = L.intel.sel(lane);
    var sig = JSON.stringify([mode, lane, s.display, s.efforts, s.effort, s.family, s.backing && s.backing.name, w.profile, w.pendingProfile, w.strategy && w.strategy.kind, ide()]);
    if (sig === cellSig) return;
    cellSig = sig;
    box.textContent = '';
    var rt = el('span', '');
    L.intel.routeCompact(rt, lane, { prefer: 'above', alignRight: true });
    box.appendChild(rt);
    // THE MODE ICON: the Coding Agent's execution — and, in the IDE, the context options for either pane.
    // THE MODE ICON (spec §15: provider icon · model · effort icon · mode icon) in every composer — Chat included.
    box.appendChild(execCell(w));
  }

  // ---- SLASH SUGGESTIONS: "/" lists LAIN's controls; they change Core state, never reach a model. ------------------
  var controls = null, slashPop = null, slashIdx = 0, slashRows = [];
  function loadControls() { if (!controls) L.api('/api/controls/list', {}).then(function (r) { if (r && r.ok) controls = r.controls; slashUpdate(); }); }
  function slashClose() { if (slashPop) { L.closePop(); slashPop = null; } }
  function slashPick(row) { var a = $('ask'); a.value = row.name + ' '; a.focus(); slashClose(); }
  function slashUpdate() {
    var a = $('ask');
    var v = a.value;
    var m = /^\/([a-z-]*)$/i.exec(v);
    if (!m) { slashClose(); return; }
    loadControls();
    slashRows = (controls || []).filter(function (c) { return c.name.slice(1).indexOf(m[1].toLowerCase()) === 0; });
    if (!slashRows.length) { slashClose(); return; }
    slashIdx = Math.min(slashIdx, slashRows.length - 1);
    var draw = function (p) {
      slashRows.forEach(function (c, i) {
        var o = el('button', 'opt');
        o.setAttribute('aria-selected', String(i === slashIdx));
        o.appendChild(el('b', '', c.name)); o.appendChild(el('span', '', c.desc));
        o.onmousedown = function (e) { e.preventDefault(); slashPick(c); };
        p.appendChild(o);
      });
    };
    if (slashPop && document.body.contains(slashPop)) { slashPop.textContent = ''; draw(slashPop); return; }
    slashPop = L.popover(a, draw, { cls: 'slashpop', prefer: 'above' });
  }
  document.addEventListener('keydown', function (e) {
    if (!slashPop || !document.body.contains(slashPop) || e.target !== $('ask')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); slashIdx = (slashIdx + (e.key === 'ArrowDown' ? 1 : -1) + slashRows.length) % slashRows.length; slashPop.textContent = ''; slashUpdate(); return; }
    if ((e.key === 'Enter' || e.key === 'Tab') && slashRows[slashIdx]) { e.preventDefault(); e.stopPropagation(); slashPick(slashRows[slashIdx]); return; }
    if (e.key === 'Escape') { e.stopPropagation(); slashClose(); }
  }, true);

  L.composer = { extra: extra, afterSend: afterSend, chips: chips, paint: paintAction, act: act, state: function () { return actionState(L.state()); },
    effort: effortNow, effortMenu: effortMenu, profileMenu: profileMenu, strategyMenu: strategyMenu, modeMenu: modeMenu, setProfile: setProfile, setStrategy: setStrategy, cells: function () { cellSig = ''; cells(); } };

  L.onBoot(function () {
    $('addBtn').appendChild(L.icon('plus', 16));
    $('addBtn').setAttribute('data-tip', 'Add files or context');
    $('atBtn').setAttribute('data-tip', 'Reference context (@)');
    $('slashBtn').setAttribute('data-tip', 'Commands (/)');
    $('addBtn').onclick = addMenu;
    $('atBtn').onclick = atMenu;
    // "/" — the same command list typing it opens, one click away.
    $('slashBtn').onclick = function () { var a = $('ask'); a.focus(); if (!a.value) { a.value = '/'; a.dispatchEvent(new Event('input', { bubbles: true })); } };
    $('send').onclick = act;
    $('ask').addEventListener('input', function () { paintAction(); slashIdx = 0; slashUpdate(); });
    $('ask').addEventListener('blur', function () { setTimeout(slashClose, 150); });
    $('ask').addEventListener('keydown', function (e) {
      if (e.key === '@' && !this.value.trim()) { e.preventDefault(); atMenu(); }
    });
    setInterval(function () { if (!document.hidden) chips(); }, 1200);
  });
  L.onRender(function () { chips(); paintAction(); cells(); });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
