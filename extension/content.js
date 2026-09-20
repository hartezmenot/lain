'use strict';

/**
 * LAIN for Chrome — content script.
 *
 * Executes exactly the command it is sent, on this page, and reports what
 * happened. It never reads the page and decides to act on what it finds —
 * every action arrives as an explicit command from background.js, which
 * only relays commands for tabs the person already authorized. This script
 * has no opinion about the page's own text; it does not look for
 * instructions in it, because a page's text is content, not a command
 * channel, and this file is the boundary that keeps it that way.
 */

// STABLE REFS: a per-page counter and a Map, not a DOM attribute — so a ref
// survives even if the site itself reads/strips data- attributes it does
// not recognise, and so two calls to `find` in a row hand back the SAME ref
// for the SAME element instead of minting a new one every time.
const refs = new Map(); // ref -> Element
let refSeq = 0;

function refFor(el) {
  for (const [ref, node] of refs) if (node === el) return ref;
  const ref = `e${++refSeq}`;
  refs.set(ref, el);
  return ref;
}

function elementFor(ref) {
  const el = refs.get(ref);
  if (el && document.contains(el)) return el;
  refs.delete(ref);
  return null;
}

function visibleText(el) {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return '';
  return (el.innerText || el.textContent || '').trim();
}

const ROLE_SELECTORS = {
  button: 'button, [role="button"], input[type="button"], input[type="submit"]',
  link: 'a[href], [role="link"]',
  input: 'input, textarea, select, [role="textbox"], [contenteditable="true"]',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  text: '*',
};

/** `query` is "role:needle" (e.g. "button:Save") or just free text against visible text. */
function find(query) {
  const [maybeRole, ...rest] = String(query || '').split(':');
  const role = ROLE_SELECTORS[maybeRole] ? maybeRole : null;
  const needle = (role ? rest.join(':') : query || '').trim().toLowerCase();
  const selector = role ? ROLE_SELECTORS[role] : 'button, a[href], input, textarea, select, [role], label, h1, h2, h3, p, span';
  const nodes = [...document.querySelectorAll(selector)].slice(0, 4000);
  const matches = [];
  for (const el of nodes) {
    const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || visibleText(el) || '').trim();
    if (needle && !label.toLowerCase().includes(needle)) continue;
    if (!needle && !label) continue;
    matches.push({ ref: refFor(el), role: el.getAttribute('role') || el.tagName.toLowerCase(), text: label.slice(0, 200) });
    if (matches.length >= 50) break;
  }
  return { ok: true, matches };
}

function pageText() {
  return { ok: true, text: visibleText(document.body).slice(0, 20000) };
}

function click(ref) {
  const el = elementFor(ref);
  if (!el) return { ok: false, error: `ref ${ref} no longer exists on this page — call find again` };
  el.scrollIntoView({ block: 'center' });
  el.click();
  return { ok: true, summary: `clicked ${el.tagName.toLowerCase()}` };
}

function type(ref, text) {
  const el = elementFor(ref);
  if (!el) return { ok: false, error: `ref ${ref} no longer exists on this page — call find again` };
  el.focus();
  if ('value' in el) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    return { ok: false, error: 'this element does not accept typed text' };
  }
  return { ok: true, summary: `typed ${text.length} character(s)` };
}

function key(ref, keyName) {
  const el = ref ? elementFor(ref) : document.activeElement;
  if (ref && !el) return { ok: false, error: `ref ${ref} no longer exists on this page` };
  const target = el || document.body;
  for (const type_ of ['keydown', 'keypress', 'keyup']) {
    target.dispatchEvent(new KeyboardEvent(type_, { key: keyName, bubbles: true, cancelable: true }));
  }
  return { ok: true, summary: `sent key ${keyName}` };
}

function scroll(deltaY) {
  window.scrollBy(0, Number(deltaY) || 0);
  return { ok: true, summary: `scrolled by ${deltaY}` };
}

function focus(ref) {
  const el = elementFor(ref);
  if (!el) return { ok: false, error: `ref ${ref} no longer exists on this page` };
  el.focus();
  return { ok: true, summary: 'focused' };
}

/** `submit` is its own explicit op — never inferred from a click on a button inside a form. */
function submit(ref) {
  const el = elementFor(ref);
  if (!el) return { ok: false, error: `ref ${ref} no longer exists on this page` };
  const form = el.tagName === 'FORM' ? el : el.closest('form');
  if (!form) return { ok: false, error: 'that element is not inside a form' };
  form.requestSubmit ? form.requestSubmit() : form.submit();
  return { ok: true, summary: 'submitted the form' };
}

chrome.runtime.onMessage.addListener((cmd, _sender, sendResponse) => {
  const p = cmd.params || {};
  let result;
  switch (cmd.op) {
    case 'find': result = find(p.query); break;
    case 'text': result = pageText(); break;
    case 'click': result = click(p.ref); break;
    case 'type': result = type(p.ref, String(p.text || '')); break;
    case 'key': result = key(p.ref, String(p.key || '')); break;
    case 'scroll': result = scroll(p.deltaY); break;
    case 'focus': result = focus(p.ref); break;
    case 'submit': result = submit(p.ref); break;
    default: result = { ok: false, error: `content script does not handle op "${cmd.op}"` };
  }
  sendResponse(result);
  return false; // synchronous — every handler above returns immediately
});
