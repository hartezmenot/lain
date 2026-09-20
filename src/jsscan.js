'use strict';

/**
 * A REAL SCANNER FOR JAVASCRIPT — the seam search.js said would need one.
 *
 * `symbols` and `dependents` read files as TEXT: definitions by shape,
 * references by name. That is fast, language-agnostic and right most of the
 * time, and it is why they exist. What it cannot do is give the exact BYTE
 * RANGE of a definition, and it cannot tell a name in code from the same name
 * inside a comment or a string. Both of those are the difference between an
 * index and an edit:
 *
 *     rename `id` with a regex          → renames `id` inside every URL,
 *                                          every comment, every CSS selector
 *     replace a function with a regex   → 95% right, and the other 5% is a
 *                                          silently corrupted file
 *
 * So this tokenises. It is not a parser and does not build a tree — it produces
 * the one thing a tree would have been built for: a stream of tokens with exact
 * offsets, where a name is a NAME and a string is a STRING. Everything above it
 * (codemodel.js) works on tokens rather than on characters, which is what makes
 * a rename safe and a symbol range exact.
 *
 * THE HARD PART IS `/`. It begins a regular expression or it is division, and
 * which one depends on what came before it — `a / b` against `return /x/`.
 * There is no way to know without the grammar, so this uses the standard
 * preceding-token rule AND a safety net: a regex that does not terminate is
 * re-read as division. A tokeniser that desynchronises is worse than none,
 * because everything downstream then reports confident nonsense.
 *
 * DECLARED LIMITS, because the honest statement of what a tool cannot do is
 * what makes the rest of it trustworthy:
 *   · JavaScript, JSX and TypeScript. Not Python, not Go, not Rust.
 *   · No scope analysis: it says a name is a name, not which binding it is.
 *   · No type information of any kind. A type annotation is tokens like any
 *     other, so `x: string` can leave a `string` binding behind — noise the
 *     CAVEAT in locate.js already states for every answer built on this.
 * Anything outside that returns `supported: false` and the callers say so
 * rather than guessing.
 *
 * THIS PARAGRAPH USED TO SAY "Not JSX" AND "JSX-free TypeScript", while
 * `SUPPORTED` admitted neither TS nor JSX at all — so the documented limit and
 * the enforced one disagreed, and both were wrong. Measured on a real TS/React
 * project: JSX components, typed functions and their import specifiers all come
 * out correctly. What the scanner does is now what this says it does.
 */

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

/**
 * The keywords after which a `/` must begin a regular expression.
 *
 * `return /x/` is a regex; `count / 2` is division. The difference is entirely
 * in the token before the slash.
 */
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

/**
 * Is the token before a `/` one that an expression can END with?
 *
 * If it is, the slash is division. If not, a value is expected and the slash
 * opens a regex.
 */
function endsValue(tok) {
  if (!tok) return false;
  if (tok.type === T.NAME) return !REGEX_AFTER.has(tok.value);
  if (tok.type === T.NUMBER || tok.type === T.STRING || tok.type === T.TEMPLATE || tok.type === T.REGEX) return true;
  if (tok.type === T.PUNCT) {
    // `)` and `]` and `}` are genuinely ambiguous — `if (x) /re/.test(s)` is
    // legal and so is `(a+b) / c`. `}` is taken as ending a BLOCK (regex may
    // follow) and `)` as ending a parenthesised value (division follows),
    // because that is which way each is more commonly written. A wrong guess
    // here is recovered by the unterminated-regex fallback below.
    return tok.value === ')' || tok.value === ']' || tok.value === '++' || tok.value === '--';
  }
  return false;
}

/**
 * Read a regular expression literal starting at `i` (which points at `/`).
 *
 * @returns {number} the index just past the closing `/` and its flags, or -1 if
 *   it does not terminate on this line — which means the `/` was division and
 *   the caller must re-read it as such.
 */
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

/**
 * Read a template literal, INCLUDING its `${...}` holes.
 *
 * The holes are real code and can contain nested templates and braces, so this
 * counts depth rather than looking for the next backtick. Everything between
 * the backticks is returned as ONE token: nothing above needs to see inside a
 * template, and a name that appears in one is not a reference worth renaming
 * without a person looking at it.
 */
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

/**
 * Tokenise a JavaScript source file.
 *
 * @param {string} src
 * @param {object} [o]
 * @param {boolean} [o.comments=false] include comment tokens
 * @returns {{tokens: Array, lineStarts: number[]}}
 */
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
      // THE SAFETY NET. An unterminated regex means the preceding-token rule
      // guessed wrong and this is division after all. Falling through to the
      // operator branch keeps the stream synchronised; guessing again would
      // desynchronise the rest of the file.
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

/**
 * The index of the token closing the bracket opened at `tokens[from]`.
 *
 * Works on TOKENS, so a `}` inside a string or a comment cannot close a block —
 * which is the whole reason a brace counter over raw characters is not good
 * enough to define a symbol's range.
 *
 * @returns {number} the index of the closing token, or -1 if it never closes
 */
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

/**
 * FILES THIS SCANNER CLAIMS TO UNDERSTAND. Anything else gets an honest no.
 *
 * ------------------------------------------------------------------------
 * WHY TYPESCRIPT IS ON THIS LIST, AND WHAT IT COST TO LEAVE IT OFF.
 *
 * This read `/\.(?:js|cjs|mjs)$/i` while projectindex.js decided what to scan
 * with `/\.(?:js|jsx|mjs|cjs|ts|tsx)$/i`. Two lists, one of them wrong, and the
 * disagreement was SWALLOWED: the index marked a `.ts` file `lang: 'js'`, asked
 * for its symbols, was told "not JavaScript", and stored the file with NO
 * symbols and NO imports — no error, no warning, no degraded state.
 *
 * The effect on a TypeScript project is total. Measured on a real one
 * (toradb, 41 TS/TSX sources): the persisted index held 47 files and ZERO
 * symbols, so `locate`, `definitionsOf` and `importersOf` could never answer,
 * and every question about the project fell back to grep and whole-file reads
 * — the same regions, every turn, across every resume. That is the reread loop.
 *
 * THE SCANNER WAS ALWAYS ABLE TO DO IT. It is lexical, not a type checker, and
 * declaration SHAPES are the same in both languages; asked to scan the same
 * files with the gate bypassed it produced 1821 symbols with correct
 * containers and correct import specifiers, JSX included. The gate was the only
 * thing in the way.
 *
 * WHAT IT STILL IS: lexical. A type annotation can read as a declaration
 * (`x: string` can yield a `string` binding), and that noise is the same class
 * the CAVEAT in locate.js already states for every answer built on this. It is
 * worth far less than answering "unknown" about every symbol in the project.
 *
 * ONE LIST. Every caller asks `supports()`; nobody keeps a private copy. See
 * tests/unit/codemodel.test.js, which fails if a second list appears.
 */
const SUPPORTED = /\.(?:js|cjs|mjs|jsx|ts|tsx|mts|cts)$/i;

function supports(file) { return SUPPORTED.test(String(file || '')); }

module.exports = { tokenize, lineAt, matchBracket, supports, T, KEYWORDS, REGEX_AFTER, SUPPORTED };
