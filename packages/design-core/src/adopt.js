'use strict';

/**
 * ADOPTING ANY FRONTEND (D9) — the edit pipeline for apps Design did not make:
 *
 *   mirror     Design's own headless page on the same preview (the window's canvas shows the person's; this one is
 *              measured and asked over CDP)
 *   map        the mapping ladder (mapper.js) for an element, with its tier
 *   planStyle  a style edit from the CSS ORIGIN: the declaration that wins, in the file that wrote it — inside its
 *              @media when that is where it lives; a base rule while a breakpoint is active asks "All sizes or only
 *              this breakpoint?"; a selector shared by other elements asks "all or only this one"; values that match a
 *              project token are written as the token
 *   prove      the alignment proof: predict, write, wait for the reload, measure; a write the canvas does not confirm
 *              (within 1 px, or the computed value) is undone byte-exact and the reason is said
 */

const fs = require('fs');
const path = require('path');
const { StyleOrigin, declAt, addDecl, mediaRule } = require('./styles');
const { diffSummary } = require('./text');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The mirror page on a screen, and its CSS origin reader. */
async function mirror(design, screen, device = null) {
  const h = await design.page(screen, device);
  if (!design._origin || design._origin.h !== h) design._origin = new StyleOrigin(h, design.root, design.preview.url);
  return { h, so: design._origin };
}

async function describe(design, screen, q) {
  const { h } = await mirror(design, screen);
  return h.page.eval(`window.__lainDesign ? window.__lainDesign.describe(${JSON.stringify(q)}) : null`);
}

async function mapNode(design, screen, q) {
  const d = await describe(design, screen, q);
  if (!d) return { tier: 'none', why: `no element ${q} on this screen` };
  return { ...require('./mapper').map(design.project, d), selector: d.selector, desc: d };
}

