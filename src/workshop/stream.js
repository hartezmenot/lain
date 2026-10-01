'use strict';

/**
 * THE PREVIEW, LIVE AND INTERACTIVE (Phase 8.2).
 *
 * The Workshop showed SCREENSHOTS of the project's page: a person could look,
 * never click, type, scroll or navigate — and dragging the picture dragged a
 * copy of the image. Now the same page LAIN observes streams its frames
 * (CDP `Page.startScreencast` — a frame when the page repaints, not a poll of
 * the whole page) and the window's pointer, wheel and keys are delivered to it
 * (`Input.dispatch*`). One page: what a person clicks is what LAIN reads, so
 * "the page on screen" is always the page a change request targets.
 *
 *   start(session)            begin streaming (idempotent)
 *   stop(session)
 *   frame(session, since)     the newest frame after "since", or { unchanged }
 *   input(session, events)    move · down · up · wheel · key · text, in order
 *   hover(session, x, y)      the element under a point: rect + a short label (Pick mode)
 *   url(session)              where the page is now
 *
 * NOTHING HERE CHANGES THE PAGE'S DOM. Pick mode's outline is drawn by the
 * window over the frame; the element under the pointer is only read.
 *
 * COORDINATES ARE THE PAGE'S CSS PIXELS — the space `elementFromPoint`,
 * `getBoundingClientRect` and CDP input share. A frame is DEVICE pixels (a
 * phone at 3×, a zoomed-out page at 0.5), so every frame carries `css`: the
 * visual viewport in CSS pixels (Page.getLayoutMetrics), read again whenever
 * the frame's geometry changes. The window maps pointer → CSS through it.
 */

const streams = new WeakMap();   // BrowserSession -> { on, seq, frame, meta, url, at, off }

function st(session) { return streams.get(session) || null; }

async function start(session, { quality = 72, maxWidth = 1920, maxHeight = 1600 } = {}) {
  if (!session || !session.conn || !session.conn.open) return { ok: false, why: 'the preview page is not open' };
  let s = st(session);
  if (s && s.on) return { ok: true, already: true };
  s = { on: true, seq: 0, frame: null, meta: null, css: null, geo: '', url: session.url || null, at: 0, off: null };
  streams.set(session, s);
  s.off = session.conn.on((method, params) => {
    if (method === 'Page.screencastFrame') {
      s.seq += 1; s.frame = params.data; s.meta = params.metadata || null; s.at = Date.now();
      // THE FRAME'S GEOMETRY MOVED (a viewport switch, a zoom, a scroll): re-read the CSS viewport.
      const m = s.meta || {};
      const geo = [m.deviceWidth, m.deviceHeight, m.pageScaleFactor, m.scrollOffsetX, m.scrollOffsetY].join(',');
      if (geo !== s.geo) { s.geo = geo; layout(session, s); }
      // EVERY FRAME IS ACKNOWLEDGED, or Chromium stops sending them.
      session.conn.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    } else if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
      s.url = params.frame.url; session.url = params.frame.url;
    } else if (method === 'Page.navigatedWithinDocument' && params.url) {
      s.url = params.url; session.url = params.url;
    }
  });
  try {
    await session.conn.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame: 1 });
  } catch (e) {
    s.on = false;
    if (s.off) s.off();
    return { ok: false, why: `the preview could not stream: ${(e && e.message) || e}` };
  }
  return { ok: true };
}

async function stop(session) {
  const s = st(session);
  if (!s || !s.on) return { ok: true };
  s.on = false;
  if (s.off) s.off();
  try { await session.conn.send('Page.stopScreencast'); } catch { /* the page may be gone */ }
  return { ok: true };
}

/** The visual viewport in CSS pixels — what a frame shows, in the page's own units. */
async function layout(session, s) {
  try {
    const r = await session.conn.send('Page.getLayoutMetrics', {}, 3000);
    const v = (r && (r.cssVisualViewport || r.visualViewport)) || null;
    if (v) s.css = { w: v.clientWidth, h: v.clientHeight, ox: v.offsetX || 0, oy: v.offsetY || 0, scale: v.scale || 1 };
  } catch { /* the next geometry change asks again */ }
}

/** The newest frame after "since" — a base64 JPEG, how it maps to the page (css), and where the page is. */
function frame(session, since = 0) {
  const s = st(session);
  if (!s) return { ok: true, streaming: false, seq: 0, frame: null };
  if (!s.frame || s.seq <= Number(since || 0)) return { ok: true, streaming: s.on, seq: s.seq, unchanged: true, url: s.url, css: s.css };
  return { ok: true, streaming: s.on, seq: s.seq, frame: s.frame, meta: s.meta, css: s.css, url: s.url, at: s.at };
}

