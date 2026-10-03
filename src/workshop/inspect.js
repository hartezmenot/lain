'use strict';

/** WHAT THE PREVIEW PAGE ACTUALLY SHOWS — read structurally, bounded, and scoped to what a turn can use. */

/** Nothing read off a page is unbounded. */
const MAX_TEXT = 2000;
const MAX_NODES = 40;
const MAX_CONSOLE = 30;
const MAX_NETWORK = 40;

/** The computed properties that actually decide a layout complaint. */
const LAYOUT_PROPS = [
  'display', 'position', 'flex-direction', 'justify-content', 'align-items',
  'margin', 'padding', 'width', 'height', 'max-width', 'gap',
  'text-align', 'font-size', 'line-height', 'overflow', 'transform',
];

function lit(v) { return JSON.stringify(v === undefined ? null : v); }

/** One evaluate with a named failure, so a report points at what was attempted. */
async function ask(page, what, expression) {
  if (!page || typeof page.evaluate !== 'function') return { ok: false, why: `${what}: no page` };
  const r = await page.evaluate(expression);
  return r.ok ? { ok: true, value: r.value } : { ok: false, why: `${what}: ${r.why}` };
}

/** EVERYTHING WORTH KNOWING ABOUT ONE ELEMENT, in one round trip. */
function describeExpr(selectorOrNull) {
  return `(() => {
    const sel = ${lit(selectorOrNull)};
    const el = sel ? document.querySelector(sel) : (window.__lainPicked || null);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const layout = {};
    for (const p of ${lit(LAYOUT_PROPS)}) layout[p] = cs.getPropertyValue(p);
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = String(a.value).slice(0, 200);
    const ws = new RegExp('[ ' + String.fromCharCode(9, 10, 13) + ']+', 'g');
    const pathOf = (n) => {
      if (n.id) return '#' + n.id;
      if (n.getAttribute && n.getAttribute('data-testid')) return '[data-testid="' + n.getAttribute('data-testid') + '"]';
      const parts = [];
      let cur = n;
      while (cur && cur.nodeType === 1 && parts.length < 6) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift('#' + cur.id); break; }
        const par = cur.parentElement;
        if (par) {
          const same = [].slice.call(par.children).filter((c) => c.tagName === cur.tagName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
        }
        parts.unshift(part);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    };
    const cls = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : String(el.className || '');
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: cls.trim().slice(0, 300),
      testid: el.getAttribute('data-testid') || null,
      role: el.getAttribute('role') || null,
      name: (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(ws, ' ').trim().slice(0, 300),
      selector: pathOf(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0,
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      layout,
      attributes: attrs,
      parent: el.parentElement ? {
        tag: el.parentElement.tagName.toLowerCase(),
        display: getComputedStyle(el.parentElement).display,
        justify: getComputedStyle(el.parentElement).justifyContent,
        align: getComputedStyle(el.parentElement).alignItems,
      } : null,
    };
  })()`;
}

/** THE GUG MEASUREMENT (gug.js fromDom): every VISIBLE element's box, its nearest measured ancestor, its identity and the computed px that decide its… */
const GUG_STYLE = ['display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap',
  'justify-content', 'align-items', 'flex-direction'];
function gugExpr(max = 400) {
  return `(() => {
    const max = ${Number(max) || 400};
    const keys = ${lit(GUG_STYLE)};
    const skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, META: 1, LINK: 1, HEAD: 1, BR: 1 };
    const ws = new RegExp('[ ' + String.fromCharCode(9, 10, 13) + ']+', 'g');
    const out = [];
    const index = new Map();
    const pathOf = (n) => {
      if (n.id) return '#' + n.id;
      if (n.getAttribute && n.getAttribute('data-testid')) return '[data-testid="' + n.getAttribute('data-testid') + '"]';
      const parts = [];
      let cur = n;
      while (cur && cur.nodeType === 1 && parts.length < 6) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift('#' + cur.id); break; }
        const par = cur.parentElement;
        if (par) {
          const same = [].slice.call(par.children).filter((c) => c.tagName === cur.tagName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
        }
        parts.unshift(part);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    };
    const walker = document.createTreeWalker(document.body || document.documentElement, 1);
    let el = walker.currentNode;
    while (el && out.length < max) {
      if (!skip[el.tagName] && el !== window.__lainPickerBox) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') {
          let p = el.parentElement;
          while (p && !index.has(p)) p = p.parentElement;
          const style = {};
          for (const k of keys) style[k] = cs.getPropertyValue(k);
          const cls = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : String(el.className || '');
          index.set(el, out.length);
          out.push({
            tag: el.tagName.toLowerCase(), id: el.id || '', classes: cls.trim().slice(0, 200),
            testid: el.getAttribute('data-testid') || '', role: el.getAttribute('role') || '',
            label: (el.getAttribute('aria-label') || (el.children.length ? '' : (el.innerText || el.textContent || ''))).replace(ws, ' ').trim().slice(0, 60),
            selector: pathOf(el),
            rect: { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height },
            parent: p ? index.get(p) : -1, style,
          });
        }
      }
      el = walker.nextNode();
    }
    return { url: location.href, viewport: { w: innerWidth, h: innerHeight }, elements: out };
  })()`;
}

