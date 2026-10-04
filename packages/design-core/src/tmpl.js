'use strict';

/**
 * VUE AND SVELTE MARKUP, BY OFFSETS (D9) — a tolerant tokenizer for a .vue file's <template> block and a .svelte file's
 * markup. It gives the html.js element shape (attrs, attrLoc, textLoc, startTag/endTag, children…), so html.js's
 * writers and structural splices work on it unchanged. It understands what HTML parsers do not: self-closing
 * components (`<Foo />`), brace expressions in text and attributes (`{a > b}`, `on:click={() => x}`), Svelte blocks
 * (`{#each}` … `{/each}`, kept as text), and Vue directives (`:prop`, `@click`, `v-for`). Ids are file:line:col of
 * the `<`, exactly as the Vite plugin computes them.
 */

const { idFor } = require('./text');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'pre']);

/** Is this tag a real DOM element here (so it can carry data-lain-id)? Components and special tags are not. */
function isHost(tag) { return /^[a-z][a-z0-9]*$/.test(tag) && tag !== 'template' && tag !== 'slot'; }

/** Skip a balanced {…} starting at i (src[i] === '{'), honouring quotes and template strings. Returns the index after. */
function skipBraces(src, i) {
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === '"' || c === "'" || c === '`') { const q = c; k += 1; while (k < src.length && src[k] !== q) { if (src[k] === '\\') k += 1; k += 1; } continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return k + 1; }
  }
  return src.length;
}

/** The ranges of a file this tokenizer reads: a Vue SFC's <template>…</template> body; a Svelte file minus scripts/styles. */
function regions(src, rel) {
  if (/\.vue$/i.test(rel)) {
    const open = /^<template(\s[^>]*)?>/m.exec(src);
    if (!open) return [];
    const from = open.index + open[0].length;
    const closeRe = /^<\/template>[ \t]*$/gm; let last = null; let m;
    while ((m = closeRe.exec(src))) last = m;
    return [[from, last ? last.index : src.length]];
  }
  // SVELTE: everything but top-level <script>/<style> blocks.
  const out = []; let at = 0; const re = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g; let m;
  while ((m = re.exec(src))) { out.push([at, m.index]); at = m.index + m[0].length; }
  out.push([at, src.length]);
  return out;
}

