'use strict';

/**
 * THE HARNESS CONTEXT — what the person is looking at, touching and pointing
 * to, as CORE-OWNED STATE (2026-09-24).
 *
 *     LAIN HARNESS (IDE · Chat · Workshop · Browser · Computer · Bot)
 *          │ live events: selection, surface, manual edits, navigation
 *          ▼
 *     THIS FILE — the current state, its generations, a recent-actions ledger
 *          │ bounded facts                      │ background jobs (SHADOW)
 *          ▼                                    ▼
 *     CONTEXT_PACKET (Core's, in the volatile   Laya (layacontext.js): context
 *     tail of a request)                        hypotheses, VALIDATED here
 *
 * WHAT IT IS NOT. Not project truth: git, the fingerprints and the AST stay
 * authoritative for what the files say; the ledger below is situational
 * awareness ("the person just renamed webButton"), never history. Not a
 * transcript: nothing here is written into the conversation or the session
 * file. Not the flagship's by default: `packet` is a SMALL, CANONICAL block —
 * the same state renders the same bytes — and only when there is something to
 * say; a terminal turn with no Harness state gets nothing.
 *
 * OWNERS IT READS, never re-derives: idecontext.js (the editor's report),
 * journey.js (the path through the house), gug.js (visual nodes), locate.js
 * (the AST side of a selected identifier), observationstore.js (receipts).
 */

const path = require('path');
const canonical = require('./canonical');

const SURFACES = Object.freeze(['IDE', 'CHAT', 'WORKSHOP', 'BROWSER', 'COMPUTER', 'BOT', 'TERMINAL']);
/** A selection older than this describes a screen the person has left. */
const FRESH_MS = 30 * 60 * 1000;
const MAX_ACTIONS = 40;
const SHOW_ACTIONS = 6;
const MAX_DELTA_FILES = 20;
/** The packet's own ceiling — measured packets run 300–1,400 chars; see cachebudget.js for the tail budget. */
const PACKET_CHARS = 2400;


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

/**
 * THE PROJECT GENERATION is Core's, shared by every process on the project:
 * projectgen.js. This module advances it (noteSourceEdit, below) and keys the
 * canonical Selection by it; it does not keep a count of its own.
 */
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

function background(app, session, type) {
  try { require('./layacontext').enqueue(app, session, { type }); } catch { /* background only: never affects the caller */ }
}

// ---- recording ---------------------------------------------------------------

/** The surface the person is on. Only a change is recorded as an action. */
function surface(app, session, name) {
  const h = of(session);
  const s = String(name || '').toUpperCase();
  if (!h || !SURFACES.includes(s)) return null;
  if (h.surface && h.surface !== s) action(h, 'surface', `switched ${h.surface} → ${s}`);
  h.surface = s;
  if (touch(h)) background(app, session, 'surface');
  return h;
}

/**
 * THE EDITOR'S REPORT (POST /api/ide/context, after idecontext.record): file,
 * tabs, selection, dirty buffers. The selection's TEXT stays idecontext's; this
 * keeps the range and a short head for the referent.
 */
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
  if (touch(h)) background(app, session, 'selection');
  return h;
}

/**
 * A WORKSHOP SELECTION: the element the person clicked, and the GUG node it
 * is (by selector — gug.nodeFor). Core now knows what "this" is, where it is,
 * how it relates and which source sizes it.
 */
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
  if (touch(h)) background(app, session, 'selection');
  return h.visualSelection;
}

/**
 * MEASURE THE WORKSHOP PAGE INTO THE GUG: one bounded evaluate (inspect.js
 * gugExpr), nodes and relations built deterministically, bound to the
 * project's stylesheets, kept per project. Returns the graph and — when a
 * previous measurement exists — its visual impact (the reverse mapping).
 */
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

/**
 * THE SAME MEASUREMENT, TAKEN BY THE FRAME PREVIEW'S BRIDGE (workshop/bridge.js):
 * the page measured itself with the Workshop's own gugExpr and posted it. Built
 * into the GUG exactly as a CDP measurement is — one graph, one binding.
 */
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

