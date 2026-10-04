'use strict';

/**
 * JSX, BY OFFSETS. The React adapter's parser and writers: the same tree shape `html.js` gives (so the structural
 * splices — remove, insert, reorder — are shared), with JSX's own attribute, style-object and text writers. Ids come
 * from file:line:col exactly as the Vite plugin computes them for `data-lain-id`, so the canvas, the served page and
 * the tools agree on every element.
 */

const babel = require('@babel/parser');
const { idFor, splice } = require('./text');

const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^ms-/, '-ms-');
const camel = (p) => p.replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function nameOfNode(n) {
  if (!n) return '';
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXMemberExpression') return `${nameOfNode(n.object)}.${nameOfNode(n.property)}`;
  if (n.type === 'JSXNamespacedName') return `${n.namespace.name}:${n.name.name}`;
  return '';
}

function parseAst(src, rel) {
  const ts = /\.tsx?$/i.test(rel);
  return babel.parse(src, { sourceType: 'module', errorRecovery: true, plugins: ['jsx', ...(ts ? ['typescript'] : [])] });
}

function staticString(v) {
  if (!v) return null;
  if (v.type === 'StringLiteral') return v.value;
  if (v.type === 'JSXExpressionContainer') return staticString(v.expression);
  if (v.type === 'TemplateLiteral' && !v.expressions.length) return v.quasis.map((q) => q.value.cooked).join('');
  return null;
}

/** The JSX tree of a file: { all, byId, roots, body:null } — elements carry the html.js fields plus JSX ones. */
function parse(src, rel) {
  const ast = parseAst(src, rel);
  const all = []; const byId = new Map(); const roots = [];
  (function walk(n, parent, direct) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'JSXElement') {
      const o = n.openingElement;
      const tag = nameOfNode(o.name);
      const el = {
        id: idFor(rel, o.loc.start.line, o.loc.start.column + 1), file: rel, tag, host: /^[a-z]/.test(tag) && !tag.includes('.'),
        attrs: {}, attrLoc: {}, classes: [], classStatic: true, styleObj: null, styleComputed: false,
        start: n.start, end: n.end, startTag: { start: o.start, end: o.end }, endTag: n.closingElement ? { start: n.closingElement.start, end: n.closingElement.end } : null,
        nameEnd: o.name.end, void: o.selfClosing, line: o.loc.start.line, col: o.loc.start.column + 1,
        children: [], parent: parent ? parent.id : null, text: '', textLoc: [],
      };
      for (const a of o.attributes) {
        if (a.type !== 'JSXAttribute') continue;
        const name = nameOfNode(a.name);
        const value = a.value == null ? '' : staticString(a.value);
        el.attrs[name] = value;   // null: an expression
        el.attrLoc[name] = { start: a.start, end: a.end, valueStart: a.value ? a.value.start : a.end, valueEnd: a.value ? a.value.end : a.end };
        if (name === 'className') { if (value != null) el.classes = value.split(/\s+/).filter(Boolean); else el.classStatic = false; }
        if (name === 'style') {
          const ex = a.value && a.value.type === 'JSXExpressionContainer' ? a.value.expression : null;
          if (ex && ex.type === 'ObjectExpression' && ex.properties.every((p) => p.type === 'ObjectProperty' && !p.computed)) {
            el.styleObj = { start: ex.start, end: ex.end, props: ex.properties.map((p) => ({ key: p.key.name || p.key.value, value: staticString(p.value) != null ? staticString(p.value) : (p.value.type === 'NumericLiteral' ? String(p.value.value) : null), start: p.start, end: p.end, valueStart: p.value.start, valueEnd: p.value.end })) };
          } else el.styleComputed = true;
        }
      }
      for (const c of n.children) {
        if (c.type === 'JSXText' && c.value.trim()) { el.textLoc.push({ start: c.start, end: c.end, value: c.value }); el.text += c.value.trim().replace(/\s+/g, ' '); }
      }
      el.text = el.text.slice(0, 120);
      all.push(el); byId.set(el.id, el);
      if (parent && direct) parent.children.push(el.id); else if (!parent) roots.push(el.id);
      for (const c of n.children) {
        if (c.type === 'JSXElement') walk(c, el, true);
        else if (c.type === 'JSXFragment') walkFragment(c, el);
        else walk(c, el, false);
      }
      for (const a of o.attributes) walk(a, el, false);
      return;
    }
    function walkFragment(f, p) { for (const c of f.children) { if (c.type === 'JSXElement') walk(c, p, true); else if (c.type === 'JSXFragment') walkFragment(c, p); else walk(c, p, false); } }
    if (n.type === 'JSXFragment' && parent) { walkFragment(n, parent); return; }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => walk(x, parent, false)); else if (v && typeof v.type === 'string') walk(v, parent, false);
    }
  }(ast.program, null, false));
  return { all, byId, roots, body: null, ast };
}