function parse(src, rel) {
  const all = []; const byId = new Map(); const roots = [];
  const starts = [0]; for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) starts.push(k + 1);
  const lc = (off) => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const md = (lo + hi + 1) >> 1; if (starts[md] <= off) lo = md; else hi = md - 1; } return { line: lo + 1, col: off - starts[lo] + 1 }; };
  for (const [from, to] of regions(src, rel)) {
    const stack = [];
    let i = from;
    const pushText = (s, e) => {
      const p = stack[stack.length - 1];
      if (!p || s >= e) return;
      const value = src.slice(s, e);
      if (value.trim()) { p.textLoc.push({ start: s, end: e, value }); if (!p.children.length) p.text = `${p.text} ${value.replace(/\s+/g, ' ').trim()}`.trim().slice(0, 120); }
    };
    let textFrom = i;
    while (i < to) {
      const c = src[i];
      if (c === '{') { i = skipBraces(src, i); continue; }
      if (c !== '<') { i += 1; continue; }
      if (src.startsWith('<!--', i)) { pushText(textFrom, i); const e = src.indexOf('-->', i + 4); i = e < 0 ? to : e + 3; textFrom = i; continue; }
      if (src[i + 1] === '/') {
        pushText(textFrom, i);
        const e = src.indexOf('>', i); const name = src.slice(i + 2, e).trim();
        // CLOSE the nearest open element of that name (a stray close tag closes nothing).
        let k = stack.length - 1; while (k >= 0 && stack[k].tag !== name) k -= 1;
        if (k >= 0) { while (stack.length > k + 1) { const lost = stack.pop(); lost.end = i; } const el = stack.pop(); el.endTag = { start: i, end: e + 1 }; el.end = e + 1; }
        i = e + 1; textFrom = i; continue;
      }
      if (!/[A-Za-z]/.test(src[i + 1] || '')) { i += 1; continue; }
      pushText(textFrom, i);
      // A START TAG.
      let k = i + 1; while (k < to && /[\w:.\-]/.test(src[k])) k += 1;
      const tag = src.slice(i + 1, k);
      const attrs = {}; const attrLoc = {};
      let selfClosing = false;
      for (;;) {
        while (k < to && /\s/.test(src[k])) k += 1;
        if (src[k] === '/' && src[k + 1] === '>') { selfClosing = true; k += 2; break; }
        if (src[k] === '>' || k >= to) { k += 1; break; }
        const ns = k;
        if (src[k] === '{') { k = skipBraces(src, k); const name = src.slice(ns, k); attrs[name] = null; attrLoc[name] = { start: ns, end: k }; continue; }
        while (k < to && !/[\s=>]/.test(src[k]) && !(src[k] === '/' && src[k + 1] === '>')) k += 1;
        const name = src.slice(ns, k);
        if (!name) { k += 1; continue; }
        let j = k; while (/\s/.test(src[j])) j += 1;
        if (src[j] !== '=') { attrs[name] = ''; attrLoc[name] = { start: ns, end: k }; continue; }
        j += 1; while (/\s/.test(src[j])) j += 1;
        let ve; let value;
        if (src[j] === '"' || src[j] === "'") { const q = src[j]; ve = src.indexOf(q, j + 1) + 1; value = src.slice(j + 1, ve - 1); if (/\{[\s\S]*\}/.test(value) && /\.svelte$/i.test(rel)) value = /^\{[\s\S]*\}$/.test(value) ? null : value; } else if (src[j] === '{') { ve = skipBraces(src, j); value = null; } else { ve = j; while (ve < to && !/[\s>]/.test(src[ve])) ve += 1; value = src.slice(j, ve); }
        // A BOUND VALUE (:prop, v-bind, a {brace}) is an expression, not a string.
        if (/^(:|v-bind:|@|v-on:|on:|bind:)/.test(name)) value = null;
        attrs[name] = value; attrLoc[name] = { start: ns, end: ve };
        k = ve;
      }
      const p = lc(i);
      const parent = stack[stack.length - 1] || null;
      const el = {
        id: idFor(rel, p.line, p.col), file: rel, tag, host: isHost(tag), attrs, attrLoc,
        classes: typeof attrs.class === 'string' ? attrs.class.split(/\s+/).filter(Boolean) : [], classStatic: attrs.class === undefined || typeof attrs.class === 'string',
        text: '', textLoc: [], start: i, end: null, startTag: { start: i, end: k }, endTag: null, nameEnd: i + 1 + tag.length,
        void: selfClosing || VOID.has(tag.toLowerCase()), line: p.line, col: p.col, children: [], parent: parent ? parent.id : null,
        repeated: Boolean(attrs['v-for'] !== undefined),
      };
      all.push(el); byId.set(el.id, el);
      if (parent) parent.children.push(el.id); else roots.push(el.id);
      if (el.void) { el.end = k; } else if (RAW.has(tag) && tag !== 'pre') {
        const close = src.indexOf(`</${tag}`, k); const e = src.indexOf('>', close);
        el.endTag = { start: close, end: e + 1 }; el.end = e + 1; k = e + 1;
      } else stack.push(el);
      i = k; textFrom = i;
    }
    pushText(textFrom, to);
    while (stack.length) { const el = stack.pop(); el.end = to; }
  }
  // INSIDE AN {#each} / v-for the element is rendered many times.
  for (const el of all) {
    if (el.repeated) continue;
    if (/\.svelte$/i.test(rel)) { const before = src.slice(0, el.start); const opens = (before.match(/\{#each\b/g) || []).length; const closes = (before.match(/\{\/each\}/g) || []).length; if (opens > closes) el.repeated = true; }
  }
  for (const el of all) { let p = el.parent ? byId.get(el.parent) : null; while (p && !el.repeated) { if (p.repeated && p.attrs['v-for'] !== undefined) el.repeated = true; p = p.parent ? byId.get(p.parent) : null; } }
  return { all, byId, roots, body: null };
}

/** The served copy: data-lain-id on every host element (the Vite plugin calls this on the module source). */
function instrument(src, rel) {
  let tree;
  try { tree = parse(src, rel); } catch { return src; }
  const edits = tree.all.filter((el) => el.host && !el.attrLoc['data-lain-id']).map((el) => ({ start: el.nameEnd, end: el.nameEnd, text: ` data-lain-id="${el.id}"` }));
  return edits.length ? require('./text').splice(src, edits) : src;
}

module.exports = { parse, instrument, isHost, regions };
