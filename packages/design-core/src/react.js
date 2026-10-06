'use strict';

/**
 * THE REACT (VITE) ADAPTER. The same engine as plain HTML — style planning, layout-aware moves, snapshots, flows —
 * over JSX: screens are the route components (src/pages|screens|routes, else App), layers are the JSX elements of the
 * screen and the components it renders, styles go to the style object, the element's own CSS class (imported
 * stylesheets), or, in a Tailwind project, its utilities. The preview is the project's own Vite dev server with one
 * plugin added at createServer (no config file is touched): `data-lain-id` on host elements and the Design runtime.
 */

const fs = require('fs');
const path = require('path');
const jsx = require('./jsx');
const css = require('./css');
const { WebProject, nameOf, slug } = require('./web');
const { splice } = require('./text');

const SRC_EXT = /\.(jsx|tsx|js|ts)$/i;
const SCREEN_DIRS = ['src/pages', 'src/screens', 'src/routes', 'src/views'];

/** Tailwind: CSS prop → utility prefix (arbitrary values: `left-[16px]`), and what it replaces. */
const TW = {
  top: ['top', /^-?top-/], left: ['left', /^-?left-/], right: ['right', /^-?right-/], bottom: ['bottom', /^-?bottom-/],
  width: ['w', /^w-/], height: ['h', /^h-/], 'border-radius': ['rounded', /^rounded(-|$)/], opacity: ['opacity', /^opacity-/],
  'font-size': ['text', /^text-(xs|sm|base|lg|[2-9]?xl|\[\d)/], color: ['text', /^text-(\[#|\[rgb|black|white|transparent|current|inherit|[a-z]+-\d)/],
  'background-color': ['bg', /^bg-/], gap: ['gap', /^gap-/], padding: ['p', /^p-/], rotate: ['rotate', /^-?rotate-/],
  'z-index': ['z', /^z-/],
};
const TW_POSITION = { absolute: 'absolute', relative: 'relative', fixed: 'fixed', static: 'static', sticky: 'sticky' };

const file = (el, screen) => el.file || screen;

class ReactProject extends WebProject {
  constructor(root, opts = {}) {
    super(root, opts);
    this.kind = 'web-react';
    this.spa = true;
    this.tailwind = ReactProject.usesTailwind(this.root);
  }

  static pkg(root) { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return null; } }
  static deps(root) { const p = ReactProject.pkg(root) || {}; return { ...(p.dependencies || {}), ...(p.devDependencies || {}) }; }
  static detect(root) { const d = ReactProject.deps(root); if (!d.react) return 0; return d.vite ? 1 : 0.5; }
  static usesTailwind(root) { return Boolean(ReactProject.deps(root).tailwindcss) || fs.readdirSync(root).some((f) => /^tailwind\.config\./.test(f)); }
  detect() { return ReactProject.detect(this.root); }

  _parse(entry, ext) {
    if (SRC_EXT.test(entry.rel)) { try { entry.tree = jsx.parse(entry.src, entry.rel); } catch (e) { entry.tree = { all: [], byId: new Map(), roots: [], error: e.message }; } return; }
    super._parse(entry, ext);
  }

  // ---- the JSX dialect ------------------------------------------------------------------------------------------
  _inlineDecls(el) { return jsx.declsOf(el); }
  _hasInline(el) { return Boolean(el.styleObj); }
  _inlineEdit(src, el, props) { return jsx.setStyleObj(src, el, props); }
  _setAttr(src, el, name, value) { return jsx.setAttr(src, el, name === 'class' ? 'className' : name, value); }
  _classEdit(src, el, classes) {
    if (!el.classStatic) throw new Error(`${nameOf(el)}'s className is computed in code — change it in the IDE or through the Agent`);
    return jsx.setAttr(src, el, 'className', classes.join(' '));
  }
  _setText(src, el, text) { return jsx.setText(src, el, text); }
  _parseText(text, rel) { return jsx.parse(text, rel); }
  _markup(kind, { elId, src, label, alt, cls }) {
    const t = /[{}<>"]/.test(label) ? `{${JSON.stringify(label)}}` : label;
    const s = src ? `{${src}}` : null;
    const c = cls ? ` className=${JSON.stringify(cls)}` : '';
    if (kind === 'image') return `<img id="${elId}"${c} src=${s} alt=${JSON.stringify(alt)} />`;
    if (kind === 'button') return `<button id="${elId}"${c} type="button">${s ? `<img src=${s} alt="" />` : ''}${t}</button>`;
    if (kind === 'text') return `<p id="${elId}"${c}>${t}</p>`;
    return `<div id="${elId}"${c} />`;
  }
  _menuMarkup(menu, items) {
    return `<div id="${menu}" className="lain-dropdown" hidden>${items.map((i) => `<a href=${JSON.stringify(i.target || '#')}>${/[{}<>]/.test(i.label || '') ? `{${JSON.stringify(i.label)}}` : (i.label || i.target)}</a>`).join('')}</div>`;
  }

  /** An asset is copied into src/assets and IMPORTED by the file that uses it; markup refers to the binding. */
  _asset(file, source, perFile) {
    const assetRel = path.posix.normalize(`src/${super._asset('src/x', source, perFile)}`);
    const fromDir = path.posix.dirname(file);
    let spec = path.posix.relative(fromDir, assetRel); if (!spec.startsWith('.')) spec = `./${spec}`;
    const entry = this.read(file);
    const { list, insertAt } = jsx.imports(entry.src, file);
    const have = list.find((i) => i.source === spec && i.local);
    if (have) return have.local;
    const base = slug(path.basename(assetRel, path.extname(assetRel))).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()).replace(/^[^a-z_]/i, '_$&');
    let local = `${base}${path.extname(assetRel).slice(1).toUpperCase()}`; let n = 1;
    while (new RegExp(`\\b${local}\\b`).test(entry.src)) local = `${base}${path.extname(assetRel).slice(1).toUpperCase()}${++n}`;
    perFile.extra = perFile.extra || [];
    perFile.extra.push({ start: insertAt, end: insertAt, text: `${insertAt ? '\n' : ''}import ${local} from '${spec}';${insertAt ? '' : '\n'}` });
    return local;
  }

  _assetDir() { return fs.existsSync(path.join(this.root, 'src/images')) ? 'src/images' : 'src/assets'; }

  // ---- reading -------------------------------------------------------------------------------------------------

  sources() { return this.files((rel) => rel.startsWith('src/') && SRC_EXT.test(rel) && !/\.(test|spec|d)\.[jt]sx?$/.test(rel)); }

  scanScreens() {
    const all = this.sources();
    let screens = all.filter((rel) => SCREEN_DIRS.some((d) => rel.startsWith(`${d}/`)) && /\.(jsx|tsx)$/i.test(rel) && rel.split('/').length === 3);
    if (!screens.length) screens = all.filter((rel) => /^src\/App\.(jsx|tsx|js)$/i.test(rel));
    return screens.map((rel) => {
      const base = path.basename(rel).replace(SRC_EXT, '');
      const home = /^(index|home|app)$/i.test(base);
      return { id: rel, name: base === 'index' ? 'Home' : base.replace(/([a-z])([A-Z])/g, '$1 $2'), file: rel, route: home ? '/' : `/${base.toLowerCase()}`, home };
    }).sort((a, b) => Number(b.home) - Number(a.home) || a.name.localeCompare(b.name));
  }

  /** A screen's layers: its own JSX and the JSX of the local components it renders (one level of files deep, then on). */
  scanElements(screen) {
    const seen = new Set(); const out = [];
    const visit = (rel, depth) => {
      if (seen.has(rel) || depth > 4) return; seen.add(rel);
      const e = this.read(rel);
      for (const el of e.tree.all) out.push({ id: el.id, tag: el.tag, host: el.host, name: nameOf(el), classes: el.classes, text: el.text, attrs: { id: el.attrs.id || null, src: el.attrs.src || null, href: el.attrs.href || el.attrs.to || null }, parent: el.parent, children: el.children, file: rel, line: el.line, col: el.col });
      for (const im of jsx.imports(e.src, rel).list) {
        if (!im.source.startsWith('.')) continue;
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), im.source));
        const hit = ['', '.jsx', '.tsx', '.js', '.ts', '/index.jsx', '/index.tsx'].map((x) => base + x).find((f) => SRC_EXT.test(f) && fs.existsSync(path.join(this.root, f)) && fs.statSync(path.join(this.root, f)).isFile());
        if (hit && e.tree.all.some((el) => el.tag === im.local)) visit(hit, depth + 1);
      }
    };
    visit(screen, 0);
    return out;
  }

  /** Any element in any source file (a click can land in a component's JSX). */
  locate(id) {
    for (const rel of this.sources()) {
      const entry = this.read(rel);
      const el = entry.tree.byId.get(id);
      if (el) return { screen: rel, el, entry };
    }
    return null;
  }

  /** Stylesheets a file imports, and the app entry's (global CSS). */
  sheetsFor(file) {
    const rels = new Set();
    const from = (rel) => {
      try {
        for (const im of jsx.imports(this.read(rel).src, rel).list) {
          if (!/\.css$/i.test(im.source) || /\.module\.css$/i.test(im.source) || !im.source.startsWith('.')) continue;
          const r = path.posix.normalize(path.posix.join(path.posix.dirname(rel), im.source));
          if (fs.existsSync(path.join(this.root, r))) rels.add(r);
        }
      } catch { /* unreadable */ }
    };
    from(file);
    for (const f of ['src/main.jsx', 'src/main.tsx', 'src/index.jsx', 'src/index.tsx', 'src/App.jsx', 'src/App.tsx']) if (fs.existsSync(path.join(this.root, f))) from(f);
    return [...rels].map((r) => this.read(r));
  }

  classUses(cls) {
    const out = [];
    for (const rel of this.sources()) for (const el of this.read(rel).tree.all) if (el.classes.includes(cls)) out.push({ screen: rel, id: el.id });
    return out;
  }

  /** Tailwind first (utilities on the element), then the shared planner; a computed className falls back to inline. */
  planStyle(screen, el, prop, opts = {}) {
    if (this.tailwind && el.classStatic && (TW[prop] || prop === 'position' || prop === 'translate') && !(el.styleObj && el.styleObj.props.some((p) => jsx.kebab(p.key) === prop)) && this._utilityStyled(file(el, screen), el)) return { kind: 'tailwind' };
    const plan = super.planStyle(screen, el, prop, opts);
    if ((plan.kind === 'scoped' || (plan.kind === 'class' && plan.scoped && !el.classes.includes(plan.cls))) && !el.classStatic) return { kind: 'inline' };
    return plan;
  }

  /** Styled with utilities: it has classes and none of them is a rule in the project's own stylesheets (or no classes). */
  _utilityStyled(screen, el) {
    if (!el.classes.length) return true;
    const sheets = this.sheetsFor(screen);
    return !el.classes.some((c) => /^lain-/.test(c) || sheets.some((sh) => css.rulesForClass(sh.sheet, c).length));
  }

  _tailwindEdit(src, el, props) {
    let cls = el.classes.slice();
    for (const [p, v] of Object.entries(props)) {
      if (p === 'position') { cls = cls.filter((c) => !TW_POSITION[c]); if (v && TW_POSITION[v]) cls.push(TW_POSITION[v]); continue; }
      if (p === 'translate') {
        cls = cls.filter((c) => !/^-?translate-[xy]-/.test(c));
        if (v && v !== 'none') { const [x, y = '0px'] = String(v).split(/\s+/); cls.push(`translate-x-[${x}]`, `translate-y-[${y}]`); }
        continue;
      }
      const [pre, re] = TW[p];
      cls = cls.filter((c) => !re.test(c));
      // THE PROJECT'S THEME FIRST (`text-brand`, `rounded-card`); an arbitrary value only when no token has it.
      const named = v != null && this.tokens ? this.tokens.utility(p, v) : null;
      if (named) cls.push(named); else if (v != null && v !== '') cls.push(`${pre}-[${String(v).replace(/\s+/g, '_')}]`);
    }
    return jsx.setAttr(src, el, 'className', cls.join(' '));
  }

  /** Wires live in src/lain-wires.js, imported once by the app entry. */
  wireScript() {
    const rel = 'src/lain-wires.js';
    const exists = fs.existsSync(path.join(this.root, rel));
    const entry = ['src/main.jsx', 'src/main.tsx', 'src/index.jsx', 'src/index.tsx', 'src/main.js'].find((f) => fs.existsSync(path.join(this.root, f)));
    const linked = exists && entry && /lain-wires/.test(this.read(entry).src);
    return {
      rel, linked: Boolean(linked) || !entry, linkFile: entry,
      link: (src) => { const { insertAt } = jsx.imports(src, entry); return { start: insertAt, end: insertAt, text: `${insertAt ? '\n' : ''}import './lain-wires.js';${insertAt ? '' : '\n'}` }; },
    };
  }
}

