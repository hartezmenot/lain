'use strict';

/**
 * EXTENSION COLOUR THEMES — the "imported" theme preset (Phase 8).
 *
 * An installed extension's `contributes.themes` is DATA: a JSON file of editor
 * colours and TextMate token colours. LAIN reads that file — it never runs the
 * extension to get it — and hands the editor a Monaco theme:
 *
 *   list(app)       every contributed theme: { id: 'ext:<extId>/<label>', label, extension, base }
 *   read(app, id)   { label, base: 'vs' | 'vs-dark', colors, rules } — colours
 *                   limited to the editor's own keys, token rules mapped from
 *                   TextMate scopes to the editor's token names
 *
 * A theme file may `include` another (VS Code's own convention); includes are
 * followed inside the extension's folder only, at most four deep.
 */

const fs = require('fs');
const path = require('path');

const ID_RE = /^ext:([\w.-]+)\/([\w .()+-]{1,80})$/;
const MAX_FILE = 2 * 1024 * 1024;

/** JSON with comments and trailing commas, as theme files are written. */
function parseLoose(text) {
  let out = ''; let i = 0; let inStr = false;
  const s = String(text || '').replace(/^﻿/, '');
  while (i < s.length) {
    const c = s[i];
    if (inStr) { out += c; if (c === '\\') { out += s[i + 1] || ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function project(app) {
  try { const p = require('./sessionviews').project(app.session); return p.attached && !p.missing ? p.root : null; } catch { return null; }
}

function installed(app) {
  const ext = require('./extensions');
  const out = [];
  for (const e of ext.list({ project: project(app) })) {
    if (e.enabled === false) continue;
    const root = ext.rootFor(e.scope, { project: project(app) });
    const dir = root && e.dir ? path.join(root, e.dir) : null;
    if (!dir) continue;
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')); } catch { continue; }
    const themes = (pkg.contributes && Array.isArray(pkg.contributes.themes)) ? pkg.contributes.themes : [];
    for (const t of themes) {
      if (!t || typeof t.path !== 'string') continue;
      const label = String(t.label || t.id || path.basename(t.path, '.json')).replace(/[^\w .()+-]/g, '').slice(0, 80).trim();
      if (!label) continue;
      out.push({ id: `ext:${e.id}/${label}`, label, extension: e.id, extensionName: pkg.displayName || pkg.name || e.id,
        base: t.uiTheme === 'vs' || t.uiTheme === 'hc-light' ? 'vs' : 'vs-dark', dir, file: t.path });
    }
  }
  return out;
}

function list(app) {
  return installed(app).map(({ id, label, extension, extensionName, base }) => ({ id, label, extension, extensionName, base }));
}

/** A file inside the extension folder, never outside it. */
function inside(dir, rel) {
  const f = path.resolve(dir, rel);
  const r = path.relative(dir, f);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? f : null;
}

function load(dir, rel, depth = 0) {
  const f = inside(dir, rel);
  if (!f) throw new Error('the theme file is outside its extension');
  const st = fs.statSync(f);
  if (st.size > MAX_FILE) throw new Error('the theme file is too large');
  const j = parseLoose(fs.readFileSync(f, 'utf8'));
  if (j.include && depth < 4) {
    const base = load(path.dirname(f), path.basename(String(j.include)) === String(j.include) ? String(j.include) : path.relative(path.dirname(f), path.resolve(path.dirname(f), String(j.include))), depth + 1);
    return { colors: { ...base.colors, ...(j.colors || {}) }, tokenColors: [...(base.tokenColors || []), ...(Array.isArray(j.tokenColors) ? j.tokenColors : [])], type: j.type || base.type };
  }
  return { colors: j.colors || {}, tokenColors: Array.isArray(j.tokenColors) ? j.tokenColors : [], type: j.type };
}

// TextMate scope (prefix) → the editor's token name. Longest prefix wins.
const SCOPES = [
  ['comment', 'comment'], ['string.regexp', 'regexp'], ['string', 'string'], ['constant.numeric', 'number'], ['constant.language', 'keyword'],
  ['keyword.operator', 'delimiter'], ['keyword', 'keyword'], ['storage.type', 'keyword'], ['storage.modifier', 'keyword'], ['storage', 'keyword'],
  ['entity.name.type', 'type.identifier'], ['entity.name.class', 'type.identifier'], ['support.type', 'type'], ['support.class', 'type.identifier'],
  ['entity.name.tag', 'tag'], ['entity.other.attribute-name', 'attribute.name'], ['entity.name.function', 'identifier'],
  ['variable', 'variable'], ['punctuation', 'delimiter'], ['meta.embedded', 'variable'],
];
const HEX = /^#?([0-9a-f]{3,8})$/i;
function hex(c) { const m = HEX.exec(String(c || '')); return m ? m[1] : null; }

function rules(tokenColors) {
  const best = new Map();
  for (const t of tokenColors) {
    const st = (t && t.settings) || {};
    const scopes = Array.isArray(t.scope) ? t.scope : String(t.scope || '').split(',');
    for (const raw of scopes) {
      const sc = String(raw).trim();
      if (!sc || /\s/.test(sc)) continue;   // descendant selectors are too specific for the editor's tokens
      for (const [prefix, token] of SCOPES) {
        if (sc !== prefix && !sc.startsWith(`${prefix}.`)) continue;
        const prev = best.get(token);
        if (!prev || prefix.length >= prev.len) best.set(token, { len: prefix.length, fg: hex(st.foreground), style: st.fontStyle });
        break;
      }
    }
  }
  const out = [];
  for (const [token, v] of best) if (v.fg || v.style) out.push({ token, ...(v.fg ? { foreground: v.fg } : {}), ...(v.style ? { fontStyle: String(v.style) } : {}) });
  return out;
}

const COLOR_KEYS = /^(editor|editorLineNumber|editorCursor|editorIndentGuide|editorWhitespace|editorWidget|editorSuggestWidget|editorGutter|editorBracketMatch|editorError|editorWarning|editorInfo|scrollbarSlider|minimap|input|focusBorder|list|peekView)\b/;

function read(app, id) {
  if (!ID_RE.test(String(id || ''))) return { ok: false, why: 'not an extension theme id' };
  const t = installed(app).find((x) => x.id === id);
  if (!t) return { ok: false, why: 'that theme is not installed (or its extension is disabled)' };
  let data;
  try { data = load(t.dir, t.file); } catch (e) { return { ok: false, why: `could not read the theme: ${e.message}` }; }
  const colors = {};
  for (const [k, v] of Object.entries(data.colors || {})) if (COLOR_KEYS.test(k) && HEX.test(String(v))) colors[k] = String(v).startsWith('#') ? String(v) : `#${v}`;
  const base = data.type === 'light' ? 'vs' : data.type === 'dark' ? 'vs-dark' : t.base;
  return { ok: true, id, label: t.label, extension: t.extensionName, base, colors, rules: rules(data.tokenColors || []) };
}

module.exports = { list, read, rules, parseLoose, ID_RE };