const jsxString = (v) => (/["{}<>\n]/.test(v) ? `{${JSON.stringify(v)}}` : `"${v}"`);

/** Splice: set (or, with null, remove) a JSX attribute to a static string. */
function setAttr(src, el, name, value) {
  const loc = el.attrLoc[name];
  if (value == null) {
    if (!loc) return null;
    let s = loc.start; while (s > 0 && /[ \t]/.test(src[s - 1])) s -= 1;
    return { start: s, end: loc.end, text: '' };
  }
  if (loc) return { start: loc.start, end: loc.end, text: `${name}=${jsxString(value)}` };
  return { start: el.nameEnd, end: el.nameEnd, text: ` ${name}=${jsxString(value)}` };
}

/** The inline style object's declarations, as CSS: [{prop, value}]. */
function declsOf(el) {
  return el.styleObj ? el.styleObj.props.filter((p) => p.value != null).map((p) => ({ prop: kebab(p.key), value: p.value })) : [];
}

const jsValue = (v) => (/^-?\d+(\.\d+)?$/.test(String(v)) ? String(v) : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`);
const keyText = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`);

/** Splices: set CSS props (kebab, value or null) in the element's `style={{…}}` object, adding it when absent. */
function setStyleObj(src, el, props) {
  if (el.styleComputed) throw new Error(`${el.tag}'s style is computed in code — change it in the IDE or through the Agent`);
  const entries = Object.entries(props);
  if (!el.styleObj) {
    const add = entries.filter(([, v]) => v != null).map(([p, v]) => `${keyText(camel(p))}: ${jsValue(v)}`);
    if (!add.length) return [];
    return [{ start: el.nameEnd, end: el.nameEnd, text: ` style={{ ${add.join(', ')} }}` }];
  }
  const edits = []; const adds = [];
  const obj = el.styleObj;
  for (const [p, v] of entries) {
    const k = camel(p);
    const i = obj.props.findIndex((x) => x.key === k);
    if (i >= 0) {
      const cur = obj.props[i];
      if (v != null) { edits.push({ start: cur.valueStart, end: cur.valueEnd, text: jsValue(v) }); continue; }
      // REMOVE the property and the comma that joins it to a neighbour.
      const after = src.slice(cur.end); const m = /^\s*,[ \t]*/.exec(after);
      if (m) edits.push({ start: cur.start, end: cur.end + m[0].length, text: '' });
      else { const before = src.slice(obj.start, cur.start); const mb = /,\s*$/.exec(before); edits.push({ start: mb ? obj.start + mb.index : cur.start, end: cur.end, text: '' }); }
    } else if (v != null) adds.push(`${keyText(k)}: ${jsValue(v)}`);
  }
  if (adds.length) {
    const close = obj.end - 1;   // the object's `}`
    const inner = src.slice(obj.start + 1, close);
    if (!obj.props.length) edits.push({ start: obj.start + 1, end: close, text: ` ${adds.join(', ')} ` });
    else {
      const last = obj.props[obj.props.length - 1];
      const tail = src.slice(last.end, close);
      const hasComma = /^\s*,/.test(tail);
      const multi = /\n/.test(inner);
      const ind = multi ? (/\n([ \t]*)\S/.exec(inner) || [, '  '])[1] : '';
      edits.push({ start: last.end, end: last.end, text: (hasComma ? '' : ',') + adds.map((a) => (multi ? `\n${ind}${a}` : ` ${a}`)).join(',') + (hasComma ? ',' : '') });
    }
  }
  return edits;
}

/** Splice: the element's text, safe for JSX. */
function setText(src, el, text) {
  const t = el.textLoc[0];
  const safe = /[{}<>]/.test(text) ? `{${JSON.stringify(text)}}` : text;
  if (t) {
    const lead = /^\s*/.exec(t.value)[0]; const trail = /\s*$/.exec(t.value)[0];
    return { start: t.start, end: t.end, text: `${lead}${safe}${trail}` };
  }
  if (el.void || !el.endTag) return null;
  return { start: el.startTag.end, end: el.startTag.end, text: safe };
}

/** The served copy: `data-lain-id` on every host element (the Vite plugin calls this on the module source). */
function instrument(src, rel) {
  let tree;
  try { tree = parse(src, rel); } catch { return src; }
  const edits = tree.all.filter((el) => el.host && !el.attrLoc['data-lain-id']).map((el) => ({ start: el.nameEnd, end: el.nameEnd, text: ` data-lain-id="${el.id}"` }));
  return edits.length ? splice(src, edits) : src;
}

/** `import x from '…'` statements: [{ source, start, end, local }] and where a new import goes. */
function imports(src, rel) {
  const ast = parseAst(src, rel);
  const out = []; let after = 0;
  for (const n of ast.program.body) {
    if (n.type === 'ImportDeclaration') { out.push({ source: n.source.value, start: n.start, end: n.end, local: n.specifiers[0] ? n.specifiers[0].local.name : null }); after = n.end; }
  }
  return { list: out, insertAt: after };
}

module.exports = { parse, setAttr, setStyleObj, declsOf, setText, instrument, imports, kebab, camel, staticString };