/**
 * THE VITE PLUGIN, added at createServer only. `enforce: 'pre'` so it sees the module source exactly as on disk (the
 * ids are offsets into that text). Plain object — no Vite import.
 */
function vitePlugin({ root }) {
  const runtime = require('./runtime');
  const abs = require('./realroot').longPath(root);
  return {
    name: 'lain-design',
    enforce: 'pre',
    apply: 'serve',
    transform(code, id) {
      let file = id.split('?')[0];
      // ONE SPELLING: an id under the project in another form (8.3 short name, other case) is compared by its real path.
      const under = (f) => (process.platform === 'win32' ? f.toLowerCase().startsWith(abs.toLowerCase()) : f.startsWith(abs));
      if (!under(file)) { try { const r = fs.realpathSync.native(file); if (under(r)) file = r; } catch { /* not on disk */ } }
      if (!/\.(jsx|tsx)$/i.test(file) || !under(file) || file.includes('node_modules')) return null;
      const rel = path.relative(abs, file).replace(/\\/g, '/');
      const out = jsx.instrument(code, rel);
      return out === code ? null : { code: out, map: null };
    },
    transformIndexHtml() { return [{ tag: 'script', attrs: { src: '/__lain/runtime.js', 'data-lain-runtime': '1' }, injectTo: 'body' }]; },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/__lain/runtime.js')) { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(runtime.source()); return; }
        if (req.url && req.url.startsWith('/__lain/events')) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write(': lain (vite hot-reloads)\n\n'); return; }
        next();
      });
    },
  };
}

