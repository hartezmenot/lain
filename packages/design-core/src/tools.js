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
    description: 'The design project: no args → screens, flows, undo stack; `screen` → its layers (id, tag, name); `node` → its source, declared styles, where a style edit would go, measured layout.',
    parameters: S({ screen: str, node: str }),
  },
  design_edit: {
    name: 'design_edit',
    description: 'One deterministic source edit on a layer, written behind the stale-edit guard and undoable. op: setStyle{props:{css-prop:value|null}} move{dx,dy,choice?} resize{dw,dh} reorder{index} insert{parent,index?,name,kind:button|text|image|container,text?,asset?} remove setText{text} setAsset{asset} setAnimation{preset,duration?,easing?}. A shared class answers with a question: repeat with scope "all"|"only". A flex/grid child move answers with choices: repeat with choice.',
    parameters: S({ op: str, node: str, props: { type: 'object' }, scope: str, choice: str, dx: num, dy: num, dw: num, dh: num, index: num, parent: str, name: str, kind: str, text: str, asset: str, preset: str, duration: num, easing: str }, ['op']),
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

async function edit(design, input, commit) {
  const op = { ...input };
  if (op.asset) op.asset = assetPath(design, op.asset);
  if ((op.op === 'move' || op.op === 'resize') && !op.layout) {
    try { op.layout = await design.layout(op.node); } catch (e) { return { output: `NOT CHANGED: the layer could not be measured in the preview (${e.message})`, isError: true }; }
    if (!op.layout) return { output: `NOT CHANGED: ${op.node} is not on the page to measure — inspect the screen again`, isError: true };
  }
  const r = design.project.applyEdit(op);
  if (!r.ok) return { output: line(r), isError: !r.needs, question: Boolean(r.needs) };
  const c = await commit(r);
  if (!c.ok) return { output: `NOT CHANGED: ${c.why}`, isError: true, stale: Boolean(c.stale) };
  return { output: `${line(r)}${c.followId ? ` [${c.followId}]` : ''}${r.wireId ? ` [wire ${r.wireId}]` : ''}\n${r.diff}`, files: c.files };
}

async function flow(design, input, commit) {
  const a = String(input.action || 'list');
  if (a === 'list') {
    const w = design.project.scanFlows();
    return { output: w.length ? w.map((x) => `${x.origin === 'design' ? x.id : '(code)'} ${x.screen} ${x.source.elementId || x.source.node} ${x.trigger} → ${x.action}${x.target ? ` ${x.target}` : ''}${x.transition && x.transition !== 'none' ? ` (${x.transition}${x.duration ? ` ${x.duration}ms` : ''})` : ''} · ${x.file}:${x.line}`).join('\n') : 'no flows' };
  }
  const map = { add: 'addWire', update: 'updateWire', remove: 'removeWire' };
  if (!map[a]) return { output: `design_flow action is list, add, update or remove — not "${a}"`, isError: true };
  return edit(design, { op: map[a], id: input.id, node: input.node, trigger: input.trigger, action: input.do || (a === 'add' ? 'navigate' : undefined), target: input.target, transition: input.transition, duration: input.duration, easing: input.easing, items: input.items }, commit);
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
async function run(design, name, input = {}, { commit = (r) => design.commit(r), shotsDir = null } = {}) {
  try {
    if (name === 'design_inspect') return await inspect(design, input);
    if (name === 'design_edit') return await edit(design, input, commit);
    if (name === 'design_flow') return await flow(design, input, commit);
    if (name === 'design_interact') return await interact(design, input, { shotsDir });
    if (name === 'design_snapshot') return await snapshot(design, input);
    return { output: `unknown design tool ${name}`, isError: true };
  } catch (e) {
    return { output: `${name} failed: ${(e && e.message) || e}`, isError: true };
  }
}

module.exports = { SCHEMAS, NAMES, MUTATES, schemaBytes, run, line, outline };
