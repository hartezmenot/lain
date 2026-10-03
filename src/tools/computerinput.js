'use strict';

/** MOUSE AND KEYBOARD — the fallback when UI Automation cannot name the thing (a canvas, a game, a custom-drawn app). */

const MAX_TEXT = 2000;
const MAX_STEPS = 20;
const MAX_PER_TURN = 400;

function cmOf(ctx) { return require('../computermcp').forApp(ctx && ctx.app); }
function num(v) { return v == null || v === '' ? null : Number(v); }

/** A turn may send only so many inputs: a model in a loop is stopped by LAIN, not by the person's patience. */
function budget(ctx) {
  const s = (ctx && ctx.session) || (ctx && ctx.app && ctx.app.session) || {};
  const turn = (s.turns || []).length;
  if (s._cuTurn !== turn) { s._cuTurn = turn; s._cuOps = 0; }
  s._cuOps = (s._cuOps || 0) + 1;
  return s._cuOps <= MAX_PER_TURN ? null : `this turn already sent ${MAX_PER_TURN} inputs — stop, look (computer screenshot), and say what is happening`;
}

/**
 * FOCUS_LOST TO LAIN ITSELF (S12b): when what is in front is LAIN's own terminal or window, the target is brought
 * back and the input sent once more — the person did not move the focus, LAIN's own screen did. Any other window in
 * front is the person's, and the refusal stands.
 */
async function refocusIfOwn(ctx, r) {
  if (r.ok || !/^FOCUS_LOST/.test(String(r.why || ''))) return false;
  const cc = require('../computercontrol');
  const t = cc.view(ctx && ctx.app).target;
  if (!t) return false;
  try {
    const a = await cmOf(ctx).call('window.active', {});
    const fg = a.ok && a.result ? a.result.window : null;
    if (!fg || !require('../selfwindows').own(fg)) return false;
    const f = await cmOf(ctx).call('window.focus', { handle: t.handle });
    return Boolean(f.ok && f.result && f.result.focused);
  } catch { return false; }
}

async function send(ctx, op, params, what) {
  const over = budget(ctx);
  if (over) return { output: `REFUSED: ${over}`, isError: true, denied: true };
  let r = await cmOf(ctx).call(op, params);
  if (await refocusIfOwn(ctx, r)) r = await cmOf(ctx).call(op, params);
  if (!r.ok) return { output: `NOT SENT: ${r.why}`, isError: true, denied: Boolean(r.denied) || /^(KILLED|USER_ACTIVE|FOCUS_LOST)/.test(String(r.why || '')) };
  const fg = r.result && r.result.foreground ? ` · in front: ${r.result.foreground.title}` : '';
  return { output: `${what} — delivered${fg}. Unconfirmed until you look (computer screenshot).`, meta: { op, result: r.result } };
}

