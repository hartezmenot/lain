'use strict';

/** THE HARNESS CONTEXT: what the person is looking at and pointing to (the Selection store), as Core-owned state. */

const path = require('path');
const canonical = require('./canonical');

const SURFACES = Object.freeze(['IDE', 'CHAT', 'WORKSHOP', 'BROWSER', 'COMPUTER', 'BOT', 'TERMINAL']);
/** A selection older than this describes a screen the person has left. */
const FRESH_MS = 30 * 60 * 1000;
const MAX_ACTIONS = 40;

/** The per-session state, created on first touch. In memory only. */
function of(session) {
  if (!session) return null;
  if (!session._harness) {
    session._harness = {
      generation: 0, surface: null, activeTab: null, activeFile: null, activeSymbol: null,
      textSelection: null, visualSelection: null, domSelection: null, uiaSelection: null,
      focus: null, dirty: [], navigation: [], actions: [], at: 0,
    };
  }
  return session._harness;
}

// ---- generations ------------------------------------------------------------

/** THE PROJECT GENERATION is Core's, shared by every process on the project: projectgen.js. */
const projectgen = require('./projectgen');
// ANOTHER PROCESS CHANGED A FILE (a CLI turn while the Harness is open): the
// GUG nodes that file sizes are stale here too.
projectgen.onForeign((root, changes) => {
  for (const c of changes) { try { require('./gug').sourceEdited(null, root, c.file); } catch { /* derived state only */ } }
});
function _reset() { projectgen._reset(); }

/** Bump the context generation only when the canonical state really changed. */
function touch(h) {
  const snap = canonical.hash({ s: h.surface, t: h.activeTab, f: h.activeFile, ts: h.textSelection, vs: h.visualSelection, ds: h.domSelection, us: h.uiaSelection, d: h.dirty, a: h.actions.length });
  if (snap !== h._hash) { h._hash = snap; h.generation += 1; h.at = Date.now(); return true; }
  return false;
}

function action(h, kind, text, extra = {}) {
  const a = { kind, text: String(text || '').slice(0, 160), at: Date.now(), ...extra };
  const last = h.actions[h.actions.length - 1];
  // A repeated report of the same thing is one action, not a stream.
  if (last && last.kind === a.kind && last.text === a.text) return last;
  h.actions.push(a);
  if (h.actions.length > MAX_ACTIONS) h.actions.splice(0, h.actions.length - MAX_ACTIONS);
  return a;
}

// ---- recording ---------------------------------------------------------------

/** The surface the person is on. Only a change is recorded as an action. */
function surface(app, session, name) {
  const h = of(session);
  const s = String(name || '').toUpperCase();
  if (!h || !SURFACES.includes(s)) return null;
  if (h.surface && h.surface !== s) action(h, 'surface', `switched ${h.surface} → ${s}`);
  h.surface = s;
  touch(h);
  return h;
}

