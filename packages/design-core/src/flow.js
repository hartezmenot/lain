'use strict';

/**
 * FLOWS ARE CODE. A wire — element + trigger → action + target + transition — is written into the project's own script
 * as a marked block (`// lain:wire {…}` … `// /lain:wire <id>`) that calls a small helper block written once
 * (`// lain:design-helpers`). `scanFlows` reads those back, AND the navigation people write by hand (links, `onclick`,
 * `addEventListener` handlers that set `location`), so Flow mode shows both. Nothing about a wire lives anywhere else.
 */

const fs = require('fs');
const path = require('path');
const babel = require('@babel/parser');
const html = require('./html');
const anim = require('./animations');
const { splice, sha1, escAttr, escText } = require('./text');

const TRIGGERS = Object.freeze(['click', 'longpress', 'swipe', 'swipe-left', 'swipe-right', 'swipe-up', 'swipe-down', 'change']);
const ACTIONS = Object.freeze(['navigate', 'toggleDropdown', 'openModal', 'back', 'setState', 'custom']);
const WIRE_RE = /^[ \t]*\/\/ lain:wire (\{.*\})[ \t]*\r?\n[\s\S]*?^[ \t]*\/\/ \/lain:wire ([\w-]+)[ \t]*(\r?\n|$)/gm;
const HELPERS_OPEN = '// lain:design-helpers';
const HELPERS_CLOSE = '// /lain:design-helpers';

