'use strict';

/**
 * PREVIEW POINTER AND KEYBOARD TOOLS (packaging pass §L) — the model tests the project's own frontend INSIDE the
 * Noema Preview: click, type, scroll, drag, keys. Never the person's browser, never the desktop, never another app.
 * See workshop/previewinput.js for the path an action takes and bridge.js for what the page refuses.
 */

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
  if (!app) return { output: 'the Preview tools need a running Noema session', isError: true };
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

function tool(name, description, properties, required, toAction) {
  return {
    mutates: false,
    schema: { name, description, parameters: { type: 'object', properties, required } },
    run: (input, ctx) => perform(ctx, toAction(input || {})),
  };
}

const tools = {
  preview_pointer_move: tool('preview_pointer_move', 'Move the Preview pointer onto an element (hover) — inside the Noema Preview only.', { target: TARGET }, ['target'], (i) => ({ action: 'pointer_move', target: i.target })),
  preview_click: tool('preview_click', 'Click an element in the Noema Preview (the project page). Prefer target.text/selector/role over x/y. Refused if it would leave the Preview (file picker, download, another site, new window).', { target: TARGET }, ['target'], (i) => ({ action: 'click', target: i.target })),
  preview_double_click: tool('preview_double_click', 'Double-click an element in the Noema Preview.', { target: TARGET }, ['target'], (i) => ({ action: 'double_click', target: i.target })),
  preview_pointer_down: tool('preview_pointer_down', 'Press the Preview pointer on an element (for custom drag logic; pair with preview_pointer_up).', { target: TARGET }, ['target'], (i) => ({ action: 'pointer_down', target: i.target })),
  preview_pointer_up: tool('preview_pointer_up', 'Release the Preview pointer on an element.', { target: TARGET }, ['target'], (i) => ({ action: 'pointer_up', target: i.target })),
  preview_drag: tool('preview_drag', 'Drag from an element to another element or by an offset, inside the Noema Preview (sliders, sortable lists, resize handles).', {
    target: TARGET,
    to: { type: 'object', description: 'where to drop: an element (selector/text/role) or dx/dy CSS px from the start, or x/y', properties: { selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } } },
  }, ['target', 'to'], (i) => ({ action: 'drag', target: i.target, to: i.to })),
  preview_scroll: tool('preview_scroll', 'Scroll the Preview page (or a scrollable element) by dy/dx CSS px, or to "top"/"bottom".', {
    target: TARGET, dy: { type: 'number' }, dx: { type: 'number' }, to: { type: 'string', enum: ['top', 'bottom'] },
  }, [], (i) => ({ action: 'scroll', target: i.target || {}, dy: i.dy, dx: i.dx, to: i.to })),
  preview_key: tool('preview_key', 'Press one key in the Noema Preview on the focused element: Enter, Tab, Escape, Space, Backspace, ArrowUp/Down/Left/Right, Home, End, PageUp/Down, F1–F12, or one character.', {
    key: { type: 'string' },
  }, ['key'], (i) => ({ action: 'key', key: i.key })),
  preview_key_chord: tool('preview_key_chord', 'Press a key chord in the Noema Preview, e.g. "Ctrl+S", "Shift+Tab", "Ctrl+Shift+K". Delivered to the page only — never to Windows or another app.', {
    keys: { type: 'string' },
  }, ['keys'], (i) => ({ action: 'key_chord', keys: i.keys })),
  // WHAT IS ON THE PAGE, as text — how a model without vision sees the result of what it did.
  preview_read: tool('preview_read', 'Read the Noema Preview page as text: its address, title, visible text, and the interactive elements (role, name, selector, field values — never a password). Changes nothing. Use it before acting and to check the result after.', {
    target: { ...TARGET, description: 'optional: read only inside this element (selector or visible text)' },
  }, [], (i) => ({ action: 'read', target: i.target || null })),
  preview_type_text: tool('preview_type_text', 'Type text into a field in the Noema Preview (target it, or the focused one). Never a password or other credential — those are the person\'s to enter.', {
    target: TARGET, text: { type: 'string' }, replace: { type: 'boolean', description: 'replace the field\'s current text' },
  }, ['text'], (i) => ({ action: 'type_text', target: i.target || {}, text: i.text, replace: Boolean(i.replace) })),
};

module.exports = { tools, describe };
