'use strict';

/** THE PROJECT AS SYMBOLS, not as text. */

const fs = require('fs');
const path = require('path');
const { tokenize, lineAt, matchBracket, supports, T } = require('./jsscan');

/** How a declaration is described. One word each, no synonyms. */
const KIND = Object.freeze({
  FUNCTION: 'function',
  CLASS: 'class',
  METHOD: 'method',
  VARIABLE: 'variable',
  PROPERTY: 'property',
  // TYPESCRIPT DECLARES THINGS THAT ARE NOT VALUES
  INTERFACE: 'interface',
  TYPE: 'type',
  ENUM: 'enum',
});

/** TYPE-LEVEL DECLARATIONS, and why they are matched so narrowly. */
const TYPE_DECLARATORS = new Set(['interface', 'type', 'enum']);

const DECLARATORS = new Set(['const', 'let', 'var']);

/** Names that resolve without being declared anywhere in the file. */
const GLOBALS = new Set([
  // language
  'undefined', 'NaN', 'Infinity', 'globalThis', 'arguments', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'AggregateError', 'Promise', 'Proxy', 'Reflect', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'WeakRef', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'Intl',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'Function', 'eval', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'escape', 'unescape',
  'structuredClone', 'queueMicrotask', 'AbortController', 'AbortSignal', 'Event',
  'EventTarget', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'Blob',
  'ReadableStream', 'WritableStream', 'TransformStream', 'CompressionStream',
  // node
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'console',
  'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'clearImmediate', 'global', 'performance', 'fetch', 'Headers', 'Request', 'Response',
  'FormData', 'WebSocket', 'crypto',
  // browser, because a project's frontend files run through the same check
  'window', 'document', 'navigator', 'location', 'history', 'localStorage',
  'sessionStorage', 'alert', 'confirm', 'prompt', 'HTMLElement', 'Element', 'Node',
  'CustomEvent', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'Image',
  'CSS', 'DOMParser', 'XMLHttpRequest', 'Worker', 'CanvasRenderingContext2D',
]);

/** Reserved words, which are never a reference to anything. */
const NOT_A_REFERENCE = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'let', 'new', 'return', 'static', 'super', 'switch',
  'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'async',
  'await', 'of', 'from', 'as', 'null', 'true', 'false', 'get', 'set',
]);

// ------------------------------------------------------------------ scan ----

function isPunct(t, v) { return t && t.type === T.PUNCT && t.value === v; }
function isName(t, v) { return t && t.type === T.NAME && (v === undefined || t.value === v); }

/** The end of a `const x = …` statement. */
function statementEnd(tokens, from) {
  let depth = 0;
  for (let k = from; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== T.PUNCT) continue;
    if (t.value === '{' || t.value === '(' || t.value === '[') depth += 1;
    else if (t.value === '}' || t.value === ')' || t.value === ']') {
      if (depth === 0) return k - 1;          // the enclosing block ended first
      depth -= 1;
    } else if (depth === 0 && (t.value === ';' || t.value === ',')) return k;
  }
  return tokens.length - 1;
}

/** THE `{` THAT OPENS A BODY, STEPPING OVER A RETURN TYPE. */
function bodyAfter(tokens, closeParen) {
  if (closeParen <= 0) return -1;
  let k = closeParen + 1;
  if (isPunct(tokens[k], '{')) return k;
  if (!isPunct(tokens[k], ':')) return -1;
  k += 1;
  let angle = 0;
  for (let steps = 0; k < tokens.length && steps < 120; steps++, k++) {
    const t = tokens[k];
    if (!t) return -1;
    if (t.type === T.PUNCT) {
      if (t.value === '<') { angle += 1; continue; }
      if (t.value === '>') { angle = Math.max(0, angle - 1); continue; }
      if (t.value === '{') {
        // `: { a: number }` is an inline object TYPE, not the body — a body never sits inside an unclosed generic, and a type that ends here is followed by the…
        if (angle > 0) return -1;
        return k;
      }
      if (t.value === ';' || t.value === '=' || t.value === ')' || t.value === '}' || t.value === ',') return -1;
      continue;      // . [ ] | & ? ( etc. are all type punctuation here
    }
    // NAME, STRING and NUMBER tokens are all legal inside a type.
  }
  return -1;
}

