'use strict';

/**
 * THE PALETTE WORKBENCH — LAIN's design tokens (v2, 2026-09-30: the four-gate rebuild).
 *
 * ------------------------------------------------------------------------
 * SPACE IS MADE OF FLAT COLOUR PLANES laid on a darker canvas, like cards of
 * paper — curved, never glassy, never glowing:
 *
 *     canvas          the window                               deep navy slate
 *     nav             the navigation plane                     a shade under it
 *     surface-base    the primary plane (a card, a panel)      visibly lighter
 *     surface-raised  a plane on a plane (an input, a row)     one step up
 *     surface-panel   what floats (a menu, a dropdown, a sheet)
 *     surface-active  selected / pressed
 *     plane-*         a plane pulled a few degrees toward a hue (a provider)
 *
 * A plane separates from what is under it by COLOUR, not by a border. Only
 * what floats casts a (soft) shadow. The accents are flat: violet acts, teal
 * reports, pink/amber/blue are for charts — no gradient, no glow.
 *
 * ------------------------------------------------------------------------
 * SEMANTIC TOKENS — every surface uses these names and nothing else; a palette
 * (Settings › Appearance) only remaps them:
 *
 *   canvas · nav · surface-base/raised/panel/active · text-primary/secondary/
 *   muted/disabled · separator · border-subtle · accent-primary/secondary/
 *   tertiary · on-accent · positive · warning · danger · info · selection ·
 *   hover · focus · chart-1…6 · plane-blue/violet/teal/amber/rose/accent
 *
 * GEOMETRY   radius-xs 5 · sm 8 · md 12 · lg 16 · xl 20 · float 24
 * SPACE      space-1 4 · 2 8 · 3 12 · 4 16 · 5 20 · 6 24 · 8 32 · 12 48
 * MOTION     hover 90ms · popover 130 · dropdown 150 · tab 150 · panel 190 ·
 *            sidebar 200 · page 220 — one easing, cubic-bezier(.2,.8,.2,1);
 *            opacity and transform only; nothing moves under reduced motion
 * TYPE       per context, one scale (--ts); written at their final size:
 *            Harness body 13.5 · secondary 12.5 · meta 11.5 · section 15.5 ·
 *            page 24 · display 34 · Chat 14.5 · IDE 12.5 · Agent sidecar 13
 */

