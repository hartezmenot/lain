'use strict';

/**
 * THE APPLICATION SHELL — one document, no build step.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS FILE IS AND IS NOT.
 *
 * It is the HTML skeleton and the whole of the visual language. It contains no
 * behaviour: the script comes from pagescript.js (the lanes, the sessions, the
 * conversation, the composer, the model picker) and pageworkshop.js (the
 * preview and its instruments), composed in below.
 *
 * The split is the god-object guard doing its job, and the seam is real —
 * "what it looks like" and "what it does" change for different reasons.
 *
 * ------------------------------------------------------------------------
 * THE VISUAL LANGUAGE, WHICH IS THE CLI'S.
 *
 * Near-black ground, one cyan accent, restrained semantic colour (green for
 * proved, amber for waiting, red for failed), generous whitespace, and NO
 * BOXES AROUND EVERYTHING. A person moving between the terminal and this
 * should recognise the same product rather than two designs that share a name.
 *
 * PROGRESSIVE DISCLOSURE IS THE LAYOUT RULE. The resting screen is a session
 * list, a conversation and a composer. Changes, verification and the Workshop
 * are contextual: they appear when there is something in them, and the Workshop
 * takes the right half only while it is open. There is no permanent process
 * monitor, no permanent event stream and no grid of status cards.
 */

/**
 * THE PALETTE, RESTRAINED ON PURPOSE.
 *
 * Neutral graphite, not blue-black: --bg and --panel differ by one step of
 * lightness rather than a border, which is what lets the header, rail and
 * workspace read as one surface stack instead of a grid of boxed panels. The
 * accent is a single desaturated steel blue, used for selection and action
 * only - never decoration. --radius dropped from 6 to 4: a smaller corner
 * reads as engineering software, not a rounded consumer app.
 */
