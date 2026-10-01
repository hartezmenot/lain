'use strict';

/**
 * THE GUG — GEOMETRIC UI GRAPH. Core-owned (2026-09-24).
 *
 *     AST      what code structurally exists            codemodel.js / locate.js
 *     FGM      which feature owns what                  architecture.js
 *     Wiring   what talks to what                       wiring.js
 *     GUG      what visual nodes exist, where they are, how their geometry
 *              relates, and which source owns it         THIS FILE
 *
 * NOT Laya's, and not a replacement for any of the above. It is built from
 * DETERMINISTIC evidence only, in this order of preference:
 *
 *   1. the Workshop / browser DOM                 (inspect.js gugExpr)
 *   2. computed layout and bounds                 (the same measurement)
 *   3. UIA / accessibility bounds                 (fromUia, when no DOM)
 *   4. source stylesheet bindings                 (bind — rules and tokens)
 *   5. existing project intelligence              (uisource.js, by the caller)
 *
 * No model builds a node. A RELATION IS AN OBSERVATION, NOT AN INTENT: "right
 * gap 8" means 8 px were measured, never that a designer declared 8 px. Intent
 * stays UNKNOWN, and a limit the page did not report stays null.
 *
 * The flagship never receives the graph — only a bounded `slice` of it (a few
 * hundred tokens), rendered canonically so the same state costs nothing twice.
 */

const fs = require('fs');
const path = require('path');
const canonical = require('./canonical');

/** Measured, not declared: below half a pixel two numbers are the same number. */
const TOL = 0.5;
const MAX_NODES = 400;
const MAX_SIBLINGS = 40;
const SLICE_CHARS = 1800;

const EDGE = Object.freeze({
  PARENT_OF: 'PARENT_OF', CHILD_OF: 'CHILD_OF', ALIGNED_WITH: 'ALIGNED_WITH', CENTERED_IN: 'CENTERED_IN',
  ABOVE: 'ABOVE', BELOW: 'BELOW', LEFT_OF: 'LEFT_OF', RIGHT_OF: 'RIGHT_OF', ANCHORED_TO: 'ANCHORED_TO',
  SAME_WIDTH_AS: 'SAME_WIDTH_AS', SAME_HEIGHT_AS: 'SAME_HEIGHT_AS', GAP_TO: 'GAP_TO', OVERLAPS: 'OVERLAPS',
  CONTAINS: 'CONTAINS', BINDS_TO_SOURCE: 'BINDS_TO_SOURCE', CONTROLLED_BY_TOKEN: 'CONTROLLED_BY_TOKEN',
});

const near = (a, b) => Math.abs(a - b) <= TOL;
const r2 = (n) => canonical.num(n);

// ---- identity ---------------------------------------------------------------

const GENERATED = /^(?:css|sc|jsx|emotion|svelte|chakra|mui|tw)-[a-z0-9]{4,}$|^[a-z]{1,3}[0-9][a-z0-9]{4,}$|^_[a-zA-Z0-9]{5,}$/;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

/** The most meaningful name one element carries, or its tag. */
function token(el) {
  if (el.testid) return slug(el.testid);
  if (el.id) return slug(el.id);
  const cls = String(el.classes || '').split(/\s+/).filter((c) => c && !GENERATED.test(c));
  // The most specific authored class: `composer-submit` over `btn`.
  const best = cls.slice().sort((a, b) => b.length - a.length)[0];
  if (best) return slug(best);
  if (el.label) return slug(el.label);
  return slug(el.role || el.tag || 'node');
}

/**
 * STABLE SEMANTIC IDS. `composer.submit`: the node's own token under its
 * nearest named ancestor. A re-measure of the same DOM yields the same ids;
 * siblings that share a token are numbered in document order.
 */
