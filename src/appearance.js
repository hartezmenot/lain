'use strict';

/**
 * THE HARNESS'S APPEARANCE — persisted in Core (cfg.ui), applied by the window.
 * Independent axes, so any combination works (JetBrains keymap + LAIN theme):
 *
 *   mode       dark · light · system
 *   palette    lain · slate · violet · coral · mono · custom      (accent family)
 *   custom     { background, surface, accent, secondary, warning } — five flat colours
 *   zoom       80 · 90 · 100 · 110 · 125 · 150 · 175 · 200        (the whole window)
 *   type       small · medium · large                             (text size, composes with zoom)
 *   icons      small · medium · large
 *   theme      lain · vscode · cursor · jetbrains · ext:<id>      (workbench/editor theme preset)
 *   keymap     lain · vscode · cursor · jetbrains · custom
 *   density    comfortable · compact
 *   nav        compact · expanded        (the app panel beside every surface but the IDE — icons, or
 *                                        icons and names; expanded by default since 2026-09-30, and
 *                                        icons only on a narrow window whatever the choice)
 *
 * No gradient, glow or shadow tokens exist here on purpose: depth comes from
 * spacing, contrast, block proportion and hairline separators.
 */

const MODES = ['dark', 'light', 'system'];
const PALETTES = ['lain', 'slate', 'violet', 'coral', 'mono', 'custom'];
const ZOOMS = [80, 90, 100, 110, 125, 150, 175, 200];
const SIZES = ['small', 'medium', 'large'];
const THEMES = ['lain', 'vscode', 'cursor', 'jetbrains'];
const KEYMAPS = ['lain', 'vscode', 'cursor', 'jetbrains', 'custom'];
const CUSTOM_KEYS = ['background', 'surface', 'accent', 'secondary', 'warning'];
const NAVS = ['compact', 'expanded'];
/** Phase 8.1's values, read as the nearest 8.2 choice. */
const NAV_MIGRATE = Object.freeze({ contextual: 'compact', persistent: 'expanded' });
const HEX = /^#[0-9a-fA-F]{6}$/;

const DEFAULTS = Object.freeze({
  mode: 'dark', palette: 'slate', zoom: 100, type: 'medium', icons: 'medium', theme: 'lain', keymap: 'lain', density: 'comfortable', nav: 'expanded',
  custom: { background: '#0F1115', surface: '#1A1E24', accent: '#8EB1D0', secondary: '#6D8AA3', warning: '#E6B450' },
  customKeys: {},
});

function root(app) { return (app && app._sibling) || app; }

function get(app) {
  const u = ((root(app) && root(app).cfg) || {}).ui || {};
  const nav = NAV_MIGRATE[u.nav] || (NAVS.includes(u.nav) ? u.nav : DEFAULTS.nav);
  return { ...DEFAULTS, ...u, nav, custom: { ...DEFAULTS.custom, ...(u.custom || {}) }, customKeys: { ...(u.customKeys || {}) } };
}

/** Validate and merge a change. Returns { ok, ui } or { ok:false, why }. */
function set(app, patch = {}) {
  const cur = get(app);
  const next = { ...cur };
  const bad = (why) => ({ ok: false, why });
  if ('mode' in patch) { if (!MODES.includes(patch.mode)) return bad(`mode is ${MODES.join(', ')}`); next.mode = patch.mode; }
  if ('palette' in patch) { if (!PALETTES.includes(patch.palette)) return bad(`palette is ${PALETTES.join(', ')}`); next.palette = patch.palette; }
  if ('zoom' in patch) { const z = Number(patch.zoom); if (!ZOOMS.includes(z)) return bad(`zoom is ${ZOOMS.join(', ')}`); next.zoom = z; }
  if ('type' in patch) { if (!SIZES.includes(patch.type)) return bad('type is small, medium or large'); next.type = patch.type; }
  if ('icons' in patch) { if (!SIZES.includes(patch.icons)) return bad('icons is small, medium or large'); next.icons = patch.icons; }
  if ('density' in patch) { if (!['comfortable', 'compact'].includes(patch.density)) return bad('density is comfortable or compact'); next.density = patch.density; }
  if ('theme' in patch) { const t = String(patch.theme || ''); if (!THEMES.includes(t) && !/^ext:[\w.-]+(\/[\w .-]+)?$/.test(t)) return bad(`theme is ${THEMES.join(', ')} or an installed extension theme`); next.theme = t; }
  if ('nav' in patch) { const n = NAV_MIGRATE[patch.nav] || patch.nav; if (!NAVS.includes(n)) return bad('navigation is compact or expanded'); next.nav = n; }
  if ('keymap' in patch) { if (!KEYMAPS.includes(patch.keymap)) return bad(`keymap is ${KEYMAPS.join(', ')}`); next.keymap = patch.keymap; }
  if (patch.custom) {
    const c = { ...cur.custom };
    for (const [k, v] of Object.entries(patch.custom)) {
      if (!CUSTOM_KEYS.includes(k)) return bad(`custom colours are ${CUSTOM_KEYS.join(', ')}`);
      if (!HEX.test(String(v))) return bad(`${k} must be a colour like #1A2B3C`);
      c[k] = String(v).toUpperCase();
    }
    next.custom = c;
  }
  if (patch.customKeys && typeof patch.customKeys === 'object') {
    const ks = {};
    for (const [cmd, key] of Object.entries(patch.customKeys)) {
      if (!/^[a-z][\w.-]{1,60}$/i.test(cmd)) return bad(`"${cmd}" is not a command id`);
      if (key !== null && !/^((Ctrl|Alt|Shift|Meta)\+)*([A-Z0-9]|F\d{1,2}|Enter|Escape|Tab|Space|Backspace|Delete|Arrow(Up|Down|Left|Right)|[=\-`[\]\\;',./])$/i.test(String(key))) return bad(`"${key}" is not a key combination`);
      ks[cmd] = key;
    }
    next.customKeys = { ...cur.customKeys, ...ks };
  }
  if (patch.reset === 'palette') { next.palette = DEFAULTS.palette; next.custom = { ...DEFAULTS.custom }; }
  if (patch.reset === 'all') Object.assign(next, JSON.parse(JSON.stringify(DEFAULTS)));
  const cfg = root(app).cfg;
  cfg.ui = next;
  try { require('./config').save(cfg); } catch { /* applies in memory */ }
  return { ok: true, ui: next };
}

module.exports = { get, set, DEFAULTS, MODES, PALETTES, ZOOMS, SIZES, THEMES, KEYMAPS, CUSTOM_KEYS, NAVS };