/** The helper block, as written into a project once (ES5: it runs in any browser the project targets). */
function helpers() {
  return `${HELPERS_OPEN} — written by LAIN Design; the wires below call these. Edit freely; keep the markers.
var LAIN_TRANSITIONS = ${JSON.stringify(anim.webTable())};
function lainOnScreen(screen) { if (!screen) return true; var p = location.pathname.split('/').pop() || 'index.html'; return p === screen; }
function lainWire(screen, id, trigger, run) {
  var hit = function (e) { var t = e.target && e.target.closest ? e.target.closest('[id]') : null; while (t && t.id !== id) t = t.parentElement ? t.parentElement.closest('[id]') : null; return lainOnScreen(screen) ? t : null; };
  if (trigger === 'longpress') {
    var timer = null;
    document.addEventListener('pointerdown', function (e) { var el = hit(e); if (el) timer = setTimeout(function () { run(e, el); }, 500); });
    ['pointerup', 'pointercancel'].forEach(function (k) { document.addEventListener(k, function () { clearTimeout(timer); }); });
    return;
  }
  if (trigger.indexOf('swipe') === 0) {
    var sx = 0, sy = 0, from = null;
    document.addEventListener('pointerdown', function (e) { from = hit(e); sx = e.clientX; sy = e.clientY; });
    document.addEventListener('pointerup', function (e) {
      if (!from) return;
      var dx = e.clientX - sx, dy = e.clientY - sy, el = from; from = null;
      var dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 40 && (trigger === 'swipe' || trigger === 'swipe-' + dir)) run(e, el);
    });
    return;
  }
  document.addEventListener(trigger === 'change' ? 'input' : 'click', function (e) { var el = hit(e); if (!el) return; if (trigger !== 'change') e.preventDefault(); run(e, el); });
}
function lainNavigate(to, opts, from) {
  opts = opts || {};
  var p = LAIN_TRANSITIONS[opts.transition] || {}, d = opts.duration || 300, ez = opts.easing || 'ease-out';
  var go = function () {
    if (to.charAt(0) === '/' && window.history && history.pushState && !/\.html?($|[?#])/.test(to)) { try { sessionStorage.removeItem('lain:enter'); } catch (e) { /* private mode */ } history.pushState({}, '', to); window.dispatchEvent(new PopStateEvent('popstate')); if (p.enter && document.documentElement.animate) document.documentElement.animate(p.enter, { duration: d, easing: ez }); if (o) o.remove(); if (b) b.cancel(); return; }
    location.href = to;
  };
  var o = null, b = null;
  try { sessionStorage.setItem('lain:enter', JSON.stringify({ transition: opts.transition || 'none', duration: d, easing: ez })); } catch (e) { /* private mode */ }
  if (p.fromElement && from && document.body.animate) {
    var r = from.getBoundingClientRect(), cs = getComputedStyle(from); o = document.createElement('div');
    var bg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : getComputedStyle(document.body).backgroundColor;
    o.style.cssText = 'position:fixed;z-index:2147483000;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;border-radius:' + cs.borderRadius + ';background:' + bg + ';';
    document.body.appendChild(o);
    var a = o.animate([{ left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', borderRadius: cs.borderRadius }, { left: '0px', top: '0px', width: innerWidth + 'px', height: innerHeight + 'px', borderRadius: '0px' }], { duration: d, easing: ez, fill: 'forwards' });
    a.onfinish = go;
    return;
  }
  if (p.leave && document.body.animate) { b = document.body.animate(p.leave, { duration: Math.round(d * 0.6), easing: ez, fill: 'forwards' }); b.onfinish = go; return; }
  go();
}
function lainBack() { history.back(); }
function lainToggleDropdown(id, opts, from) {
  var m = document.getElementById(id); if (!m) return;
  if (m.hasAttribute('hidden')) {
    if (from) { var r = from.getBoundingClientRect(); m.style.position = 'fixed'; m.style.top = (r.bottom + 6) + 'px'; m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px'; }
    m.removeAttribute('hidden');
    if (from) m.style.left = Math.max(8, Math.min(from.getBoundingClientRect().right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + 'px';
    var p = LAIN_TRANSITIONS[(opts && opts.transition) || 'dropdown-reveal'];
    if (p && p.enter && m.animate) m.animate(p.enter, { duration: (opts && opts.duration) || 160, easing: (opts && opts.easing) || 'ease-out' });
  } else m.setAttribute('hidden', '');
}
function lainOpenModal(to, opts) {
  var dlg = document.createElement('dialog'); dlg.className = 'lain-modal';
  var f = document.createElement('iframe'); f.title = to; f.src = to; dlg.appendChild(f);
  var x = document.createElement('button'); x.type = 'button'; x.className = 'lain-modal-close'; x.setAttribute('aria-label', 'Close'); x.textContent = '\\u00d7';
  x.onclick = function () { dlg.close(); dlg.remove(); }; dlg.appendChild(x);
  document.body.appendChild(dlg); dlg.showModal();
  var p = LAIN_TRANSITIONS[(opts && opts.transition) || 'slide-up'];
  if (p && p.enter && dlg.animate) dlg.animate(p.enter, { duration: (opts && opts.duration) || 260, easing: (opts && opts.easing) || 'ease-out' });
}
(function () {
  try {
    var s = sessionStorage.getItem('lain:enter'); if (!s) return; sessionStorage.removeItem('lain:enter');
    var o = JSON.parse(s), p = LAIN_TRANSITIONS[o.transition];
    if (p && p.enter && document.documentElement.animate) document.documentElement.animate(p.enter, { duration: o.duration || 300, easing: o.easing || 'ease-out' });
  } catch (e) { /* no transition */ }
})();
${HELPERS_CLOSE}
`;
}

const HELPER_CSS = '.lain-dropdown { min-width: 160px; padding: 6px; background: #ffffff; border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16); z-index: 50; }\n'
  + '.lain-dropdown a { display: block; padding: 8px 10px; color: inherit; text-decoration: none; border-radius: 6px; }\n'
  + '.lain-modal { width: min(92vw, 420px); height: min(86vh, 760px); padding: 0; border: 0; border-radius: 16px; overflow: hidden; }\n'
  + '.lain-modal iframe { width: 100%; height: 100%; border: 0; }\n'
  + '.lain-modal-close { position: absolute; top: 8px; right: 10px; border: 0; background: transparent; font-size: 22px; }\n';