/** THE EDITOR'S REPORT (POST /api/ide/context, after idecontext.record): file, tabs, selection, dirty buffers. */
function fromIde(app, session, body = {}) {
  const h = of(session);
  if (!h) return null;
  const file = body.file ? String(body.file).slice(0, 300) : null;
  if (file && file !== h.activeFile) { h.navigation.push({ file, at: Date.now() }); if (h.navigation.length > 20) h.navigation.shift(); if (h.activeFile) action(h, 'navigate', `opened ${file}`, { file }); }
  h.activeFile = file;
  h.activeTab = file;
  const sel = body.selection && typeof body.selection === 'object' && body.selection.text ? body.selection : null;
  const prevSel = h.textSelection;
  // WHEN THE PERSON MADE IT: kept while the range is the same, even when the text
  // under it changed (a rename rewrote it) — that is the same selection, not a new one.
  const sameRange = (x) => prevSel && prevSel.file === file && prevSel.startLine === (Number(x.startLine) || 0) && prevSel.endLine === (Number(x.endLine) || 0) && prevSel.startCol === (Number(x.startCol) || null);
  h.textSelection = sel ? { file, startLine: Number(sel.startLine) || 0, endLine: Number(sel.endLine) || 0, startCol: Number(sel.startCol) || null, head: String(sel.text).slice(0, 200), at: Date.now(), madeAt: sameRange(sel) ? (prevSel.madeAt || prevSel.at) : Date.now(), surface: 'IDE' } : null;
  if (h.textSelection && (!prevSel || prevSel.head !== h.textSelection.head || prevSel.file !== file)) action(h, 'select', `selected ${JSON.stringify(h.textSelection.head.slice(0, 40))} in ${file || 'the editor'}`, { file });
  h.dirty = Array.isArray(body.dirty) ? body.dirty.map((f) => String(f).slice(0, 300)).slice(0, 20) : h.dirty;
  // SELECTING CODE IS BEING IN THE EDITOR: a new text selection makes the IDE
  // the surface, so it — not an older Workshop pick — is what "this" means.
  const newSelection = h.textSelection && (!prevSel || prevSel.head !== h.textSelection.head || prevSel.file !== file || prevSel.startLine !== h.textSelection.startLine);
  if (newSelection && h.surface && h.surface !== 'IDE') { action(h, 'surface', `switched ${h.surface} → IDE`); h.surface = 'IDE'; }
  if (!h.surface) h.surface = 'IDE';
  touch(h);
  return h;
}

/** A WORKSHOP SELECTION: the element the person clicked, and the GUG node it is (by selector — gug.nodeFor). */
function workshopSelect(app, session, el, graph = null) {
  const h = of(session);
  if (!h || !el) return null;
  const gug = require('./gug');
  const node = graph ? gug.nodeFor(graph, el) : null;
  h.visualSelection = { surface: 'WORKSHOP', selector: el.selector || null, gugId: node ? node.id : null, gugGeneration: graph ? graph.generation : null,
    label: String(el.name || el.tag || '').slice(0, 60), rect: el.rect || null, at: Date.now(),
    // What the picked element IS, kept so the canonical Selection binds it
    // once (component evidence needs tag, id, classes and text, not a selector).
    element: { tag: el.tag || null, id: el.id || null, classes: (Array.isArray(el.classes) ? el.classes : String(el.classes || '').split(/\s+/)).filter(Boolean).slice(0, 12), text: String(el.text || '').slice(0, 120), selector: el.selector || null, rect: el.rect || null } };
  action(h, 'select', `selected ${node ? node.id : el.selector || el.tag} in the Workshop`, { gugId: node ? node.id : null });
  h.surface = 'WORKSHOP';
  touch(h);
  return h.visualSelection;
}

/** MEASURE THE WORKSHOP PAGE INTO THE GUG: one bounded evaluate (inspect.js gugExpr), nodes and relations built deterministically, bound to the… */
async function measureWorkshop(app, session, ws) {
  const gug = require('./gug');
  const root = session.cwd;
  const m = await ws.measure(root);
  if (!m || !m.ok) return { ok: false, why: (m && m.why) || 'the page could not be measured' };
  const g = gug.bind(gug.fromDom(m.elements, { root, surface: 'workshop', url: m.url, viewport: m.viewport }), root);
  // THE PROJECT STATE THIS MEASUREMENT SAW — the GUG's own generation counts
  // measurements; which project generation it measured is the canonical one.
  g.projectGeneration = projectgen.current(root).n;
  const kept = gug.put(app, root, g);
  const prev = gug.previous(app, root);
  const impact = kept === g && prev ? gug.impact(prev, g) : null;
  if (impact && impact.changes.length) action(of(session), 'visual', `visual change: ${impact.lines.slice(0, 2).join('; ')}`);
  return { ok: true, graph: kept, summary: gug.summary(kept), impact };
}