const CSS = `
:root{
  --bg:#0c0d0f; --panel:#111214; --surface:#17181b; --line:#212226; --ink:#e3e5e8; --dim:#93969c;
  --faint:#606268; --accent:#5b9bd5; --ok:#4e9d72; --warn:#c99a44; --bad:#c05b56;
  --grey:#1a1b1e; --radius:4px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:"Segoe UI",system-ui,-apple-system,Roboto,sans-serif;
}
*{box-sizing:border-box}
/* HIDDEN MEANS HIDDEN. Any rule that sets display (#app is grid) outranks the
   renderer's own [hidden] style. Found by screenshotting the real window, not
   by reading the DOM, which said hidden. */
[hidden]{display:none!important}
/* ONE FOCUS RING FOR THE WHOLE PRODUCT, keyboard-only and restrained: a thin
   accent outline with a gap, never a glow. Every interactive element in this
   file has its border reset to 0 by the button/input rules below, so without
   this a keyboard user driving the session rail, the tabs or the composer has
   no visible position at all. */
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
:focus:not(:focus-visible){outline:none}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--ink);font:14px/1.55 var(--sans);overflow:hidden}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
button:disabled{opacity:.4;cursor:default}
input,textarea{font:inherit;color:inherit;background:none;border:0;outline:0;width:100%}

/* ---- the frame -------------------------------------------------------- */
#app{display:grid;grid-template-rows:auto 1fr;height:100%}
main{position:relative}
header{display:flex;align-items:center;gap:8px;padding:0 14px;height:44px;background:var(--panel);border-bottom:1px solid var(--line)}
.brand{font-weight:600;letter-spacing:.1em;font-size:12px;color:var(--dim);margin-right:6px}
.lanes{display:flex;gap:2px}
.lane{padding:5px 12px;border-radius:var(--radius);color:var(--dim);font-size:12.5px}
.lane:hover{color:var(--ink)}
.lane[aria-selected=true]{background:var(--surface);color:var(--ink)}
.spacer{flex:1}
.hint{color:var(--faint);font-size:12px}
/* ---- header-right icon controls: diagnostics, settings ----------------
   Small, quiet, text-free. A gear and an info glyph do not compete with the
   lane tabs for attention, which is the point of putting them here at all. */
.iconbtn{width:26px;height:26px;border-radius:var(--radius);display:inline-flex;align-items:center;justify-content:center;color:var(--faint);font-size:13px}
.iconbtn:hover{background:var(--surface);color:var(--ink)}

/* ---- WHY EVERY FLEXIBLE COLUMN IS minmax(0,1fr) -----------------------
   A grid track written 1fr will not shrink below the MIN-CONTENT width of
   what is in it. The conversation column holds code, long paths and provider
   JSON, so at 520px the grid was 813px wide and the composer sat off the right
   edge of the window: a LAIN you could read and not type into. Measured — 293px
   of bleed at 520px, 393px at 420px. minmax(0,1fr) is the track saying it may
   be narrower than its contents; the contents scroll or wrap instead. */
main{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:0}
main.with-workshop{grid-template-columns:250px minmax(0,1fr) minmax(420px,44%)}
/* THE PROJECT FILES COLUMN. Project Files and Workshop are two states of one
   Core-held workspace.openPanel (docs/HARNESS_UI_CONTRACT.md §7) - never
   both at once, so there is no compound rule for having both open. */
main.with-source{grid-template-columns:250px minmax(0,1fr) minmax(460px,46%)}

/* ---- A NARROW WINDOW ---------------------------------------------------
   Half a screen is a normal way to keep LAIN open beside an editor, and at that
   width 250px of session list is most of what is left. So under 820px the rail
   stops being a column and becomes a panel over the conversation, reached by a
   header button that exists only at this width.

   IT IS NOT HIDDEN. A narrow window that simply dropped the session list would
   be a window you cannot leave the session you are in — which is the exact
   defect the session pool was built to remove. */
#railBtn{display:none}
@media (max-width: 820px){
  main, main.with-workshop, main.with-source{grid-template-columns:minmax(0,1fr)}
  main > aside{position:absolute;left:0;top:46px;bottom:0;width:min(320px,86vw);z-index:30;
               background:var(--bg);box-shadow:0 0 40px #000a}
  main:not(.rail-open) > aside{display:none}
  /* The extra panels are a wide-window luxury; at this width they would each be
     the whole window and the conversation would be gone. */
  main.with-workshop > .workshop, main.with-source > #srcPanel{display:none}
  #railBtn{display:inline-flex}
  /* THE CONNECTION HINT IS THE LOWEST-PRIORITY THING IN THE HEADER. At a width
     that already gave up a column for the rail, it is the first thing to go
     rather than pushing the diagnostics/settings icons off the edge. */
  .hint{display:none}
  /* THE CRUMB STACKS rather than truncates: a project name, Chat/Coding and a
     running status competing for one row at 380px produced ellipsis on all
     three. Two rows reads better than none of them being legible. */
  .crumb{flex-wrap:wrap;row-gap:6px}
  .crumb .status{order:1} .crumb .modes{order:2} #crumbStop{order:3}
}

/* ---- sessions ----------------------------------------------------------
   THREE LINES, ALWAYS: name, task, status. A row that grows or shrinks by
   what it happens to know reads as a list where some items matter more than
   others - they do not. Selection is a tone shift plus a left edge, not a
   border box, so a resting rail is quiet and a glance still finds the
   current row. */
aside{border-right:1px solid var(--line);overflow-y:auto;padding:8px 0}
.aside-head{padding:0 14px 8px;color:var(--faint);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center}
.sess{display:block;width:100%;text-align:left;padding:7px 14px 7px 12px;border-left:2px solid transparent}
.sess:hover{background:var(--surface)}
.sess[aria-current=true]{border-left-color:var(--accent);background:var(--surface)}
.sess .p{font-size:12.5px;color:var(--ink);font-weight:500}
.sess .t{font-size:12px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.sess .w{font-size:11px;color:var(--faint);margin-top:3px}
/* ---- a live session says so, quietly -------------------------------------
   The glyph is the only moving thing in the rail and it does not animate: a
   session list that pulses is a list nobody can read past. See the note at
   renderSessions in pagescript.js for why only LIVE rows carry one. */
.sessrow{position:relative;display:flex;align-items:stretch}
.sessrow .sess{flex:1;min-width:0}
.sess .p{display:flex;align-items:center;gap:6px}
.sess .p .sdot{margin-left:auto;font-size:9px;line-height:1;flex:none}
.sess .p .sdot.RUNNING{color:var(--accent)}
.sess .p .sdot.WAITING{color:var(--warn)}
.sess .p .sdot.STOPPED{color:var(--bad)}
.sess .p .sdot.DONE{color:var(--ok)}
.sess .p .sdot.IDLE{color:var(--faint)}
.sess .w.RUNNING{color:var(--accent)} .sess .w.WAITING{color:var(--warn)} .sess .w.STOPPED{color:var(--bad)}
.sessx,.sessdel{flex:none;width:22px;color:var(--faint);opacity:0;font-size:14px;line-height:1}
.sessrow:hover .sessx,.sessrow:hover .sessdel{opacity:1}
.sessx:hover{color:var(--ink)}
/* DELETE READS AS DELETE. It is a different glyph in a different colour from
   the close control beside it, because the one thing that must never happen
   here is a person reaching for "close" and hitting "destroy". */
.sessdel:hover{color:var(--bad)}
.src{display:inline-block;font-size:10px;letter-spacing:.04em;text-transform:uppercase;
     color:var(--faint);background:var(--surface);border-radius:3px;padding:0 5px;margin-left:6px}
.empty{padding:16px 14px;color:var(--faint);font-size:12px;line-height:1.6}

/* ---- the work column -------------------------------------------------- */
section.work{display:grid;grid-template-rows:auto auto 1fr auto;min-height:0}
.crumb{display:flex;align-items:center;gap:12px;padding:11px 22px;border-bottom:1px solid var(--line)}
.crumb .head{min-width:0}
.crumb .proj{font-weight:600;font-size:13.5px;display:block}
.crumb .goal{color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;margin-top:1px}
/* THE LIVE STATUS, next to the project rather than buried in the activity
   row below - this is the one fact a person glances at first. */
.crumb .status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--faint);white-space:nowrap}
.crumb .status .sdot{font-size:9px}
.crumb .status.working{color:var(--accent)}
.crumb .status.warn{color:var(--warn)}
.crumb .status.bad{color:var(--bad)}
/* ---- Chat / Coding, the two internal modes of an engineering session ----
   Not a second lane and not a second conversation: both read the same
   S.conversation. Chat keeps the workspace out of the way for planning and
   discussion; Coding surfaces Changes, Plan, Terminal and Project Files.
   Purely a client-side filter over what is already there (LAIN.ui.mode). */
.modes{display:flex;gap:2px;background:var(--surface);border-radius:var(--radius);padding:2px}
.mode{padding:4px 11px;border-radius:calc(var(--radius) - 1px);color:var(--dim);font-size:12px}
.mode[aria-selected=true]{background:var(--grey);color:var(--ink)}
.stream{overflow-y:auto;padding:18px 22px 8px}
.msg{margin:0 0 18px;max-width:78ch}
.msg .who{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin-bottom:5px}
.msg.user .body{background:var(--surface);border-radius:var(--radius);padding:9px 12px;white-space:pre-wrap}
.msg.assistant .body{white-space:pre-wrap}
.prov{color:var(--accent);text-transform:none;letter-spacing:0;margin-left:8px;font-size:11px}

/* ---- the plan card -----------------------------------------------------
   The one message-area object that earns a stronger surface: it is a
   decision (accept, revise, not yet), not a line of conversation, and it
   asks to be told apart from the messages around it. Everything else in the
   stream stays plain text. */
.plancard{margin:0 0 20px;max-width:78ch;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.plancard .ph{padding:10px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);border-bottom:1px solid var(--line)}
.plancard .steps{padding:6px 6px}
.plancard .step{display:flex;gap:9px;align-items:flex-start;padding:6px 10px;font-size:13px;border-radius:3px}
.plancard .step .m{flex:none;width:14px;color:var(--faint);font-family:var(--mono);font-size:12px;line-height:1.5}
.plancard .step.done .m{color:var(--ok)}
.plancard .step.active .m{color:var(--accent)}
.plancard .step.done .t{color:var(--dim);text-decoration:line-through;text-decoration-color:var(--line)}
.plancard .actions{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--line);flex-wrap:wrap}

/* ---- activity, contextual -------------------------------------------- */
.act{display:flex;align-items:center;gap:9px;padding:8px 22px;border-top:1px solid var(--line);font-size:12.5px;color:var(--dim)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--faint);flex:none}
.dot.run{background:var(--accent);animation:p 1.4s ease-in-out infinite}
.dot.ok{background:var(--ok)} .dot.bad{background:var(--bad)} .dot.warn{background:var(--warn)}
@keyframes p{0%,100%{opacity:.35}50%{opacity:1}}
.clock{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--faint)}

/* ---- composer -----------------------------------------------------------
   FLAT BUTTONS, NOT PILLS. A row of eight rounded-full chips reads as a
   feature showcase; a row of quiet rectangular buttons on one shared surface
   reads as a toolbar - which is what this is. Colour appears only on the
   status dot inside each button, never on the button itself, so the row does
   not compete with anything above it. */
.composer{border-top:1px solid var(--line);padding:11px 22px 14px}
.box{background:var(--surface);border-radius:var(--radius);padding:10px 12px}
.box textarea{resize:none;min-height:22px;max-height:180px;display:block}
.box textarea::placeholder{color:var(--faint)}
.tools{display:flex;align-items:center;gap:6px;margin-top:9px;flex-wrap:wrap}
.pill{display:flex;align-items:center;gap:6px;padding:4px 9px;
      border-radius:var(--radius);color:var(--dim);font-size:12px}
.pill:hover{background:var(--surface);color:var(--ink)}
.pill[aria-selected=true]{background:var(--surface);color:var(--ink)}
.pill b{font-weight:500;color:var(--ink)}
.pill .st{width:6px;height:6px;border-radius:50%;background:var(--faint)}
.pill .st.ready{background:var(--ok)} .pill .st.auth{background:var(--warn)} .pill .st.bad{background:var(--bad)}
.send{margin-left:auto;padding:5px 15px;border-radius:var(--radius);background:var(--accent);color:#0a1620;font-weight:600}
.send:disabled{background:var(--surface);color:var(--faint)}

/* ---- contextual drawers ---------------------------------------------- */
.drawers{display:flex;gap:4px;padding:0 22px 10px;flex-wrap:wrap}
.tab{padding:4px 10px;border-radius:var(--radius);color:var(--dim);font-size:12px}
.tab:hover{color:var(--ink)}
.tab[aria-selected=true]{background:var(--surface);color:var(--ink)}
.tab .n{color:var(--faint);margin-left:5px;font-size:11px}
.drawer{padding:0 22px 14px;max-height:34vh;overflow-y:auto}
.proj.gone{color:var(--bad)}
.drawer .out.shell{max-height:300px}
.shellin{margin-top:8px;padding:8px 10px;background:var(--bg);
  border-radius:var(--radius);font:12px/1.5 var(--mono);color:var(--ink)}
/* ---- the project terminal, contextual and collapsed ---------------------
   A process view, not a prompt: see harnessapp/terminalroutes.js for why there
   is nothing to type into. It never opens itself and never grows past a third
   of the window. */
.termhead{display:flex;justify-content:flex-end;padding:0 0 8px}
.proc{padding:8px 0;border-top:1px solid var(--line)}
.proc .st.on{color:var(--accent)}
.proc .st.off{color:var(--faint)}
.proc .out,.drawer .out{margin:6px 0 0;padding:8px 10px;background:var(--bg);border-radius:var(--radius);
  max-height:220px;overflow:auto;font:12px/1.5 var(--mono);color:var(--dim);white-space:pre-wrap;word-break:break-word}
.row{display:flex;gap:10px;padding:4px 0;font-family:var(--mono);font-size:12px;color:var(--dim)}
.row .path{color:var(--ink)}
.add{color:var(--ok)} .del{color:var(--bad)}
.verdict{font-size:12.5px;padding:8px 0}
.verdict .PASSED{color:var(--ok)} .verdict .FAILED{color:var(--bad)} .verdict .INCONCLUSIVE{color:var(--warn)}

${require('./pagesource').CSS}
/* ---- Project Files with nothing attached yet -------------------------- */
.src-noproject{display:grid;place-items:center;border-left:1px solid var(--line);padding:40px;min-height:0}
.src-noproject .in{max-width:360px;text-align:left}
.src-noproject h2{font:600 15px/1.3 var(--sans);margin:0 0 8px}
.src-noproject p{color:var(--dim);margin:0 0 16px;font-size:13px}
.src-noproject .recent{margin:0 0 16px}
.src-noproject .recent button{display:block;width:100%;text-align:left;padding:7px 10px;border-radius:var(--radius);color:var(--dim);font-size:12.5px}
.src-noproject .recent button:hover{background:var(--surface);color:var(--ink)}
.src-noproject .recent .path{color:var(--faint);font-size:11px;font-family:var(--mono)}
${require('./pagecowork').CSS}
${require('./pagebot').CSS}
${require('./pageimage').CSS}
${require('./pagemenu').CSS}
/* ---- the workshop -------------------------------------------------------
   Dev Server / Preview / Console / Network / viewport, in one restrained
   instrument panel - not a devtools clone. The status line uses the same
   semantic dots as everywhere else in the product. */
.workshop{border-left:1px solid var(--line);display:grid;grid-template-rows:auto auto auto 1fr auto;min-height:0}
.ws-head{display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--line)}
.ws-title{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.ws-server{display:flex;align-items:center;gap:8px;padding:9px 16px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--dim)}
.ws-server .sdot{font-size:9px}
.ws-server .url{color:var(--faint);font-family:var(--mono);font-size:11.5px;margin-left:2px}
.ws-bar{display:flex;align-items:center;gap:6px;padding:9px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.vp{padding:3px 10px;border-radius:var(--radius);font-size:12px;color:var(--dim)}
.vp[aria-selected=true]{background:var(--surface);color:var(--ink)}
.ws-body{overflow:auto;padding:14px 16px;min-height:0}
.shot{width:100%;border:1px solid var(--line);border-radius:var(--radius);display:block;background:#fff}
.ba{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ba figcaption{font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-family:var(--mono);font-size:12px;margin:8px 0}
.kv dt{color:var(--faint)} .kv dd{margin:0;color:var(--ink);word-break:break-all}
.obs{font-family:var(--mono);font-size:11.5px;color:var(--dim);padding:2px 0;word-break:break-all}
.obs.err{color:var(--bad)}
.ws-foot{border-top:1px solid var(--line);padding:10px 16px;display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:5px 12px;border-radius:var(--radius);color:var(--dim);font-size:12px;background:var(--surface)}
.btn:hover{color:var(--ink)}
.btn.go{color:var(--accent)}
.btn.danger:hover{color:var(--bad)}

/* ---- popovers, notices -------------------------------------------------
   ONE POPOVER SHAPE for the model picker, the source picker and the
   diagnostics panel - a single surface with a subtle border and shadow to
   lift it off the page, never a glassy panel. */
.pop{position:fixed;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
     padding:6px;min-width:260px;max-height:60vh;overflow-y:auto;z-index:40;box-shadow:0 10px 28px #0007}
.pop h4{margin:6px 8px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:600}
.pop .psearch{margin:2px 4px 6px;padding:6px 9px;background:var(--surface);border-radius:var(--radius)}
.pop .psearch input{font-size:13px}
.opt{display:block;width:100%;text-align:left;padding:6px 9px;border-radius:3px;font-size:13px;color:var(--dim)}
.opt:hover{background:var(--surface);color:var(--ink)}
.opt[aria-selected=true]{color:var(--accent)}
.opt small{display:block;color:var(--faint);font-size:11px}
.opt .row1{display:flex;align-items:center;gap:6px}
.opt .row1 .st{width:6px;height:6px;border-radius:50%;background:var(--faint);flex:none}
.opt .row1 .st.ready{background:var(--ok)} .opt .row1 .st.auth{background:var(--warn)} .opt .row1 .st.bad{background:var(--bad)}
.note{padding:9px 22px;font-size:12.5px;color:var(--warn);border-top:1px solid var(--line)}
.note.bad{color:var(--bad)}

/* ---- diagnostics popover -------------------------------------------------
   Where the host/browser/environment facts moved to, out of the composer
   row. A person who wants them clicks one small header control; nobody
   else has to look at "Chromium 141" while asking a question. */
.diag{padding:2px 4px}
.diag dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:4px 6px 8px;font-size:12px}
.diag dt{color:var(--faint)} .diag dd{margin:0;color:var(--ink)}

/* ---- settings ------------------------------------------------------------
   A real navigation, not a stack of switches: sections down the left, one
   section's controls on the right. Only sections Core actually supports are
   rendered - see pagesettings.js. */
.settings{position:fixed;inset:0;background:#000a;z-index:50;display:grid;place-items:center}
.settings .box{width:min(760px,92vw);height:min(560px,84vh);background:var(--panel);border:1px solid var(--line);
  border-radius:var(--radius);display:grid;grid-template-columns:190px 1fr;overflow:hidden;box-shadow:0 20px 60px #0009}
.settings .sidenav{border-right:1px solid var(--line);padding:10px 0;overflow-y:auto}
.settings .sidenav h1{font:600 12px/1 var(--sans);letter-spacing:.08em;color:var(--dim);margin:0;padding:6px 16px 12px}
.settings .snav{display:block;width:100%;text-align:left;padding:7px 16px;color:var(--dim);font-size:12.5px}
.settings .snav:hover{color:var(--ink)}
.settings .snav[aria-selected=true]{background:var(--surface);color:var(--ink)}
.settings .pane{overflow-y:auto;padding:18px 22px}
.settings .pane h2{font:600 14px/1 var(--sans);margin:0 0 4px}
.settings .pane .sub{color:var(--faint);font-size:12px;margin:0 0 18px}
.settings .field{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid var(--line)}
.settings .field:first-of-type{border-top:0}
.settings .field .lbl{font-size:13px}
.settings .field .desc{color:var(--faint);font-size:11.5px;margin-top:2px}
.settings .field .val{color:var(--dim);font-size:12.5px;flex:none}
.settings .missing{color:var(--faint);font-size:12px;font-style:italic;padding:10px 0}
.settings .close{position:absolute;top:12px;right:14px}
.toggle{width:32px;height:18px;border-radius:9px;background:var(--surface);position:relative;flex:none}
.toggle::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--faint)}
.toggle[aria-checked=true]{background:var(--accent)}
.toggle[aria-checked=true]::after{left:16px;background:#0a1620}
.connrow{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line)}
.connrow:first-of-type{border-top:0}
.connrow .name{font-size:13px;flex:1}
.connrow .cst{font-size:12px;color:var(--faint);display:flex;align-items:center;gap:6px}
.connrow .cst .sdot{font-size:9px}
`;

