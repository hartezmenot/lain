'use strict';

/**
 * THE design_* TOOLS — a Design session's five, fixed for the session, never offered anywhere else. Every edit is the
 * same deterministic splice the canvas makes; the result is one status line and the diff. Nothing here judges or
 * nudges: a question that is the person's (shared class scope, how a flex child moves) is returned as the question.
 */

const fs = require('fs');
const path = require('path');

const S = (properties, required = []) => ({ type: 'object', properties, required });
const str = { type: 'string' }; const num = { type: 'number' };

const SCHEMAS = {
  design_inspect: {
    name: 'design_inspect',
    description: 'The design project: no args → screens, flows, undo stack; `screen` → its layers; `node` or `selector` → its source and mapping tier (exact|resolved|inferred|agent|none), styles, measured layout. `map: {selector, file, line}` records where an unmapped element is rendered.',
    parameters: S({ screen: str, node: str, selector: str, map: { type: 'object' } }),
  },
  design_edit: {
    name: 'design_edit',
    description: 'One deterministic source edit on a layer (node, or selector on screen), written behind the stale-edit guard, kept only if the preview then measures what was predicted, undoable. op: setStyle{props:{css-prop:value|null}} move{dx,dy,choice?} resize{dw,dh} reorder{index} insert{parent,index?,name,kind:button|text|image|container,text?,asset?} remove setText{text} setAsset{asset} setAnimation{preset,duration?,easing?}. Questions come back as questions: repeat with scope "all"|"only", choice, breakpoint "all"|"only", instance "component"|"only".',
    parameters: S({ op: str, node: str, selector: str, screen: str, breakpoint: str, instance: str, props: { type: 'object' }, scope: str, choice: str, dx: num, dy: num, dw: num, dh: num, index: num, parent: str, name: str, kind: str, text: str, asset: str, preset: str, duration: num, easing: str }, ['op']),
  },
  design_flow: {
    name: 'design_flow',
    description: 'Screen flows (wires): list, or add {node, trigger:click|longpress|swipe|change, action:navigate|toggleDropdown|openModal|back|setState, target screen, transition, duration, easing, items?}, update {id, …}, remove {id}. Written into the project\'s own code.',
    parameters: S({ action: str, id: str, node: str, trigger: str, do: str, target: str, transition: str, duration: num, easing: str, items: { type: 'array', items: { type: 'object' } } }, ['action']),
  },
  design_interact: {
    name: 'design_interact',
    description: 'Drive the preview with a virtual cursor and keyboard (never the real desktop). steps: [{action:click|tap|hover|longpress|type|press|scroll|drag|swipe|wait|goto, target:node id|{selector}|{text}, text, key, dx, dy, to, ms, url}]. Returns per step: url, DOM changes, console errors; a screenshot path to read_file.',
    parameters: S({ screen: str, steps: { type: 'array', items: { type: 'object' } }, screenshots: str }, ['steps']),
  },
  design_snapshot: {
    name: 'design_snapshot',
    description: 'Design\'s undo stack (file patches, not commits): list, undo, redo, restore {id}.',
    parameters: S({ action: str, id: str }, ['action']),
  },
};

const NAMES = Object.keys(SCHEMAS);
const MUTATES = { design_inspect: false, design_edit: true, design_flow: true, design_interact: false, design_snapshot: true };

/** Bytes of the five schemas as sent (JSON). */
function schemaBytes() { return Buffer.byteLength(JSON.stringify(NAMES.map((n) => SCHEMAS[n]))); }

// ---- running -----------------------------------------------------------------------------------------------------

function line(r) {
  if (!r) return 'nothing happened';
  if (r.ok === false) {
    if (r.needs && r.needs.scope) return `QUESTION: ${r.needs.scope.question} Repeat with scope "all" or "only".`;
    if (r.needs && r.needs.breakpoint) return `QUESTION: ${r.needs.breakpoint.question} Repeat with breakpoint "all" or "only".`;
    if (r.needs && r.needs.instance) return `QUESTION: ${r.needs.instance.question} Repeat with instance "component" (default) or "only".`;
    if (r.needs && r.needs.mapping) return `QUESTION: ${r.needs.mapping.question} Repeat with node set to one of: ${r.needs.mapping.candidates.map((c) => `${c.node} (${c.file}:${c.line})`).join(', ')}.`;
    if (r.reverted) return `NOT KEPT: ${r.why} — the write was undone byte-exact. Alternatives: ${(r.alternatives || []).join(', ')}.`;
    if (r.needs && r.needs.choice) {
      const c = r.needs.choice;
      return `QUESTION: this is a ${c.flexChild ? 'flex/grid child' : 'flow element'}; how should it move? ${c.choices.map((x) => `"${x.id}" (${x.label}${x.index != null ? `, to position ${x.index + 1}` : ''})`).join(', ')}. Default "${c.default}". Repeat with choice.`;
    }
    return `NOT CHANGED: ${r.why}`;
  }
  return r.summary || 'done';
}

