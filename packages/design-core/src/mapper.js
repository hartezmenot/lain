'use strict';

/**
 * THE MAPPING LADDER (D9) — a page element → the source that renders it, with a confidence tier, stopping at the
 * first rung that answers:
 *
 *   exact     a compile-time data-lain-id the engine can locate (JSX, Vue SFC, Svelte, plain HTML)
 *   resolved  a framework's own dev hook names the file: Svelte `__svelte_meta` (file:line:col), Vue `__file`, React's
 *             component owner names → the file that defines them; then the element inside that file, uniquely
 *   inferred  a static fuzzy match over every parsed source: tag, text, classes, attributes, sibling index, parents —
 *             accepted only above a threshold AND unique; a near-tie is returned as a question, never guessed
 *   agent     an answer the Agent gave before for the same element, cached in .lain/design/mappings.json
 *   none      selectable, but markup edits route to the prompt bar
 *
 * (Style edits need no markup mapping: styles.js finds the rule through the CSS origin.)
 */

const fs = require('fs');
const path = require('path');
const { sha1 } = require('./text');

const THRESHOLD = 6;

function mappingsFile(root) { return path.join(root, '.lain', 'design', 'mappings.json'); }
function readMappings(root) { try { return JSON.parse(fs.readFileSync(mappingsFile(root), 'utf8')); } catch { return {}; } }
function signature(d) { return sha1(JSON.stringify([d.tag, d.text || d.innerText, (d.classes || []).filter((c) => !/__|^s-|^svelte-|^data-v/.test(c)).slice(0, 4), d.attrs && d.attrs.id, (d.parent || []).slice(0, 2).map((p) => p.tag)])).slice(0, 16); }

/** Cache an Agent's answer (design_inspect {map}) for this element's signature. */
function remember(root, key, where) {
  const all = readMappings(root);
  all[key] = { file: where.file, line: Number(where.line) || null, at: Date.now() };
  fs.mkdirSync(path.dirname(mappingsFile(root)), { recursive: true });
  fs.writeFileSync(mappingsFile(root), JSON.stringify(all, null, 2));
  return all[key];
}

/** Identifiers in a bound class expression (`styles.title`, `cx('a', b)`) — hints for hashed class names. */
function classHints(project, el) {
  const out = new Set(el.classes || []);
  const loc = el.attrLoc && (el.attrLoc.className || el.attrLoc.class || el.attrLoc[':class']);
  if (loc) { try { const raw = project.read(el.file).src.slice(loc.start, loc.end); for (const m of raw.matchAll(/[A-Za-z_][\w-]*/g)) out.add(m[0]); } catch { /* none */ } }
  return out;
}

function score(project, el, d, tree) {
  if (String(el.tag).toLowerCase() !== d.tag) return 0;
  let s = 3;
  const text = (d.text || '').trim();
  const et = String(el.text || '').replace(/\{[^}]*\}/g, '').trim();
  if (text && et && et === text) s += 4; else if (text && et && (et.includes(text) || text.includes(et))) s += 1.5; else if (text && et && !/[{]/.test(el.text)) s -= 2;
  const hints = classHints(project, el);
  for (const c of d.classes || []) {
    if (hints.has(c)) s += 2;
    else { const local = /^[A-Za-z0-9-]+?_([\w-]+?)__[\w-]{5}$/.exec(c); if (local && hints.has(local[1])) s += 2; }
  }
  const a = d.attrs || {};
  for (const k of ['id', 'href', 'src', 'alt', 'type', 'name', 'placeholder', 'aria-label']) if (a[k] != null && el.attrs[k] != null && String(el.attrs[k]) === String(a[k])) s += k === 'id' ? 4 : 2;
  const parent = el.parent ? tree.byId.get(el.parent) : null;
  if (parent && d.parent && d.parent[0] && String(parent.tag).toLowerCase() === d.parent[0].tag) s += 1;
  if (parent && d.siblingIndex != null && parent.children.indexOf(el.id) === d.siblingIndex) s += 1;
  return s;
}

/** Fuzzy over these files: { best, second, candidates } sorted by score. */
function fuzzy(project, d, files) {
  const cands = [];
  for (const rel of files) {
    let e; try { e = project.read(rel); } catch { continue; }
    if (!e || !e.tree) continue;
    for (const el of e.tree.all) { const sc = score(project, el, d, e.tree); if (sc > 0) cands.push({ id: el.id, file: rel, line: el.line, col: el.col, score: sc, repeated: Boolean(el.repeated) }); }
  }
  cands.sort((x, y) => y.score - x.score);
  return cands;
}