/**
 * THE DOCUMENT.
 *
 * Every dynamic region is empty here and filled by the script from
 * `/api/state`. Nothing is server-rendered, so there is exactly one place a
 * fact can come from and the page cannot show a stale render of one.
 */
/**
 * THE DOCUMENT.
 *
 * THERE IS NOTHING TO AUTHENTICATE TO. The document is packaged beside the
 * host and loaded from LAIN's own window over a pipe LAIN authenticated when it
 * launched it (harnessapp/ipc.js). It takes no session, sets no cookie and has
 * no form: the browser Harness that needed all three was removed in 2026-09.
 */
function html() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LAIN Harness</title>
<style>${CSS}</style>
</head><body>

<div id="app" hidden>
  <header>
    <span class="brand">LAIN</span>
    <!-- ONLY AT NARROW WIDTHS. See the @media block: below 820px the session
         rail stops being a column, and this is how you get back to it. -->
    <button class="lane" id="railBtn" aria-expanded="false" title="Sessions">Sessions</button>
    <div class="lanes" role="tablist">
      <button class="lane" role="tab" id="laneEng" aria-selected="true">Chat / Coding</button>
      <button class="lane" role="tab" id="laneCo" aria-selected="false">Cowork / Bot</button>
    </div>
    <span class="spacer"></span>
    <span class="hint" id="conn"></span>
    <!-- DIAGNOSTICS AND SETTINGS, the two things that recede until asked for.
         Environment, host and browser facts used to sit in the composer row
         under every question a person typed; they live behind one icon now. -->
    <button class="iconbtn" id="diagBtn" title="Diagnostics" aria-label="Diagnostics">i</button>
    <button class="iconbtn" id="settingsBtn" title="Settings" aria-label="Settings">&#9881;</button>
  </header>

  <main id="main">
    <aside>
      <div class="aside-head" id="asideHead">Sessions</div>
      <div id="sessions"></div>
    </aside>

    <section class="work">
      <div class="crumb">
        <div class="head">
          <span class="proj" id="proj"></span>
          <span class="goal" id="goal"></span>
        </div>
        <span class="spacer"></span>
        <!-- CHAT / CODING, the two internal modes of an engineering session.
             Hidden entirely on the Cowork/Bot lane, where it means nothing. -->
        <div class="modes" id="modes" role="tablist">
          <button class="mode" role="tab" id="modeChat" aria-selected="true">Chat</button>
          <button class="mode" role="tab" id="modeCode" aria-selected="false">Coding</button>
        </div>
        <!-- COWORK / BOT — the lane's own two views (docs/HARNESS_UI_CONTRACT.md
             §9). Which one is showing is UI state; shown only on that lane. -->
        <div class="modes" id="botModes" role="tablist" hidden>
          <button class="mode" role="tab" id="modeCowork" aria-selected="true">Cowork</button>
          <button class="mode" role="tab" id="modeBot" aria-selected="false">Bot</button>
        </div>
        <span class="status" id="crumbStatus" hidden>
          <span class="sdot" id="crumbDot"></span><span id="crumbWord"></span>
        </span>
        <button class="btn" id="crumbStop" hidden>Stop</button>
      </div>

