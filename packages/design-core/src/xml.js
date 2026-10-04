'use strict';

/**
 * ANDROID XML, BY OFFSETS — a small, strict tokenizer for layout, navigation and resource files (well-formed XML:
 * elements, attributes, comments, the prolog). It gives the same tree shape html.js does (so the structural splices are
 * shared) with attribute name/value offsets for in-place writes. Names keep their case (`android:layout_width`).
 */

const { idFor, escAttr } = require('./text');

function parse(src, rel) {
  const all = []; const byId = new Map(); const roots = [];
  const stack = [];
  let i = 0;
  const lineAt = (() => { const starts = [0]; for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) starts.push(k + 1); return (off) => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1; } return { line: lo + 1, col: off - starts[lo] + 1 }; }; })();
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      const name = src.slice(lt + 2, e).trim();
      const open = stack.pop();
      if (!open || open.tag !== name) throw new Error(`${rel}: </${name}> does not close <${open ? open.tag : '?'}>`);
      open.endTag = { start: lt, end: e + 1 }; open.end = e + 1;
      const inner = src.slice(open.startTag.end, lt);
      if (!open.children.length && inner.trim()) open.text = inner.trim().slice(0, 120);
      i = e + 1; continue;
    }
    // A START TAG: name, attributes (with offsets), self-closing or not.
    let k = lt + 1;
    while (k < src.length && /[\w:.\-]/.test(src[k])) k += 1;
    const tag = src.slice(lt + 1, k);
    const attrs = {}; const attrLoc = {};
    for (;;) {
      while (k < src.length && /\s/.test(src[k])) k += 1;
      if (src[k] === '/' && src[k + 1] === '>') { k += 2; break; }
      if (src[k] === '>') { k += 1; break; }
      const ns = k;
      while (k < src.length && /[\w:.\-]/.test(src[k])) k += 1;
      const name = src.slice(ns, k);
      if (!name) throw new Error(`${rel}: unexpected "${src[k]}" in <${tag}> at ${lineAt(k).line}`);
      while (/\s/.test(src[k])) k += 1;
      if (src[k] !== '=') { attrs[name] = ''; attrLoc[name] = { start: ns, end: k, valueStart: k, valueEnd: k }; continue; }
      k += 1; while (/\s/.test(src[k])) k += 1;
      const q = src[k]; const vs = k + 1; const ve = src.indexOf(q, vs);
      attrs[name] = src.slice(vs, ve).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      attrLoc[name] = { start: ns, end: ve + 1, valueStart: vs, valueEnd: ve };
      k = ve + 1;
    }
    const selfClosing = src[k - 2] === '/';
    const lc = lineAt(lt);
    const parent = stack[stack.length - 1] || null;
    const el = {
      id: idFor(rel, lc.line, lc.col), file: rel, tag, attrs, attrLoc, classes: [], text: '', textLoc: [],
      start: lt, end: selfClosing ? k : null, startTag: { start: lt, end: k }, endTag: null, nameEnd: lt + 1 + tag.length,
      void: selfClosing, line: lc.line, col: lc.col, children: [], parent: parent ? parent.id : null,
    };
    all.push(el); byId.set(el.id, el);
    if (parent) parent.children.push(el.id); else roots.push(el.id);
    if (!selfClosing) stack.push(el);
    i = k;
  }
  if (stack.length) throw new Error(`${rel}: <${stack[stack.length - 1].tag}> is never closed`);
  return { all, byId, roots, body: null };
}

/** Splice: set (or, with null, remove) an attribute, keeping the file's attribute layout (one per line or inline). */
function setAttr(src, el, name, value) {
  const loc = el.attrLoc[name];
  if (value == null) {
    if (!loc) return null;
    let s = loc.start; while (s > 0 && /[ \t]/.test(src[s - 1])) s -= 1;
    if (src[s - 1] === '\n') { s -= 1; if (src[s - 1] === '\r') s -= 1; }
    return { start: s, end: loc.end, text: '' };
  }
  if (loc) return { start: loc.valueStart, end: loc.valueEnd, text: escAttr(value) };
  // NEW: after the last attribute, in the same layout (a new line with its indentation when attributes are one per line).
  const names = Object.keys(el.attrLoc);
  const last = names.length ? el.attrLoc[names[names.length - 1]] : null;
  if (!last) return { start: el.nameEnd, end: el.nameEnd, text: ` ${name}="${escAttr(value)}"` };
  const before = src.slice(el.startTag.start, last.start);
  const m = /\n([ \t]+)[^\n]*$/.exec(before);
  return { start: last.end, end: last.end, text: m ? `\n${m[1]}${name}="${escAttr(value)}"` : ` ${name}="${escAttr(value)}"` };
}

module.exports = { parse, setAttr };