const js = (v) => JSON.stringify(v).replace(/"/g, '\'');

/** How a wire's script refers to a target screen: a route (React) or a path relative to the source screen. */
function targetUrl(project, screen, t) {
  if (!t) return null;
  const scr = project.scanScreens().find((x) => x.file === t);
  if (project.kind === 'web-react') return scr ? scr.route : t;
  return scr ? (path.posix.relative(path.posix.dirname(screen), t) || t) : t;
}

/** One wire's code. */
function wireCode(w) {
  const opts = js({ transition: w.transition || 'none', duration: w.duration || 300, easing: w.easing || 'ease-out' });
  let body;
  const url = w.url || w.target;
  if (w.action === 'navigate') body = `lainNavigate(${js(url)}, ${opts}, el);`;
  else if (w.action === 'toggleDropdown') body = `lainToggleDropdown(${js(w.menu)}, ${opts}, el);`;
  else if (w.action === 'openModal') body = `lainOpenModal(${js(url)}, ${opts});`;
  else if (w.action === 'back') body = 'lainBack();';
  else if (w.action === 'setState') body = `document.documentElement.dataset[${js(w.state && w.state.key ? w.state.key : 'state')}] = ${js(w.state && w.state.value != null ? String(w.state.value) : 'on')};`;
  else body = '/* custom — describe it in the prompt bar and the Agent writes it here */';
  const meta = { id: w.id, screen: w.screen, url: w.url || null, source: w.source, trigger: w.trigger, action: w.action, target: w.target || null, menu: w.menu || null, transition: w.transition || 'none', duration: w.duration || 300, easing: w.easing || 'ease-out' };
  return `// lain:wire ${JSON.stringify(meta)}\nlainWire(${w.match === null ? 'null' : js(w.match || path.posix.basename(w.screen))}, ${js(w.source)}, ${js(w.trigger)}, function (e, el) { ${body} });\n// /lain:wire ${w.id}\n`;
}

// ---- reading -------------------------------------------------------------------------------------------------

/** Hand-written navigation in a script: { selectorId, target, trigger, line }. */
function handWritten(src, rel) {
  let ast;
  try { ast = babel.parse(src, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx'] }); } catch { return []; }
  const vars = new Map();   // name -> element id
  const idOf = (n) => {
    if (!n) return null;
    if (n.type === 'Identifier') return vars.get(n.name) || null;
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.arguments[0] && n.arguments[0].type === 'StringLiteral') {
      const m = n.callee.property.name; const a = n.arguments[0].value;
      if (m === 'getElementById') return a;
      if (m === 'querySelector' && /^#[\w-]+$/.test(a)) return a.slice(1);
    }
    return null;
  };
  const targetIn = (fn) => {
    let t = null;
    (function walk(n) {
      if (!n || typeof n !== 'object' || t) return;
      if (n.type === 'AssignmentExpression' && n.right.type === 'StringLiteral') {
        const l = n.left;
        const txt = l.type === 'MemberExpression' ? `${l.object.name || (l.object.property && l.object.property.name) || ''}.${l.property.name}` : l.name;
        if (/^(location\.href|window\.location|location)$/.test(txt) || (l.type === 'Identifier' && l.name === 'location')) t = n.right.value;
      }
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && /^(assign|replace)$/.test(n.callee.property.name || '') && n.arguments[0] && n.arguments[0].type === 'StringLiteral') {
        const o = n.callee.object; if ((o.name || (o.property && o.property.name)) === 'location') t = n.arguments[0].value;
      }
      for (const k of Object.keys(n)) { if (k === 'loc' || k === 'start' || k === 'end') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
    }(fn));
    return t;
  };
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') { const id = idOf(n.init); if (id) vars.set(n.id.name, id); }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'addEventListener' && n.arguments[0] && n.arguments[0].type === 'StringLiteral') {
      const id = idOf(n.callee.object); const ev = n.arguments[0].value; const t = targetIn(n.arguments[1]);
      if (id && t && /^(click|pointerup|touchend)$/.test(ev)) out.push({ selectorId: id, target: t, trigger: 'click', line: n.loc.start.line, start: n.start });
    }
    for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
  }(ast.program));
  return out.map((w) => ({ ...w, file: rel }));
}

