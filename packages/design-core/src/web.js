'use strict';

/**
 * THE WEB ADAPTER for a plain HTML/CSS/JS project: every `.html` file at the root (and under pages/) is a screen; its
 * elements are layers; its linked stylesheets carry the classes. Every edit is computed here as byte splices and only
 * written by `commit` — through the host's writer, behind the stale-edit guard — then snapshotted for Undo.
 */

const fs = require('fs');
const path = require('path');
const html = require('./html');
const css = require('./css');
const layout = require('./layout');
const { splice, sha1, diffSummary, mapOffset, escAttr, escText } = require('./text');
const { Snapshots } = require('./snapshots');

const IGNORE = /(^|[\\/])(node_modules|\.git|\.lain|dist|build|out)([\\/]|$)/;
const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico']);
const POSITION = new Set(['top', 'left', 'right', 'bottom']);

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'el';

/** A readable layer name: the element's id, its text, its alt, its most specific class — then its tag. */
function nameOf(el) {
  if (el.attrs.id) return el.attrs.id;
  if (el.attrs['aria-label']) return el.attrs['aria-label'];
  if (el.text && el.text.length <= 40) return el.text;
  if (el.attrs.alt) return el.attrs.alt;
  if (el.classes.length) return el.classes.slice().sort((a, b) => b.length - a.length)[0];
  return el.tag;
}

function defaultWrite(root) {
  return (rel, text, expectSha) => {
    const abs = path.join(root, rel);
    let cur = null;
    try { cur = fs.readFileSync(abs, 'utf8'); } catch { cur = null; }
    if (expectSha && cur != null && sha1(cur) !== expectSha) return { ok: false, stale: true, why: `${rel} changed on disk since Design read it — nothing was written; the canvas re-reads it` };
    if (expectSha === null && cur != null) return { ok: false, stale: true, why: `${rel} appeared on disk since Design planned to create it — nothing was written` };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return { ok: true };
  };
}

class WebProject {
  constructor(root, { snapshotsDir = null, write = null, readBinary = null, webRoot = '' } = {}) {
    this.root = path.resolve(root);
    this.kind = 'web-html';
    this.write = write || defaultWrite(this.root);
    this.snapshots = new Snapshots(snapshotsDir);
    this._cache = new Map();   // rel -> { sha, src, tree|sheet }
    this.readBinary = readBinary || ((p) => fs.readFileSync(p));
    this.webRoot = webRoot || '';   // where the pages live: '' (the root) or 'public' (a legacy site served from there)
  }

  // ---- reading -------------------------------------------------------------------------------------------------

  read(rel) {
    const abs = path.join(this.root, rel);
    const src = fs.readFileSync(abs, 'utf8');
    const sha = sha1(src);
    const hit = this._cache.get(rel);
    if (hit && hit.sha === sha) return hit;
    const ext = path.extname(rel).toLowerCase();
    const entry = { rel, src, sha };
    this._parse(entry, ext);
    this._cache.set(rel, entry);
    return entry;
  }

  _parse(entry, ext) {
    if (ext === '.html' || ext === '.htm') entry.tree = html.parse(entry.src, entry.rel);
    if (ext === '.css') entry.sheet = css.parse(entry.src, entry.rel);
  }

  // ---- the markup dialect (the React adapter overrides these) ---------------------------------------------------

