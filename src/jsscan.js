'use strict';

/** A REAL SCANNER FOR JAVASCRIPT — the seam search.js said would need one. */

/** What a token can be. A `name` is an identifier or a keyword. */
const T = Object.freeze({
  NAME: 'name',
  PUNCT: 'punct',
  STRING: 'string',
  TEMPLATE: 'template',
  REGEX: 'regex',
  COMMENT: 'comment',
  NUMBER: 'number',
});

/** The keywords after which a `/` must begin a regular expression. */
const REGEX_AFTER = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await', 'if', 'while', 'switch',
]);

/** Reserved words, so a caller can tell `class` from a variable called cls. */
const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'let', 'new', 'return', 'static', 'super', 'switch',
  'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'async',
  'await', 'get', 'set', 'of', 'from', 'as', 'null', 'true', 'false',
]);

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;

/** Multi-character operators, longest first so `>>>=` is not read as `>>`. */
const OPERATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
];

/** Is the token before a `/` one that an expression can END with? */
function endsValue(tok) {
  if (!tok) return false;
  if (tok.type === T.NAME) return !REGEX_AFTER.has(tok.value);
  if (tok.type === T.NUMBER || tok.type === T.STRING || tok.type === T.TEMPLATE || tok.type === T.REGEX) return true;
  if (tok.type === T.PUNCT) {
    // `)` and `]` and `}` are genuinely ambiguous — `if (x) /re/.test(s)` is legal and so is `(a+b) / c`.
    return tok.value === ')' || tok.value === ']' || tok.value === '++' || tok.value === '--';
  }
  return false;
}

/** Read a regular expression literal starting at `i` (which points at `/`). */
function readRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return -1;                 // a regex literal cannot span lines
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j += 1;
      while (j < src.length && /[a-z]/.test(src[j])) j += 1;   // flags
      return j;
    }
    j += 1;
  }
  return -1;
}

/** Read a quoted string. Returns the index past the closing quote. */
function readString(src, i, quote) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === quote) return j + 1;
    // An unterminated string ends at the newline rather than eating the file.
    if (c === '\n') return j;
    j += 1;
  }
  return j;
}

/** Read a template literal, INCLUDING its `${...}` holes. */
function readTemplate(src, i) {
  let j = i + 1;
  let depth = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (depth === 0 && c === '`') return j + 1;
    if (depth === 0 && c === '$' && src[j + 1] === '{') { depth = 1; j += 2; continue; }
    if (depth > 0) {
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '`') { const end = readTemplate(src, j); j = end; continue; }
      else if (c === '"' || c === "'") { j = readString(src, j, c); continue; }
    }
    j += 1;
  }
  return j;
}

/** Tokenise a JavaScript source file. */
function tokenize(src, { comments = false } = {}) {
  const tokens = [];
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);

  let i = 0;
  let last = null;                 // last SIGNIFICANT token (comments excluded)
  const push = (type, start, end) => {
    const tok = { type, value: src.slice(start, end), start, end };
    if (type !== T.COMMENT) last = tok;
    if (type !== T.COMMENT || comments) tokens.push(tok);
    return tok;
  };

  while (i < src.length) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i += 1; continue; }

    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = src.length;
      push(T.COMMENT, i, j);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? src.length : j + 2;
      push(T.COMMENT, i, j);
      i = j;
      continue;
    }
    if (c === '/' && !endsValue(last)) {
      const j = readRegex(src, i);
      // THE SAFETY NET. An unterminated regex means the preceding-token rule guessed wrong and this is division after all. Falling through to the operator…
      if (j > 0) { push(T.REGEX, i, j); i = j; continue; }
    }
    if (c === '"' || c === "'") {
      const j = readString(src, i, c);
      push(T.STRING, i, j);
      i = j;
      continue;
    }
    if (c === '`') {
      const j = readTemplate(src, i);
      push(T.TEMPLATE, i, j);
      i = j;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j += 1;
      push(T.NAME, i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9a-fA-FxXoObBeE._n]/.test(src[j])) j += 1;
      push(T.NUMBER, i, j);
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) { push(T.PUNCT, i, i + op.length); i += op.length; continue; }
    push(T.PUNCT, i, i + 1);
    i += 1;
  }

  return { tokens, lineStarts };
}

/** 1-based line number for a byte offset, by binary search over line starts. */
function lineAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The index of the token closing the bracket opened at `tokens[from]`. */
function matchBracket(tokens, from) {
  const open = tokens[from] && tokens[from].value;
  const close = open === '{' ? '}' : open === '(' ? ')' : open === '[' ? ']' : null;
  if (!close) return -1;
  let depth = 0;
  for (let k = from; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== T.PUNCT) continue;
    if (t.value === open) depth += 1;
    else if (t.value === close) {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** FILES THIS SCANNER CLAIMS TO UNDERSTAND. */
const SUPPORTED = /\.(?:js|cjs|mjs|jsx|ts|tsx|mts|cts)$/i;

function supports(file) { return SUPPORTED.test(String(file || '')); }

module.exports = { tokenize, lineAt, matchBracket, supports, T, KEYWORDS, REGEX_AFTER, SUPPORTED };
