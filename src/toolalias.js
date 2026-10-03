'use strict';

/** A TOOL NAME THAT IS NOT OURS, BUT WHOSE MEANING IS. */

const NAMESPACE = /^(?:functions|repo_browser|default_api|tools?)[./:]+/i;

const ALIASES = {
  print_tree: (input) => ({
    name: 'list_dir',
    input: { path: String(input.path || input.dir || input.directory || '.'), depth: Math.max(1, Math.min(3, Number(input.depth) || 2)) },
    what: 'a recursive listing (list_dir, depth ≤ 3)',
  }),
  // `search {query}` takes LITERAL text; grep takes a regular expression.
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
  return { name: t.name, input: t.input, from: raw, note: `NOTE: "${raw}" is not a LAIN tool — ran ${t.what} instead. Call ${t.name} directly.` };
}

module.exports = { resolve, NAMESPACE, ALIASES };
