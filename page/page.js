'use strict';

/**
 * THE LAIN WORKSPACE — one document, no build step, no framework.
 *
 * ------------------------------------------------------------------------
 * WHERE THINGS LIVE (2026-09-29 rewrite):
 *
 *   ui/         the design system: tokens (semantic palette, type scale,
 *               the appearance client), base (elements and primitives),
 *               kit (planes, sections, rows, quota, menus, sheets), icons
 *   core/       the client runtime: transport, poll, the one render loop,
 *               the contract client, the keymap
 *   shell/      the frame: the navigation rail, the top bar (the window's
 *               title bar), the usage tracker, the surface switcher, doors,
 *               quick menus, the context menu
 *   home/       Home
 *   chat/       Chat and Coding Chat: the conversations drawer, the stream,
 *               the composer, supervision, plans, sessions, Cowork
 *   workbench/  the IDE: explorer, editor groups, panels, terminal, debug,
 *               the Workshop and the Coding Agent sidecar
 *   model/      MODEL: Accounts, Setup, Models, API, Local, Defaults, and
 *               the route choosers every surface uses
 *   usage/      Usage
 *   mcp/        MCP & Skills
 *   settings/   Settings
 *
 * Each module owns one surface and exports what it contributes: CSS (a
 * string), HTML (markup placed in the skeleton), and js() (a client script,
 * emitted from a real function's source). This file only puts them in order.
 *
 * ------------------------------------------------------------------------
 * THERE IS NOTHING TO AUTHENTICATE TO. The document is loaded by LAIN's own
 * window over a pipe LAIN authenticated when it launched it (harnessapp/ipc.js).
 * It takes no session, sets no cookie and has no login form.
 */

const mod = (name) => require(`./${name}`);

/**
 * THE SHARED PANEL ROWS — the IDE's bottom panel and Sessions draw them. (The
 * conversation block's look is chat/stream.js.)
 */
const SHARED = `
.hrow{display:flex;align-items:center;gap:10px;width:100%;padding:6px 8px;border-radius:var(--radius-sm);text-align:left;color:var(--text-secondary);font-size:13px}
.hrow:hover{background:var(--hover);color:var(--text-primary)}
.hrow .ht{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hrow .ht small{display:block;color:var(--text-muted);font-size:11.5px;overflow:hidden;text-overflow:ellipsis}
.spane .note{border-radius:var(--radius-sm);background:var(--warning-weak);margin-bottom:12px}
.row{display:flex;gap:10px;padding:3px 0;font-family:var(--mono);font-size:12px;color:var(--text-secondary)}
.row .path{color:var(--text-primary)}
.linkrow{width:100%;text-align:left}
.linkrow:hover .path{color:var(--accent-primary)}
.add{color:var(--positive)} .del{color:var(--danger)}
.verdict{font-size:12.5px;padding:6px 0}
.verdict .PASSED{color:var(--positive)} .verdict .FAILED{color:var(--danger)} .verdict .INCONCLUSIVE{color:var(--warning)}
.obs{font-family:var(--mono);font-size:11.5px;color:var(--text-secondary);padding:2px 0;word-break:break-all}
.obs.err{color:var(--danger)}
.termhead{display:flex;justify-content:flex-end;gap:6px;padding:0 0 8px}
.proc{padding:8px 0;border-top:1px solid var(--separator)}
.proc .st.on{color:var(--accent-primary)} .proc .st.off{color:var(--text-muted)}
.proc .out,.bp-body .out{margin:6px 0 0;padding:8px 10px;background:var(--canvas);border-radius:var(--radius-sm);max-height:260px;overflow:auto;font:12px/1.5 var(--mono);color:var(--text-secondary);white-space:pre-wrap;word-break:break-word}
.bp-body .out.shell{max-height:none;min-height:120px}
.shellin{margin-top:8px;padding:7px 10px;background:var(--canvas);border-radius:var(--radius-sm);box-shadow:inset 0 0 0 1px var(--border-subtle);font:12px/1.5 var(--mono);color:var(--text-primary)}
`;

/**
 * THE ONE TYPE SCALE. Every `font-size: Npx` (and `font: … Npx`) in a module is
 * rewritten into calc(Npx × var(--ts)), so the Typography setting reaches every
 * surface; modules are written at their final size (--ts = 1 at Medium). The
 * interface ZOOM (the whole window, 80–200 %) composes on top.
 */
function scaleFonts(css) {
  return String(css)
    .replace(/font-size:\s*(\d+(?:\.\d+)?)px/g, (m, n) => `font-size:calc(${n}px * var(--ts))`)
    .replace(/(font:\s*(?:(?:italic|normal|bold|bolder|lighter|\d{3})\s+)*)(\d+(?:\.\d+)?)px/g, (m, pre, n) => `${pre}calc(${n}px * var(--ts))`);
}

