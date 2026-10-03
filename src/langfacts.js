'use strict';

/** LANGUAGE FACTS FOR THE CANONICAL SELECTION — what the language server knows, asked once, kept as addressable evidence (2026-09-25). */

const fs = require('fs');
const path = require('path');

const DEADLINE_MS = 6000;
const MAX_LOCS = 60;
const OPS = ['definition', 'references', 'implementation', 'hover', 'symbols', 'prepareRename'];

function lsp() { return require('./lsp/manager'); }

/** Operations a server said it does not provide — not asked again (server id -> Set). */
const unsupportedBy = new Map();

/** The 1-based column of `name` on `line` of `file` — the editor's column when it gave one. */
function columnOf(root, file, line, name, col = null) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)[Math.max(0, line - 1)] || ''; } catch { return col || 1; }
  if (col && text.slice(col - 1, col - 1 + name.length) === name) return col;
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`);
  const m = re.exec(text);
  return m ? m.index + m[1].length + 1 : (col || 1);
}

/** WHERE TO ASK: the selected identifier's own position. */
function positionOf(root, sel) {
  if (!sel || !sel.source || !sel.source.file) return null;
  const name = sel.symbol && sel.symbol.name;
  const file = sel.source.file;
  if (!name) return { file, line: sel.source.startLine || 1, col: sel.source.startCol || 1, name: null };
  let text = '';
  try { text = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)[Math.max(0, (sel.source.startLine || 1) - 1)] || ''; } catch { text = ''; }
  if (text.includes(name)) return { file, line: sel.source.startLine, col: columnOf(root, file, sel.source.startLine, name, sel.source.startCol), name };
  const d = (sel.symbol.declarations || [])[0];
  if (d) return { file: d.file, line: d.line, col: columnOf(root, d.file, d.line, name), name };
  return { file, line: sel.source.startLine || 1, col: sel.source.startCol || 1, name };
}

function within(p, ms) {
  let t;
  return Promise.race([p.then((v) => { clearTimeout(t); return v; }, (e) => { clearTimeout(t); return { ok: false, why: e && e.message }; }),
    new Promise((res) => { t = setTimeout(() => res({ ok: false, why: `no answer within ${Math.round(ms / 1000)}s`, late: true }), ms); })]);
}

function brief(l) { return { path: l.path, line: l.line, col: l.col, text: l.text }; }
function byFile(locs) {
  const m = new Map();
  for (const l of locs) { const a = m.get(l.path) || []; a.push(l.line); m.set(l.path, a); }
  return [...m.entries()].map(([file, lines]) => ({ file, lines: [...new Set(lines)].sort((a, b) => a - b) }));
}

/** THE FACTS FOR A SELECTION. */
async function forSelection(app, session, sel, { deadlineMs = DEADLINE_MS } = {}) {
  const root = (session && session.cwd) || process.cwd();
  const out = { via: 'none', server: null, position: null, definition: [], references: [], implementations: [], type: '', symbols: [], diagnostics: [], rename: null, ops: {}, evidence: {} };
  if (!sel || !sel.source) return out;
  const at = positionOf(root, sel);
  if (!at) return out;
  out.position = at;
  const ev = require('./evidencerefs');
  const cov = lsp().coverage(app, at.file);
  if (!cov.available) {
    // NO SERVER FOR THIS LANGUAGE: the index's answer, labelled as such.
    out.via = 'index';
    out.why = cov.why;
    if (sel.symbol) {
      out.definition = (sel.symbol.declarations || []).map((d) => ({ path: d.file, line: d.line, col: null, text: '' }));
      out.references = [];
      for (const f of sel.symbol.files || []) for (const line of f.lines) out.references.push({ path: f.file, line, col: null, text: '' });
    }
    out.ops.index = { ok: true, ms: 0, cached: true };
    return out;
  }
  out.via = 'lsp';
  out.server = cov.id;
  // A SERVER THAT HAS NOT LOADED THE FILES answers references from what it has open: the files the Selection already knows mention the name are opened…
  try { await within(lsp().prime(app, [at.file, ...(sel.symbol ? (sel.symbol.files || []).map((f) => f.file) : [])], { max: 60 }), deadlineMs); } catch { /* the answer may be partial; the ops say so */ }
  const words = at.name ? [at.name] : [];
  const keyOf = (op) => `lsp.${op}:${sel.id}:${at.file}:${at.line}:${at.col}`;
  const q = { path: at.file, line: at.line, col: at.col };
  const run = {
    definition: () => lsp().definition(app, q),
    references: () => lsp().references(app, { ...q, includeDeclaration: true }),
    implementation: () => lsp().implementation(app, q),
    hover: () => lsp().hover(app, q),
    symbols: () => lsp().documentSymbols(app, { path: at.file }),
    prepareRename: () => lsp().prepareRename(app, q),
  };
  const shape = {
    definition: (r) => ({ summary: `${at.name || 'selection'}: defined at ${(r.locations || []).map((l) => `${l.path}:${l.line}`).join(', ') || 'nowhere the server knows'}`, deps: (r.locations || []).map((l) => l.path), value: (r.locations || []).slice(0, MAX_LOCS).map(brief) }),
    references: (r) => { const locs = (r.locations || []).slice(0, 400); const files = byFile(locs); return { summary: `${at.name || 'selection'}: ${locs.length} reference(s) in ${files.length} file(s)`, deps: files.map((f) => f.file), value: locs.slice(0, MAX_LOCS * 4).map(brief), content: files.map((f) => `${f.file}: ${f.lines.join(', ')}`).join('\n') }; },
    implementation: (r) => ({ summary: `${at.name || 'selection'}: ${(r.locations || []).length} implementation(s)`, deps: (r.locations || []).map((l) => l.path), value: (r.locations || []).slice(0, MAX_LOCS).map(brief) }),
    hover: (r) => ({ summary: `${at.name || 'selection'}: ${String(r.contents || '').replace(/\x60{3}\w*\n?/g, '').replace(/\s+/g, ' ').slice(0, 160) || 'no type information'}`, deps: [at.file], value: String(r.contents || '').slice(0, 1200) }),
    symbols: (r) => ({ summary: `${at.file}: ${(r.symbols || []).length} symbol(s)`, deps: [at.file], value: (r.symbols || []).slice(0, 200), content: (r.symbols || []).slice(0, 200).map((s) => `${s.line}: ${s.container ? `${s.container}.` : ''}${s.name}`).join('\n') }),
    prepareRename: (r) => ({ summary: `${at.name || 'selection'}: ${r.renameable === false ? 'cannot be renamed' : `renameable${r.placeholder ? ` as "${r.placeholder}"` : ''}`} (${r.prepared ? 'prepareRename' : 'server has no prepare step'})`, deps: [at.file], value: { renameable: r.renameable !== false, prepared: Boolean(r.prepared), placeholder: r.placeholder || null, range: r.range || null } }),
  };
  // PARALLEL, each against its own deadline; cached answers need no request.
  await Promise.all(OPS.map(async (op) => {
    const t0 = Date.now();
    if (unsupportedBy.has(cov.id) && unsupportedBy.get(cov.id).has(op)) { out.ops[op] = { ok: false, ms: 0, cached: true, unsupported: true }; return; }
    const hit = ev.lookup(session, keyOf(op));
    if (hit.entry && hit.state !== 'stale') { out.ops[op] = { ok: true, ms: 0, cached: true, state: hit.state }; out[`_${op}`] = hit.entry.data; out.evidence[op] = hit.entry.id; return; }
    const r = await within(Promise.resolve().then(run[op]), deadlineMs);
    out.ops[op] = { ok: Boolean(r && r.ok), ms: Date.now() - t0, cached: false, why: r && !r.ok ? r.why : undefined, unsupported: Boolean(r && r.unsupported) };
    if (r && r.unsupported) { if (!unsupportedBy.has(cov.id)) unsupportedBy.set(cov.id, new Set()); unsupportedBy.get(cov.id).add(op); }
    if (!r || !r.ok) return;
    const s = shape[op](r);
    const e = ev.put(session, { kind: `lsp.${op}`, key: keyOf(op), source: `language server ${r.server || cov.id}`, summary: s.summary, content: s.content || (typeof s.value === 'string' ? s.value : JSON.stringify(s.value)), deps: [...s.deps, at.file], words, data: s.value });
    out[`_${op}`] = s.value;
    out.evidence[op] = e ? e.id : null;
  }));
  out.definition = out._definition || [];
  out.references = out._references || [];
  out.implementations = out._implementation || [];
  out.type = typeof out._hover === 'string' ? out._hover : '';
  out.symbols = out._symbols || [];
  out.rename = out._prepareRename || null;
  for (const k of OPS) delete out[`_${k}`];
  // THE SERVER'S DIAGNOSTICS for the files in play — whatever it has published.
  const files = [...new Set([at.file, ...out.definition.map((l) => l.path), ...out.references.map((l) => l.path)])].slice(0, 20);
  try { out.diagnostics = lsp().diagnosticsFor(app, files).slice(0, 40); } catch { out.diagnostics = []; }
  if (!out.definition.length && !out.references.length && Object.values(out.ops).every((o) => !o.ok)) out.via = 'lsp-failed';
  return out;
}

/** THE FILES A SELECTION'S LANGUAGE FACTS NAME, by role — for the packet, for Laya, for narrowing. */
function relevantFiles(facts, sel) {
  if (!facts) return [];
  const decl = facts.definition.map((l) => l.path);
  const front = sel && sel.source ? sel.source.file : null;
  const refs = byFile(facts.references).map((f) => f.file);
  return [...new Set([...decl, front, ...refs, ...facts.implementations.map((l) => l.path)].filter(Boolean))];
}

module.exports = { forSelection, positionOf, columnOf, relevantFiles, byFile, DEADLINE_MS, OPS };
