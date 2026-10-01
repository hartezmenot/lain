'use strict';

/**
 * A TOOL NAME THAT IS NOT OURS, BUT WHOSE MEANING IS.
 *
 * Measured on the wire (Toralink diagnostic, 2026-09-24 — raw router bytes,
 * before any LAIN code touched them): gpt-oss:120b called `functions/grep` and
 * `functions/symbols` — its training format's namespace leaking into the name —
 * and, in an earlier run, `print_tree` twice (the `repo_browser` vocabulary it
 * was trained with). LAIN answered "unknown tool" each time and the model spent
 * steps rediscovering what it had meant.
 *
 * The MODEL generated these; nothing upstream corrupted them. But the meaning
 * of each is unambiguous, so LAIN recovers locally and says so, rather than
 * paying a round trip for an error:
 *
 *   A KNOWN FOREIGN NAMESPACE on a name we DO have   → that tool, noted
 *   print_tree                                       → a bounded recursive list_dir
 *   open_file                                        → read_file (line range kept)
 *   search {query}                                   → grep for the query, ESCAPED
 *                                                      (literal text, never a pattern)
 *
 * NOTHING ELSE. No fuzzy matching, no "closest name" — a guess at meaning is
 * not recovery. Anything else stays an unknown tool.
 */

const NAMESPACE = /^(?:functions|repo_browser|default_api|tools?)[./:]+/i;

const ALIASES = {
  print_tree: (input) => ({
    name: 'list_dir',
    input: { path: String(input.path || input.dir || input.directory || '.'), depth: Math.max(1, Math.min(3, Number(input.depth) || 2)) },
    what: 'a recursive listing (list_dir, depth ≤ 3)',
  }),
  // `search {query}` takes LITERAL text; grep takes a regular expression. The
  // conversion is typed, one way: the literal is ESCAPED into a pattern, so
  // "search(" finds "search(" — the two representations never leak.
  search: (input) => ({
    name: 'grep',
    input: { pattern: String(input.query || input.text || input.pattern || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ...(input.path ? { path: String(input.path) } : {}) },
    what: 'grep for the literal text',
  }),
  open_file: (input) => {
    const start = Number(input.line_start || input.start_line || input.offset) || 0;
    const end = Number(input.line_end || input.end_line) || 0;
    const range = start > 0 ? { offset: start, ...(end >= start ? { limit: end - start + 1 } : {}) } : {};
    return { name: 'read_file', input: { path: String(input.path || input.file || ''), ...range }, what: 'read_file' };
  },
};

/**
 * @param {string}   name   the name the model called
 * @param {object}   input  its arguments
 * @param {function} has    (name) => whether that tool is registered
 * @returns {{name, input, from, note}|null}
 */
function resolve(name, input, has) {
  const raw = String(name || '');
  const bare = raw.replace(NAMESPACE, '');
  if (bare !== raw && bare && has(bare)) {
    return { name: bare, input: input || {}, from: raw, note: `NOTE: "${raw}" is not a tool name here — ran "${bare}". Call it as "${bare}".` };
  }
  const alias = ALIASES[bare];
  if (!alias) return null;
  const t = alias(input || {});
  if (!has(t.name)) return null;
  return { name: t.name, input: t.input, from: raw, note: `NOTE: "${raw}" is not a Noema tool — ran ${t.what} instead. Call ${t.name} directly.` };
}

module.exports = { resolve, NAMESPACE, ALIASES };
