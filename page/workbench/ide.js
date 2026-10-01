'use strict';

/**
 * THE IDE — a familiar editor with the Coding Agent beside it (Phase 8).
 *
 * The IDE is OPTIONAL for agentic coding: the same Coding Agent task is in
 * CHAT › Coding Agent, here, and in the CLI. Here its sidecar is narrow by
 * default (~320px), resizable and fully hideable, so the editor keeps the
 * majority of the width; "Coding Chat" swaps the editor for the full Agent
 * conversation and back. The assistant (Chat) appears in the IDE only as the
 * small floating messenger (pageassist.js) — the right side is the Agent's.
 *
 * ------------------------------------------------------------------------
 * A REAL IDE FIRST (Phase 8.2). It opens on the EXPLORER — Open Editors and
 * the project tree — never on Source Control; editor tabs with a context menu
 * and a preview tab, breadcrumbs, split editors, a bottom panel (Problems ·
 * Output · Terminal · Debug Console), Run and Debug as an activity, a status
 * bar that names the ACCOUNT before the model. The Coding Agent sidecar is
 * optional and narrow; the IDE works without it. Familiar keys: Ctrl+P,
 * Ctrl+Shift+P, Ctrl+S, Ctrl+B, Ctrl+J, Ctrl+`, F5, Ctrl+\\.
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
      <p class="is-sub">Open a folder to browse, edit and build it with the Coding Agent beside you.</p>
      <div class="is-actions">
        <button class="is-btn" id="ideNew"><span class="ib-ic" id="ideNewIc"></span><span><b>New Project</b><small>Choose where it lives; Noema creates it</small></span></button>
        <button class="is-btn" id="ideOpen"><span class="ib-ic" id="ideOpenIc"></span><span><b>Open Folder</b><small>Pick an existing folder</small></span></button>
      </div>
      <div class="is-handoff" id="isHandoff" hidden></div>
      <div class="is-recent"><h2>Recent</h2><div id="ideRecent"></div></div>
    </div>
  </div>
  <div class="ide" id="main" hidden>
    <nav class="activity" id="activity" aria-label="IDE">
      <button class="act-btn" data-pane="explorer" title="Explorer (Ctrl+Shift+E)"></button>
      <button class="act-btn" data-pane="search" title="Search (Ctrl+Shift+F)"></button>
      <button class="act-btn" data-pane="scm" title="Source Control (Ctrl+Shift+G)"><span class="act-badge" id="chgBadge" hidden></span></button>
      <button class="act-btn" data-pane="run" title="Run and Debug (Ctrl+Shift+D)"></button>
      <button class="act-btn" data-pane="extensions" title="Extensions (Ctrl+Shift+X)"></button>
      <button class="act-btn" id="wsPill" title="Preview (Ctrl+Shift+V)"></button>
      <span class="spacer"></span>
      <button class="act-btn" id="botToggle" title="Hide / show the sidecar — Chat and the Coding Agent (Ctrl+Alt+B)"></button>
      <button class="act-btn" id="ideSettings" title="Settings"></button>
    </nav>
    <aside class="side" id="ideSide">
      <div class="side-head"><span id="sideTitle">Explorer</span><span class="spacer"></span><span class="side-acts" id="sideActs"></span><button class="iconbtn" id="sideRefresh" title="Refresh"></button></div>
      <div class="side-body side-explorer" id="paneExplorer">
        <div class="xsec" id="xOpen"><button class="xsec-h" id="xOpenHead" aria-expanded="true"><span class="tw">\u25be</span><span>Open Editors</span><span class="xn" id="xOpenN"></span></button><div class="xsec-b" id="xOpenList"></div></div>
        <div class="xsec xsec-tree"><button class="xsec-h" id="xTreeHead" aria-expanded="true" title="The project folder"><span class="tw">\u25be</span><span class="side-proj" id="sideProj"></span></button><div class="xsec-b xsec-fill">${require('./source').TREE_HTML}</div></div>
      </div>
      <div class="side-body" id="paneSearch" hidden></div>
      <div class="side-body" id="paneScm" hidden></div>
      <div class="side-body" id="paneRun" hidden></div>
      <div class="side-body" id="paneExtensions" hidden></div>
    </aside>
    <div class="editor-col">
      <div class="coding-center" id="ideCodingHost" hidden><div class="cc-bar"><button class="u-btn sm ghost" id="centerEditor" title="Back to the editor"><span id="centerEditorIc"></span>Editor</button><span class="cc-title"><span id="ccTitleIc"></span>Coding Chat</span><span class="spacer"></span><span class="cc-note">The same task as the sidecar and Chat \u203a Coding Agent</span><span class="spacer"></span><button class="u-btn sm ghost" id="centerToChat" title="Open it in Chat, with the conversations beside it">Open in Chat</button></div></div>
      <div class="editor-area" id="editorArea">
        ${require('./source').PANE_HTML}
        <div class="pv-slot" id="pvSlotIde"></div>
      </div>
      <div class="bpanel" id="bpanel" hidden>
        <div class="bp-tabs" id="drawers"></div>
        <div class="bp-body" id="drawer"></div>
      </div>
    </div>
    <aside class="botpanel" id="ideBot">
      <div class="agent-resize" id="agentResize" title="Drag to resize"></div>
      <div class="bp-head">
        <div class="bp-sidetabs" id="sideTabs"></div>
        <span class="spacer"></span>
        <button class="u-ib" id="agentWide" aria-label="Open the full Coding Chat"></button>
        <button class="u-ib" id="agentHide" aria-label="Minimize — it keeps running"></button>
        <button class="u-ib" id="botMore" aria-label="More"></button>
      </div>
      <div class="bp-task" id="agentTask" hidden></div>
      <div class="bp-convo" id="ideBotHost"></div>
    </aside>
    <button class="chat-dock" id="chatDock" hidden><span class="cd-ic" id="chatDockIc"></span><span class="cd-t">Chat</span><span class="cd-dot" id="chatDockDot" hidden></span></button>
  </div>
  <footer class="statusbar" id="ideStatus" hidden>
    <span class="sb-item" id="sbProject"></span>
    <button class="sb-item sb-btn" id="sbBranch" title="Source Control"></button>
    <button class="sb-item sb-btn" id="sbProblems" title="Problems"></button>
    <span class="sb-item" id="sbUnderstand"></span>
    <span class="spacer"></span>
    <span class="sb-item" id="sbPos"></span>
    <span class="sb-item" id="sbEnc"></span>
    <span class="sb-item" id="sbEol"></span>
    <span class="sb-item" id="sbLang"></span>
    <button class="sb-item sb-btn sb-model" id="sbModel" title="Coding Agent model"></button>
  </footer>
</section>`;

const CSS = `
.idev{display:grid;grid-template-rows:1fr auto;min-height:0;background:var(--canvas)}
/* ---- no project yet: open a folder ---------------------------------------------------------------- */
.ide-start{display:grid;place-items:center;overflow-y:auto;min-height:0}
.is-in{width:min(560px,calc(100vw - 48px));padding:40px 0}
.is-mark{color:var(--accent-primary);margin-bottom:12px}
.is-in h1{font:600 22px/1.2 var(--display);margin:0 0 4px}
.is-sub{color:var(--text-secondary);margin:0 0 20px;font-size:13.5px}
.is-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.is-btn{display:flex;gap:12px;align-items:center;padding:14px;border-radius:var(--radius-md);background:var(--surface-base);box-shadow:inset 0 0 0 1px var(--separator);text-align:left}
.is-btn:hover{background:var(--surface-raised)}
.is-btn b{display:block;font-size:13.5px}
.is-btn small{display:block;color:var(--text-muted);font-size:12px;margin-top:2px}
.ib-ic{width:34px;height:34px;border-radius:var(--radius-sm);background:var(--selection);color:var(--accent-primary);display:grid;place-items:center;flex:none}
#ideOpen .ib-ic{background:var(--accent-primary);color:var(--on-accent)}
.is-handoff{margin-top:16px;padding:10px 12px;border-radius:var(--radius-md);background:var(--selection);font-size:12.5px;color:var(--text-secondary)}
.is-handoff b{color:var(--text-primary)}
.is-recent{margin-top:24px;padding:12px 14px;border-radius:var(--radius-md);background:var(--surface-base);box-shadow:inset 0 0 0 1px var(--separator)}
.is-recent h2{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted);margin:0 0 4px;font-weight:600}