const CSS = `
:root{
  --ts:1; --ic:1; --pad:1;
  --mono:"Cascadia Code","Cascadia Mono",Consolas,ui-monospace,monospace;
  --sans:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;
  --display:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;
  --radius-xs:5px; --radius-sm:8px; --radius-md:12px; --radius-lg:16px; --radius-xl:20px; --radius-float:24px;
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:20px; --space-6:24px; --space-8:32px; --space-12:48px;
  --ease:cubic-bezier(.2,.8,.2,1);
  --t-hover:90ms; --t-pop:130ms; --t-drop:150ms; --t-tab:150ms; --t-panel:190ms; --t-side:200ms; --t-page:220ms;
  --fs-caption:calc(11.5px * var(--ts)); --fs-small:calc(12.5px * var(--ts)); --fs-body:calc(13.5px * var(--ts));
  --fs-lead:calc(14.5px * var(--ts)); --fs-h3:calc(15.5px * var(--ts)); --fs-h2:calc(18px * var(--ts)); --fs-h1:calc(24px * var(--ts));
  --fs-display:calc(34px * var(--ts));
  --fs-chat:calc(14.5px * var(--ts)); --fs-composer:calc(14.5px * var(--ts));
  --fs-ide:calc(12.5px * var(--ts)); --fs-ide-small:calc(11.5px * var(--ts)); --fs-sidecar:calc(13px * var(--ts));
  --rail-w:236px; --rail-compact:64px; --topbar-h:52px; --chat-col:800px; --composer-w:840px;
}
:root[data-type=small]{--ts:.92} :root[data-type=large]{--ts:1.1}
:root[data-icons=small]{--ic:.88} :root[data-icons=large]{--ic:1.18}
:root[data-density=compact]{--pad:.8}

/* ---- SLATE (the default): navy-slate planes, a violet action, teal beside it ------------------------------- */
:root,:root[data-mode=dark]{
  --canvas:#0E131A; --nav:#0B1015; --nav-text:#E7ECF3; --nav-muted:#8B96A8;
  --surface-base:#141B24; --surface-raised:#1A2230; --surface-panel:#19212D; --surface-active:#232D3D;
  --plane-blue:#131D2B; --plane-violet:#18172A; --plane-teal:#112226; --plane-amber:#1E1B16; --plane-rose:#1F1720;
  --text-primary:#E7ECF3; --text-secondary:#A3ADBD; --text-muted:#6E7888; --text-disabled:#4C5563;
  --separator:#1C2430; --border-subtle:#283243;
  --positive:#34D399; --warning:#F2B84B; --danger:#F16D7A; --info:#60A5FA;
  --shadow-float:0 16px 40px rgba(0,0,0,.42),0 2px 6px rgba(0,0,0,.25);
  color-scheme:dark;
}
:root,:root[data-palette=slate]{
  --accent-primary:#9B8AFB; --on-accent:#140F2B; --accent-secondary:#2DD4BF; --on-secondary:#04211D; --accent-tertiary:#F472B6; --on-tertiary:#2A0A1C;
}
:root[data-mode=light]{
  --canvas:#EEF1F6; --nav:#E6EAF1; --nav-text:#141A23; --nav-muted:#5E6878;
  --surface-base:#FFFFFF; --surface-raised:#F4F6FA; --surface-panel:#FFFFFF; --surface-active:#E7EBF3;
  --plane-blue:#EEF3FB; --plane-violet:#F2F0FD; --plane-teal:#EAF6F5; --plane-amber:#FBF5E9; --plane-rose:#FBEFF4;
  --text-primary:#141A23; --text-secondary:#4A5566; --text-muted:#778294; --text-disabled:#A3ACB9;
  --separator:#E1E6EE; --border-subtle:#CFD6E0;
  --positive:#15935C; --warning:#B07A12; --danger:#D23F4E; --info:#2F6FD8;
  --shadow-float:0 16px 40px rgba(20,30,45,.14),0 2px 6px rgba(20,30,45,.08);
  color-scheme:light;
}
:root[data-mode=light][data-palette=slate]{
  --accent-primary:#6D5AE6; --on-accent:#FFFFFF; --accent-secondary:#0F9E8D; --on-secondary:#FFFFFF; --accent-tertiary:#D6428F; --on-tertiary:#FFFFFF;
}
/* ---- LAIN CYAN (optional) --------------------------------------------------------------------------------- */
:root[data-mode=dark][data-palette=lain]{
  --canvas:#0A1A1E; --nav:#071418; --nav-text:#E2F1F1; --nav-muted:#7C9FA3;
  --surface-base:#0F252A; --surface-raised:#153036; --surface-panel:#12292F; --surface-active:#1C3B42;
  --plane-blue:#0F2330; --plane-violet:#17213A; --plane-teal:#0E2A2C; --plane-amber:#22251A; --plane-rose:#24202A;
  --text-primary:#E2F1F1; --text-secondary:#9DBDC0; --text-muted:#6C8E92;
  --separator:#18353C; --border-subtle:#22464E;
}
:root[data-palette=lain]{ --accent-primary:#27D9D2; --on-accent:#032322; --accent-secondary:#0FA3A8; --on-secondary:#FFFFFF; --accent-tertiary:#FF5C83; --on-tertiary:#2A0510; }
:root[data-mode=light][data-palette=lain]{
  --canvas:#E8F2F2; --nav:#DDEBEB; --surface-base:#FFFFFF; --surface-raised:#F2F9F9; --surface-panel:#FFFFFF; --surface-active:#E0EDED;
  --plane-teal:#E6F4F3; --separator:#D3E4E4; --border-subtle:#BCD4D4; --text-primary:#0B2328; --text-secondary:#3F5E62; --text-muted:#6E8A8D;
  --accent-primary:#0FA7A2; --on-accent:#FFFFFF; --accent-secondary:#0B7F84;
}
/* ---- VIOLET · CORAL · MONOCHROME ---------------------------------------------------------------------------- */
:root[data-palette=violet]{ --accent-primary:#B49CFF; --on-accent:#180E33; --accent-secondary:#6F8EF2; --on-secondary:#0A1330; --accent-tertiary:#E08AF7; --on-tertiary:#23092E; }
:root[data-mode=dark][data-palette=violet]{ --canvas:#11101A; --nav:#0D0C14; --surface-base:#191724; --surface-raised:#211E30; --surface-panel:#1E1B2C; --surface-active:#2A273C; --separator:#24213A; --border-subtle:#322E4A; }
:root[data-mode=light][data-palette=violet]{ --accent-primary:#6A4ADF; --on-accent:#FFFFFF; --accent-secondary:#4A6CD6; --on-secondary:#FFFFFF; --accent-tertiary:#9F3FCB; --on-tertiary:#FFFFFF; }
:root[data-palette=coral]{ --accent-primary:#FF7A92; --on-accent:#2B0510; --accent-secondary:#FFA07F; --on-secondary:#2B1206; --accent-tertiary:#FFC56B; --on-tertiary:#2B1A05; }
:root[data-mode=dark][data-palette=coral]{ --canvas:#16111A; --nav:#110D14; --surface-base:#1F1822; --surface-raised:#28202B; --surface-panel:#241C27; --surface-active:#322834; --separator:#2C2330; --border-subtle:#3A2F3E; }
:root[data-mode=light][data-palette=coral]{ --accent-primary:#D8405F; --on-accent:#FFFFFF; --accent-secondary:#D86A48; --on-secondary:#FFFFFF; --accent-tertiary:#B47A12; --on-tertiary:#FFFFFF; }
:root[data-palette=mono]{ --accent-primary:#E8E8E8; --on-accent:#111111; --accent-secondary:#A8A8A8; --on-secondary:#111111; --accent-tertiary:#C9C9C9; --on-tertiary:#111111; }
:root[data-mode=dark][data-palette=mono]{ --canvas:#111111; --nav:#0B0B0B; --surface-base:#1A1A1A; --surface-raised:#222222; --surface-panel:#1F1F1F; --surface-active:#2C2C2C; --plane-blue:#1A1B1D; --plane-violet:#1B1A1D; --plane-teal:#191C1B; --plane-amber:#1D1C19; --plane-rose:#1D1A1B; --separator:#262626; --border-subtle:#333333; }
:root[data-mode=light][data-palette=mono]{ --accent-primary:#1A1A1A; --on-accent:#FFFFFF; --accent-secondary:#555555; --on-secondary:#FFFFFF; --accent-tertiary:#3A3A3A; --on-tertiary:#FFFFFF; }

/* ---- derived: never a new hue, only the palette's own at lower weight ------------------------------------------ */
:root{
  --selection:color-mix(in srgb,var(--accent-primary) 16%,transparent);
  --hover:color-mix(in srgb,var(--text-primary) 5.5%,transparent);
  --focus:color-mix(in srgb,var(--accent-primary) 60%,transparent);
  --accent-border:color-mix(in srgb,var(--accent-primary) 45%,transparent);
  --accent-weak:color-mix(in srgb,var(--accent-primary) 14%,transparent);
  --secondary-weak:color-mix(in srgb,var(--accent-secondary) 14%,transparent);
  --tertiary-weak:color-mix(in srgb,var(--accent-tertiary) 14%,transparent);
  --positive-weak:color-mix(in srgb,var(--positive) 13%,transparent);
  --warning-weak:color-mix(in srgb,var(--warning) 13%,transparent);
  --danger-weak:color-mix(in srgb,var(--danger) 13%,transparent);
  --info-weak:color-mix(in srgb,var(--info) 13%,transparent);
  --plane-accent:color-mix(in srgb,var(--accent-primary) 10%,var(--surface-base));
  --plane-secondary:color-mix(in srgb,var(--accent-secondary) 9%,var(--surface-base));
  --chart-1:var(--accent-primary); --chart-2:var(--accent-secondary); --chart-3:var(--info); --chart-4:var(--accent-tertiary); --chart-5:var(--warning); --chart-6:var(--text-muted);
}

/* ---- motion: quick, and absent under reduced motion ------------------------------------------------------------- */
@keyframes lain-pop{from{opacity:0;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}
@keyframes lain-drop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
@keyframes lain-fade{from{opacity:0}to{opacity:1}}
@keyframes lain-page{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes lain-side{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:none}}
@keyframes lain-spin{to{transform:rotate(360deg)}}
@keyframes lain-pulse{0%,100%{opacity:.45}50%{opacity:1}}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var root = document.documentElement;
  var ui = null;
  var subs = [];
  var ZOOMS = [80, 90, 100, 110, 125, 150, 175, 200];

  function hexToRgb(h) { var m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; var n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function lum(h) { var c = hexToRgb(h); if (!c) return 0; var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
  function mix(a, b, t) { var x = hexToRgb(a), y = hexToRgb(b); if (!x || !y) return a; var c = x.map(function (v, i) { return Math.round(v + (y[i] - v) * t); }); return '#' + c.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join(''); }
  function ink(on) { return lum(on) > 0.45 ? '#101418' : '#FFFFFF'; }

  /**
   * A CUSTOM PALETTE: five colours in (background, surface, accent, secondary, warning), the whole semantic set out —
   * derived as flat steps of the same colours, never a gradient, never a new hue.
   */
  var CUSTOM_VARS = ['--canvas', '--nav', '--nav-text', '--nav-muted', '--surface-base', '--surface-raised', '--surface-panel', '--surface-active', '--plane-blue', '--plane-violet', '--plane-teal', '--plane-amber', '--plane-rose',
    '--separator', '--border-subtle', '--text-primary', '--text-secondary', '--text-muted', '--text-disabled', '--accent-primary', '--on-accent', '--accent-secondary', '--on-secondary', '--accent-tertiary', '--on-tertiary'];
  function applyCustom(c) {
    CUSTOM_VARS.forEach(function (v) { root.style.removeProperty(v); });
    if (!c || !ui || ui.palette !== 'custom') return;
    var dark = lum(c.background) < 0.35;
    var text = dark ? '#EEF2F3' : '#101418';
    var s1 = c.surface;
    var set = {
      '--canvas': c.background, '--nav': mix(c.background, dark ? '#000000' : '#FFFFFF', dark ? 0.22 : 0.3), '--nav-text': text, '--nav-muted': mix(text, c.background, 0.42),
      '--surface-base': s1, '--surface-raised': mix(s1, text, 0.05), '--surface-panel': mix(s1, text, 0.03), '--surface-active': mix(s1, text, 0.1),
      '--plane-blue': mix(s1, '#5B8CFF', 0.06), '--plane-violet': mix(s1, '#8E7BFF', 0.06), '--plane-teal': mix(s1, '#3FBFB0', 0.06), '--plane-amber': mix(s1, '#E0A840', 0.06), '--plane-rose': mix(s1, '#E0608A', 0.06),
      '--separator': mix(s1, text, 0.07), '--border-subtle': mix(s1, text, 0.14), '--text-primary': text, '--text-secondary': mix(text, c.background, 0.32), '--text-muted': mix(text, c.background, 0.5), '--text-disabled': mix(text, c.background, 0.66),
      '--accent-primary': c.accent, '--on-accent': ink(c.accent), '--accent-secondary': c.secondary, '--on-secondary': ink(c.secondary), '--accent-tertiary': c.warning, '--on-tertiary': ink(c.warning),
    };
    Object.keys(set).forEach(function (k) { root.style.setProperty(k, set[k]); });
    root.setAttribute('data-mode', dark ? 'dark' : 'light');
  }

  function effectiveMode(m) {
    if (m === 'system') return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    return m === 'light' ? 'light' : 'dark';
  }

  /** THE WHOLE WINDOW'S SCALE — the host's own zoom when there is one. */
  async function applyZoom(z) {
    var f = (Number(z) || 100) / 100;
    var r = L.hostCall ? await L.hostCall('zoom', { factor: f }) : null;
    if (r && r.ok) { root.style.zoom = ''; return; }
    root.style.zoom = String(f);
  }

  function apply(next) {
    if (!next) return;
    var prevZoom = ui ? ui.zoom : null;
    ui = next;
    root.setAttribute('data-mode', effectiveMode(ui.mode));
    root.setAttribute('data-palette', ui.palette || 'slate');
    root.setAttribute('data-type', ui.type || 'medium');
    root.setAttribute('data-icons', ui.icons || 'medium');
    root.setAttribute('data-density', ui.density || 'comfortable');
    root.setAttribute('data-theme', ui.theme || 'lain');
    root.setAttribute('data-keymap', ui.keymap || 'lain');
    root.setAttribute('data-nav', ui.nav === 'compact' ? 'compact' : 'expanded');
    applyCustom(ui.custom);
    if (prevZoom !== ui.zoom) applyZoom(ui.zoom);
    subs.forEach(function (fn) { try { fn(ui); } catch (e) { if (window.console) console.error('appearance', e); } });
  }

  async function set(patch) {
    var before = ui;
    if (ui) apply(Object.assign({}, ui, patch, patch.custom ? { custom: Object.assign({}, ui.custom, patch.custom) } : {}));   // instant
    var r = await L.api('/api/appearance', { set: patch });
    if (r && r.ok) { apply(r.ui); return r; }
    if (before) apply(before);
    if (L.toast) L.toast((r && r.why) || 'could not save the appearance', true);
    return r;
  }

  function step(dir) {
    var z = ui ? ui.zoom : 100;
    var i = ZOOMS.indexOf(z); if (i < 0) i = ZOOMS.indexOf(100);
    var n = dir === 0 ? 100 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))];
    if (n !== z) { set({ zoom: n }); if (L.toast) L.toast('Interface scale ' + n + '%'); }
  }

  /** A token's value as it is drawn now (the editor and terminal themes read the palette from here). */
  function token(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }

  // CTRL + / CTRL - / CTRL 0 — the whole interface, everywhere (the editor included), captured before any surface.
  window.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    var k = e.key;
    var dir = (k === '=' || k === '+' || e.code === 'NumpadAdd') ? 1 : (k === '-' || k === '_' || e.code === 'NumpadSubtract') ? -1 : (k === '0' || e.code === 'Numpad0') ? 0 : null;
    if (dir === null) return;
    e.preventDefault(); e.stopPropagation();
    step(dir);
  }, true);
  window.addEventListener('wheel', function (e) { if (e.ctrlKey) { e.preventDefault(); step(e.deltaY < 0 ? 1 : -1); } }, { passive: false, capture: true });
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () { if (ui && ui.mode === 'system') apply(ui); });

  L.appearance = {
    get: function () { return ui; }, set: set, apply: apply, step: step, ZOOMS: ZOOMS, token: token,
    onChange: function (fn) { subs.push(fn); if (ui) try { fn(ui); } catch (e) { /* first paint */ } },
    mode: function () { return root.getAttribute('data-mode') || 'dark'; },
    /** Light ⇄ dark, keeping the palette (the top bar's moon). */
    toggleMode: function () { return set({ mode: (root.getAttribute('data-mode') || 'dark') === 'dark' ? 'light' : 'dark' }); },
  };
  L.onBoot(function () {
    L.api('/api/appearance', {}).then(function (r) { if (r && r.ok) apply(r.ui); }, function () { apply({ mode: 'dark', palette: 'slate', zoom: 100, type: 'medium', icons: 'medium' }); });
  });
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