function assignIds(els) {
  const ids = new Array(els.length);
  const used = new Map();
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    const own = token(e);
    const p = e.parent != null && e.parent >= 0 ? ids[e.parent] : null;
    // A wrapper with no name of its own does not lengthen its children's ids.
    const parentName = p && !/^(?:div|span|section|main|body|html|node)(?:-\d+)?$/.test(p.split('.').pop()) ? p : (p ? p.split('.').slice(0, -1).join('.') || null : null);
    let id = parentName ? `${parentName}.${own}` : own;
    if (id.split('.').length > 4) id = id.split('.').slice(-4).join('.');
    const n = (used.get(id) || 0) + 1;
    used.set(id, n);
    ids[i] = n > 1 ? `${id}#${n}` : id;
  }
  return ids;
}

// ---- building ---------------------------------------------------------------

function px(v) { const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v || '').trim()); return m ? Number(m[1]) : null; }

/**
 * A GRAPH FROM A DOM MEASUREMENT (inspect.js gugExpr, or an observation
 * receipt's nodes). `els`: [{ tag, id, classes, testid, role, label, text,
 * selector, rect:{x,y,w,h}, parent (index | -1), style:{…computed px} }].
 */
function fromDom(els, { root = '', surface = 'workshop', url = '', viewport = null, generation = 1, provenance = ['DOM', 'computed-style'] } = {}) {
  const list = (els || []).filter((e) => e && e.rect && e.rect.w > 0 && e.rect.h > 0).slice(0, MAX_NODES);
  // Re-index parents after the filter: a parent that was dropped hands its children to its own parent.
  const keep = new Map();
  (els || []).forEach((e, i) => { if (list.includes(e)) keep.set(i, keep.size); });
  const parentOf = (i) => {
    let p = els[i].parent;
    while (p != null && p >= 0 && !keep.has(p)) p = els[p] ? els[p].parent : -1;
    return p != null && p >= 0 ? keep.get(p) : -1;
  };
  const shaped = list.map((e) => ({ ...e, parent: parentOf(els.indexOf(e)) }));
  const ids = assignIds(shaped);
  const nodes = new Map();
  shaped.forEach((e, i) => {
    const st = e.style || {};
    const lim = (k) => { const v = px(st[k]); return v == null ? null : v; };
    nodes.set(ids[i], {
      id: ids[i],
      surface,
      role: e.role || null,
      tag: e.tag || null,
      name: String(e.label || e.text || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null,
      selector: e.selector || null,
      classes: String(e.classes || '').trim().split(/\s+/).filter(Boolean).slice(0, 8),
      domId: e.id || null,
      rect: { x: r2(e.rect.x), y: r2(e.rect.y), w: r2(e.rect.w), h: r2(e.rect.h) },
      parent: e.parent >= 0 ? ids[e.parent] : null,
      children: [],
      // WHAT THE PAGE REPORTED, or null — never a default dressed as a fact.
      limits: { minW: lim('min-width'), maxW: lim('max-width'), minH: lim('min-height'), maxH: lim('max-height') },
      style: pickStyle(st),
      binding: null,
      provenance: provenance.slice(),
    });
  });
  for (const n of nodes.values()) if (n.parent && nodes.has(n.parent)) nodes.get(n.parent).children.push(n.id);
  const g = { type: 'GUG', root: root ? path.resolve(root) : '', surface, url, viewport, generation, nodes, edges: [], stale: {} };
  g.edges = relations(g);
  g.fingerprint = fingerprint(g);
  return g;
}

const STYLE_KEYS = ['display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap', 'justify-content', 'align-items', 'flex-direction'];
function pickStyle(st) {
  const out = {};
  for (const k of STYLE_KEYS) if (st[k] != null && st[k] !== '') out[k] = String(st[k]).slice(0, 40);
  return out;
}

/**
 * A GRAPH FROM A UIA TREE (computer ui_tree), for surfaces with no DOM:
 * controlType, name, automationId and the bounding rectangle. No stylesheet
 * binding is possible from here, and none is invented.
 */
function fromUia(tree, { window = '', generation = 1 } = {}) {
  const els = [];
  const walk = (n, parent) => {
    if (!n || els.length >= MAX_NODES) return;
    const r = n.rect || n.bounds || null;
    const i = els.length;
    els.push({ tag: String(n.controlType || 'node').toLowerCase(), id: n.automationId || '', classes: '', role: n.controlType || '', label: n.name || '',
      rect: r ? { x: r.x, y: r.y, w: r.width != null ? r.width : r.w, h: r.height != null ? r.height : r.h } : null, parent });
    for (const c of n.children || []) walk(c, i);
  };
  walk(tree, -1);
  return fromDom(els, { surface: 'computer', url: window, generation, provenance: ['UIA'] });
}

// ---- relations -----------------------------------------------------------------

function edge(type, from, to, extra = {}) { return { type, from, to, ...extra, provenance: 'measured', intent: 'UNKNOWN' }; }

/**
 * THE RELATIONS A MEASUREMENT PROVES, for each parent and its children:
 * containment, centring, insets, sibling alignment, order, gaps, equal sizes,
 * overlap. Bounded per parent; nothing is inferred beyond the numbers.
 */
function relations(g) {
  const out = [];
  for (const p of g.nodes.values()) {
    const kids = p.children.map((id) => g.nodes.get(id)).filter(Boolean).slice(0, MAX_SIBLINGS);
    const pr = p.rect;
    for (const c of kids) {
      const r = c.rect;
      out.push(edge(EDGE.PARENT_OF, p.id, c.id));
      if (near(r.x + r.w / 2, pr.x + pr.w / 2)) out.push(edge(EDGE.CENTERED_IN, c.id, p.id, { axis: 'x' }));
      if (near(r.y + r.h / 2, pr.y + pr.h / 2)) out.push(edge(EDGE.CENTERED_IN, c.id, p.id, { axis: 'y' }));
      out.push(edge(EDGE.ANCHORED_TO, c.id, p.id, { insets: { top: r2(r.y - pr.y), right: r2(pr.x + pr.w - r.x - r.w), bottom: r2(pr.y + pr.h - r.y - r.h), left: r2(r.x - pr.x) } }));
    }
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].rect; const b = kids[j].rect; const A = kids[i].id; const B = kids[j].id;
        if (near(a.w, b.w)) out.push(edge(EDGE.SAME_WIDTH_AS, A, B));
        if (near(a.h, b.h)) out.push(edge(EDGE.SAME_HEIGHT_AS, A, B));
        for (const [k, va, vb] of [['top', a.y, b.y], ['bottom', a.y + a.h, b.y + b.h], ['left', a.x, b.x], ['right', a.x + a.w, b.x + b.w], ['centerY', a.y + a.h / 2, b.y + b.h / 2], ['centerX', a.x + a.w / 2, b.x + b.w / 2]]) {
          if (near(va, vb)) out.push(edge(EDGE.ALIGNED_WITH, A, B, { edge: k }));
        }
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (overlapX > TOL && overlapY > TOL) { out.push(edge(EDGE.OVERLAPS, A, B)); continue; }
        if (b.y >= a.y + a.h - TOL && overlapX > TOL) { out.push(edge(EDGE.ABOVE, A, B)); out.push(edge(EDGE.GAP_TO, A, B, { axis: 'y', px: r2(b.y - a.y - a.h) })); }
        else if (a.y >= b.y + b.h - TOL && overlapX > TOL) { out.push(edge(EDGE.BELOW, A, B)); out.push(edge(EDGE.GAP_TO, B, A, { axis: 'y', px: r2(a.y - b.y - b.h) })); }
        else if (b.x >= a.x + a.w - TOL && overlapY > TOL) { out.push(edge(EDGE.LEFT_OF, A, B)); out.push(edge(EDGE.GAP_TO, A, B, { axis: 'x', px: r2(b.x - a.x - a.w) })); }
        else if (a.x >= b.x + b.w - TOL && overlapY > TOL) { out.push(edge(EDGE.RIGHT_OF, A, B)); out.push(edge(EDGE.GAP_TO, B, A, { axis: 'x', px: r2(a.x - b.x - b.w) })); }
      }
    }
  }
  return out;
}