const BUTTONS = { 0: 'left', 1: 'middle', 2: 'right' };
const VK = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34,
  End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
};
function vk(key) {
  if (VK[key] != null) return VK[key];
  if (key && key.length === 1) { const c = key.toUpperCase().charCodeAt(0); if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90)) return c; }
  if (/^F([1-9]|1[0-2])$/.test(String(key))) return 111 + Number(String(key).slice(1));
  return 0;
}
function mods(e) { return (e.alt ? 1 : 0) | (e.ctrl ? 2 : 0) | (e.meta ? 4 : 0) | (e.shift ? 8 : 0); }

/**
 * THE PERSON'S INPUT, IN ORDER. A key with printable text types it (keyDown
 * carrying `text`, as a real keyboard does); Enter carries a carriage return
 * so forms submit; everything else is a key a page can listen for.
 */
async function input(session, events = []) {
  if (!session || !session.conn || !session.conn.open) return { ok: false, why: 'the preview page is not open' };
  const send = (m, p) => session.conn.send(m, p, 5000);
  let n = 0;
  for (const e of (Array.isArray(events) ? events : []).slice(0, 60)) {
    const x = Math.max(0, Number(e.x) || 0);
    const y = Math.max(0, Number(e.y) || 0);
    try {
      if (e.type === 'move') await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: mods(e), buttons: e.buttons ? 1 : 0 });
      else if (e.type === 'down' || e.type === 'up') {
        await send('Input.dispatchMouseEvent', { type: e.type === 'down' ? 'mousePressed' : 'mouseReleased', x, y, button: BUTTONS[e.button] || 'left', buttons: e.type === 'down' ? 1 : 0, clickCount: Math.max(1, Math.min(3, Number(e.clicks) || 1)), modifiers: mods(e) });
      } else if (e.type === 'wheel') {
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: Number(e.dx) || 0, deltaY: Number(e.dy) || 0, modifiers: mods(e) });
      } else if (e.type === 'key') {
        const key = String(e.key || '');
        const printable = key.length === 1 && !e.ctrl && !e.meta && !e.alt;
        const text = printable ? key : key === 'Enter' ? '\r' : '';
        const base = { key, code: String(e.code || ''), windowsVirtualKeyCode: vk(key), nativeVirtualKeyCode: vk(key), modifiers: mods(e) };
        if (e.up) await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        else await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
      } else if (e.type === 'text' && e.text) {
        await send('Input.insertText', { text: String(e.text).slice(0, 4000) });
      } else continue;
      n += 1;
    } catch (err) { return { ok: false, why: `the page did not take the input: ${(err && err.message) || err}`, delivered: n }; }
  }
  return { ok: true, delivered: n };
}

/** The element under a point, for Pick mode's outline: its rect and a short name. Reads only. */
async function hover(session, x, y) {
  if (!session || typeof session.evaluate !== 'function') return { ok: false, why: 'the preview page is not open' };
  const px = Math.max(0, Math.round(Number(x) || 0));
  const py = Math.max(0, Math.round(Number(y) || 0));
  const r = await session.evaluate(`(() => {
    const el = document.elementFromPoint(${px}, ${py});
    if (!el || el === document.documentElement) return null;
    const b = el.getBoundingClientRect();
    const cls = typeof el.className === 'string' ? el.className.trim().split(/[\\s]+/).filter(Boolean).slice(0, 2) : [];
    return { rect: { x: b.left, y: b.top, w: b.width, h: b.height }, tag: el.tagName.toLowerCase(), id: el.id || '', cls,
      label: el.tagName.toLowerCase() + (el.id ? '#' + el.id : cls.length ? '.' + cls.join('.') : ''),
      text: String(el.innerText || el.value || '').trim().replace(/[\\s]+/g, ' ').slice(0, 48) };   // (a class: survives the template literal, and the backslash guard)
  })()`, 5000);
  if (!r || !r.ok) return { ok: false, why: (r && r.why) || 'the page did not answer' };
  return { ok: true, element: r.value || null };
}

/** Where the page is now (its own location — navigation inside the page included). */
async function url(session) {
  const s = st(session);
  if (s && s.url) return s.url;
  if (session && typeof session.evaluate === 'function') {
    const r = await session.evaluate('location.href', 3000).catch(() => null);
    if (r && r.ok && r.value) return String(r.value);
  }
  return (session && session.url) || null;
}

module.exports = { start, stop, frame, input, hover, url };
