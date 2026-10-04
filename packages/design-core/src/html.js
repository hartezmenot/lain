'use strict';

/** HTML, READ WITH SOURCE POSITIONS (parse5) AND WRITTEN AS SPLICES. */

const parse5 = require('parse5');
const { idFor, escAttr, escText, indentAt } = require('./text');

/** Elements a person does not design: they never appear as layers and are never given an id. */
const SKIP = new Set(['html', 'head', 'meta', 'title', 'link', 'script', 'style', 'base', 'noscript', 'template', 'br', 'wbr']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function attrsOf(n) { const o = {}; for (const a of n.attrs || []) o[a.name] = a.value; return o; }

/**
 * Parse `src` (the file at `rel`) into an element tree: { id, tag, attrs, classes, text, start, end, startTag,
 * endTag, attrLoc, line, col, children, parent }. Implied elements (a missing <body>) have no position and are walked
 * through, never given an id.
 */
function parse(src, rel) {
  const doc = parse5.parse(src, { sourceCodeLocationInfo: true });
  const all = [];
  const byId = new Map();
  let body = null;
  function walk(n, parent) {
    for (const c of n.childNodes || []) {
      if (!c.tagName) continue;
      const loc = c.sourceCodeLocation;
      let el = null;
      if (c.tagName === 'body') body = { node: c, loc };
      if (loc && loc.startTag && !SKIP.has(c.tagName) && c.tagName !== 'body') {
        const attrs = attrsOf(c);
        const textOf = (c.childNodes || []).filter((t) => t.nodeName === '#text').map((t) => t.value).join('').replace(/\s+/g, ' ').trim();
        el = {
          id: idFor(rel, loc.startLine, loc.startCol), file: rel, tag: c.tagName, attrs,
          classes: String(attrs.class || '').split(/\s+/).filter(Boolean),
          text: textOf, start: loc.startOffset, end: loc.endOffset,
          startTag: { start: loc.startTag.startOffset, end: loc.startTag.endOffset },
          endTag: loc.endTag ? { start: loc.endTag.startOffset, end: loc.endTag.endOffset } : null,
          attrLoc: Object.fromEntries(Object.entries(loc.attrs || {}).map(([k, v]) => [k, { start: v.startOffset, end: v.endOffset }])),
          textLoc: (c.childNodes || []).filter((t) => t.nodeName === '#text' && t.sourceCodeLocation).map((t) => ({ start: t.sourceCodeLocation.startOffset, end: t.sourceCodeLocation.endOffset, value: t.value })),
          line: loc.startLine, col: loc.startCol, children: [], parent: parent ? parent.id : null, void: VOID.has(c.tagName),
        };
        all.push(el); byId.set(el.id, el);
        if (parent) parent.children.push(el.id);
      }
      walk(c.content || c, el || parent);
    }
  }
  walk(doc, null);
  const roots = all.filter((e) => !e.parent);
  // THE BODY'S OWN RANGE, for inserting at the end of a page with no other container.
  const bodyRange = body && body.loc ? { start: body.loc.startTag ? body.loc.startTag.endOffset : 0, end: body.loc.endTag ? body.loc.endTag.startOffset : src.length } : { start: 0, end: src.length };
  return { all, byId, roots: roots.map((r) => r.id), body: bodyRange, head: headRange(doc, src) };
}

function headRange(doc, src) {
  const html = (doc.childNodes || []).find((n) => n.tagName === 'html');
  const head = html && (html.childNodes || []).find((n) => n.tagName === 'head');
  const loc = head && head.sourceCodeLocation;
  if (!loc || !loc.endTag) return null;
  return { start: loc.startTag.endOffset, end: loc.endTag.startOffset, src };
}

/** Where a new attribute goes: just before the start tag's `>` (or `/>`). */
function attrInsertAt(src, el) {
  let at = el.startTag.end - 1;
  if (src[at - 1] === '/') at -= 1;
  while (at > el.startTag.start && /\s/.test(src[at - 1])) at -= 1;
  return at;
}

/** Splice: set `name` to `value` (null removes it). */
function setAttr(src, el, name, value) {
  const loc = el.attrLoc[name];
  if (value == null) {
    if (!loc) return null;
    let s = loc.start; while (s > 0 && /[ \t]/.test(src[s - 1])) s -= 1;
    return { start: s, end: loc.end, text: '' };
  }
  const text = `${name}="${escAttr(value)}"`;
  if (loc) return { start: loc.start, end: loc.end, text };
  const at = attrInsertAt(src, el);
  return { start: at, end: at, text: ` ${text}` };
}

// ---- inline style -----------------------------------------------------------------------------------------------

/** `a: b; c: d` → [{prop, value, start, end}] relative to the attribute value; order kept. */
function declsOf(style) {
  const out = []; let depth = 0; let from = 0;
  const s = String(style || '');
  for (let i = 0; i <= s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth += 1; else if (ch === ')') depth -= 1;
    if (i === s.length || (ch === ';' && depth === 0)) {
      const part = s.slice(from, i); const colon = part.indexOf(':');
      if (colon > 0) out.push({ prop: part.slice(0, colon).trim().toLowerCase(), value: part.slice(colon + 1).trim(), start: from, end: i });
      from = i + 1;
    }
  }
  return out;
}

/** Splice the `style` attribute so `props` ({prop: value|null}) hold, keeping every other declaration as written. */
function setInlineStyle(src, el, props) {
  const cur = el.attrs.style || '';
  const decls = declsOf(cur);
  let next = cur;
  const touched = new Set();
  // EXISTING DECLARATIONS ARE EDITED IN PLACE (right to left, so offsets hold).
  for (const d of decls.slice().reverse()) {
    if (!(d.prop in props)) continue;
    touched.add(d.prop);
    const v = props[d.prop];
    const lead = /^\s*/.exec(cur.slice(d.start, d.end))[0];
    if (v == null) {
      const end = cur[d.end] === ';' ? d.end + 1 : d.end;
      next = next.slice(0, d.start) + next.slice(end);
    } else next = `${next.slice(0, d.start)}${lead}${d.prop}: ${v}${next.slice(d.end)}`;
  }
  const add = Object.entries(props).filter(([p, v]) => !touched.has(p) && v != null);
  if (add.length) {
    const base = next.trim().replace(/;\s*$/, '');
    next = `${base}${base ? '; ' : ''}${add.map(([p, v]) => `${p}: ${v}`).join('; ')}`;
  }
  next = next.trim();
  return setAttr(src, el, 'style', next ? next : null);
}

// ---- structure --------------------------------------------------------------------------------------------------

/** The element's whole text including its leading indentation and line break, for moving or removing it cleanly. */
function blockRange(src, el) {
  let s = el.start; let e = el.end;
  const ls = src.lastIndexOf('\n', s - 1) + 1;
  const onlyIndentBefore = /^[ \t]*$/.test(src.slice(ls, s));
  const le = src.indexOf('\n', e);
  const onlySpaceAfter = /^[ \t]*$/.test(src.slice(e, le < 0 ? src.length : le));
  if (onlyIndentBefore && onlySpaceAfter) { s = ls; e = le < 0 ? src.length : le + 1; return { start: s, end: e, block: true }; }
  return { start: s, end: e, block: false };
}

/** Splice: remove the element. */
function remove(src, el) { const r = blockRange(src, el); return { start: r.start, end: r.end, text: '' }; }

/** Splice: insert `markup` as the `index`-th element child of `parent` (or append when index is past the end). */
function insertInto(src, tree, parent, markup, index = Infinity) {
  const kids = parent ? parent.children.map((id) => tree.byId.get(id)) : tree.roots.map((id) => tree.byId.get(id));
  if (index < kids.length) {
    const ref = kids[Math.max(0, index)];
    const r = blockRange(src, ref);
    if (r.block) { const ind = indentAt(src, ref.start); return { start: r.start, end: r.start, text: `${ind}${markup}\n` }; }
    return { start: ref.start, end: ref.start, text: markup };
  }
  const last = kids[kids.length - 1];
  if (last) {
    const r = blockRange(src, last);
    if (r.block) { const ind = indentAt(src, last.start); return { start: r.end, end: r.end, text: `${ind}${markup}\n` }; }
    return { start: last.end, end: last.end, text: markup };
  }
  // AN EMPTY PARENT (or the body): inside its tags, one level deeper than the parent.
  const at = parent ? (parent.endTag ? parent.endTag.start : parent.end) : tree.body.end;
  const ind = parent ? `${indentAt(src, parent.start)}  ` : '  ';
  const before = src.slice(0, at);
  const nl = /\n[ \t]*$/.test(before);
  return { start: at, end: at, text: nl ? `  ${markup}\n${indentAt(src, at)}` : `\n${ind}${markup}\n${parent ? indentAt(src, parent.start) : ''}` };
}

/** Splices that move `el` to be the `index`-th child of its parent (index counted WITHOUT el). */
function reorder(src, tree, el, index) {
  const parent = el.parent ? tree.byId.get(el.parent) : null;
  const sibs = (parent ? parent.children : tree.roots).filter((id) => id !== el.id).map((id) => tree.byId.get(id));
  const r = blockRange(src, el);
  const piece = src.slice(el.start, el.end);
  const cut = { start: r.start, end: r.end, text: '' };
  let ins;
  if (index < sibs.length) {
    const ref = sibs[Math.max(0, index)];
    const rr = blockRange(src, ref);
    ins = rr.block && r.block ? { start: rr.start, end: rr.start, text: `${indentAt(src, ref.start)}${piece}\n` } : { start: ref.start, end: ref.start, text: piece };
  } else {
    const last = sibs[sibs.length - 1];
    const rr = blockRange(src, last);
    ins = rr.block && r.block ? { start: rr.end, end: rr.end, text: `${indentAt(src, last.start)}${piece}\n` } : { start: last.end, end: last.end, text: piece };
  }
  return [cut, ins];
}

/** Splice: replace the element's own text (its first text run), escaped. */
function setText(src, el, text) {
  const t = el.textLoc.find((x) => x.value.trim()) || el.textLoc[0];
  if (t) {
    const lead = /^\s*/.exec(src.slice(t.start, t.end))[0]; const trail = /\s*$/.exec(src.slice(t.start, t.end))[0];
    return { start: t.start, end: t.end, text: `${lead}${escText(text)}${trail}` };
  }
  if (el.void || !el.endTag) return null;
  return { start: el.startTag.end, end: el.startTag.end, text: escText(text) };
}

/**
 * THE SERVED COPY: every designable element carries `data-lain-id`, and the Design runtime is loaded. Never written
 * to disk — the project's files are untouched by serving them.
 */
function instrument(src, rel, { runtimeSrc = '/__lain/runtime.js' } = {}) {
  const tree = parse(src, rel);
  const edits = [];
  for (const el of tree.all) {
    if (el.attrLoc['data-lain-id']) continue;
    const at = attrInsertAt(src, el);
    edits.push({ start: at, end: at, text: ` data-lain-id="${el.id}"` });
  }
  const tag = `<script src="${runtimeSrc}" data-lain-runtime="1"></script>`;
  const close = src.lastIndexOf('</body>');
  edits.push(close >= 0 ? { start: close, end: close, text: tag } : { start: src.length, end: src.length, text: tag });
  return require('./text').splice(src, edits);
}

/** The stylesheets and scripts a page links (local ones only, relative to the page). */
function links(src) {
  const doc = parse5.parse(src);
  const css = []; const js = [];
  (function walk(n) {
    for (const c of n.childNodes || []) {
      if (c.tagName === 'link') { const a = attrsOf(c); if (/stylesheet/i.test(a.rel || '') && a.href && !/^[a-z]+:\/\//i.test(a.href)) css.push(a.href); }
      if (c.tagName === 'script') { const a = attrsOf(c); if (a.src && !/^[a-z]+:\/\//i.test(a.src)) js.push(a.src); }
      walk(c.content || c);
    }
  }(doc));
  return { css, js };
}

module.exports = { parse, setAttr, setInlineStyle, declsOf, remove, insertInto, reorder, setText, instrument, links, blockRange, SKIP, VOID };