/** The selector's text as written in the source rule around a position (for a media copy of the rule). */
function sourceSelector(src, line, col) {
  let at = 0; for (let i = 1; i < line; i++) at = src.indexOf('\n', at) + 1;
  at += col || 0;
  const open = src.lastIndexOf('{', at);
  const prev = Math.max(src.lastIndexOf('}', open), src.lastIndexOf(';', open), src.lastIndexOf('{', open - 1));
  return src.slice(prev + 1, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

/** Which project media queries are active now (the device width selects them). */
async function activeMedia(design, h) {
  const list = design.tokens().t.media || [];
  const out = [];
  for (const q of list) { try { if (await h.page.eval(`matchMedia(${JSON.stringify(q)}).matches`)) out.push(q); } catch { /* skip */ } }
  return out;
}

/**
 * PLAN A STYLE EDIT through the CSS origin: { ok, files, summary, diff, target } or { ok:false, needs|why }.
 * op: { screen, selector, props: {prop: value|null}, scope: 'all'|'only', breakpoint: 'all'|'only' }
 */
async function planStyle(design, op) {
  const project = design.project;
  const { h, so } = await mirror(design, op.screen, op.device);
  const sel = op.selector;
  const tok = design.tokens();
  const perFile = new Map();
  const add = (rel, e) => { if (!perFile.has(rel)) perFile.set(rel, []); perFile.get(rel).push(e); };
  const notes = [];
  const media = await activeMedia(design, h);
  const desc = await describe(design, op.screen, sel);
  for (const [prop, raw] of Object.entries(op.props || {})) {
    const c = await so.cascade(sel, prop);
    const w = c.winner;
    const write = (rel, value) => (value == null ? value : (tok.token(prop, value, rel) || value));
    if (w && !w.rule.inline) {
      const o = await so.origin(w.styleSheetId, w.range);
      if (!o || o.line == null) return { ok: false, why: `the rule that sets ${prop} (${w.rule.selector}) could not be traced to a project file`, route: 'agent' };
      const src = project.read(o.rel).src;
      const inMedia = w.rule.media.length > 0;
      if (!inMedia && media.length && !op.breakpoint) return { ok: false, needs: { breakpoint: { media: media[0], question: `All sizes or only this breakpoint (${media[0]})?` } } };
      const shared = await so.uses(w.rule.selector);
      const allSame = desc && desc.count > 1 && shared <= desc.count;
      if (shared > 1 && !allSame && !op.scope) return { ok: false, needs: { scope: { uses: shared, cls: w.rule.selector, question: `Change all ${shared} uses of ${w.rule.selector}, or only this one?` } } };
      if (shared > 1 && !allSame && op.scope === 'only') return { ok: false, why: `"only this one" needs its own class on the element's markup — ask the Agent, or change all ${shared}`, route: 'agent' };
      if (!inMedia && op.breakpoint === 'only') {
        add(o.rel, mediaRule(src, media[0], sourceSelector(src, o.line, o.col), { [prop]: write(o.rel, raw) }));
        notes.push(`${prop} for ${media[0]} only in ${o.rel}`);
        continue;
      }
      const d = declAt(src, o.line, o.col, prop);
      if (!d) return { ok: false, why: `${prop} was traced to ${o.rel}:${o.line} but the declaration is not there`, route: 'agent' };
      if (raw == null) { add(o.rel, { start: d.declStart, end: d.end + (src[d.end] === ';' ? 1 : 0), text: '' }); notes.push(`-${prop} in ${o.rel}:${o.line}`); } else { add(o.rel, { start: d.start, end: d.end, text: write(o.rel, raw) }); notes.push(`${prop} ${write(o.rel, raw)} in ${o.rel}:${o.line}${inMedia ? ` (@media ${w.rule.media[0]})` : ''}${allSame ? ` — all ${desc.count} rendered by ${path.basename(o.rel)}` : ''}`); }
      continue;
    }
    // NO RULE SETS IT (or only the inline style): the element's own most specific rule gets it, if no one else uses it.
    const own = c.rules.slice().reverse().find(Boolean);
    if (own && (!w || !w.rule.inline)) {
      const shared = await so.uses(own.selector);
      const o = await so.origin(own.styleSheetId, own.styleRange);
      if (o && o.line != null && (shared <= 1 || (desc && shared <= desc.count) || op.scope === 'all')) {
        const src = project.read(o.rel).src;
        if (media.length && !op.breakpoint) return { ok: false, needs: { breakpoint: { media: media[0], question: `All sizes or only this breakpoint (${media[0]})?` } } };
        if (op.breakpoint === 'only') add(o.rel, mediaRule(src, media[0], sourceSelector(src, o.line, o.col + 1), { [prop]: write(o.rel, raw) }));
        else { const e = addDecl(src, o.line, o.col, prop, write(o.rel, raw)); if (!e) return { ok: false, why: `no rule block at ${o.rel}:${o.line}`, route: 'agent' }; add(o.rel, e); }
        notes.push(`${prop} ${write(o.rel, raw)} added to ${own.selector} in ${o.rel}:${o.line}`);
        continue;
      }
      if (shared > 1 && !op.scope) return { ok: false, needs: { scope: { uses: shared, cls: own.selector, question: `Change all ${shared} uses of ${own.selector}, or only this one?` } } };
    }
    // THE MARKUP (inline style / a new class) — only with a mapping that names the element's source.
    return { ok: false, markup: true, why: `no stylesheet rule of its own sets ${prop}` };
  }
  const res = project._result({ op: 'setStyle' }, perFile, { summary: `${desc ? desc.tag : sel}: ${notes.join('; ')}`, target: [...perFile.keys()] });
  res.viaOrigin = true;
  return res;
}

// ---- the alignment proof -------------------------------------------------------------------------------------------

/** What the browser will compute for prop: value on this element (a hidden probe beside it). */
async function expected(h, selector, prop, value) {
  return h.page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const p = el.parentElement || document.body; const d = document.createElement(el.tagName); d.className = el.className; d.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;'; d.style.setProperty(${JSON.stringify(prop)}, ${JSON.stringify(String(value))}); p.appendChild(d); const v = getComputedStyle(d).getPropertyValue(${JSON.stringify(prop)}); d.remove(); return v; })()`);
}

async function measure(h, selector, props) {
  return h.page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); const o = {}; ${JSON.stringify(props)}.forEach((p) => { o[p] = cs.getPropertyValue(p); }); return { rect: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }, computed: o }; })()`);
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
function close(a, b) { const x = num(a); const y = num(b); if (x != null && y != null && /px$|^-?[\d.]+$/.test(String(a)) && /px$|^-?[\d.]+$/.test(String(b))) return Math.abs(x - y) <= 1; return String(a).trim() === String(b).trim(); }

/** Why the canvas did not follow the write: a one-line reason, read from the browser. */
async function explain(design, h, selector, prop, wrote) {
  try {
    const so = design._origin;
    const c = await so.cascade(selector, prop);
    const w = c.winner;
    if (w) {
      const o = await so.origin(w.styleSheetId, w.range).catch(() => null);
      const where = o ? `${o.rel}:${o.line}` : w.rule.selector;
      if (w.important && (!wrote || !o || o.rel !== wrote.rel || o.line !== wrote.line)) return `an \`!important\` rule at ${where} (${w.rule.selector} { ${prop}: ${w.value} !important }) wins`;
      if (!wrote || (o && (o.rel !== wrote.rel || o.line !== wrote.line))) return `\`${w.rule.selector}\` at ${where} wins for ${prop}`;
    }
    const t = await h.page.eval(`(() => { let el = document.querySelector(${JSON.stringify(selector)}); const own = getComputedStyle(el); const r = { position: own.position, transform: own.transform, translate: own.translate }; let p = el.parentElement; while (p && p !== document.documentElement) { const cs = getComputedStyle(p); if (cs.transform && cs.transform !== 'none') { r.parentTransform = cs.transform; r.parent = p.className || p.tagName.toLowerCase(); break; } p = p.parentElement; } return r; })()`);
    if (t.parentTransform) return `a parent transform (\`${t.parentTransform}\` on ${t.parent}) changes how far it moves`;
    if (/^(left|right|top|bottom)$/.test(prop) && t.position === 'static') return `\`${prop}\` has no effect on a position: static element`;
    if (t.transform && t.transform !== 'none') return `its own transform (\`${t.transform}\`) moves it too`;
  } catch { /* fall through */ }
  return 'the preview did not change as predicted';
}

