'use strict';

/** THE FOCUSED CONTEXT PACKET — the neighbourhood of a change, not the repository. */

const fs = require('fs');
const path = require('path');

const MAX_RELEVANT = 12;
const MAX_LINES_SHOWN = 36;
const RESEARCH_DEADLINE_MS = 6000;
const GEOMETRY_RE = /\b(move|shift|nudge|lower|higher|raise|up|down|left|right|bigger|smaller|wider|narrower|taller|shorter|align|center|centre|spacing|padding|margin|gap|position|resize|size)\b/i;
const QUESTION_RE = /^\s*(what|why|how|where|which|who|when|does|do|is|are|can|could|should|explain|describe|tell me)\b|\?\s*$/i;
const TEST_FILE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\./i;

function ranges(lines) {
  const u = [...new Set(lines)].sort((a, b) => a - b);
  const out = [];
  for (const n of u) {
    const last = out[out.length - 1];
    if (last && n <= last[1] + 1) last[1] = n; else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/** The numeric geometry in the rule the GUG bound the element to — read from the binding, not guessed. */
function ruleValues(root, binding) {
  if (!binding || !binding.file) return [];
  let text = '';
  try { text = fs.readFileSync(path.join(root, binding.file), 'utf8'); } catch { return []; }
  const lines = text.split('\n');
  const start = Math.max(0, (Number(binding.line) || 1) - 1);
  const out = [];
  for (let k = start; k < Math.min(lines.length, start + 16); k++) {
    if (/\b(top|bottom|left|right|margin|padding|gap|height|width|transform|translate|inset)\b[^;]*\d/.test(lines[k])) out.push(`${k + 1}: ${lines[k].trim()}`);
    if (k > start && lines[k].includes('}')) break;
  }
  return out.slice(0, 6);
}

function within(p, ms, fallback) {
  let t;
  return Promise.race([Promise.resolve(p).then((v) => { clearTimeout(t); return v; }, () => { clearTimeout(t); return fallback; }),
    new Promise((res) => { t = setTimeout(() => res(fallback), ms); })]);
}

/** WHAT KIND OF WORK this is, from the parsed request and the Selection — never from a model. */
function kindOf(task, sel, op, { role = 'agent' } = {}) {
  const name = (op && op.from) || (sel && sel.symbol && sel.symbol.name) || null;
  if (name && op && op.op === 'rename' && op.to) return 'rename';
  if (sel && sel.kind === 'visual' && GEOMETRY_RE.test(String(task))) return 'geometry';
  if (!sel && GEOMETRY_RE.test(String(task)) && !name) return 'geometry';
  if (sel && (role === 'bot' || QUESTION_RE.test(String(task)))) return 'explain';
  if (sel && sel.symbol) return 'symbol-edit';
  if (sel && sel.source) return 'file';
  return 'task';
}

/** IS THE SELECTION STILL "THIS"? */
const DEICTIC = /\b(this|that|these|those|it|its|here|selected|selection|highlighted)\b/i;
function pointsAt(task, sel, session = null) {
  if (!sel) return null;
  const t = String(task || '');
  if (!t.trim() || DEICTIC.test(t)) return sel;
  const used = session && session._selConsumed;
  const where = sel.source ? sel.source.file : (sel.visual && sel.visual.gugId) || null;
  if (!(used && used.madeAt === (sel.madeAt || null) && used.where === where)) return sel;
  const name = sel.symbol && sel.symbol.name;
  if (name && new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`).test(t)) return sel;
  if (sel.visual && sel.visual.label && t.toLowerCase().includes(String(sel.visual.label).toLowerCase())) return sel;
  return null;
}

/** The funnel shape for a kind; null keeps the whole registry. */
function shapeOf(kind) { return ({ rename: 'rename', geometry: 'geometry', explain: 'explain', 'symbol-edit': 'symbol-edit' })[kind] || null; }

// ---- the research: independent deterministic lookups, in parallel ---------------------

/** The picked element's neighbourhood: owner, parent, rule values, GUG slice. */
function visualNeighbourhood(app, root, sel) {
  const v = sel && sel.visual;
  if (!v) return null;
  const gug = require('./gug');
  const g = gug.get(app, root);
  const node = g && v.gugId ? g.nodes.get(v.gugId) : null;
  const parent = node && node.parent && g ? g.nodes.get(node.parent) : null;
  const comp = v.component && v.component.candidates && v.component.candidates[0] ? v.component.candidates[0] : null;
  const slice = g && v.gugId ? gug.slice(g, v.gugId, { maxChars: 700 }) : { found: false, text: '' };
  return {
    gugHit: Boolean(node) && !(g.stale && g.stale[node.id]),
    gugStale: Boolean(node && g.stale && g.stale[node.id]),
    label: v.label || (node && (node.name || node.tag)) || v.selector || null,
    // WHEN THE EVIDENCE DOES NOT DECIDE (MULTIPLE), the other candidates are named too.
    component: comp ? { file: comp.rel, confidence: v.component.confidence, evidence: (comp.hits || []).slice(0, 2).map((h) => `${h.kind} "${h.token}" line ${h.line}`),
      also: v.component.confidence === 'EXACT' ? [] : v.component.candidates.slice(1, 4).map((c) => c.rel) } : null,
    parent: parent ? { id: parent.id, label: parent.name || parent.tag || parent.id } : null,
    style: v.binding && v.binding.file ? v.binding : null,
    values: v.binding && v.binding.file ? ruleValues(root, v.binding) : [],
    slice: slice.found ? slice.text : '',
  };
}

/** The files git says changed, restricted to the ones in play. */
async function gitChanged(root, files) {
  try {
    const m = await require('./gitsense').numstat(root);
    const want = new Set(files);
    return [...m.entries()].filter(([f]) => want.has(f)).map(([file, s]) => ({ file, added: s.added, removed: s.removed }));
  } catch { return []; }
}

/** DO THE RESEARCH (or reuse the artifact). */
async function research(app, session, { task = '', useSelection = true, role = 'agent', deadlineMs = RESEARCH_DEADLINE_MS } = {}) {
  const root = session.cwd;
  const hc = require('./harnesscontext');
  const pi = require('./projectindex');
  const ev = require('./evidencerefs');
  const t0 = Date.now();
  // THE PROJECT INDEX: the graph LAIN already keeps, re-used when unchanged.
  let idx = { files: {} };
  let scan = { scanned: null, reused: null };
  try { const got = pi.fresh(root, { persist: false }); idx = got.index || idx; scan = { scanned: got.scanned, reused: got.reused }; } catch { /* no index */ }
  const projectFiles = Object.keys(idx.files || {}).length;
  const before = hc.selectionStats(session);
  const sel = useSelection ? pointsAt(task, hc.selection(app, session), session) : null;
  const after = hc.selectionStats(session);
  const served = !sel ? 'none' : after.resolved > before.resolved ? 'resolved' : after.carried > before.carried ? 'carried' : 'hit';
  const op = require('./selectionjob').parse(task);
  const kind = kindOf(task, sel, op, { role });
  const to = op && op.op === 'rename' ? op.to : null;
  const r = { sel, op, kind, to, projectFiles, scan, served, facts: null, visual: null, git: [], edits: [], diagnostics: [], relevant: [], candidates: [], evidence: {}, lsp: null, ms: 0 };

  // A NAME THE REQUEST GIVES WITHOUT A SELECTION is resolved by the same owners.
  let sym = sel && sel.symbol ? sel.symbol : null;
  const named = (op && op.from) || null;
  if (named && (!sym || sym.name !== named)) {
    let decls = [];
    try { decls = pi.definitionsOf(idx, named).slice(0, 4).map((d) => ({ file: d.file, line: d.line })); } catch { decls = []; }
    sym = { name: named, declarations: decls, ...hc.symbolSites(root, named) };
  }
  r.sym = sym;

  // ---- in parallel: the language server, the UI graph, git ----
  const factsP = sel && sel.source && sym && sel.symbol && sel.symbol.name === sym.name
    ? within(require('./langfacts').forSelection(app, session, sel, { deadlineMs }), deadlineMs + 500, null)
    : Promise.resolve(null);
  const visualP = Promise.resolve().then(() => (sel && sel.kind === 'visual' ? visualNeighbourhood(app, root, sel) : null));
  const [facts, visual] = await Promise.all([factsP, visualP]);
  r.facts = facts;
  r.visual = visual;

  // ---- structural narrowing: the candidate set, then what is sent ----
  if (facts && facts.via === 'lsp') {
    const lf = require('./langfacts');
    r.candidates = lf.relevantFiles(facts, sel);
    r.lsp = { via: 'lsp', server: facts.server, ops: facts.ops, requests: Object.values(facts.ops).filter((o) => !o.cached).length, cached: Object.values(facts.ops).filter((o) => o.cached).length };
    Object.assign(r.evidence, Object.fromEntries(Object.entries(facts.evidence).map(([k, v]) => [`lsp.${k}`, v])));
  } else if (sym) {
    const decl = new Set((sym.declarations || []).map((d) => d.file));
    const front = sel && sel.source ? sel.source.file : null;
    const rank = (f) => (decl.has(f.file) ? 0 : f.file === front ? 1 : TEST_FILE.test(f.file) ? 3 : 2);
    r.candidates = (sym.files || []).slice().sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file)).map((f) => f.file);
    r.lsp = facts ? { via: facts.via, why: facts.why || '', requests: 0, cached: 0 } : { via: 'none', requests: 0, cached: 0 };
  } else if (sel && sel.source && sel.source.file) {
    const file = sel.source.file;
    let importers = [];
    try { importers = pi.importersOf(idx, file); } catch { importers = []; }
    r.candidates = [file, ...importers].filter((v, i, a) => a.indexOf(v) === i);
  }
  if (visual) {
    r.candidates = [...new Set([visual.style && visual.style.file, visual.component && visual.component.file, ...r.candidates].filter(Boolean))];
    if (visual.slice) {
      const e = ev.put(session, { kind: 'gug.slice', key: `gug.slice:${sel.id}`, source: 'GUG', summary: `${visual.label || 'selected element'}${visual.parent ? ` in ${visual.parent.label}` : ''} → ${visual.style ? `${visual.style.file}:${visual.style.line} ${visual.style.selector || ''}` : 'no style owner'}`, content: visual.slice, deps: [visual.style && visual.style.file, visual.component && visual.component.file].filter(Boolean), words: [] });
      if (e) r.evidence['gug.slice'] = e.id;
    }
  }
  r.relevant = r.candidates.slice(0, MAX_RELEVANT);

  // ---- then what depends on the narrowed set: provenance, diagnostics, git ----
  const provFiles = r.relevant.length ? r.relevant : (sel && sel.source && sel.source.file ? [sel.source.file] : []);
  try { r.edits = require('./editledger').recentUserEdits(root, provFiles); } catch { r.edits = []; }
  r.git = await within(gitChanged(root, r.relevant), 2500, []);
  if (r.git.length) {
    const e = ev.put(session, { kind: 'git.diff', source: 'git numstat', summary: `${r.git.length} relevant file(s) differ from HEAD: ${r.git.map((g) => `${g.file} +${g.added} −${g.removed}`).join(', ')}`, content: r.git.map((g) => `${g.file} +${g.added} -${g.removed}`).join('\n'), deps: r.git.map((g) => g.file) });
    if (e) r.evidence['git.diff'] = e.id;
  }
  const want = new Set(r.relevant);
  const editorDiags = ((session._ide && session._ide.diagnostics) || []).filter((d) => want.has(d.path));
  r.diagnostics = [...(facts && facts.diagnostics ? facts.diagnostics : []), ...editorDiags.map((d) => ({ ...d, source: d.source || 'editor' }))].filter((d) => d.severity === 'error' || d.severity === 'warning').slice(0, 20);
  r.ms = Date.now() - t0;
  return r;
}

// ---- rendering ---------------------------------------------------------------------

/** The neighbourhood (everything but the TASK line) — the cacheable part. */
function renderNeighbourhood(r, root) {
  const out = [];
  const { sel, sym, facts, visual, to } = r;
  if (sel && sel.source) out.push(`SELECTION ${sel.id} (project generation ${sel.projectGeneration})\n  ${sel.source.file}:${sel.source.startLine}-${sel.source.endLine}`);
  else if (sel && sel.visual) out.push(`SELECTION ${sel.id} (project generation ${sel.projectGeneration})\n  ${sel.visual.gugId ? `UI node ${sel.visual.gugId}` : sel.visual.selector || sel.visual.name || sel.kind}${sel.visual.binding && sel.visual.binding.file ? ` → ${sel.visual.binding.file}:${sel.visual.binding.line || '?'}` : ''}`);
  const constraints = [];
  if (sym) {
    if (facts && facts.via === 'lsp') {
      const lf = require('./langfacts');
      const files = lf.byFile(facts.references);
      out.push(`SYMBOL (language server ${facts.server})\n  ${sym.name}${to ? ` → ${to}` : ''}${facts.definition.length ? `\n  defined: ${facts.definition.map((d) => `${d.path}:${d.line}`).join(', ')}` : ''}${facts.type ? `\n  type: ${facts.type.replace(/\x60{3}\w*\n?/g, '').replace(/\s+/g, ' ').slice(0, 200)}` : ''}${facts.implementations.length ? `\n  implementations: ${facts.implementations.slice(0, 6).map((d) => `${d.path}:${d.line}`).join(', ')}` : ''}`);
      out.push(`REFERENCES (language server: ${facts.references.length} in ${files.length} file(s)${files.length > MAX_RELEVANT ? `; first ${MAX_RELEVANT} shown` : ''}${r.evidence['lsp.references'] ? ` — evidence:${r.evidence['lsp.references']}` : ''})\n${files.slice(0, MAX_RELEVANT).map((f) => `  ${f.file} — lines ${ranges(f.lines.slice(0, MAX_LINES_SHOWN))}`).join('\n') || '  none'}`);
      if (facts.rename) out.push(`RENAME\n  ${facts.rename.renameable ? `the language server can rename it${facts.rename.prepared ? ` (prepareRename: ${facts.rename.placeholder || sym.name})` : ''} — rename_symbol uses it` : 'the language server says it cannot be renamed'}`);
    } else {
      out.push(`SYMBOL (project index${facts && facts.why ? ` — no language server: ${facts.why}` : ''})\n  ${sym.name}${to ? ` → ${to}` : ''}${sym.declarations && sym.declarations.length ? `\n  declared: ${sym.declarations.map((d) => `${d.file}:${d.line || '?'}`).join(', ')}` : '\n  declared: not found in the project index (may be a local, a parameter or outside the project)'}`);
      const files = (sym.files || []).filter((f) => r.relevant.includes(f.file));
      out.push(`RELEVANT (${(sym.files || []).length} file(s) reference ${sym.name}${(sym.files || []).length > MAX_RELEVANT ? `; first ${MAX_RELEVANT} shown` : ''})\n${files.map((f) => `  ${f.file} — lines ${ranges(f.lines.slice(0, MAX_LINES_SHOWN))} (${Object.entries(f.kinds || {}).map(([k, v]) => `${v} ${k}`).join(', ')})`).join('\n') || '  none outside the selection'}`);
    }
    if ((sym.strings || []).length) out.push(`STRINGS AND COMMENTS containing "${sym.name}" (not identifiers — decide each on purpose)\n${sym.strings.slice(0, 10).map((s) => `  ${s.file} — lines ${ranges(s.lines)}`).join('\n')}`);
    if (r.kind === 'rename') {
      constraints.push(`rename the SYMBOL ${sym.name} → ${to} with rename_symbol${facts && facts.via === 'lsp' ? ` (the language server renames declaration, references and imports${sel && sel.source ? `; it is the selection at ${sel.source.file}:${sel.source.startLine}` : ''})` : ' (run it with dry_run first)'} — not with text replacement`);
      if ((sym.wire || []).length) constraints.push(`preserve serialized/wire names ${[...new Set(sym.wire.map((w) => `"${w.name}"`))].join(', ')} (found in ${[...new Set(sym.wire.map((w) => w.file))].slice(0, 4).join(', ')}) unless the person asked to change the protocol`);
      if ((sym.strings || []).length) constraints.push(`the name also appears inside strings/comments in ${sym.strings.length} file(s): update comments that describe the symbol; leave strings that are data or protocol`);
    }
  } else if (sel && sel.source && sel.source.file && r.relevant.length) {
    out.push(`RELEVANT (the selected file and what imports it)\n${r.relevant.map((f) => `  ${f}${f === sel.source.file ? ' (selected)' : ' (imports it)'}`).join('\n')}`);
  }
  if (visual) {
    const lines = [`  selected: ${visual.label || 'element'}${visual.parent ? ` (inside ${visual.parent.label})` : ''}`];
    if (visual.component) lines.push(`  component: ${visual.component.file} (${visual.component.confidence}${visual.component.evidence.length ? `: ${visual.component.evidence.join('; ')}` : ''})${visual.component.also && visual.component.also.length ? ` — also matched: ${visual.component.also.join(', ')}` : ''}`);
    if (visual.style) lines.push(`  style owner: ${visual.style.file}:${visual.style.line || '?'} ${visual.style.selector || ''} (binding ${visual.style.confidence || 'unknown'})`);
    if (visual.values.length) lines.push(`  current geometry:\n    ${visual.values.join('\n    ')}`);
    if (visual.gugStale) lines.push('  (the UI graph is STALE for this node: its source changed since the last measurement)');
    out.push(`VISUAL TARGET${r.evidence['gug.slice'] ? ` — UI graph slice evidence:${r.evidence['gug.slice']}` : ''}\n${lines.join('\n')}`);
  }
  if (r.kind === 'geometry') {
    if (visual && visual.style) constraints.push('change the owning rule, starting from its current value; when the amount was not stated ("a little"), make one small step and say the exact value so the person can refine it');
    else constraints.push('no visual element with a source binding is selected (pick it in the preview): find the layout owner before changing numbers, and say the exact value chosen');
  }
  if (r.diagnostics.length) out.push(`DIAGNOSTICS in these files\n${r.diagnostics.slice(0, 10).map((d) => `  ${String(d.severity).toUpperCase()} ${d.path}:${d.line}:${d.col} ${d.message}${d.source ? ` [${d.source}]` : ''}`).join('\n')}`);
  if (r.git.length) out.push(`UNCOMMITTED CHANGES in these files (git)${r.evidence['git.diff'] ? ` — evidence:${r.evidence['git.diff']}` : ''}\n${r.git.map((g) => `  ${g.file} +${g.added} −${g.removed}`).join('\n')}`);
  if (r.edits.length) {
    out.push(`PROVENANCE (who wrote these lines)\n${r.edits.slice(0, 12).map((e) => `  the person edited ${e.path} lines ${e.startLine}-${e.endLine} by hand ${Math.max(1, Math.round((Date.now() - e.at) / 60000))} min ago${e.approximate ? ' (line numbers approximate: the file changed outside LAIN since)' : ''}`).join('\n')}`);
    constraints.push('preserve the person\'s recent manual edits listed under PROVENANCE unless the task requires changing those lines — and say so if it does');
  }
  if (constraints.length) out.push(`CONSTRAINTS\n${constraints.map((c) => `  - ${c}`).join('\n')}`);
  return out.join('\n\n');
}

function header() { return '# Focused context (assembled by LAIN from the language server, the UI graph, the project index and the provenance ledger — not the person\'s words)'; }
function footer() { return 'This is a starting map, not a limit: read what you need (ranged reads, the evidence ids above via recall_evidence), but do not re-survey the whole project.'; }

/** BUILD ONE PACKET: the artifact for this Selection and kind if it is still valid, otherwise research and render (and keep the artifact). */
async function build(app, session, { task = '', useSelection = true, role = 'agent' } = {}) {
  const root = session && session.cwd;
  if (!root) return null;
  const t0 = Date.now();
  const ev = require('./evidencerefs');
  const hc = require('./harnesscontext');
  const sel0 = useSelection ? pointsAt(task, hc.selection(app, session), session) : null;
  const op0 = require('./selectionjob').parse(task);
  const kind0 = kindOf(task, sel0, op0, { role });
  const artifactKey = sel0 ? `focus:${sel0.id}:${kind0}:${(op0 && op0.to) || ''}` : null;
  let hit = artifactKey ? ev.lookup(session, artifactKey) : { entry: null, state: 'missing' };
  let r = null;
  let body;
  if (hit.entry && hit.state !== 'stale') {
    body = hit.entry.content;
  } else {
    r = await research(app, session, { task, useSelection, role });
    body = renderNeighbourhood(r, root);
    if (artifactKey) {
      const deps = [...new Set([...r.candidates, ...(r.sel ? hc.selectionFiles(r.sel) : [])])];
      const words = r.sym ? [r.sym.name] : [];
      ev.put(session, { kind: 'focus.artifact', key: artifactKey, source: 'focuspacket', summary: `focus neighbourhood for ${sel0.id} (${kind0}): ${r.relevant.length} file(s)`, content: body, deps, words, data: { relevant: r.relevant, candidates: r.candidates.length, projectFiles: r.projectFiles, evidence: r.evidence } });
    }
  }
  const text = [header(), `TASK\n  ${String(task).replace(/\s+/g, ' ').slice(0, 400)}`, body, footer()].filter(Boolean).join('\n\n');
  const data = r ? { relevant: r.relevant, candidates: r.candidates.length, projectFiles: r.projectFiles, evidence: r.evidence } : (hit.entry.data || { relevant: [], candidates: 0, projectFiles: 0, evidence: {} });
  let generation = null;
  try { generation = require('./projectgen').current(root).n; } catch { generation = null; }
  const metrics = {
    at: Date.now(), ms: Date.now() - t0, sessionId: session.id || null, kind: kind0,
    projectFiles: data.projectFiles, candidateFiles: data.candidates, filesSelected: data.relevant.length,
    symbolsSelected: r ? (r.sym ? 1 + ((r.facts && r.facts.definition.length) || (r.sym.declarations || []).length) : 0) : null,
    selection: sel0 ? { id: sel0.id, served: r ? r.served : 'hit', projectGeneration: sel0.projectGeneration } : null,
    lsp: r ? r.lsp : { via: 'artifact', requests: 0, cached: null },
    gug: r && r.visual ? { hit: r.visual.gugHit, stale: r.visual.gugStale } : null,
    projectGraph: r ? { reused: r.scan.reused, scanned: r.scan.scanned } : { reused: true, scanned: 0 },
    artifact: artifactKey ? { key: artifactKey, state: hit.entry && hit.state !== 'stale' ? hit.state : (hit.state === 'stale' ? 'rebuilt-stale' : 'built'), why: hit.why || '' } : null,
    evidence: data.evidence, researchMs: r ? r.ms : 0,
    chars: text.length, approxTokens: Math.round(text.length / 4),
    fullReadsAvoided: Math.max(0, (data.projectFiles || 0) - data.relevant.length),
    projectGeneration: generation, fromCanonicalSelection: Boolean(sel0),
    funnel: shapeOf(kind0),
  };
  return { text, metrics, relevant: data.relevant, kind: kind0, intent: { symbol: r && r.sym ? r.sym.name : null, to: op0 && op0.op === 'rename' ? op0.to : null, rename: kind0 === 'rename', geometry: kind0 === 'geometry' } };
}

/** Counts only, machine-local — the evidence that /focus sends less. */
function logMetrics(m) {
  try {
    const dir = path.join(require('./config').configDir(), 'metrics');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'focus.jsonl');
    try { if (fs.statSync(f).size > 1_000_000) fs.writeFileSync(f, ''); } catch { /* new */ }
    const { sessionId, ...rest } = m;
    fs.appendFileSync(f, `${JSON.stringify(rest)}\n`);
  } catch { /* metrics never cost a turn */ }
}

/** FOR A TURN IN THE IDE: build once, keep it on the session for the turn's prompt, open the turn's tool funnel, record the counts. */
async function prepare(app, task, { useSelection = true, role = 'agent', funnel = true } = {}) {
  const s = app.session;
  s._focusPacket = null;
  let attached = false;
  try { const p = require('./sessionviews').project(s); attached = p.attached && !p.missing; } catch { attached = false; }
  if (!attached) return null;
  let pk = null;
  try { pk = await build(app, s, { task, useSelection, role }); } catch { pk = null; }
  if (!pk) return null;
  // THE BOT gets it only for a question about the Selection (explain): the
  // language server's answer instead of a search.
  if (role !== 'bot' || pk.kind === 'explain') s._focusPacket = { text: pk.text, at: Date.now(), role };
  if (funnel) require('./toolfunnel').open(s, shapeOf(pk.kind), { why: `focus ${pk.kind}` });
  pk.metrics.role = role;
  if (role === 'agent') { try { pk.metrics.plan = seedPlan(s, pk); } catch { /* the plan is a projection; the turn runs without it */ } }
  s._focusTurn = { metrics: pk.metrics, t0: Date.now(), msgsBefore: (s.messages || []).length };
  // THIS TURN ACTED ON THE SELECTION: a later turn treats it as "this" only when pointed at (pointsAt).
  if (pk.metrics.selection) { try { const cur = require('./harnesscontext').selection(app, s); if (cur && cur.id === pk.metrics.selection.id) s._selConsumed = { id: cur.id, madeAt: cur.madeAt || null, where: cur.source ? cur.source.file : (cur.visual && cur.visual.gugId) || null }; } catch { /* context only */ } }
  s._focusMetrics = [...(s._focusMetrics || []), pk.metrics].slice(-20);
  return pk;
}

/** A LIVE EXECUTION PLAN, NOT A GATE. */
function seedPlan(session, pk) {
  if (!['rename', 'geometry'].includes(pk.kind)) return null;
  // A PLAN SOMEBODY WROTE (the model, the person, a steer) is the work in hand
  // and is kept; one Core seeded for an earlier focus turn is replaced.
  if (session.plan && session.plan.isLive && session.plan.remaining.length && session.plan.steps.some((s) => s.origin !== 'core')) return { seeded: false, why: 'a live plan is already in hand' };
  const m = pk.metrics;
  const sel = m.selection ? m.selection.id : 'the selection';
  let steps;
  let done;
  if (pk.kind === 'rename') {
    const via = m.lsp && m.lsp.via === 'lsp' ? `language server ${m.lsp.server}` : 'project index';
    done = [[`Resolve the symbol (${sel}, ${via})`, `${pk.intent.symbol}`], [`Inspect dependents (${m.candidateFiles} file(s) reference it)`, `${m.filesSelected} file(s) in the focus packet`]];
    steps = [`Rename ${pk.intent.symbol} → ${pk.intent.to} with rename_symbol`, 'Update comments that describe it; keep wire/protocol strings', 'Verify: diagnostics and the tests'];
  } else {
    done = [[`Resolve the picked element (${sel}) to its style owner`, (pk.relevant || [])[0] || 'owner not bound']];
    steps = ['Change the owning rule by one small step', 'Verify the change (and say the exact value)'];
  }
  require('./plan').seedFromCore(session, { objective: (session.task && session.task.objective) || pk.metrics.kind, done, remaining: steps });
  return { seeded: true, done: done.length, remaining: steps.length };
}

/** AFTER THE TURN: what the model actually did with the packet — its requests (reqtrace, by session, sizes only), the tools it was shown and called, and… */
function afterTurn(app) {
  const s = app && app.session;
  const ft = s && s._focusTurn;
  if (!ft) { try { require('./toolfunnel').close(s); } catch { /* none */ } return null; }
  s._focusTurn = null;
  const m = ft.metrics;
  try {
    const reqs = require('./reqtrace').forSession(s.id).filter((r) => (r.at || 0) >= ft.t0);
    m.modelRequests = reqs.length;
    m.requestChars = reqs.reduce((n, r) => n + (r.messageChars || 0), 0);
    m.toolSchemaChars = reqs.reduce((n, r) => n + (r.toolSchemaChars || 0), 0);
    m.inputTokens = reqs.reduce((n, r) => n + ((r.receipt && r.receipt.inputTokens) || 0), 0) || null;
  } catch { /* measurement only */ }
  const calls = [];
  for (const msg of (s.messages || []).slice(ft.msgsBefore)) for (const c of msg.tool_calls || []) calls.push(c);
  const byName = {};
  let fullReads = 0;
  let searches = 0;
  for (const c of calls) {
    const name = (c.function && c.function.name) || c.name || '?';
    byName[name] = (byName[name] || 0) + 1;
    let args = {};
    try { args = typeof (c.function && c.function.arguments) === 'string' ? JSON.parse(c.function.arguments) : (c.input || {}); } catch { args = {}; }
    if (name === 'read_file' && args.offset == null && args.limit == null && args.start_line == null && args.line == null) fullReads += 1;
    if (['grep', 'glob', 'locate', 'understand', 'list_dir'].includes(name)) searches += 1;
  }
  m.toolCalls = byName;
  m.fullFileReads = fullReads;
  m.searches = searches;
  try { const all = require('./tools').names(app); m.funnel = require('./toolfunnel').view(s, all); } catch { /* measurement only */ }
  try { require('./toolfunnel').close(s); } catch { /* none */ }
  logMetrics(m);
  return m;
}

/** The prompt section for the running Agent turn, or ''. */
function section(session) {
  const p = session && session._focusPacket;
  return p && session._role && (session._role === 'agent' || p.role === session._role) ? p.text : '';
}

module.exports = { build, research, renderNeighbourhood, prepare, afterTurn, section, ruleValues, kindOf, shapeOf, pointsAt, MAX_RELEVANT };