/** Start the project's own Vite with the plugin: { url, reload(), close() }. Needs the project's node_modules. */
async function startVite(root, { port = 0 } = {}) {
  const { pathToFileURL } = require('url');
  let pkgFile;
  try { pkgFile = require.resolve('vite/package.json', { paths: [root] }); } catch { throw new Error('this React project has no installed Vite (run its package manager install) — Design can read it, not preview it'); }
  // THE ESM ENTRY (Vite's CJS API is deprecated): exports['.'].import, whatever its shape.
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const pick = (e) => (typeof e === 'string' ? e : e && (pick(e.import) || pick(e.default)));
  const rel = pick(pkg.exports && (pkg.exports['.'] || pkg.exports)) || pkg.module || pkg.main;
  const mod = await import(pathToFileURL(path.join(path.dirname(pkgFile), rel)).href);
  const vite = mod.createServer ? mod : mod.default;
  const server = await vite.createServer({ root, plugins: [vitePlugin({ root })], server: { host: '127.0.0.1', port: port || undefined, strictPort: false, hmr: true }, clearScreen: false, logLevel: 'error' });
  await server.listen();
  const addr = server.httpServer.address();
  return { url: `http://127.0.0.1:${addr.port}`, port: addr.port, reload() { server.ws.send({ type: 'full-reload' }); return 1; }, close: () => server.close() };
}

module.exports = { ReactProject, vitePlugin, startVite, TW, css, splice };
