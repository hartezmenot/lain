'use strict';

/** SEMANTIC RENAME THROUGH THE LANGUAGE SERVER — any language whose server renames (2026-09-25). */

const fs = require('fs');
const path = require('path');

function lsp() { return require('./lsp/manager'); }

function parseAt(at) {
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(String(at || '').trim());
  return m ? { file: m[1].replace(/\\/g, '/'), line: Number(m[2]), col: m[3] ? Number(m[3]) : null } : null;
}

/** Where to rename `from`: explicit, the Selection's, or its one declaration. */
function positionFor(app, session, from, at) {
  const root = session.cwd;
  const lf = require('./langfacts');
  const given = parseAt(at);
  if (given) return { ...given, col: lf.columnOf(root, given.file, given.line, from, given.col), via: 'given' };
  let sel = null;
  try { sel = require('./harnesscontext').selection(app, session); } catch { sel = null; }
  if (sel && sel.symbol && sel.symbol.name === from) {
    const p = lf.positionOf(root, sel);
    if (p) return { file: p.file, line: p.line, col: p.col, via: `selection ${sel.id}`, selection: sel };
  }
  let decls = [];
  try { const idx = require('./projectindex').fresh(root, { persist: false }).index; decls = require('./projectindex').definitionsOf(idx, from); } catch { decls = []; }
  if (decls.length === 1) return { file: decls[0].file, line: decls[0].line, col: lf.columnOf(root, decls[0].file, decls[0].line, from), via: 'its declaration' };
  return null;
}

