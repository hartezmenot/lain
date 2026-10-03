'use strict';

/** SEARCH — finding code without reading it. */

const fs = require('fs');
const path = require('path');
const { SKIP } = require('../project');

const MAX_FILES_VISITED = 20_000;
const MAX_DEPTH = 20;
const MAX_MATCHES = 200;
const MAX_GLOB_RESULTS = 300;
/** Per file. Larger than this and it is data, not source. */
const MAX_FILE_BYTES = 2_000_000;
const MAX_LINE_CHARS = 300;

/** Binary sniff. A NUL in the first block means the "lines" of this file are not lines, and emitting them corrupts the transcript — V1 shipped a source… */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Translate a glob to a RegExp. */
function globToRegExp(glob, { caseInsensitive = process.platform === 'win32' } = {}) {
  const g = String(glob || '').replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` may match nothing at all, so `**/*.js` also matches `a.js`.
        if (g[i + 2] === '/') { out += '(?:[^/]*\\/)*'; i += 2; }
        else { out += '.*'; i += 1; }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const close = g.indexOf('}', i);
      if (close < 0) out += '\\{';
      else {
        out += '(?:' + g.slice(i + 1, close).split(',').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = close;
      }
    } else if ('.+^$()|[]\\'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp('^' + out + '$', caseInsensitive ? 'i' : '');
}

/** Walk the project, yielding project-relative POSIX paths. */
function* walk(root, { maxDepth = MAX_DEPTH } = {}) {
  const stack = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      if (++visited > MAX_FILES_VISITED) return;
      yield { abs, rel: path.relative(root, abs).replace(/\\/g, '/') };
    }
  }
}

