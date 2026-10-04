'use strict';

/** CSS, READ WITH SOURCE OFFSETS (postcss) AND WRITTEN AS SPLICES — a declaration's value, never the whole rule. */

const postcss = require('postcss');

function parse(src, rel) {
  const root = postcss.parse(src, { from: rel });
  const rules = [];
  root.walkRules((r) => {
    if (r.parent && r.parent.type === 'atrule' && /keyframes/i.test(r.parent.name)) return;
    const decls = [];
    r.each((d) => {
      if (d.type !== 'decl') return;
      decls.push({ prop: d.prop.toLowerCase(), value: d.value, important: Boolean(d.important), start: d.source.start.offset, end: d.source.end.offset });
    });
    rules.push({
      selector: r.selector, selectors: r.selectors.map((s) => s.trim()), start: r.source.start.offset, end: r.source.end.offset,
      openBrace: src.indexOf('{', r.source.start.offset), closeBrace: r.source.end.offset - 1, decls, inMedia: Boolean(r.parent && r.parent.type === 'atrule'),
    });
  });
  return { rules, src, rel };
}

/** Rules whose selector list contains exactly `.cls` (a plain class selector), outside media queries first. */
function rulesForClass(sheet, cls) {
  const want = `.${cls}`;
  return sheet.rules.filter((r) => r.selectors.includes(want)).sort((a, b) => Number(a.inMedia) - Number(b.inMedia));
}

/** The range of a declaration's VALUE (after `prop:` and its whitespace, before `!important`/`;`). */
function valueRange(src, d) {
  const text = src.slice(d.start, d.end);
  const colon = text.indexOf(':');
  let s = colon + 1; while (/\s/.test(text[s])) s += 1;
  let e = text.length; if (text[e - 1] === ';') e -= 1;
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  const imp = /\s*!\s*important\s*$/i.exec(text.slice(s, e));
  if (imp) e -= imp[0].length;
  return { start: d.start + s, end: d.start + e };
}

/**
 * Splices that make `props` ({prop: value|null}) hold in `rule`, editing values in place and appending the rest. A
 * property that is removed while another is added (right → left when an element crosses the middle) is RENAMED in
 * place, so the diff is that one declaration.
 */
function setDecls(src, rule, props) {
  const edits = [];
  const done = new Set();
  const removing = rule.decls.filter((d) => d.prop in props && props[d.prop] == null).map((d) => d.prop);
  const adding = Object.keys(props).filter((p) => props[p] != null && !rule.decls.some((d) => d.prop === p));
  const RENAME = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' };
  for (const from of removing.slice()) {
    const to = RENAME[from];
    if (!to || !adding.includes(to)) continue;
    const d = rule.decls.find((x) => x.prop === from);
    const r = valueRange(src, d);
    const nameEnd = d.start + src.slice(d.start, d.end).indexOf(':');
    edits.push({ start: d.start, end: nameEnd, text: to });
    edits.push({ start: r.start, end: r.end, text: String(props[to]) });
    done.add(from); done.add(to);
    adding.splice(adding.indexOf(to), 1);
  }
  for (const d of rule.decls) {
    if (!(d.prop in props) || done.has(d.prop)) continue;
    done.add(d.prop);
    const v = props[d.prop];
    if (v == null) {
      // REMOVED with the whitespace that led into it.
      let s = d.start; while (s > rule.openBrace + 1 && /[ \t]/.test(src[s - 1])) s -= 1;
      if (src[s - 1] === '\n') { s -= 1; while (s > rule.openBrace + 1 && src[s - 1] === '\r') s -= 1; }
      let e = d.end; if (src[e] === ';') e += 1;
      edits.push({ start: s, end: e, text: '' });
    } else {
      const r = valueRange(src, d);
      edits.push({ start: r.start, end: r.end, text: String(v) });
    }
  }
  const add = Object.entries(props).filter(([p, v]) => !done.has(p) && v != null);
  if (add.length) {
    const last = rule.decls[rule.decls.length - 1];
    const multiline = /\n/.test(src.slice(rule.openBrace, rule.closeBrace));
    if (last) {
      let at = last.end; const needSemi = src[at - 1] !== ';';
      if (multiline) {
        const ls = src.lastIndexOf('\n', last.start - 1) + 1;
        const ind = /^[ \t]*/.exec(src.slice(ls))[0];
        edits.push({ start: at, end: at, text: `${needSemi ? ';' : ''}${add.map(([p, v]) => `\n${ind}${p}: ${v};`).join('')}` });
      } else edits.push({ start: at, end: at, text: `${needSemi ? ';' : ''}${add.map(([p, v]) => ` ${p}: ${v};`).join('')}` });
    } else {
      const at = rule.closeBrace;
      edits.push(multiline ? { start: at, end: at, text: `${add.map(([p, v]) => `  ${p}: ${v};\n`).join('')}` } : { start: at, end: at, text: `${src[at - 1] === ' ' ? '' : ' '}${add.map(([p, v]) => `${p}: ${v};`).join(' ')} ` });
    }
  }
  return edits;
}

/** Splice: a new rule at the end of the sheet, written in the sheet's own one-line style when it has one. */
function addRule(src, selector, props) {
  const body = Object.entries(props).filter(([, v]) => v != null).map(([p, v]) => `${p}: ${v};`).join(' ');
  const nl = src.endsWith('\n') ? '' : '\n';
  return { start: src.length, end: src.length, text: `${nl}${selector} { ${body} }\n` };
}

/** The declared value of `prop` for `.cls`, or null. */
function declared(sheet, cls, prop) {
  for (const r of rulesForClass(sheet, cls)) for (const d of r.decls) if (d.prop === prop) return { rule: r, decl: d };
  return null;
}

module.exports = { parse, rulesForClass, setDecls, addRule, declared, valueRange };
