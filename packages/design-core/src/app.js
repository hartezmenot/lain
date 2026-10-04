'use strict';

/**
 * ANY JS FRONTEND (D9) — React with a router, Next, Vue, Svelte/SvelteKit, Solid… — as one adapter over three markup
 * dialects: JSX (jsx.js), Vue/Svelte templates (tmpl.js) and the stylesheets they import. Screens come from the router
 * (routes.js) or a crawl; a screen's layers are its route file, the layouts around it, and the local components they
 * render. Style edits for anything the running page shows go through the CSS origin (styles.js, via CDP); markup edits
 * (text, insert, reorder, remove, attributes) splice the file the element is mapped to.
 */

const fs = require('fs');
const path = require('path');
const html = require('./html');
const jsx = require('./jsx');
const tmpl = require('./tmpl');
const { ReactProject } = require('./react');
const { nameOf } = require('./web');

const SRC = /\.(jsx|tsx|js|ts|vue|svelte)$/i;
const TMPL = /\.(vue|svelte)$/i;
const ROOTS = ['src', 'app', 'pages', 'components', 'layouts', 'lib'];

class AppProject extends ReactProject {
  constructor(root, opts = {}) {
    super(root, opts);
    this.detection = opts.detection || require('./detect').detect(root);
    this.kind = `web-${this.detection.framework}`;
    this.spa = true;
    this.viaOrigin = true;   // styles through the CSS origin (styles.js): the running page says which rule applies
    this._screens = null;
  }

  static detect() { return 0; }   // chosen by open() from the detector, never by score

  _parse(entry, ext) {
    if (TMPL.test(entry.rel)) { try { entry.tree = tmpl.parse(entry.src, entry.rel); } catch (e) { entry.tree = { all: [], byId: new Map(), roots: [], error: e.message }; } return; }
    super._parse(entry, ext);
  }
  _parseText(text, rel) { return TMPL.test(rel) ? tmpl.parse(text, rel) : jsx.parse(text, rel); }

  // ---- the dialect follows the element's file ----------------------------------------------------------------------
  _t(el) { return TMPL.test(el.file || ''); }
  _inlineDecls(el) { return this._t(el) ? html.declsOf(typeof el.attrs.style === 'string' ? el.attrs.style : '') : super._inlineDecls(el); }
  _hasInline(el) { return this._t(el) ? typeof el.attrs.style === 'string' : super._hasInline(el); }
  _inlineEdit(src, el, props) { return this._t(el) ? html.setInlineStyle(src, el, props) : super._inlineEdit(src, el, props); }
  _setAttr(src, el, name, value) { return this._t(el) ? html.setAttr(src, el, name === 'className' ? 'class' : name, value) : super._setAttr(src, el, name, value); }
  _classEdit(src, el, classes) {
    if (!this._t(el)) return super._classEdit(src, el, classes);
    if (!el.classStatic) throw new Error(`${nameOf(el)}'s class is bound in code — change it in the IDE or through the Agent`);
    return html.setAttr(src, el, 'class', classes.join(' '));
  }
  _setText(src, el, text) { return this._t(el) ? html.setText(src, el, text) : super._setText(src, el, text); }

  sources() { return this.files((rel) => ROOTS.some((r) => rel === r || rel.startsWith(`${r}/`)) && SRC.test(rel) && !/\.(test|spec|d)\.[jt]sx?$/.test(rel) && !/(^|\/)(vite|next|svelte|nuxt|astro|tailwind|postcss)\.config\./.test(rel), 8); }

  scanScreens() {
    if (this._screens) return this._screens;
    const list = require('./routes').screens(this.root, this.detection);
    this._screens = list.length ? list : super.scanScreens();
    return this._screens;
  }
  setScreens(list) { this._screens = list; }