/** THE SAME MEASUREMENT, TAKEN BY THE FRAME PREVIEW'S BRIDGE (workshop/bridge.js): the page measured itself with the Workshop's own gugExpr and posted… */
function measureFrom(app, session, m) {
  const gug = require('./gug');
  const root = session.cwd;
  if (!m || !Array.isArray(m.elements)) return { ok: false, why: 'the preview sent no measurement' };
  const g = gug.bind(gug.fromDom(m.elements.slice(0, 400), { root, surface: 'workshop', url: m.url, viewport: m.viewport }), root);
  g.projectGeneration = projectgen.current(root).n;
  const kept = gug.put(app, root, g);
  const prev = gug.previous(app, root);
  const impact = kept === g && prev ? gug.impact(prev, g) : null;
  if (impact && impact.changes.length) action(of(session), 'visual', `visual change: ${impact.lines.slice(0, 2).join('; ')}`);
  return { ok: true, graph: kept, summary: gug.summary(kept), impact };
}

/** A FRAME PREVIEW SELECTION: its measurement into the GUG, the pick onto a node, recorded as THE selection. */
function framePicked(app, session, el, m) {
  if (!el || !session || !session.cwd) return null;
  const gug = require('./gug');
  let g = null;
  const r = measureFrom(app, session, m);
  g = r.ok ? r.graph : gug.get(app, session.cwd);
  const sel = workshopSelect(app, session, el, g);
  // THE FRAMEWORK'S OWN HINT (React _debugSource, Vue __file, Svelte meta) travels with the selection as evidence.
  const h = of(session);
  if (h && h.visualSelection && el.hints && (el.hints.file || el.hints.component)) h.visualSelection.hints = { framework: el.hints.framework || null, component: el.hints.component || null, file: el.hints.file ? String(el.hints.file).slice(0, 400) : null, line: el.hints.line || null };
  const n = g && sel && sel.gugId ? g.nodes.get(sel.gugId) : null;
  return sel ? { id: sel.gugId, generation: sel.gugGeneration, binding: n && n.binding ? { confidence: n.binding.confidence, file: n.binding.file || null, line: n.binding.line || null, selector: n.binding.selector || null } : null } : null;
}

/** THE PERSON PICKED AN ELEMENT IN THE WORKSHOP: measure (or reuse a graph that is not stale), map the pick to its GUG node, record it as the selection. */
async function workshopPicked(app, session, ws, el) {
  if (!el || !session || !session.cwd) return null;
  const gug = require('./gug');
  let g = gug.get(app, session.cwd);
  if (!g || Object.keys(g.stale).length || !gug.nodeFor(g, el)) {
    const r = await measureWorkshop(app, session, ws);
    g = r.ok ? r.graph : g;
  }
  const sel = workshopSelect(app, session, el, g);
  const n = g && sel && sel.gugId ? g.nodes.get(sel.gugId) : null;
  return sel ? { id: sel.gugId, generation: sel.gugGeneration, binding: n && n.binding ? { confidence: n.binding.confidence, file: n.binding.file || null, line: n.binding.line || null, selector: n.binding.selector || null } : null } : null;
}

/** A browser / DOM or computer / UIA selection, by reference only. */
function select(app, session, kind, ref = {}) {
  const h = of(session);
  if (!h) return null;
  const v = { ...ref, at: Date.now() };
  if (kind === 'dom') { h.domSelection = v; h.surface = 'BROWSER'; }
  else if (kind === 'uia') { h.uiaSelection = v; h.surface = 'COMPUTER'; }
  else return null;
  action(h, 'select', `selected ${ref.selector || ref.name || ref.automationId || kind} (${kind.toUpperCase()})`);
  touch(h);
  return v;
}

