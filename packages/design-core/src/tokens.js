'use strict';

/**
 * THE PROJECT'S DESIGN LANGUAGE (D9) — scanned once from its own files: CSS custom properties, SCSS variables, the
 * Tailwind theme (read statically from tailwind.config.*, never executed), and the scales its stylesheets actually use
 * (spacing grid, type scale, radii, shadows, palette, breakpoints). Then:
 *
 *   snap(prop, value)          the nearest value on the project's scale (sliders snap to it)
 *   token(prop, value, file)   the token form to write instead of a raw value, for that file's dialect
 *                              (`var(--brand)` in CSS, `$brand` in SCSS, `bg-brand` in a Tailwind class list)
 *   offScale(prop, value)      a value outside the scale (allowed, flagged)
 */

const fs = require('fs');
const path = require('path');
const { walk } = require('./routes');

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i;
const SPACING = new Set(['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap', 'row-gap', 'column-gap', 'top', 'left', 'right', 'bottom']);
const COLOR_PROPS = new Set(['color', 'background-color', 'background', 'border-color', 'fill', 'stroke', 'outline-color']);

function normColor(v) {
  const s = String(v || '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s); if (m) return `#${m[1].split('').map((c) => c + c).join('')}`;
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s); if (m) return m[2] && m[2] !== 'ff' ? s : `#${m[1]}`;
  m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(s);
  if (m && (m[4] == null || Number(m[4]) === 1)) return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  return s;
}
const px = (v) => { const m = /^(-?\d*\.?\d+)px$/.exec(String(v).trim()); return m ? Number(m[1]) : null; };

