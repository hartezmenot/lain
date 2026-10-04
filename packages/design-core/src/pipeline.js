'use strict';

/**
 * THE EDIT PIPELINE (D9) — every deterministic Design edit, from the canvas or a design_* tool:
 *
 *   1. find the element on the mirror page and map it to its source (the ladder, with its tier)
 *   2. plan the splice: styles through the CSS origin (apps Design did not make) or the source planner (files it
 *      reads end to end); questions that are the person's come back as questions — shared class, breakpoint, a flex
 *      child's move, an element rendered many times, an ambiguous mapping
 *   3. PROVE it: predict, write, wait for the reload, measure — not confirmed → undone byte-exact, with the reason
 *   4. keep a change card (before/after, diff, proof)
 *
 * `hooks.commit(result)` writes (the host's mutation transaction and stale guard); `hooks.undo()` restores.
 */

const adopt = require('./adopt');
const layoutMod = require('./layout');

const STYLE = new Set(['setStyle', 'move', 'resize']);
const MARKUP = new Set(['setText', 'insert', 'remove', 'reorder', 'setAsset', 'addWire', 'setAnimation']);

function sigScript(sel) {
  return `(() => { const p = document.querySelector(${JSON.stringify(sel)}); if (!p) return null; return [...p.children].filter((c) => !c.hasAttribute('data-lain-overlay') && !/^(SCRIPT|STYLE)$/.test(c.tagName)).map((c) => c.tagName.toLowerCase() + '|' + (c.innerText || '').trim().slice(0, 40)); })()`;
}

