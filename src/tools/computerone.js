'use strict';

/**
 * ONE COMPUTER TOOL (Simplify S5.1): `computer({action, …})`, the shape of Anthropic's computer use, in place of twelve
 * `computer_*` tools. Every action runs the same guarded implementation as before (tools/computerinput.js →
 * computermcp.call → computercontrol.admit → the bridge): the exact-window lock, the person's input pausing, the kill
 * switch, password/credential/UAC refusal and the header indicator are untouched. The accessibility-tree tool is
 * `computer_ui`, found with tool_search.
 *
 * In Auto, `window` given as an exact window handle picks the target (after the same refusals, and never one of
 * LAIN's own windows); switching target is a new pick and says so on the activity line.
 */

const input = () => require('./computerinput').tools;

const ACTIONS = ['windows', 'screenshot', 'click', 'double_click', 'move', 'drag', 'scroll', 'type', 'key', 'hotkey', 'hold_key', 'mouse_button', 'sequence'];
const READS = new Set(['windows', 'screenshot']);

const schema = {
  name: 'computer',
  description: 'Use this desktop (Computer Control): look, then act on the target window. `windows` lists windows with their handles; '
    + '`screenshot` captures the target (or `window`, or "screen") as an image to read_file. Input is locked to the target window, and '
    + 'the person\'s own input, the kill switch and password/UAC prompts always win. A delivered input is unconfirmed until you look again.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      window: { type: 'string', description: 'a window handle (from `windows`) or title; "screen" for the whole screen' },
      x: { type: 'number' }, y: { type: 'number' },
      to_x: { type: 'number', description: 'drag end' }, to_y: { type: 'number' },
      dx: { type: 'number', description: 'relative move/drag' }, dy: { type: 'number' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      state: { type: 'string', enum: ['down', 'up'], description: 'mouse_button' },
      clicks: { type: 'number', description: 'scroll; negative is down' },
      text: { type: 'string' },
      key: { type: 'string' },
      keys: { type: 'array', items: { type: 'string' }, description: 'hotkey chord' },
      ms: { type: 'number', description: 'hold_key duration' },
      steps: { type: 'array', items: { type: 'object' }, description: 'sequence: up to 20 {action, …}' },
    },
    required: ['action'],
  },
};

/** LAIN's own windows: the Harness host and the terminal hosting this CLI (selfwindows.js). */
const own = (w) => require('../selfwindows').own(w);

/** AUTO picks the target by exact handle; anywhere else the person picks it. */
async function pick(ctx, window) {
  const app = ctx && ctx.app;
  const handle = /^\d+$/.test(String(window || '').trim()) ? Number(window) : null;
  if (handle == null || !app) return null;
  const cc = require('../computercontrol');
  if (require('../execmode').effective(app, ctx.session) !== 'AUTO') return null;
  const cur = cc.view(app).target;
  if (cur && Number(cur.handle) === handle) return null;
  const list = await require('../computermcp').forApp(app).windows();
  const w = list && list.ok ? (list.result.windows || []).find((x) => Number(x.handle) === handle) : null;
  if (!w) return { output: `NOT TARGETED: no window with handle ${handle} — \`windows\` lists them`, isError: true, denied: true };
  if (own(w)) return { output: `NOT TARGETED: "${w.title}" is LAIN's own window`, isError: true, denied: true };
  const r = await cc.setTarget(app, { handle });
  if (!r.ok) return { output: `NOT TARGETED: ${r.why}`, isError: true, denied: true };
  const line = `Computer target → "${w.title}" (${w.process || '?'} · handle ${handle})`;
  try { if (app.ui && app.ui.enabled) app.ui.noteSystem(line, 'info'); else app.render.notice('info', line); } catch { /* the header shows it too */ }
  return null;
}

/** One action, through the guarded input tool it always used. */
async function act(i, ctx) {
  const t = input();
  const a = String(i.action || '');
  switch (a) {
    case 'windows': {
      const r = await require('../computermcp').forApp(ctx && ctx.app).windows();
      if (!r.ok) return { output: `NOT LISTED: ${r.why}`, isError: true };
      // A READ: handle, process and title — sensitive surfaces and LAIN's own windows are not offered (S5.2).
      const cc = require('../computercontrol');
      return { output: (r.result.windows || []).filter((w) => !cc.sensitive(w) && !own(w)).map((w) => `${w.handle}  "${w.title}" · ${w.process || '?'}${w.foreground ? ' · in front' : ''}${w.minimized ? ' · minimized' : ''}`).join('\n') || '(no windows)' };
    }
    case 'screenshot': return t.computer_capture.run({ window: /^\d+$/.test(String(i.window || '')) ? '' : i.window }, ctx);
    case 'click': return t.computer_click.run({ x: i.x, y: i.y, button: i.button, count: 1 }, ctx);
    case 'double_click': return t.computer_click.run({ x: i.x, y: i.y, button: i.button, count: 2 }, ctx);
    case 'move': return t.computer_mouse_move.run({ x: i.x, y: i.y, dx: i.dx, dy: i.dy }, ctx);
    case 'drag': return t.computer_drag.run({ fromX: i.x, fromY: i.y, toX: i.to_x, toY: i.to_y, dx: i.dx, dy: i.dy }, ctx);
    case 'scroll': return t.computer_scroll.run({ clicks: i.clicks, x: i.x, y: i.y }, ctx);
    case 'type': return t.computer_type.run({ text: i.text }, ctx);
    case 'key': return t.computer_key.run({ key: i.key }, ctx);
    case 'hotkey': return t.computer_hotkey.run({ keys: i.keys }, ctx);
    case 'hold_key': return t.computer_hold_key.run({ key: i.key, ms: i.ms }, ctx);
    case 'mouse_button': return t.computer_mouse_button.run({ button: i.button, action: i.state }, ctx);
    default: return { output: `unknown action "${a}" — one of ${ACTIONS.join(', ')}`, isError: true };
  }
}

async function run(i = {}, ctx) {
  const picked = await pick(ctx, i.window);
  if (picked) return picked;
  if (i.action !== 'sequence') return act(i, ctx);
  const steps = Array.isArray(i.steps) ? i.steps : [];
  if (!steps.length || steps.length > 20) return { output: 'REFUSED: a sequence is 1–20 steps', isError: true };
  const lines = [];
  for (const [k, st] of steps.entries()) {
    if (!st || st.action === 'sequence' || st.action === 'windows') return { output: `REFUSED: step ${k + 1} is not an input action — nothing after step ${k} ran`, isError: true };
    const r = await act(st, ctx);
    lines.push(`${k + 1}. ${st.action}: ${String(r.output).split('\n')[0].slice(0, 120)}`);
    if (r.isError) return { output: `${lines.join('\n')}\nSTOPPED at step ${k + 1}; ${steps.length - k - 1} not run.`, isError: true, denied: r.denied };
  }
  return { output: `${lines.join('\n')}\n${steps.length} steps delivered. Unconfirmed until you look.` };
}

/** Does this call only look? */
function reads(i) { return READS.has(String((i && i.action) || '')); }

module.exports = { tools: { computer: { mutates: true, schema, run } }, ACTIONS, reads, own };