function fingerprint(g) {
  const nodes = [...g.nodes.values()].map((n) => [n.id, n.rect, n.binding ? `${n.binding.file}:${n.binding.line}` : null]);
  return canonical.hash({ nodes, url: g.url, viewport: g.viewport });
}

// ---- source binding ----------------------------------------------------------------

/**
 * EVERY STYLESHEET RULE, once per stylesheet state: selector, declarations
 * with line numbers, and the custom properties (tokens) each uses or defines.
 * Keyed by the files' sizes and mtimes, so a source edit is a new index.
 */
const ruleCache = new Map();
function rules(root) {
  const gj = require('./geometryjob');
  const files = gj.styleFiles(root);
  const key = files.map((f) => { try { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return f; } }).join('|');
  const hit = ruleCache.get(root);
  if (hit && hit.key === key) return hit.rules;
  const out = [];
  for (const file of files) {
    let text;
    try { if (fs.statSync(file).size > 512 * 1024) continue; text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(text))) {
      const selector = m[1].trim().split('\n').pop().trim();
      if (!selector || selector.startsWith('@')) continue;
      const startLine = text.slice(0, m.index + m[1].length).split(/\r?\n/).length;
      const decls = [];
      m[2].split(/\r?\n/).forEach((body, k) => {
        const dre = /(?:^|[;{\s])(--[\w-]+|[a-z-]+)\s*:\s*([^;]+)/g;
        let d;
        while ((d = dre.exec(body))) decls.push({ prop: d[1], value: d[2].trim(), line: startLine + k });
      });
      out.push({ file: rel, selector, line: startLine, decls, uses: [...new Set((m[2].match(/var\((--[\w-]+)/g) || []).map((v) => v.slice(4)))] });
    }
  }
  ruleCache.set(root, { key, rules: out });
  if (ruleCache.size > 20) ruleCache.delete(ruleCache.keys().next().value);
  return out;
}

const GEOMETRY_PROPS = /^(?:width|height|min-width|max-width|min-height|max-height|margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?|top|left|right|bottom|gap|inset|transform)$/;

/** Does the LAST compound of a selector name this node (a class or id it carries)? */
function selects(selector, node) {
  return selector.split(',').some((part) => {
    const last = part.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() || '';
    const names = last.match(/[.#][\w-]+/g) || [];
    if (!names.length) return false;
    return names.every((nm) => (nm[0] === '#' ? node.domId === nm.slice(1) : node.classes.includes(nm.slice(1))));
  });
}

/**
 * BIND EVERY NODE TO THE SOURCE THAT SIZES IT, or say it could not. EXACT:
 * one rule names the node and sets geometry. MULTIPLE: several do — the
 * person or the flagship chooses. UNKNOWN: none (generated class names, inline
 * styles, a framework's runtime) — said plainly, never guessed.
 */
function bind(g, root = g.root) {
  if (!root) return g;
  const all = rules(root);
  const tokens = new Map();
  for (const r of all) for (const d of r.decls) if (d.prop.startsWith('--')) tokens.set(d.prop, { file: r.file, line: d.line, value: d.value });
  g.edges = g.edges.filter((e) => e.type !== EDGE.BINDS_TO_SOURCE && e.type !== EDGE.CONTROLLED_BY_TOKEN);
  for (const n of g.nodes.values()) {
    const hits = all.filter((r) => selects(r.selector, n) && r.decls.some((d) => GEOMETRY_PROPS.test(d.prop)));
    if (!hits.length) { n.binding = { confidence: 'UNKNOWN', why: n.classes.length || n.domId ? 'no stylesheet rule names it and sets geometry' : 'no class or id to bind' }; continue; }
    const r = hits.length === 1 ? hits[0] : null;
    const used = [...new Set(hits.flatMap((h) => h.uses))].filter((t) => tokens.has(t));
    n.binding = r
      ? { confidence: 'EXACT', file: r.file, line: r.line, selector: r.selector, props: r.decls.filter((d) => GEOMETRY_PROPS.test(d.prop)).map((d) => ({ prop: d.prop, value: d.value, line: d.line })), tokens: used.map((t) => ({ name: t, ...tokens.get(t) })) }
      : { confidence: 'MULTIPLE', candidates: hits.slice(0, 6).map((h) => ({ file: h.file, line: h.line, selector: h.selector })), tokens: used.map((t) => ({ name: t, ...tokens.get(t) })) };
    if (!n.provenance.includes('source-css')) n.provenance.push('source-css');
    for (const h of hits.slice(0, 6)) g.edges.push({ type: EDGE.BINDS_TO_SOURCE, from: n.id, to: `${h.file}:${h.line}`, selector: h.selector, provenance: 'source-css', intent: 'UNKNOWN' });
    for (const t of used) g.edges.push({ type: EDGE.CONTROLLED_BY_TOKEN, from: n.id, to: t, at: `${tokens.get(t).file}:${tokens.get(t).line}`, provenance: 'source-css', intent: 'UNKNOWN' });
  }
  g.fingerprint = fingerprint(g);
  return g;
}

// ---- the store (per App, per project) -------------------------------------------------

// PER PROJECT, PROCESS-WIDE: one LAIN process, one current measurement per project root.
const STORE = new Map();
function storeOf() { return STORE; }
function _reset() { STORE.clear(); ruleCache.clear(); }

/**
 * KEEP A NEW MEASUREMENT for a project. The generation advances only when the
 * graph actually differs; the previous one is kept for the reverse mapping
 * (`impact`).
 */
function put(app, root, g) {
  const s = storeOf(app);
  const key = path.resolve(root || g.root || '.');
  const prev = s.get(key) || null;
  if (prev && prev.graph.fingerprint === g.fingerprint && !Object.keys(prev.graph.stale).length) return prev.graph;
  g.generation = prev ? prev.graph.generation + 1 : 1;
  s.set(key, { graph: g, previous: prev ? prev.graph : null });
  return g;
}

function get(app, root) { const e = storeOf(app).get(path.resolve(root || '.')); return e ? e.graph : null; }
function previous(app, root) { const e = storeOf(app).get(path.resolve(root || '.')); return e ? e.previous : null; }

/** The node a Workshop selection is, by selector (or rect as a last, exact resort). */
function nodeFor(g, el) {
  if (!g || !el) return null;
  for (const n of g.nodes.values()) if (el.selector && n.selector === el.selector) return n;
  if (el.rect) for (const n of g.nodes.values()) if (near(n.rect.x, el.rect.x) && near(n.rect.y, el.rect.y) && near(n.rect.w, el.rect.w) && near(n.rect.h, el.rect.h)) return n;
  return null;
}

/**
 * THE ONE UI → SOURCE BINDING (2026-09-25). "Which source owns this element?"
 * had two answers computed side by side — uisource.js searched the markup for
 * the component, and this graph bound the stylesheet rule that sizes it — and
 * every caller combined them its own way. It is answered here, once:
 *
 *   node       the GUG node the element is (by selector, else by bounds)
 *   style      the stylesheet rule that sizes it (bind, above), with confidence
 *   component  where the element's markup is declared — uisource.js's search,
 *              kept as EVIDENCE #5 in the header's order, never as a second owner
 *
 * Callers — the Workshop pick, the from-element route, the canonical Selection
 * (harnesscontext.selection), the geometry and selection jobs — consume this.
 */
function sourceBinding(app, root, el, g = null) {
  const graph = g || get(app, root);
  const node = graph && el ? nodeFor(graph, el) : null;
  let component = null;
  try { component = require('./harnessapp/uisource').fromElement({ session: { cwd: root } }, el || {}); } catch { component = null; }
  const b = node && node.binding;
  return {
    node: node ? node.id : null,
    generation: graph ? graph.generation : null,
    projectGeneration: graph && graph.projectGeneration != null ? graph.projectGeneration : null,
    style: b ? { confidence: b.confidence, file: b.file || null, line: b.line || null, selector: b.selector || null, candidates: b.candidates || null } : null,
    component: component ? { confidence: component.confidence, candidates: (component.candidates || []).slice(0, 5), searched: component.searched || [], why: component.why || '' } : null,
  };
}

// ---- reverse mapping ---------------------------------------------------------------------

/**
 * A SOURCE EDIT, SEEN FROM THE SCREEN: which nodes that file (or a token it
 * defines) sizes. They are marked STALE until the next measurement; the
 * generation is not advanced on a guess.
 */
function sourceEdited(app, root, file) {
  const g = get(app, root);
  if (!g) return [];
  const rel = String(file || '').replace(/\\/g, '/');
  const hit = [];
  for (const n of g.nodes.values()) {
    const b = n.binding || {};
    const files = [b.file, ...(b.candidates || []).map((c) => c.file), ...(b.tokens || []).map((t) => t.file)].filter(Boolean);
    if (files.includes(rel)) { hit.push(n.id); g.stale[n.id] = rel; }
  }
  return hit;
}

/**
 * WHAT CHANGED ON SCREEN between two measurements: per node, the move and the
 * resize; and the relations that appeared or disappeared. "SearchBar height
 * +6px · Results moved +6px · 2 affected visual relationships" — more useful
 * than "SearchView.tsx changed".
 */
function impact(before, after) {
  if (!before || !after) return null;
  const changes = [];
  for (const n of after.nodes.values()) {
    const o = before.nodes.get(n.id);
    if (!o) { changes.push({ id: n.id, added: true }); continue; }
    const d = { dx: r2(n.rect.x - o.rect.x), dy: r2(n.rect.y - o.rect.y), dw: r2(n.rect.w - o.rect.w), dh: r2(n.rect.h - o.rect.h) };
    if (Object.values(d).some((v) => Math.abs(v) > TOL)) changes.push({ id: n.id, ...d });
  }
  for (const id of before.nodes.keys()) if (!after.nodes.has(id)) changes.push({ id, removed: true });
  const key = (e) => `${e.type}|${e.from}|${e.to}|${e.axis || e.edge || ''}`;
  const geo = (list) => new Set(list.filter((e) => ![EDGE.PARENT_OF, EDGE.ANCHORED_TO, EDGE.GAP_TO, EDGE.BINDS_TO_SOURCE, EDGE.CONTROLLED_BY_TOKEN].includes(e.type)).map(key));
  const a = geo(before.edges); const b = geo(after.edges);
  const lost = [...a].filter((k) => !b.has(k));
  const gained = [...b].filter((k) => !a.has(k));
  const gaps = (g) => new Map(g.edges.filter((e) => e.type === EDGE.GAP_TO).map((e) => [key(e), e.px]));
  const ga = gaps(before); const gb = gaps(after);
  const gapChanged = [...gb.entries()].filter(([k, v]) => ga.has(k) && Math.abs(ga.get(k) - v) > TOL).map(([k, v]) => ({ rel: k, from: ga.get(k), to: v }));
  const lines = changes.slice(0, 12).map((c) => (c.added ? `${c.id} appeared` : c.removed ? `${c.id} disappeared`
    : [c.dw ? `width ${c.dw > 0 ? '+' : ''}${c.dw}px` : '', c.dh ? `height ${c.dh > 0 ? '+' : ''}${c.dh}px` : '', c.dx || c.dy ? `moved ${c.dx ? `x ${c.dx > 0 ? '+' : ''}${c.dx}px ` : ''}${c.dy ? `y ${c.dy > 0 ? '+' : ''}${c.dy}px` : ''}`.trim() : ''].filter(Boolean).map((s) => `${c.id} ${s}`).join(' · ')));
  return { from: before.generation, to: after.generation, changes, lost, gained, gapChanged, affectedRelations: lost.length + gained.length + gapChanged.length, lines };
}

// ---- the slice ----------------------------------------------------------------------------

/**
 * GUG_SLICE for one target: its geometry, parent, the relations it takes part
 * in, its nearest neighbours, its implementation binding, provenance and what
 * is unknown. Canonical and bounded (`maxChars`); never the whole graph.
 */
function slice(g, id, { maxChars = SLICE_CHARS } = {}) {
  const n = g && g.nodes.get(id);
  if (!n) return { text: '', chars: 0, found: false };
  const R = (r) => `x ${r2(r.x)} y ${r2(r.y)} w ${r2(r.w)} h ${r2(r.h)}`;
  const p = n.parent ? g.nodes.get(n.parent) : null;
  const mine = g.edges.filter((e) => e.from === id || e.to === id);
  const rel = [];
  if (near(n.rect.w, n.rect.h)) rel.push('width == height');
  for (const e of mine) {
    const other = e.from === id ? e.to : e.from;
    if (e.type === EDGE.CENTERED_IN && e.from === id) rel.push(`center${e.axis.toUpperCase()} == ${other}.center${e.axis.toUpperCase()}`);
    else if (e.type === EDGE.ANCHORED_TO && e.from === id) rel.push(`insets in ${other}: top ${e.insets.top} right ${e.insets.right} bottom ${e.insets.bottom} left ${e.insets.left}`);
    else if (e.type === EDGE.ALIGNED_WITH) rel.push(`${e.edge} aligned with ${other}`);
    else if (e.type === EDGE.SAME_WIDTH_AS || e.type === EDGE.SAME_HEIGHT_AS) rel.push(`${e.type === EDGE.SAME_WIDTH_AS ? 'width' : 'height'} == ${other}`);
    else if (e.type === EDGE.GAP_TO) rel.push(`${e.from === id ? 'gap after' : 'gap before'} ${e.px}px (${e.axis}) ${e.from === id ? 'to' : 'from'} ${other}`);
    else if (e.type === EDGE.OVERLAPS) rel.push(`overlaps ${other}`);
  }
  const nearby = (p ? p.children : []).filter((c) => c !== id).slice(0, 6).map((c) => { const m = g.nodes.get(c); return m ? `${m.id} ${m.tag || ''} w ${m.rect.w} h ${m.rect.h}` : c; });
  const b = n.binding || { confidence: 'UNKNOWN', why: 'not bound yet' };
  const impl = b.confidence === 'EXACT'
    ? [`${b.file}:${b.line} ${b.selector} { ${b.props.map((d) => `${d.prop}: ${d.value}`).join('; ')} }`, ...(b.tokens || []).map((t) => `token ${t.name}: ${t.value} (${t.file}:${t.line})`)]
    : b.confidence === 'MULTIPLE' ? [`MULTIPLE rules: ${b.candidates.map((c) => `${c.file}:${c.line} ${c.selector}`).join(' | ')}`] : [`UNKNOWN — ${b.why}`];
  const lim = Object.entries(n.limits || {}).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`);
  const lines = [
    `GUG_SLICE · generation ${g.generation} · ${g.surface}${g.url ? ` · ${g.url}` : ''}${g.stale[id] ? ` · STALE (source ${g.stale[id]} changed since this measurement)` : ''}`,
    `target: ${n.id}${n.tag ? ` <${n.tag}>` : ''}${n.name ? ` "${n.name}"` : ''}${n.role ? ` role ${n.role}` : ''}`,
    `geometry: ${R(n.rect)}`,
    p ? `parent: ${p.id} (${R(p.rect)})` : 'parent: none measured',
    `relations: ${rel.length ? [...new Set(rel)].slice(0, 12).join(' · ') : 'none measured'}`,
    nearby.length ? `nearby: ${nearby.join(' · ')}` : '',
    `limits: ${lim.length ? lim.join(' · ') : 'UNKNOWN (none reported by the page)'}`,
    `implementation: ${impl.join(' · ')}`,
    `provenance: ${n.provenance.join(' · ')}`,
    'uncertainty: relations are MEASURED, not declared — design intent is UNKNOWN',
  ].filter(Boolean);
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 60)}\n[… GUG slice bounded at ${maxChars} chars]`;
  return { text, chars: text.length, found: true, id, generation: g.generation };
}

/** A small, serialisable summary for routes and state (never the whole graph). */
function summary(g) {
  if (!g) return null;
  const bound = [...g.nodes.values()].filter((n) => n.binding && n.binding.confidence === 'EXACT').length;
  return { generation: g.generation, surface: g.surface, url: g.url, nodes: g.nodes.size, edges: g.edges.length, bound, stale: Object.keys(g.stale).length, fingerprint: g.fingerprint };
}

module.exports = { EDGE, fromDom, fromUia, relations, bind, rules, selects, put, get, previous, nodeFor, sourceBinding, sourceEdited, impact, slice, summary, _reset, assignIds, token, TOL, MAX_NODES, SLICE_CHARS };
