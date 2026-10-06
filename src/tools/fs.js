'use strict';

/** Filesystem tools. */

const fs = require('fs');
const path = require('path');

const MAX_READ_BYTES = 400_000;

/** One resolver for every file tool — including the `/tmp/…` a Windows shell wrote (pathmap.js). */
function resolve(cwd, p) { return require('./pathmap').resolve(cwd, p); }

function rel(cwd, abs) {
  try {
    const r = path.relative(cwd, abs);
    return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : abs;
  } catch { return abs; }
}

/**
 * A PATH THAT IS NOT THERE — say what IS there, from the nearest folder that
 * exists, instead of inviting the next speculative, deeper guess.
 *
 * A missing path invalidates that candidate; the recovery is the nearest
 * KNOWN-existing ancestor (the file's folder, else its parent, else the root)
 * and its real entries — filesystem truth, not a suggestion engine.
 *
 * PATHS ARE LITERAL, NOT PATTERNS. A path that carries a regular-expression
 * escape (`SearchView\.tsx`) is a search pattern leaking into a filesystem
 * argument; on Windows the backslash is also a separator, so it silently names
 * a different path. It is REPORTED — with the literal file, only when that
 * file actually exists — and never rewritten: stripping backslashes blindly
 * would break a genuine `src\.eslintrc`.
 */
const REGEX_ESCAPE = /\\([.()[\]{}*+?^$|])/g;
function missing(cwd, p, kind) {
  const shown = String(p || '');
  const lines = [`no such ${kind}: ${shown}`];
  const exists = (q) => { try { fs.statSync(resolve(cwd, q)); return true; } catch { return false; } };
  const literal = shown.replace(REGEX_ESCAPE, '$1');
  if (literal !== shown && exists(literal)) {
    lines.push(`The path contains a regular-expression escape; tool paths are literal, not patterns. The literal path "${literal}" exists.`);
  }
  let dir = path.dirname(resolve(cwd, shown) || cwd);
  for (;;) {
    try { if (fs.statSync(dir).isDirectory()) break; } catch { /* keep climbing */ }
    const up = path.dirname(dir);
    if (up === dir) { dir = null; break; }
    dir = up;
  }
  if (dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* unreadable */ }
    const base = path.basename(literal).toLowerCase();
    const same = entries.find((e) => e.name.toLowerCase() === base && e.name !== path.basename(literal));
    const where = rel(cwd, dir) || '.';
    const list = entries.slice(0, 40).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    lines.push(`Nearest existing folder: ${where === cwd ? where : `${where}${where.endsWith('/') ? '' : '/'}`} — contains: ${list.join(', ') || '[empty]'}${entries.length > 40 ? `, … (${entries.length} entries)` : ''}`);
    if (same) lines.push(`A differently-cased entry exists there: ${same.name}`);
  }
  return lines.join('\n');
}

/** A bounded recursive listing — the print_tree recovery (toolalias.js). */
const TREE_SKIP = new Set(['node_modules', '.git', '.lain', '.noema', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target']);
function tree(root, depth, max = 300) {
  const out = [];
  (function walk(d, level, prefix) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      const isDir = e.isDirectory();
      out.push(`${prefix}${e.name}${isDir ? '/' : ''}`);
      if (isDir && level < depth && !TREE_SKIP.has(e.name)) walk(path.join(d, e.name), level + 1, `${prefix}${e.name}/`);
    }
  })(root, 1, '');
  if (out.length >= max) out.push(`… (stopped at ${max} entries)`);
  return out.join('\n');
}

/** BELOW THIS, A FILE IS SMALL ENOUGH THAT REWRITING IT WHOLE IS ORDINARY. */
const TRUNCATION_FLOOR_BYTES = 2_000;

/** A write keeping less than this share of the file is a collapse, not an edit. */
const TRUNCATION_RATIO = 0.5;

/** Would this write destroy most of an existing file? */
function truncationRisk(abs, content) {
  let was;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    was = st.size;
  } catch { return null; }              // a new file loses nothing
  if (was === 0) return null;
  const now = Buffer.byteLength(content, 'utf8');
  if (now === 0) return { was, now };
  if (was < TRUNCATION_FLOOR_BYTES) return null;
  if (now >= was * TRUNCATION_RATIO) return null;
  return { was, now };
}

