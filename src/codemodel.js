'use strict';

/**
 * THE PROJECT AS SYMBOLS, not as text.
 *
 * Built on jsscan.js's token stream, so everything here knows the difference
 * between a name in code and the same characters inside a string, a comment or
 * a regular expression. That distinction is what separates an index from an
 * edit: `symbols` in search.js can tell you `send` appears in eleven files, and
 * nothing lexical can tell you which of those eleven you may safely rewrite.
 *
 * WHAT IT PRODUCES for one file:
 *
 *   symbols     every declaration, with its EXACT byte range and its container
 *   bindings    every name that could be a local binding — deliberately
 *               over-collected, see below
 *   used        every bare identifier reference, with its offset
 *   imports     specifiers, with the names they bind
 *
 * WHY `bindings` OVER-COLLECTS, and why that is the correct direction. It feeds
 * the unresolved-name check, whose entire value depends on never crying wolf: a
 * checker that flags one correct name teaches the model to stop reading the
 * channel, and then it catches nothing at all. Missing a real typo costs one
 * bug that the tests were going to find anyway. Reporting a false one costs the
 * channel. So every construction that MIGHT bind a name is treated as binding
 * it, and the check stays quiet whenever it is unsure.
 *
 * NO STORE. Nothing here is written to disk or cached across a turn. V1's
 * `.lain/index.json` was rebuilt at startup and then aged with every edit LAIN
 * made, so it answered confidently from stale data for the rest of the session.
 * These functions read the file that is on disk at the moment they are called;
 * there is nothing to go stale.
 *
 * WHAT `used` DOES NOT CONTAIN, because it decides what the typo check can
 * catch: A TEMPLATE LITERAL IS ONE TOKEN, holes included, so a name referenced
 * only inside `${…}` is not in `used`. That is a MISS, never a false report —
 * the name is simply never examined — and it is the direction this whole
 * subsystem fails in on purpose. It also means a dead-code sweep built on
 * `used` will call a helper unused when every call to it is interpolated;
 * checking this file's own modules for dead exports found exactly that, twice.
 */

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
  // ---- TYPESCRIPT DECLARES THINGS THAT ARE NOT VALUES ---------------------
  //
  // `interface StallPolicy` and `type Item` are DECLARATIONS a person looks for
  // by name exactly as often as a class — and they were invisible. A TS project
  // indexed its functions and classes and answered "where is StallPolicy
  // defined?" with nothing, which sends the model straight back to grep for a
  // fact the index should have had. Measured on a real TS fixture, 2026-09-15.
  INTERFACE: 'interface',
  TYPE: 'type',
  ENUM: 'enum',
});

/**
 * TYPE-LEVEL DECLARATIONS, and why they are matched so narrowly.
 *
 * `type` is NOT a reserved word in JavaScript: `type = 4`, `obj.type`, and
 * `{ type: 'x' }` are all ordinary code, and treating every one of them as a
 * declaration would fill the index with noise that looks authoritative. So a
 * match requires the shape a declaration actually has — the keyword, then a
 * name, then `=` for an alias or `{`/`extends` for an interface — and anything
 * else is left alone.
 */
const TYPE_DECLARATORS = new Set(['interface', 'type', 'enum']);

const DECLARATORS = new Set(['const', 'let', 'var']);

/**
 * Names that resolve without being declared anywhere in the file.
 *
 * The list is long on purpose. Every name missing from it is a potential false
 * report, and a false report is the one thing the unresolved check must not
 * produce — so when in doubt a name goes in.
 */
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

/**
 * The end of a `const x = …` statement.
 *
 * Scans forward over BALANCED brackets, so an initialiser that is an object, an
 * array or a function body is included whole, and stops at the first `;` or `,`
 * that is not inside one of them. That is what makes the range of a
 * function-valued const the whole function.
 */
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

/**
 * THE `{` THAT OPENS A BODY, STEPPING OVER A RETURN TYPE.
 *
 * `function addMovie(m) {` and `function addMovie(m: Row): Promise<void> {` are
 * the same declaration; only the second carries an annotation between the
 * parameter list and the body. Both branches below used to require the `{` to
 * sit immediately after the `)`, so in TypeScript EVERY function with a
 * declared return type vanished from the index — and in typed code that is most
 * exported functions. Measured: `export function addMovie(m: Row):
 * Promise<void>` produced no symbol at all.
 *
 * Only type-shaped tokens may be stepped over, and never a `;`, `=` or `)`,
 * so an interface member (`foo(): void;`) or a call is not mistaken for a body.
 *
 * @returns {number} index of the opening `{`, or -1
 */
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
        // `: { a: number }` is an inline object TYPE, not the body — a body
        // never sits inside an unclosed generic, and a type that ends here is
        // followed by the real `{`.
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

/**
 * THE SECOND AND LATER NAMES IN ONE DECLARATION.
 *
 * `const a = 1, b = 2;` and `let x, { y } = o;` are single statements that bind
 * more than one name. Walking from just past the first declarator to the end of
 * the statement, a comma AT THE STATEMENT'S OWN BRACKET DEPTH starts the next
 * one — a comma inside `f(a, b)` or `{ a, b }` does not.
 *
 * `statementEnd` deliberately stops at the FIRST top-level comma — it marks one
 * declarator — so this walks to the end of the whole DECLARATION instead: a
 * `;` at depth 0, or the closing bracket of whatever encloses it.
 *
 * @param {Array} tokens
 * @param {number} from   first token after the first declared name
 * @param {Set} bindings
 * @param {Function} add  (name, kind, startTok, endTok, container)
 * @param {string|null} container
 */
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

