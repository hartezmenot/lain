'use strict';

/**
 * THE LAIN WORKSPACE — one document, no build step.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS FILE IS.
 *
 * The visual language (theme tokens and the shared components) and the
 * skeleton the surfaces are composed into. Behaviour lives in the page*.js
 * modules, each owning one surface:
 *
 *   pagescript    transport, poll, render loop, the one conversation block
 *   pageshell     menubar, the seven primary tabs, the quota bar
 *   pagehome      Home and the search over everything
 *   pageide       the IDE (with pagesource, pageworkshop, pageterminal)
 *   pagechat      Chat, and the handoff to the IDE (with pageplan)
 *   pagebot       the BOT: identity, channels, permissions, capabilities
 *   pagemodel     providers, accounts, usage, roles (pickers: pagemodels)
 *   pagesession   previous work
 *   pagesettings  settings, MCP and Skills
 *
 * ------------------------------------------------------------------------
 * LAIN'S OWN LOOK.
 *
 * Near-black graphite surfaces separated by one step of lightness and hairline
 * rules, not boxes; one restrained periwinkle accent for selection and action;
 * green, amber and red only for success, waiting and failure. Hierarchy comes
 * from spacing and type. The IDE keeps an editor's familiar geometry; the shell
 * around it is LAIN's.
 *
 * ------------------------------------------------------------------------
 * THERE IS NOTHING TO AUTHENTICATE TO. The document is loaded by LAIN's own
 * window over a pipe LAIN authenticated when it launched it (harnessapp/ipc.js).
 * It takes no session, sets no cookie and has no login form.
 */