function outline(project, screen) {
  const els = project.scanElements(screen);
  if (!els.length) return `${screen}: no layers`;
  const by = new Map(els.map((e) => [e.id, e]));
  const depth = (e) => { let d = 0; let p = e.parent; while (p && by.has(p) && d < 12) { d += 1; p = by.get(p).parent; } return d; };
  const rows = els.slice(0, 220).map((e) => `${'  '.repeat(depth(e))}${e.id} ${e.tag}${e.attrs.id ? `#${e.attrs.id}` : ''}${e.classes.length ? `.${e.classes.join('.')}` : ''}${e.text && e.name !== e.text ? ` "${e.text.slice(0, 40)}"` : (e.name !== e.tag && e.name !== e.attrs.id && !e.classes.includes(e.name) ? ` "${e.name}"` : '')}${e.file !== screen ? `  (${e.file}:${e.line})` : ''}`);
  return `${screen} — ${els.length} layers${els.length > 220 ? ' (first 220)' : ''}:\n${rows.join('\n')}`;
}

async function inspect(design, input) {
  const p = design.project;
  if (p.readOnly) return { output: `READ-ONLY: ${p.why}` };
  if (input.map && typeof input.map === 'object') {
    const screen = input.screen || (p.scanScreens()[0] || {}).file;
    const d = input.map.selector ? await require('./adopt').describe(design, screen, input.map.selector) : null;
    if (!d) return { output: `no element ${input.map.selector || ''} on ${screen} to record a mapping for`, isError: true };
    const f = String(input.map.file || ''); const abs = path.resolve(design.root, f);
    if (!f || !abs.startsWith(design.root + path.sep) || !fs.existsSync(abs)) return { output: `no file ${f} in the project`, isError: true };
    require('./mapper').remember(design.root, require('./mapper').signature(d), { file: path.relative(design.root, abs).replace(/\\/g, '/'), line: input.map.line });
    return { output: `recorded: ${input.map.selector} is rendered at ${f}:${input.map.line || '?'} (tier agent)` };
  }
  if (input.selector && !input.node) {
    const screen = input.screen || (p.scanScreens()[0] || {}).file;
    const m = await design.map(screen, input.selector);
    const lines = [`${input.selector} on ${screen}: tier ${m.tier}${m.file ? ` — ${m.file}:${m.line}` : ''}${m.via ? ` (via ${m.via})` : ''}${m.count > 1 ? ` · rendered ${m.count} times by <${m.component}>` : ''}`];
    if (m.question) lines.push(`ambiguous: ${m.question}`);
    if (m.tier === 'none') lines.push('markup edits for it go to the prompt bar; styles still work (the CSS origin). If you know where it is rendered, record it with map.');
    if (m.node && m.tier !== 'none') input = { ...input, node: m.node };
    else return { output: lines.join('\n') };
    const rest = await inspect(design, { node: m.node });
    return { output: `${lines.join('\n')}\n${rest.output}` };
  }
  if (input.node) {
    const at = p.locate(input.node);
    if (!at) return { output: `no layer ${input.node} — the file may have changed; inspect the screen again`, isError: true };
    const el = at.el;
    const dec = p.declaredFor(at.screen, el);
    const rows = Object.entries(dec).map(([k, v]) => `  ${k}: ${v.value}  (${v.where === 'inline' ? 'inline' : `.${v.cls} ${v.sheet}`})`);
    const plan = p.planStyle(at.screen, el, 'color');
    const target = plan.kind === 'shared' ? `.${plan.cls} is shared by ${plan.uses} — a new style asks "all or only this one?"` : plan.kind === 'scoped' ? `a new class .${plan.cls} in ${plan.sheet}` : plan.kind === 'class' ? `.${plan.cls} in ${plan.sheet}` : plan.kind === 'tailwind' ? 'its Tailwind utilities' : 'its inline style';
    let lay = null;
    try { lay = await design.layout(input.node); } catch (e) { lay = { why: e.message }; }
    const flows = p.scanFlows().filter((w) => w.source.node === input.node);
    return {
      output: [
        `${el.id} <${el.tag}>${el.attrs.id ? ` #${el.attrs.id}` : ''}${el.classes.length ? ` .${el.classes.join(' .')}` : ''} — ${el.file || at.screen}:${el.line}:${el.col}`,
        rows.length ? `declared:\n${rows.join('\n')}` : 'declared: nothing (browser defaults)',
        `a new style goes to: ${target}`,
        lay && lay.rect ? `measured: ${Math.round(lay.rect.x)},${Math.round(lay.rect.y)} ${Math.round(lay.rect.w)}×${Math.round(lay.rect.h)} · position ${lay.position} · parent ${lay.parentDisplay}${lay.flexDirection && /flex/.test(lay.parentDisplay) ? ` ${lay.flexDirection}` : ''}` : `measured: unavailable${lay && lay.why ? ` (${lay.why})` : ''}`,
        flows.length ? `wires from it: ${flows.map((w) => `${w.trigger} → ${w.action} ${w.target || ''}${w.transition && w.transition !== 'none' ? ` (${w.transition})` : ''} [${w.origin}${w.origin === 'design' ? ` ${w.id}` : ''}]`).join('; ')}` : 'wires from it: none',
      ].join('\n'),
    };
  }
  if (input.screen) return { output: outline(p, input.screen) };
  const screens = p.scanScreens();
  const flows = p.scanFlows();
  const snaps = p.snapshots.list();
  return {
    output: [
      `Design · ${p.kind} project · ${screens.length} screen(s):`,
      ...screens.map((s) => `  ${s.file}  "${s.name}"${s.home ? ' (home)' : ''}`),
      `flows: ${flows.length}${flows.length ? '' : ' (none)'}`,
      ...flows.slice(0, 60).map((w) => `  ${w.screen} ${w.source.elementId || w.source.node} ${w.trigger} → ${w.action}${w.target ? ` ${w.target}` : ''}${w.transition && w.transition !== 'none' ? ` (${w.transition})` : ''} [${w.origin}${w.origin === 'design' ? ` ${w.id}` : ''}]`),
      `undo: ${snaps.undo.length}, redo: ${snaps.redo.length}`,
    ].join('\n'),
  };
}

/** The asset path a model gave: inside the project, or an absolute file it points at. */
function assetPath(design, a) {
  if (!a) return null;
  const abs = path.isAbsolute(a) ? a : path.join(design.root, a);
  if (!fs.existsSync(abs)) throw new Error(`no file ${a}`);
  return abs;
}

async function edit(design, input, commit, undo) {
  const op = { ...input };
  if (op.asset) op.asset = assetPath(design, op.asset);
  const r = await design.edit(op, { commit, undo, actor: 'agent' });
  if (!r.ok) return { output: line(r), isError: !r.needs && !r.reverted, question: Boolean(r.needs) };
  if (r.noop) return { output: r.summary };
  const pr = r.proof && r.proof.actual && r.proof.actual.rect ? ` · proved: ${Math.round(r.proof.actual.rect.x)},${Math.round(r.proof.actual.rect.y)} ${Math.round(r.proof.actual.rect.w)}×${Math.round(r.proof.actual.rect.h)}` : r.proof && r.proof.skipped ? ` · not measured (${r.proof.skipped})` : r.proof ? ' · proved in the preview' : '';
  return { output: `${r.summary}${r.followId ? ` [${r.followId}]` : ''}${r.result && r.result.wireId ? ` [wire ${r.result.wireId}]` : ''}${r.tier ? ` · tier ${r.tier}` : ''}${pr}\n${r.diff}`, files: r.files };
}

async function flow(design, input, commit, undo) {
  const a = String(input.action || 'list');
  if (a === 'list') {
    const w = design.project.scanFlows();
    return { output: w.length ? w.map((x) => `${x.origin === 'design' ? x.id : '(code)'} ${x.screen} ${x.source.elementId || x.source.node} ${x.trigger} → ${x.action}${x.target ? ` ${x.target}` : ''}${x.transition && x.transition !== 'none' ? ` (${x.transition}${x.duration ? ` ${x.duration}ms` : ''})` : ''} · ${x.file}:${x.line}`).join('\n') : 'no flows' };
  }
  const map = { add: 'addWire', update: 'updateWire', remove: 'removeWire' };
  if (!map[a]) return { output: `design_flow action is list, add, update or remove — not "${a}"`, isError: true };
  return edit(design, { op: map[a], id: input.id, node: input.node, trigger: input.trigger, action: input.do || (a === 'add' ? 'navigate' : undefined), target: input.target, transition: input.transition, duration: input.duration, easing: input.easing, items: input.items }, commit, undo);
}

async function interact(design, input, { shotsDir } = {}) {
  const steps = Array.isArray(input.steps) ? input.steps.slice(0, 20) : [];
  if (!steps.length) return { output: 'design_interact needs steps', isError: true };
  const screen = input.screen || (design.project.scanScreens()[0] || {}).file || null;
  const res = await design.interact(steps, { screen, screenshots: ['none', 'last', 'each'].includes(input.screenshots) ? input.screenshots : 'last' });
  const out = []; let image = null;
  for (const s of res) {
    let shot = '';
    if (s.screenshot && shotsDir) {
      fs.mkdirSync(shotsDir, { recursive: true });
      const f = path.join(shotsDir, `design-${Date.now().toString(36)}-${s.step}.png`);
      fs.writeFileSync(f, Buffer.isBuffer(s.screenshot) ? s.screenshot : Buffer.from(String(s.screenshot), 'base64'));
      shot = ` · screenshot ${f}`; image = f;
    }
    const ch = s.changes ? `${s.changes.added}+ ${s.changes.removed}- ${s.changes.attributes} attr` : '';
    out.push(`${s.step}. ${s.action}${s.target ? ` ${typeof s.target === 'string' ? s.target : JSON.stringify(s.target)}` : ''}: ${s.ok ? 'ok' : `FAILED ${s.why}`} · ${s.url || ''}${s.navigated ? ' (navigated)' : ''}${ch ? ` · DOM ${ch}` : ''} · ${s.errors && s.errors.length ? `console errors: ${s.errors.join(' | ')}` : 'no console errors'}${shot}`);
  }
  // THE AGENT'S TEST, KEPT WITH ITS LATEST CHANGE CARD (the frames the person can review).
  if (design.lastAgentCard) { try { design.cards().addFrames(design.lastAgentCard, res.map((s) => s.screenshot).filter(Boolean)); } catch { /* the card is a courtesy */ } }
  return { output: `${out.join('\n')}${image ? '\nread_file the screenshot to look.' : ''}`, meta: image ? { image } : undefined, steps: res.map(({ screenshot, ...s }) => s) };
}

async function snapshot(design, input) {
  const a = String(input.action || 'list');
  const p = design.project;
  if (a === 'list') { const l = p.snapshots.list(); return { output: l.undo.length ? l.undo.map((e) => `${e.id} ${new Date(e.at).toISOString().slice(11, 19)} ${e.label} (${e.files.join(', ')})`).join('\n') : 'no Design edits to undo' }; }
  const r = a === 'undo' ? design.undo() : a === 'redo' ? design.redo() : a === 'restore' ? p.restore(input.id) : { ok: false, why: `action is list, undo, redo or restore — not "${a}"` };
  if (!r.ok) return { output: `NOT CHANGED: ${r.why}`, isError: true };
  return { output: a === 'restore' ? `restored: undid ${r.done.length} edit(s)` : `${a === 'undo' ? 'undid' : 'redid'}: ${r.label} (${r.files.join(', ')})` };
}

/**
 * RUN one tool. `commit(result)` writes a computed edit (the host wraps it in its own transaction and guards);
 * `shotsDir` is where screenshots go.
 */
async function run(design, name, input = {}, { commit = (r) => design.commit(r), undo = () => design.undo(), shotsDir = null } = {}) {
  try {
    if (name === 'design_inspect') return await inspect(design, input);
    if (name === 'design_edit') return await edit(design, input, commit, undo);
    if (name === 'design_flow') return await flow(design, input, commit, undo);
    if (name === 'design_interact') return await interact(design, input, { shotsDir });
    if (name === 'design_snapshot') return await snapshot(design, input);
    return { output: `unknown design tool ${name}`, isError: true };
  } catch (e) {
    return { output: `${name} failed: ${(e && e.message) || e}`, isError: true };
  }
}

module.exports = { SCHEMAS, NAMES, MUTATES, schemaBytes, run, line, outline };