function resolveRoot(cwd, p) {
  const base = cwd || process.cwd();
  if (!p) return base;
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

/** IS THIS FILE INSIDE `include`? */
function inScope(includeRe, f, cwd) {
  if (!includeRe || includeRe.test(f.rel)) return true;
  const fromProject = path.relative(cwd || process.cwd(), f.abs).replace(/\\/g, '/');
  return !fromProject.startsWith('..') && includeRe.test(fromProject);
}

const tools = {
  grep: {
    mutates: false,
    schema: {
      name: 'grep',
      description:
        'Search file CONTENTS with a regular expression and get back matching lines with their file and line number. '
        + 'Far cheaper than reading files to find something. Narrow with `include` (e.g. "**/*.js") and `path`.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regular expression' },
          path: { type: 'string', description: 'directory or file to search; defaults to the working directory' },
          include: { type: 'string', description: 'glob limiting which files are searched, e.g. "src/**/*.ts"' },
          ignore_case: { type: 'boolean' },
          files_only: { type: 'boolean', description: 'return just the matching file names' },
          context: { type: 'number', description: 'lines of surrounding context per match (0-5)' },
        },
        required: ['pattern'],
      },
    },
    async run(input, ctx) {
      const patternStr = String(input.pattern == null ? '' : input.pattern);
      if (!patternStr) return { output: 'grep needs a pattern', isError: true };
      let re;
      try {
        re = new RegExp(patternStr, input.ignore_case ? 'i' : '');
      } catch (e) {
        // An invalid regex is the model's typo, and telling it exactly what the
        // engine objected to is what lets it fix the call instead of retrying.
        return { output: `invalid regular expression: ${e.message}`, isError: true };
      }

      const root = resolveRoot(ctx.cwd, input.path);
      let rootStat;
      try { rootStat = fs.statSync(root); } catch { return { output: `no such path: ${input.path || '.'}`, isError: true }; }

      const includeRe = input.include ? globToRegExp(String(input.include)) : null;
      const ctxLines = Math.max(0, Math.min(5, Number(input.context) || 0));
      const filesOnly = Boolean(input.files_only);

      const files = rootStat.isDirectory()
        ? walk(root)
        : [{ abs: root, rel: path.basename(root) }];

      const out = [];
      const matchedFiles = [];
      let matches = 0;
      let truncated = false;
      let scanned = 0;
      let skipped = 0;

      for (const f of files) {
        if (!inScope(includeRe, f, ctx && ctx.cwd)) continue;
        let st;
        try { st = fs.statSync(f.abs); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) { skipped += 1; continue; }
        let buf;
        try { buf = fs.readFileSync(f.abs); } catch { skipped += 1; continue; }
        if (looksBinary(buf)) continue;
        scanned += 1;

        const lines = buf.toString('utf8').split('\n');
        let fileHit = false;
        for (let i = 0; i < lines.length; i++) {
          // `lastIndex` is irrelevant here because the regex is never global —
          // a /g regex is stateful across .test() calls and would skip matches.
          if (!re.test(lines[i])) continue;
          fileHit = true;
          if (filesOnly) break;
          if (matches >= MAX_MATCHES) { truncated = true; break; }
          matches += 1;
          const from = Math.max(0, i - ctxLines);
          const to = Math.min(lines.length - 1, i + ctxLines);
          for (let j = from; j <= to; j++) {
            const sep = j === i ? ':' : '-';
            out.push(`${f.rel}${sep}${j + 1}${sep}${lines[j].slice(0, MAX_LINE_CHARS)}`);
          }
          if (ctxLines) out.push('--');
        }
        if (fileHit) matchedFiles.push(f.rel);
        if (truncated) break;
      }

      if (filesOnly) {
        if (!matchedFiles.length) return zeroResult(`/${patternStr}/`, scanned, skipped, input.include);
        const shown = matchedFiles.slice(0, MAX_GLOB_RESULTS);
        return {
          output: shown.join('\n')
            + (matchedFiles.length > shown.length ? `\n[${matchedFiles.length - shown.length} more file(s) not shown]` : ''),
          meta: { files: matchedFiles.length, scanned },
        };
      }
      if (!out.length) {
        // A zero-result search is a RESULT, not an error — "it is not there" is often exactly what the model needed to learn.
        return zeroResult(`/${patternStr}/`, scanned, skipped, input.include);
      }
      const body = out.join('\n');
      return {
        output: truncated
          ? `${body}\n[truncated at ${MAX_MATCHES} matches — narrow the pattern, or pass include/path]`
          : body,
        meta: { matches, files: matchedFiles.length, scanned, truncated },
      };
    },
  },

  glob: {
    mutates: false,
    schema: {
      name: 'glob',
      description:
        'Find files by NAME pattern: "**/*.test.js", "src/**/auth*". Returns project-relative paths, '
        + 'most recently modified first — which is usually where the work is.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob, e.g. "src/**/*.js"' },
          path: { type: 'string', description: 'directory to search from; defaults to the working directory' },
        },
        required: ['pattern'],
      },
    },
    async run(input, ctx) {
      const pattern = String(input.pattern == null ? '' : input.pattern).trim();
      if (!pattern) return { output: 'glob needs a pattern', isError: true };
      const root = resolveRoot(ctx.cwd, input.path);
      try {
        if (!fs.statSync(root).isDirectory()) return { output: `${input.path} is not a directory`, isError: true };
      } catch { return { output: `no such directory: ${input.path || '.'}`, isError: true }; }

      // A bare `*.js` plainly means "anywhere", not "only at the top level" — matching literally there produces an empty answer for the most natural way to…
      const re = globToRegExp(pattern.includes('/') ? pattern : `**/${pattern}`);
      const hits = [];
      for (const f of walk(root)) {
        if (!re.test(f.rel)) continue;
        let mtime = 0;
        try { mtime = fs.statSync(f.abs).mtimeMs; } catch { /* vanished mid-walk */ }
        hits.push({ rel: f.rel, mtime });
      }
      if (!hits.length) return { output: `no file matches ${pattern}` };
      hits.sort((a, b) => b.mtime - a.mtime);
      const shown = hits.slice(0, MAX_GLOB_RESULTS);
      const body = shown.map((h) => h.rel).join('\n');
      return {
        output: hits.length > shown.length
          ? `${body}\n[${hits.length - shown.length} more not shown — narrow the pattern]`
          : body,
        meta: { count: hits.length },
      };
    },
  },
};