/** Marked wires in a script: [{ meta, start, end }]. */
function marked(src) {
  const out = []; let m;
  WIRE_RE.lastIndex = 0;
  while ((m = WIRE_RE.exec(src))) {
    let meta = null;
    try { meta = JSON.parse(m[1]); } catch { meta = null; }
    if (meta && meta.id === m[2]) out.push({ meta, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** React: <Link to>, <NavLink to>, <a href>, and onClick handlers that call navigate('/x'); plus src/lain-wires.js. */
function scanFlowsReact(project) {
  const screens = project.scanScreens();
  const byRoute = new Map(screens.map((s) => [s.route, s.file]));
  const resolve = (t) => (t == null ? null : byRoute.get(String(t).split(/[?#]/)[0]) || null);
  const wires = [];
  const callTarget = (n) => {
    let t = null;
    (function walk(x) {
      if (!x || typeof x !== 'object' || t) return;
      // navigate('/x'), router.push('/x'), a local go('/x') — any call whose first argument is a known route.
      if (x.type === 'CallExpression' && x.arguments[0] && x.arguments[0].type === 'StringLiteral' && byRoute.has(x.arguments[0].value.split(/[?#]/)[0])) t = x.arguments[0].value;
      for (const k of Object.keys(x)) { if (k === 'loc') continue; const v = x[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
    }(n));
    return t;
  };
  for (const s of screens) {
    for (const e of project.scanElements(s.file)) {
      const el = project.read(e.file).tree.byId.get(e.id);
      if (!el) continue;
      let t = null; let kind = null;
      if (/^(Link|NavLink)$/.test(el.tag) && el.attrs.to) { t = el.attrs.to; kind = 'link'; } else if (el.tag === 'a' && el.attrs.href && el.attrs.href.startsWith('/')) { t = el.attrs.href; kind = 'link'; }
      if (!t && el.attrLoc.onClick) {
        const tree = project.read(e.file).tree;
        const find = (n) => { if (!n || typeof n !== 'object') return null; if (n.type === 'JSXAttribute' && n.start === el.attrLoc.onClick.start) return n; for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; const r = Array.isArray(v) ? v.map(find).find(Boolean) : (v && typeof v.type === 'string' ? find(v) : null); if (r) return r; } return null; };
        const attr = find(tree.ast.program);
        t = attr ? callTarget(attr) : null; kind = 'handler';
      }
      const target = resolve(t);
      if (target) wires.push({ id: `${kind}:${el.id}`, origin: 'code', kind, screen: s.file, source: { node: el.id, elementId: el.attrs.id || null }, trigger: 'click', action: 'navigate', target, transition: 'none', file: e.file, line: el.line });
    }
  }
  const sc = project.wireScript();
  const abs = path.join(project.root, sc.rel);
  if (fs.existsSync(abs)) {
    const src = fs.readFileSync(abs, 'utf8');
    for (const mk of marked(src)) {
      const w = mk.meta;
      let node = null;
      for (const rel of project.sources()) { const el = project.read(rel).tree.all.find((x) => x.attrs.id === w.source); if (el) { node = el.id; break; } }
      wires.push({ id: w.id, origin: 'design', screen: w.screen, source: { node, elementId: w.source }, trigger: w.trigger, action: w.action, target: resolve(w.target) || w.target, menu: w.menu || null, transition: w.transition, duration: w.duration, easing: w.easing, file: sc.rel, line: src.slice(0, mk.start).split('\n').length });
    }
  }
  return wires;
}

/** EVERY WIRE the code holds: [{ id, origin:'design'|'code', screen, source:{node, elementId}, trigger, action, target, transition, file, line }]. */
function scanFlows(project) {
  if (project.kind === 'web-react') return scanFlowsReact(project);
  const screens = project.scanScreens();
  const files = new Set(screens.map((s) => s.file));
  const wires = [];
  const resolveTarget = (from, t) => { if (!t) return null; const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from) === '.' ? '' : path.posix.dirname(from), t.split('#')[0].split('?')[0])); return files.has(rel) ? rel : null; };
  const byElementId = (screen, elId) => { const el = project.read(screen).tree.all.find((e) => e.attrs.id === elId); return el ? el.id : null; };
  const seenScripts = new Set();
  for (const s of screens) {
    const tree = project.read(s.file).tree;
    for (const el of tree.all) {
      if (el.tag === 'a' && el.attrs.href && !/^[a-z]+:|^#/i.test(el.attrs.href)) {
        const t = resolveTarget(s.file, el.attrs.href);
        if (t) wires.push({ id: `href:${el.id}`, origin: 'code', kind: 'link', screen: s.file, source: { node: el.id, elementId: el.attrs.id || null }, trigger: 'click', action: 'navigate', target: t, transition: 'none', file: s.file, line: el.line });
      }
      const oc = el.attrs.onclick && /location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/.exec(el.attrs.onclick);
      if (oc && resolveTarget(s.file, oc[1])) wires.push({ id: `onclick:${el.id}`, origin: 'code', kind: 'onclick', screen: s.file, source: { node: el.id, elementId: el.attrs.id || null }, trigger: 'click', action: 'navigate', target: resolveTarget(s.file, oc[1]), transition: 'none', file: s.file, line: el.line });
    }
    const { js: scripts } = html.links(project.read(s.file).src);
    for (const sc of scripts) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(s.file) === '.' ? '' : path.posix.dirname(s.file), sc.split('?')[0]));
      if (!fs.existsSync(path.join(project.root, rel))) continue;
      const src = fs.readFileSync(path.join(project.root, rel), 'utf8');
      const marks = marked(src);
      if (!seenScripts.has(rel)) {
        for (const mk of marks) {
          const w = mk.meta;
          const node = byElementId(w.screen, w.source);
          wires.push({ id: w.id, origin: 'design', screen: w.screen, source: { node, elementId: w.source }, trigger: w.trigger, action: w.action, target: w.target ? resolveTarget(w.screen, w.target) || w.target : null, menu: w.menu || null, transition: w.transition, duration: w.duration, easing: w.easing, file: rel, line: src.slice(0, mk.start).split('\n').length });
        }
      }
      // HAND-WRITTEN navigation outside the marked blocks, for elements on THIS screen.
      const outside = marks.reduce((acc, mk) => acc.slice(0, mk.start) + ' '.repeat(mk.end - mk.start) + acc.slice(mk.end), src);
      const helpersAt = outside.indexOf(HELPERS_OPEN);
      const plain = helpersAt >= 0 ? outside.slice(0, helpersAt) + ' '.repeat(Math.max(0, outside.indexOf(HELPERS_CLOSE) + HELPERS_CLOSE.length - helpersAt)) + outside.slice(outside.indexOf(HELPERS_CLOSE) + HELPERS_CLOSE.length) : outside;
      for (const h of handWritten(plain, rel)) {
        const node = byElementId(s.file, h.selectorId);
        const t = resolveTarget(s.file, h.target);
        if (node && t) wires.push({ id: `js:${rel}:${h.line}:${s.file}`, origin: 'code', kind: 'handler', screen: s.file, source: { node, elementId: h.selectorId }, trigger: h.trigger, action: 'navigate', target: t, transition: 'none', file: rel, line: h.line });
      }
      seenScripts.add(rel);
    }
  }
  return wires;
}

// ---- writing -------------------------------------------------------------------------------------------------

/**
 * ADD A WIRE: { node, trigger, action, target, transition, duration, easing, items? } → a computed edit (not written).
 * The source element gets an id when it has none; a dropdown gets its menu element; the helpers are written once.
 */
function addWire(project, op) {
  const at = project.locate(op.node);
  if (!at) return { ok: false, why: `no element ${op.node}` };
  const { screen, el, entry } = at;
  const trigger = TRIGGERS.includes(op.trigger) ? op.trigger : 'click';
  const action = ACTIONS.includes(op.action) ? op.action : 'navigate';
  if ((action === 'navigate' || action === 'openModal') && !op.target) return { ok: false, why: `${action} needs a target screen` };
  const transition = anim.preset(op.transition || (action === 'toggleDropdown' ? 'dropdown-reveal' : action === 'openModal' ? 'slide-up' : 'none'));
  const react = project.kind === 'web-react';
  const urlOf = (t) => targetUrl(project, screen, t);
  const id = `w${sha1(`${screen}:${el.id}:${Date.now()}:${Math.random()}`).slice(0, 6)}`;
  const perFile = new Map();
  const add = (rel, e) => { if (!perFile.has(rel)) perFile.set(rel, []); perFile.get(rel).push(e); };
  // THE ELEMENT NEEDS AN ID the wire can find it by.
  let elId = el.attrs.id;
  if (!elId) {
    const taken = new Set(entry.tree.all.map((x) => x.attrs.id).filter(Boolean));
    const base = require('./web').slug(require('./web').nameOf(el)); elId = base; let n = 1; while (taken.has(elId)) elId = `${base}-${++n}`;
    add(screen, project._setAttr(entry.src, el, 'id', elId));
  }
  // A DROPDOWN'S MENU is markup beside the element, hidden until the wire opens it.
  let menu = null;
  if (action === 'toggleDropdown') {
    menu = `${elId}-menu`;
    const items = (Array.isArray(op.items) && op.items.length ? op.items : (op.target ? [{ label: project.scanScreens().find((s) => s.file === op.target)?.name || op.target, target: op.target }] : [{ label: 'Item', target: '#' }]));
    const markup = project._menuMarkup(menu, items);
    const parent = el.parent ? entry.tree.byId.get(el.parent) : null;
    const sibs = parent ? parent.children : entry.tree.roots;
    add(screen, html.insertInto(entry.src, entry.tree, parent, markup, sibs.indexOf(el.id) + 1));
  }
  // THE SCRIPT: helpers once, then the wire.
  const sc = project.wireScript(screen);
  const scAbs = path.join(project.root, sc.rel);
  const cur = fs.existsSync(scAbs) ? fs.readFileSync(scAbs, 'utf8') : '';
  const needHelpers = !cur.includes(HELPERS_OPEN);
  const piece = `${needHelpers ? `${cur && !cur.endsWith('\n') ? '\n' : ''}\n${helpers()}` : ''}\n${wireCode({ id, screen, match: react ? null : undefined, url: urlOf(op.target), source: elId, trigger, action, target: op.target || null, menu, transition, duration: op.duration, easing: op.easing, state: op.state })}`;
  add(sc.rel, { start: cur.length, end: cur.length, text: piece });
  if (!sc.linked) { const l = sc.link(project.read(sc.linkFile || screen).src); add(sc.linkFile || screen, l); }
  // THE MENU AND MODAL STYLES, once, in the screen's stylesheet.
  if (action === 'toggleDropdown' || action === 'openModal') {
    const sheet = project.sheetsFor(screen)[0];
    if (sheet && !sheet.src.includes('.lain-dropdown')) add(sheet.rel, { start: sheet.src.length, end: sheet.src.length, text: `${sheet.src.endsWith('\n') ? '' : '\n'}${HELPER_CSS}` });
  }
  const res = project._result({ op: 'addWire' }, perFile, {
    summary: `wire ${require('./web').nameOf(el)} ${trigger} → ${action}${op.target ? ` ${op.target}` : ''}${transition !== 'none' ? ` (${transition})` : ''}`,
    target: [sc.rel], follow: { rel: screen, offset: el.start, id: el.id },
  });
  res.wireId = id;
  return res;
}

/** REMOVE a design-made wire (its marked block, and its dropdown menu when it made one). */
function removeWire(project, op) {
  for (const s of project.scanScreens()) {
    const sc = project.wireScript(s.file);
    const abs = path.join(project.root, sc.rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const mk = marked(src).find((m) => m.meta.id === op.id);
    if (!mk) continue;
    const perFile = new Map([[sc.rel, [{ start: mk.start, end: mk.end, text: '' }]]]);
    if (mk.meta.menu) {
      const page = project.read(mk.meta.screen);
      const m = page.tree.all.find((e) => e.attrs.id === mk.meta.menu);
      if (m) perFile.set(mk.meta.screen, [html.remove(page.src, m)]);
    }
    return project._result({ op: 'removeWire' }, perFile, { summary: `removed wire ${op.id} (${mk.meta.source} → ${mk.meta.action}${mk.meta.target ? ` ${mk.meta.target}` : ''})`, target: [sc.rel] });
  }
  return { ok: false, why: `no design-made wire ${op.id} (a hand-written one is changed in the IDE)` };
}

/** SET A WIRE'S TRANSITION (or trigger) in place: its marked block is rewritten from its own metadata. */
function updateWire(project, op) {
  for (const s of project.scanScreens()) {
    const sc = project.wireScript(s.file);
    const abs = path.join(project.root, sc.rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const mk = marked(src).find((m) => m.meta.id === op.id);
    if (!mk) continue;
    const w = { ...mk.meta, match: project.kind === 'web-react' ? null : undefined, ...(op.trigger ? { trigger: op.trigger } : {}), ...(op.transition ? { transition: anim.preset(op.transition) } : {}), ...(op.duration ? { duration: op.duration } : {}), ...(op.easing ? { easing: op.easing } : {}), ...(op.target ? { target: op.target, url: targetUrl(project, mk.meta.screen, op.target) } : {}) };
    return project._result({ op: 'updateWire' }, new Map([[sc.rel, [{ start: mk.start, end: mk.end, text: wireCode(w) }]]]), { summary: `wire ${op.id}: ${w.trigger} → ${w.action}${w.target ? ` ${w.target}` : ''} (${w.transition})`, target: [sc.rel] });
  }
  return { ok: false, why: `no design-made wire ${op.id}` };
}

/** SET AN ELEMENT'S ANIMATION: `animation` on the element (through the style planner) and the keyframes, once. */
function setAnimation(project, op) {
  const at = project.locate(op.node);
  if (!at) return { ok: false, why: `no element ${op.node}` };
  const name = anim.preset(op.preset);
  if (name === 'none') return project.applyEdit({ op: 'setStyle', node: op.node, props: { animation: null }, scope: op.scope });
  const r = project.applyEdit({ op: 'setStyle', node: op.node, props: { animation: anim.animationValue(name, op) }, scope: op.scope });
  if (!r.ok) return r;
  const sheet = project.sheetsFor(at.screen)[0];
  if (sheet && !sheet.src.includes(`@keyframes lain-${name} `)) {
    const f = r.files.find((x) => x.rel === sheet.rel);
    const base = f ? f.after : sheet.src;
    const add = `${base.endsWith('\n') ? '' : '\n'}${anim.keyframesCss(name)}\n`;
    if (f) f.after = base + add; else r.files.push({ rel: sheet.rel, before: sheet.src, after: base + add, expectSha: sheet.sha });
    r.diff += `\n${sheet.rel}: + ${anim.keyframesCss(name)}`;
  }
  r.summary = `${r.summary.split(':')[0]}: animation ${name}`;
  return r;
}

module.exports = { TRIGGERS, ACTIONS, scanFlows, addWire, removeWire, updateWire, setAnimation, helpers, wireCode, marked, handWritten, HELPER_CSS };