/** Every NAME inside a bracket group, for parameter and pattern collection. */
function namesIn(tokens, open, close, out) {
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k];
    if (t.type !== T.NAME) continue;
    if (isPunct(tokens[k - 1], '.')) continue;   // a member, not a binding
    if (NOT_A_REFERENCE.has(t.value)) continue;
    out.add(t.value);
  }
}

/** THE SECOND AND LATER NAMES IN ONE DECLARATION. */
function declaratorsAfter(tokens, from, bindings, add, container) {
  let depth = 0;
  for (let k = from; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === T.PUNCT) {
      if (t.value === '(' || t.value === '[' || t.value === '{') { depth += 1; continue; }
      if (t.value === ')' || t.value === ']' || t.value === '}') {
        if (depth === 0) return;                 // the enclosing block ended first
        depth -= 1;
        continue;
      }
      if (t.value === ';' && depth === 0) return;
      if (t.value !== ',' || depth !== 0) continue;
      const next = tokens[k + 1];
      if (!next) return;
      if (isPunct(next, '{') || isPunct(next, '[')) {
        const close = matchBracket(tokens, k + 1);
        if (close > 0) { namesIn(tokens, k + 1, close, bindings); k = close; }
        continue;
      }
      if (next.type === T.NAME && !NOT_A_REFERENCE.has(next.value)) {
        add(next.value, KIND.VARIABLE, k + 1, k + 1, container);
      }
    }
  }
}

