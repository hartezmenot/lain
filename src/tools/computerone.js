'use strict';

/** ONE COMPUTER TOOL (Simplify S5.1): `computer({action, …})`, the shape of Anthropic's computer use, in place of twelve `computer_*` tools. */

const input = () => require('./computerinput').tools;

const ACTIONS = ['windows', 'target', 'launch', 'screenshot', 'click', 'double_click', 'move', 'drag', 'scroll', 'type', 'key', 'hotkey', 'hold_key', 'mouse_button', 'sequence'];
const READS = new Set(['windows', 'screenshot']);

const schema = {
  name: 'computer',
  description: 'Use this desktop (Computer Control): look, then act on the target window. `windows` lists windows with their handles; '
    + '`target` makes a window (title or handle) the target and brings it to the front; `launch` starts an app (a name like calc, or a path) '
    + 'and makes its window the target; `screenshot` captures the target as an image to read_file (the result says how image pixels map to '
    + 'screen x/y for click). Input is locked to the target window, and the person\'s own input, the kill switch and password/UAC prompts '
    + 'always win. A delivered input is unconfirmed until you look again.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      window: { type: 'string', description: 'a window handle (from `windows`) or title; "screen" for the whole screen (FULL only)' },
      app: { type: 'string', description: 'launch: an app name (calc, notepad) or a path' },
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

/** THE WINDOWS NOW, as the model sees them: sensitive surfaces and LAIN's own windows are not offered. */
async function windowsNow(ctx) {
  const r = await require('../computermcp').forApp(ctx && ctx.app).windows();
  if (!r.ok) return { ok: false, why: r.why, list: [] };
  const cc = require('../computercontrol');
  return { ok: true, list: (r.result.windows || []).filter((w) => !cc.sensitive(w) && !own(w)) };
}
const rowOf = (w) => `${w.handle}  "${w.title}" · ${w.process || '?'}${w.foreground ? ' · in front' : ''}${w.minimized ? ' · minimized' : ''}`;
const listOf = (list, n = 12) => list.slice(0, n).map(rowOf).join('\n') || '(no windows)';

/** IN AUTO THE MODEL PICKS THE TARGET (S5, S12b); anywhere else it is the person's choice. */
function autoOnly(ctx, what) {
  const app = ctx && ctx.app;
  if (!app || require('../execmode').effective(app, ctx.session) === 'AUTO') return null;
  return { output: `NOT ${what}: in this permission mode the person picks the target window (/computer target <window>, or Target in the Harness). In Auto you may.`, isError: true, denied: true };
}

/** `target`: a window by handle or title — the usual refusals, then the focus lock holds that exact window. */
async function target(i, ctx) {
  const refused = autoOnly(ctx, 'TARGETED'); if (refused) return refused;
  const want = String(i.window || '').trim();
  if (!want) return { output: 'target needs `window`: a handle or a title from `windows`', isError: true };
  const now = await windowsNow(ctx);
  if (!now.ok) return { output: `NOT TARGETED: ${now.why}`, isError: true };
  const all = await require('../computermcp').forApp(ctx.app).windows();
  const every = all.ok ? all.result.windows || [] : [];
  let hits;
  if (/^\d+$/.test(want)) hits = every.filter((w) => Number(w.handle) === Number(want));
  else {
    const low = want.toLowerCase();
    const exact = every.filter((w) => String(w.title || '').toLowerCase() === low);
    hits = exact.length ? exact : every.filter((w) => String(w.title || '').toLowerCase().includes(low));
  }
  if (!hits.length) return { output: `NOT TARGETED: no window matches "${want}". Windows now:\n${listOf(now.list)}`, isError: true };
  if (hits.length > 1) return { output: `NOT TARGETED: ${hits.length} windows match "${want}" — name one by handle:\n${listOf(hits.filter((w) => !own(w)))}`, isError: true };
  const w = hits[0];
  if (own(w)) return { output: `NOT TARGETED: "${w.title}" is LAIN's own window`, isError: true, denied: true };
  const cc = require('../computercontrol');
  const r = await cc.setTarget(ctx.app, { handle: w.handle });
  if (!r.ok) return { output: `NOT TARGETED: ${r.why}`, isError: true, denied: true };
  const line = `Computer target → "${w.title}" (${w.process || '?'} · handle ${w.handle})`;
  try { if (ctx.app.ui && ctx.app.ui.enabled) ctx.app.ui.noteSystem(line, 'info'); else ctx.app.render.notice('info', line); } catch { /* the header shows it too */ }
  return { output: `${line} — in front, input is locked to it. Look with screenshot.` };
}

/**
 * `launch`: start an app and make its main window the target, so the shell is never needed for that (S12b). Started
 * through the process authority (computermcp.openApp — owned, listed by /ps, cleaned up with the session) when there is
 * one; otherwise with the system's own `start`. Its window is the new one that appears.
 */
async function launch(i, ctx, { waitMs = 15000 } = {}) {
  const refused = autoOnly(ctx, 'LAUNCHED'); if (refused) return refused;
  const what = String(i.app || i.window || '').trim();
  if (!what) return { output: 'launch needs `app`: a name (calc, notepad) or a path', isError: true };
  if (/[\r\n"&|<>^%]/.test(what)) return { output: 'launch takes one app name or path — no command line', isError: true };
  if (process.platform !== 'win32') return { output: 'launch is Windows-only (the desktop bridge)', isError: true };
  const cm = require('../computermcp').forApp(ctx.app);
  const before = await cm.windows();
  if (!before.ok) return { output: `NOT LAUNCHED: ${before.why}`, isError: true };
  const known = new Set((before.result.windows || []).map((w) => Number(w.handle)));
  const t0 = Date.now();
  const opened = await cm.openApp(what, { name: what, timeoutMs: Math.min(5000, waitMs) }).catch((e) => ({ ok: false, why: e.message }));
  if (!opened.ok) {
    if (!/no process authority/.test(String(opened.why || ''))) return { output: `NOT LAUNCHED: ${opened.why}`, isError: true };
    try {
      const child = require('child_process').spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${what}"`], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {}); child.unref();
    } catch (e) { return { output: `NOT LAUNCHED: ${e.message}`, isError: true }; }
  }
  let main = opened.ok && opened.handle ? { handle: opened.handle } : null;
  while (!main && Date.now() - t0 < waitMs) {
    const now = await cm.windows();
    const fresh = now.ok ? (now.result.windows || []).filter((w) => !known.has(Number(w.handle)) && String(w.title || '').trim() && !own(w)) : [];
    main = fresh.find((w) => w.foreground) || fresh[0] || null;
    if (!main) await new Promise((res) => setTimeout(res, 400));
  }
  if (!main) return { output: `LAUNCHED "${what}", but no new window appeared within ${Math.round(waitMs / 1000)} s — look with \`windows\`, then \`target\` it.`, isError: true };
  const t = await target({ window: String(main.handle) }, ctx);
  return t.isError ? t : { output: `LAUNCHED "${what}" → ${t.output}` };
}

/** THE TARGET DISAPPEARED (S12b): one line and the windows there are now — an observation, not a refusal to repeat. */
async function targetGone(ctx) {
  const cc = require('../computercontrol');
  const t = cc.view(ctx && ctx.app).target;
  if (!t) return null;
  const all = await require('../computermcp').forApp(ctx.app).windows();
  if (!all.ok || (all.result.windows || []).some((w) => Number(w.handle) === Number(t.handle))) return null;
  cc.dropTarget(ctx.app);
  const now = await windowsNow(ctx);
  return { output: `TARGET GONE: "${t.title}" (handle ${t.handle}) is no longer open. Windows now:\n${listOf(now.list)}\nChoose one with target, or launch the app again.`, isError: true };
}

/** One action, through the guarded input tool it always used. */
async function act(i, ctx) {
  const t = input();
  const a = String(i.action || '');
  switch (a) {
    case 'windows': {
      // A READ: handle, process and title — sensitive surfaces and LAIN's own windows are not offered (S5.2).
      const now = await windowsNow(ctx);
      if (!now.ok) return { output: `NOT LISTED: ${now.why}`, isError: true };
      return { output: listOf(now.list, 200) };
    }
    case 'target': return target(i, ctx);
    case 'launch': return launch(i, ctx);
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
  if (i.action !== 'target' && i.action !== 'launch') { const picked = await pick(ctx, i.window); if (picked) return picked; }
  if (i.action !== 'sequence') {
    const r = await act(i, ctx);
    return r.isError && i.action !== 'windows' && i.action !== 'target' && i.action !== 'launch' ? ((await targetGone(ctx)) || r) : r;
  }
  const steps = Array.isArray(i.steps) ? i.steps : [];
  if (!steps.length || steps.length > 20) return { output: 'REFUSED: a sequence is 1–20 steps', isError: true };
  const lines = [];
  for (const [k, st] of steps.entries()) {
    if (!st || st.action === 'sequence' || st.action === 'windows' || st.action === 'target' || st.action === 'launch') return { output: `REFUSED: step ${k + 1} is not an input action — nothing after step ${k} ran`, isError: true };
    const r = await act(st, ctx);
    lines.push(`${k + 1}. ${st.action}: ${String(r.output).split('\n')[0].slice(0, 120)}`);
    if (r.isError) { const gone = await targetGone(ctx); return { output: `${lines.join('\n')}\nSTOPPED at step ${k + 1}; ${steps.length - k - 1} not run.${gone ? `\n${gone.output}` : ''}`, isError: true, denied: gone ? false : r.denied }; }
  }
  return { output: `${lines.join('\n')}\n${steps.length} steps delivered. Unconfirmed until you look.` };
}

/** Does this call only look? */
function reads(i) { return READS.has(String((i && i.action) || '')); }

module.exports = { tools: { computer: { mutates: true, schema, run } }, ACTIONS, reads, own, target, launch, targetGone };
