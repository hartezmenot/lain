'use strict';

/**
 * THE CSS ORIGIN (D9) — for any framework, ask the browser which declaration wins for a property on an element
 * (CDP `CSS.getMatchedStylesForNode`), then follow the stylesheet's source map (SCSS, CSS modules, Vue/Svelte
 * <style>, PostCSS) back to the file and line that wrote it, with its selector, specificity, `!important` and the
 * `@media` it sits in. Style edits need no markup mapping: they edit the rule that actually applies.
 *
 * Positions are 1-based lines and 0-based columns in the ORIGINAL file (`rel`, project-relative).
 */

const fs = require('fs');
const path = require('path');

let SMC = null;
function consumer(raw) { if (!SMC) SMC = require('source-map-js').SourceMapConsumer; return new SMC(raw); }

function dataUrl(u) {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(u || '');
  if (!m) return null;
  return m[1] ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]);
}

class StyleOrigin {
  /** `h` a Headless (its page shows the app at `previewUrl`), `root` the project. */
  constructor(h, root, previewUrl) {
    this.h = h; this.root = path.resolve(root); this.base = previewUrl;
    this.sheets = new Map(); this.maps = new Map(); this.enabled = false;
    h.handlers.push((msg) => {
      if (msg.method === 'CSS.styleSheetAdded') this.sheets.set(msg.params.header.styleSheetId, msg.params.header);
      if (msg.method === 'CSS.styleSheetRemoved') this.sheets.delete(msg.params.styleSheetId);
      if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) { this.sheets.clear(); this.enabled = false; }
    });
  }

  send(m, p) { return this.h.page.send(m, p); }

  async enable() {
    if (this.enabled) return;
    await this.send('DOM.enable'); await this.send('CSS.enable');
    this.enabled = true;
  }

  async nodeId(selector) {
    await this.enable();
    const doc = await this.send('DOM.getDocument', { depth: 0 });
    const r = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!r.nodeId) throw new Error(`no element ${selector} on the page`);
    return r.nodeId;
  }

  /** Every author declaration of `prop` that applies to the element, in cascade order, and the winner. */
  async cascade(selector, prop) {
    const nodeId = await this.nodeId(selector);
    const m = await this.send('CSS.getMatchedStylesForNode', { nodeId });
    const decls = [];
    const fromStyle = (style, rule, order) => {
      for (const p of (style && style.cssProperties) || []) {
        if (p.name !== prop || p.disabled || p.parsedOk === false || !p.range) continue;
        decls.push({ value: String(p.value).replace(/\s*!important\s*$/i, ''), important: Boolean(p.important), range: p.range, styleSheetId: style.styleSheetId, rule, order });
      }
    };
    let order = 0;
    for (const rm of m.matchedCSSRules || []) {
      const r = rm.rule;
      if (r.origin !== 'regular') { order += 1; continue; }
      const sels = (r.selectorList && r.selectorList.selectors) || [];
      const matched = (rm.matchingSelectors || []).map((i) => sels[i]).filter(Boolean);
      const spec = matched.map((s) => s.specificity).filter(Boolean).sort((a, b) => b.a - a.a || b.b - a.b || b.c - a.c)[0] || null;
      fromStyle(r.style, { selector: r.selectorList.text, matched: matched.map((s) => s.text), specificity: spec, media: (r.media || []).map((x) => x.text), styleRange: r.style.range, styleSheetId: r.styleSheetId }, order);
      order += 1;
    }
    if (m.inlineStyle) fromStyle(m.inlineStyle, { inline: true, selector: 'style=""', media: [] }, 1e6);
    // THE WINNER: !important beats normal; then inline beats rules; then later in cascade order (the protocol's
    // matchedCSSRules are in ascending cascade order).
    const rank = (d) => (d.important ? 2e6 : 0) + d.order;
    const winner = decls.slice().sort((a, b) => rank(b) - rank(a))[0] || null;
    const rules = (m.matchedCSSRules || []).filter((rm) => rm.rule.origin === 'regular').map((rm) => ({ selector: rm.rule.selectorList.text, media: (rm.rule.media || []).map((x) => x.text), styleRange: rm.rule.style.range, styleSheetId: rm.rule.styleSheetId }));
    return { nodeId, prop, winner, decls, rules };
  }

  /** The sheet's source map, fetched once (inline data: URL, or by URL from the preview). */
  async mapFor(header) {
    if (!header || !header.sourceMapURL) return null;
    if (this.maps.has(header.styleSheetId)) return this.maps.get(header.styleSheetId);
    let raw = dataUrl(header.sourceMapURL);
    if (!raw) {
      try {
        const u = new URL(header.sourceMapURL, header.sourceURL || this.base).href;
        const r = await require('./launch').get(u, 4000);
        raw = r && r.status === 200 ? r.body : null;
      } catch { raw = null; }
    }
    let c = null; try { c = raw ? consumer(raw) : null; } catch { c = null; }
    this.maps.set(header.styleSheetId, c);
    return c;
  }

  /** A served URL or a source-map source → a project-relative file, if it is one. */
  fileOf(ref, header) {
    if (!ref) return null;
    let p = String(ref).replace(/^file:\/\//, '').replace(/[?#].*$/, '');
    try { p = decodeURIComponent(p); } catch { /* as is */ }
    const tries = [];
    if (path.isAbsolute(p)) tries.push(p, path.join(this.root, p));
    else if (/^https?:/.test(p)) { const u = new URL(p); tries.push(path.join(this.root, u.pathname), path.join(this.root, 'public', u.pathname)); } else {
      tries.push(path.join(this.root, p));
      if (header && header.sourceURL && /^https?:/.test(header.sourceURL)) { const u = new URL(p, header.sourceURL); tries.push(path.join(this.root, u.pathname), path.join(this.root, 'public', u.pathname)); }
      tries.push(path.join(this.root, p.replace(/^(\.\.\/)+/, '')), path.join(this.root, p.replace(/^webpack:\/\/[^/]*\//, '').replace(/^\.\//, '')));
    }
    for (const t of tries) {
      const abs = path.resolve(t);
      if (!abs.startsWith(this.root + path.sep)) continue;
      if (/node_modules/.test(abs)) continue;
      try { if (fs.statSync(abs).isFile()) return path.relative(this.root, abs).replace(/\\/g, '/'); } catch { /* next */ }
    }
    return null;
  }

  /** The owner <style>'s data-vite-dev-id (Vite's injected styles name their file). */
  async ownerFile(header) {
    if (!header || !header.ownerNode) return null;
    try {
      const d = await this.send('DOM.describeNode', { backendNodeId: header.ownerNode });
      const a = d.node.attributes || [];
      const i = a.indexOf('data-vite-dev-id');
      if (i >= 0) return this.fileOf(a[i + 1].split('?')[0], header);
    } catch { /* none */ }
    return null;
  }

  /**
   * WHERE A DECLARATION (or a rule's block) WAS WRITTEN: { rel, line, col, via } or null. `range` is in the
   * stylesheet's generated text (0-based line/col).
   */
  async origin(styleSheetId, range) {
    const header = this.sheets.get(styleSheetId);
    if (!header) return null;
    const map = await this.mapFor(header);
    if (map) {
      for (const bias of [map.constructor.GREATEST_LOWER_BOUND, map.constructor.LEAST_UPPER_BOUND]) {
        const o = map.originalPositionFor({ line: range.startLine + 1, column: range.startColumn, bias });
        if (o && o.source) {
          const rel = this.fileOf(o.source, header) || this.fileOf(map.sourceRoot ? `${map.sourceRoot.replace(/\/$/, '')}/${o.source}` : null, header);
          if (rel) return { rel, line: o.line, col: o.column, via: 'sourcemap' };
        }
      }
    }
    // NO MAP: the sheet IS a file (a <link> to /css/site.css, or Vite's <style data-vite-dev-id> with the file's text),
    // or a webpack bundle whose banners name each source file (`!*** css …!./app/page.module.css ***!`).
    const text = (await this.send('CSS.getStyleSheetText', { styleSheetId })).text;
    let rel = (await this.ownerFile(header)) || (header.sourceURL && !/^(data|blob):/.test(header.sourceURL) ? this.fileOf(header.sourceURL, header) : null);
    if (!rel || !/\.(css|scss|sass|less|vue|svelte)$/.test(rel)) {
      const lines = text.split('\n').slice(0, range.startLine + 1).join('\n');
      const banners = [...lines.matchAll(/!\*{3} css [^\n]*?!\.\/([^\s!]+?\.(?:css|scss|sass|less)) \*{3}!/g)];
      const b = banners.pop();
      if (b) rel = this.fileOf(b[1], header);
    }
    if (!rel) return null;
    const file = fs.readFileSync(path.join(this.root, rel), 'utf8');
    if (text.replace(/\r\n/g, '\n').startsWith(file.replace(/\r\n/g, '\n').replace(/\s+$/, ''))) return { rel, line: range.startLine + 1, col: range.startColumn, via: 'identical' };
    // The served text differs (a PostCSS pass): find the same declaration text in the file, if it is unique.
    const lines = text.split('\n');
    const snippet = lines[range.startLine] ? lines[range.startLine].slice(range.startColumn, range.endLine === range.startLine ? range.endColumn : undefined).trim() : '';
    if (snippet) {
      const hits = []; let at = file.indexOf(snippet);
      while (at >= 0 && hits.length < 20) { hits.push(at); at = file.indexOf(snippet, at + 1); }
      // MORE THAN ONE: the one inside the rule whose selector this is (a CSS-module class unhashed to its local name).
      let pick = hits.length === 1 ? hits[0] : null;
      if (hits.length > 1) {
        const ruleSel = (() => { const before = text.split('\n').slice(0, range.startLine + 1).join('\n'); const open = before.lastIndexOf('{'); const prev = before.lastIndexOf('}', open); return before.slice(prev + 1, open).trim(); })();
        const local = ruleSel.replace(/\.[A-Za-z0-9-]+?_([\w-]+?)__[\w-]{5}\b/g, '.$1');
        const own = hits.filter((h) => { const b = file.slice(0, h); const open = b.lastIndexOf('{'); const prev = b.lastIndexOf('}', open); return b.slice(prev + 1, open).trim() === local; });
        if (own.length === 1) pick = own[0];
      }
      if (pick != null) { const before = file.slice(0, pick); const line = before.split('\n').length; return { rel, line, col: pick - (before.lastIndexOf('\n') + 1), via: 'text' }; }
    }
    return { rel, line: null, col: null, via: 'file-only' };
  }

  /** How many elements a rule's selector matches on this page (a shared class asks before it is changed). */
  async uses(selectorText) {
    const sels = String(selectorText || '').split(',').map((s) => s.trim().replace(/::?[\w-]+(\([^)]*\))?/g, '')).filter(Boolean);
    let n = 0;
    for (const s of sels) { try { n += await this.h.page.eval(`document.querySelectorAll(${JSON.stringify(s)}).length`); } catch { /* an unsupported selector */ } }
    return n;
  }

  /** Media queries that match the page now, from every author sheet (the active breakpoints). */
  async activeMedia() {
    const r = await this.send('CSS.getMediaQueries').catch(() => ({ medias: [] }));
    const out = new Set();
    for (const m of r.medias || []) {
      if (!m.styleSheetId || !this.sheets.has(m.styleSheetId)) continue;
      // eslint-disable-next-line no-await-in-loop
      try { if (await this.h.page.eval(`matchMedia(${JSON.stringify(m.text)}).matches`)) out.add(m.text); } catch { /* skip */ }
    }
    return [...out];
  }
}

// ---- writing into the original file ------------------------------------------------------------------------------

const lineStart = (src, line) => { let at = 0; for (let i = 1; i < line; i++) { const n = src.indexOf('\n', at); if (n < 0) return src.length; at = n + 1; } return at; };

/** The value span of `prop` at or after (line, col) in `src`: { start, end, value, declStart } or null. */
function declAt(src, line, col, prop) {
  const from = lineStart(src, line) + (col || 0);
  const re = new RegExp(`(^|[;{\\s])(${prop.replace(/[-]/g, '\\-')})\\s*:`, 'g');
  re.lastIndex = Math.max(0, from - 1);
  const m = re.exec(src);
  if (!m || m.index - from > 400) return null;
  let i = m.index + m[0].length;
  while (/[ \t]/.test(src[i])) i += 1;
  const vs = i; let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth += 1; else if (c === ')') depth -= 1;
    else if (c === '"' || c === "'") { const q = c; i += 1; while (i < src.length && src[i] !== q) i += 1; } else if (depth === 0 && (c === ';' || c === '}' || c === '\n')) break;
  }
  let ve = i; while (ve > vs && /\s/.test(src[ve - 1])) ve -= 1;
  let value = src.slice(vs, ve);
  const imp = /\s*!important\s*$/i.exec(value);
  if (imp) { ve -= imp[0].length; value = src.slice(vs, ve); }
  return { start: vs, end: ve, value, declStart: m.index + m[1].length };
}

/** Insert `prop: value;` into the rule whose block starts at (line, col) — the `{` at or after it. */
function addDecl(src, line, col, prop, value) {
  let at = lineStart(src, line) + (col || 0);
  while (at < src.length && src[at] !== '{') at += 1;
  if (src[at] !== '{') return null;
  let depth = 0; let i = at;
  for (; i < src.length; i++) { if (src[i] === '{') depth += 1; else if (src[i] === '}') { depth -= 1; if (depth === 0) break; } }
  const inner = src.slice(at + 1, i);
  if (/\n/.test(inner)) {
    const ind = (/\n([ \t]+)\S/.exec(inner) || [, '  '])[1];
    let end = i; while (end > at && /[ \t]/.test(src[end - 1])) end -= 1;
    const needsNl = src[end - 1] !== '\n';
    return { start: end, end, text: `${needsNl ? '\n' : ''}${ind}${prop}: ${value};\n` };
  }
  const t = inner.trimEnd();
  const sep = t && !t.endsWith(';') ? ';' : '';
  const ws = inner.slice(t.length);
  return { start: at + 1 + t.length, end: at + 1 + inner.length, text: `${sep} ${prop}: ${value};${ws || ' '}` };
}

/** A new `@media (…) { selector { prop: value } }`, or the rule added inside an existing block with that query. */
function mediaRule(src, query, selector, props) {
  const body = Object.entries(props).map(([p, v]) => `${p}: ${v};`);
  const at = src.indexOf(`@media ${query}`);
  if (at >= 0) {
    let i = src.indexOf('{', at); let depth = 0; let k = i;
    for (; k < src.length; k++) { if (src[k] === '{') depth += 1; else if (src[k] === '}') { depth -= 1; if (depth === 0) break; } }
    return { start: k, end: k, text: `  ${selector} {\n    ${body.join('\n    ')}\n  }\n` };
  }
  return { start: src.length, end: src.length, text: `${src.endsWith('\n') ? '' : '\n'}\n@media ${query} {\n  ${selector} {\n    ${body.join('\n    ')}\n  }\n}\n` };
}

module.exports = { StyleOrigin, declAt, addDecl, mediaRule, dataUrl };