/** Read one file into symbols, bindings, references and imports. */
function scan(source, file = '') {
  if (file && !supports(file)) {
    return { supported: false, why: `${path.extname(file) || 'this file type'} is not JavaScript`, symbols: [], bindings: new Set(), used: [], imports: [] };
  }
  const { tokens, lineStarts } = tokenize(String(source));
  const symbols = [];
  const bindings = new Set();
  const used = [];
  const imports = [];

  /** WHAT THIS DECLARATION BELONGS TO — a class, or the object literal it is a member of. */
  const containers = [];
  /** Token index at which each open container's body closes. */
  const closesAt = [];
  /** Bracket nesting at the current token, so "top level" means something. */
  let depth = 0;

  const at = (offset) => lineAt(lineStarts, offset);
  const add = (name, kind, startTok, endTok, container) => {
    const s = tokens[startTok];
    const e = tokens[endTok] || tokens[tokens.length - 1];
    if (!s || !e) return;
    symbols.push({
      name,
      kind,
      container: container || null,
      depth,
      start: s.start,
      end: e.end,
      startLine: at(s.start),
      endLine: at(e.end),
    });
    bindings.add(name);
  };
  const enter = (name, closeTok) => {
    if (closeTok > 0) { containers.push(name); closesAt.push(closeTok); }
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    while (closesAt.length && k > closesAt[closesAt.length - 1]) { closesAt.pop(); containers.pop(); }
    if (t.type === T.PUNCT) {
      if (t.value === '{' || t.value === '(' || t.value === '[') depth += 1;
      else if (t.value === '}' || t.value === ')' || t.value === ']') depth = Math.max(0, depth - 1);
    }
    if (t.type !== T.NAME) continue;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];

    // ---- function declarations, including generators and async ------------
    if (t.value === 'function') {
      let n = k + 1;
      if (isPunct(tokens[n], '*')) n += 1;      // `function* runTurn`
      if (isName(tokens[n]) && !NOT_A_REFERENCE.has(tokens[n].value)) {
        const nameTok = n;
        const paren = isPunct(tokens[n + 1], '(') ? n + 1 : -1;
        const body = paren >= 0 ? bodyAfter(tokens, matchBracket(tokens, paren)) : -1;
        if (paren >= 0) namesIn(tokens, paren, matchBracket(tokens, paren), bindings);
        const close = body > 0 ? matchBracket(tokens, body) : -1;
        const start = isName(prev, 'async') ? k - 1 : k;
        if (close > 0) add(tokens[nameTok].value, KIND.FUNCTION, start, close, containers[containers.length - 1]);
        // NOT SKIPPED PAST THE BODY, and the earlier version was — `k = close` jumped the scanner over every function body in the file, so `used` held only the…
      }
      continue;
    }

    // ---- classes, and the body their methods belong to ---------------------
    if (t.value === 'class' && isName(next) && !NOT_A_REFERENCE.has(next.value)) {
      let b = k + 2;
      while (b < tokens.length && !isPunct(tokens[b], '{')) b += 1;
      const close = matchBracket(tokens, b);
      if (close > 0) {
        add(next.value, KIND.CLASS, k, close, containers[containers.length - 1]);
        enter(next.value, close);
      }
      continue;
    }

    // interface / type / enum — TypeScript's own declarations
    if (TYPE_DECLARATORS.has(t.value) && isName(next) && !NOT_A_REFERENCE.has(next.value)
      && !isPunct(prev, '.') && !isPunct(prev, '?') && !isPunct(prev, ',')) {
      const after = tokens[k + 2];
      // `type Fn<T> = …` IS STILL AN ALIAS.
      const aliasAhead = () => {
        for (let j = k + 2; j < Math.min(tokens.length, k + 42); j += 1) {
          if (isPunct(tokens[j], '=')) return true;
          if (isPunct(tokens[j], ';') || isPunct(tokens[j], '{') || isPunct(tokens[j], ')')) return false;
        }
        return false;
      };
      const alias = t.value === 'type' && (isPunct(after, '=') || (isPunct(after, '<') && aliasAhead()));
      const body = t.value !== 'type' && (isPunct(after, '{') || isName(after, 'extends') || isPunct(after, '<'));
      if (alias || body) {
        add(next.value,
          t.value === 'interface' ? KIND.INTERFACE : t.value === 'enum' ? KIND.ENUM : KIND.TYPE,
          k, k + 2, containers[containers.length - 1]);
        // NOT ENTERED AS A CONTAINER.
        continue;
      }
    }

    // ---- const / let / var, and destructuring patterns ---------------------
    if (DECLARATORS.has(t.value) && !isPunct(prev, '.')) {
      if (isPunct(next, '{') || isPunct(next, '[')) {
        const close = matchBracket(tokens, k + 1);
        if (close > 0) {
          // `const { a, b: c } = require('x')` binds `a` and `c`. Both are
          // collected: over-collecting a binding is the safe direction.
          namesIn(tokens, k + 1, close, bindings);
          k = close;
        }
        continue;
      }
      if (isName(next) && !NOT_A_REFERENCE.has(next.value)) {
        const end = statementEnd(tokens, k + 2);
        // A const whose value is a function is a FUNCTION, because that is what
        // a reader is looking for when they ask where it is defined.
        const v = tokens[k + 3];
        const arrowish = isName(v, 'function') || isName(v, 'async')
          || (isPunct(v, '(') && isPunct(tokens[matchBracket(tokens, k + 3) + 1], '=>'))
          || isPunct(tokens[k + 4], '=>');
        add(next.value, arrowish ? KIND.FUNCTION : KIND.VARIABLE, k, end, containers[containers.length - 1]);
        // `const tools = { … }` — its members belong to it, and are named
        // `tools.grep` rather than being reported as top-level declarations.
        if (isPunct(tokens[k + 3], '{')) enter(next.value, matchBracket(tokens, k + 3));
        // AND EVERY OTHER NAME IN THE SAME DECLARATION
        declaratorsAfter(tokens, k + 2, bindings, add, containers[containers.length - 1]);
        continue;
      }
    }

    // METHOD SHORTHAND, in a class body or an object literal
    if (isPunct(next, '(') && !NOT_A_REFERENCE.has(t.value) && !isPunct(prev, '.') && !isPunct(prev, '?.')
      // A declared function's NAME also matches "name, parens, block" — it IS one — and the `function` branch above has already recorded it.
      && !isName(prev, 'function') && !isName(prev, 'class')
      && !(isPunct(prev, '*') && isName(tokens[k - 2], 'function'))) {
      const closeParen = matchBracket(tokens, k + 1);
      const bodyAt = bodyAfter(tokens, closeParen);
      if (bodyAt > 0) {
        const closeBody = matchBracket(tokens, bodyAt);
        if (closeBody > 0) {
          namesIn(tokens, k + 1, closeParen, bindings);
          // The modifiers belong to the definition, so the range starts at them
          // — replacing a method without its `async` would change what it is.
          let start = k;
          while (isName(tokens[start - 1], 'async') || isName(tokens[start - 1], 'static')
            || isName(tokens[start - 1], 'get') || isName(tokens[start - 1], 'set')
            || isPunct(tokens[start - 1], '*')) start -= 1;
          const inClass = containers.length > 0 && closeBody <= closesAt[closesAt.length - 1];
          add(t.value, inClass ? KIND.METHOD : KIND.FUNCTION, start, closeBody,
            inClass ? containers[containers.length - 1] : null);
          continue;
        }
      }
    }

    // object literal members
    if (isPunct(next, ':') && !NOT_A_REFERENCE.has(t.value) && !isPunct(prev, '.') && !isPunct(prev, '?')) {
      const v = tokens[k + 2];
      let end = -1;
      let kind = KIND.PROPERTY;
      if (isPunct(v, '{') || isPunct(v, '[')) { end = matchBracket(tokens, k + 2); }
      else if (isName(v, 'function') || isName(v, 'async')) {
        let b = k + 3;
        while (b < tokens.length && !isPunct(tokens[b], '{')) b += 1;
        end = matchBracket(tokens, b);
        kind = KIND.FUNCTION;
      } else if (isPunct(v, '(')) {
        const cp = matchBracket(tokens, k + 2);
        if (isPunct(tokens[cp + 1], '=>')) {
          namesIn(tokens, k + 2, cp, bindings);
          end = statementEnd(tokens, cp + 2);
          kind = KIND.FUNCTION;
        }
      }
      if (end > 0) {
        add(t.value, kind, k, end, containers[containers.length - 1]);
        // NOT skipped past: an object literal's members are symbols too, and
        // walking into it is how they are found.
        if (isPunct(v, '{')) enter(t.value, end);
      }
      continue;
    }

    // ---- catch bindings ----------------------------------------------------
    if (t.value === 'catch' && isPunct(next, '(')) {
      const cp = matchBracket(tokens, k + 1);
      if (cp > 0) namesIn(tokens, k + 1, cp, bindings);
      continue;
    }

    // ---- imports ----------------------------------------------------------
    if (t.value === 'require' && isPunct(next, '(') && tokens[k + 2] && tokens[k + 2].type === T.STRING) {
      imports.push({ spec: tokens[k + 2].value.slice(1, -1), line: at(t.start) });
    }
    if (t.value === 'import') {
      for (let j = k + 1; j < tokens.length && j < k + 40; j++) {
        if (tokens[j].type === T.STRING) { imports.push({ spec: tokens[j].value.slice(1, -1), line: at(t.start) }); break; }
        if (isPunct(tokens[j], ';')) break;
      }
    }

    // ---- references --------------------------------------------------------
    if (NOT_A_REFERENCE.has(t.value)) continue;
    if (isPunct(prev, '.') || isPunct(prev, '?.')) continue;      // a member name
    if (isPunct(next, ':') ) continue;                            // a key or a label
    used.push({ name: t.value, offset: t.start, line: at(t.start), calls: isPunct(next, '(') });
  }

  // An arrow function's parameters are bound wherever they appear, and the loop above only reaches the ones attached to a declaration.
  for (let k = 0; k < tokens.length; k++) {
    if (!isPunct(tokens[k], '=>')) continue;
    const before = tokens[k - 1];
    if (isPunct(before, ')')) {
      // Walk back to the matching open paren.
      let depth = 0;
      for (let j = k - 1; j >= 0; j--) {
        if (isPunct(tokens[j], ')')) depth += 1;
        else if (isPunct(tokens[j], '(')) {
          depth -= 1;
          if (depth === 0) { namesIn(tokens, j, k - 1, bindings); break; }
        }
      }
    } else if (before && before.type === T.NAME) bindings.add(before.value);
  }

  return { supported: true, symbols, bindings, used, imports, tokens, lineStarts };
}

/** Read a file from disk and scan it. Never throws for an unreadable file. */
function scanFile(abs) {
  let source;
  try { source = fs.readFileSync(abs, 'utf8'); } catch (e) {
    return { supported: false, why: `could not read ${abs}: ${e.message}`, symbols: [], bindings: new Set(), used: [], imports: [] };
  }
  return { ...scan(source, abs), source };
}

/** Find one symbol by name in a file. */
function find(model, name, { container = null } = {}) {
  return model.symbols.filter((s) => s.name === name
    && (container == null || s.container === container));
}

module.exports = { scan, scanFile, find, KIND, GLOBALS, NOT_A_REFERENCE, statementEnd };