const tools = {
  read_file: {
    mutates: false,
    schema: {
      name: 'read_file',
      description: 'Read a text file. Use offset/limit for a line range instead of re-reading a large file whole. '
        + 'NOT the way to FIND something: to locate a definition or its callers use symbols, to search contents use grep, '
        + 'to find files by name use glob, to ask what would break if a file changed use dependents, and to see what a '
        + 'file CONTAINS use check_symbols with list_symbols — its outline, in any language, a fraction of the cost of reading it whole. '
        + 'Each answers in one result what reading the candidate files whole costs tens of thousands of tokens to answer. '
        + 'Read a file once you know it is the one you need, and do not re-read a file that has not changed since you read it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'number', description: '1-based first line' },
          limit: { type: 'number', description: 'number of lines' },
        },
        required: ['path'],
      },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path);
      if (!abs) return { output: 'read_file needs a path', isError: true };
      let st;
      try { st = fs.statSync(abs); } catch { return { output: missing(ctx.cwd, input.path, 'file'), isError: true }; }
      if (st.isDirectory()) return { output: `${input.path} is a directory — use list_dir`, isError: true };
      if (st.size > MAX_READ_BYTES && !input.limit) {
        return { output: `${input.path} is ${st.size} bytes. Read a range with offset/limit.`, isError: true };
      }
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return { output: `could not read ${input.path}: ${e.message}`, isError: true }; }
      const lines = text.split('\n');
      const start = Math.max(1, Number(input.offset) || 1);
      const count = Number(input.limit) || lines.length;
      const slice = lines.slice(start - 1, start - 1 + count);
      const numbered = slice.map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join('\n');
      return {
        output: numbered || '[empty file]',
        meta: { path: rel(ctx.cwd, abs), size: st.size, mtimeMs: Math.floor(st.mtimeMs), lines: lines.length },
      };
    },
  },

  write_file: {
    mutates: true,
    schema: {
      name: 'write_file',
      description:
        'Write a file, creating parent directories. Overwrites if it exists. '
        + 'To change PART of an existing file use apply_patch or edit_file instead - they verify '
        + 'the exact text they replace, so they cannot lose an edit they did not see. '
        + 'An existing file this session has never read is refused until it is read - '
        + 'read_file it first. '
        + 'A write that would replace a substantial file with a fraction of itself is refused '
        + 'unless truncate is set.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          truncate: { type: 'boolean', description: 'acknowledge deliberately replacing a file with much less content' },
        },
        required: ['path', 'content'],
      },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path);
      if (!abs) return { output: 'write_file needs a path', isError: true };
      if (input.content == null) return { output: 'write_file needs content', isError: true };
      // THE ONE MUTATOR THAT CAN DESTROY SOMEBODY ELSE'S WORK
      const { staleness, ledgerOf } = require('../evidence');
      const conflict = staleness(ledgerOf(ctx), ctx.cwd, abs);
      if (conflict.stale) {
        return {
          isError: true,
          output: [
            `WRITE CONFLICT - ${rel(ctx.cwd, abs)}`,
            'REASON: this file changed after you read it, and write_file would replace the whole',
            'file with what you composed from the old bytes - silently discarding that change.',
            `It was ${conflict.was.size} bytes when read; it is ${conflict.now.size} now.`,
            'Re-read it, then either write it again or make the change with apply_patch, which',
            'verifies the exact text it is replacing and therefore cannot lose an edit it did',
            'not see. NOTHING WAS WRITTEN.',
          ].join(String.fromCharCode(10)),
        };
      }
      // THE THIRD QUESTION: WAS THERE ANYTHING TO GO STALE?
      const { noInspection, sessionIdOf } = require('../evidence');   // `ledgerOf` is already in scope above
      // AN ANCHORED WRITE IS ITS OWN INSPECTION — `_anchorSha1` is the hash of the exact bytes being replaced, checked here
      let anchored = false;
      if (typeof input._anchorSha1 === 'string' && input._anchorSha1) {
        try { anchored = require('crypto').createHash('sha1').update(fs.readFileSync(abs)).digest('hex') === input._anchorSha1; } catch { anchored = false; }
      }
      const blind = anchored ? null : noInspection(ledgerOf(ctx), ctx.cwd, abs, sessionIdOf(ctx));
      if (blind) {
        return {
          isError: true,
          output: [
            `WRITE REFUSED - ${rel(ctx.cwd, abs)}`,
            'REASON: NO_INSPECTION_PROVENANCE - this file exists, and this session has never',
            'read it. Writing it now would replace every byte of it with ones composed from',
            'no inspection of what is there.',
            'read_file it first, then write it again. NOTHING WAS WRITTEN.',
          ].join(String.fromCharCode(10)),
        };
      }
      // AND THE OTHER WAY TO LOSE A FILE: WRITING LESS THAN IS THERE
      const shrink = truncationRisk(abs, String(input.content));
      if (shrink && !input.truncate) {
        return {
          isError: true,
          output: [
            `TRUNCATION REFUSED - ${rel(ctx.cwd, abs)}`,
            `It is ${shrink.was} bytes; this write is ${shrink.now}${shrink.now === 0 ? ' (empty)' : ''}.`,
            'A whole-file write that keeps a fraction of the file is usually a small edit',
            'attempted the expensive way, or a reconstruction that was not complete.',
            '',
            'To change part of it:  apply_patch, or edit_file - both verify the exact text',
            'they replace, so they cannot destroy what they did not see.',
            'If you really do mean to replace it:  write_file with truncate: true.',
            'NOTHING WAS WRITTEN.',
          ].join(String.fromCharCode(10)),
        };
      }
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(input.content), 'utf8');
      } catch (e) { return { output: `could not write ${input.path}: ${e.message}`, isError: true }; }
      const bytes = Buffer.byteLength(String(input.content), 'utf8');
      return { output: `wrote ${rel(ctx.cwd, abs)} (${bytes} bytes)`, mutated: [abs] };
    },
  },

  edit_file: {
    mutates: true,
    schema: {
      name: 'edit_file',
      description: 'Replace an exact string in a file. `old` must appear exactly once unless replace_all is set; otherwise the edit is '
        + 'refused and nothing is written. Use it for a short, unique string or for replacing every occurrence (replace_all); for a '
        + 'multi-line block, apply_patch reports more precisely what it did not find. Returns the result of the write, not the file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'the file, relative to the working directory' },
          old: { type: 'string', description: 'the exact current text, whitespace included' },
          new: { type: 'string', description: 'the text that replaces it' },
          replace_all: { type: 'boolean', description: 'replace every occurrence of `old` instead of requiring exactly one' },
        },
        required: ['path', 'old', 'new'],
      },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path);
      if (!abs) return { output: 'edit_file needs a path', isError: true };
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { return { output: require('./pathmap').missing(input.path), isError: true }; }
      if (!String(input.old)) return { output: 'edit_file needs a non-empty `old`', isError: true };
      // read_file's line-number gutter copied into `old` (see gutter.js).
      const g = require('./gutter').resolve(text, String(input.old), String(input.new));
      let oldStr = g.old;
      let newStr = g.replacement;
      let count = text.split(oldStr).length - 1;
      // A CRLF FILE (a Windows checkout, core.autocrlf) and LF text from the model: matched in the file's own line
      // ending, and the replacement written in it too — never a file of mixed endings, never a false "not found".
      if (count === 0 && /\r\n/.test(text) && /\n/.test(oldStr) && !/\r\n/.test(oldStr)) {
        const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
        const n = text.split(crlf(oldStr)).length - 1;
        if (n > 0) { oldStr = crlf(oldStr); newStr = crlf(newStr); count = n; }
      }
      if (count === 0) return { output: `\`old\` not found in ${input.path}`, isError: true };
      if (count > 1 && !input.replace_all) {
        return { output: `\`old\` appears ${count} times in ${input.path} — pass replace_all or use a longer unique string`, isError: true };
      }
      // A FUNCTION REPLACER: a string one reads `$&`, `$'` and `$1` in the new
      // text as patterns, so code containing them was written back altered.
      const next = input.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
      try { fs.writeFileSync(abs, next, 'utf8'); } catch (e) { return { output: `could not write ${input.path}: ${e.message}`, isError: true }; }
      return { output: `edited ${rel(ctx.cwd, abs)} (${count} replacement${count === 1 ? '' : 's'})${g.stripped ? ` ${require('./gutter').NOTE}` : ''}`, mutated: [abs] };
    },
  },

  list_dir: {
    mutates: false,
    schema: {
      name: 'list_dir',
      // WHEN, not merely what.
      description: 'List the entries of ONE directory. Use it to see what is immediately '
        + 'inside a folder. To find files by name across the tree use glob; to find where '
        + 'a name is defined and who uses it, symbols; for what imports a file, dependents '
        + '— each answers in a single call without reading any file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    async run(input, ctx) {
      const shown = input.path || '.';
      const abs = resolve(ctx.cwd, shown);
      let st = null;
      try { st = fs.statSync(abs); } catch { /* reported below */ }
      // A FILE IS NOT A FOLDER, and saying which it is ends the guess.
      if (st && !st.isDirectory()) {
        return { output: `${shown} is a FILE (${st.size.toLocaleString('en-US')} bytes), not a directory — read it with read_file. In a listing, folders end with "/".`, isError: true };
      }
      if (!st) return { output: missing(ctx.cwd, shown, 'directory'), isError: true };
      const depth = Math.max(1, Math.min(3, Number(input.depth) || 1));
      if (depth > 1) return { output: tree(abs, depth) || '[empty directory]' };
      let entries;
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return { output: `could not list ${shown}: ${e.message}`, isError: true }; }
      const rows = entries.slice(0, 500).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return { output: rows.join('\n') || '[empty directory]' };
    },
  },
};

module.exports = { tools, resolve, rel, truncationRisk, TRUNCATION_FLOOR_BYTES, TRUNCATION_RATIO };
