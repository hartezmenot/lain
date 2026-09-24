'use strict';

/**
 * THE IDE — a familiar editor with the BOT beside it.
 *
 * ------------------------------------------------------------------------
 * FAMILIAR ON PURPOSE. Activity bar, explorer, editor tabs, a bottom panel,
 * a status bar and the keys people already have in their hands (Ctrl+P,
 * Ctrl+S, Ctrl+B, Ctrl+J, Ctrl+`). Only the palette and the shell around it
 * are LAIN's own.
 *
 *   ┌──┬──────────┬──────────────────────────┬──────────────┐
 *   │▣ │ EXPLORER │ editor tabs / editor     │ BOT          │
 *   │  │          │──────────────────────────│ models       │
 *   │  │          │ panel: Changes Terminal… │ conversation │
 *   └──┴──────────┴──────────────────────────┴──────────────┘
 *    status bar: project · understanding · Coding Agent model
 *
 * ------------------------------------------------------------------------
 * WHO OWNS WHAT.
 *   the project, its attachment        Core (S.workspace.project)
 *   project understanding              Core (S.workspace.project.sync — the
 *                                      index walk's own running/finished state)
 *   which bottom panel is open         Core (S.workspace.openPanel)
 *   the tree, buffers, tabs            LAIN.source (pagesource.js)
 *   the BOT conversation               pagescript.js (#convo, mounted here)
 *   models for each role               Core (S.models), picked via LAIN.models
 * This file lays them out and wires the gestures. It keeps only paint state:
 * which side pane is showing and whether the side/BOT columns are collapsed.
 */

const HTML = `
<section class="view idev" id="vIde" data-view="ide" hidden>
  <div class="ide-start" id="ideStart" hidden>
    <div class="is-in">
      <div class="is-mark" id="isMark"></div>
      <h1>IDE</h1>
      <p class="is-sub">Open a folder to browse, edit and build it with the BOT beside you.</p>
      <div class="is-actions">
        <button class="is-btn" id="ideNew"><span class="ib-ic" id="ideNewIc"></span><span><b>New Project</b><small>Choose where it lives; LAIN creates it</small></span></button>
        <button class="is-btn" id="ideOpen"><span class="ib-ic" id="ideOpenIc"></span><span><b>Open Project</b><small>Pick an existing folder</small></span></button>
      </div>
      <div class="is-handoff" id="isHandoff" hidden></div>
      <div class="is-recent"><h2>Recent</h2><div id="ideRecent"></div></div>
    </div>
  </div>
  <div class="ide" id="main" hidden>
    <nav class="activity" id="activity" aria-label="IDE">
      <button class="act-btn" data-pane="explorer" title="Explorer (Ctrl+Shift+E)"></button>
      <button class="act-btn" data-pane="search" title="Search files (Ctrl+Shift+F)"></button>
      <button class="act-btn" data-pane="changes" title="Changes"><span class="act-badge" id="chgBadge" hidden></span></button>
      <button class="act-btn" id="wsPill" title="Preview (Workshop)"></button>
      <span class="spacer"></span>
      <button class="act-btn" id="botToggle" title="BOT panel (Ctrl+Alt+B)"></button>
    </nav>
    <aside class="side" id="ideSide">
      <div class="side-head"><span id="sideTitle">Explorer</span><span class="spacer"></span><button class="iconbtn" id="sideRefresh" title="Refresh"></button></div>
      <div class="side-proj" id="sideProj"></div>
      <div class="side-body" id="paneExplorer">
        ${require('./pagesource').TREE_HTML}
      </div>
      <div class="side-body" id="paneSearch" hidden>
        <div class="sp-search"><input id="fileSearch" placeholder="Search files by name" autocomplete="off" spellcheck="false"></div>
        <div id="fileSearchHits" class="hits"></div>
      </div>
      <div class="side-body" id="paneChanges" hidden><div id="changesList" class="hits"></div></div>
    </aside>
    <div class="editor-col">
      <div class="editor-area" id="editorArea">
        ${require('./pagesource').PANE_HTML}
        ${require('./pageworkshop').HTML}
      </div>
      <div class="bpanel" id="bpanel" hidden>
        <div class="bp-tabs" id="drawers"></div>
        <div class="bp-body" id="drawer"></div>
      </div>
    </div>
    <aside class="botpanel" id="ideBot">
      <div class="bp-head">
        <span class="bp-title">BOT</span>
        <span class="spacer"></span>
        <button class="iconbtn" id="botMore" title="More"></button>
        <button class="iconbtn" id="botGear" title="Models"></button>
      </div>
      <div class="bp-models" id="botModels">
        <button class="mrow" id="botModelBtn"><span class="ml">BOT Model</span><span class="mv" id="botModelVal">\u2014</span><span class="ms" id="botModelScope"></span></button>
        <button class="mrow" id="codeModelBtn"><span class="ml">Coding Agent</span><span class="mv" id="codeModelVal">\u2014</span><span class="ms" id="codeModelScope"></span></button>
      </div>
      <div class="bp-convo" id="ideBotHost"></div>
    </aside>
  </div>
  <footer class="statusbar" id="ideStatus" hidden>
    <span class="sb-item" id="sbProject"></span>
    <span class="sb-item" id="sbUnderstand"></span>
    <span class="spacer"></span>
    <span class="sb-item" id="sbPos"></span>
    <span class="sb-item" id="sbLang"></span>
    <span class="sb-item sb-model" id="sbModel"></span>
  </footer>
</section>`;

