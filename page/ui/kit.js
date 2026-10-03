'use strict';

/**
 * THE KIT — the shared components of every Harness surface, `L.kit` (v2, 2026-09-30).
 *
 *   page frame      u-page · u-head (title, one line of context, actions) · u-tabs
 *   plane           u-plane — a FLAT colour plane (surface-base, or a tint: blue ·
 *                   violet · teal · amber · rose · accent), curved, no border, no
 *                   shadow. Planes are how a surface is composed.
 *   section         u-sec — a heading and its rows, inside or outside a plane
 *   row             u-row — name + facts, quota or facts, ⋯; hairline-separated
 *   quota           u-q — a window label, a thin bar of what REMAINS, "N% remaining"
 *   charts          ring (one value, its number in the middle) · donut (shares,
 *                   with a legend) · bars (a series over time) — inline SVG, no
 *                   chart library: three shapes do not earn one
 *   segmented       u-seg — two to five choices, the chosen one a raised pill
 *   tooltip         any element with data-tip — quick, small, curved
 *   inline select   "Automatic ▾" · overflow ⋯ · menus (u-menu)
 *   setting row     label and description, the control on the right
 *   side sheet      one header, grouped body; a full page on a narrow window
 *   empty state     one line saying what is missing, one action
 *
 * EVERY CLASS IS `u-` PREFIXED; nothing here restyles an element or another
 * module's class. Sizes are final at --ts = 1 (ui/tokens.js).
 *
 * PROVIDER MARKS are LAIN-drawn neutral glyphs. Official brand assets are not
 * bundled: there is no licence to redistribute them.
 */

