'use strict';

/**
 * SCREENS FOR REAL APPS (D9) — routes read statically from the router the project uses, each a screen with its URL and
 * the file that renders it. File-based routers (Next app/ and pages/, SvelteKit, Nuxt, Astro) are read from the
 * file tree; React Router, Vue Router and Angular routes are read from the source that declares them. Nothing runs.
 * When none applies, crawl.js finds screens from the running app.
 */

const fs = require('fs');
const path = require('path');

const IGNORE = /(^|\/)(node_modules|\.git|\.next|\.svelte-kit|\.nuxt|dist|build|out|\.lain)(\/|$)/;

function walk(root, dir, max = 8, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (IGNORE.test(rel)) continue;
    if (e.isDirectory()) { if (max > 0) walk(root, rel, max - 1, out); } else out.push(rel);
  }
  return out;
}

const titleCase = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
function screen(file, route) {
  const segs = route.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  return { id: route, name: route === '/' ? 'Home' : titleCase(last && last.replace(/^:|\[|\]/g, '')), file, route, home: route === '/', pattern: /[:[]/.test(route) };
}

/** A route path from a file-based router directory path (groups and private folders dropped, params kept). */
function fileRoute(parts) {
  const segs = parts.filter((p) => !/^\(.*\)$/.test(p) && !/^@/.test(p) && p !== 'index');
  return `/${segs.map((p) => p.replace(/^\[\.\.\.(\w+)\]$/, '*$1').replace(/^\[(\w+)\]$/, ':$1')).join('/')}`.replace(/\/+$/, '') || '/';
}

function nextApp(root) {
  const base = fs.existsSync(path.join(root, 'src/app')) ? 'src/app' : 'app';
  return walk(root, base).filter((f) => /\/page\.(jsx|tsx|js|ts|mdx)$/.test(f)).map((f) => screen(f, fileRoute(f.slice(base.length + 1).split('/').slice(0, -1))));
}
function nextPages(root) {
  const base = fs.existsSync(path.join(root, 'src/pages')) ? 'src/pages' : 'pages';
  return walk(root, base).filter((f) => /\.(jsx|tsx|js|ts|mdx)$/.test(f) && !/\/(_app|_document|_error|404|500)\.|\/api\//.test(`/${f}`)).map((f) => screen(f, fileRoute(f.slice(base.length + 1).replace(/\.(jsx|tsx|js|ts|mdx)$/, '').split('/'))));
}
function sveltekit(root) {
  return walk(root, 'src/routes').filter((f) => /\/\+page\.svelte$/.test(f)).map((f) => screen(f, fileRoute(f.slice('src/routes/'.length).split('/').slice(0, -1))));
}
function nuxt(root) {
  const base = fs.existsSync(path.join(root, 'app/pages')) ? 'app/pages' : 'pages';
  return walk(root, base).filter((f) => /\.vue$/.test(f)).map((f) => screen(f, fileRoute(f.slice(base.length + 1).replace(/\.vue$/, '').split('/'))));
}
function astro(root) {
  return walk(root, 'src/pages').filter((f) => /\.(astro|md|mdx)$/.test(f)).map((f) => screen(f, fileRoute(f.slice('src/pages/'.length).replace(/\.(astro|md|mdx)$/, '').split('/'))));
}

/** Imported binding → file (relative import, with the usual extensions). */
function importsOf(root, rel) {
  let src = ''; try { src = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return new Map(); }
  const out = new Map();
  const re = /import\s+(?:(\w+)|\{([^}]+)\})\s+from\s+['"]([^'"]+)['"]|(\w+)\s*:\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)|const\s+(\w+)\s*=\s*(?:lazy|defineAsyncComponent)\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  const resolve = (spec) => {
    if (!spec.startsWith('.') && !spec.startsWith('@/') && !spec.startsWith('~/')) return null;
    const b = spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)) : `src/${spec.slice(2)}`;
    return ['', '.jsx', '.tsx', '.js', '.ts', '.vue', '.svelte', '/index.jsx', '/index.tsx', '/index.js', '/index.vue'].map((x) => b + x).find((f) => { try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; } }) || null;
  };
  while ((m = re.exec(src))) {
    if (m[1]) out.set(m[1], resolve(m[3]));
    else if (m[2]) for (const n of m[2].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean)) out.set(n, resolve(m[3]));
    else if (m[4]) out.set(m[4], resolve(m[5]));
    else if (m[6]) out.set(m[6], resolve(m[7]));
  }
  return out;
}