/* ---- THE WORKBENCH: flat planes on the canvas (activity · explorer · editor/panel · sidecar) ---------------- */
.ide{--agent-w:340px;--side-w:256px;position:relative;display:grid;grid-template-columns:48px var(--side-w) minmax(0,1fr) var(--agent-w);padding:6px 6px 0 0;min-height:0}
.ide.side-off{grid-template-columns:48px 0 minmax(0,1fr) var(--agent-w)}
.ide.center-chat{grid-template-columns:48px var(--side-w) minmax(0,1fr) 0}
.ide.center-chat.side-off{grid-template-columns:48px 0 minmax(0,1fr) 0}
.ide.bot-off{grid-template-columns:48px var(--side-w) minmax(0,1fr) 0}
.ide.side-off.bot-off{grid-template-columns:48px 0 minmax(0,1fr) 0}
/* EACH PANE KEEPS ITS OWN COLUMN: hiding one only hides it (a hidden pane once slid the editor into a 0-wide column). */
.ide > .activity{grid-column:1}
.ide > .side{grid-column:2}
.ide > .editor-col{grid-column:3}
.ide > .botpanel{grid-column:4}
.ide.center-chat .botpanel,.ide.side-off .side,.ide.bot-off .botpanel{display:none}
/* A PLANE: its own flat colour, IDE-chrome corners (8 px), a hairline drawn over its content. */
.ide .side,.ide .editor-area,.ide .coding-center,.ide .bpanel,.ide .botpanel{background:var(--surface-base);border-radius:8px;outline:1px solid var(--separator);outline-offset:-1px;overflow:hidden}
.ide .side{margin-right:6px}
.ide .botpanel{margin-left:6px}
/* HIDING THE SIDECAR IS PRESENTATION ONLY: the editor takes the room, the Agent keeps working, one button brings it back. */
.show-agent{display:none;align-items:center;gap:6px}
.srcActs .show-agent{display:none}
.ide.bot-off .srcActs .show-agent{display:inline-flex}

/* ---- the activity bar: icons on the canvas, the chosen one on a raised tile ------------------------------------ */
.activity{display:flex;flex-direction:column;align-items:center;gap:4px;padding:2px 0 8px}
.act-btn{position:relative;width:38px;height:38px;border-radius:9px;display:grid;place-items:center;color:var(--nav-muted);transition:background var(--t-hover) var(--ease),color var(--t-hover) var(--ease)}
.act-btn:hover{color:var(--nav-text);background:color-mix(in srgb,var(--nav-text) 5%,transparent)}
.act-btn[aria-selected=true]{color:var(--nav-text);background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--separator)}
.act-btn:disabled{opacity:.35}
.act-badge{position:absolute;right:2px;bottom:2px;min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:var(--accent-primary);color:var(--on-accent);font-size:9px;font-weight:700;display:grid;place-items:center}