  /** The layouts around a route file (Next layout.*, SvelteKit +layout.svelte) and the app shell (App.vue/App.jsx). */
  shellOf(file) {
    const out = [];
    if (!file) return out;
    let dir = path.posix.dirname(file);
    const names = this.detection.framework === 'sveltekit' ? ['+layout.svelte'] : ['layout.jsx', 'layout.tsx', 'layout.js'];
    while (dir && dir !== '.') {
      for (const n of names) if (fs.existsSync(path.join(this.root, dir, n))) out.push(`${dir}/${n}`);
      if (/^(src\/routes|app|src\/app)$/.test(dir)) break;
      dir = path.posix.dirname(dir);
    }
    for (const n of ['src/App.vue', 'src/App.jsx', 'src/App.tsx', 'src/App.svelte']) if (fs.existsSync(path.join(this.root, n))) out.push(n);
    return out.reverse();
  }

  scanElements(screen) {
    const s = this.scanScreens().find((x) => x.file === screen || x.route === screen || x.id === screen);
    const file = s ? s.file : screen;
    const seen = new Set(); const out = [];
    const visit = (rel, depth) => {
      if (!rel || seen.has(rel) || depth > 4 || !fs.existsSync(path.join(this.root, rel))) return; seen.add(rel);
      const e = this.read(rel);
      if (!e.tree) return;
      for (const el of e.tree.all) out.push({ id: el.id, tag: el.tag, host: el.host !== false, name: nameOf(el), classes: el.classes, text: el.text, repeated: Boolean(el.repeated), attrs: { id: el.attrs.id || null, src: el.attrs.src || null, href: el.attrs.href || el.attrs.to || null }, parent: el.parent, children: el.children, file: rel, line: el.line, col: el.col });
      const imps = require('./routes').importsOf(this.root, rel);
      for (const [local, f] of imps) if (f && SRC.test(f) && e.tree.all.some((el) => el.tag === local || el.tag === local.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase())) visit(f, depth + 1);
    };
    for (const sh of this.shellOf(file)) visit(sh, 1);
    visit(file, 0);
    return out;
  }

  sheetsFor(file) {
    const rels = new Set();
    const from = (rel) => {
      let src = ''; try { src = this.read(rel).src; } catch { return; }
      for (const m of src.matchAll(/import\s+(?:\w+\s+from\s+)?['"](\.[^'"]+\.css)['"]/g)) { const r = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])); if (!/\.module\.css$/.test(r) && fs.existsSync(path.join(this.root, r))) rels.add(r); }
    };
    from(file);
    for (const f of ['src/main.js', 'src/main.jsx', 'src/main.ts', 'src/main.tsx', 'app/layout.jsx', 'app/layout.tsx', 'src/App.vue']) if (fs.existsSync(path.join(this.root, f))) from(f);
    return [...rels].map((r) => this.read(r));
  }

  _markup(kind, o) {
    if (!this._insertFile || !TMPL.test(this._insertFile)) return super._markup(kind, o);
    const cls = o.cls ? ` class="${o.cls}"` : '';
    if (kind === 'image') return `<img id="${o.elId}"${cls} src="${o.src}" alt="${o.alt || ''}">`;
    if (kind === 'button') return `<button id="${o.elId}"${cls} type="button">${o.label || ''}</button>`;
    if (kind === 'text') return `<p id="${o.elId}"${cls}>${o.label || ''}</p>`;
    return `<div id="${o.elId}"${cls}></div>`;
  }
  _op_insert(op) {
    const at = this.locate(op.parent);
    this._insertFile = at ? at.screen : null;
    try { return super._op_insert(op); } finally { this._insertFile = null; }
  }

  wireScript() {
    if (/^web-(react|solid)$/.test(this.kind)) return super.wireScript();
    const entry = ['src/main.js', 'src/main.ts', 'src/main.jsx', 'src/main.tsx'].find((f) => fs.existsSync(path.join(this.root, f)));
    const rel = 'src/lain-wires.js';
    const linked = entry && /lain-wires/.test(this.read(entry).src);
    return { rel, linked: Boolean(linked) || !entry, linkFile: entry, link: (src) => { const m = [...src.matchAll(/^import [^\n]+\n/gm)].pop(); const at = m ? m.index + m[0].length : 0; return { start: at, end: at, text: "import './lain-wires.js';\n" }; } };
  }
}

module.exports = { AppProject };