/** React Router: `{ path: '/x', element: <X /> }` objects and `<Route path="x" element={<X/>} />` elements. */
function reactRouter(root) {
  const files = walk(root, 'src').filter((f) => /\.(jsx|tsx|js|ts)$/.test(f));
  const out = [];
  for (const f of files) {
    let src = ''; try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    if (!/react-router|@tanstack\/react-router/.test(src)) continue;
    const imps = importsOf(root, f);
    const re = /path\s*:\s*['"]([^'"]*)['"][^}]*?(?:element\s*:\s*<\s*(\w+)|Component\s*:\s*(\w+)|component\s*:\s*(\w+))|<Route\b[^>]*?\bpath=["']([^"']*)["'][^>]*?element=\{\s*<\s*(\w+)/g;
    let m;
    while ((m = re.exec(src))) {
      const p = m[1] != null ? m[1] : m[5]; const comp = m[2] || m[3] || m[4] || m[6];
      const route = p.startsWith('/') ? p : `/${p}`;
      out.push(screen(imps.get(comp) || f, route === '/*' ? '/' : route));
    }
  }
  return out;
}

/** Vue Router: `routes: [{ path, component: X }]`. */
function vueRouter(root) {
  const out = [];
  for (const f of walk(root, 'src').filter((x) => /\.(js|ts)$/.test(x))) {
    let src = ''; try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    if (!/vue-router/.test(src)) continue;
    const imps = importsOf(root, f);
    const re = /path\s*:\s*['"]([^'"]+)['"][^}]*?component\s*:\s*(?:\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)|(\w+))/g; let m;
    while ((m = re.exec(src))) {
      let file = m[3] ? imps.get(m[3]) : null;
      if (m[2]) { const b = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[2])); file = fs.existsSync(path.join(root, b)) ? b : null; }
      out.push(screen(file || f, m[1]));
    }
  }
  return out;
}

/** Angular: `{ path: 'x', component: XComponent }` in the routes file. */
function angular(root) {
  const out = [];
  for (const f of walk(root, 'src').filter((x) => /routes?\.ts$|routing\.module\.ts$/.test(x))) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    const imps = importsOf(root, f);
    const re = /path\s*:\s*['"]([^'"]*)['"][^}]*?component\s*:\s*(\w+)/g; let m;
    while ((m = re.exec(src))) { const ts = imps.get(m[2]); const html = ts ? ts.replace(/\.ts$/, '.html') : null; out.push(screen(html && fs.existsSync(path.join(root, html)) ? html : ts || f, `/${m[1]}`.replace(/\/+$/, '') || '/')); }
  }
  return out;
}

/** Plain files: every .html in the web root (and pages/). */
function files(root, webRoot = '') {
  const base = webRoot || '';
  return walk(root, base, 2).filter((f) => /\.html?$/i.test(f) && (f.split('/').length === (base ? 2 : 1) || f.startsWith(`${base ? `${base}/` : ''}pages/`))).map((f) => {
    const routeRel = base ? f.slice(base.length + 1) : f;
    let title = null; try { const m = /<title>([^<]*)<\/title>/i.exec(fs.readFileSync(path.join(root, f), 'utf8')); title = m && m[1].trim(); } catch { /* none */ }
    const home = /^index\.html?$/i.test(routeRel);
    return { id: f, name: title || (home ? 'Home' : titleCase(path.basename(f).replace(/\.html?$/i, ''))), file: f, route: `/${routeRel}`, home };
  }).sort((a, b) => a.file.localeCompare(b.file));
}

/** The screens of a project as its router declares them: [{ id, name, file, route, home, pattern }]. */
function screens(root, det) {
  const by = { 'next-app': nextApp, 'next-pages': nextPages, sveltekit, nuxt, astro, 'react-router': reactRouter, 'vue-router': vueRouter, angular };
  let list = [];
  try { list = by[det.router] ? by[det.router](root) : det.router === 'files' ? files(root, det.webRoot || '') : []; } catch { list = []; }
  const seen = new Set();
  list = list.filter((s) => (seen.has(s.route) ? false : seen.add(s.route)));
  return list.sort((a, b) => Number(b.home) - Number(a.home) || a.route.localeCompare(b.route));
}

module.exports = { screens, importsOf, fileRoute, walk, files };