  _inlineDecls(el) { return html.declsOf(el.attrs.style || ''); }
  _hasInline(el) { return el.attrs.style != null; }
  _inlineEdit(src, el, props) { return html.setInlineStyle(src, el, props); }
  _setAttr(src, el, name, value) { return html.setAttr(src, el, name, value); }
  _classEdit(src, el, classes) { return html.setAttr(src, el, 'class', classes.join(' ')); }
  _setText(src, el, text) { return html.setText(src, el, text); }
  _parseText(text, rel) { return html.parse(text, rel); }
  _markup(kind, { elId, src, label, alt }) {
    if (kind === 'image') return `<img id="${escAttr(elId)}" src="${escAttr(src)}" alt="${escAttr(alt)}">`;
    if (kind === 'button') return `<button id="${escAttr(elId)}" type="button">${src ? `<img src="${escAttr(src)}" alt="">` : ''}${escText(label)}</button>`;
    if (kind === 'text') return `<p id="${escAttr(elId)}">${escText(label)}</p>`;
    return `<div id="${escAttr(elId)}"></div>`;
  }
  _menuMarkup(menu, items) { return `<div id="${escAttr(menu)}" class="lain-dropdown" hidden>${items.map((i) => `<a href="${escAttr(i.target || '#')}">${escText(i.label || i.target)}</a>`).join('')}</div>`; }
  /** The script a screen's wires go in (flow.js). */
  wireScript(screen) {
    const { js: scripts } = html.links(this.read(screen).src);
    const dir = path.posix.dirname(screen);
    const local = scripts.map((s) => path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, s.split('?')[0]))).find((rel) => fs.existsSync(path.join(this.root, rel)));
    return local ? { rel: local, linked: true } : { rel: 'lain-wires.js', linked: false, link: (src) => { const close = src.lastIndexOf('</body>'); const at = close >= 0 ? close : src.length; return { start: at, end: at, text: '  <script src="lain-wires.js"></script>\n' }; } };
  }

  files(filter, maxDepth = 3) {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > maxDepth) return;
      let ents = [];
      try { ents = fs.readdirSync(path.join(this.root, dir), { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (IGNORE.test(rel)) continue;
        if (e.isDirectory()) walk(rel, depth + 1); else if (filter(rel)) out.push(rel);
      }
    };
    walk('', 0);
    return out.sort();
  }

  static detect(root) {
    const has = (f) => fs.existsSync(path.join(root, f));
    if (has('package.json')) {
      try { const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); const d = { ...(p.dependencies || {}), ...(p.devDependencies || {}) }; if (d.react) return 0; } catch { /* plain */ }
    }
    try { return fs.readdirSync(root).some((f) => /\.html?$/i.test(f)) ? 0.9 : 0; } catch { return 0; }
  }

  detect() { return WebProject.detect(this.root); }

  scanScreens() {
    return require('./routes').files(this.root, this.webRoot).sort((a, b) => Number(b.home) - Number(a.home));
  }

  scanElements(screen) {
    const e = this.read(screen);
    return e.tree.all.map((el) => ({
      id: el.id, tag: el.tag, name: nameOf(el), classes: el.classes, text: el.text, attrs: { id: el.attrs.id || null, src: el.attrs.src || null, href: el.attrs.href || null },
      parent: el.parent, children: el.children, file: screen, line: el.line, col: el.col,
    }));
  }

  /** Find a node by id across screens: { screen, el, entry }. */
  locate(id) {
    for (const s of this.scanScreens()) {
      const entry = this.read(s.file);
      const el = entry.tree.byId.get(id);
      if (el) return { screen: s.file, el, entry };
    }
    return null;
  }

  resolveSource(id) {
    const at = this.locate(id);
    if (!at) return null;
    return { file: at.screen, range: { start: at.el.start, end: at.el.end, line: at.el.line, col: at.el.col } };
  }

  sheetsFor(screen) {
    const { css: hrefs } = html.links(this.read(screen).src);
    const dir = path.posix.dirname(screen);
    return hrefs.map((h) => path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, h.split('?')[0]))).filter((rel) => fs.existsSync(path.join(this.root, rel))).map((rel) => this.read(rel));
  }

  /** Every element (on every screen) that carries `cls`. */
  classUses(cls) {
    const out = [];
    for (const s of this.scanScreens()) for (const el of this.read(s.file).tree.all) if (el.classes.includes(cls)) out.push({ screen: s.file, id: el.id });
    return out;
  }

  /** prop → { where: 'inline'|'class', cls?, value, sheet?, rule? } — the effective declaration (last class rule wins). */
  declaredFor(screen, el) {
    const out = {};
    for (const sh of this.sheetsFor(screen)) {
      for (const r of sh.sheet.rules) {
        if (r.inMedia) continue;
        const cls = el.classes.find((c) => r.selectors.includes(`.${c}`));
        if (!cls) continue;
        for (const d of r.decls) out[d.prop] = { where: 'class', cls, value: d.value, sheet: sh.rel, rule: r };
      }
    }
    for (const d of this._inlineDecls(el)) out[d.prop] = { where: 'inline', value: d.value };
    return out;
  }

  /**
   * WHERE A STYLE IS WRITTEN, in this order (and the result says which): (1) the element's inline style when it holds
   * the property, (2) a class only this element uses, (3) a new scoped class. A SHARED class is never edited silently:
   * the plan is 'shared' and the caller asks "all N uses, or only this one?".
   */
  planStyle(screen, el, prop, { scope = null } = {}) {
    const dec = this.declaredFor(screen, el)[prop];
    if (dec && dec.where === 'inline') return { kind: 'inline' };
    if (dec && dec.where === 'class') {
      const uses = this.classUses(dec.cls).length;
      if (uses <= 1) return { kind: 'class', cls: dec.cls, sheet: dec.sheet };
      if (scope === 'all') return { kind: 'class', cls: dec.cls, sheet: dec.sheet, shared: uses };
      if (scope === 'only') return this.scopedPlan(screen, el);
      return { kind: 'shared', cls: dec.cls, uses, sheet: dec.sheet };
    }
    // NOT DECLARED YET: a class only this element uses (with a rule) takes it; inline when the element already has a
    // style attribute; otherwise a new scoped class.
    for (const c of el.classes) {
      if (this.classUses(c).length !== 1) continue;
      const sh = this.sheetsFor(screen).find((s) => css.rulesForClass(s.sheet, c).length);
      if (sh) return { kind: 'class', cls: c, sheet: sh.rel };
    }
    if (this._hasInline(el)) return { kind: 'inline' };
    return this.scopedPlan(screen, el);
  }

  scopedPlan(screen, el) {
    const own = el.classes.find((c) => /^lain-/.test(c));
    const sheets = this.sheetsFor(screen);
    if (!sheets.length) return { kind: 'inline' };
    if (own) return { kind: 'class', cls: own, sheet: sheets.find((s) => css.rulesForClass(s.sheet, own).length)?.rel || sheets[sheets.length - 1].rel, scoped: true };
    const base = `lain-${slug(el.attrs.id || el.classes[0] || el.tag)}-${el.id.slice(1, 5)}`;
    return { kind: 'scoped', cls: base, sheet: sheets[sheets.length - 1].rel };
  }

  // ---- edits (computed, not written) ----------------------------------------------------------------------------

  /** Splices per file → the result shape every op returns. */
  _result(op, perFile, { summary, target, follow = null } = {}) {
    const files = [];
    for (const [rel, edits] of perFile) {
      const entry = fs.existsSync(path.join(this.root, rel)) ? this.read(rel) : { src: '', sha: null };
      const after = splice(entry.src, edits);
      if (after !== entry.src) files.push({ rel, before: entry.src, after, expectSha: entry.sha, edits });
    }
    const diff = files.map((f) => diffSummary(f.rel, f.before, f.after)).join('\n');
    let followId = null;
    if (follow) {
      const f = files.find((x) => x.rel === follow.rel);
      if (f) {
        const off = mapOffset(follow.offset, f.edits);
        const t = this._parseText(f.after, f.rel);
        const n = t.all.find((e) => e.start === off);
        followId = n ? n.id : null;
      } else followId = follow.id || op.node || null;   // the page itself did not move: the same id
    }
    return { ok: true, op: op.op, files: files.map(({ edits, ...f }) => f), summary, target: target || null, diff, followId };
  }

  _styleEdits(screen, el, props, scope, perFile) {
    const groups = new Map();   // planKey -> {plan, props}
    // ONE TARGET FOR A MOVE: position properties go where the element's position is already declared.
    const anchorPlan = Object.keys(props).some((p) => POSITION.has(p)) ? (() => {
      const dec = this.declaredFor(screen, el);
      const p = ['left', 'right', 'top', 'bottom', 'position'].find((k) => dec[k]);
      return p ? this.planStyle(screen, el, p, { scope }) : null;
    })() : null;
    for (const [p, v] of Object.entries(props)) {
      const plan = (POSITION.has(p) && anchorPlan) ? anchorPlan : this.planStyle(screen, el, p, { scope });
      if (plan.kind === 'shared') return { needs: { scope: { cls: plan.cls, uses: plan.uses, question: `Change all ${plan.uses} uses of .${plan.cls}, or only this one?` } } };
      const key = `${plan.kind}|${plan.cls || ''}|${plan.sheet || ''}`;
      if (!groups.has(key)) groups.set(key, { plan, props: {} });
      groups.get(key).props[p] = v;
    }
    const add = (rel, e) => { if (!perFile.has(rel)) perFile.set(rel, []); perFile.get(rel).push(...(Array.isArray(e) ? e : [e]).filter(Boolean)); };
    const targets = [];
    const page = this.read(el.file || screen);
    screen = el.file || screen;
    // TOKENS: a value that matches the project's design language is written as its token (tokens.js).
    const tok = (ps, rel) => (this.tokens ? Object.fromEntries(Object.entries(ps).map(([k, v]) => [k, v == null ? v : (this.tokens.token(k, v, rel) || v)])) : ps);
    for (const { plan, props: raw } of groups.values()) {
      const ps = tok(raw, plan.sheet || screen);
      if (plan.kind === 'inline') { add(screen, this._inlineEdit(page.src, el, ps)); targets.push('inline style'); continue; }
      if (plan.kind === 'tailwind') { add(screen, this._tailwindEdit(page.src, el, ps)); targets.push(`utilities on ${nameOf(el)}`); continue; }
      const sh = this.read(plan.sheet);
      if (plan.kind === 'class') {
        const rule = css.rulesForClass(sh.sheet, plan.cls)[0];
        if (rule) add(plan.sheet, css.setDecls(sh.src, rule, ps)); else add(plan.sheet, css.addRule(sh.src, `.${plan.cls}`, ps));
        targets.push(`.${plan.cls}${plan.shared ? ` (all ${plan.shared} uses)` : ''} in ${plan.sheet}`);
        continue;
      }
      // SCOPED: a new class on this element, and its rule.
      add(plan.sheet, css.addRule(sh.src, `.${plan.cls}`, ps));
      add(screen, this._classEdit(page.src, el, [...el.classes, plan.cls]));
      targets.push(`new class .${plan.cls} in ${plan.sheet}`);
    }
    return { targets };
  }

  /**
   * ONE EDIT, computed: { op: 'setStyle'|'move'|'resize'|'reorder'|'insert'|'remove'|'setText'|'setAsset'|… }.
   * Returns { ok, files:[{rel,before,after,expectSha}], summary, diff, target, followId } or { ok:false, why|needs }.
   * Nothing is written until `commit`.
   */
  applyEdit(op) {
    const handler = this[`_op_${op.op}`];
    if (!handler) return { ok: false, why: `unknown design edit "${op.op}"` };
    try { return handler.call(this, op); } catch (e) { return { ok: false, why: e.message }; }
  }

  _at(op, key = 'node') {
    const at = this.locate(op[key]);
    if (!at) throw new Error(`no element ${op[key]} — the file may have changed; read the screen again`);
    return at;
  }

  _op_setStyle(op) {
    const { screen, el } = this._at(op);
    const perFile = new Map();
    const r = this._styleEdits(screen, el, op.props || {}, op.scope || null, perFile);
    if (r.needs) return { ok: false, needs: r.needs };
    const props = Object.entries(op.props || {}).map(([p, v]) => (v == null ? `-${p}` : `${p}: ${v}`)).join('; ');
    return this._result(op, perFile, { summary: `${nameOf(el)}: ${props} → ${r.targets.join(', ')}`, target: r.targets, follow: { rel: screen, offset: el.start, id: el.id } });
  }

  _op_move(op) {
    const { screen, el } = this._at(op);
    if (!op.layout) return { ok: false, why: 'a move needs the element\'s measured layout (design_inspect, or the canvas)' };
    const declared = Object.fromEntries(Object.entries(this.declaredFor(screen, el)).map(([k, v]) => [k, v.value]));
    const d = layout.drag(op.layout, declared, { dx: op.dx || 0, dy: op.dy || 0, drop: op.drop || null });
    if (d.kind === 'absolute') {
      const perFile = new Map();
      const r = this._styleEdits(screen, el, d.props, op.scope || null, perFile);
      if (r.needs) return { ok: false, needs: r.needs };
      return this._result(op, perFile, { summary: `${nameOf(el)}: ${Object.entries(d.props).map(([p, v]) => (v == null ? `-${p}` : `${p} ${v}`)).join(', ')} → ${r.targets.join(', ')}`, target: r.targets, follow: { rel: screen, offset: el.start } });
    }
    const pick = op.choice || null;
    if (!pick) return { ok: false, needs: { choice: { choices: d.choices.map((c) => ({ id: c.id, label: c.label, index: c.index, props: c.props })), default: d.default, flexChild: d.flexChild } } };
    const c = d.choices.find((x) => x.id === pick);
    if (!c) return { ok: false, why: `"${pick}" is not offered here (${d.choices.map((x) => x.id).join(', ')})` };
    if (c.id === 'reorder') return this._op_reorder({ op: 'reorder', node: op.node, index: c.index });
    const perFile = new Map();
    const r = this._styleEdits(screen, el, c.props, op.scope || null, perFile);
    if (r.needs) return { ok: false, needs: r.needs };
    return this._result(op, perFile, { summary: `${nameOf(el)}: ${c.label.toLowerCase()} — ${Object.entries(c.props).map(([p, v]) => `${p} ${v}`).join(', ')} → ${r.targets.join(', ')}`, target: r.targets, follow: { rel: screen, offset: el.start } });
  }

  _op_resize(op) {
    const { screen, el } = this._at(op);
    if (!op.layout) return { ok: false, why: 'a resize needs the element\'s measured layout' };
    const declared = Object.fromEntries(Object.entries(this.declaredFor(screen, el)).map(([k, v]) => [k, v.value]));
    const props = layout.resize(op.layout, declared, { dw: op.dw || 0, dh: op.dh || 0, corner: op.corner || 'se' });
    return this._op_setStyle({ op: 'resize', node: op.node, props, scope: op.scope });
  }

  _op_reorder(op) {
    const { screen, el, entry } = this._at(op);
    const edits = html.reorder(entry.src, entry.tree, el, Number(op.index) || 0);
    const after = splice(entry.src, edits);
    const t = this._parseText(after, screen);
    const piece = entry.src.slice(el.start, el.end);
    const moved = t.all.find((x) => after.slice(x.start, x.end) === piece && x.tag === el.tag);
    const res = this._result(op, new Map([[screen, edits]]), { summary: `${nameOf(el)}: moved to position ${Number(op.index) + 1} among its siblings`, target: ['order in ' + screen] });
    res.followId = moved ? moved.id : null;
    return res;
  }

  _op_remove(op) {
    const { screen, el, entry } = this._at(op);
    return this._result(op, new Map([[screen, [html.remove(entry.src, el)]]]), { summary: `removed ${nameOf(el)}`, target: [screen] });
  }

  _op_setText(op) {
    const { screen, el, entry } = this._at(op);
    const e = this._setText(entry.src, el, String(op.text == null ? '' : op.text));
    if (!e) return { ok: false, why: `${el.tag} holds no text` };
    return this._result(op, new Map([[screen, [e]]]), { summary: `${nameOf(el)}: text "${op.text}"`, target: [screen], follow: { rel: screen, offset: el.start } });
  }

  _assetDir() { return fs.existsSync(path.join(this.root, 'assets')) ? 'assets' : (fs.existsSync(path.join(this.root, 'images')) ? 'images' : 'assets'); }

  /** Copy an asset into the project's asset folder (once, by content) and return its path relative to `screen`. */
  _asset(screen, source, perFile) {
    const abs = path.resolve(source);
    const ext = path.extname(abs).toLowerCase();
    if (!ASSET_EXT.has(ext)) throw new Error(`${ext || 'that file'} is not an image asset (png, jpg, gif, webp, svg, ico)`);
    const bytes = this.readBinary(abs);
    const dirRel = this._assetDir();
    const base = slug(path.basename(abs, ext));
    let rel = `${dirRel}/${base}${ext}`;
    let n = 1;
    while (fs.existsSync(path.join(this.root, rel)) && !this.readBinary(path.join(this.root, rel)).equals(bytes)) rel = `${dirRel}/${base}-${++n}${ext}`;
    perFile.binary = perFile.binary || [];
    if (!fs.existsSync(path.join(this.root, rel))) perFile.binary.push({ rel, bytes });
    const fromDir = path.posix.dirname(screen);
    return path.posix.relative(fromDir === '.' ? '' : fromDir, rel) || rel;
  }

  /**
   * INSERT a component: { parent, index, name, kind: 'button'|'text'|'image'|'container', text?, asset? }. An asset is
   * copied into the project's asset folder and referenced from the markup; a name becomes the element's id.
   */
  _op_insert(op) {
    const { screen, el: parent, entry } = this._at(op, 'parent');
    const perFile = new Map();
    const id = slug(op.name || op.kind || 'item');
    const taken = new Set(entry.tree.all.map((x) => x.attrs.id).filter(Boolean));
    let elId = id; let n = 1; while (taken.has(elId)) elId = `${id}-${++n}`;
    const src = op.asset ? this._asset(screen, op.asset, perFile) : null;
    const kind = op.kind || (src ? 'image' : 'button');
    const markup = this._markup(kind, { elId, src, label: op.text || op.name || '', alt: op.name || '' });
    const e = html.insertInto(entry.src, entry.tree, parent, markup, op.index == null ? Infinity : Number(op.index));
    perFile.set(screen, [e, ...(perFile.extra || [])]);
    const res = this._result(op, perFile, { summary: `added ${kind} "${op.name || elId}"${src ? ` with ${src}` : ''} to ${nameOf(parent)}`, target: [screen] });
    res.binary = perFile.binary || [];
    const t = this._parseText(res.files.find((f) => f.rel === screen).after, screen);
    const made = t.all.find((x) => x.attrs.id === elId);
    res.followId = made ? made.id : null;
    res.elementId = elId;
    return res;
  }

  _op_setAsset(op) {
    const { screen, el, entry } = this._at(op);
    const perFile = new Map();
    const src = this._asset(screen, op.asset, perFile);
    const target = el.tag === 'img' ? el : (el.children.map((c) => entry.tree.byId.get(c)).find((c) => c.tag === 'img'));
    if (!target) return { ok: false, why: `${nameOf(el)} has no image to replace — insert one instead` };
    perFile.set(screen, [this._setAttr(entry.src, target, 'src', src), ...(perFile.extra || [])]);
    const res = this._result(op, perFile, { summary: `${nameOf(el)}: image → ${src}`, target: [screen], follow: { rel: screen, offset: el.start } });
    res.binary = perFile.binary || [];
    return res;
  }

  // FLOWS AND ANIMATION live in flow.js (they write the project's script); loaded on first use.
  _op_addWire(op) { return require('./flow').addWire(this, op); }
  _op_removeWire(op) { return require('./flow').removeWire(this, op); }
  _op_updateWire(op) { return require('./flow').updateWire(this, op); }
  _op_setAnimation(op) { return require('./flow').setAnimation(this, op); }
  scanFlows() { return require('./flow').scanFlows(this); }

  // ---- writing ---------------------------------------------------------------------------------------------------

  /** WRITE a computed edit (behind the stale-edit guard), snapshot it for Undo, and say what happened. */
  commit(result, { label = null } = {}) {
    if (!result || !result.ok) return result || { ok: false, why: 'nothing to commit' };
    for (const b of result.binary || []) {
      const abs = path.join(this.root, b.rel);
      if (!fs.existsSync(abs)) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, b.bytes); }
    }
    // EVERY FILE IS CHECKED BEFORE ANY IS WRITTEN.
    for (const f of result.files) {
      let cur = null;
      try { cur = fs.readFileSync(path.join(this.root, f.rel), 'utf8'); } catch { cur = null; }
      if ((cur == null ? null : sha1(cur)) !== f.expectSha) return { ok: false, stale: true, why: `${f.rel} changed on disk since Design read it — nothing was written; the canvas re-reads it` };
    }
    const written = [];
    for (const f of result.files) {
      const w = this.write(f.rel, f.after, f.expectSha);
      if (w && w.ok === false) return { ...w, written };
      written.push(f.rel);
    }
    const snap = this.snapshots.push(label || result.summary, result.files, result.binary || []);
    this._cache.clear();
    if (this.onCommit) { try { this.onCommit(result); } catch { /* the reload is a courtesy */ } }
    return { ok: true, snapshot: snap.id, summary: result.summary, diff: result.diff, files: written, followId: result.followId };
  }

  undo() { const r = this.snapshots.step(this.root, 'undo', (rel, text, sha) => this.write(rel, text, sha)); this._cache.clear(); if (r.ok && this.onCommit) this.onCommit(r); return r; }
  redo() { const r = this.snapshots.step(this.root, 'redo', (rel, text, sha) => this.write(rel, text, sha)); this._cache.clear(); if (r.ok && this.onCommit) this.onCommit(r); return r; }
  restore(id) { const r = this.snapshots.restore(this.root, id, (rel, text, sha) => this.write(rel, text, sha)); this._cache.clear(); if (r.ok && this.onCommit) this.onCommit(r); return r; }
}

module.exports = { WebProject, nameOf, slug };