const CSS = `
:root{
  --bg:#0d0e11; --chrome:#101115; --panel:#131419; --surface:#191b21; --raise:#20232a;
  --line:#22242b; --line2:#2d3039;
  --ink:#e5e7ec; --dim:#9da1ab; --faint:#666a75;
  --accent:#8f9bff; --accent-ink:#0e1024; --accent-weak:#8f9bff1c; --accent-line:#8f9bff59;
  --ok:#5aae84; --warn:#d8a650; --bad:#d9675f;
  --radius:6px; --radius-s:4px; --shadow:0 14px 40px #000a;
  --mono:"Cascadia Code","Cascadia Mono",Consolas,ui-monospace,monospace;
  --sans:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;
  --grey:var(--raise);
  color-scheme:dark;
}
*{box-sizing:border-box}
/* HIDDEN MEANS HIDDEN: a rule that sets display outranks the renderer's own
   [hidden] style otherwise. */
[hidden]{display:none!important}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
:focus:not(:focus-visible){outline:none}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--ink);font:13.5px/1.55 var(--sans);overflow:hidden;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
button:disabled{opacity:.45;cursor:default}
input,textarea{font:inherit;color:inherit;background:none;border:0;outline:0;width:100%}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:#2a2d36;border-radius:10px;border:2px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:#383c48;background-clip:padding-box;border:2px solid transparent}
::-webkit-scrollbar-corner{background:transparent}
.ic{display:block;flex:none}
.spacer{flex:1}
.hint{color:var(--faint);font-size:12px}
.empty{padding:14px 10px;color:var(--faint);font-size:12.5px;line-height:1.6}
.none{color:var(--faint);font-size:12.5px;padding:6px 8px}
body.compact .sess,body.compact .srow,body.compact .hrow{padding-top:4px;padding-bottom:4px}

/* ---- the frame ----------------------------------------------------------- */
#app{display:grid;grid-template-rows:auto auto minmax(0,1fr);height:100%}
#views{position:relative;min-height:0;display:grid;grid-template-rows:minmax(0,1fr);grid-template-columns:minmax(0,1fr)}
.view{min-height:0;min-width:0}
.hrow{display:flex;align-items:center;gap:10px;width:100%;padding:7px 8px;border-radius:var(--radius-s);text-align:left;color:var(--dim);font-size:13px}
.hrow:hover{background:var(--surface);color:var(--ink)}
.hrow .ht{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hrow .ht small{display:block;color:var(--faint);font-size:11px;overflow:hidden;text-overflow:ellipsis}

/* ---- controls -------------------------------------------------------------- */
.btn{display:inline-flex;align-items:center;gap:6px;padding:6px 13px;border-radius:var(--radius-s);color:var(--ink);font-size:12.5px;background:var(--surface);border:1px solid var(--line2)}
.btn:hover:not(:disabled){background:var(--raise)}
.btn.small{padding:3px 10px;font-size:12px}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
.btn.primary:hover:not(:disabled){background:#a3adff}
.btn.go{color:var(--accent)}
.btn.danger:hover:not(:disabled){color:var(--bad);border-color:#d9675f66}
.btn.danger-fill{background:var(--bad);border-color:var(--bad);color:#1a0706;font-weight:600}
.iconbtn{width:26px;height:26px;border-radius:var(--radius-s);display:inline-grid;place-items:center;color:var(--faint)}
.iconbtn:hover{background:var(--raise);color:var(--ink)}
.pill{display:flex;align-items:center;gap:6px;padding:3px 9px;border-radius:var(--radius-s);color:var(--dim);font-size:12px;white-space:nowrap}
.pill:hover{background:var(--raise);color:var(--ink)}
.pill b{font-weight:500;color:var(--ink)}
.st{width:6px;height:6px;border-radius:50%;background:var(--faint);flex:none}
.st.ready{background:var(--ok)} .st.auth{background:var(--warn)} .st.bad{background:var(--bad)}
.note{padding:8px 14px;font-size:12.5px;color:var(--warn);border-top:1px solid var(--line)}
.note.bad{color:var(--bad)}
.spane .note{border:1px solid var(--line);border-radius:var(--radius-s);margin-bottom:12px}

/* ---- popovers, menus, dialogs, toasts ------------------------------------------- */
.pop{position:fixed;background:var(--panel);border:1px solid var(--line2);border-radius:8px;padding:6px;min-width:270px;max-width:420px;max-height:64vh;overflow-y:auto;z-index:65;box-shadow:var(--shadow)}
.pop h4{margin:6px 8px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:600}
.pop .psearch{margin:2px 4px 6px;padding:6px 9px;background:var(--surface);border:1px solid var(--line2);border-radius:var(--radius-s)}
.opt{display:block;width:100%;text-align:left;padding:6px 9px;border-radius:var(--radius-s);font-size:13px;color:var(--dim)}
.opt:hover{background:var(--accent-weak);color:var(--ink)}
.opt[aria-selected=true]{color:var(--accent)}
.opt small{display:block;color:var(--faint);font-size:11px}
.opt .row1{display:flex;align-items:center;gap:7px}
.dlg-back{position:fixed;inset:0;z-index:90;background:#0009;display:grid;place-items:center}
.dlg{width:min(460px,92vw);background:var(--panel);border:1px solid var(--line2);border-radius:10px;box-shadow:var(--shadow);padding:18px 20px}
.dlg h3{margin:0 0 6px;font:600 15px/1.3 var(--sans)}
.dlg p{margin:0 0 14px;color:var(--dim);white-space:pre-line}
.dlg-field{display:block;margin:0 0 12px}
.dlg-field > span{display:block;font-size:11.5px;color:var(--faint);margin-bottom:4px}
.dlg-line{display:flex;gap:8px}
.dlg-line input{background:var(--bg);border:1px solid var(--line2);border-radius:var(--radius-s);padding:7px 10px;font-size:13px}
.dlg-line input:focus{border-color:var(--accent-line)}
.dlg-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
#toasts{position:fixed;right:16px;bottom:16px;z-index:95;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none}
.toast{max-width:420px;padding:9px 14px;border-radius:8px;background:var(--raise);border:1px solid var(--line2);box-shadow:var(--shadow);font-size:12.5px;color:var(--ink);transition:opacity .25s}
.toast.bad{border-color:#d9675f66;color:#f0b3ae}
.toast.out{opacity:0}

/* ---- the conversation block ------------------------------------------------------- */
.convo{display:flex;flex-direction:column;min-height:0;min-width:0}
.convo-head{display:flex;align-items:center;gap:10px;padding:12px 22px 10px}
.ch-title{min-width:0;display:flex;align-items:baseline;gap:8px;overflow:hidden}
.ch-title .proj{font-weight:600;font-size:14px;white-space:nowrap}
.ch-title .proj.gone{color:var(--bad)}
.ch-title .goal{color:var(--faint);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--faint);white-space:nowrap}
.status .sdot{font-size:9px}
.status.working{color:var(--accent)} .status.warn{color:var(--warn)} .status.bad{color:var(--bad)}
.stream{flex:1;min-height:0;overflow-y:auto;padding:14px 22px 8px}
.stream-empty{padding:18vh 4px 0;text-align:center}
.se-title{font-size:15px;color:var(--dim)}
.se-sub{font-size:12.5px;color:var(--faint);margin-top:6px}
.msg{margin:0 0 20px;max-width:78ch}
.msg .who{display:flex;align-items:center;gap:8px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:5px;font-weight:600}
.msg .who .at{letter-spacing:0;font-weight:400;margin-left:auto}
.msg.user{margin-left:auto}
.msg.user .body{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:9px 13px}
.msg.user .who{justify-content:flex-end}
.msg.user .who .at{margin-left:0}
.prose{white-space:pre-wrap;overflow-wrap:anywhere}
pre.code{margin:8px 0;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);overflow-x:auto;font:12.5px/1.55 var(--mono);color:var(--ink)}
.prov{color:var(--accent);text-transform:none;letter-spacing:0;font-weight:500}
.plancard{margin:0 0 20px;max-width:78ch;background:var(--panel);border:1px solid var(--accent-line);border-radius:8px;overflow:hidden}
.plancard .ph{padding:10px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);border-bottom:1px solid var(--line);font-weight:600}
.plancard .steps{padding:6px}
.plancard .step{display:flex;gap:9px;align-items:flex-start;padding:5px 10px;font-size:13px}
.plancard .step .m{flex:none;width:14px;color:var(--faint);font-family:var(--mono);font-size:12px}
.plancard .actions{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--line);flex-wrap:wrap}
.act{display:flex;align-items:center;gap:9px;padding:6px 22px;font-size:12px;color:var(--dim)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--faint);flex:none}
.dot.run{background:var(--accent);animation:p 1.6s ease-in-out infinite}
.dot.ok{background:var(--ok)} .dot.bad{background:var(--bad)} .dot.warn{background:var(--warn)}
@keyframes p{0%,100%{opacity:.4}50%{opacity:1}}
.clock{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--faint)}
.composer{padding:8px 22px 16px}
.composer .box{background:var(--surface);border:1px solid var(--line2);border-radius:10px;padding:10px 12px}
.composer .box:focus-within{border-color:var(--accent-line)}
.composer textarea{resize:none;min-height:22px;max-height:200px;display:block}
.composer textarea::placeholder{color:var(--faint)}
.tools{display:flex;align-items:center;gap:4px;margin-top:7px;flex-wrap:wrap}
.send{padding:4px 14px;border-radius:var(--radius-s);background:var(--accent);color:var(--accent-ink);font-weight:600;font-size:12.5px}
.send:disabled{background:var(--raise);color:var(--faint)}
/* ---- panel content shared by the IDE's bottom panel and Session ----------------- */
.row{display:flex;gap:10px;padding:3px 0;font-family:var(--mono);font-size:12px;color:var(--dim)}
.row .path{color:var(--ink)}
.linkrow{width:100%;text-align:left}
.linkrow:hover .path{color:var(--accent)}
.add{color:var(--ok)} .del{color:var(--bad)}
.verdict{font-size:12.5px;padding:6px 0}
.verdict .PASSED{color:var(--ok)} .verdict .FAILED{color:var(--bad)} .verdict .INCONCLUSIVE{color:var(--warn)}
.obs{font-family:var(--mono);font-size:11.5px;color:var(--dim);padding:2px 0;word-break:break-all}
.obs.err{color:var(--bad)}
.termhead{display:flex;justify-content:flex-end;gap:6px;padding:0 0 8px}
.proc{padding:8px 0;border-top:1px solid var(--line)}
.proc .st.on{color:var(--accent)} .proc .st.off{color:var(--faint)}
.proc .out,.bp-body .out{margin:6px 0 0;padding:8px 10px;background:var(--bg);border-radius:var(--radius-s);max-height:260px;overflow:auto;font:12px/1.5 var(--mono);color:var(--dim);white-space:pre-wrap;word-break:break-word}
.bp-body .out.shell{max-height:none;min-height:120px}
.shellin{margin-top:8px;padding:7px 10px;background:var(--bg);border:1px solid var(--line2);border-radius:var(--radius-s);font:12px/1.5 var(--mono);color:var(--ink)}

${require('./pageshell').CSS}
${require('./pagehome').CSS}
${require('./pageide').CSS}
${require('./pagesource').CSS}
${require('./pageeditor').CSS}
${require('./pageworkshop').CSS}
${require('./pagechat').CSS}
${require('./pagebot').CSS}
${require('./pagemodel').CSS}
${require('./pagesession').CSS}
${require('./pagesettings').CSS}
${require('./pagecowork').CSS}
${require('./pageimage').CSS}
${require('./pagemenu').CSS}
`;

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