const CSS = `
.idev{display:grid;grid-template-rows:1fr auto;min-height:0}
/* ---- no project yet ----------------------------------------------------- */
.ide-start{display:grid;place-items:center;overflow-y:auto;min-height:0}
.is-in{width:min(560px,90vw);padding:40px 0}
.is-mark{color:var(--accent);margin-bottom:14px}
.is-in h1{font:600 22px/1.2 var(--sans);margin:0 0 6px}
.is-sub{color:var(--dim);margin:0 0 24px}
.is-actions{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.is-btn{display:flex;gap:12px;align-items:center;padding:16px;border-radius:10px;background:var(--panel);border:1px solid var(--line);text-align:left}
.is-btn:hover{border-color:var(--accent-line);background:var(--surface)}
.is-btn b{display:block;font-size:14px}
.is-btn small{display:block;color:var(--faint);font-size:12px;margin-top:2px}
.ib-ic{width:38px;height:38px;border-radius:9px;background:var(--accent-weak);color:var(--accent);display:grid;place-items:center;flex:none}
.is-handoff{margin-top:18px;padding:12px 14px;border-radius:8px;background:var(--surface);border:1px solid var(--accent-line);font-size:13px;color:var(--dim)}
.is-handoff b{color:var(--ink)}
.is-recent{margin-top:28px}
.is-recent h2{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin:0 0 6px;font-weight:600}
/* ---- the workspace grid --------------------------------------------------- */
.ide{display:grid;grid-template-columns:44px 250px minmax(0,1fr) 380px;min-height:0}
.ide.side-off{grid-template-columns:44px 0 minmax(0,1fr) 380px}
.ide.bot-off{grid-template-columns:44px 250px minmax(0,1fr) 0}
.ide.side-off.bot-off{grid-template-columns:44px 0 minmax(0,1fr) 0}
.ide.side-off .side,.ide.bot-off .botpanel{display:none}
.activity{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;background:var(--chrome);border-right:1px solid var(--line)}
.act-btn{position:relative;width:36px;height:36px;border-radius:7px;display:grid;place-items:center;color:var(--faint)}
.act-btn:hover{color:var(--ink)}
.act-btn[aria-selected=true]{color:var(--ink);background:var(--raise)}
.act-btn[aria-selected=true]::before{content:'';position:absolute;left:-4px;top:9px;bottom:9px;width:2px;border-radius:2px;background:var(--accent)}
.act-btn:disabled{opacity:.35}
.act-badge{position:absolute;right:3px;bottom:3px;min-width:15px;height:15px;padding:0 3px;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:9.5px;font-weight:700;display:grid;place-items:center}
.side{display:flex;flex-direction:column;min-height:0;background:var(--panel);border-right:1px solid var(--line)}
.side-head{display:flex;align-items:center;height:34px;padding:0 8px 0 14px;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);font-weight:600}
.side-proj{padding:2px 14px 6px;font-size:12px;font-weight:600;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side-body{flex:1;min-height:0;overflow:auto}
.sp-search{padding:4px 10px 8px}
.sp-search input{background:var(--surface);border:1px solid var(--line2);border-radius:var(--radius-s);padding:5px 8px;font-size:12.5px}
.hits .hit{display:block;width:100%;text-align:left;padding:4px 14px;font-size:12.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hits .hit:hover{background:var(--raise);color:var(--ink)}
.hits .hit small{color:var(--faint);margin-left:6px;font-size:11px}
.hits .hit .add{margin-left:6px}
.hits .none{padding:8px 14px;color:var(--faint);font-size:12px}
.editor-col{display:grid;grid-template-rows:minmax(0,1fr) auto;min-width:0;min-height:0}
.editor-area{display:grid;grid-template-columns:minmax(0,1fr);min-height:0;min-width:0}
.ide.with-workshop .editor-area{grid-template-columns:minmax(0,1fr) minmax(360px,46%)}
.bpanel{height:clamp(160px,32vh,420px);display:grid;grid-template-rows:auto 1fr;border-top:1px solid var(--line);background:var(--panel);min-height:0}
.bp-tabs{display:flex;align-items:center;gap:2px;padding:0 10px;height:32px;border-bottom:1px solid var(--line)}
.bp-tabs .tab{padding:4px 10px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);border-radius:0;border-bottom:1px solid transparent}
.bp-tabs .tab:hover{color:var(--ink)}
.bp-tabs .tab[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent)}
.bp-tabs .tab .n{margin-left:5px;color:var(--faint)}
.bp-body{overflow:auto;padding:8px 14px;min-height:0}
/* ---- the BOT panel -------------------------------------------------------- */
.botpanel{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--panel);border-left:1px solid var(--line)}
.bp-head{display:flex;align-items:center;gap:2px;height:34px;padding:0 6px 0 14px}
.bp-title{font-size:11px;letter-spacing:.14em;font-weight:700;color:var(--ink)}
.bp-models{padding:0 8px 8px;border-bottom:1px solid var(--line)}
.bp-models.collapsed{display:none}
.mrow{display:grid;grid-template-columns:96px minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;padding:5px 8px;border-radius:var(--radius-s);text-align:left;font-size:12.5px}
.mrow:hover{background:var(--surface)}
.mrow .ml{color:var(--faint);font-size:11.5px}
.mrow .mv{color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrow .mv::after{content:' \\25BE';color:var(--faint);font-size:10px}
.mrow .ms{font-size:10.5px;color:var(--faint)}
.bp-convo{flex:1;min-height:0;display:flex;flex-direction:column}
.bp-convo .convo{flex:1}
.bp-convo .convo-head{display:none}
.bp-convo .stream{padding:12px 14px 6px}
.bp-convo .composer{padding:8px 10px 10px}
.bp-convo .msg{max-width:none}
/* ---- status bar ------------------------------------------------------------ */
.statusbar{display:flex;align-items:center;gap:2px;height:24px;padding:0 8px;background:var(--chrome);border-top:1px solid var(--line);font-size:11.5px;color:var(--faint)}
.sb-item{display:flex;align-items:center;gap:6px;padding:0 7px;white-space:nowrap}
.sb-item b{color:var(--dim);font-weight:500}
.sb-ok{color:var(--ok)}
.sb-bar{display:inline-block;position:relative;width:90px;height:5px;border-radius:3px;background:var(--surface);overflow:hidden;box-shadow:inset 0 0 0 1px var(--line2)}
.sb-bar i{position:absolute;left:0;top:0;bottom:0;background:var(--accent)}
.sb-model{color:var(--dim)}
/* ---- the handoff card: a task that arrived from Chat ------------------------ */
.card.handoff{border:1px solid var(--accent-line)}
.card.handoff h4::before{background:var(--accent)}
.card.handoff .hk{display:grid;grid-template-columns:92px 1fr;gap:3px 10px;font-size:12.5px;margin:6px 0 10px}
.card.handoff .hk dt{color:var(--faint)} .card.handoff .hk dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.card.handoff .ok{color:var(--ok)}
@media (max-width: 1100px){.ide{grid-template-columns:44px 210px minmax(0,1fr) 320px}}
@media (max-width: 900px){.ide,.ide.bot-off{grid-template-columns:44px 0 minmax(0,1fr) 0}.ide .side,.ide .botpanel{display:none}.ide.show-bot{grid-template-columns:44px 0 0 minmax(0,1fr)}.ide.show-bot .botpanel{display:flex}.ide.show-bot .editor-col{display:none}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var pane = 'explorer';
  var recent = null;
  var DRAWER_IDS = ['CHANGES', 'PLAN', 'TERMINAL', 'VERIFICATION'];
  var lastPanel = 'TERMINAL';
  function pref(k, d) { try { var v = localStorage.getItem('lain.ide.' + k); return v == null ? d : v === '1'; } catch (e) { return d; } }
  function setPref(k, v) { try { localStorage.setItem('lain.ide.' + k, v ? '1' : '0'); } catch (e) { /* private window */ } }

  function S() { return L.state(); }
  function attached() {
    var s = S();
    return Boolean(s && s.current.lane === 'engineering' && s.workspace && s.workspace.project && s.workspace.project.attached);
  }

  // ---- opening and creating ------------------------------------------------
  async function pickFolder(title) {
    var r = await L.hostCall('pickFolder', { title: title });
    if (r) return r.cancelled ? null : (r.path || null);
    // A HOST OLDER THAN THE PICKER: the same question, typed.
    var v = await L.dialog({ title: title, text: 'Type the full path of the folder.', fields: [{ key: 'path', label: 'Folder', placeholder: 'D:\\projects\\my-app' }], ok: 'Choose' });
    return v && v.path && v.path.trim() ? v.path.trim() : null;
  }
  async function unsavedOk() {
    var st = L.source.state();
    var dirty = st.open.filter(function (f) { return f.dirty; });
    if (!dirty.length) return true;
    return L.confirm(dirty.length + ' file' + (dirty.length === 1 ? ' has' : 's have') + ' unsaved changes (' + dirty.map(function (f) { return f.path; }).join(', ') + '). Opening another project closes them.', { ok: 'Discard and open', danger: true });
  }
  async function open(root) {
    if (!(await unsavedOk())) return;
    L.nav.go('ide');
    var r = await L.api('/api/project/open', { path: root });
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not open that folder', true); return; }
    await L.poll();
    L.nav.go('ide');
  }
  async function openProject() {
    var p = await pickFolder('Open Project');
    if (p) open(p);
  }
  async function newProject() {
    if (!recent) { try { recent = await L.api('/api/project/recent', {}); } catch (e) { recent = null; } }
    var base = (recent && recent.defaultProjectRoot) || '';
    var v = await L.dialog({
      title: 'New Project',
      text: 'LAIN creates the folder and opens it here.',
      fields: [
        { key: 'name', label: 'Name', value: 'new-project' },
        { key: 'parent', label: 'Location', value: base, placeholder: 'D:\\projects', action: { label: 'Choose\u2026', run: function () { return pickFolder('Choose where the project lives'); } } },
      ],
      ok: 'Create',
    });
    if (!v) return;
    if (!v.parent.trim()) { L.toast('Choose a location for the project.', true); return; }
    if (!(await unsavedOk())) return;
    L.nav.go('ide');
    var r = await L.api('/api/project/create', { parent: v.parent.trim(), name: v.name.trim() });
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not create the project', true); return; }
    await L.poll();
    L.nav.go('ide');
  }

  // ---- the start screen ----------------------------------------------------------
  function loadRecent() {
    L.api('/api/project/recent', {}).then(function (r) { if (r && r.ok) { recent = r; drawRecent(); } }, function () {});
  }
  function drawRecent() {
    var box = $('ideRecent');
    box.textContent = '';
    var rows = (recent && recent.recent) || [];
    if (!rows.length) { box.appendChild(el('div', 'none', 'No recent projects.')); return; }
    rows.slice(0, 8).forEach(function (p) {
      var b = el('button', 'hrow');
      b.appendChild(L.icon('folder', 15));
      var t = el('span', 'ht', p.name); t.appendChild(el('small', '', p.root)); b.appendChild(t);
      b.onclick = function () { open(p.root); };
      box.appendChild(b);
    });
  }

  // ---- panes, panels, columns --------------------------------------------------
  function showPane(p) {
    if (pane === p && !$('main').classList.contains('side-off')) { toggleSide(); return; }
    pane = p;
    $('main').classList.remove('side-off');
    setPref('side', true);
    drawPane();
  }
  function drawPane() {
    $('paneExplorer').hidden = pane !== 'explorer';
    $('paneSearch').hidden = pane !== 'search';
    $('paneChanges').hidden = pane !== 'changes';
    $('sideTitle').textContent = pane === 'search' ? 'Search' : pane === 'changes' ? 'Changes' : 'Explorer';
    Array.prototype.forEach.call(document.querySelectorAll('.act-btn[data-pane]'), function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-pane') === pane && !$('main').classList.contains('side-off')));
    });
    if (pane === 'search') setTimeout(function () { $('fileSearch').focus(); }, 0);
  }
  function toggleSide() { var off = $('main').classList.toggle('side-off'); setPref('side', !off); drawPane(); }
  function toggleBot() {
    var m = $('main');
    if (window.innerWidth <= 900) { m.classList.toggle('show-bot'); return; }
    var off = m.classList.toggle('bot-off');
    setPref('bot', !off);
    $('botToggle').setAttribute('aria-selected', String(!off));
  }
  async function showPanel(id) {
    var s = S();
    var open = s && s.workspace ? s.workspace.openPanel : 'NONE';
    if (open === id) return;
    await L.api('/api/workspace/panel', { action: 'open', panel: id });
    L.poll();
  }
  async function togglePanel(id) {
    var s = S();
    var open = s && s.workspace ? s.workspace.openPanel : 'NONE';
    if (!id) id = DRAWER_IDS.indexOf(open) >= 0 ? open : lastPanel;
    await L.api('/api/workspace/panel', { action: open === id ? 'close' : 'open', panel: id });
    L.poll();
  }

  function renderPanel(s) {
    var bar = $('drawers'), body = $('drawer'), box = $('bpanel');
    var ws = s.workspace || {};
    var open = ws.openPanel || 'NONE';
    var panels = (ws.panels || []).filter(function (p) { return DRAWER_IDS.indexOf(p.id) >= 0 && (p.available || p.id === 'TERMINAL'); });
    if (DRAWER_IDS.indexOf(open) < 0) { box.hidden = true; return; }
    lastPanel = open;
    box.hidden = false;
    bar.textContent = '';
    panels.forEach(function (p) {
      var b = el('button', 'tab', p.label);
      if (p.badge != null) b.appendChild(el('span', 'n', p.badge));
      b.setAttribute('aria-selected', String(open === p.id));
      b.onclick = function () { togglePanel(p.id); };
      bar.appendChild(b);
    });
    bar.appendChild(el('span', 'spacer'));
    var x = el('button', 'iconbtn'); x.appendChild(L.icon('close', 14)); x.title = 'Close panel (Ctrl+J)';
    x.onclick = function () { togglePanel(open); };
    bar.appendChild(x);
    // THE TERMINAL IS THE ONE PANEL THAT PAINTS ITSELF, and repainting it on
    // every poll would throw away the line being typed into it.
    if (open === 'TERMINAL' && body.dataset.panel === 'TERMINAL' && document.activeElement && body.contains(document.activeElement)) return;
    body.dataset.panel = open;
    body.textContent = '';
    if (open === 'CHANGES') {
      if (!(s.changes || []).length) body.appendChild(el('div', 'obs', 'Nothing has changed in this session yet.'));
      (s.changes || []).forEach(function (c) {
        var r = el('button', 'row linkrow');
        r.appendChild(el('span', 'path', c.path));
        if (c.added) r.appendChild(el('span', 'add', '+' + c.added));
        if (c.removed) r.appendChild(el('span', 'del', '-' + c.removed));
        r.onclick = function () { L.source.openFile(c.path); };
        body.appendChild(r);
      });
    } else if (open === 'VERIFICATION') {
      var v = s.harness && s.harness.verification;
      if (!v) { body.appendChild(el('div', 'obs', 'No verification evidence yet.')); return; }
      var d = el('div', 'verdict');
      d.appendChild(el('b', v.verdict, v.verdict));
      d.appendChild(el('span', '', '  ' + [v.passed ? v.passed + ' passed' : '', v.failed ? v.failed + ' failed' : '', v.inconclusive ? v.inconclusive + ' inconclusive' : ''].filter(Boolean).join('  \u00b7  ')));
      body.appendChild(d);
      if (v.why) body.appendChild(el('div', 'obs', v.why));
    } else if (open === 'PLAN') {
      if (!s.plan) { body.appendChild(el('div', 'obs', 'No plan is executing in this session yet.')); return; }
      (s.plan.steps || []).forEach(function (st) {
        var r = el('div', 'row');
        r.appendChild(el('span', '', st.status === 'done' ? '\u2713' : st.status === 'active' ? '\u25b8' : '\u25cb'));
        r.appendChild(el('span', 'path', st.text));
        body.appendChild(r);
      });
    } else if (open === 'TERMINAL') {
      L.terminal.renderPanel(body);
    }
  }

  function renderChanges(s) {
    var list = s.changes || [];
    var badge = $('chgBadge');
    badge.hidden = !list.length;
    badge.textContent = list.length > 99 ? '99+' : String(list.length);
    if (pane !== 'changes') return;
    var box = $('changesList');
    var sig = JSON.stringify(list);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    if (!list.length) { box.appendChild(el('div', 'none', 'No files changed in this session.')); return; }
    list.forEach(function (c) {
      var b = el('button', 'hit', c.path.split('/').pop());
      b.appendChild(el('small', '', c.path));
      if (c.added) b.appendChild(el('span', 'add', '+' + c.added));
      if (c.removed) b.appendChild(el('span', 'del', ' -' + c.removed));
      b.onclick = function () { L.source.openFile(c.path); };
      box.appendChild(b);
    });
  }

  var findSeq = 0;
  function fileSearch() {
    var q = $('fileSearch').value.trim();
    var box = $('fileSearchHits');
    var mine = ++findSeq;
    if (!q) { box.textContent = ''; return; }
    L.api('/api/files/find', { q: q }).then(function (r) {
      if (mine !== findSeq) return;
      box.textContent = '';
      var rows = (r && r.matches) || [];
      if (!rows.length) box.appendChild(el('div', 'none', 'No file matches.'));
      rows.slice(0, 200).forEach(function (m) {
        var b = el('button', 'hit', m.path.split('/').pop());
        b.appendChild(el('small', '', m.path));
        b.onclick = function () { L.source.openFile(m.path); };
        box.appendChild(b);
      });
    }, function () {});
  }

  // ---- the BOT panel ---------------------------------------------------------------
  function renderModels(s) {
    var m = s.models || {};
    var chat = m.chat || {}, code = m.coding || {};
    var chatLabel = chat.source && chat.source !== 'lain' ? (chat.label || chat.source) + (chat.modelId ? ' \u00b7 ' + L.fmt.model(chat.modelId) : '') : L.fmt.model(chat.modelId) || 'LAIN default';
    $('botModelVal').textContent = chatLabel;
    $('botModelBtn').title = 'BOT Model \u2014 conversation, questions and planning (Chat, and the bot\u2019s channels). ' + (chat.modelId || chat.source || '');
    $('botModelScope').textContent = chat.scope === 'session' ? 'session' : 'default';
    $('codeModelVal').textContent = L.fmt.model(code.modelId) || 'not set';
    $('codeModelBtn').title = 'Coding Agent \u2014 work in this project: implementation, debugging, tests. ' + (code.modelId || '');
    $('codeModelScope').textContent = code.scope === 'session' ? 'session' : 'default';
  }

  function botMore() {
    L.popover($('botMore'), function (p) {
      var item = function (label, run) { var b = el('button', 'opt', label); b.onclick = function () { L.closePop(); run(); }; p.appendChild(b); };
      item('Continue in Chat', continueInChat);
      item('Open this session in Session', function () { L.nav.go('session'); });
      item('Model settings', function () { L.nav.go('model', { section: 'roles' }); });
    }, { alignRight: true });
  }

  /** IDE -> CHAT: the same session, its Chat thread, with a line saying where it came from. */
  function continueInChat() {
    var s = S();
    var p = s.workspace && s.workspace.project;
    var bits = [];
    if (p && p.attached) bits.push('the ' + p.name + ' project');
    if ((s.changes || []).length) bits.push((s.changes || []).length + ' changed file' + ((s.changes || []).length === 1 ? '' : 's'));
    if (s.plan && s.plan.total) bits.push('a plan at ' + s.plan.done + '/' + s.plan.total);
    var a = $('ask');
    var prefix = 'Continuing from the IDE' + (bits.length ? ' (' + bits.join(', ') + ')' : '') + ': ';
    if (a.value.indexOf('Continuing from the IDE') !== 0) a.value = prefix + a.value;
    L.nav.go('chat');
    setTimeout(function () { a.focus(); a.setSelectionRange(a.value.length, a.value.length); }, 0);
  }

  /** CHAT -> IDE: the handoff Core built when the plan was accepted. */
  function renderHandoff(s) {
    var card = $('handoffCard');
    var ui = L.ui();
    var pre = s.composer && s.composer.coding && s.composer.coding.prefill;
    var h = s.plans && s.plans.handoff;
    if (ui.mode !== 'ide' || !pre || !h || h.state !== 'PREFILLED') { card.hidden = true; card.dataset.id = ''; return; }
    if (card.dataset.id === h.id && !card.hidden) return;
    card.dataset.id = h.id;
    card.hidden = false;
    card.textContent = '';
    card.appendChild(el('h4', '', 'Continued from Chat'));
    var b = h.brief || {};
    var plan = ((s.plans && s.plans.plans) || []).filter(function (x) { return x.id === h.planId; })[0];
    var dl = el('dl', 'hk');
    var put = function (k, v, cls) { if (!v) return; dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', cls || '', v)); };
    put('Task', (plan && plan.title) || (b.goal && b.goal.text) || 'The plan agreed in Chat');
    var ctx = [];
    if (plan && plan.steps && plan.steps.length) ctx.push(plan.steps.length + ' steps');
    if (b.requirements && b.requirements.length) ctx.push(b.requirements.length + ' requirements');
    if (b.constraints && b.constraints.length) ctx.push(b.constraints.length + ' constraints');
    if (b.files && b.files.length) ctx.push(b.files.length + ' files');
    put('Context', '\u2713 imported' + (ctx.length ? ' \u00b7 ' + ctx.join(', ') : ''), 'ok');
    var p = s.workspace && s.workspace.project;
    put('Project', p && p.attached ? p.name : 'none yet \u2014 open a project first');
    put('Coding Agent', L.fmt.model(s.models && s.models.coding && s.models.coding.modelId) || 'not set');
    card.appendChild(dl);
    var row = el('div', 'choices');
    var start = el('button', 'btn primary', 'Start');
    start.disabled = !(p && p.attached);
    start.onclick = function () { L.send(); };
    var discard = el('button', 'btn', 'Discard');
    discard.onclick = async function () {
      var r = await L.api('/api/handoff/discard', {});
      if (!r.ok) L.notice(r.why, true);
      $('ask').value = '';
      L.poll();
    };
    row.appendChild(start);
    row.appendChild(discard);
    card.appendChild(row);
  }

  // ---- the status bar ------------------------------------------------------------------
  function renderStatus(s) {
    var p = s.workspace && s.workspace.project;
    $('sbProject').textContent = '';
    $('sbProject').appendChild(L.icon('folder', 13));
    $('sbProject').appendChild(el('b', '', p ? p.name : ''));
    var u = $('sbUnderstand');
    var sync = p && p.sync;
    var sig = JSON.stringify(sync || null);
    if (u.dataset.sig !== sig) {
      u.dataset.sig = sig;
      u.textContent = '';
      u.title = '';
      if (sync && sync.running) {
        u.appendChild(el('span', '', 'Understanding project\u2026'));
        u.title = 'Indexing files, declarations and imports. The editor is usable meanwhile.';
      } else if (sync && sync.why) {
        u.appendChild(el('span', '', 'Project index unavailable'));
        u.title = sync.why;
      } else if (sync && sync.state) {
        var code = Number(sync.code) || 0, scanned = Number(sync.scanned) || 0;
        if (sync.state === 'PARTIAL' && code) {
          var pct = Math.round((scanned / code) * 100);
          u.appendChild(el('span', '', 'Understood'));
          var bar = el('span', 'sb-bar'); var fill = el('i'); fill.style.width = pct + '%'; bar.appendChild(fill);
          u.appendChild(bar);
          u.appendChild(el('span', '', pct + '%'));
          u.title = scanned + ' of ' + code + ' code files scanned; ' + (code - scanned) + ' could not be read as code.';
        } else {
          u.appendChild(el('span', 'sb-ok', 'Project ready \u2713'));
          u.title = (sync.files || 0) + ' files \u00b7 ' + (sync.symbols || 0) + ' declarations indexed';
        }
      }
    }
    var f = L.source.state();
    var cur = f.active >= 0 ? f.open[f.active] : null;
    $('sbLang').textContent = cur ? cur.language : '';
    var pos = L.source.cursor();
    $('sbPos').textContent = cur && pos ? 'Ln ' + pos.line + ', Col ' + pos.col : '';
    var code2 = s.models && s.models.coding;
    $('sbModel').textContent = '';
    $('sbModel').appendChild(L.icon('model', 13));
    $('sbModel').appendChild(el('span', '', 'Coding Agent: ' + (L.fmt.model(code2 && code2.modelId) || 'not set')));
  }

  // ---- the frame -----------------------------------------------------------------------------
  function render(s) {
    var showing = L.nav.tab() === 'ide';
    var ws = attached();
    $('ideStart').hidden = ws;
    $('main').hidden = !ws;
    $('ideStatus').hidden = !ws;
    L.source.sync(ws && showing, ws ? s.workspace.project.root : null);
    if (!showing) return;
    if (!ws) {
      L.mountConvo(null, 'ide');
      var h = s.plans && s.plans.handoff;
      var ho = $('isHandoff');
      if (h && h.state === 'PREFILLED' && s.current.lane === 'engineering') {
        ho.hidden = false;
        ho.textContent = '';
        ho.appendChild(el('b', '', 'A task from Chat is waiting. '));
        ho.appendChild(document.createTextNode('Open or create its project and the BOT will pick it up with the context agreed in Chat.'));
      } else ho.hidden = true;
      return;
    }
    L.mountConvo($('ideBotHost'), 'ide');
    $('sideProj').textContent = s.workspace.project.name;
    $('sideProj').title = s.workspace.project.root;
    renderModels(s);
    renderPanel(s);
    renderChanges(s);
    renderHandoff(s);
    renderStatus(s);
  }

  L.ide = {
    open: open, openProject: openProject, newProject: newProject, pickFolder: pickFolder,
    quickOpen: function () { if (attached()) L.source.quickOpen(); },
    closeEditor: function () { L.source.closeActive(); },
    find: function () { L.source.findPrompt(); },
    toggleSide: toggleSide, togglePanel: function () { return togglePanel(null); }, toggleBot: toggleBot, showPanel: showPanel,
  };

  L.onBoot(function () {
    $('isMark').appendChild(L.icon('ide', 34));
    $('ideNewIc').appendChild(L.icon('plus', 19));
    $('ideOpenIc').appendChild(L.icon('folder', 19));
    $('ideNew').onclick = newProject;
    $('ideOpen').onclick = openProject;
    var icons = { explorer: 'files', search: 'search', changes: 'changes' };
    Array.prototype.forEach.call(document.querySelectorAll('.act-btn[data-pane]'), function (b) {
      b.insertBefore(L.icon(icons[b.getAttribute('data-pane')], 20), b.firstChild);
      b.onclick = function () { showPane(b.getAttribute('data-pane')); };
    });
    $('wsPill').appendChild(L.icon('preview', 20));
    $('botToggle').appendChild(L.icon('bot', 20));
    $('botToggle').onclick = toggleBot;
    $('sideRefresh').appendChild(L.icon('refresh', 14));
    $('sideRefresh').onclick = function () { L.source.loadRoot(); };
    $('botGear').appendChild(L.icon('gear', 15));
    $('botMore').appendChild(L.icon('chevron', 15));
    $('botGear').onclick = function () { var c = $('botModels').classList.toggle('collapsed'); setPref('models', !c); };
    $('botMore').onclick = botMore;
    $('botModelBtn').onclick = function () { L.models.pickBot($('botModelBtn')); };
    $('codeModelBtn').onclick = function () { L.models.pickCoding($('codeModelBtn')); };
    $('fileSearch').addEventListener('input', fileSearch);
    if (!pref('side', true)) $('main').classList.add('side-off');
    if (!pref('bot', true)) $('main').classList.add('bot-off');
    if (!pref('models', true)) $('botModels').classList.add('collapsed');
    $('botToggle').setAttribute('aria-selected', String(pref('bot', true)));
    drawPane();
    L.nav.onShow('ide', function () { loadRecent(); });
    document.addEventListener('keydown', function (e) {
      if (L.nav.tab() !== 'ide' || !attached()) return;
      var ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); toggleSide(); }
      else if (ctrl && !e.shiftKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); togglePanel(null); }
      else if (ctrl && e.key === '`') { e.preventDefault(); togglePanel('TERMINAL'); }
      else if (ctrl && e.altKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); toggleBot(); }
      else if (ctrl && e.shiftKey && (e.key === 'E' || e.key === 'e')) { e.preventDefault(); showPane('explorer'); }
      else if (ctrl && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); showPane('search'); }
      else if (ctrl && !e.shiftKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); L.source.closeActive(); }
    });
  });
  L.onRender(render);
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
