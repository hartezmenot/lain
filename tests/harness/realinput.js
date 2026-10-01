'use strict';

/**
 * REAL INPUT FOR A REAL WINDOW — the mouse at an element's centre, keys with
 * their modifiers, text as the keyboard inserts it. Through the renderer's
 * input pipeline (CDP Input.*), so focus, default actions, Monaco's own key
 * handling and `stopPropagation` all behave as they do for a person. A DOM
 * `.click()` skips all of that, which is how a double-click that opened a file
 * twice passed every scripted check (Phase 8.2).
 *
 *   const R = require('../harness/realinput')(d);
 *   await R.click("document.getElementById('x')");       // an expression → the element
 *   await R.click(R.byText('#paneScm button', 'Commit'));
 *   await R.key('P', { ctrl: true, shift: true });
 *   await R.text('hello');
 */

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const CODES = {
  Enter: ['Enter', 13, '\r'], Escape: ['Escape', 27], Tab: ['Tab', 9], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
  ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
  F5: ['F5', 116], F9: ['F9', 120], '`': ['Backquote', 192], '\\': ['Backslash', 220],
};

module.exports = function realInput(d) {
  const C = d.page.conn;
  /** The centre of the element an expression names, scrolled into view — or null. */
  async function at(expr) {
    return d.js(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); if (!r.width || !r.height) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  }
  async function clickAt(p, { count = 1, button = 'left' } = {}) {
    await C.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    for (let i = 1; i <= count; i++) {
      await C.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, clickCount: i });
      await C.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, clickCount: i });
    }
  }
  async function click(expr, { count = 1, button = 'left', settle = 350 } = {}) {
    const p = await at(expr);
    if (!p) throw new Error(`nothing on screen for: ${expr}`);
    await clickAt(p, { count, button });
    await pause(settle);
    return p;
  }
  async function hover(expr) { const p = await at(expr); if (!p) throw new Error(`nothing on screen for: ${expr}`); await C.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); return p; }
  async function key(k, { ctrl = false, shift = false, alt = false, settle = 200 } = {}) {
    const mods = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const named = CODES[k];
    const single = !named && k.length === 1;
    const upper = single ? k.toUpperCase() : null;
    const code = named ? named[0] : (single && /[A-Z]/.test(upper) ? `Key${upper}` : (single && /[0-9]/.test(k) ? `Digit${k}` : k));
    const vk = named ? named[1] : (single ? upper.charCodeAt(0) : 0);
    const text = named ? named[2] : (single && !ctrl && !alt ? (shift ? upper : k) : undefined);
    await C.send('Input.dispatchKeyEvent', { type: 'keyDown', key: single && shift ? upper : k, code, windowsVirtualKeyCode: vk, modifiers: mods, text });
    await C.send('Input.dispatchKeyEvent', { type: 'keyUp', key: single && shift ? upper : k, code, windowsVirtualKeyCode: vk, modifiers: mods });
    await pause(settle);
  }
  /** Text as an input method commits it (one insertion, no key events) — fields, the editor. */
  async function text(t, { settle = 200 } = {}) { await C.send('Input.insertText', { text: t }); await pause(settle); }
  /** Text as a KEYBOARD types it: a keydown carrying each character, then its keyup. */
  async function type(t, { settle = 200, gap = 15 } = {}) {
    for (const ch of String(t)) {
      const upper = ch.toUpperCase();
      const code = /[a-z]/i.test(ch) ? `Key${upper}` : (/[0-9]/.test(ch) ? `Digit${ch}` : (ch === ' ' ? 'Space' : ''));
      const vk = /[a-z0-9]/i.test(ch) ? upper.charCodeAt(0) : (ch === ' ' ? 32 : 0);
      await C.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, windowsVirtualKeyCode: vk, text: ch, unmodifiedText: ch });
      await C.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
      if (gap) await pause(gap);
    }
    await pause(settle);
  }
  /** An expression for the first visible element matching `selector` whose text (or title) matches. */
  function byText(selector, match) {
    const re = match instanceof RegExp ? match : new RegExp(`^${String(match).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    return `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((e) => e.offsetParent !== null && (${re.toString()}.test(e.textContent.trim()) || ${re.toString()}.test(e.title || '')))`;
  }
  return { at, clickAt, click, hover, key, text, type, byText, pause };
};