/**
 * Read one file into symbols, bindings, references and imports.
 *
 * @param {string} source
 * @param {string} [file] only used to decide whether this is a file we claim to
 *   understand; pass '' to scan anyway.
 */
function scan(source, file = '') {
  if (file && !supports(file)) {
    return { supported: false, why: `${path.extname(file) || 'this file type'} is not JavaScript`, symbols: [], bindings: new Set(), used: [], imports: [] };
  }
  const { tokens, lineStarts } = tokenize(String(source));
  const symbols = [];
  const bindings = new Set();
  const used = [];
  const imports = [];

  /**
   * WHAT THIS DECLARATION BELONGS TO — a class, or the object literal it is a
   * member of.
   *
   * Object literals are containers too, and leaving them out was not a
   * simplification: `ENEMIES = { slime: {…} }` put `slime` at the top level of
   * the file, so listing "what is defined here" answered with the innards of
   * every data table in it. This project is largely written as registries of
   * objects — `tools`, `MODE_GUIDANCE`, `OPS` — and `tools.grep` is the name a
   * person would use for that symbol.
   */
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
        // NOT SKIPPED PAST THE BODY, and the earlier version was — `k = close`
        // jumped the scanner over every function body in the file, so `used`
        // held only the handful of names at module scope. The unresolved check
        // then had almost nothing to check and reported nothing, which reads
        // exactly like a clean file. Walking in is also how nested declarations
        // are found at all.
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

    // ---- interface / type / enum — TypeScript's own declarations -----------
    //
    // SHAPE-CHECKED, NOT KEYWORD-CHECKED. None of these three words is reserved
    // in JavaScript, so `type` as a variable, a property or an object key must
    // not be read as a declaration. What distinguishes one is what FOLLOWS the
    // name: `=` for an alias, `{` or `extends` for an interface or enum body.
    if (TYPE_DECLARATORS.has(t.value) && isName(next) && !NOT_A_REFERENCE.has(next.value)
      && !isPunct(prev, '.') && !isPunct(prev, '?') && !isPunct(prev, ',')) {
      const after = tokens[k + 2];
      // `type Fn<T> = …` IS STILL AN ALIAS. The `=` is just behind the type
      // parameters, so a bounded look-ahead finds it — bounded because an
      // unbounded one would happily read `type < 4` as a declaration by finding
      // an `=` somewhere later in the file.
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
        // NOT ENTERED AS A CONTAINER. The members of a type are its shape, not
        // declarations a person navigates to by name, and indexing every field
        // of every interface would bury the names that are actually looked up.
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
        // ---- AND EVERY OTHER NAME IN THE SAME DECLARATION -----------------
        //
        // `const runtime = f(), sheet = g();` declares TWO names. Only the
        // first was registered, so every later one read as a use of something
        // undeclared — and the unresolved check then offered the nearest
        // binding as a near miss. Observed: `sheet` reported as a typo for
        // `sent`, in working code. A declaration list is one statement and all
        // of its names are bindings.
        declaratorsAfter(tokens, k + 2, bindings, add, containers[containers.length - 1]);
        continue;
      }
    }

    // ---- METHOD SHORTHAND, in a class body or an object literal ------------
    //
    // `run(input, ctx) { … }`, `async call(op) { … }`, `get length() { … }`.
    // One rule covers all of them: a NAME, a balanced parameter list, and then
    // a BLOCK. A call expression is never followed by `{`, and every construct
    // that is — if, while, for, switch, catch — leads with a keyword, which is
    // excluded above.
    //
    // THE NARROWER VERSION OF THIS MISSED HALF OF THEM. It required the method
    // to sit directly in a class body and to follow a comma, so the first
    // member after `{`, and every `async`/`get`/`static`-prefixed one, was read
    // as a CALL to an undeclared name — which is exactly the false report the
    // unresolved check must never make. It was caught by running the check
    // against this repository, where the only thing it flagged was itself.
    if (isPunct(next, '(') && !NOT_A_REFERENCE.has(t.value) && !isPunct(prev, '.') && !isPunct(prev, '?.')
      // A declared function's NAME also matches "name, parens, block" — it IS
      // one — and the `function` branch above has already recorded it. Without
      // this, every declaration in the file was registered TWICE, and then
      // every lookup of it was refused as ambiguous against itself.
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

    // ---- object literal members -------------------------------------------
    //
    // `tools = { grep: { … } }` and `{ run(input, ctx) { … } }` are how a great
    // deal of this project is written, and a symbol index that cannot name
    // `grep` cannot edit it either.
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

  // An arrow function's parameters are bound wherever they appear, and the loop
  // above only reaches the ones attached to a declaration. This second pass
  // catches `arr.map((item) => …)` and `x => x.id`, both of which bind a name
  // that nothing else in the file declares.
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

/**
 * Find one symbol by name in a file.
 *
 * A name can be declared more than once — two classes with a `send` method, an
 * inner helper shadowing an outer one — and picking one silently is how an edit
 * lands in the wrong place. So ALL matches come back and the caller is
 * responsible for refusing when there is more than one.
 */
function find(model, name, { container = null } = {}) {
  return model.symbols.filter((s) => s.name === name
    && (container == null || s.container === container));
}

module.exports = { scan, scanFile, find, KIND, GLOBALS, NOT_A_REFERENCE, statementEnd };