/* ---- the explorer and its friends ---------------------------------------------------------------------------- */
.side{display:flex;flex-direction:column;min-height:0}
.side-head{display:flex;align-items:center;height:40px;padding:0 6px 0 14px;font-size:var(--fs-ide);font-weight:600;color:var(--text-primary);flex:none}
.side-acts{display:flex;gap:1px}
.side-acts .iconbtn,.side-head .iconbtn{width:24px;height:24px;border-radius:6px}
.side-body{flex:1;min-height:0;overflow:auto}
.side-explorer{display:flex;flex-direction:column;overflow:hidden}
.xsec{display:flex;flex-direction:column;min-height:0;border-top:1px solid var(--separator)}
.xsec:first-child{border-top:0}
.xsec-tree{flex:1}
.xsec-h{display:flex;align-items:center;gap:4px;width:100%;height:26px;padding:0 10px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-secondary);text-align:left;flex:none}
.xsec-h:hover{color:var(--text-primary)}
.xsec-h .tw{width:12px;color:var(--text-muted);font-size:9px;transition:transform var(--t-hover) var(--ease)}
.xsec-h[aria-expanded=false] .tw{transform:rotate(-90deg)}
.xsec-h .xn{margin-left:auto;font-weight:500;color:var(--text-muted);letter-spacing:0}
.xsec-b{min-height:0}
.xsec-h[aria-expanded=false] + .xsec-b{display:none}
.xsec-fill{flex:1;overflow:auto}
#xOpenList{max-height:30vh;overflow:auto;padding-bottom:4px}
.oe{display:flex;align-items:center;gap:6px;width:100%;height:24px;padding:0 6px 0 22px;font-size:var(--fs-ide);color:var(--text-secondary);text-align:left;white-space:nowrap}
.oe:hover{background:var(--hover);color:var(--text-primary)}
.oe[aria-current=true]{background:var(--selection);color:var(--text-primary)}
.oe .nm{overflow:hidden;text-overflow:ellipsis}
.oe .dir{color:var(--text-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis}
.oe .x{margin-left:auto;width:18px;height:18px;border-radius:var(--radius-xs);display:grid;place-items:center;color:var(--text-muted);visibility:hidden}
.oe:hover .x,.oe .x.dirty{visibility:visible}
.oe .x:hover{background:var(--surface-active);color:var(--text-primary)}
.oe .x.dirty::before{content:'●';font-size:10px;color:var(--text-secondary)}
.oe .x.dirty:hover::before{content:''}
.side-proj{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hits .hit{display:block;width:100%;text-align:left;padding:3px 12px;font-size:var(--fs-ide);color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hits .hit:hover{background:var(--hover);color:var(--text-primary)}
.hits .hit small{color:var(--text-muted);margin-left:6px;font-size:11px}
.hits .hit .add{margin-left:6px}
.hits .none{padding:8px 12px;color:var(--text-muted);font-size:12px}

/* ---- the editor column: the editor plane (or the full Coding Chat) over the panel plane ---------------------- */
.editor-col{display:grid;grid-template-rows:minmax(0,1fr) auto;row-gap:6px;min-width:0;min-height:0}
.editor-col > .editor-area,.editor-col > .coding-center{grid-row:1}
.editor-col > .bpanel{grid-row:2}
.editor-area{display:grid;grid-template-columns:minmax(0,1fr);min-height:0;min-width:0}
/* THE PREVIEW TAKES THE LARGER SHARE: a page shrunk into a strip is a thumbnail, not a preview. */
.ide.with-workshop .editor-area{grid-template-columns:minmax(240px,1fr) minmax(420px,60%)}
#pvSlotIde{display:none}
.ide.with-workshop #pvSlotIde{display:block;margin:4px 4px 4px 0}
.coding-center{display:flex;flex-direction:column;min-height:0;min-width:0}
.ide.center-chat .editor-area{display:none}
.cc-bar{display:flex;align-items:center;gap:10px;height:40px;padding:0 10px;border-bottom:1px solid var(--separator);flex:none}
.cc-title{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-ide);font-weight:600;color:var(--text-primary)}
.cc-title .ic{color:var(--accent-primary)}
.cc-note{font-size:11.5px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bpanel{height:clamp(150px,30vh,420px);display:grid;grid-template-rows:auto 1fr;min-height:0}
.bp-tabs{display:flex;align-items:center;gap:2px;padding:0 6px 0 8px;height:38px;border-bottom:1px solid var(--separator)}
.bp-tabs .tsep{width:1px;height:14px;background:var(--border-subtle);margin:0 6px}
.bp-tabs .tab{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:6px;font-size:var(--fs-ide);color:var(--text-secondary);transition:background var(--t-hover) var(--ease),color var(--t-hover) var(--ease)}
.bp-tabs .tab:hover{color:var(--text-primary);background:var(--hover)}
.bp-tabs .tab[aria-selected=true]{color:var(--text-primary);background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--separator)}
.bp-tabs .tab .n{min-width:17px;height:17px;padding:0 5px;border-radius:9px;background:var(--surface-active);color:var(--text-secondary);font-size:10.5px;font-weight:600;display:inline-grid;place-items:center}
.bp-tabs .tab .n.err{background:var(--danger);color:#fff}
.bp-tabs .iconbtn{width:26px;height:26px;border-radius:6px}
.bp-body{overflow:auto;padding:8px 12px;min-height:0}
/* QUICK CHANGES in the Changes panel: the request, the files it touched, whether it landed. */
.qc-h{margin:4px 0 6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted)}
.qc-h + .qc-h,.qc-row + .qc-h{margin-top:12px}
.qc-row{display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px;padding:6px 0;border-top:1px solid var(--separator)}
.qc-row:first-of-type{border-top:0}
.qc-ic{display:flex;padding-top:2px;color:var(--positive)} .qc-row.bad .qc-ic{color:var(--warning)}
.qc-t b{display:block;font-size:var(--fs-ide);font-weight:500;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qc-t small{display:block;font-size:11.5px;color:var(--text-muted)}
.qc-files{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.qc-file{padding:1px 7px;border-radius:5px;background:var(--surface-raised);font:11.5px/1.5 var(--mono);color:var(--text-secondary)}
.qc-file:hover{color:var(--text-primary);box-shadow:inset 0 0 0 1px var(--accent-border)}
.qc-why{font-size:11.5px;color:var(--warning)}
.outp{display:grid;grid-template-rows:auto minmax(0,1fr);height:100%;min-height:0}
.outp .obar{display:flex;align-items:center;gap:8px;padding:0 0 6px}
.outp select{background:var(--surface-raised);border:0;box-shadow:inset 0 0 0 1px var(--border-subtle);border-radius:6px;padding:3px 6px;font-size:12px;color:var(--text-primary)}
.outp pre{margin:0;overflow:auto;font:12px/1.5 var(--mono);white-space:pre-wrap;color:var(--text-secondary);min-height:0}

/* ---- the sidecar: Chat | Coding Agent — compact, IDE-scale, resizable, hideable ------------------------------- */
.botpanel{position:relative;display:flex;flex-direction:column;min-height:0;min-width:0;overflow:visible!important}
.agent-resize{position:absolute;left:-6px;top:0;bottom:0;width:6px;cursor:col-resize;z-index:5;border-radius:3px;transition:background var(--t-hover) var(--ease)}
.agent-resize:hover,.agent-resize.drag{background:var(--accent-border)}
.bp-head{display:flex;align-items:center;gap:2px;height:44px;padding:0 6px 0 8px;border-bottom:1px solid var(--separator);flex:none}
.bp-head .u-ib{width:26px;height:26px;border-radius:6px}
.bp-sidetabs .u-seg{padding:2px}
.bp-sidetabs .u-seg > button{padding:4px 11px;font-size:var(--fs-ide)}
.bp-sidetabs .u-seg .run{width:6px;height:6px;border-radius:50%;background:var(--accent-primary);animation:lain-pulse 1.4s var(--ease) infinite}
.bp-sidetabs .u-seg .run[hidden]{display:none}
/* THE TASK STRIP: TASK · phase · state, the task, a thin progress line — and what to do with it. Never a big card. */
.bp-task{flex:none;margin:8px 8px 0;padding:10px 12px;border-radius:8px;background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--separator);font-size:12.5px;color:var(--text-secondary);max-height:36vh;overflow:auto;min-width:0}
.bp-task .tk-top{display:flex;align-items:center;gap:8px;min-width:0}
.bp-task .tk-label{font-size:10.5px;font-weight:700;letter-spacing:.14em;color:var(--text-muted)}
.bp-task .tk-phase{font-size:11.5px;color:var(--text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.bp-task .tk-state{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;color:var(--text-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bp-task .tk-state i{width:7px;height:7px;border-radius:50%;background:var(--text-muted);flex:none}
.bp-task .tk-state.run{color:var(--accent-secondary)} .bp-task .tk-state.run i{background:var(--accent-secondary);animation:lain-pulse 1.4s var(--ease) infinite}
.bp-task .tk-state.warn{color:var(--warning)} .bp-task .tk-state.warn i{background:var(--warning)} .bp-task .tk-state.ok{color:var(--positive)} .bp-task .tk-state.ok i{background:var(--positive)}
.bp-task b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--text-primary);font-size:13px;font-weight:600;line-height:1.4;margin-top:6px;overflow-wrap:anywhere}
.bp-task .tk-prog{display:flex;align-items:center;gap:10px;margin-top:8px}
.bp-task .tk-prog .bar{flex:1;height:4px;border-radius:2px;background:color-mix(in srgb,var(--text-primary) 9%,transparent);overflow:hidden}
.bp-task .tk-prog .bar i{display:block;height:100%;border-radius:2px;background:var(--accent-secondary);transition:width var(--t-panel) var(--ease)}
.bp-task .tk-prog span{font-size:11px;color:var(--text-muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.bp-task .tk-sum{margin-top:6px;font-size:12px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.bp-task .tk-auto{margin-top:4px;font-size:11.5px;color:var(--accent-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bp-task .steps{margin-top:8px}
.bp-task .tk-step{display:flex;gap:8px;align-items:flex-start;padding:3px 0;line-height:1.45;font-size:12px}
.bp-task .tk-step > span:last-child{flex:1;min-width:0;overflow-wrap:anywhere}
.bp-task .tk-step .m{width:14px;height:14px;margin-top:1px;border-radius:4px;box-shadow:inset 0 0 0 1.5px var(--text-muted);flex:none;display:grid;place-items:center;font-size:10px;color:var(--on-secondary)}
.bp-task .tk-step .m.done{background:var(--accent-secondary);box-shadow:none}
.bp-task .tk-step .m.active{box-shadow:inset 0 0 0 1.5px var(--accent-secondary)}
.bp-task .tk-step .m.active::after{content:'';width:6px;height:6px;border-radius:50%;background:var(--accent-secondary)}
.bp-task .tk-step.active > span:last-child{color:var(--text-primary)}
.bp-task .tk-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;align-items:center}
.bp-task .tk-acts button{white-space:nowrap;font-size:12px;padding:4px 10px;border-radius:6px;background:var(--surface-active);color:var(--text-primary)}
.bp-task .tk-acts button:hover{background:var(--border-subtle)}
.bp-task .tk-acts button.pri{background:var(--accent-primary);color:var(--on-accent);font-weight:600}
.bp-task .tk-acts button.quiet{background:transparent;color:var(--text-secondary);padding:4px 4px}
@media (max-height:600px){.bp-task{padding:8px 10px;max-height:26vh}.bp-task .tk-sum,.bp-task .tk-acts .quiet{display:none}}
/* THE MINIMISED SIDECAR: "Chat", built into the lower-right edge of the workbench — never a floating button. */
.chat-dock{position:absolute;right:0;bottom:12px;z-index:20;display:flex;align-items:center;gap:8px;height:38px;padding:0 16px 0 14px;border-radius:19px 0 0 19px;background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--border-subtle),var(--shadow-float);color:var(--text-primary);font-size:var(--fs-ide);font-weight:600;transition:padding var(--t-hover) var(--ease),background var(--t-hover) var(--ease);animation:lain-dock var(--t-panel) var(--ease)}
.chat-dock[hidden]{display:none}
.chat-dock:hover{padding-right:22px;background:var(--surface-active)}
.chat-dock .cd-ic{display:flex;color:var(--accent-primary)}
.chat-dock .cd-dot{width:8px;height:8px;border-radius:50%;background:var(--accent-primary)}
.chat-dock .cd-dot.run{animation:lain-pulse 1.4s var(--ease) infinite}
.chat-dock .cd-dot.warn{background:var(--warning)} .chat-dock .cd-dot.unread{background:var(--info)}
@keyframes lain-dock{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
/* "This requires code changes. Move to Agent?" and a task handed over from Chat */
.card.propose .pq{font-weight:600;margin:0 0 4px}
.card.propose .pt{font-size:12.5px;color:var(--text-secondary);margin:0 0 10px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow:auto}
.card.handoff{box-shadow:inset 2px 0 0 var(--accent-primary)}
.card.handoff h4{margin:0 0 6px;font-size:12px}
.card.handoff .hk{display:grid;grid-template-columns:92px 1fr;gap:3px 10px;font-size:12.5px;margin:6px 0 10px}
.card.handoff .hk dt{color:var(--text-muted)} .card.handoff .hk dd{margin:0;color:var(--text-primary);overflow-wrap:anywhere}
.card.handoff .ok{color:var(--positive)}

/* ---- the status bar: small type on the canvas ------------------------------------------------------------------ */
.statusbar{display:flex;align-items:center;gap:1px;height:24px;padding:0 8px;background:var(--canvas);font-size:11.5px;color:var(--nav-muted)}
.sb-item{display:flex;align-items:center;gap:5px;padding:0 7px;white-space:nowrap;min-width:0}
.sb-item b{color:var(--nav-text);font-weight:500}
.sb-ok{color:var(--positive)}
.sb-bar{display:inline-block;position:relative;width:80px;height:4px;border-radius:2px;background:color-mix(in srgb,var(--nav-text) 14%,transparent);overflow:hidden}
.sb-bar i{position:absolute;left:0;top:0;bottom:0;background:var(--accent-primary)}
.sb-btn{height:100%;border-radius:4px;color:var(--nav-muted)}
.sb-btn:hover{background:color-mix(in srgb,var(--nav-text) 8%,transparent);color:var(--nav-text)}
.sb-model{max-width:340px;overflow:hidden;text-overflow:ellipsis}
.sb-err{color:var(--danger)} .sb-warn{color:var(--warning)}
@media (max-width: 1100px){.ide{--side-w:230px}}
@media (max-width: 900px){.ide,.ide.bot-off{grid-template-columns:48px 0 minmax(0,1fr) 0}.ide .side,.ide .botpanel{display:none}.ide.show-bot{grid-template-columns:48px 0 0 minmax(0,1fr)}.ide.show-bot .botpanel{display:flex;margin-left:0}.ide.show-bot .editor-col{display:none}.sb-model{max-width:180px}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var pane = 'explorer';
  var recent = null;
  // THE BOTTOM PANEL: the IDE's four, then LAIN's own (Changes, Plan, Verification) after a separator.
  var DRAWER_IDS = ['PROBLEMS', 'OUTPUT', 'TERMINAL', 'DEBUG', 'CHANGES', 'PLAN', 'VERIFICATION'];
  var IDE_PANELS = ['PROBLEMS', 'OUTPUT', 'TERMINAL', 'DEBUG', 'CHANGES'];
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
      text: 'Noema creates the folder and opens it here.',
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
  var PANES = { explorer: ['paneExplorer', 'Explorer'], search: ['paneSearch', 'Search'], scm: ['paneScm', 'Source Control'], run: ['paneRun', 'Run and Debug'], extensions: ['paneExtensions', 'Extensions'] };
  var mounted = {};
  /** Show a side pane; clicking the one already showing hides the side bar, as in VS Code. */
  function showPane(p, force) {
    if (!PANES[p]) return;
    if (!force && pane === p && !$('main').classList.contains('side-off')) { toggleSide(); return; }
    pane = p;
    $('main').classList.remove('side-off');
    setPref('side', true);
    drawPane();
  }
  function drawPane() {
    Object.keys(PANES).forEach(function (k) { $(PANES[k][0]).hidden = pane !== k; });
    $('sideTitle').textContent = PANES[pane][1];
    $('sideRefresh').hidden = pane === 'search';
    drawSideActs();
    Array.prototype.forEach.call(document.querySelectorAll('.act-btn[data-pane]'), function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-pane') === pane && !$('main').classList.contains('side-off')));
    });
    if (!attached()) return;
    if (pane === 'search') {
      if (!mounted.search) { mounted.search = true; L.panes.mountSearch($('paneSearch')); }
      setTimeout(function () { var q = $('paneSearchQ'); if (q) { q.focus(); q.select(); } }, 0);
    } else if (pane === 'scm') {
      if (!mounted.scm) { mounted.scm = true; L.panes.mountScm($('paneScm')); } else L.panes.refreshScm();
    } else if (pane === 'run') {
      L.panes.mountRun($('paneRun'));
      if (L.debug && L.debug.refresh) L.debug.refresh();
    } else if (pane === 'extensions' && L.extensions) {
      L.extensions.mount($('paneExtensions'));
    }
  }
  function refreshPane() {
    if (pane === 'explorer') L.source.loadRoot();
    else if (pane === 'scm') L.panes.refreshScm();
    else if (pane === 'run') L.panes.mountRun($('paneRun'));
    else if (pane === 'extensions' && L.extensions) L.extensions.mount($('paneExtensions'));
  }
  function toggleSide() { var off = $('main').classList.toggle('side-off'); setPref('side', !off); drawPane(); }
  function toggleBot() {
    var m = $('main');
    if (window.innerWidth <= 900) { m.classList.toggle('show-bot'); return; }
    var off = m.classList.toggle('bot-off');
    setPref('bot', !off);
    $('botToggle').setAttribute('aria-selected', String(!off));
    if (!off && sideTab === 'chat') seenChat = chatCount(S());
    paintDock(S());
    if (L.editor && L.editor.layout) setTimeout(function () { L.editor.layout(); }, 0);
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
    setPref('panelClosed', open === id);
    await L.api('/api/workspace/panel', { action: open === id ? 'close' : 'open', panel: id });
    L.poll();
  }

  function renderPanel(s) {
    var bar = $('drawers'), body = $('drawer'), box = $('bpanel');
    var ws = s.workspace || {};
    var open = ws.openPanel || 'NONE';
    // THE IDE'S FIVE ARE ALWAYS THERE (Problems · Output · Terminal · Debug Console · Changes); Plan and Verification when they exist.
    var panels = (ws.panels || []).filter(function (p) { return DRAWER_IDS.indexOf(p.id) >= 0 && (p.available || p.id === 'TERMINAL' || p.id === 'CHANGES'); });
    if (DRAWER_IDS.indexOf(open) < 0) { box.hidden = true; return; }
    lastPanel = open;
    box.hidden = false;
    bar.textContent = '';
    panels.sort(function (a, b) { return DRAWER_IDS.indexOf(a.id) - DRAWER_IDS.indexOf(b.id); });
    var sepDone = false;
    panels.forEach(function (p) {
      var lainOwn = IDE_PANELS.indexOf(p.id) < 0;
      if (lainOwn && !sepDone) { bar.appendChild(el('span', 'tsep')); sepDone = true; }
      var b = el('button', 'tab' + (lainOwn ? ' lain' : ''), p.label);
      if (p.badge != null) b.appendChild(el('span', 'n', p.badge));
      b.setAttribute('aria-selected', String(open === p.id));
      b.onclick = function () { if (open !== p.id) togglePanel(p.id); };
      bar.appendChild(b);
    });
    bar.appendChild(el('span', 'spacer'));
    var x = el('button', 'iconbtn'); x.appendChild(L.icon('close', 14)); x.title = 'Close panel (Ctrl+J)';
    x.onclick = function () { togglePanel(open); };
    bar.appendChild(x);
    // THE TERMINAL PAINTS ITSELF. With xterm (pagexterm.js) its screen is one
    // DOM that must survive every poll; the built-in view only needs the line
    // being typed protected.
    if (open === 'TERMINAL' && L.xterm && L.xterm.available()) {
      if (body.dataset.panel !== 'TERMINAL' || !body.contains(L.xterm.host())) { body.dataset.panel = 'TERMINAL'; L.xterm.mount(body); }
      return;
    }
    if (L.xterm) L.xterm.unmount(body);
    if (open === 'TERMINAL' && body.dataset.panel === 'TERMINAL' && document.activeElement && body.contains(document.activeElement)) return;
    // THE DEBUG PANEL keeps a watch or console line being typed.
    if (open === 'DEBUG' && body.dataset.panel === 'DEBUG' && L.debug && L.debug.busy(body)) return;
    body.dataset.panel = open;
    body.textContent = '';
    if (open === 'DEBUG') {
      // THE DEBUG CONSOLE is the bottom panel's; stack, variables, watch and breakpoints are Run and Debug's.
      if (L.debug) (L.debug.renderConsole || L.debug.renderPanel)(body);
    } else if (open === 'OUTPUT') {
      outputPanel(body);
    } else if (open === 'PROBLEMS') {
      L.panes.problemsPanel(body);
    } else if (open === 'CHANGES') {
      // QUICK CHANGES FIRST (changeclass.js): a small edit's result, without a conversation around it.
      var qc = (s.quickChanges || []).slice().reverse();
      if (qc.length) {
        body.appendChild(el('div', 'qc-h', 'Quick changes'));
        qc.slice(0, 6).forEach(function (q) {
          var row = el('div', 'qc-row' + (q.ok ? '' : ' bad'));
          var mk = el('span', 'qc-ic'); mk.appendChild(L.icon(q.ok ? 'done' : 'warn', 14)); row.appendChild(mk);
          var t = el('div', 'qc-t');
          t.appendChild(el('b', '', q.text || 'A change'));
          var meta = el('small', '', (q.class === 'DIRECT' ? 'Direct' : 'Narrow') + (q.fromPreview ? ' · from Preview' : '') + ' · ' + (q.ok ? (q.files.length + ' file' + (q.files.length === 1 ? '' : 's')) : (q.why || 'did not land')) + (q.ms ? ' · ' + Math.max(1, Math.round(q.ms / 1000)) + ' s' : ''));
          t.appendChild(meta);
          var fl = el('div', 'qc-files');
          (q.files || []).slice(0, 4).forEach(function (f) { var b = el('button', 'qc-file', f); b.onclick = function () { L.source.openFile(f); }; fl.appendChild(b); });
          if ((q.failed || []).length) fl.appendChild(el('span', 'qc-why', q.failed.map(function (x) { return x.tool + ': ' + String(x.verdict).toLowerCase(); }).join(' · ')));
          t.appendChild(fl);
          row.appendChild(t);
          body.appendChild(row);
        });
        body.appendChild(el('div', 'qc-h', 'Changed files'));
      }
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

  /** The Source Control badge: git's own count of changed files. */
  function renderScmBadge() {
    var g = L.panes && L.panes.git();
    var n = g && g.ok && g.repo ? g.files.length : 0;
    var badge = $('chgBadge');
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
  }

  // ---- BOT | AGENT ------------------------------------------------------------------
  //
  // TWO SUB-TABS OF ONE PANEL, over one session and one task. The BOT tab is
  // the conversation; the AGENT tab is the Coding Agent's execution. Which one
  // is in front is paint state (kept per session in this window); what each
  // shows is Core's — the messages carry `to`/`by` (botroute.js). The AGENT
  // tab appears once the Agent has something: a message, a running turn, the
  // task it carries, or the person choosing it. Switching tabs never stops
  // anything; only Stop does.
  // (A second `var pane = 'agent'` stood here and re-declared the side pane: the IDE booted with every
  // side pane hidden and its keyboard shortcuts unregistered — Phase 8.2 P0.)
  // ---- THE SIDECAR: Chat | Coding Agent (2026-09-30) ------------------------------------------------------------
  //
  // TWO TABS OVER ONE SESSION: Chat is the session's Chat lane, the Coding Agent its implementation lane — the
  // same threads the Chat room shows. Which tab is in front is paint state (per viewer); switching stops nothing.
  // MINIMISED, the sidecar becomes "Chat ●" built into the lower-right edge of the workbench (never a floating
  // button); the dot says the Agent is working, something new arrived, or something needs attention.
  var sideTab = (function () { try { return localStorage.getItem('lain.ide.sideTab') === 'chat' ? 'chat' : 'agent'; } catch (e) { return 'agent'; } })();
  var sideSeg = null;
  function convoMode() { return sideTab === 'chat' ? 'chat' : 'ide'; }
  function setSideTab(t, opts) {
    sideTab = t === 'chat' ? 'chat' : 'agent';
    try { localStorage.setItem('lain.ide.sideTab', sideTab); } catch (e) { /* per viewer */ }
    if (sideSeg) sideSeg.set(sideTab);
    $('ideBot').setAttribute('data-side', sideTab);
    if (center !== 'chat') L.mountConvo($('ideBotHost'), convoMode());
    if (sideTab === 'chat') { seenChat = chatCount(S()); paintDock(S()); }
    var s = S(); if (s) renderTask(s);
    if (L.composer) L.composer.cells();
    if (!(opts && opts.quiet)) setTimeout(function () { var a = $('ask'); if (a && a.offsetParent) a.focus(); }, 0);
  }
  L.botpane = {
    current: function () { return L.nav.tab() === 'ide' ? (sideTab === 'chat' ? 'bot' : 'agent') : null; },
    show: function (which) { if ($('main').classList.contains('bot-off')) toggleBot(); if (which) setSideTab(which === 'agent' ? 'agent' : 'chat'); },
    has: function () { return true; },
    tab: function () { return sideTab; },
  };
  var seenChat = 0;
  function chatCount(s) { return s ? (s.conversation || []).filter(function (m) { return m.thread === 'chat' && m.role === 'assistant'; }).length : 0; }
  /** THE DOCK: shown only while the sidecar is minimised; its dot is the reason to come back. */
  function paintDock(s) {
    var dock = $('chatDock');
    var off = $('main').classList.contains('bot-off') && window.innerWidth > 900;
    dock.hidden = !off || center === 'chat';
    if (dock.hidden || !s) return;
    var w = s.workbench || {};
    var attention = (w.quota && w.quota.state === 'QUOTA_PAUSED') || w.hostPaused || (w.offers || []).length || (w.findings || []).some(function (f) { return f.state === 'OPEN' && f.blocking; });
    var unread = chatCount(s) > seenChat;
    var dot = $('chatDockDot');
    dot.hidden = !(w.running || attention || unread);
    dot.className = 'cd-dot' + (attention ? ' warn' : w.running ? ' run' : unread ? ' unread' : '');
    dock.setAttribute('data-tip', attention ? 'Chat — something needs your attention' : w.running ? 'Chat — the Coding Agent is working' : unread ? 'Chat — new message' : 'Chat');
  }

  // ---- the sidecar: width, hide/show, Coding Chat, the current task ----------------------------
  /**
   * THE SIDECAR'S WIDTH: a quarter of the window, clamped 280–430 px (≈320 at 1280, ≈400 at 1600) — comparable
   * to the Explorer, never the editor's rival. A drag is remembered (per viewer) and can go wider, but never past
   * half of what the editor would keep.
   */
  function defaultAgentWidth() { return Math.max(280, Math.min(430, Math.round(window.innerWidth * 0.25))); }
  function dragged() { try { return Number(localStorage.getItem('lain.ide.agentW4')) || 0; } catch (e) { return 0; } }
  function agentWidth() { return dragged() || defaultAgentWidth(); }
  function setAgentWidth(px, remember) {
    var side = $('main').classList.contains('side-off') ? 0 : 256;
    var most = Math.max(300, Math.floor((window.innerWidth - 48 - side) / 2));
    var w = Math.max(280, Math.min(most, 560, px));
    $('main').style.setProperty('--agent-w', w + 'px');
    if (remember) { try { localStorage.setItem('lain.ide.agentW4', String(w)); } catch (e) { /* per viewer */ } }
  }
  function startResize(e) {
    e.preventDefault();
    var bar = $('agentResize'); bar.classList.add('drag');
    var move = function (ev) { setAgentWidth(window.innerWidth - ev.clientX - 0, true); };
    var up = function () { bar.classList.remove('drag'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); if (L.editor && L.editor.layout) L.editor.layout(); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  }
  var center = 'editor';
  function setCenter(c) {
    center = c === 'chat' ? 'chat' : 'editor';
    $('main').classList.toggle('center-chat', center === 'chat');
    $('ideCodingHost').hidden = center !== 'chat';
    var cc = $('centerChat'); if (cc) cc.setAttribute('aria-pressed', String(center === 'chat'));
    L.mountConvo(center === 'chat' ? $('ideCodingHost') : $('ideBotHost'), center === 'chat' ? 'ide' : convoMode());
    paintDock(S());
    if (center === 'editor' && L.editor && L.editor.layout) setTimeout(function () { L.editor.layout(); }, 0);
  }
  function taskOpen() { try { return localStorage.getItem('lain.ide.taskOpen') === '1'; } catch (e) { return false; } }
  /**
   * THE TASK STRIP — TASK · Phase n/N · state, the task, a thin progress line (the plan's own steps), and
   * [▶ Continue] [Open full Coding Chat] [Steps]. Derived from Core's state; nothing is invented. Shown on the
   * Coding Agent tab only.
   */
  function renderTask(s) {
    var dot = $('agentShowDot'); if (dot) dot.hidden = !(s.workbench && s.workbench.running);
    var run = $('agentRun'); if (run) run.hidden = !(s.workbench && s.workbench.running);
    var box = $('agentTask');
    if (sideTab === 'chat' && center !== 'chat') { box.hidden = true; box.dataset.sig = ''; return; }
    var plan = s.plan;
    var w = s.workbench || {};
    var alert = s.execution && s.execution.alert;
    var resumable = Boolean(alert && alert.resumable);
    var at = s.journey && s.journey.agentTask;
    var title = (s.header && s.header.title) || '';
    if (/^\(no task/i.test(title)) title = '';
    // NO TITLE YET: the task is what was asked — the first thing said to the Coding Agent, clipped.
    if (!title) {
      var first = (s.conversation || []).filter(function (m) { return m.role === 'user' && m.thread !== 'chat'; })[0];
      if (first && first.text) title = first.text.length > 100 ? first.text.slice(0, 99).replace(/\s+\S*$/, '') + '\u2026' : first.text;
    }
    var hostPaused = Boolean(w.hostPaused);
    if (!plan && !w.running && !resumable && !hostPaused) { box.hidden = true; return; }
    var hs = (s.header && s.header.status) || {};
    var status = String(w.status || '');
    var running = Boolean(w.running);
    var ph = w.phase || {};
    // THE STATE IS CORE'S LINE (supervision.statusLine): "Paused \u00b7 CLI closed", "Restarting \u00b7 \u2026", "Phase 2 of 5 \u00b7 Implementing".
    var state = running ? ['run', status || 'Running'] : /^Restarting/.test(status) ? ['warn', status] : /^Paused/.test(status) ? ['warn', status] : /complete/i.test(status) ? ['ok', 'Complete'] : resumable ? ['warn', 'Interrupted'] : ['', 'Ready'];
    // THE POSITION IS CORE'S COMMITTED CHECKPOINT (taskcheckpoint.js) — "Phase 3 / 5" (spec §22) is the same number the CLI,
    // the handover and the model are given. Nothing here counts steps of its own.
    var cpv = plan && plan.checkpoint && plan.checkpoint.step ? plan.checkpoint : null;
    var canContinue = !running && (resumable || hostPaused || Boolean(at && at.state === 'ACTIVE'));
    var open = taskOpen();
    var steps = (plan && plan.steps) || [];
    var act = steps.filter(function (x) { return x.status === 'active'; })[0];
    var sum = hs.summary || (act && act.text) || '';
    var auto = L.work && L.work.autoLine ? L.work.autoLine(w) : '';
    var done = plan ? plan.done : 0;
    var total = plan ? plan.total : 0;
    var sig = JSON.stringify([title, plan, status, running, resumable, canContinue, cpv && [cpv.step.index, cpv.step.total, cpv.generation], sum, open, auto, done, ph.total]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig; box.hidden = false; box.textContent = '';
    var top = el('div', 'tk-top');
    top.appendChild(el('span', 'tk-label', 'TASK'));
    if (cpv) { var pe = el('span', 'tk-phase', 'Phase ' + cpv.step.index + ' / ' + cpv.step.total); pe.title = cpv.generation ? 'Committed checkpoint ' + cpv.generation : ''; top.appendChild(pe); }
    var stEl = el('span', 'tk-state ' + state[0]); stEl.appendChild(el('i', '')); stEl.appendChild(document.createTextNode(state[1])); stEl.title = status; top.appendChild(stEl);
    box.appendChild(top);
    box.appendChild(el('b', '', title || 'Current task'));
    // THE PROGRESS LINE: the plan's steps done of all \u2014 only when there is a plan to count.
    if (total) {
      var pr = el('div', 'tk-prog');
      var bar = el('span', 'bar'); var fill = el('i', ''); fill.style.width = Math.round(100 * done / total) + '%'; bar.appendChild(fill);
      pr.appendChild(bar);
      pr.appendChild(el('span', '', done + ' / ' + total + ' steps'));
      box.appendChild(pr);
    }
    if (sum && !open) box.appendChild(el('div', 'tk-sum', sum));
    if (auto && !running) box.appendChild(el('div', 'tk-auto', auto));
    if (open && steps.length) {
      var st = el('div', 'steps');
      steps.slice(0, 12).forEach(function (x) {
        var r = el('div', 'tk-step' + (x.status === 'active' ? ' active' : ''));
        var m = el('span', 'm ' + x.status); if (x.status === 'done') m.appendChild(L.icon('check', 11)); r.appendChild(m);
        r.appendChild(el('span', '', x.text)); st.appendChild(r);
      });
      box.appendChild(st);
    }
    var acts = el('div', 'tk-acts');
    if (canContinue) { var cb = el('button', 'pri', '\u25b6 Continue'); cb.setAttribute('data-task-continue', '1'); cb.onclick = function () { if (hostPaused || (w.quota && w.quota.state === 'QUOTA_PAUSED')) L.work.continueTask(); else L.send('continue'); }; acts.appendChild(cb); }
    var ob = el('button', '', 'Open full Coding Chat'); ob.title = 'The same task, in the Chat layout in place of the editor'; ob.setAttribute('data-task-open', '1'); ob.onclick = function () { setCenter('chat'); }; acts.appendChild(ob);
    if (steps.length) {
      var tg = el('button', 'quiet', open ? 'Hide steps' : 'Steps (' + steps.length + ')');
      tg.onclick = function () { try { localStorage.setItem('lain.ide.taskOpen', open ? '0' : '1'); } catch (e) { /* per viewer */ } box.dataset.sig = ''; renderTask(S()); };
      acts.appendChild(tg);
    }
    box.appendChild(acts);
  }
  /** OPEN THE AGENT'S TASK HERE — asking first when the editor holds another project's files. */
  async function openTask() {
    var s = S();
    var root = s && s.workspace && s.workspace.project && s.workspace.project.root;
    var shown = L.source && L.source.state ? L.source.state() : null;
    var showingRoot = shown && shown.root;
    if (root && showingRoot && showingRoot.toLowerCase() !== root.toLowerCase() && shown.open && shown.open.length) {
      var go = await L.dialog({ title: 'Open this task in IDE', text: 'Agent project:\n' + root + '\n\nIDE project:\n' + showingRoot + '\n\nThe IDE shows one workspace at a time. Its open files are closed, never discarded unsaved without asking.', ok: 'Open ' + (s.workspace.project.name || 'project'), cancel: 'Cancel' });
      if (!go) return;
    }
    L.nav.go('ide');
  }

  // ---- asking from elsewhere in the IDE ------------------------------------------------------
  /** Put a question to the BOT from elsewhere in the IDE (a menu, F2). */
  function askBot(text, route) {
    L.nav.go('ide');
    if ($('main').classList.contains('bot-off')) toggleBot();
    setSideTab(route === 'agent' ? 'agent' : 'chat', { quiet: true });
    var a = $('ask');
    a.value = text;
    a.dispatchEvent(new Event('input', { bubbles: true }));
    L.send(undefined, route ? { route: route } : undefined);
  }
  function askAboutSelection() {
    var E = L.editor && L.editor.editor && L.editor.editor();
    var sel = E && E.getSelection();
    if ($('main').classList.contains('bot-off')) toggleBot();
    // A QUESTION ABOUT THE CODE is a Chat question: the discussion lane, beside the editor.
    setSideTab('chat', { quiet: true });
    var a = $('ask');
    a.value = sel && !sel.isEmpty() ? 'Explain what the selected code does.' : 'Explain what this file does.';
    a.dispatchEvent(new Event('input', { bubbles: true }));
    a.focus();
    a.setSelectionRange(0, a.value.length);
  }

  function botMore() {
    var w = (S() || {}).workbench || {};
    L.kit.menu($('botMore'), [
      { label: 'Open full Coding Chat', note: 'here, in place of the editor', run: function () { setCenter('chat'); } },
      { label: 'Open in Chat', note: 'with the conversations beside it', run: function () { L.chat.openCoding(); } },
      { label: 'Discuss in Chat', note: 'the Chat lane of this session', run: continueInChat },
      { sep: true },
      { label: w.surface && w.surface.writer === 'cli' ? 'Take back from CLI' : 'Continue in CLI', run: function () { L.work.continueInCli(); } },
      { label: 'Who changed what', run: function () { if (L.prov) L.prov.history(); } },
      { label: 'Session history', run: function () { L.nav.go('session'); } },
      { label: 'Model defaults', run: function () { L.nav.go('model', { section: 'defaults' }); } },
    ], { alignRight: true });
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
    L.chat.lane('chat');
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
    var text = cur && cur.kind === 'text';
    $('sbLang').textContent = cur ? (cur.mode || cur.language || '') : '';
    $('sbEnc').textContent = text ? ({ utf8: 'UTF-8', utf8bom: 'UTF-8 with BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', latin1: 'Latin-1' }[cur.encoding] || 'UTF-8') : '';
    $('sbEol').textContent = text ? (cur.eol || 'LF') : '';
    var pos = L.source.cursor();
    $('sbPos').textContent = text && pos ? 'Ln ' + pos.line + ', Col ' + pos.col : '';
    var g = L.panes && L.panes.git();
    $('sbBranch').textContent = '';
    if (g && g.ok && g.repo) { $('sbBranch').appendChild(L.icon('changes', 13)); $('sbBranch').appendChild(el('span', '', (g.branch || '(no branch)') + (g.files.length ? '*' : ''))); }
    $('sbBranch').hidden = !(g && g.ok && g.repo);
    var c = L.panes ? L.panes.counts() : { errors: 0, warnings: 0 };
    $('sbProblems').textContent = '';
    $('sbProblems').appendChild(el('span', c.errors ? 'sb-err' : '', '\u2715 ' + c.errors));
    $('sbProblems').appendChild(el('span', c.warnings ? 'sb-warn' : '', '\u26a0 ' + c.warnings));
    // THE CODING AGENT'S ROUTE: Core's canonical one, or "Select model"; one click chooses.
    var c2 = (s.models && s.models.coding) || {};
    var d = c2.display || { resolved: false };
    var sig = JSON.stringify([d, c2.backing && c2.backing.name]);
    if ($('sbModel').dataset.sig !== sig) {
      $('sbModel').dataset.sig = sig;
      $('sbModel').textContent = '';
      $('sbModel').appendChild(L.icon('spark', 12));
      $('sbModel').appendChild(el(d.resolved ? 'b' : 'span', '', d.resolved ? d.text : 'Select model'));
      $('sbModel').classList.toggle('sb-warn', !d.resolved);
      $('sbModel').title = 'Coding Agent: ' + (d.resolved ? d.text + (c2.backing ? ' \u00b7 account ' + c2.backing.name : '') : 'Select model' + (d.problem ? ' \u2014 ' + d.problem : '')) + '\nClick to choose';
    }
  }

  // ---- PREVIEW, OPENED BY THE PERSON (Phase 8.2) ------------------------------------------------
  //
  // Toolbar, palette (LAIN: Open Preview), the Explorer's menu and Ctrl+Shift+V all land here. A
  // project that cannot be previewed says so — "No preview target detected" — with Configure
  // Preview…; nothing silently does nothing, and nobody has to ask the Agent to open it.
  var previewAvail = null;
  function loadPreviewAvail() {
    L.api('/api/preview/available', {}).then(function (a) { previewAvail = a && a.ok ? a : null; paintPreviewBtn(); }, function () {});
  }
  function paintPreviewBtn() {
    var b = $('previewBtn');
    if (!b) return;
    var no = previewAvail && previewAvail.available === false;
    b.setAttribute('aria-disabled', String(Boolean(no)));
    b.classList.toggle('dim', Boolean(no));
    b.title = no ? 'No preview target detected for this project \u2014 click to configure' : 'Open Preview (Ctrl+Shift+V)' + (previewAvail && previewAvail.why ? ' \u00b7 ' + previewAvail.why : '');
  }
  async function previewOpen(opts) {
    var o = opts || {};
    if (L.workshop && L.workshop.isOpen && L.workshop.isOpen()) { if (o.toggle) L.workshop.close(); return; }
    // PREVIEW IS NOT IDE-ONLY: it opens beside whatever room asked (Chat, Coding Chat, the IDE) — the same page.
    if (!attached()) { L.toast('Open a project to preview it.', true); return; }
    var a = await L.api('/api/preview/available', {});
    previewAvail = a && a.ok ? a : previewAvail; paintPreviewBtn();
    if (!a || !a.ok || !a.available) {
      var go = await L.dialog({ title: 'Preview', text: 'No preview target detected for this project.' + (a && a.detail ? '\n\n' + a.detail : ''), ok: 'Configure Preview\u2026', cancel: 'Close' });
      if (go) previewConfigure();
      return;
    }
    if (L.nav.tab() === 'ide' && center === 'chat') setCenter('editor');
    if (L.workshop && L.workshop.open) L.workshop.open();
  }
  async function previewConfigure() {
    var a = await L.api('/api/preview/available', {});
    var v = await L.dialog({
      title: 'Configure Preview',
      text: 'The command that serves this project, run in the project folder. Noema gives it a free port in PORT; name a port only if the command always uses one. Kept in .lain/preview.json. Empty the command to go back to detection.',
      fields: [
        { key: 'command', label: 'Command', value: (a && a.configured && a.command) || '', placeholder: 'npm run dev' },
        { key: 'port', label: 'Port (optional)', value: a && a.configured && a.port ? String(a.port) : '', placeholder: '5173' },
      ],
      ok: 'Save',
    });
    if (!v) return;
    var r = await L.api('/api/preview/configure', { command: v.command, port: v.port });
    if (!r || !r.ok) { L.toast((r && r.why) || 'not saved', true); return; }
    previewAvail = r; paintPreviewBtn();
    L.toast(r.available ? 'Preview: ' + r.why : 'Preview configuration cleared');
    if (r.available && v.command) previewOpen();
  }
  L.preview = { open: previewOpen, configure: previewConfigure, available: function () { return previewAvail; } };

  // ---- the Explorer's own actions and its Open Editors ----------------------------------------
  function drawSideActs() {
    var box = $('sideActs');
    if (!box) return;
    var want = pane === 'explorer' ? 'explorer' : '';
    if (box.dataset.for === want) return;
    box.dataset.for = want;
    box.textContent = '';
    if (want !== 'explorer') return;
    var act = function (icon, title, fn) { var b = el('button', 'iconbtn'); b.appendChild(L.icon(icon, 14)); b.title = title; b.onclick = fn; box.appendChild(b); };
    act('plus', 'New File\u2026', function () { if (L.editor && L.editor.newFile) L.editor.newFile(''); });
    act('folder', 'New Folder\u2026', function () { if (L.editor && L.editor.newFolder) L.editor.newFolder(''); });
    act('layers', 'Collapse Folders', function () { if (L.source.collapseAll) L.source.collapseAll(); });
  }
  function xsecToggle(head, key) {
    var open = head.getAttribute('aria-expanded') !== 'false';
    head.setAttribute('aria-expanded', String(!open));
    try { localStorage.setItem('lain.ide.' + key, open ? '0' : '1'); } catch (e) { /* per viewer */ }
  }
  function renderOpenEditors() {
    var st = L.source.state();
    var list = $('xOpenList');
    var sig = JSON.stringify([st.active, st.open.map(function (f) { return [f.path, f.dirty, f.preview]; })]);
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.textContent = '';
    $('xOpenN').textContent = st.open.length ? String(st.open.length) : '';
    if (!st.open.length) { list.appendChild(el('div', 'none', 'No open editors')); return; }
    st.open.forEach(function (f, i) {
      var b = el('button', 'oe');
      b.setAttribute('aria-current', String(i === st.active));
      var parts = f.path.split('/');
      var nm = el('span', 'nm', parts.pop()); if (f.preview) nm.style.fontStyle = 'italic';
      b.appendChild(nm);
      if (parts.length) b.appendChild(el('span', 'dir', parts.join('/')));
      var x = el('span', 'x' + (f.dirty ? ' dirty' : ''), f.dirty ? '' : '\u00d7');
      x.title = f.dirty ? 'Unsaved \u2014 close' : 'Close';
      x.onclick = function (e) { e.stopPropagation(); L.source.close(i); };
      b.appendChild(x);
      b.title = f.path + (f.dirty ? ' \u00b7 unsaved' : '');
      b.onclick = function () { L.source.activate(i); };
      list.appendChild(b);
    });
  }

  // ---- OUTPUT: the logs of what LAIN runs in this project (tasks, the dev server) ------------------
  var O = { channel: null, at: 0, busy: false };
  async function outputPanel(body) {
    var box = el('div', 'outp');
    var bar = el('div', 'obar');
    var sel = document.createElement('select');
    var pre = el('pre', '');
    bar.appendChild(el('span', 'none', 'Channel'));
    bar.appendChild(sel);
    box.appendChild(bar); box.appendChild(pre);
    body.appendChild(box);
    var r = null;
    try { r = await L.api('/api/terminal/processes', {}); } catch (e) { r = null; }
    var procs = (r && r.processes) || [];
    if (!procs.length) { sel.appendChild(el('option', '', 'Tasks')); pre.textContent = 'Nothing Noema started in this project has written output yet. Scripts and tasks run from Run and Debug appear here, and the dev server once Preview starts it.'; return; }
    procs.forEach(function (p) { var o = el('option', '', (p.kind === 'service' ? 'Service \u00b7 ' : 'Task \u00b7 ') + (p.command || p.id).slice(0, 60) + (p.running ? '' : ' (ended)')); o.value = p.id; sel.appendChild(o); });
    if (!O.channel || !procs.some(function (p) { return p.id === O.channel; })) O.channel = procs[procs.length - 1].id;
    sel.value = O.channel;
    var show = function () { var p = procs.filter(function (x) { return x.id === O.channel; })[0]; pre.textContent = p ? (p.lines || '(no output yet)') : ''; pre.scrollTop = pre.scrollHeight; };
    sel.onchange = function () { O.channel = sel.value; show(); };
    show();
  }

  // ---- OPENED FROM WINDOWS (`LAIN.exe path`, "Open with LAIN", "Open folder in LAIN") ---------------------------
  //
  // Core opened the project (openpath.js) and asked for the IDE with { openFile, project, focus }. The file waits
  // for the project to be the one on screen, then opens, then the editor takes the keyboard. Nothing else is done.
  var pendingOpen = null;
  function wantOpen(o) {
    if (!o || (!o.openFile && !o.project)) return;
    pendingOpen = { file: o.openFile ? String(o.openFile) : null, project: o.project || null, focus: o.focus || null, at: Date.now() };
  }
  function samePath(a, b) { var n = function (x) { return String(x || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase(); }; return n(a) === n(b); }
  function applyOpen(s) {
    if (!pendingOpen) return;
    if (Date.now() - pendingOpen.at > 30000) { pendingOpen = null; return; }
    if (!attached() || (pendingOpen.project && !samePath(s.workspace.project.root, pendingOpen.project))) return;
    var want = pendingOpen;
    pendingOpen = null;
    if (center === 'chat') setCenter('editor');
    if (!want.file) return;
    Promise.resolve(L.source.openFile(want.file, { pin: true })).then(function (ok) {
      if (ok !== false && want.focus === 'editor') setTimeout(function () { if (L.editor && L.editor.focus) L.editor.focus(); }, 80);
    });
  }

  // ---- the frame -----------------------------------------------------------------------------
  var gitAsked = false;
  var gitRoot = null;
  function render(s) {
    var showing = L.nav.tab() === 'ide';
    var rootNow = attached() ? s.workspace.project.root : null;
    if (rootNow !== gitRoot) { gitRoot = rootNow; gitAsked = false; mounted = {}; }
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
    L.mountConvo(center === 'chat' ? $('ideCodingHost') : $('ideBotHost'), center === 'chat' ? 'ide' : convoMode());
    if (sideTab === 'chat' && !$('main').classList.contains('bot-off')) seenChat = chatCount(s);
    paintDock(s);
    renderTask(s);
    $('sideProj').textContent = s.workspace.project.name;
    $('sideProj').title = s.workspace.project.root;
    renderPanel(s);
    renderScmBadge();
    renderHandoff(s);
    renderStatus(s);
    renderOpenEditors();
    applyOpen(s);
    // A PROJECT OPENS ON THE EXPLORER — never on Source Control — with the bottom panel's
    // Problems showing, unless the person closed the panel before (per viewer).
    if (!gitAsked) {
      gitAsked = true;
      L.panes.refreshScm();
      pane = 'explorer'; drawPane();
      loadPreviewAvail();
      var wsp = s.workspace || {};
      if ((wsp.openPanel || 'NONE') === 'NONE' && !pref('panelClosed', false)) showPanel('PROBLEMS');
    }
  }

  L.ide = {
    open: open, openProject: openProject, newProject: newProject, pickFolder: pickFolder,
    quickOpen: function () { if (attached()) L.source.quickOpen(); },
    closeEditor: function () { L.source.closeActive(); },
    find: function () { L.source.findPrompt(); },
    toggleSide: toggleSide, togglePanel: function () { return togglePanel(null); }, toggleBot: toggleBot, showPanel: showPanel,
    previewOpen: previewOpen, previewConfigure: previewConfigure,
    openTask: openTask, center: setCenter, agentWidth: function () { return agentWidth(); }, setAgentWidth: setAgentWidth,
    currentRoot: function () { var st = L.source && L.source.state ? L.source.state() : null; return (st && st.root) || null; },
    showPane: showPane, askBot: askBot, askAboutSelection: askAboutSelection,
    searchFor: function (q, o) { L.panes.searchFor(q, o); },
    /** The debugger's state moved (pagedebug.js): redraw its panel if it is the open one. */
    rerenderPanel: function () {
      var s = S();
      if (!s || !s.workspace || s.workspace.openPanel !== 'DEBUG' || !L.debug || L.debug.busy($('drawer'))) return;
      $('drawer').dataset.panel = 'DEBUG';
      $('drawer').textContent = '';
      L.debug.renderPanel($('drawer'));
    },
    problemsChanged: function () {
      var s = S();
      if (!s || L.nav.tab() !== 'ide' || !attached()) return;
      if (s.workspace && s.workspace.openPanel === 'PROBLEMS') L.panes.problemsPanel($('drawer'));
      renderStatus(s);
    },
    gitChanged: function () { renderScmBadge(); var s = S(); if (s && attached()) renderStatus(s); },
  };

  L.onBoot(function () {
    $('isMark').appendChild(L.icon('ide', 34));
    $('ideNewIc').appendChild(L.icon('plus', 19));
    $('ideOpenIc').appendChild(L.icon('folder', 19));
    $('ideNew').onclick = newProject;
    $('ideOpen').onclick = openProject;
    var icons = { explorer: 'files', search: 'search', scm: 'changes', run: 'play', extensions: 'ext' };
    Array.prototype.forEach.call(document.querySelectorAll('.act-btn[data-pane]'), function (b) {
      b.insertBefore(L.icon(icons[b.getAttribute('data-pane')], 20), b.firstChild);
      b.onclick = function () { showPane(b.getAttribute('data-pane')); };
    });
    $('wsPill').appendChild(L.icon('preview', 20));
    $('botToggle').appendChild(L.icon('chats', 20));
    // THE SIDECAR'S TABS — Chat | Coding Agent — and its three actions.
    sideSeg = L.kit.segmented([['chat', 'Chat'], ['agent', 'Coding Agent']], sideTab, function (id) { setSideTab(id); });
    sideSeg.setAttribute('aria-label', 'Sidecar');
    var at = sideSeg.querySelector('[data-seg=agent]'); var rd = el('span', 'run'); rd.id = 'agentRun'; rd.hidden = true; at.appendChild(rd);
    $('sideTabs').appendChild(sideSeg);
    $('ideBot').setAttribute('data-side', sideTab);
    $('agentWide').appendChild(L.icon('maximize', 15)); $('agentWide').setAttribute('data-tip', 'Open the full Coding Chat — the same task');
    $('agentHide').appendChild(L.icon('down', 16)); $('agentHide').setAttribute('data-tip', 'Minimize — Chat stays at the lower-right edge');
    $('agentWide').onclick = function () { setCenter('chat'); };
    $('agentHide').onclick = toggleBot;
    $('chatDockIc').appendChild(L.icon('chat', 17));
    $('chatDock').onclick = function () { toggleBot(); setSideTab('chat'); };
    $('ideSettings').appendChild(L.icon('settings', 20));
    $('ideSettings').onclick = function () { L.nav.go('settings'); };
    $('centerEditorIc').appendChild(L.icon('back', 14));
    $('ccTitleIc').appendChild(L.icon('code', 16));
    $('centerEditor').onclick = function () { setCenter('editor'); };
    // THE EDITOR'S ACTIONS (end of the tab strip): split, Preview, Coding Chat, and Show Coding Agent when hidden.
    var acts = $('srcActs');
    if (acts) {
      var a = function (id, icon, label, title, fn, cls) {
        var b = el('button', 'sact' + (cls ? ' ' + cls : '')); b.id = id; b.appendChild(L.icon(icon, 14)); if (label) b.appendChild(el('span', '', label)); b.title = title; b.onclick = fn; acts.appendChild(b); return b;
      };
      a('agentShowBtn', 'code', 'Show Coding Agent', 'Show the Coding Agent sidecar (it kept running while hidden)', toggleBot, 'show-agent');
      a('splitRightBtn', 'splitr', '', 'Split Editor Right (Ctrl+\\)', function () { if (L.groups && L.groups.splitRight) L.groups.splitRight(); else L.toast('Split editors need the full editor (Monaco).', true); });
      a('splitDownBtn', 'splitd', '', 'Split Editor Down', function () { if (L.groups && L.groups.splitDown) L.groups.splitDown(); else L.toast('Split editors need the full editor (Monaco).', true); });
      a('previewBtn', 'preview', 'Preview', 'Open Preview (Ctrl+Shift+V)', function () { previewOpen({ toggle: true }); }, 'labelled');
      a('centerChat', 'spark', 'Coding Chat', 'Talk to the Coding Agent in the full width — the same task', function () { setCenter(center === 'chat' ? 'editor' : 'chat'); }, 'labelled');
    }
    var oh = $('xOpenHead'), th = $('xTreeHead');
    if (!pref('openEditors', true)) oh.setAttribute('aria-expanded', 'false');
    oh.onclick = function () { xsecToggle(oh, 'openEditors'); };
    th.onclick = function () { xsecToggle(th, 'tree'); };
    $('agentResize').addEventListener('mousedown', startResize);
    setAgentWidth(agentWidth(), false);
    // UNTIL A PERSON DRAGS IT, the sidecar's width follows the window (a quarter, clamped).
    window.addEventListener('resize', function () { if (!dragged()) setAgentWidth(defaultAgentWidth(), false); });
    $('botToggle').onclick = toggleBot;

    $('sideRefresh').appendChild(L.icon('refresh', 14));
    $('sideRefresh').onclick = refreshPane;
    // BACK FROM ANOTHER WINDOW (a terminal, another editor), the Explorer and Source Control
    // show what changed there — at most every two seconds, and only while the IDE is on screen.
    var focusAt = 0;
    window.addEventListener('focus', function () {
      if (L.nav.tab() !== 'ide' || !attached() || Date.now() - focusAt < 2000) return;
      focusAt = Date.now();
      L.source.loadRoot();
      L.panes.refreshScm();
    });
    $('botMore').appendChild(L.icon('dots', 16)); $('botMore').setAttribute('data-tip', 'More');
    $('botMore').onclick = botMore;
    $('sbBranch').onclick = function () { showPane('scm', true); };
    $('sbProblems').onclick = function () { showPanel('PROBLEMS'); };
    $('sbModel').onclick = function () { L.intel.pickProvider($('sbModel'), 'coding', { alignRight: true, prefer: 'above' }); };
    $('centerToChat').onclick = function () { setCenter('editor'); L.chat.openCoding(); };
    if (!pref('side', true)) $('main').classList.add('side-off');
    if (!pref('bot', true)) $('main').classList.add('bot-off');
    $('botToggle').setAttribute('aria-selected', String(pref('bot', true)));
    drawPane();
    L.nav.onShow('ide', function (o) { loadRecent(); wantOpen(o); var s = S(); if (s) applyOpen(s); });
    document.addEventListener('keydown', function (e) {
      if (L.nav.tab() !== 'ide' || !attached()) return;
      var ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); toggleSide(); }
      else if (ctrl && !e.shiftKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); togglePanel(null); }
      else if (ctrl && e.key === '`') { e.preventDefault(); togglePanel('TERMINAL'); }
      else if (ctrl && e.altKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); toggleBot(); }
      else if (ctrl && e.shiftKey && (e.key === 'E' || e.key === 'e')) { e.preventDefault(); showPane('explorer'); }
      else if (ctrl && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); showPane('search', true); }
      else if (ctrl && e.shiftKey && (e.key === 'G' || e.key === 'g')) { e.preventDefault(); showPane('scm', true); }
      else if (ctrl && e.shiftKey && (e.key === 'X' || e.key === 'x')) { e.preventDefault(); showPane('extensions', true); }
      else if (ctrl && e.shiftKey && (e.key === 'D' || e.key === 'd')) { e.preventDefault(); showPane('run', true); }
      else if (ctrl && e.shiftKey && (e.key === 'V' || e.key === 'v')) { e.preventDefault(); if (L.preview && L.preview.open) L.preview.open(); else $('wsPill').click(); }
      else if (ctrl && !e.shiftKey && e.key === '\\') { e.preventDefault(); if (L.groups && L.groups.splitRight) L.groups.splitRight(); }
      else if (ctrl && e.shiftKey && (e.key === 'M' || e.key === 'm')) { e.preventDefault(); showPanel('PROBLEMS'); }
      else if (ctrl && !e.shiftKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); L.source.closeActive(); }
    });
  });
  L.onRender(render);
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