/**
 * THE PERSON PICKED AN ELEMENT IN THE WORKSHOP: measure (or reuse a graph that
 * is not stale), map the pick to its GUG node, record it as the selection.
 * The Workshop then speaks in a semantic id, not a screenshot.
 */
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
  if (touch(h)) background(app, session, 'selection');
  return v;
}

/**
 * A SOURCE EDIT. Advances the project generation with the file, marks the GUG
 * nodes that file sizes as STALE (the reverse mapping), and records who did it.
 * Two callers only (guarded by oneauthority.test.js): mutation.consequences,
 * for every change through the one transaction whatever its actor, and
 * source.freshness, for a change made OUTSIDE LAIN that it observed.
 */
function noteSourceEdit(app, session, { file, by = 'user', what = '' } = {}) {
  if (!file) return null;
  const root = (session && session.cwd) || process.cwd();
  const rel = path.isAbsolute(String(file)) ? path.relative(root, String(file)).replace(/\\/g, '/') : String(file).replace(/\\/g, '/');
  const n = projectgen.advance(root, { file: rel, by });
  let affected = [];
  try { affected = require('./gug').sourceEdited(app, root, rel); } catch { affected = []; }
  const h = of(session);
  if (h) {
    if (by === 'user') action(h, 'edit', `${what ? `${what} — ` : ''}manually edited ${rel}`, { file: rel });
    else action(h, 'edit', `${by} edited ${rel}${what ? ` (${what})` : ''}`, { file: rel });
    if (by === 'user') try { require('./journey').note(session, 'user.edit', { file: rel }); } catch { /* the path is a courtesy */ }
    if (touch(h)) background(app, session, 'edit');
  }
  return { generation: n, file: rel, gugAffected: affected };
}

// ---- reading -----------------------------------------------------------------

function fresh(x) { return x && x.at && Date.now() - x.at <= FRESH_MS; }

/**
 * WHAT "THIS" IS, if the person pointed at something: the most recent fresh
 * selection. `explicit` — the Harness recorded the selection itself; nothing
 * was inferred. Cheap: read on every input by dispatch.assign.
 */
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

/**
 * THE AST SIDE OF A TEXT SELECTION: a selected identifier resolved to its
 * declaration(s) by locate.js. Not on the dispatch path — asked for the packet
 * and for a deterministic edit only.
 */
function resolveSymbol(root, ref) {
  if (!ref || ref.kind !== 'text') return null;
  const name = String(ref.head || '').trim();
  if (!IDENT.test(name)) return { name: null, why: 'the selection is not a single identifier' };
  try {
    const { defs, refs } = require('./locate').sweep(root, name);
    return { name, defs: defs.slice(0, 4).map((d) => ({ file: d.file, line: d.line })), refs, declaredInSelection: defs.some((d) => d.file === ref.file && d.line >= ref.startLine && d.line <= ref.endLine) };
  } catch { return { name, defs: [], refs: 0 }; }
}

// ---- THE CANONICAL SELECTION ---------------------------------------------------------
//
// RESOLVE ONCE, CONSUME MANY TIMES (2026-09-25). "What did the person select,
// and what does it belong to?" used to be answered three times per request —
// here for the packet, again by the focused context packet with its own scan,
// and a third time as raw selected text in the IDE section — three slightly
// different versions of "this" in one prompt. Now it is answered here, once per
// (selection, project generation), and every consumer reads this object:
// the packet, focuspacket.js (the Agent), selectionjob.js, layacontext.js.
//
//   source      file, lines, and the selected text (bounded)
//   visual      the GUG node and its binding, for a Workshop pick
//   symbol      a selected identifier: declarations (locate.js), and where it
//               occurs by file — identifier sites vs string/comment sites
//               (rename.js tokens for JS/TS, a line scan elsewhere) — and its
//               snake/kebab wire spellings found in strings
//   provenance  the person's recent hand-edits in the selected file
//   generations project (the one project generation) and selection

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

/**
 * THE SELECTION, resolved once per (referent, project generation). `null` when
 * the person has not pointed at anything. See the block comment above.
 */
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

/**
 * DID A CHANGE SINCE ITS GENERATION TOUCH THIS RESOLUTION? Its own files (the
 * selected file, the declarations, every file the symbol occurs in, the style
 * owner and the component candidates) — and, since a new reference can appear
 * anywhere, any changed file that now mentions the symbol or the element's
 * class / id at all. The rule is evidencerefs.touched, shared.
 */
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