function allSources(project) {
  const out = new Set();
  try { for (const f of project.sources ? project.sources() : []) out.add(f); } catch { /* none */ }
  try { for (const s of project.scanScreens()) if (s.file) out.add(s.file); } catch { /* none */ }
  return [...out].filter((f) => /\.(jsx|tsx|js|ts|vue|svelte|html?)$/i.test(f));
}

/** Files defining these component names (`function Name(`, `const Name =`, `class Name`, a Name.vue/.svelte file). */
function filesDefining(project, names) {
  const out = [];
  const files = allSources(project);
  for (const n of names) {
    if (!/^[A-Z]/.test(n)) continue;
    for (const f of files) {
      if (new RegExp(`(^|/)${n}\\.(vue|svelte|jsx|tsx)$`).test(f)) { out.push(f); continue; }
      let src = ''; try { src = project.read(f).src; } catch { continue; }
      if (new RegExp(`(function\\s+${n}\\s*\\(|(const|let|var)\\s+${n}\\s*=|class\\s+${n}\\b)`).test(src)) out.push(f);
    }
  }
  return [...new Set(out)];
}

const at = (c, tier, extra = {}) => ({ tier, node: c.id, file: c.file, line: c.line, col: c.col, ...extra });

/** The ladder. `d` is the runtime's describe() of the element. */
function map(project, d) {
  if (!d) return { tier: 'none', why: 'no element' };
  const repeat = (node, file) => (d.count > 1 ? { count: d.count, component: path.basename(file || '').replace(/\.(vue|svelte|jsx|tsx|js|ts)$/, '') || null } : {});
  // 1. EXACT
  if (d.lainId) {
    const loc = project.locate(d.lainId);
    if (loc) return { tier: 'exact', node: d.lainId, file: loc.el.file || loc.screen, line: loc.el.line, col: loc.el.col, ...repeat(d.lainId, loc.el.file || loc.screen) };
  }
  // 2. RESOLVED — the framework's own dev hooks.
  if (d.svelteMeta && d.svelteMeta.file) {
    const rel = path.isAbsolute(d.svelteMeta.file) ? path.relative(project.root, d.svelteMeta.file).replace(/\\/g, '/') : d.svelteMeta.file;
    try { const e = project.read(rel); const el = e.tree.all.find((x) => x.line === d.svelteMeta.line && Math.abs(x.col - (d.svelteMeta.column + 1)) <= 1); if (el) return at({ id: el.id, file: rel, line: el.line, col: el.col }, 'resolved', { via: '__svelte_meta', ...repeat(el.id, rel) }); } catch { /* fall through */ }
  }
  const hookFiles = [];
  if (d.vueFile) hookFiles.push(path.isAbsolute(d.vueFile) ? path.relative(project.root, d.vueFile).replace(/\\/g, '/') : d.vueFile);
  if (d.reactOwners && d.reactOwners.length) hookFiles.push(...filesDefining(project, d.reactOwners.slice(0, 3)));
  if (hookFiles.length) {
    const c = fuzzy(project, d, hookFiles);
    if (c[0] && c[0].score >= THRESHOLD - 2 && (!c[1] || c[1].score < c[0].score)) return at(c[0], 'resolved', { via: d.vueFile ? '__file' : 'react owner', ...repeat(c[0].id, c[0].file) });
  }
  // 4. INFERRED — static fuzzy over every source, unique and above the threshold; a near-tie is a question.
  const c = fuzzy(project, d, allSources(project));
  if (c[0] && c[0].score >= THRESHOLD) {
    if (c[1] && c[1].score >= c[0].score - 0.5) return { tier: 'ambiguous', candidates: c.slice(0, 3).filter((x) => x.score >= c[0].score - 0.5).map((x) => ({ node: x.id, file: x.file, line: x.line })), question: `This looks like ${c.slice(0, 2).map((x) => `${x.file}:${x.line}`).join(' or ')} — which one?` };
    return at(c[0], 'inferred', { score: c[0].score, ...repeat(c[0].id, c[0].file) });
  }
  // 5. AGENT — an answer cached from before.
  const key = signature(d);
  const cached = readMappings(project.root)[key];
  if (cached && cached.file) {
    let node = null; try { const e = project.read(cached.file); const el = e.tree && e.tree.all.find((x) => x.line === cached.line); node = el ? el.id : null; } catch { /* file moved */ }
    return { tier: 'agent', node, file: cached.file, line: cached.line, key };
  }
  // 6. NONE
  return { tier: 'none', key, why: 'no source matched this element; markup edits go to the prompt bar', best: c[0] ? { file: c[0].file, line: c[0].line, score: c[0].score } : null };
}

module.exports = { map, remember, signature, fuzzy, readMappings, THRESHOLD };