function html() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LAIN</title>
<style>${CSS}</style>
</head><body>

<div id="app" hidden>
${require('./pageshell').HTML}
  <main id="views">
${require('./pagehome').HTML}
${require('./pageide').HTML}
${require('./pagechat').HTML}
${require('./pagebot').HTML}
${require('./pagemodel').HTML}
${require('./pagesession').HTML}
${require('./pagesettings').HTML}
${require('./pageimage').HTML}
  </main>
</div>
${require('./pagescript').HTML}
${require('./pagemenu').HTML}
<div id="toasts" aria-live="polite"></div>

<script>${require('./pageicons').js()}</script>
<script>${require('./pagescript').js()}</script>
<script>${require('./pagecontract').js()}</script>
<script>${require('./pageshell').js()}</script>
<script>${require('./pagemodels').js()}</script>
<script>${require('./pageplan').js()}</script>
<script>${require('./pageworkshop').js()}</script>
<script>${require('./pagesource').js()}</script>
<script>${require('./pageeditor').js()}</script>
<script>${require('./pagecowork').js()}</script>
<script>${require('./pageterminal').js()}</script>
<script>${require('./pageimage').SCRIPT}</script>
<script>${require('./pagemenu').SCRIPT}</script>
<script>${require('./pagehome').js()}</script>
<script>${require('./pageide').js()}</script>
<script>${require('./pagechat').js()}</script>
<script>${require('./pagebot').js()}</script>
<script>${require('./pagemodel').js()}</script>
<script>${require('./pagesession').js()}</script>
<script>${require('./pagesettings').js()}</script>
<script>${GLUE}</script>
<script>LAIN.boot();</script>
</body></html>`;
}

module.exports = { html, CSS };