/**
 * PROJECT_DELTA base → now: the files that changed since the generation the
 * stable prefix describes. Bounded; empty when nothing changed.
 */
function projectDelta(app, root) {
  const g = projectgen.current(root);
  if (g.n === g.base) return { base: g.base, now: g.n, files: [] };
  const files = [...new Set(g.changes.filter((c) => c.n > g.base).map((c) => `${c.file}${c.by !== 'user' ? '' : ' (by the person)'}`))];
  return { base: g.base, now: g.n, files: files.slice(-MAX_DELTA_FILES), more: Math.max(0, files.length - MAX_DELTA_FILES) };
}

/**
 * THE CONTEXT_PACKET — Core's, for the volatile tail of a flagship request.
 * Canonical: generations instead of clocks, sorted and bounded lists. Empty
 * when there is nothing situational to say. `laya` is a slice Core already
 * VALIDATED (layacontext.consumable), or nothing.
 */
function packet(app, session, { maxChars = PACKET_CHARS, gugChars = 900 } = {}) {
  const h = session && session._harness;
  const root = (session && session.cwd) || process.cwd();
  const delta = projectDelta(app, root);
  const ref = referent(app, session);
  const leftOut = Boolean(session && session._ideTurn && session._ideExclude && session._ideExclude.selection);
  const actions = h ? h.actions.filter((a) => a.kind === 'edit' || (a.kind === 'select' && !leftOut) || a.kind === 'surface').slice(-SHOW_ACTIONS) : [];
  let laya = '';
  try { laya = require('./layacontext').consumable(app, session); } catch { laya = ''; }
  // A PAUSED DEBUGGER, in one line: where. The state itself is asked for
  // (the debug.context door), never injected.
  let debugLine = '';
  try {
    const p = require('./dap/manager').pausedAt(app);
    if (p) debugLine = `debugger: paused (${p.reason}) in ${p.program} at ${p.path || '?'}:${p.line} — the debug.context door returns the frame, stack and variables`;
  } catch { debugLine = ''; }
  if (!ref && !delta.files.length && !actions.length && !laya && !debugLine && !(h && h.surface && h.surface !== 'TERMINAL')) return '';
  const out = ['# Harness context (Core)'];
  if (h && h.surface) out.push(`surface: ${h.surface}${h.activeFile ? ` · active file ${h.activeFile}` : ''}${h.dirty.length ? ` · unsaved: ${h.dirty.slice(0, 6).join(', ')}` : ''}`);
  if (ref) {
    const sel = selection(app, session);
    if (ref.kind === 'text' && !sel) {
      // left out of this turn by the person (a closed chip)
    } else if (ref.kind === 'text') {
      // THE CANONICAL SELECTION — resolved once per (selection, generation), shared with every consumer.
      const sym = sel && sel.symbol;
      const refs = sym ? sym.files.reduce((n, f) => n + f.lines.length, 0) : 0;
      out.push(`selection ${sel ? sel.id : ''}: ${ref.file || 'editor'} lines ${ref.startLine}-${ref.endLine}${sym ? ` · identifier ${sym.name}${sym.declarations.length ? ` declared at ${sym.declarations.map((d) => `${d.file}:${d.line}`).join(', ')}` : ' (no declaration found in this project)'} · ${refs} reference(s) in ${sym.files.length} file(s)` : ''}`);
      if (sel && sel.source && sel.source.text) out.push(`selected text:\n\`\`\`\n${sel.source.text.slice(0, 600)}\n\`\`\``);
    } else if (ref.kind === 'visual') {
      out.push(`selection: Workshop node ${ref.gugId || `(unmapped: ${ref.selector})`}${ref.gugGeneration ? ` · GUG generation ${ref.gugGeneration}` : ''}`);
      const g = require('./gug').get(app, root);
      if (g && ref.gugId) { const s = require('./gug').slice(g, ref.gugId, { maxChars: gugChars }); if (s.found) out.push(s.text); }
    } else out.push(`selection: ${ref.kind.toUpperCase()} ${ref.selector || ref.name || ref.automationId || ''}`.trim());
    out.push('"this" / "that" in the request refers to the selection above unless the request names something else.');
  }
  if (delta.files.length) out.push(`PROJECT_DELTA ${delta.base} → ${delta.now}: changed ${delta.files.join(', ')}${delta.more ? ` (+${delta.more} more)` : ''} — the project summary above describes generation ${delta.base}`);
  if (actions.length) out.push('recent user actions:', ...actions.map((a) => `- ${a.text}`));
  if (debugLine) out.push(debugLine);
  if (laya) out.push(laya);
  let text = out.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 70)}\n[… Harness context bounded at ${maxChars} chars by Core]`;
  return text;
}

/**
 * APPEND-ONLY, NOT RE-SENT. The packet is situational and changes rarely
 * between requests; riding the volatile tail it would be re-sent — uncached —
 * on every request of every turn (measured: ~1.2 KB per request with a GUG
 * slice). So a turn that finds a NEW packet (by canonical hash) records it
 * once, anchored before that turn's user message; contextfit.buildWire splices
 * it into the wire at that point, where every later request finds it in the
 * cached prefix. A later packet supersedes it (it says its generation).
 *
 * Not the transcript: kept on the session in memory, never saved, never in
 * the feed. An entry whose anchor message is gone (compaction rewrote history)
 * is dropped with it — the one moment the prefix changes anyway.
 */
const MAX_ANCHORED = 12;
function anchorPacket(app, session) {
  if (!session) return false;
  let text = packet(app, session);
  const log = session._ctxLog = Array.isArray(session._ctxLog) ? session._ctxLog : [];
  const last = log[log.length - 1];
  // A SELECTION THAT WENT AWAY is said once, so an older packet is not left standing as current.
  if (!text && last && /\nselection: /.test(last.text)) text = '# Harness context (Core)\nselection: none (the earlier selection is no longer current)';
  if (!text) return false;
  const gen = session._harness ? session._harness.generation : 0;
  const body = text.replace(/^# Harness context \(Core\)/, `# Harness context (Core) · generation ${gen} — supersedes any earlier Harness context`);
  const hash = canonical.hash(text);
  if (last && last.hash === hash) return false;
  log.push({ index: (session.messages || []).length, text: body, hash, anchor: null });
  if (log.length > MAX_ANCHORED) log.splice(0, log.length - MAX_ANCHORED);
  return true;
}

