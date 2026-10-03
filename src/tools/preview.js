'use strict';

/** THE PREVIEW TOOL — the model tests the project's own frontend INSIDE the LAIN Preview: click, type, scroll, drag, keys. */

const TARGET = {
  type: 'object',
  description: 'what to act on — prefer semantic: the current Selection, a CSS selector, the visible text/label, or a role with a name; x/y (CSS px in the page) only as a last resort',
  properties: {
    selection: { type: 'boolean', description: 'the element the person selected in the Preview' },
    selector: { type: 'string' },
    text: { type: 'string', description: 'visible text, label, aria-label or title — e.g. "Play", "Settings"' },
    role: { type: 'string', enum: ['button', 'link', 'textbox', 'checkbox', 'tab', 'option', 'slider', 'video', 'menuitem'] },
    name: { type: 'string', description: 'with role: its accessible name' },
    x: { type: 'number' }, y: { type: 'number' },
  },
};

function describe(r) {
  if (!r) return 'no answer';
  if (r.ok && r.page) {
    const p = r.page;
    const els = (p.elements || []).map((e) => `  ${e.role} "${e.name}"${e.selector ? ` ${e.selector}` : ''}${e.value != null ? ` = "${e.value}"` : ''}${e.disabled ? ' (disabled)' : ''}`);
    return [`page ${p.url}${p.title ? ` — ${p.title}` : ''}`, '', 'visible text:', p.text || '(none)', '', `interactive elements (${els.length}${p.more ? `, ${p.more} more` : ''}):`, ...els].join('\n');
  }
  const t = r.target ? `${r.target.tag}${r.target.name ? ` "${r.target.name}"` : ''}${r.target.selector ? ` (${r.target.selector})` : ''}` : '';
  const bits = [];
  if (r.ok) bits.push(`done${t ? ` on ${t}` : ''}`); else bits.push(`${r.refused ? 'REFUSED' : r.yielded ? 'YIELDED' : 'FAILED'}: ${r.why}${t ? ` (${t})` : ''}`);
  if (r.dropped) bits.push(`dropped on ${r.dropped.tag}${r.dropped.selector ? ` (${r.dropped.selector})` : ''}`);
  if (r.scrolled) bits.push(`scrolled ${r.scrolled.from.y}→${r.scrolled.to.y}`);
  if (r.value != null) bits.push(`value now "${r.value}"`);
  if (r.url) { try { const u = new URL(r.url); bits.push(`page ${u.pathname}${u.search}${u.hash}${r.title ? ` — ${r.title}` : ''}`); } catch { bits.push(`page ${r.url}`); } }
  if (r.focused) bits.push(`focus: ${r.focused.tag}${r.focused.name ? ` "${r.focused.name}"` : ''}`);
  if (r.dialogs && r.dialogs.length) bits.push(`the page opened ${r.dialogs.map((d) => `a ${d.kind} ("${d.text}")`).join(', ')} — dismissed, not answered; tell the person if it matters`);
  return bits.join(' · ');
}

async function perform(ctx, action) {
  const app = ctx && ctx.app;
  if (!app) return { output: 'the Preview tools need a running LAIN session', isError: true };
  // THE SELECTION the person made becomes a selector (never a guess).
  if (action.target && action.target.selection) {
    let sel = null; try { sel = require('../harnesscontext').selection(app, app.session); } catch { sel = null; }
    const selector = sel && sel.visual && (sel.visual.selector || (sel.visual.element && sel.visual.element.selector));
    if (!selector) return { output: 'nothing is selected in the Preview — ask the person to select it, or name a selector or text', isError: true };
    action.target = { selector };
  }
  const surface = require('../workshop/previewsurface');
  const open = await surface.ensure(app, { reason: 'the model is testing the page' });
  if (!open.ok) return { output: `the Preview is not open and could not be opened: ${open.why}`, isError: true };
  const r = await require('../workshop/previewinput').run(app, action);
  return { output: describe(r), isError: !r.ok, meta: { preview: r } };
}

const ACTIONS = ['read', 'click', 'double_click', 'move', 'down', 'up', 'drag', 'scroll', 'key', 'chord', 'type'];

/** One action → what workshop/previewinput.js performs. */
function toAction(i) {
  const t = i.target || {};
  switch (i.action) {
    case 'read': return { action: 'read', target: i.target || null };
    case 'click': return { action: 'click', target: t };
    case 'double_click': return { action: 'double_click', target: t };
    case 'move': return { action: 'pointer_move', target: t };
    case 'down': return { action: 'pointer_down', target: t };
    case 'up': return { action: 'pointer_up', target: t };
    case 'drag': return { action: 'drag', target: t, to: i.to };
    case 'scroll': return { action: 'scroll', target: t, dy: i.dy, dx: i.dx, to: i.edge };
    case 'key': return { action: 'key', key: i.key };
    case 'chord': return { action: 'key_chord', keys: i.keys };
    case 'type': return { action: 'type_text', target: t, text: i.text, replace: Boolean(i.replace) };
    default: return null;
  }
}

/** THE ONE PREVIEW TOOL (S9): the project's own page in the LAIN Preview — read it, click, type, scroll, drag, keys. */
const tools = {
  preview: {
    mutates: false,
    schema: {
      name: 'preview',
      description: 'Test the project\'s own page in the LAIN Preview: `read` (address, visible text, interactive elements) to see it; '
        + 'click, double_click, move, down/up, drag, scroll, key, chord ("Ctrl+S"), type (never a password). Prefer target text/selector/role over x/y. '
        + 'Only inside the Preview — a file picker, download or new window is refused.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTIONS },
          target: TARGET,
          to: { type: 'object', description: 'drag: an element (selector/text/role), or dx/dy, or x/y', properties: { selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } } },
          dy: { type: 'number' }, dx: { type: 'number' },
          edge: { type: 'string', enum: ['top', 'bottom'], description: 'scroll to the top or bottom' },
          key: { type: 'string' }, keys: { type: 'string' },
          text: { type: 'string' }, replace: { type: 'boolean' },
        },
        required: ['action'],
      },
    },
    run(input, ctx) {
      const action = toAction(input || {});
      if (!action) return { output: `unknown preview action "${input && input.action}" — one of ${ACTIONS.join(', ')}`, isError: true };
      return perform(ctx, action);
    },
  },
};

module.exports = { tools, describe };
