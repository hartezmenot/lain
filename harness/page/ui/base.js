'use strict';

/**
 * THE BASE — elements, and the handful of primitives every surface shares
 * (v2, 2026-09-30). Tokens are ui/tokens.js; components are ui/kit.js.
 *
 *   element base     body, buttons, inputs, focus, scrollbars
 *   primitives       .btn (+ .primary .ghost .line .danger .small) · .iconbtn · .pill
 *                    · .st · .kbd · .tag · .dot · .spacer · .empty · .hint
 *   floating         .pop (popovers and menus: the stack in core/client.js),
 *                    .opt rows, dialogs (.dlg), toasts
 *
 * CURVED, FLAT, QUICK: controls take radius-sm (8), planes radius-md/lg, what
 * floats radius-lg; a button is a colour, never a bevel; only what floats casts
 * a shadow. Hover and press answer in ~90 ms, a popover arrives in ~130 ms —
 * opacity and transform only, nothing under reduced motion (ui/tokens.js).
 */

const CSS = `
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%;margin:0}
body{background:var(--canvas);color:var(--text-primary);font:var(--fs-body)/1.5 var(--sans);overflow:hidden;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0;transition:background-color var(--t-hover) var(--ease),color var(--t-hover) var(--ease),box-shadow var(--t-hover) var(--ease),transform var(--t-hover) var(--ease),opacity var(--t-hover) var(--ease)}
button:disabled{opacity:.45;cursor:default}
input,textarea,select{font:inherit;color:inherit}
input,textarea{background:none;border:0;outline:0;width:100%}
select{background:var(--surface-raised);color:var(--text-primary);border:0;box-shadow:inset 0 0 0 1px var(--border-subtle);border-radius:var(--radius-sm);padding:6px 10px;font-size:13px}
select:focus-visible{outline:none;box-shadow:inset 0 0 0 1px var(--accent-border)}
:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
:focus:not(:focus-visible){outline:none}
/* A TEXT FIELD SHOWS FOCUS THROUGH ITS BOX (the field, the composer, the search), not a second ring inside it. */
input:focus-visible,textarea:focus-visible{outline:none}
::selection{background:color-mix(in srgb,var(--accent-primary) 32%,transparent)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--border-subtle);border-radius:8px;border:3px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:var(--text-muted);background-clip:padding-box;border:3px solid transparent}
::-webkit-scrollbar-corner{background:transparent}
.ic{display:block;flex:none}
.spacer{flex:1}
.hint{color:var(--text-muted);font-size:var(--fs-small)}
.empty{padding:14px 10px;color:var(--text-muted);font-size:var(--fs-small);line-height:1.6}
.none{color:var(--text-muted);font-size:var(--fs-small);padding:6px 8px}
.muted{color:var(--text-secondary)} .faint{color:var(--text-muted)}
.kicker{font-size:var(--fs-caption);font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted)}
.rule{height:1px;background:var(--separator);border:0;margin:0}

/* ---- the frame ------------------------------------------------------------------------------------- */
#views{position:relative;min-height:0;display:grid;grid-template-rows:minmax(0,1fr);grid-template-columns:minmax(0,1fr)}
.view{min-height:0;min-width:0}
/* A ROOM ARRIVES: a short fade and rise — the layout never animates, only opacity and transform. */
.view.entering{animation:lain-page var(--t-page) var(--ease)}

/* ---- buttons: a flat colour, curved, never a bevel ------------------------------------------------------ */
.btn,.fbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 13px;border-radius:var(--radius-sm);font-size:var(--fs-small);font-weight:500;line-height:1.3;color:var(--text-primary);background:var(--surface-active);white-space:nowrap}
.btn:hover:not(:disabled),.fbtn:hover:not(:disabled){background:color-mix(in srgb,var(--surface-active) 72%,var(--text-primary) 9%)}
.btn:active:not(:disabled),.fbtn:active:not(:disabled){transform:scale(.97)}
.btn.small,.fbtn.small{padding:4px 10px;font-size:var(--fs-caption)}
.btn.primary,.fbtn.primary{background:var(--accent-primary);color:var(--on-accent);font-weight:600}
.btn.primary:hover:not(:disabled),.fbtn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--accent-primary) 86%,#fff 14%)}
.btn.ghost{background:transparent;color:var(--text-secondary)}
.btn.ghost:hover:not(:disabled){background:var(--hover);color:var(--text-primary)}
.fbtn.ghost,.btn.line{background:transparent;color:var(--text-secondary);box-shadow:inset 0 0 0 1px var(--border-subtle)}
.fbtn.ghost:hover:not(:disabled),.btn.line:hover:not(:disabled){background:var(--hover);color:var(--text-primary)}
.btn.go{color:var(--accent-primary)}
.btn.danger,.fbtn.danger{background:transparent;color:var(--text-secondary)}
.btn.danger:hover:not(:disabled),.fbtn.danger:hover:not(:disabled){color:var(--danger);background:var(--danger-weak)}
.btn.danger-fill{background:var(--danger);color:#fff;font-weight:600}
.iconbtn{width:28px;height:28px;border-radius:var(--radius-sm);display:inline-grid;place-items:center;color:var(--text-muted);flex:none}
.iconbtn:hover{background:var(--hover);color:var(--text-primary)}
.iconbtn:active{transform:scale(.94)}
.iconbtn[aria-pressed=true]{color:var(--accent-primary)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;color:var(--text-secondary);font-size:var(--fs-small);white-space:nowrap}
.pill:hover{background:var(--hover);color:var(--text-primary)}
.pill b{font-weight:500;color:var(--text-primary)}
.kbd{display:inline-block;padding:0 6px;border-radius:var(--radius-xs);background:var(--surface-active);color:var(--text-muted);font:500 var(--fs-caption)/1.6 var(--sans)}
.tag{display:inline-flex;align-items:center;gap:5px;padding:1px 9px;border-radius:999px;background:var(--surface-active);color:var(--text-secondary);font-size:var(--fs-caption);font-weight:500;white-space:nowrap}
.tag.ok{color:var(--positive);background:var(--positive-weak)} .tag.warn{color:var(--warning);background:var(--warning-weak)}
.tag.bad{color:var(--danger);background:var(--danger-weak)} .tag.accent{color:var(--accent-primary);background:var(--selection)}
.tag.info{color:var(--info);background:var(--info-weak)}
.st,.dot{width:7px;height:7px;border-radius:50%;background:var(--text-muted);flex:none;display:inline-block}
.st.ready,.dot.ok{background:var(--positive)} .st.auth,.dot.warn{background:var(--warning)} .st.bad,.dot.bad{background:var(--danger)}
.dot.run{background:var(--accent-primary);animation:lain-pulse 1.6s ease-in-out infinite}
.spin{width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,var(--accent-primary) 28%,transparent);border-top-color:var(--accent-primary);animation:lain-spin .8s linear infinite}
.note{padding:8px 14px;font-size:var(--fs-small);color:var(--warning)}
.note.bad{color:var(--danger)}

/* ---- floating: popovers and menus (the stack lives in core/client.js) ----------------------------------- */
.pop{position:fixed;background:var(--surface-panel);border-radius:var(--radius-lg);padding:5px;min-width:min(240px,calc(100vw - 16px));max-width:min(420px,calc(100vw - 16px));max-height:64vh;overflow-y:auto;z-index:65;box-shadow:var(--shadow-float),0 0 0 1px var(--border-subtle);animation:lain-pop var(--t-pop) var(--ease);transform-origin:top center}
.pop[data-side=above]{transform-origin:bottom center}
.pop.sub{box-shadow:var(--shadow-float),0 0 0 1px var(--accent-border)}
.pop h4{margin:6px 9px 4px;font-size:var(--fs-caption);letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);font-weight:600}
.pop .psearch{margin:2px 2px 4px;padding:7px 10px;background:var(--surface-raised);border-radius:var(--radius-sm);box-shadow:inset 0 0 0 1px var(--separator)}
.opt{display:block;width:100%;text-align:left;padding:7px 10px;border-radius:var(--radius-sm);font-size:var(--fs-body);color:var(--text-primary)}
.opt:hover,.opt:focus-visible{background:var(--selection);outline:none}
.opt[aria-selected=true]{color:var(--accent-primary)}
.opt small{display:block;color:var(--text-muted);font-size:var(--fs-caption);line-height:1.35}
.gpop{width:min(340px,calc(100vw - 16px));padding:8px}
.gpop .grow{display:grid;grid-template-columns:110px 1fr;align-items:center;gap:8px;padding:4px 0;font-size:var(--fs-small)}
.gpop .grow .gl{color:var(--text-muted)}
.gpop .grow .gv{justify-self:stretch;text-align:left;padding:5px 9px;border-radius:var(--radius-sm);background:var(--surface-raised);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gpop .grow .gv:hover{background:var(--surface-active)}
.gpop .seg{display:flex;gap:2px;background:var(--surface-raised);border-radius:var(--radius-sm);padding:2px}
.gpop .seg button{flex:1;padding:3px 6px;border-radius:var(--radius-xs);font-size:var(--fs-caption);color:var(--text-secondary)}
.gpop .seg button[aria-selected=true]{background:var(--surface-active);color:var(--text-primary)}
/* A TOOLTIP (data-tip): quick, small, curved. */
.tipbox{position:fixed;z-index:120;max-width:280px;padding:6px 10px;border-radius:var(--radius-sm);background:var(--surface-active);color:var(--text-primary);font-size:var(--fs-caption);line-height:1.4;box-shadow:var(--shadow-float);pointer-events:none;animation:lain-fade var(--t-hover) var(--ease)}

/* ---- dialogs and toasts -------------------------------------------------------------------------------- */
.dlg-back{position:fixed;inset:0;z-index:90;background:color-mix(in srgb,var(--canvas) 66%,transparent);display:grid;place-items:center;animation:lain-fade var(--t-pop) var(--ease)}
.dlg{width:min(460px,92vw);background:var(--surface-panel);border-radius:var(--radius-xl);box-shadow:var(--shadow-float),0 0 0 1px var(--border-subtle);padding:20px 22px;animation:lain-pop var(--t-drop) var(--ease)}
.dlg h3{margin:0 0 6px;font:600 var(--fs-h3)/1.3 var(--sans)}
.dlg p{margin:0 0 14px;color:var(--text-secondary);white-space:pre-line}
.dlg-field{display:block;margin:0 0 12px}
.dlg-field > span{display:block;font-size:var(--fs-caption);color:var(--text-muted);margin-bottom:4px}
.dlg-line{display:flex;gap:8px}
.dlg-line input,.dlg-line select{background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--border-subtle);border-radius:var(--radius-sm);padding:8px 11px;font-size:var(--fs-body)}
.dlg-line input:focus,.dlg-line select:focus{box-shadow:inset 0 0 0 1px var(--accent-border)}
.dlg-line select{flex:1;min-width:0;border:0;color:var(--text-primary);font-family:inherit}
.dlg-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
#toasts{position:fixed;right:16px;bottom:16px;z-index:95;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none}
.toast{max-width:420px;padding:10px 15px;border-radius:var(--radius-lg);background:var(--surface-active);box-shadow:var(--shadow-float);font-size:var(--fs-small);color:var(--text-primary);transition:opacity var(--t-panel) var(--ease),transform var(--t-panel) var(--ease);animation:lain-pop var(--t-drop) var(--ease)}
.toast.bad{color:var(--danger);background:color-mix(in srgb,var(--danger) 12%,var(--surface-active))}
.toast.out{opacity:0;transform:translateY(6px)}
`;

module.exports = { CSS };