/** CSS, in cascade order: the design system first, then every surface. */
const STYLE = [
  'ui/tokens', 'ui/base', 'ui/kit', 'shell/search',
  'home/home', 'workbench/ide', 'workbench/source', 'workbench/editor', 'workbench/groups', 'workbench/debug', 'workbench/devsettings',
  'workbench/panes', 'chat/composer', 'workbench/xterm', 'model/apikey', 'shell/quick', 'workbench/provenance', 'workbench/extensions', 'workbench/extpage',
  'workbench/workshop', 'settings/bot', 'settings/assistant', 'model/local', 'model/model', 'usage/usage',
  'chat/sessions', 'settings/settings', 'chat/cowork', 'chat/image', 'shell/contextmenu',
  'shell/shell', 'shell/tracker', 'shell/update', 'chat/chat', 'chat/work', 'chat/plan', 'settings/prefs', 'settings/github', 'settings/storage', 'settings/feedback',
  'mcp/mcp', 'settings/router', 'model/intel', 'model/dashboard', 'chat/stream', 'chat/live',
];

function css() {
  const parts = STYLE.map((m) => mod(m).CSS || '');
  parts.splice(3, 0, SHARED);
  return scaleFonts(parts.join('\n'));
}

/** Client scripts, in boot order: the runtime and the design system before any surface. */
const SCRIPTS = [
  'ui/icons', 'core/client', 'ui/tokens', 'ui/kit', 'core/keymap', 'core/contract', 'chat/live', 'shell/shell', 'model/intel', 'shell/tracker', 'shell/update',
  'chat/plan', 'chat/work', 'workbench/workshop', 'workbench/source', 'workbench/editor', 'workbench/groups', 'workbench/debug',
  'workbench/devsettings', 'workbench/panes', 'chat/composer', 'chat/cowork', 'workbench/terminal', 'workbench/xterm', 'model/apikey',
  'shell/quick', 'shell/house', 'workbench/provenance', 'workbench/editorprofile', 'workbench/extensions', 'workbench/extpage', 'chat/image', 'shell/contextmenu',
  'shell/search', 'home/home', 'workbench/ide', 'settings/assistant', 'chat/chat', 'settings/bot', 'model/local',
  'model/dashboard', 'model/model', 'usage/usage', 'mcp/mcp', 'chat/sessions', 'settings/prefs', 'settings/github', 'settings/storage', 'settings/feedback',
  'settings/router', 'settings/settings',
];
function scriptOf(name) { const m = mod(name); return m.js ? m.js() : (m.SCRIPT || ''); }

/**
 * THE STITCHING — the older modules keep their own boot/render signatures;
 * this one place hands them the shared transport and calls them from the one
 * render loop, so none of them runs a second clock.
 */
const GLUE = `
LAIN.onBoot(function (d) {
  var uiFn = function () { return d.ui; };
  LAIN.plan.boot(d.api, d.notice, d.poll, d.render);
  LAIN.workshop.boot(d.api, d.notice, uiFn, d.poll);
  LAIN.source.boot(d.api, d.notice, d.poll);
  LAIN.cowork.boot(d.api, d.notice, d.poll, uiFn);
  LAIN.terminal.boot({ api: d.api, notice: d.notice, render: d.render, ui: d.ui, poll: d.poll });
  LAIN.imageview.boot({ api: d.api, notice: d.notice });
  LAIN.menu.boot({ api: d.api, notice: d.notice });
});
LAIN.onRender(function (S, ui) {
  LAIN.plan.applyPrefill(S);
  LAIN.workshop.render(S, ui);
  LAIN.cowork.render(S, ui);
  LAIN.imageview.render(S.viewing);
  if (LAIN.nav.tab() === 'ide') LAIN.source.refresh();
});
`;

/** The views, in the order the skeleton holds them. */
const VIEWS = ['home/home', 'workbench/ide', 'chat/chat', 'settings/bot', 'model/model', 'usage/usage', 'mcp/mcp', 'chat/sessions', 'settings/settings', 'workbench/extpage', 'chat/image'];

function html() {
  return `<!doctype html>
<html lang="en" data-mode="dark" data-palette="slate"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LAIN</title>
<style>${css()}</style>
</head><body>

<div id="app" hidden>
${mod('shell/shell').HTML}
  <main id="views">
${VIEWS.map((v) => mod(v).HTML).join('\n')}
  </main>
</div>
${mod('workbench/workshop').HTML}
${mod('core/client').HTML}
${mod('shell/search').HTML}
${mod('shell/contextmenu').HTML}
<div id="toasts" aria-live="polite"></div>

${SCRIPTS.map((s) => `<script>${scriptOf(s)}</script>`).join('\n')}
<script>${GLUE}</script>
<script>LAIN.boot();</script>
</body></html>`;
}

module.exports = { html, css, scaleFonts, STYLE, SCRIPTS };