/**
 * THE WIRE WITH THE ANCHORED PACKETS SPLICED IN (contextfit.buildWire): each
 * before the message it was recorded for. `frame` is contextprovenance.frame.
 */
function spliceContext(session, list, frame) {
  const log = session && session._ctxLog;
  if (!Array.isArray(log) || !log.length) return list;
  const msgs = session.messages || [];
  for (const e of log) if (!e.anchor && msgs[e.index]) e.anchor = msgs[e.index];
  // Gone from the session (compaction replaced it): drop the entry with it.
  session._ctxLog = log.filter((e) => !e.anchor || msgs.includes(e.anchor));
  const by = new Map(session._ctxLog.filter((e) => e.anchor).map((e) => [e.anchor, e]));
  if (!by.size) return list;
  const out = [];
  for (const m of list) {
    const e = by.get(m);
    if (e) out.push({ role: 'user', content: frame(e.text), _ctx: 'harness' });
    out.push(m);
  }
  return out;
}

/** For `/api/state`, `/workers` and tests: the state without text bodies. */
function view(session) {
  const h = session && session._harness;
  if (!h) return null;
  return { generation: h.generation, surface: h.surface, activeFile: h.activeFile, textSelection: h.textSelection && { file: h.textSelection.file, startLine: h.textSelection.startLine, endLine: h.textSelection.endLine },
    visualSelection: h.visualSelection && { gugId: h.visualSelection.gugId, gugGeneration: h.visualSelection.gugGeneration }, dirty: h.dirty.length, actions: h.actions.length };
}

module.exports = { of, surface, fromIde, workshopSelect, workshopPicked, measureWorkshop, measureFrom, framePicked, select, noteSourceEdit, referent, selection, selectionFiles, selectionStats, symbolSites, resolveSymbol, projectDelta, packet, anchorPacket, spliceContext, view, _reset, SURFACES, FRESH_MS, PACKET_CHARS };