/** A SOURCE EDIT. Advances the project generation with the file, marks the GUG nodes that file sizes as STALE (the reverse mapping), and records who did… */
function noteSourceEdit(app, session, { file, by = 'user', what = '' } = {}) {
  if (!file) return null;
  const root = (session && session.cwd) || process.cwd();
  const rel = path.isAbsolute(String(file)) ? path.relative(root, String(file)).replace(/\\/g, '/') : String(file).replace(/\\/g, '/');
  const n = projectgen.advance(root, { file: rel, by });
  let affected = [];
  try { if (require.cache[require.resolve('./gug')]) affected = require('./gug').sourceEdited(app, root, rel); } catch { affected = []; }   // geometry (frozen, S9): only once it loaded
  const h = of(session);
  if (h) {
    if (by === 'user') action(h, 'edit', `${what ? `${what} — ` : ''}manually edited ${rel}`, { file: rel });
    else action(h, 'edit', `${by} edited ${rel}${what ? ` (${what})` : ''}`, { file: rel });
    if (by === 'user') try { require('./journey').note(session, 'user.edit', { file: rel }); } catch { /* the path is a courtesy */ }
    touch(h);
  }
  return { generation: n, file: rel, gugAffected: affected };
}

// ---- reading -----------------------------------------------------------------

function fresh(x) { return x && x.at && Date.now() - x.at <= FRESH_MS; }

/** WHAT "THIS" IS, if the person pointed at something: the most recent fresh selection. */
function referent(app, session) {
  const h = session && session._harness;
  if (!h) return null;
  const all = [
    fresh(h.textSelection) && { kind: 'text', explicit: true, surface: 'IDE', file: h.textSelection.file, startLine: h.textSelection.startLine, endLine: h.textSelection.endLine, startCol: h.textSelection.startCol || null, head: h.textSelection.head, at: h.textSelection.at, madeAt: h.textSelection.madeAt || h.textSelection.at },
    fresh(h.visualSelection) && { kind: 'visual', explicit: true, surface: 'WORKSHOP', gugId: h.visualSelection.gugId, gugGeneration: h.visualSelection.gugGeneration, selector: h.visualSelection.selector, label: h.visualSelection.label, at: h.visualSelection.at },
    fresh(h.domSelection) && { kind: 'dom', explicit: true, surface: 'BROWSER', ...h.domSelection },
    fresh(h.uiaSelection) && { kind: 'uia', explicit: true, surface: 'COMPUTER', ...h.uiaSelection },
  ].filter(Boolean).sort((a, b) => b.at - a.at);
  if (!all.length) return null;
  // THE SURFACE THE PERSON IS ON wins over a newer selection on another.
  const on = all.find((r) => r.surface === h.surface);
  return on || all[0];
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** THE AST SIDE OF A TEXT SELECTION: a selected identifier resolved to its declaration(s) by locate.js. */
function resolveSymbol(root, ref) {
  if (!ref || ref.kind !== 'text') return null;
  const name = String(ref.head || '').trim();
  if (!IDENT.test(name)) return { name: null, why: 'the selection is not a single identifier' };
  try {
    const { defs, refs } = require('./locate').sweep(root, name);
    return { name, defs: defs.slice(0, 4).map((d) => ({ file: d.file, line: d.line })), refs, declaredInSelection: defs.some((d) => d.file === ref.file && d.line >= ref.startLine && d.line <= ref.endLine) };
  } catch { return { name, defs: [], refs: 0 }; }
}

// THE CANONICAL SELECTION

const MAX_SEL_TEXT = 2000;
const MAX_SCAN_FILES = 3000;
const MAX_SCAN_BYTES = 400000;
const CODE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|php|swift|scala|dart|lua|html?|css|scss|less|json|ya?ml|toml|md)$/i;
const JSISH = /\.(?:[cm]?[jt]sx?)$/i;

function readSmall(abs) {
  try { const st = require('fs').statSync(abs); if (!st.isFile() || st.size > MAX_SCAN_BYTES) return null; return require('fs').readFileSync(abs, 'utf8'); } catch { return null; }
}
function snakeOf(n) { return n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(); }