/** Static read of `theme` / `theme.extend` in a Tailwind config: { colors: {brand: '#…'}, spacing, borderRadius, fontSize }. */
function tailwindTheme(root) {
  const f = ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts'].find((n) => fs.existsSync(path.join(root, n)));
  if (!f) return null;
  let ast;
  try { ast = require('@babel/parser').parse(fs.readFileSync(path.join(root, f), 'utf8'), { sourceType: 'unambiguous', plugins: ['typescript'] }); } catch { return null; }
  const lit = (n) => {
    if (!n) return undefined;
    if (n.type === 'StringLiteral' || n.type === 'NumericLiteral') return n.value;
    if (n.type === 'ObjectExpression') { const o = {}; for (const p of n.properties) if (p.type === 'ObjectProperty') { const k = p.key.name || p.key.value; const v = lit(p.value); if (v !== undefined) o[k] = v; } return o; }
    return undefined;
  };
  let theme = null;
  (function find(n) {
    if (!n || typeof n !== 'object' || theme) return;
    if (n.type === 'ObjectProperty' && (n.key.name === 'theme' || n.key.value === 'theme') && n.value.type === 'ObjectExpression') { theme = lit(n.value); return; }
    for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(find); else if (v && typeof v.type === 'string') find(v); }
  }(ast.program));
  if (!theme) return { file: f };
  const ext = theme.extend || {};
  const merge = (k) => ({ ...(theme[k] && typeof theme[k] === 'object' ? theme[k] : {}), ...(ext[k] || {}) });
  const flat = (o, pre = '') => Object.entries(o || {}).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${pre}${k === 'DEFAULT' ? '' : `${k}-`}`) : [[`${pre}${k === 'DEFAULT' ? '' : k}`.replace(/-$/, ''), v]]));
  return { file: f, colors: Object.fromEntries(flat(merge('colors'))), spacing: merge('spacing'), borderRadius: merge('borderRadius'), fontSize: merge('fontSize') };
}

function scan(root) {
  const abs = path.resolve(root);
  const t = { vars: [], scss: [], tailwind: tailwindTheme(abs), spacing: [], fontSizes: [], radii: [], shadows: [], colors: [], media: [], grid: null };
  const files = walk(abs, '', 7).filter((f) => /\.(css|scss|sass|vue|svelte)$/.test(f));
  const counts = { spacing: new Map(), font: new Map(), radius: new Map(), color: new Map() };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const rel of files.slice(0, 400)) {
    let src = ''; try { src = fs.readFileSync(path.join(abs, rel), 'utf8'); } catch { continue; }
    if (/\.(vue|svelte)$/.test(rel)) src = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
    for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;}\n]+)/g)) t.vars.push({ name: m[1], value: m[2].trim(), file: rel });
    if (/\.s[ac]ss$/.test(rel)) for (const m of src.matchAll(/^\s*\$([\w-]+)\s*:\s*([^;\n]+?)\s*(?:!default)?\s*;/gm)) t.scss.push({ name: `$${m[1]}`, value: m[2].trim(), file: rel });
    for (const m of src.matchAll(/@media\s*([^{]+)\{/g)) t.media.push(m[1].trim());
    for (const m of src.matchAll(/([\w-]+)\s*:\s*([^;}\n]+)/g)) {
      const prop = m[1]; const v = m[2].trim();
      if (SPACING.has(prop)) for (const part of v.split(/\s+/)) { const n = px(part); if (n != null && n > 0) bump(counts.spacing, n); }
      if (prop === 'font-size') { const n = px(v); if (n) bump(counts.font, n); }
      if (prop === 'border-radius') { const n = px(v); if (n != null) bump(counts.radius, n); }
      if (prop === 'box-shadow' && v !== 'none') t.shadows.push(v);
      if (COLOR_PROPS.has(prop) && COLOR.test(v)) bump(counts.color, normColor(v));
    }
  }
  const sorted = (m) => [...m.keys()].sort((a, b) => a - b);
  t.spacing = sorted(counts.spacing); t.fontSizes = sorted(counts.font); t.radii = sorted(counts.radius);
  t.media = [...new Set(t.media)];
  // THE GRID: 8 when nearly every spacing value is a multiple of 8, 4 when of 4.
  const vals = [...counts.spacing.entries()];
  const share = (g) => { const tot = vals.reduce((a, [, c]) => a + c, 0); return tot ? vals.filter(([v]) => v % g === 0).reduce((a, [, c]) => a + c, 0) / tot : 0; };
  t.grid = share(8) >= 0.8 ? 8 : share(4) >= 0.8 ? 4 : null;
  // THE PALETTE: token colours first (they have names), then colours the sheets use.
  const named = [...t.vars.filter((v) => COLOR.test(v.value)).map((v) => ({ name: v.name, value: normColor(v.value), kind: 'var' })), ...t.scss.filter((v) => COLOR.test(v.value)).map((v) => ({ name: v.name, value: normColor(v.value), kind: 'scss' })), ...Object.entries((t.tailwind && t.tailwind.colors) || {}).filter(([, v]) => COLOR.test(String(v))).map(([k, v]) => ({ name: k, value: normColor(v), kind: 'tailwind' }))];
  t.colors = [...named, ...[...counts.color.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => ({ name: null, value: v, kind: 'used' })).filter((c) => !named.some((n) => n.value === c.value))];
  return t;
}

class Tokens {
  constructor(root) { this.root = root; this.t = scan(root); }

  scaleFor(prop) {
    if (SPACING.has(prop) || prop === 'width' || prop === 'height') {
      const g = this.t.grid;
      return g ? { step: g, values: this.t.spacing } : { step: null, values: this.t.spacing };
    }
    if (prop === 'font-size') return { step: null, values: this.t.fontSizes };
    if (prop === 'border-radius') return { step: null, values: this.t.radii };
    return null;
  }

  /** The nearest on-scale value (px props only). */
  snap(prop, value) {
    const n = px(value); const sc = this.scaleFor(prop);
    if (n == null || !sc) return value;
    if (sc.step) return `${Math.round(n / sc.step) * sc.step}px`;
    if (!sc.values.length) return value;
    const best = sc.values.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
    return Math.abs(best - n) <= 3 ? `${best}px` : value;
  }

  offScale(prop, value) {
    const n = px(value); const sc = this.scaleFor(prop);
    if (n == null || !sc || !(sc.step || sc.values.length)) return false;
    if (sc.step) return n % sc.step !== 0;
    return !sc.values.includes(n);
  }

  /** The token form of `value` for a declaration in `file` (or null when no token has that value). */
  token(prop, value, file) {
    const v = COLOR_PROPS.has(prop) || COLOR.test(String(value)) ? normColor(value) : String(value).trim();
    const same = (x) => (COLOR.test(String(x)) ? normColor(x) === v : String(x).trim() === v);
    if (/\.s[ac]ss$/.test(file || '')) { const s = this.t.scss.find((x) => same(x.value)); if (s) return s.name; }
    const css = this.t.vars.find((x) => same(x.value));
    if (css) return `var(${css.name})`;
    return null;
  }

  /** A Tailwind utility for prop/value from the project's theme (`bg-brand`, `rounded-card`), or null. */
  utility(prop, value) {
    const th = this.t.tailwind; if (!th) return null;
    const v = normColor(value);
    const color = Object.entries(th.colors || {}).find(([, c]) => normColor(c) === v);
    if (color && (prop === 'background-color' || prop === 'background')) return `bg-${color[0]}`;
    if (color && prop === 'color') return `text-${color[0]}`;
    if (color && prop === 'border-color') return `border-${color[0]}`;
    const r = Object.entries(th.borderRadius || {}).find(([, x]) => String(x) === String(value));
    if (r && prop === 'border-radius') return r[0] === 'DEFAULT' ? 'rounded' : `rounded-${r[0]}`;
    return null;
  }

  summary() { return { grid: this.t.grid, spacing: this.t.spacing, fontSizes: this.t.fontSizes, radii: this.t.radii, colors: this.t.colors.slice(0, 24), media: this.t.media, tailwind: Boolean(this.t.tailwind) }; }
}

module.exports = { Tokens, scan, tailwindTheme, normColor, COLOR_PROPS, SPACING };