const CSS = `
/* ---- page frame ------------------------------------------------------------------------------------ */
.u-page{width:100%;max-width:1120px;margin:0 auto;padding:22px 32px 48px}
.u-page.wide{max-width:1280px}
.u-scroll{height:100%;overflow-y:auto;min-height:0}
.u-head{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-4);flex-wrap:wrap;margin:0 0 18px}
.u-title{margin:0;font:600 var(--fs-h1)/1.2 var(--display);letter-spacing:-.01em;color:var(--text-primary)}
.u-sub{margin:4px 0 0;font-size:var(--fs-body);line-height:1.5;color:var(--text-secondary);max-width:68ch}
.u-acts{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap}
.u-tabs{display:flex;gap:22px;border-bottom:1px solid var(--separator);margin:0 0 18px;overflow-x:auto;scrollbar-width:none}
.u-tabs::-webkit-scrollbar{display:none}
.u-tab{position:relative;padding:6px 0 10px;font-size:var(--fs-body);font-weight:500;color:var(--text-secondary);white-space:nowrap}
.u-tab::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--accent-primary);transform:scaleX(0);transition:transform var(--t-tab) var(--ease)}
.u-tab:hover{color:var(--text-primary)}
.u-tab[aria-selected=true]{color:var(--text-primary)}
.u-tab[aria-selected=true]::after{transform:scaleX(1)}
.u-tab .u-count{margin-left:6px;color:var(--text-muted);font-weight:400}

/* ---- planes: flat colour, curved, no border, no shadow ------------------------------------------------------ */
.u-plane{background:var(--surface-base);border-radius:var(--radius-md);padding:16px 18px}
.u-plane + .u-plane{margin-top:12px}
.u-plane.blue{background:var(--plane-blue)} .u-plane.violet{background:var(--plane-violet)} .u-plane.teal{background:var(--plane-teal)}
.u-plane.amber{background:var(--plane-amber)} .u-plane.rose{background:var(--plane-rose)} .u-plane.accent{background:var(--plane-accent)}
.u-plane.flat{background:transparent;padding:0}
.u-ph{display:flex;align-items:center;gap:10px;margin:0 0 12px}
.u-ph .u-ph-ic{width:30px;height:30px;border-radius:var(--radius-sm);display:grid;place-items:center;background:var(--accent-weak);color:var(--accent-primary);flex:none}
.u-ph h3{margin:0;font:600 var(--fs-h3)/1.3 var(--sans);color:var(--text-primary)}
.u-ph small{display:block;font-size:var(--fs-small);color:var(--text-secondary);font-weight:400}
.u-ph .u-acts{margin-left:auto}

/* ---- section: a heading, then rows ------------------------------------------------------------------------ */
.u-sec{padding:0}
.u-sec + .u-sec{margin-top:20px}
.u-sech{display:flex;align-items:center;gap:10px;min-height:32px;margin-bottom:4px}
.u-mark{width:20px;height:20px;flex:none;color:var(--text-secondary)}
.u-sech-t{min-width:0;flex:1}
.u-sech-t h3{margin:0;font:600 var(--fs-h3)/1.3 var(--sans);color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.u-sech-t .u-meta{display:block;font-size:var(--fs-small);color:var(--text-secondary)}
.u-sech-a{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.u-link{color:var(--accent-primary);font-size:var(--fs-small)}
.u-link:hover{text-decoration:underline}

/* ---- controls --------------------------------------------------------------------------------------------- */
.u-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 13px;border-radius:var(--radius-sm);font-size:var(--fs-small);font-weight:500;line-height:1.3;color:var(--text-primary);background:var(--surface-active);white-space:nowrap}
.u-btn:hover:not(:disabled){background:color-mix(in srgb,var(--surface-active) 72%,var(--text-primary) 9%)}
.u-btn:active:not(:disabled){transform:scale(.97)}
.u-btn.pri{background:var(--accent-primary);color:var(--on-accent);font-weight:600}
.u-btn.pri:hover:not(:disabled){background:color-mix(in srgb,var(--accent-primary) 86%,#fff 14%)}
.u-btn.sec{background:var(--accent-secondary);color:var(--on-secondary);font-weight:600}
.u-btn.ghost{background:transparent;color:var(--text-secondary)}
.u-btn.ghost:hover:not(:disabled){background:var(--hover);color:var(--text-primary)}
.u-btn.line{background:transparent;box-shadow:inset 0 0 0 1px var(--border-subtle)}
.u-btn.line:hover:not(:disabled){background:var(--hover)}
.u-btn.danger{background:transparent;color:var(--text-secondary)}
.u-btn.danger:hover:not(:disabled){color:var(--danger);background:var(--danger-weak)}
.u-btn.sm{padding:4px 10px;font-size:var(--fs-caption)}
.u-ib{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:var(--radius-sm);color:var(--text-secondary);flex:none}
.u-ib:hover{background:var(--hover);color:var(--text-primary)}
.u-ib:active{transform:scale(.94)}
.u-in{display:inline-flex;align-items:center;gap:5px;padding:5px 9px;border-radius:var(--radius-sm);font-size:var(--fs-small);color:var(--text-primary);white-space:nowrap}
.u-in:hover{background:var(--hover)}
.u-in svg{color:var(--text-muted)}
.u-field{padding:9px 12px;border-radius:var(--radius-sm);background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--separator);font-size:var(--fs-body);color:var(--text-primary);width:100%}
.u-field:focus{box-shadow:inset 0 0 0 1px var(--accent-border)}
.u-search{display:flex;align-items:center;gap:8px;padding:0 12px;border-radius:var(--radius-md);background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--separator);color:var(--text-muted)}
.u-search:focus-within{box-shadow:inset 0 0 0 1px var(--accent-border)}
.u-search input{padding:9px 0;font-size:var(--fs-body);color:var(--text-primary)}
.u-chips{display:flex;gap:6px;flex-wrap:wrap}
.u-chip{font-size:var(--fs-small);color:var(--text-secondary);padding:4px 12px;border-radius:999px;background:var(--surface-raised)}
.u-chip:hover{color:var(--text-primary);background:var(--surface-active)}
.u-chip[aria-pressed=true]{color:var(--on-accent);background:var(--accent-primary)}
.u-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--text-muted);flex:none}
.u-dot.ok{background:var(--positive)} .u-dot.warn{background:var(--warning)} .u-dot.bad{background:var(--danger)} .u-dot.acc{background:var(--accent-primary)} .u-dot.sec{background:var(--accent-secondary)}
.u-menu{min-width:220px;padding:5px}
.u-menu .opt{padding:7px 10px;font-size:var(--fs-body);color:var(--text-primary);display:flex;align-items:flex-start;gap:10px}
.u-menu .opt small{display:block;color:var(--text-muted);font-size:var(--fs-caption)}
.u-menu .opt .ck{width:14px;flex:none;color:var(--accent-primary);margin-top:2px}
.u-menu .opt.danger{color:var(--danger)}
.u-menu hr{border:0;height:1px;background:var(--separator);margin:4px 0}
.u-menu .u-mh{margin:6px 10px 2px;font-size:var(--fs-caption);color:var(--text-muted)}
/* SEGMENTED: the chosen choice is a raised pill that slides between the others. */
.u-seg{position:relative;display:inline-flex;gap:2px;padding:3px;border-radius:999px;background:var(--surface-raised)}
.u-seg > button{position:relative;z-index:1;display:inline-flex;align-items:center;gap:7px;padding:5px 14px;border-radius:999px;font-size:var(--fs-small);font-weight:500;color:var(--text-secondary);white-space:nowrap}
.u-seg > button:hover{color:var(--text-primary)}
.u-seg > button[aria-selected=true]{color:var(--text-primary)}
.u-seg .u-seg-ind{position:absolute;z-index:0;top:3px;bottom:3px;left:0;border-radius:999px;background:var(--surface-active);transition:transform var(--t-tab) var(--ease),width var(--t-tab) var(--ease)}
.u-seg .u-seg-dot{width:7px;height:7px;border-radius:50%;box-shadow:inset 0 0 0 1.5px currentColor}
.u-seg > button[aria-selected=true] .u-seg-dot{background:var(--accent-primary);box-shadow:none}

/* ---- rows ------------------------------------------------------------------------------------------------- */
.u-rows{display:flex;flex-direction:column}
.u-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr) 28px;gap:6px 20px;align-items:center;width:100%;text-align:left;padding:10px 0}
.u-row + .u-row{border-top:1px solid color-mix(in srgb,var(--border-subtle) 70%,transparent)}
.u-row.click{cursor:pointer;border-radius:var(--radius-sm)}
.u-row.click:hover{background:var(--hover);box-shadow:-10px 0 0 var(--hover),10px 0 0 var(--hover)}
.u-row .u-id{min-width:0}
.u-row .u-nm{display:flex;align-items:center;gap:8px;font-size:var(--fs-body);font-weight:600;color:var(--text-primary);min-width:0}
.u-row .u-nm span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.u-row .u-st{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-small);font-weight:400;color:var(--text-secondary);white-space:nowrap}
.u-row .u-who{font-size:var(--fs-small);color:var(--text-secondary);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.u-row .u-qs{display:flex;flex-direction:column;gap:5px;min-width:0}
.u-row .u-qn{font-size:var(--fs-small);color:var(--text-muted)}
.u-row.plain{grid-template-columns:minmax(0,1fr) auto}
.u-q{display:grid;grid-template-columns:62px minmax(0,1fr) auto;gap:10px;align-items:center;font-size:var(--fs-small);color:var(--text-secondary)}
.u-q .b{height:5px;border-radius:3px;background:color-mix(in srgb,var(--text-primary) 9%,transparent);overflow:hidden}
.u-q .b i{display:block;height:100%;background:var(--quota-ok);border-radius:3px;transition:width var(--t-panel) var(--ease)}
.u-q .b i.warn{background:var(--quota-warn)} .u-q .b i.bad{background:var(--quota-bad)}
.u-q .v{text-align:right;color:var(--text-primary);font-variant-numeric:tabular-nums;white-space:nowrap}
.u-q .v small{color:var(--text-muted);font-size:var(--fs-caption);margin-left:6px}
.u-q .v.warn{color:var(--quota-warn)} .u-q .v.bad{color:var(--quota-bad)}
.u-empty{padding:14px 0;font-size:var(--fs-body);color:var(--text-secondary);line-height:1.55}
.u-empty b{display:block;margin-bottom:2px;font-size:var(--fs-h3);font-weight:600;color:var(--text-primary)}
.u-empty .u-btn{margin-top:10px}
.u-note{font-size:var(--fs-small);color:var(--text-muted);line-height:1.5}
.u-warnline{display:flex;gap:8px;align-items:baseline;font-size:var(--fs-small);color:var(--warning)}
.u-notice{display:flex;align-items:center;gap:10px;width:100%;padding:10px 14px;border-radius:var(--radius-md);background:var(--warning-weak);color:var(--text-primary);font-size:var(--fs-body);text-align:left}
.u-notice:hover{background:color-mix(in srgb,var(--warning) 20%,transparent)}
.u-notice .u-dot{background:var(--warning)}
.u-notice .go{margin-left:auto;color:var(--text-secondary);font-size:var(--fs-small)}

/* ---- charts: ring · donut · bars · stat ------------------------------------------------------------------- */
.u-ring{position:relative;display:inline-grid;place-items:center;flex:none}
.u-ring svg{display:block;transform:rotate(-90deg)}
.u-ring .trk{stroke:color-mix(in srgb,var(--text-primary) 9%,transparent)}
.u-ring .val{transition:stroke-dashoffset 600ms var(--ease)}
.u-ring .ctr{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;line-height:1.1}
.u-ring .ctr b{font:600 var(--fs-h3)/1.1 var(--display);color:var(--text-primary);font-variant-numeric:tabular-nums}
.u-ring .ctr small{font-size:var(--fs-caption);color:var(--text-secondary)}
.u-ring.lg .ctr b{font-size:calc(30px * var(--ts))} .u-ring.lg .ctr small{font-size:var(--fs-small)}
.u-ring.sm .ctr b{font-size:var(--fs-small)}
.u-legend{display:flex;flex-direction:column;gap:6px;min-width:0}
.u-legend .lr{display:grid;grid-template-columns:10px minmax(0,1fr) auto auto;align-items:center;gap:8px;font-size:var(--fs-small);color:var(--text-secondary);text-align:left;padding:2px 4px;border-radius:var(--radius-xs)}
.u-legend .u-note{padding:2px 4px}
.u-legend button.lr:hover{background:var(--hover);color:var(--text-primary)}
.u-legend i{width:9px;height:9px;border-radius:50%}
.u-legend span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.u-legend b{color:var(--text-primary);font-weight:500;font-variant-numeric:tabular-nums}
.u-legend em{font-style:normal;color:var(--text-muted);font-variant-numeric:tabular-nums;min-width:34px;text-align:right}
.u-bars{display:flex;align-items:flex-end;gap:3px;height:120px;padding-top:6px}
.u-bars .b{flex:1;min-width:3px;height:100%;display:flex;flex-direction:column-reverse;border-radius:3px 3px 1px 1px;overflow:hidden}
.u-bars .b:hover{filter:brightness(1.15)}
.u-bars .b i{display:block;width:100%;transition:height var(--t-panel) var(--ease)}
.u-bars-x{display:flex;justify-content:space-between;font-size:var(--fs-caption);color:var(--text-muted);margin-top:6px}
.u-stat{display:grid;grid-template-columns:34px minmax(0,1fr);gap:4px 12px;align-items:center;min-width:0}
.u-stat .ic-b{grid-row:1 / span 2;width:34px;height:34px;border-radius:var(--radius-sm);display:grid;place-items:center;background:var(--accent-weak);color:var(--accent-primary)}
.u-stat .ic-b.sec{background:var(--secondary-weak);color:var(--accent-secondary)}
.u-stat .k{font-size:var(--fs-small);color:var(--text-secondary)}
.u-stat .v{font:600 var(--fs-h2)/1.15 var(--display);color:var(--text-primary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.u-stat .v small{font:400 var(--fs-small)/1 var(--sans);color:var(--text-muted);margin-left:4px}

/* ---- settings row ----------------------------------------------------------------------------------------- */
.u-set{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:10px 0;border-top:1px solid var(--separator)}
.u-set:first-of-type{border-top:0}
.u-set .u-st2{min-width:0}
.u-set .u-st2 b{display:block;font-size:var(--fs-body);font-weight:500;color:var(--text-primary)}
.u-set .u-st2 small{display:block;font-size:var(--fs-small);color:var(--text-secondary);margin-top:1px;line-height:1.45}
.u-set .u-ctl{flex:none;display:flex;align-items:center;gap:8px}

/* ---- side sheet ------------------------------------------------------------------------------------------- */
.u-sheet-back{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;background:color-mix(in srgb,var(--canvas) 55%,transparent);animation:lain-fade var(--t-pop) var(--ease)}
.u-sheet{width:min(520px,100vw);height:100%;display:flex;flex-direction:column;background:var(--surface-panel);box-shadow:var(--shadow-float);border-radius:var(--radius-xl) 0 0 var(--radius-xl);animation:lain-sheet var(--t-panel) var(--ease)}
@keyframes lain-sheet{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
.u-sheet-h{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid var(--separator);flex:none}
.u-sheet-h h2{margin:0;flex:1;min-width:0;font:600 var(--fs-h2)/1.25 var(--display);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.u-sheet-h .u-meta{font-size:var(--fs-small);color:var(--text-secondary)}
.u-sheet-b{flex:1;min-height:0;overflow-y:auto;padding:18px 20px}
.u-group{padding:0 0 18px}
.u-group + .u-group{border-top:1px solid var(--separator);padding-top:18px}
.u-group > h4{margin:0 0 10px;font-size:var(--fs-body);font-weight:600;color:var(--text-primary)}
.u-kv{display:grid;grid-template-columns:128px minmax(0,1fr);gap:6px 14px;font-size:var(--fs-body);margin:0}
.u-kv dt{color:var(--text-secondary)} .u-kv dd{margin:0;color:var(--text-primary);overflow-wrap:anywhere}
.u-acts-col{display:flex;flex-direction:column;align-items:flex-start;gap:4px}
@media (max-width:900px){.u-sheet{width:100vw;border-radius:0}.u-sheet-back{background:var(--surface-base)}}

/* ---- the older segmented control, flat ----------------------------------------------------------------------- */
.seg{display:inline-flex;gap:2px;padding:3px;background:var(--surface-raised);border-radius:999px}
.seg > button{padding:4px 12px;border-radius:999px;font-size:var(--fs-small);color:var(--text-secondary);font-weight:500}
.seg > button:hover{color:var(--text-primary)}
.seg > button[aria-pressed=true],.seg > button[aria-selected=true]{color:var(--text-primary);background:var(--surface-active)}

/* ---- responsive --------------------------------------------------------------------------------------------- */
@media (max-width:1000px){.u-row{grid-template-columns:minmax(0,1fr) 28px}.u-row .u-qs{grid-column:1 / -1;grid-row:2}}
@media (max-width:820px){.u-page{padding:18px 16px 32px}.u-sech{flex-wrap:wrap}.u-sech-a{width:100%;justify-content:flex-start}}
@media (max-width:520px){.u-q{grid-template-columns:54px minmax(0,1fr) auto}.u-kv{grid-template-columns:1fr}.u-kv dt{margin-top:6px}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var NS = 'http://www.w3.org/2000/svg';

  // ---- PROVIDER MARKS: LAIN-drawn, neutral, one stroke weight ---------------------------------------------
  var MARKS = {
    codex: 'M6 7.5 10.5 12 6 16.5M13 17h5.5',
    claude: 'M12 3.5v17M3.5 12h17M6 6l12 12M18 6 6 18',
    antigravity: 'M12 19.5V5.5M6.5 11 12 5.5l5.5 5.5M6 20.5h12',
    opencode: 'M9 4.5c-2 0-3 1-3 3v2.2c0 1.2-.8 2.3-2 2.3 1.2 0 2 1.1 2 2.3v2.2c0 2 1 3 3 3M15 4.5c2 0 3 1 3 3v2.2c0 1.2.8 2.3 2 2.3-1.2 0-2 1.1-2 2.3v2.2c0 2-1 3-3 3',
    local: 'M8 6.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 16V8A1.5 1.5 0 0 1 8 6.5ZM10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3',
    api: 'M9 4v4.5M15 4v4.5M6.5 8.5h11V12a5.5 5.5 0 0 1-11 0ZM12 17.5V21',
    zai: 'M6 6.5h12L6 17.5h12',
    other: 'M12 3.5 19.5 8v8L12 20.5 4.5 16V8Z',
  };
  function markKey(id) {
    id = String(id || '');
    if (/^api:.*z\.?ai|^api:zai|^api:zhipu/i.test(id)) return 'zai';
    if (id.indexOf('api:') === 0 || id === 'api') return 'api';
    return MARKS[id] ? id : 'other';
  }
  function mark(family, px) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'u-mark ic');
    if (px) { s.setAttribute('width', px); s.setAttribute('height', px); }
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.7'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true'); s.setAttribute('data-mark', markKey(family));
    var p = document.createElementNS(NS, 'path'); p.setAttribute('d', MARKS[markKey(family)]); s.appendChild(p);
    return s;
  }
  /** Which tint a provider's plane wears: a few degrees of hue, never saturation. */
  var TINT = { codex: 'blue', claude: 'violet', antigravity: 'teal', opencode: 'amber', local: 'rose' };
  function tintOf(family) { return TINT[markKey(family)] || ''; }
  /** A provider's chart colour — the same one everywhere it is drawn. */
  var HUE = { codex: 'var(--info)', claude: 'var(--accent-primary)', antigravity: 'var(--accent-secondary)', opencode: 'var(--warning)', local: 'var(--accent-tertiary)', zai: 'var(--positive)' };
  function hueOf(family, i) { return HUE[markKey(family)] || ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'][(i || 0) % 6]; }

  // ---- NUMBERS -----------------------------------------------------------------------------------------------
  /** 87.4M · 12.4K · 931 — compact, tabular, never a false precision. */
  function fmtNum(n) {
    n = Number(n) || 0;
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
    return String(Math.round(n));
  }

  // ---- QUOTA: only what the provider reported ---------------------------------------------------------------
  function winLabel(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    if (/^(5|five)[\s_-]*(h|hr|hour)s?$/i.test(s)) return '5-hour';
    if (/^(7|seven)[\s_-]*(d|day)s?$|^week(ly)?$/i.test(s)) return 'Weekly';
    if (/^month(ly)?$/i.test(s)) return 'Monthly';
    if (/^dai(ly)?$|^day$/i.test(s)) return 'Daily';
    if (/^credits?$/i.test(s)) return 'Credits';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  /** "resets in 2h 13m" for the next hours, "resets Tue 09:00" for a day or more. */
  function resetText(at) {
    if (!at) return '';
    var t = Number(at) || Date.parse(at);
    var ms = t - Date.now();
    if (!isFinite(ms)) return '';
    if (ms <= 0) return 'reset';
    var m = Math.round(ms / 60000);
    if (m < 60) return 'resets in ' + m + 'm';
    if (m < 24 * 60) return 'resets in ' + Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    var d = new Date(t);
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return 'resets ' + days[d.getDay()] + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function remainingOf(w) {
    if (w.remainingPercent != null) return Math.max(0, Math.min(100, Math.round(Number(w.remainingPercent))));
    if (w.usedPercent != null) return Math.max(0, Math.min(100, Math.round(100 - Number(w.usedPercent))));
    return null;
  }
  /** THE SEMANTICS, in one place: what REMAINS is the bar and the words; red ≤ 5 % remaining, amber ≤ 20 %. */
  function quotaTone(rem) { return rem <= 5 ? 'bad' : rem <= 20 ? 'warn' : ''; }
  function toneColor(rem) { var t = quotaTone(rem); return t === 'bad' ? 'var(--quota-bad)' : t === 'warn' ? 'var(--quota-warn)' : 'var(--quota-ok)'; }
  function qbar(w) {
    var label = winLabel(w.label);
    var rem = remainingOf(w);
    if (rem == null && w.credits == null) return null;
    var r = el('div', 'u-q');
    r.setAttribute('data-window', label);
    r.appendChild(el('span', '', label || 'Credits'));
    if (rem == null) { r.appendChild(el('span', '')); r.appendChild(el('span', 'v', String(w.credits))); return r; }
    var tone = quotaTone(rem);
    r.setAttribute('data-remaining', String(rem)); r.setAttribute('data-used', String(100 - rem)); r.setAttribute('data-tone', tone || 'ok');
    var b = el('span', 'b'); var i = el('i', tone); i.style.width = rem + '%'; b.appendChild(i);
    r.appendChild(b);
    var v = el('span', 'v' + (tone ? ' ' + tone : ''), rem + '% remaining');
    var rs = w.expired ? 'reset — updates on the next read' : resetText(w.resetsAt);
    if (rs) v.appendChild(el('small', '', rs));
    r.appendChild(v);
    r.title = (100 - rem) + '% used · ' + rem + '% remaining' + (rs ? ' · ' + rs : '');
    return r;
  }
  function quota(windows, note) {
    var box = el('div', 'u-qs');
    var any = false;
    (windows || []).forEach(function (w) { var q = qbar(w); if (q) { box.appendChild(q); any = true; } });
    if (!any) box.appendChild(el('div', 'u-qn', note || 'Quota not reported yet'));
    return box;
  }

  // ---- CHARTS ------------------------------------------------------------------------------------------------------
  function svgEl(tag, attrs) { var e = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }
  /**
   * A RING: one value 0–100 around a circle, its number in the middle. o: { size, stroke, color, label, sub, cls }.
   * value null draws the empty track and "—": nothing is invented.
   */
  function ring(value, o) {
    o = o || {};
    var size = o.size || 64, sw = o.stroke || Math.max(4, Math.round(size / 11)), r = (size - sw) / 2, c = 2 * Math.PI * r;
    var box = el('span', 'u-ring' + (o.cls ? ' ' + o.cls : ''));
    box.style.width = size + 'px'; box.style.height = size + 'px';
    var s = svgEl('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, 'aria-hidden': 'true' });
    s.appendChild(svgEl('circle', { class: 'trk', cx: size / 2, cy: size / 2, r: r, fill: 'none', 'stroke-width': sw }));
    var v = value == null ? null : Math.max(0, Math.min(100, Number(value)));
    var arc = svgEl('circle', { class: 'val', cx: size / 2, cy: size / 2, r: r, fill: 'none', 'stroke-width': sw, 'stroke-linecap': 'round', stroke: o.color || 'var(--accent-secondary)', 'stroke-dasharray': c + ' ' + c, 'stroke-dashoffset': c });
    s.appendChild(arc);
    box.appendChild(s);
    // THE ARC DRAWS IN (≈600 ms, transform-free): the stroke offset animates from empty to its value.
    if (v != null) requestAnimationFrame(function () { requestAnimationFrame(function () { arc.setAttribute('stroke-dashoffset', String(c * (1 - v / 100))); }); });
    var ctr = el('span', 'ctr');
    ctr.appendChild(el('b', '', o.label != null ? o.label : (v == null ? '—' : Math.round(v) + '%')));
    if (o.sub) ctr.appendChild(el('small', '', o.sub));
    box.appendChild(ctr);
    if (o.title) box.title = o.title;
    return box;
  }
  /**
   * A DONUT of shares: segments [{ label, value, color }], its centre text, and (o.legend) a legend whose rows can be
   * clicked (o.onPick(segment)). Segments with no value are left out; a donut of nothing is an empty ring.
   */
  function donut(segments, o) {
    o = o || {};
    var size = o.size || 132, sw = o.stroke || 16, r = (size - sw) / 2, c = 2 * Math.PI * r;
    var segs = (segments || []).filter(function (x) { return Number(x.value) > 0; });
    var total = segs.reduce(function (a, x) { return a + Number(x.value); }, 0);
    var wrap = el('div', '');
    wrap.style.cssText = 'display:flex;align-items:center;gap:18px;min-width:0';
    var box = el('span', 'u-ring');
    box.style.width = size + 'px'; box.style.height = size + 'px';
    var s = svgEl('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, 'aria-hidden': 'true' });
    s.appendChild(svgEl('circle', { class: 'trk', cx: size / 2, cy: size / 2, r: r, fill: 'none', 'stroke-width': sw }));
    var at = 0;
    var gap = segs.length > 1 ? Math.min(3, c * 0.006) : 0;
    segs.forEach(function (x, i) {
      var len = total ? (Number(x.value) / total) * c : 0;
      var arc = svgEl('circle', { cx: size / 2, cy: size / 2, r: r, fill: 'none', 'stroke-width': sw, stroke: x.color || hueOf(x.key, i), 'stroke-dasharray': Math.max(0, len - gap) + ' ' + c, 'stroke-dashoffset': String(-at) });
      if (x.label) { var t = svgEl('title', {}); t.textContent = x.label + ' · ' + Math.round(100 * Number(x.value) / total) + '%'; arc.appendChild(t); }
      s.appendChild(arc);
      at += len;
    });
    box.appendChild(s);
    var ctr = el('span', 'ctr');
    ctr.appendChild(el('b', '', o.label != null ? o.label : fmtNum(total)));
    if (o.sub) ctr.appendChild(el('small', '', o.sub));
    box.appendChild(ctr);
    wrap.appendChild(box);
    if (o.legend !== false) { var lg = legend(segs, o); lg.style.flex = '1'; wrap.appendChild(lg); }
    return wrap;
  }
  /** A donut's legend on its own: colour, name, value, share — each row clickable when o.onPick is given. */
  function legend(segments, o) {
    o = o || {};
    var segs = (segments || []).filter(function (x) { return Number(x.value) > 0; });
    var total = segs.reduce(function (a, x) { return a + Number(x.value); }, 0);
    var lg = el('div', 'u-legend');
    segs.forEach(function (x, i) {
      var row = el(o.onPick ? 'button' : 'div', 'lr');
      if (x.key) row.setAttribute('data-key', x.key);
      var dotEl = el('i', ''); dotEl.style.background = x.color || hueOf(x.key, i); row.appendChild(dotEl);
      row.appendChild(el('span', '', x.label));
      row.appendChild(el('b', '', x.valueText || fmtNum(x.value)));
      row.appendChild(el('em', '', total ? Math.round(100 * Number(x.value) / total) + '%' : ''));
      if (o.onPick) row.onclick = function () { o.onPick(x); };
      lg.appendChild(row);
    });
    if (!segs.length) lg.appendChild(el('div', 'u-note', o.empty || 'Nothing recorded yet.'));
    return lg;
  }
  /** BARS over time: points [{ label, parts: [{ value, color }] }] — stacked, scaled to the tallest. */
  function bars(points, o) {
    o = o || {};
    var wrap = el('div', '');
    var box = el('div', 'u-bars');
    if (o.height) box.style.height = o.height + 'px';
    var max = Math.max.apply(null, [1].concat(points.map(function (p) { return p.parts.reduce(function (a, x) { return a + (Number(x.value) || 0); }, 0); })));
    points.forEach(function (p) {
      var b = el('span', 'b');
      var sum = p.parts.reduce(function (a, x) { return a + (Number(x.value) || 0); }, 0);
      b.title = p.label + ' · ' + fmtNum(sum);
      p.parts.forEach(function (x) { var i = el('i', ''); i.style.background = x.color; i.style.height = (100 * (Number(x.value) || 0) / max) + '%'; b.appendChild(i); });
      box.appendChild(b);
    });
    wrap.appendChild(box);
    if (points.length) {
      var xs = el('div', 'u-bars-x');
      var n = Math.min(5, points.length);
      for (var k = 0; k < n; k++) { var idx = Math.round(k * (points.length - 1) / Math.max(1, n - 1)); xs.appendChild(el('span', '', points[idx].label)); }
      wrap.appendChild(xs);
    }
    return wrap;
  }
  /** A STAT: an icon block, a label, a big value (and a quiet unit). */
  function stat(icon, label, value, unit, tone) {
    var s = el('div', 'u-stat');
    var ib = el('span', 'ic-b' + (tone ? ' ' + tone : '')); ib.appendChild(L.icon(icon, 17)); s.appendChild(ib);
    s.appendChild(el('span', 'k', label));
    var v = el('span', 'v', value); if (unit) v.appendChild(el('small', '', unit)); s.appendChild(v);
    return s;
  }

  // ---- STRUCTURE ---------------------------------------------------------------------------------------------
  function head(title, sub, actions) {
    var h = el('div', 'u-head');
    var t = el('div', '');
    t.appendChild(el('h1', 'u-title', title));
    if (sub) t.appendChild(el('p', 'u-sub', sub));
    h.appendChild(t);
    if (actions && actions.length) { var a = el('div', 'u-acts'); actions.forEach(function (x) { if (x) a.appendChild(x); }); h.appendChild(a); }
    return h;
  }
  /** items: [[id, label, count?]]; onPick(id). */
  function tabs(items, current, onPick, cls) {
    var box = el('div', 'u-tabs' + (cls ? ' ' + cls : ''));
    box.setAttribute('role', 'tablist');
    items.forEach(function (t) {
      var b = el('button', 'u-tab', t[1]);
      if (t[2] != null && t[2] !== '') b.appendChild(el('span', 'u-count', String(t[2])));
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(t[0] === current)); b.setAttribute('data-tab', t[0]);
      b.onclick = function () { onPick(t[0]); };
      box.appendChild(b);
    });
    return box;
  }
  /**
   * SEGMENTED — items [[id, label, opts?]] (opts.dot draws a state dot); the indicator slides to the chosen one.
   * Returns the element; call .set(id) to move it without rebuilding.
   */
  function segmented(items, current, onPick, o) {
    o = o || {};
    var box = el('div', 'u-seg' + (o.cls ? ' ' + o.cls : ''));
    box.setAttribute('role', 'tablist');
    var ind = el('span', 'u-seg-ind'); box.appendChild(ind);
    var btns = {};
    items.forEach(function (t) {
      var b = el('button', '');
      if (t[2] && t[2].dot) b.appendChild(el('span', 'u-seg-dot'));
      if (t[2] && t[2].icon) b.appendChild(L.icon(t[2].icon, 15));
      b.appendChild(el('span', '', t[1]));
      b.setAttribute('role', 'tab'); b.setAttribute('data-seg', t[0]);
      b.onclick = function () { if (onPick) onPick(t[0]); };
      btns[t[0]] = b;
      box.appendChild(b);
    });
    function place(id, instant) {
      Object.keys(btns).forEach(function (k) { btns[k].setAttribute('aria-selected', String(k === id)); });
      var b = btns[id];
      if (!b) return;
      if (instant) ind.style.transition = 'none';
      ind.style.width = b.offsetWidth + 'px';
      ind.style.transform = 'translateX(' + b.offsetLeft + 'px)';
      if (instant) requestAnimationFrame(function () { ind.style.transition = ''; });
    }
    box.set = function (id) { place(id, false); };
    requestAnimationFrame(function () { place(current, true); });
    // A room that was hidden when this was built measures zero: place again when it becomes visible.
    if (window.ResizeObserver) new ResizeObserver(function () { var sel = box.querySelector('[aria-selected=true]'); place(sel ? sel.getAttribute('data-seg') : current, true); }).observe(box);
    return box;
  }
  function button(label, kind, fn, icon) {
    var b = el('button', 'u-btn' + (kind ? ' ' + kind : ''));
    if (icon) b.appendChild(L.icon(icon, 15));
    b.appendChild(document.createTextNode(label));
    if (fn) b.onclick = fn;
    return b;
  }
  function iconButton(icon, title, fn) {
    var b = el('button', 'u-ib'); b.setAttribute('data-tip', title); b.setAttribute('aria-label', title);
    b.appendChild(L.icon(icon, 17)); if (fn) b.onclick = function (e) { e.stopPropagation(); fn(b, e); };
    return b;
  }
  /** A FLAT PLANE: o.tint (blue · violet · teal · amber · rose · accent), o.cls. */
  function plane(o) {
    o = o || {};
    var p = el(o.tag || 'div', 'u-plane' + (o.tint ? ' ' + o.tint : '') + (o.cls ? ' ' + o.cls : ''));
    if (o.id) p.setAttribute('data-plane', o.id);
    return p;
  }
  /** A plane's heading: an icon block, a title, a quiet line, actions on the right. */
  function planeHead(icon, title, sub, actions) {
    var h = el('div', 'u-ph');
    if (icon) { var ib = el('span', 'u-ph-ic'); ib.appendChild(L.icon(icon, 17)); h.appendChild(ib); }
    var t = el('div', ''); t.appendChild(el('h3', '', title)); if (sub) t.appendChild(el('small', '', sub)); h.appendChild(t);
    if (actions && actions.length) { var a = el('div', 'u-acts'); actions.forEach(function (x) { if (x) a.appendChild(x); }); h.appendChild(a); }
    return h;
  }
  function section(o) {
    o = o || {};
    var s = el('section', 'u-sec');
    if (o.id) s.setAttribute('data-sec', o.id);
    if (o.title) {
      var h = el('div', 'u-sech');
      if (o.mark) h.appendChild(mark(o.mark, 20));
      var t = el('div', 'u-sech-t');
      t.appendChild(el('h3', '', o.title));
      if (o.meta) { var m = el('span', 'u-meta'); if (typeof o.meta === 'string') m.textContent = o.meta; else m.appendChild(o.meta); t.appendChild(m); }
      h.appendChild(t);
      if (o.actions && o.actions.length) { var a = el('div', 'u-sech-a'); o.actions.forEach(function (x) { if (x) a.appendChild(x); }); h.appendChild(a); }
      s.appendChild(h);
    }
    return s;
  }
  /** A notice line — "3 accounts need setup →" — that opens what it names. */
  function notice(text, fn, go) {
    var b = el('button', 'u-notice');
    b.appendChild(el('span', 'u-dot'));
    b.appendChild(el('span', '', text));
    b.appendChild(el('span', 'go', go || 'Open →'));
    if (fn) b.onclick = fn;
    return b;
  }

  // ---- MENUS: the inline select and the overflow menu -----------------------------------------------------
  /** items: [{ id, label, note, checked, danger, sep, header, run, disabled, icon }] */
  function openMenu(anchor, items, opts) {
    L.popover(anchor, function (p) {
      p.classList.add('u-menu');
      if (opts && opts.title) p.appendChild(el('div', 'u-mh', opts.title));
      items.forEach(function (it) {
        if (!it) return;
        if (it.sep) { p.appendChild(document.createElement('hr')); return; }
        if (it.header) { p.appendChild(el('div', 'u-mh', it.header)); return; }
        var b = el('button', 'opt' + (it.danger ? ' danger' : ''));
        var ck = el('span', 'ck'); if (it.checked) ck.appendChild(L.icon('check', 14)); else if (it.icon) ck.appendChild(L.icon(it.icon, 14)); b.appendChild(ck);
        var t = el('span', ''); t.appendChild(el('span', '', it.label)); if (it.note) t.appendChild(el('small', '', it.note)); b.appendChild(t);
        if (it.checked) b.setAttribute('aria-selected', 'true');
        if (it.disabled) b.disabled = true;
        b.onclick = function () { L.closePop(); if (it.run) it.run(); };
        p.appendChild(b);
      });
    }, { toggle: true, cls: 'u-menu-pop' + (opts && opts.cls ? ' ' + opts.cls : ''), prefer: opts && opts.prefer, alignRight: opts && opts.alignRight });
  }
  function select(label, items, opts) {
    var b = el('button', 'u-in');
    if (opts && opts.id) b.setAttribute('data-select', opts.id);
    b.setAttribute('aria-haspopup', 'menu');
    b.appendChild(el('span', '', label));
    b.appendChild(L.icon('down', 13));
    b.onclick = function (e) { e.stopPropagation(); openMenu(b, items, opts); };
    return b;
  }
  function overflow(items, title) { return iconButton('dots', title || 'More', function (b) { openMenu(b, items, { alignRight: true }); }); }

  // ---- STATES --------------------------------------------------------------------------------------------------
  function dot(kind) { return el('span', 'u-dot' + (kind ? ' ' + kind : '')); }
  function empty(title, text, actionLabel, fn) {
    var e = el('div', 'u-empty');
    e.appendChild(el('b', '', title));
    if (text) e.appendChild(document.createTextNode(text));
    if (actionLabel) { e.appendChild(document.createElement('div')); e.appendChild(button(actionLabel, 'line', fn)); }
    return e;
  }
  function setting(label, desc, control) {
    var r = el('div', 'u-set');
    var t = el('div', 'u-st2'); t.appendChild(el('b', '', label)); if (desc) t.appendChild(el('small', '', desc)); r.appendChild(t);
    if (control) { var c = el('div', 'u-ctl'); c.appendChild(control); r.appendChild(c); }
    return r;
  }
  function kv(pairs) {
    var d = el('dl', 'u-kv');
    pairs.forEach(function (p) { if (p == null || p[1] == null || p[1] === '') return; d.appendChild(el('dt', '', p[0])); var dd = el('dd'); if (typeof p[1] === 'string') dd.textContent = p[1]; else dd.appendChild(p[1]); d.appendChild(dd); });
    return d;
  }
  function group(title) { var g = el('div', 'u-group'); if (title) g.appendChild(el('h4', '', title)); return g; }

  // ---- SIDE SHEET ------------------------------------------------------------------------------------------------
  function sheet(o) {
    var back = el('div', 'u-sheet-back');
    var sh = el('div', 'u-sheet'); sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-label', o.title || '');
    if (o.id) sh.setAttribute('data-sheet', o.id);
    var h = el('div', 'u-sheet-h');
    if (o.onBack) h.appendChild(iconButton('back', 'Back', function () { close(); o.onBack(); }));
    var wrap = el('div', ''); wrap.style.flex = '1'; wrap.style.minWidth = '0';
    var t = el('h2', '', o.title || ''); wrap.appendChild(t);
    if (o.meta) wrap.appendChild(el('div', 'u-meta', o.meta));
    h.appendChild(wrap);
    if (o.mark) h.insertBefore(mark(o.mark, 20), h.firstChild);
    var x = iconButton('close', 'Close', function () { close(); }); x.setAttribute('data-close', '1'); h.appendChild(x);
    var body = el('div', 'u-sheet-b');
    sh.appendChild(h); sh.appendChild(body); back.appendChild(sh);
    function esc(e) { if (e.key === 'Escape' && !L.popDepth()) { e.stopPropagation(); close(); } }
    function close() { back.remove(); document.removeEventListener('keydown', esc, true); if (o.onClose) o.onClose(); }
    document.addEventListener('keydown', esc, true);
    back.onclick = function (e) { if (e.target === back) close(); };
    document.body.appendChild(back);
    return { body: body, close: close, root: sh };
  }

  // ---- TOOLTIPS: any element with data-tip, after a short rest ----------------------------------------------------
  var tipEl = null, tipFor = null, tipTimer = 0;
  function hideTip() { clearTimeout(tipTimer); tipFor = null; if (tipEl) { tipEl.remove(); tipEl = null; } }
  document.addEventListener('mouseover', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (t === tipFor) return;
    hideTip();
    if (!t || L.popDepth && L.popDepth() > 0) return;
    tipFor = t;
    tipTimer = setTimeout(function () {
      if (!t.isConnected || tipFor !== t) return;
      tipEl = el('div', 'tipbox', t.getAttribute('data-tip'));
      document.body.appendChild(tipEl);
      var r = t.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
      var top = r.top - h - 8; if (top < 6) top = r.bottom + 8;
      tipEl.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2)) + 'px';
      tipEl.style.top = top + 'px';
    }, 380);
  });
  document.addEventListener('mousedown', hideTip, true);
  window.addEventListener('blur', hideTip);

  L.kit = {
    mark: mark, markKey: markKey, tintOf: tintOf, hueOf: hueOf, fmtNum: fmtNum, winLabel: winLabel, resetText: resetText, qbar: qbar, quota: quota, remainingOf: remainingOf, quotaTone: quotaTone, toneColor: toneColor,
    ring: ring, donut: donut, legend: legend, bars: bars, stat: stat,
    head: head, tabs: tabs, segmented: segmented, button: button, iconButton: iconButton, plane: plane, planeHead: planeHead, section: section, notice: notice,
    menu: openMenu, select: select, overflow: overflow,
    dot: dot, empty: empty, setting: setting, kv: kv, group: group, sheet: sheet, hideTip: hideTip,
  };
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