const P = (props, required = []) => ({ type: 'object', properties: props, required });
const tools = {
  computer_mouse_move: {
    mutates: true,
    schema: { name: 'computer_mouse_move', description: 'Move the pointer: {x,y} to a screen point, or {dx,dy,steps} relatively (what a game reading raw input sees). Locked to the target window.', parameters: P({ x: { type: 'number' }, y: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' }, steps: { type: 'number' } }) },
    run: (i = {}, ctx) => (num(i.dx) != null || num(i.dy) != null
      ? send(ctx, 'mouse.moveRel', { dx: Math.round(num(i.dx) || 0), dy: Math.round(num(i.dy) || 0), steps: Math.max(1, Math.min(60, num(i.steps) || 1)) }, `moved by (${i.dx || 0},${i.dy || 0})`)
      : send(ctx, 'mouse.move', { x: Math.round(num(i.x)), y: Math.round(num(i.y)) }, `moved to (${i.x},${i.y})`)),
  },
  computer_click: {
    mutates: true,
    schema: { name: 'computer_click', description: 'Click at {x,y} (inside the target window), or where the pointer is. button left|right|middle, count 1–3.', parameters: P({ x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, count: { type: 'number' } }) },
    run: (i = {}, ctx) => send(ctx, 'mouse.click', { ...(num(i.x) != null && num(i.y) != null ? { x: Math.round(num(i.x)), y: Math.round(num(i.y)) } : {}), button: i.button || 'left', count: Math.max(1, Math.min(3, num(i.count) || 1)) }, `${i.button || 'left'} click${num(i.x) != null ? ` at (${i.x},${i.y})` : ''}`),
  },
  computer_mouse_button: {
    mutates: true,
    schema: { name: 'computer_mouse_button', description: 'Press (down) or release (up) a mouse button — for a held drag in a canvas or game. Always release what you pressed.', parameters: P({ button: { type: 'string', enum: ['left', 'right', 'middle'] }, action: { type: 'string', enum: ['down', 'up'] } }, ['action']) },
    run: (i = {}, ctx) => send(ctx, 'mouse.button', { button: i.button || 'left', down: i.action === 'down' }, `${i.button || 'left'} button ${i.action}`),
  },
  computer_key: {
    mutates: true,
    schema: { name: 'computer_key', description: 'Press one key (enter, tab, esc, arrows, f1–f12, a letter or digit) in the target window.', parameters: P({ key: { type: 'string' } }, ['key']) },
    run: (i = {}, ctx) => send(ctx, 'keyboard.key', { keys: [String(i.key || '')] }, `key ${i.key}`),
  },
  computer_hotkey: {
    mutates: true,
    schema: { name: 'computer_hotkey', description: 'Press a chord, e.g. ["ctrl","s"]. System chords (win, alt+tab, alt+f4) need FULL; secure-attention and lock keys are never sent.', parameters: P({ keys: { type: 'array', items: { type: 'string' } } }, ['keys']) },
    run: (i = {}, ctx) => send(ctx, 'keyboard.key', { keys: (Array.isArray(i.keys) ? i.keys : []).map(String).slice(0, 5) }, `hotkey ${(i.keys || []).join('+')}`),
  },
  computer_type: {
    mutates: true,
    schema: { name: 'computer_type', description: `Type text (≤ ${MAX_TEXT} characters) into the focused place of the target window. Never into a password field.`, parameters: P({ text: { type: 'string' } }, ['text']) },
    run: (i = {}, ctx) => {
      const text = String(i.text == null ? '' : i.text);
      if (text.length > MAX_TEXT) return { output: `REFUSED: ${text.length} characters is more than ${MAX_TEXT} — type it in parts, or put it in a file`, isError: true };
      return send(ctx, 'keyboard.type', { text }, `typed ${text.length} characters`);
    },
  },
  computer_hold_key: {
    mutates: true,
    schema: { name: 'computer_hold_key', description: 'Hold a key for ms (10–5000) — walking in a game, a long press. The kill switch cuts it short.', parameters: P({ key: { type: 'string' }, ms: { type: 'number' } }, ['key', 'ms']) },
    run: (i = {}, ctx) => send(ctx, 'keyboard.hold', { key: String(i.key || ''), ms: Math.max(10, Math.min(5000, num(i.ms) || 200)) }, `held ${i.key} for ${Math.max(10, Math.min(5000, num(i.ms) || 200))} ms`),
  },
  computer_drag: {
    mutates: true,
    schema: { name: 'computer_drag', description: 'Drag from (fromX,fromY) to (toX,toY) with the left button, inside the target window — or {dx,dy} relatively from where the pointer is.', parameters: P({ fromX: { type: 'number' }, fromY: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' } }) },
    async run(i = {}, ctx) {
      if (num(i.dx) != null || num(i.dy) != null) {
        const steps = [['mouse.button', { button: 'left', down: true }], ['mouse.moveRel', { dx: Math.round(num(i.dx) || 0), dy: Math.round(num(i.dy) || 0), steps: 12 }], ['mouse.button', { button: 'left', down: false }]];
        for (const [op, p] of steps) {
          const r = await send(ctx, op, p, op);
          if (r.isError) { if (op !== 'mouse.button' || p.down) await cmOf(ctx).call('mouse.button', { button: 'left', down: false }).catch(() => {}); return r; }
        }
        return { output: `dragged by (${i.dx || 0},${i.dy || 0}) — delivered. INCONCLUSIVE until observed.` };
      }
      return send(ctx, 'mouse.drag', { fromX: Math.round(num(i.fromX)), fromY: Math.round(num(i.fromY)), toX: Math.round(num(i.toX)), toY: Math.round(num(i.toY)) }, `dragged (${i.fromX},${i.fromY}) → (${i.toX},${i.toY})`);
    },
  },
  computer_scroll: {
    mutates: true,
    schema: { name: 'computer_scroll', description: 'Scroll by clicks (negative = down, ±1–50), at {x,y} inside the target or where the pointer is.', parameters: P({ clicks: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }, ['clicks']) },
    run: (i = {}, ctx) => send(ctx, 'mouse.scroll', { clicks: Math.max(-50, Math.min(50, Math.round(num(i.clicks) || -3))), ...(num(i.x) != null && num(i.y) != null ? { x: Math.round(num(i.x)), y: Math.round(num(i.y)) } : {}) }, `scrolled ${i.clicks}`),
  },
  computer_capture: {
    mutates: false,
    schema: { name: 'computer_capture', description: 'One frame of the target window (or a named window, or the whole screen with window:"screen") as an image file you can read. On demand — never a stream.', parameters: P({ window: { type: 'string' } }) },
    async run(i = {}, ctx) {
      const app = ctx && ctx.app;
      const cc = require('../computercontrol');
      const v = cc.view(app);
      const want = String(i.window || '');
      const screen = want === 'screen';
      // THE WHOLE SCREEN IS SAID WHILE IT IS CAPTURED (S12b): "● Computer · full screen" — FULL only (computercontrol.admit).
      if (screen && v.tier === 'FULL') cc.capturing(app, 'screen');
      let r;
      try {
        r = screen ? await cmOf(ctx).call('screen.capture', {}) : !want && v.target ? await cmOf(ctx).captureWindow({ handle: v.target.handle }) : await cmOf(ctx).call('window.capture', { window: want });
      } finally { if (screen) cc.capturing(app, ''); }
      if (!r.ok) return { output: `NOT CAPTURED: ${r.why}`, isError: true };
      const res = r.result || {};
      // DOWNSCALED TO WHAT THE MODEL NEEDS: long side ≤ cfg.computer.captureMaxSide (1280), the bytes reported.
      const maxSide = Number((((app && app.cfg) || {}).computer || {}).captureMaxSide) || require('../pngscale').DEFAULT_MAX_SIDE;
      const fit = res.path ? require('../pngscale').fit(res.path, { maxSide }) : { scale: 1 };
      const kb = (n) => (n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
      const origin = res.region && res.region.x != null ? res.region : (!screen && v.target && v.target.rect) || { x: 0, y: 0 };
      const size = fit.outWidth ? `${fit.width}×${fit.height}${fit.scaled ? ` → ${fit.outWidth}×${fit.outHeight}` : ''}` : (res.region ? `${res.region.width}×${res.region.height}` : '');
      const bytes = fit.before != null ? ` · ${kb(fit.before)}${fit.scaled ? ` → ${kb(fit.after)}` : ''}` : '';
      const map = fit.scaled ? `screen x = ${origin.x} + image x ÷ ${fit.scale}, screen y = ${origin.y} + image y ÷ ${fit.scale}` : `screen x = ${origin.x} + image x, screen y = ${origin.y} + image y`;
      return {
        output: `captured ${screen ? 'the screen' : `"${(v.target && !want && v.target.title) || want || 'window'}"`} ${size}${bytes} → ${res.path}${res.method ? ` (${res.method})` : ''}. read_file it to look; ${map}.${fit.note ? ` (${fit.note})` : ''}`,
        meta: { image: res.path, capture: { width: fit.width || null, height: fit.height || null, outWidth: fit.outWidth || null, outHeight: fit.outHeight || null, scale: fit.scale, bytesBefore: fit.before ?? null, bytesAfter: fit.after ?? null, origin: { x: origin.x, y: origin.y } } },
      };
    },
  },
  computer_sequence: {
    mutates: true,
    schema: { name: 'computer_sequence', description: `Up to ${MAX_STEPS} input steps in order ([{tool:"computer_key", input:{key:"w"}}, …]); stops at the first one refused (focus lost, the person typing, the kill switch).`, parameters: P({ steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, input: { type: 'object' } } }, maxItems: MAX_STEPS } }, ['steps']) },
    async run(i = {}, ctx) {
      const steps = Array.isArray(i.steps) ? i.steps : [];
      if (!steps.length || steps.length > MAX_STEPS) return { output: `REFUSED: a sequence is 1–${MAX_STEPS} steps`, isError: true };
      const lines = [];
      for (const [k, st] of steps.entries()) {
        const t = tools[st && st.tool];
        if (!t || st.tool === 'computer_sequence') return { output: `REFUSED: step ${k + 1} names "${st && st.tool}", not an input tool — nothing after step ${k} ran`, isError: true };
        const r = await t.run((st && st.input) || {}, ctx);
        lines.push(`${k + 1}. ${st.tool}: ${String(r.output).split('\n')[0].slice(0, 120)}`);
        if (r.isError) return { output: `${lines.join('\n')}\nSTOPPED at step ${k + 1}; ${steps.length - k - 1} not run.`, isError: true, denied: r.denied };
      }
      return { output: `${lines.join('\n')}\n${steps.length} steps delivered. INCONCLUSIVE until observed.` };
    },
  },
};

module.exports = { tools, MAX_TEXT, MAX_STEPS, MAX_PER_TURN };