/**
 * THE PROOF: `expect` is { rect: {x?,y?,w?,h?} } and/or { props: {prop: value} } (values as written; the browser's
 * computed form is predicted with a probe). `commit(result)` writes; `undo()` restores. Returns
 * { ok, kept, proof } or { ok:false, reverted, why, alternatives, proof }.
 */
async function prove(design, result, { screen, selector, expect = {}, reload = null }, { commit, undo }) {
  const { h } = await mirror(design, screen);
  const props = Object.keys(expect.props || {});
  const before = await measure(h, selector, props);
  if (!before) { const c = await commit(result); return c && c.ok ? { ok: true, kept: true, commit: c, proof: { skipped: 'the element is not on the mirror page' } } : c; }
  const want = {};
  for (const p of props) want[p] = expect.props[p] == null ? null : await expected(h, selector, p, expect.props[p]);
  const predicted = { ...(expect.rect ? { rect: { ...before.rect, ...expect.rect } } : {}), computed: want };
  const c = await commit(result);
  if (!c || !c.ok) return c;
  // WAIT FOR THE RELOAD: hot reload (Vite, Next) or a page reload (plain files), then the change itself.
  const deadline = Date.now() + (design.opts.proofMs || 6000);
  let after = null;
  if (reload === 'page' || design.kind === 'web-html') { await h.goto(await h.page.eval('location.href')); }
  const matchesBox = (m) => m && (!expect.rect || Object.entries(expect.rect).every(([k, v]) => Math.abs(m.rect[k] - v) <= 1)) && props.every((p) => want[p] == null || close(m.computed[p], want[p]));
  let ok = false;
  const look = async () => { after = await measure(h, selector, props).catch(() => null); ok = (expect.check ? await expect.check(h).catch(() => false) : true) && (expect.check && !expect.rect && !props.length ? true : matchesBox(after)); return ok; };
  while (Date.now() < deadline) { await sleep(150); if (await look()) break; }
  if (!ok && reload !== 'page' && design.kind !== 'web-html') { await h.goto(await h.page.eval('location.href')); await sleep(400); await look(); }
  const proof = { predicted, actual: after, tolerancePx: 1 };
  if (ok) return { ok: true, kept: true, commit: c, proof };
  // NOT CONFIRMED: undo byte-exact, then say why (read from the browser before the undo reloads it).
  const prop = props[0] || (expect.rect ? Object.keys(result.moveProps || {})[0] || 'left' : 'left');
  const wrote = result.files && result.files[0] ? { rel: result.files[0].rel, line: null } : null;
  const why = await explain(design, h, selector, prop, wrote);
  const u = await undo();
  return { ok: false, reverted: Boolean(u && u.ok), why, proof, alternatives: ['offset', 'absolute', 'winning-rule', 'agent'], undo: u };
}

module.exports = { mirror, describe, mapNode, planStyle, prove, expected, measure, explain, activeMedia, sourceSelector };