function textAt(text, starts, p) { return (starts[p.line] != null ? starts[p.line] : text.length) + p.character; }
function lineStarts(text) { const s = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') s.push(i + 1); return s; }

/** Every edit replaces exactly `from` (shorthand keys may keep it as a prefix). */
function check(root, plan, from, to) {
  const odd = [];
  for (const f of plan.files) {
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { odd.push(`${f.path}: unreadable`); continue; }
    const st = lineStarts(text);
    for (const e of f.edits) {
      const old = text.slice(textAt(text, st, e.start), textAt(text, st, e.end));
      const ok = old === from && (e.newText === to || e.newText.endsWith(to) || e.newText.startsWith(to));
      if (!ok) odd.push(`${f.path}:${e.start.line + 1} "${old.slice(0, 40)}" → "${String(e.newText).slice(0, 40)}"`);
    }
    const rel = path.relative(root, f.abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) odd.push(`${f.abs}: outside the project`);
  }
  return odd;
}

/** RENAME `from` → `to` with the language server. */
async function rename(app, session, { from, to, at = null, dryRun = false }) {
  if (!app || !session || !session.cwd) return { used: false, why: 'no project' };
  const root = session.cwd;
  const where = positionFor(app, session, from, at);
  if (!where) return { used: false, why: `no single declaration of ${from} to ask a language server about (pass at: "file:line")` };
  const cov = lsp().coverage(app, where.file);
  if (!cov.available) return { used: false, why: cov.why };
  // A SERVER WITHOUT A PROJECT FILE sees only open files: open every file of its
  // language that mentions the name first.
  let mentions = [];
  try { mentions = (where.selection && where.selection.symbol ? where.selection.symbol.files : require('./harnesscontext').symbolSites(root, from).files).map((f) => f.file); } catch { mentions = []; }
  await lsp().prime(app, [where.file, ...mentions]);
  const q = { path: where.file, line: where.line, col: where.col };
  const prep = await lsp().prepareRename(app, q);
  if (!prep.ok) return prep.unsupported ? { used: false, why: prep.why } : { used: true, ok: false, server: prep.server, why: `prepareRename failed: ${prep.why}` };
  if (prep.renameable === false) return { used: true, ok: false, server: prep.server, why: `${cov.name} says ${from} at ${where.file}:${where.line} cannot be renamed` };
  const plan = await lsp().rename(app, { ...q, newName: to });
  if (!plan.ok) return { used: true, ok: false, server: cov.id, why: plan.why };
  if (!plan.count) return { used: false, why: `${cov.name} returned no edits for ${from} at ${where.file}:${where.line}` };
  const odd = check(lsp().absOf(app, '.'), plan, from, to);
  if (odd.length) return { used: true, ok: false, server: plan.server, why: `refused: the server's edit would change text that is not the identifier ${from} — ${odd.slice(0, 4).join('; ')}. Nothing was written.` };
  // WHAT STAYS: strings and comments that still say the old name, and its wire spellings.
  let sites = { strings: [], wire: [] };
  try { sites = require('./harnesscontext').symbolSites(root, from); } catch { /* reported as unknown */ }
  const base = { used: true, ok: true, server: plan.server, via: where.via, position: `${where.file}:${where.line}:${where.col}`, files: plan.files.map((f) => ({ path: f.path, edits: f.edits.length })), count: plan.count, strings: sites.strings || [], wire: sites.wire || [] };
  if (dryRun) return { ...base, dryRun: true, mutated: [], diagnostics: [], text: describe({ ...base, dryRun: true, from, to }) };
  const since = Date.now();
  const mutated = [];
  for (const f of plan.files) {
    // THE SESSION'S SPELLING of the project for the write (provenance and the
    // transaction are keyed by it); the server hears about it by its own.
    const abs = path.resolve(root, f.path);
    const before = fs.readFileSync(abs, 'utf8');
    const after = lsp().applyTo(before, f.edits);
    if (after === before) continue;
    fs.writeFileSync(abs, after);
    mutated.push(abs);
    lsp().document(app, { event: 'save', path: abs, text: after }).catch(() => {});
  }
  const settled = await lsp().settle(app, plan.files.map((f) => f.path), { since, ms: 4000 });
  const alive = lsp().readyFor(app, where.file);
  const diagnostics = lsp().diagnosticsFor(app, plan.files.map((f) => f.path)).filter((d) => d.severity === 'error');
  // "NO ERRORS" ONLY WHEN THE SERVER ACTUALLY RE-CHECKED the changed files.
  const out = { ...base, dryRun: false, mutated, diagnostics, checked: alive && settled };
  return { ...out, text: describe({ ...out, from, to }) };
}

function describe(r) {
  const lines = [];
  lines.push(r.dryRun
    ? `${r.from} → ${r.to} (language server ${r.server}, at ${r.position} — ${r.via}): ${r.count} edit(s) in ${r.files.length} file(s) WOULD change. Nothing was written.`
    : `${r.from} → ${r.to} (language server ${r.server}, at ${r.position} — ${r.via}): ${r.count} edit(s) in ${r.files.length} file(s).`);
  for (const f of r.files.slice(0, 30)) lines.push(`  ${f.path} (${f.edits})`);
  if (r.strings.length) {
    lines.push('', `NOT renamed — strings and comments that still contain "${r.from}" (the server renames the symbol, not text). Decide each on purpose:`);
    for (const s of r.strings.slice(0, 12)) lines.push(`  ${s.file} — line(s) ${s.lines.join(', ')}`);
  }
  if (r.wire.length) lines.push('', `Wire / protocol spellings left as they are: ${[...new Set(r.wire.map((w) => `"${w.name}" (${w.file})`))].slice(0, 8).join(', ')}`);
  if (!r.dryRun) {
    if (r.diagnostics.length) lines.push('', `The language server reports ${r.diagnostics.length} error(s) in the changed files:\n${r.diagnostics.slice(0, 10).map((d) => `  ${d.path}:${d.line}:${d.col} ${d.message}`).join('\n')}`);
    else lines.push('', r.checked ? 'The language server re-checked the changed files and reports no errors.' : 'NOT VERIFIED: the language server did not re-check the changed files in time (or restarted) — run the project\'s checks or tests.');
  }
  return lines.join('\n');
}

module.exports = { rename, positionFor, parseAt, check, describe };