${require('./pagecowork').HTML}
${require('./pagebot').HTML}
      <div class="stream" id="stream"></div>

      <div id="notice" hidden></div>

      <div class="drawers" id="drawers"></div>
      <div class="drawer" id="drawer" hidden></div>

      <div class="act" id="act" hidden>
        <span class="dot" id="actDot"></span>
        <span id="actText"></span>
        <span class="clock" id="actClock"></span>
      </div>

      <div class="composer">
        <div class="box">
          <textarea id="ask" rows="1" placeholder="Ask LAIN…"></textarea>
        </div>
        <div class="tools">
          <button class="pill" id="srcPill"><span class="st" id="srcDot"></span><span id="srcName">LAIN</span></button>
          <button class="pill" id="modelPill"><b id="modelName">no model</b></button>
          <button class="pill" id="codePill">Project Files</button>
          <button class="pill" id="attachPill" hidden>Attach</button>
          <input type="file" id="attachFile" multiple hidden>
          <button class="pill" id="wsPill">Workshop</button>
          <button class="send" id="send">Send</button>
        </div>
      </div>
    </section>

    ${require('./pagesource').HTML}
    <!-- PROJECT FILES WITH NOTHING ATTACHED YET (docs/HARNESS_UI_CONTRACT.md
         section 6): a session can genuinely have no project. Shown in the same
         grid column as #srcPanel instead of it - never LAIN's own folder. -->
    <div class="src-noproject" id="srcNoProject" hidden>
      <div class="in">
        <h2>No project attached</h2>
        <p>Project Files shows the project this session works on — never LAIN’s own folder. Attach one to browse and edit it.</p>
        <div id="recentProjects"></div>
        <button class="btn primary" id="addProjectBtn">Add project…</button>
      </div>
    </div>

    <section class="workshop" id="workshop" hidden>
      <div class="ws-head">
        <span class="ws-title">Workshop</span>
        <span class="spacer"></span>
        <button class="btn" id="wsClose">Close</button>
      </div>
      <!-- DEV SERVER STATUS. "Vite . npm run dev / RUNNING / localhost:5173"
           in one line - see pageworkshop.js render() for what fills it and
           why an HTTP 500 shows here rather than a blank preview. -->
      <div class="ws-server" id="wsServer" hidden>
        <span class="sdot" id="wsServerDot"></span>
        <span id="wsServerText"></span>
        <span class="url" id="wsUrl"></span>
        <span class="spacer"></span>
        <button class="btn" id="wsRestart">Restart</button>
      </div>
      <div class="ws-bar">
        <button class="vp" data-vp="desktop" aria-selected="true">Desktop</button>
        <button class="vp" data-vp="tablet" aria-selected="false">Tablet</button>
        <button class="vp" data-vp="mobile" aria-selected="false">Mobile</button>
        <span class="spacer"></span>
        <button class="btn" id="wsPick">Select element</button>
        <button class="btn" id="wsReload">Reload</button>
      </div>
      <div class="ws-body" id="wsBody"></div>
      <div class="ws-foot">
        <button class="btn" id="wsBefore">Capture before</button>
        <button class="btn" id="wsAfter">Capture after</button>
        <button class="btn go" id="wsVerify">Verify all viewports</button>
        <button class="btn" id="wsAttach" disabled>Ask about selection</button>
      </div>
    </section>
${require('./pageimage').HTML}
${require('./pagemenu').HTML}
${require('./pagesettings').HTML}
  </main>
</div>

<script>${require('./pagescript').js()}</script>
<script>${require('./pagecontract').js()}</script>
<script>${require('./pagemodels').js()}</script>
<script>${require('./pageplan').js()}</script>
<script>${require('./pageworkshop').js()}</script>
<script>${require('./pagesource').js()}</script>
<script>${require('./pagecowork').js()}</script>
<script>${require('./pagebot').js()}</script>
<script>${require('./pageterminal').js()}</script>
<script>${require('./pageimage').SCRIPT}</script>
<script>${require('./pagemenu').SCRIPT}</script>
<script>${require('./pagesettings').js()}</script>
<script>LAIN.boot();</script>
</body></html>`;
}

module.exports = { html, CSS };