async function edit(design, op, hooks = {}) {
  const project = design.project;
  if (project.readOnly) return { ok: false, why: project.why };
  const screen = op.screen || (project.scanScreens()[0] || {}).file || null;
  let mirror = null;
  try { await design.startPreview(); mirror = await adopt.mirror(design, screen, op.device || null); } catch (e) { mirror = null; design._noProof = e.message; }
  const h = mirror && mirror.h;
  const ev = (expr) => h.page.eval(expr);
  let selector = op.selector || null;
  if (!selector && op.node && h) { try { if (await ev(`!!document.querySelector('[data-lain-id="${op.node}"]')`)) selector = `[data-lain-id="${op.node}"]`; } catch { /* none */ } }
  const desc = h && selector ? await adopt.describe(design, screen, selector).catch(() => null) : null;
  const viaOrigin = STYLE.has(op.op) && h && selector && (project.viaOrigin || !op.node || !project.locate(op.node));

  let result = null; let expect = {}; let mapped = null;
  // ---- STYLE through the CSS origin -------------------------------------------------------------------------------
  if (viaOrigin) {
    const lay = op.layout || await ev(`window.__lainDesign.layoutOf(${JSON.stringify(selector)})`);
    let props = op.props || {};
    if (op.op === 'move') {
      const { so } = mirror;
      const declared = {};
      for (const p of ['left', 'right', 'top', 'bottom']) { const c = await so.cascade(selector, p); if (c.winner) declared[p] = c.winner.value; }
      const d = layoutMod.drag(lay, declared, { dx: op.dx || 0, dy: op.dy || 0, drop: op.drop || null });
      if (d.kind === 'choice') {
        if (!op.choice) return { ok: false, needs: { choice: { choices: d.choices.map((c) => ({ id: c.id, label: c.label, index: c.index, props: c.props })), default: d.default, flexChild: d.flexChild } } };
        const c = d.choices.find((x) => x.id === op.choice);
        if (!c) return { ok: false, why: `"${op.choice}" is not offered here` };
        if (c.id === 'reorder') return edit(design, { ...op, op: 'reorder', index: c.index, selector }, hooks);
        props = c.props;
      } else props = d.props;
      expect = { rect: { x: lay.rect.x + (op.dx || 0), y: lay.rect.y + (op.dy || 0) } };
    } else if (op.op === 'resize') {
      props = { width: `${Math.max(1, Math.round(lay.rect.w + (op.dw || 0)))}px`, height: `${Math.max(1, Math.round(lay.rect.h + (op.dh || 0)))}px` };
      expect = { rect: { w: Math.max(1, Math.round(lay.rect.w + (op.dw || 0))), h: Math.max(1, Math.round(lay.rect.h + (op.dh || 0))) } };
    } else expect = { props };
    result = await adopt.planStyle(design, { screen, selector, props, scope: op.scope, breakpoint: op.breakpoint, device: op.device });
    if (!result.ok && result.markup && desc) {
      mapped = require('./mapper').map(project, desc);
      if (mapped.node && ['exact', 'resolved', 'inferred', 'agent'].includes(mapped.tier)) result = project.applyEdit({ op: 'setStyle', node: mapped.node, props, scope: op.scope });
      else return { ok: false, route: 'agent', why: `${result.why}, and the element's markup is not mapped (tier ${mapped.tier}) — describe it in the prompt bar` };
    }
  } else {
    // ---- MARKUP (and the source planner's styles) on a mapped element -------------------------------------------
    let node = op.node && project.locate(op.node) ? op.node : null;
    if (!node && desc && op.op !== 'removeWire') {
      mapped = require('./mapper').map(project, desc);
      if (mapped.tier === 'ambiguous') return { ok: false, needs: { mapping: { candidates: mapped.candidates, question: mapped.question } } };
      if (!mapped.node) return { ok: false, route: 'agent', tier: mapped.tier, why: `this element is not mapped to source (tier ${mapped.tier}) — describe the change in the prompt bar` };
      node = mapped.node;
    }
    // AN ELEMENT RENDERED MANY TIMES (a list from data, a component used N times): the component, or only this one?
    const at = node ? project.locate(node) : null;
    const count = desc ? desc.count : 1;
    if (at && MARKUP.has(op.op) && (count > 1 || at.el.repeated) && !op.instance) {
      const comp = (at.el.file || at.screen || '').split('/').pop().replace(/\.\w+$/, '');
      return { ok: false, needs: { instance: { count: Math.max(count, 2), component: comp, question: `This element is rendered ${count > 1 ? `${count} times` : 'many times'} by <${comp}>; edit the component or only this instance?`, default: 'component' } } };
    }
    if (op.instance === 'only') return { ok: false, route: 'agent', why: 'one instance of a repeated element is data, not markup — describe it in the prompt bar' };
    const payload = { ...op, node: node || op.node };
    if ((op.op === 'move' || op.op === 'resize') && !payload.layout && h && selector) payload.layout = await ev(`window.__lainDesign.layoutOf(${JSON.stringify(selector)})`);
    result = project.applyEdit(payload);
    if (op.op === 'move' && payload.layout && result.ok && !op.choice) expect = { rect: { x: payload.layout.rect.x + (op.dx || 0), y: payload.layout.rect.y + (op.dy || 0) } };
    if (op.op === 'resize' && payload.layout && result.ok) expect = { rect: { w: Math.max(1, Math.round(payload.layout.rect.w + (op.dw || 0))), h: Math.max(1, Math.round(payload.layout.rect.h + (op.dh || 0))) } };
    if (op.op === 'setStyle') expect = { props: op.props || {} };
    if (op.op === 'setAnimation' && op.preset && op.preset !== 'none') expect = { props: { 'animation-name': `lain-${op.preset}` } };
    // STRUCTURE: the parent's children, predicted.
    if (h && selector && result.ok && ['remove', 'reorder', 'setText'].includes(op.op)) {
      const parentSel = await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e && e.parentElement ? window.__lainDesign.pathOf(e.parentElement) : null; })()`);
      const before = parentSel ? await ev(sigScript(parentSel)) : null;
      const idx = await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? [...e.parentElement.children].filter((c) => !/^(SCRIPT|STYLE)$/.test(c.tagName)).indexOf(e) : -1; })()`);
      if (before && idx >= 0) {
        const want = before.slice();
        const [item] = want.splice(idx, 1);
        if (op.op === 'reorder') want.splice(Math.min(Number(op.index) || 0, want.length), 0, item);
        if (op.op === 'setText') want.splice(idx, 0, `${item.split('|')[0]}|${String(op.text).trim().slice(0, 40)}`);
        expect.check = async () => JSON.stringify(await ev(sigScript(parentSel))) === JSON.stringify(want);
        expect.describe = { parent: parentSel, children: want };
      }
    }
    if (h && op.op === 'insert' && result.ok && result.elementId) expect.check = async () => ev(`!!document.getElementById(${JSON.stringify(result.elementId)})`);
  }
  if (!result || !result.ok) return result || { ok: false, why: 'nothing to change' };
  if (!result.files || (!result.files.length && !(result.binary || []).length)) return { ok: true, noop: true, summary: 'already so — nothing to change', diff: '' };
  const commit = hooks.commit || ((r) => design.commit(r));
  const undo = hooks.undo || (() => design.undo());
  if (!h || !selector) {
    const c = await commit(result);
    return c && c.ok ? { ...c, result, proof: { skipped: design._noProof || 'the element is not on the mirror page' }, tier: mapped ? mapped.tier : 'exact' } : c;
  }
  // ---- PROVE --------------------------------------------------------------------------------------------------------
  let before = null; try { before = await h.screenshot(); } catch { /* none */ }
  const r = await adopt.prove(design, result, { screen, selector, expect }, { commit, undo });
  if (!r.ok) return { ...r, result };
  let after = null; try { after = await h.screenshot(); } catch { /* none */ }
  const card = design.cards().add({ actor: hooks.actor || 'person', summary: result.summary, diff: result.diff, files: (result.files || []).map((f) => f.rel), snapshot: r.commit && r.commit.snapshot, proof: { predicted: r.proof.predicted, actual: r.proof.actual, structure: expect.describe || null }, screen, selector, node: op.node || (mapped && mapped.node) || null, tier: mapped ? mapped.tier : (op.node ? 'exact' : 'resolved'), before, after });
  if (hooks.actor === 'agent') design.lastAgentCard = card.id;
  return { ok: true, ...r.commit, result, proof: r.proof, card: card.id, tier: card.tier, summary: result.summary, diff: result.diff, followId: r.commit && r.commit.followId };
}

module.exports = { edit };