/** Where `name` occurs across the project, classified — the one scan, cached with the selection. */
function symbolSites(root, name) {
  let files = [];
  try { files = Object.keys(require('./projectindex').fresh(root, { persist: false }).index.files || {}).filter((f) => CODE_EXT.test(f)); } catch { files = []; }
  const code = [];
  const strings = [];
  const wire = [];
  const spellings = [...new Set([snakeOf(name), snakeOf(name).replace(/_/g, '-')])].filter((w) => w !== name);
  const word = new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`, 'g');
  for (const rel of files.slice(0, MAX_SCAN_FILES)) {
    const text = readSmall(path.join(root, rel));
    if (!text) continue;
    for (const w of spellings) if (wire.length < 8 && (text.includes(`"${w}"`) || text.includes(`'${w}'`) || text.includes(`\`${w}\``))) wire.push({ file: rel, name: w });
    if (!text.includes(name)) continue;
    let sites = [];
    if (JSISH.test(rel)) { try { sites = require('./rename').sitesIn(text, name).map((s) => ({ kind: s.kind, line: s.line })); } catch { sites = []; } }
    if (!sites.length) {
      text.split('\n').forEach((ln, i) => {
        word.lastIndex = 0;
        let m;
        while ((m = word.exec(ln))) {
          const before = ln.slice(0, m.index + m[1].length);
          const quoted = (before.match(/["'`]/g) || []).length % 2 === 1;
          const comment = /(^|\s)(\/\/|#|--)/.test(before);
          sites.push({ kind: quoted || comment ? 'text' : 'identifier', line: i + 1 });
        }
      });
    }
    const ids = sites.filter((s) => s.kind !== 'text');
    const txt = sites.filter((s) => s.kind === 'text');
    if (ids.length) {
      const kinds = {};
      for (const s of ids) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
      code.push({ file: rel, lines: ids.map((s) => s.line), kinds });
    }
    if (txt.length) strings.push({ file: rel, lines: txt.map((s) => s.line) });
  }
  return { files: code, strings, wire, scanned: Math.min(files.length, MAX_SCAN_FILES) };
}

/** THE SELECTION, resolved once per (referent, project generation). */
function selection(app, session) {
  const ref = referent(app, session);
  if (!ref || !session) return null;
  // THE PERSON CLOSED THE SELECTION CHIP for this IDE turn: it is not "this".
  if (ref.kind === 'text' && session._ideTurn && session._ideExclude && session._ideExclude.selection) return null;
  const root = session.cwd || process.cwd();
  const h = of(session);
  const gen = projectgen.current(root).n;
  // THE ID NAMES WHAT WAS SELECTED; the generation says which project state it
  // was resolved against. "S3f… at generation 91" — the same pick keeps its id.
  const refKey = canonical.hash({ k: ref.kind, f: ref.file || null, s: ref.startLine || null, e: ref.endLine || null, h: ref.head || null, g: ref.gugId || null, x: ref.selector || null });
  const key = `${refKey}:${gen}`;
  const stats = h._selStats = h._selStats || { hits: 0, carried: 0, resolved: 0 };
  if (h._selection && h._selection.key === key) { stats.hits += 1; return h._selection.value; }
  // THE GENERATION MOVED, but maybe not under this selection: a resolution none
  // of whose inputs changed is carried forward, not recomputed (contextcache's rule).
  if (h._selection && h._selection.refKey === refKey) {
    const prev = h._selection.value;
    if (!touches(root, prev)) {
      const v = { ...prev, projectGeneration: gen, carriedFrom: prev.carriedFrom != null ? prev.carriedFrom : prev.projectGeneration };
      h._selection = { key, refKey, value: v };
      stats.carried += 1;
      return v;
    }
  }
  stats.resolved += 1;
  const v = {
    id: `S${refKey.slice(0, 10)}`, surface: ref.surface, kind: ref.kind, explicit: Boolean(ref.explicit),
    projectGeneration: gen, selectionGeneration: h.generation, madeAt: ref.madeAt || ref.at || null,
    source: null, visual: null, symbol: null, provenance: [],
  };
  if (ref.kind === 'text') {
    const ide = session._ide;
    const full = ide && ide.selection && (!ide.file || ide.file === ref.file) ? ide.selection.text : ref.head;
    v.source = { file: ref.file, startLine: ref.startLine, endLine: ref.endLine, text: String(full || '').slice(0, MAX_SEL_TEXT) };
    const sym = resolveSymbol(root, ref);
    if (ref.startCol) v.source.startCol = ref.startCol;
    if (sym && sym.name) v.symbol = { name: sym.name, declarations: sym.defs, declaredInSelection: sym.declaredInSelection, ...symbolSites(root, sym.name) };
    if (ref.file) { try { v.provenance = require('./editledger').recentUserEdits(root, [ref.file]); } catch { v.provenance = []; } }
  } else if (ref.kind === 'visual') {
    // THE ONE BINDING (gug.sourceBinding): style owner and component evidence, once.
    const vs = h.visualSelection || {};
    const b = require('./gug').sourceBinding(app, root, vs.element || { selector: ref.selector || vs.selector, rect: vs.rect || null });
    v.visual = { gugId: ref.gugId || null, selector: ref.selector || null, label: ref.label || null, gugGeneration: ref.gugGeneration || null,
      binding: b.style ? { file: b.style.file, line: b.style.line, selector: b.style.selector, confidence: b.style.confidence } : null,
      component: b.component, sourceBinding: b, element: vs.element || null };
    if (v.visual.binding && v.visual.binding.file) { try { v.provenance = require('./editledger').recentUserEdits(root, [v.visual.binding.file]); } catch { v.provenance = []; } }
  } else {
    v.visual = { kind: ref.kind, selector: ref.selector || null, name: ref.name || null, automationId: ref.automationId || null };
  }
  h._selection = { key, refKey, value: v };
  return v;
}

/** DID A CHANGE SINCE ITS GENERATION TOUCH THIS RESOLUTION? */
function touches(root, sel) {
  const words = [];
  if (sel.symbol && sel.symbol.name) words.push(sel.symbol.name);
  const el = sel.visual && sel.visual.element;
  if (sel.visual) for (const t of [sel.visual.selector, ...(el ? [el.id, ...(el.classes || [])] : [])]) if (t) words.push(String(t).replace(/^[.#]/, ''));
  return require('./evidencerefs').touched(root, { generation: sel.projectGeneration, deps: selectionFiles(sel), words }).touched;
}

/** Every project file a Selection's resolution read. */
function selectionFiles(sel) {
  if (!sel) return [];
  const out = [];
  if (sel.source && sel.source.file) out.push(sel.source.file);
  if (sel.symbol) { for (const d of sel.symbol.declarations || []) out.push(d.file); for (const f of sel.symbol.files || []) out.push(f.file); for (const f of sel.symbol.strings || []) out.push(f.file); }
  if (sel.visual) {
    if (sel.visual.binding && sel.visual.binding.file) out.push(sel.visual.binding.file);
    for (const c of (sel.visual.component && sel.visual.component.candidates) || []) if (c.rel) out.push(c.rel);
  }
  return [...new Set(out)];
}

/** How the canonical Selection was served: from cache, carried forward, or resolved. */
function selectionStats(session) { const h = session && session._harness; return h && h._selStats ? { ...h._selStats } : { hits: 0, carried: 0, resolved: 0 }; }

module.exports = { of, surface, fromIde, workshopSelect, workshopPicked, measureWorkshop, measureFrom, framePicked, select, noteSourceEdit, referent, selection, selectionFiles, selectionStats, symbolSites, resolveSymbol, _reset, SURFACES, FRESH_MS };