/** WHERE IS THIS DEFINED, AND WHO USES IT? */

/** Lines that DECLARE a name, across the languages a project is likely to use. */
function defineRe(name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    '(?:'
    // A GENERATOR IS A DECLARATION TOO, and this missed every one of them: the `*` in `async function* runTurn` sits between the keyword and the name, so…
    + `(?:function|class|struct|enum|interface|trait|type|def|fn|sub|proc)\\s*\\*?\\s+${n}\\b` // declared forms
    + `|(?:const|let|var|static|public|private|protected|export)\\s+(?:[\\w<>\\[\\]]+\\s+)?${n}\\s*[=:(]` // bound forms
    + `|^\\s*${n}\\s*[:=]\\s*(?:function|async|\\()`                                     // object member / arrow
    + `|^\\s*(?:async\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{`                                   // bare method
    + `|@\\w+[\\s\\S]{0,40}?\\bdef\\s+${n}\\b`                                           // decorated python
    + ')', 'm'
  );
}

const IMPORT_RE = /\b(?:import|require|from|include|use|using)\b/;

// ------------------------------------------------------- file dependents ----

/** WHO DEPENDS ON THIS FILE — the one structural question `symbols` cannot answer, because it is about a file rather than a name. */
const DYNAMIC_RE = /\brequire\s*\(\s*[^'")\s]|\bimport\s*\(\s*[^'")\s]|\bimportlib\b|__import__\s*\(|\beval\s*\(|new\s+Function\s*\(|\bregister(?:Plugin|Handler|Component|Provider|Command)\b/;
/** Every quoted specifier on a line that is doing importing. */
const SPEC_RE = /\b(?:from|require|import|include|use|using|src|href)\b[^'"`\n]{0,40}['"`]([^'"`\n]{1,200})['"`]/g;

/** THE SYMBOL SEAM — what is here, and what a parser would add. */

/** The forms a specifier can take for `rel` — extensionless, index, basename. */
function specForms(rel) {
  const forms = new Set([rel]);
  const noExt = rel.replace(/\.[^./]+$/, '');
  forms.add(noExt);
  if (/\/index$/.test(noExt)) forms.add(noExt.replace(/\/index$/, ''));
  forms.add(path.posix.basename(rel));
  forms.add(path.posix.basename(noExt));
  // Python dotted form: a/b/c.py → a.b.c
  if (/\.py$/.test(rel)) forms.add(noExt.replace(/\//g, '.'));
  return forms;
}

/** Does `spec`, written inside `fromRel`, name `targetRel`? */
function specHits(spec, fromRel, targetRel, forms) {
  const s = String(spec).replace(/\\/g, '/').replace(/^\.\//, '').replace(/[?#].*$/, '');
  if (!s) return false;
  // A relative specifier resolves against the referring file's own directory —
  // this is what stops `./utils` in two different folders being the same file.
  if (/^\.\.?\//.test(String(spec)) || String(spec).startsWith('./')) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), s));
    return resolved === targetRel
      || targetRel.startsWith(resolved + '.')
      || targetRel === resolved + '/index.js'
      || targetRel === resolved + '/index.ts';
  }
  if (forms.has(s)) return true;
  return targetRel.endsWith('/' + s);
}

tools.dependents = {
  mutates: false,
  schema: {
    name: 'dependents',
    description:
      'Find every file that imports, requires or links to a given FILE, with the line that does it. '
      + 'Answers "what would break if I change this" and "what is this file wired into" in one call. '
      + 'Use symbols for a name; use this for a path. Computed fresh from the files on disk — there is no index to go stale. '
      + 'LEXICAL, not a parser: it reads import and require specifiers as text, so it finds static imports '
      + 'reliably and CANNOT see a path built at runtime, a dynamic import from a variable, or a re-export chain. '
      + 'No result means no textual reference was found — not that nothing depends on it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'the file to look up, project-relative, e.g. "src/web/settings.js"' },
        include: { type: 'string', description: 'glob limiting which files are searched, e.g. "src/**/*.js"' },
      },
      required: ['path'],
    },
  },
  async run(input, ctx) {
    const rawPath = String(input.path == null ? '' : input.path).trim();
    if (!rawPath) return { output: 'dependents needs a path', isError: true };

    const root = path.resolve(ctx.cwd || process.cwd());
    const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
    const targetRel = path.relative(root, abs).replace(/\\/g, '/');
    if (targetRel.startsWith('..')) return { output: `${rawPath} is outside the working directory`, isError: true };
    if (!fs.existsSync(abs)) return { output: `no such file: ${rawPath}`, isError: true };

    const forms = specForms(targetRel);
    const includeRe = input.include ? globToRegExp(String(input.include)) : null;
    const hits = [];
    let scanned = 0;
    let dynamic = null;

    for (const f of walk(root)) {
      if (f.rel === targetRel) continue;
      if (!inScope(includeRe, f, ctx && ctx.cwd)) continue;
      let st;
      try { st = fs.statSync(f.abs); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) continue;
      let buf;
      try { buf = fs.readFileSync(f.abs); } catch { continue; }
      if (looksBinary(buf)) continue;
      scanned += 1;

      const src = buf.toString('utf8');
      if (!dynamic && DYNAMIC_RE.test(src)) dynamic = f.rel;

      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!IMPORT_RE.test(line) && !/\b(?:src|href)\s*=/.test(line)) continue;
        SPEC_RE.lastIndex = 0;
        let m;
        while ((m = SPEC_RE.exec(line))) {
          if (!specHits(m[1], f.rel, targetRel, forms)) continue;
          hits.push(`${f.rel}:${i + 1}:${line.trim().slice(0, MAX_LINE_CHARS)}`);
          break;
        }
        if (hits.length >= MAX_MATCHES) break;
      }
      if (hits.length >= MAX_MATCHES) break;
    }

    // ABSENCE IS NOT PROOF. Said out loud, every time, because "nothing imports
    // this" is the finding most likely to be acted on destructively.
    const caveat = dynamic
      ? `\n\nNote: this project loads code dynamically (see ${dynamic}), so a reference here can exist without being visible to a scan.`
      : '';
    if (!hits.length) {
      return {
        output: `No file in ${scanned} scanned imports or links to ${targetRel}. `
          + `That may mean it is an entry point (started from outside), or reached by name at runtime — it is not proof it is unused.${caveat}`,
        meta: { dependents: 0, scanned },
      };
    }
    const shown = hits.slice(0, 60);
    return {
      output: `${hits.length} file(s) depend on ${targetRel}\n`
        + shown.map((h) => '  ' + h).join('\n')
        + (hits.length > shown.length ? `\n  [${hits.length - shown.length} more]` : '')
        + caveat,
      meta: { dependents: hits.length, scanned },
    };
  },
};

tools.symbols = {
  mutates: false,
  schema: {
    name: 'symbols',
    description:
      'Find where a NAME is defined and where it is used, sorted into definitions, imports and uses. '
      + 'Use this instead of grep when the question is structural — "where does this live", "who calls this", '
      + '"what imports this". One call answers it; grep returns everything and leaves the sorting to you. '
      + 'LEXICAL, not a parser: it matches the name as text, so it cannot tell two different things with the '
      + 'same name apart, cannot follow a method through an alias, and counts a mention in a comment or a '
      + 'string as a use. Treat it as a very good index, and confirm anything you are about to change.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the identifier: a function, class, constant, component or route handler' },
        path: { type: 'string', description: 'directory to search from; defaults to the working directory' },
        include: { type: 'string', description: 'glob limiting which files are searched, e.g. "src/**/*.ts"' },
      },
      required: ['name'],
    },
  },
  async run(input, ctx) {
    const name = String(input.name == null ? '' : input.name).trim();
    if (!name) return { output: 'symbols needs a name', isError: true };
    if (!/^[\w$.-]+$/.test(name)) {
      return { output: `"${name}" is not an identifier — use grep for free text`, isError: true };
    }

    const root = resolveRoot(ctx.cwd, input.path);
    try {
      if (!fs.statSync(root).isDirectory()) return { output: `${input.path} is not a directory`, isError: true };
    } catch { return { output: `no such directory: ${input.path || '.'}`, isError: true }; }

    const includeRe = input.include ? globToRegExp(String(input.include)) : null;
    // Word-boundary match, so `run` does not match `runner`.
    const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const isDef = defineRe(name);

    const defs = [];
    const imports = [];
    const uses = [];
    let scanned = 0;
    let skipped = 0;

    for (const f of walk(root)) {
      if (!inScope(includeRe, f, ctx && ctx.cwd)) continue;
      let st;
      try { st = fs.statSync(f.abs); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) { skipped += 1; continue; }
      let buf;
      try { buf = fs.readFileSync(f.abs); } catch { skipped += 1; continue; }
      if (looksBinary(buf)) continue;
      scanned += 1;

      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!word.test(line)) continue;
        const row = `${f.rel}:${i + 1}:${line.trim().slice(0, MAX_LINE_CHARS)}`;
        if (isDef.test(line)) defs.push(row);
        else if (IMPORT_RE.test(line)) imports.push(row);
        else uses.push(row);
        if (defs.length + imports.length + uses.length >= MAX_MATCHES) break;
      }
      if (defs.length + imports.length + uses.length >= MAX_MATCHES) break;
    }

    if (!defs.length && !imports.length && !uses.length) {
      return zeroResult(`"${name}"`, scanned, skipped, input.include);
    }
    const section = (title, rows, cap) => (rows.length
      ? `${title} (${rows.length})\n` + rows.slice(0, cap).map((r) => '  ' + r).join('\n')
        + (rows.length > cap ? `\n  [${rows.length - cap} more]` : '')
      : null);
    // Definitions first and uncapped-ish: that is the answer to "where is it".
    const out = [
      section('DEFINED', defs, 20),
      section('IMPORTED', imports, 20),
      section('USED', uses, 40),
    ].filter(Boolean).join('\n\n');
    return {
      output: out,
      meta: { defs: defs.length, imports: imports.length, uses: uses.length, scanned },
    };
  },
};

/** NOTHING FOUND IS THREE DIFFERENT ANSWERS (2026-09-18). */
function zeroResult(what, scanned, skipped, include) {
  if (!scanned) {
    return {
      output: `NO FILES IN SCOPE: nothing was searched for ${what}${include ? ` — include ${include} matched no file` : ''}`
        + `${skipped ? ` (${skipped} file(s) skipped as too large or unreadable)` : ''}. `
        + 'This says NOTHING about whether it exists: widen include/path, or read the file directly.',
      meta: { searchState: 'NO_FILES_IN_SCOPE', scanned, skipped },
    };
  }
  const gap = skipped ? ` ${skipped} file(s) were NOT searched (too large or unreadable) — it may be in one of them; read them in ranges.` : '';
  return {
    output: `no match for ${what} in ${scanned} file(s) searched${include ? ` matching ${include}` : ''}.${gap}`,
    meta: { searchState: skipped ? 'PARTIAL_NO_MATCH' : 'SEARCHED_FILES_NO_MATCH', scanned, skipped },
  };
}

module.exports = { tools, globToRegExp, walk, looksBinary, defineRe, zeroResult, MAX_MATCHES, MAX_GLOB_RESULTS };