/** Measure the page for the GUG. */
async function measure(page, max = 400) {
  const r = await ask(page, 'measure the page', gugExpr(max));
  if (!r.ok) return r;
  if (!r.value || !Array.isArray(r.value.elements)) return { ok: false, why: 'the page returned no measurement' };
  return { ok: true, ...r.value };
}

/** One element by selector, or a stated reason there is not one. */
async function element(page, selector) {
  const r = await ask(page, 'read the element', describeExpr(String(selector)));
  if (!r.ok) return r;
  if (!r.value) return { ok: false, why: `nothing matches ${selector}` };
  return { ok: true, element: r.value };
}

/** THE ELEMENT PICKER — a real click-to-select workflow. */
const PICKER = `(() => {
  if (window.__lainPicker) return 'already';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2ea8ff;background:rgba(46,168,255,.12);border-radius:2px';
  document.documentElement.appendChild(box);
  const label = document.createElement('div');
  label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#0b1220;color:#cfe8ff;font:11px/1.4 ui-monospace,monospace;padding:2px 6px;border-radius:3px';
  document.documentElement.appendChild(label);
  let hovered = null;
  const move = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === label) return;
    hovered = el;
    const r = el.getBoundingClientRect();
    box.style.left = r.x + 'px'; box.style.top = r.y + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    label.style.left = r.x + 'px';
    label.style.top = Math.max(0, r.y - 20) + 'px';
    label.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '  '
      + Math.round(r.width) + String.fromCharCode(215) + Math.round(r.height);
  };
  const stop = () => {
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', pick, true);
    document.removeEventListener('keydown', esc, true);
    box.remove(); label.remove();
    window.__lainPicker = null;
  };
  function pick(e) {
    e.preventDefault(); e.stopPropagation();
    window.__lainPicked = hovered || document.elementFromPoint(e.clientX, e.clientY);
    stop();
  }
  function esc(e) { if (e.key === 'Escape') { e.preventDefault(); stop(); } }
  document.addEventListener('mousemove', move, true);
  document.addEventListener('click', pick, true);
  document.addEventListener('keydown', esc, true);
  window.__lainPicker = { stop };
  window.__lainPicked = null;
  return 'armed';
})()`;

/** Arm the picker. The person then clicks in the preview. */
async function pick(page) {
  const r = await ask(page, 'arm the element picker', PICKER);
  return r.ok ? { ok: true, state: r.value } : r;
}

/** PICK THE ELEMENT AT A POINT — the click a person makes on the preview IMAGE in the application, mapped to the page's own coordinates by the caller. */
async function pickAt(page, x, y) {
  const px = Math.max(0, Math.round(Number(x) || 0));
  const py = Math.max(0, Math.round(Number(y) || 0));
  const r = await ask(page, 'pick the element at a point',
    `(() => { window.__lainPicked = document.elementFromPoint(${px}, ${py}); return Boolean(window.__lainPicked); })()`);
  if (!r.ok) return r;
  if (!r.value) return { ok: false, why: `there is no element at ${px},${py}` };
  return picked(page);
}

/** What was picked, or null while nothing has been. Polled by the frontend. */
async function picked(page) {
  const r = await ask(page, 'read the picked element', describeExpr(null));
  if (!r.ok) return r;
  return { ok: true, element: r.value || null };
}

/** Put the picker away without selecting anything. */
async function unpick(page) {
  return ask(page, 'disarm the picker',
    '(() => { if (window.__lainPicker) window.__lainPicker.stop(); window.__lainPicked = null; return "off"; })()');
}

/** THE ACCESSIBILITY TREE — what a user is TOLD, which is a different question from what is in the document. */
async function axTree(page, selector = null) {
  if (!page || typeof page.axTree !== 'function') {
    return { ok: false, why: 'this page cannot report an accessibility tree' };
  }
  const ax = await page.axTree(selector);
  if (!ax.ok) return ax;
  const nodes = (ax.nodes || [])
    .filter((n) => !n.ignored && (n.role || n.name))
    .slice(0, MAX_NODES)
    .map((n) => ({ role: n.role || '?', name: String(n.name || '').slice(0, 120), disabled: Boolean(n.disabled) }));
  return { ok: true, nodes };
}

/** THE CONSOLE, SUMMARISED FIRST. */
function consoleReport(session) {
  const errors = session && typeof session.errors === 'function' ? session.errors() : [];
  const all = (session && Array.isArray(session.console)) ? session.console : [];
  return {
    errors: errors.length,
    total: all.length,
    entries: errors.slice(-MAX_CONSOLE).map((e) => ({
      level: e.level || 'error',
      text: String(e.text || '').slice(0, MAX_TEXT),
    })),
  };
}

/** THE NETWORK, SUMMARISED THE SAME WAY, AND FAILURES FIRST. */
function networkReport(session) {
  const all = (session && Array.isArray(session.network)) ? session.network : [];
  const failed = all.filter((n) => Number(n.status) >= 400);
  return {
    total: all.length,
    failed: failed.length,
    entries: failed.slice(-MAX_NETWORK).map((n) => ({ status: n.status, url: String(n.url || '').slice(0, 300) })),
  };
}

module.exports = {
  element, pick, pickAt, picked, unpick, axTree, consoleReport, networkReport, measure, gugExpr,
  describeExpr, LAYOUT_PROPS, GUG_STYLE, MAX_TEXT, MAX_NODES, MAX_CONSOLE, MAX_NETWORK,
};
