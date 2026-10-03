'use strict';

/** TOOL SEMANTICS AND DIALECTS (Execution Discipline §34–§35) — the same operations in the vocabulary each model family uses natively, so no model is… */

const OPS = Object.freeze({
  'read-resource': ['read_file', 'list_dir', 'file_info', 'read_symbol'],
  'search-project': ['grep', 'glob', 'symbols', 'locate', 'dependents', 'understand'],
  'modify-resource': ['write_file', 'edit_file', 'apply_patch', 'append_file', 'insert_at', 'delete_range', 'move_file', 'delete_file', 'replace_symbol', 'insert_near_symbol', 'remove_symbol', 'rename_symbol'],
  'execute-command': ['run_bash', 'run_powershell', 'run_cmd', 'run_tests', 'run_background', 'python_run', 'process_run'],
  'inspect-history': ['review_changes', 'recall_evidence'],
  'inspect-runtime': ['job_status', 'observe', 'service_check', 'observe_start', 'observe_stop'],
  'inspect-preview': ['preview', 'preview_read', 'preview_pointer_move', 'preview_click', 'preview_double_click', 'preview_pointer_down', 'preview_pointer_up', 'preview_drag', 'preview_scroll', 'preview_key', 'preview_key_chord', 'preview_type_text'],
});

function opOf(name) { for (const [op, list] of Object.entries(OPS)) if (list.includes(name)) return op; return null; }

const S = (props, required) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

/** family → { alias: { canonical, schema, description, input: (aliasInput) => canonicalInput } } */
const DIALECTS = {
  claude: {
    Read: { canonical: 'read_file', description: 'Read a file (optionally a line range).', schema: S({ file_path: str('path'), offset: num('first line'), limit: num('lines') }, ['file_path']), input: (i) => ({ path: i.file_path || i.path, offset: i.offset, limit: i.limit }) },
    Edit: { canonical: 'edit_file', description: 'Replace exact text in a file.', schema: S({ file_path: str('path'), old_string: str('exact text to replace'), new_string: str('replacement'), replace_all: { type: 'boolean' } }, ['file_path', 'old_string', 'new_string']), input: (i) => ({ path: i.file_path || i.path, old: i.old_string, new: i.new_string, replace_all: Boolean(i.replace_all) }) },
    Write: { canonical: 'write_file', description: 'Write a whole file.', schema: S({ file_path: str('path'), content: str('file content') }, ['file_path', 'content']), input: (i) => ({ path: i.file_path || i.path, content: i.content }) },
    Grep: { canonical: 'grep', description: 'Search file contents with a regular expression.', schema: S({ pattern: str('regex'), path: str('where'), glob: str('file filter') }, ['pattern']), input: (i) => ({ pattern: i.pattern, path: i.path, include: i.glob }) },
    Glob: { canonical: 'glob', description: 'Find files by name pattern.', schema: S({ pattern: str('glob'), path: str('where') }, ['pattern']), input: (i) => ({ pattern: i.pattern, path: i.path }) },
    Bash: { canonical: 'run_bash', description: 'Run a shell command in the project.', schema: S({ command: str('command'), description: str('a few words for the person on what this does'), timeout: num('ms'), run_in_background: { type: 'boolean' } }, ['command']), input: (i) => ({ command: i.command, description: i.description, timeout_ms: i.timeout, background: i.run_in_background }) },
  },
  codex: {
    shell: { canonical: 'run_bash', description: 'Run a command. `command` is a string or an argv array.', schema: S({ command: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, description: str('a few words for the person on what this does'), workdir: str('directory'), timeout_ms: num('ms') }, ['command']), input: (i) => ({ command: Array.isArray(i.command) ? argvToCommand(i.command) : i.command, cwd: i.workdir, timeout_ms: i.timeout_ms, description: i.description }) },
    rg: { canonical: 'grep', description: 'ripgrep: search file contents.', schema: S({ pattern: str('regex'), path: str('where'), glob: str('file filter') }, ['pattern']), input: (i) => ({ pattern: i.pattern, path: i.path, include: i.glob }) },
    apply_patch: { canonical: 'apply_patch', multi: true, description: 'Apply a patch in the *** Begin Patch … *** End Patch format (Add File / Update File / Delete File).', schema: S({ input: str('the patch') }, ['input']), input: (i) => patchToCalls(String(i.input || i.patch || '')) },
  },
  glm: {
    bash: { canonical: 'run_bash', description: 'Run a bash/shell command in the project.', schema: S({ command: str('command'), description: str('a few words for the person on what this does'), cwd: str('directory'), background: { type: 'boolean' } }, ['command']), input: (i) => ({ command: i.command, description: i.description, cwd: i.cwd, background: i.background }) },
    read: { canonical: 'read_file', description: 'Read a file.', schema: S({ path: str('path'), offset: num('first line'), limit: num('lines') }, ['path']), input: (i) => ({ path: i.path, offset: i.offset, limit: i.limit }) },
    search: { canonical: 'grep', description: 'Search the project for a pattern.', schema: S({ pattern: str('regex'), path: str('where') }, ['pattern']), input: (i) => ({ pattern: i.pattern, path: i.path }) },
    str_replace: { canonical: 'edit_file', description: 'Replace an exact string in a file.', schema: S({ path: str('path'), old_str: str('exact text'), new_str: str('replacement') }, ['path', 'old_str', 'new_str']), input: (i) => ({ path: i.path, old: i.old_str, new: i.new_str }) },
  },
  local: {},   // canonical names; render() makes every schema strict
};

function argvToCommand(argv) {
  const a = argv.map(String);
  // ["bash","-lc","cmd"] / ["powershell","-Command","cmd"] → the command itself
  if (a.length === 3 && /^(?:bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?$/i.test(a[0]) && /^(?:-l?c|-Command|\/c)$/i.test(a[1])) return a[2];
  return a.map((x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)).join(' ');
}

/** The Codex patch envelope → canonical calls (one per file operation). */
function patchToCalls(patch) {
  const calls = [];
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(l))) {
      const body = []; i += 1;
      while (i < lines.length && !/^\*\*\* /.test(lines[i])) { body.push(lines[i].replace(/^\+/, '')); i += 1; }
      calls.push({ name: 'write_file', input: { path: m[1].trim(), content: body.join('\n') } });
      continue;
    }
    if ((m = /^\*\*\* Delete File: (.+)$/.exec(l))) { calls.push({ name: 'delete_file', input: { path: m[1].trim() } }); i += 1; continue; }
    if ((m = /^\*\*\* Update File: (.+)$/.exec(l))) {
      const file = m[1].trim(); i += 1;
      let expect = []; let replace = [];
      const flush = () => { if (expect.length || replace.length) calls.push({ name: 'apply_patch', input: { path: file, expect: expect.join('\n'), replace: replace.join('\n') } }); expect = []; replace = []; };
      while (i < lines.length && !/^\*\*\* (?:Add|Delete|Update) File|^\*\*\* End Patch/.test(lines[i])) {
        const x = lines[i];
        if (/^@@/.test(x)) flush();
        else if (x.startsWith('-')) expect.push(x.slice(1));
        else if (x.startsWith('+')) replace.push(x.slice(1));
        else if (!/^\*\*\* End of File/.test(x)) { const c = x.startsWith(' ') ? x.slice(1) : x; expect.push(c); replace.push(c); }
        i += 1;
      }
      flush();
      continue;
    }
    i += 1;
  }
  return calls;
}

/** Which dialect a model speaks: config override, then its family. Mock/test models stay canonical. */
function familyOf(model, cfg = {}) {
  if (cfg && cfg.toolDialect && DIALECTS[cfg.toolDialect]) return cfg.toolDialect;
  const m = String(model || '').toLowerCase();
  if (!m || /mock/.test(m)) return 'canonical';
  if (/claude|anthropic|opus|sonnet|haiku|fable/.test(m)) return 'claude';
  if (/gpt|codex|\bo[1-9]\b|openai/.test(m)) return 'codex';
  if (/glm|zhipu|z-ai|zai/.test(m)) return 'glm';
  if (/qwen|llama|mistral|gemma|phi|ollama|local|deepseek-coder/.test(m)) return 'local';
  return 'canonical';
}

/** Render canonical schemas in a family's dialect. Canonical tools without an alias keep their names. */
function render(schemas, family) {
  const d = DIALECTS[family];
  if (!d) return schemas;
  if (family === 'local') return schemas.map((s) => ({ ...s, parameters: { ...(s.parameters || {}), additionalProperties: false } }));
  const present = new Set(schemas.map((s) => s.name));
  // THE ONE `shell` TOOL (simple mode) stands in for run_bash: a family's shell alias replaces it.
  const canon = (c) => (c === 'run_bash' && !present.has(c) && present.has('shell') ? 'shell' : c);
  const aliases = Object.entries(d).filter(([, x]) => present.has(canon(x.canonical)));
  const replaced = new Set(aliases.map(([, x]) => canon(x.canonical)));
  const added = aliases.map(([alias, x]) => ({ name: alias, description: `${x.description} [${opOf(x.canonical) || 'tool'}]`, parameters: x.schema }));
  return [...schemas.filter((s) => !replaced.has(s.name)), ...added];
}

/**
 * RESOLVE a dialect call to canonical call(s). @returns null when `name` is not a dialect alias of `family`.
 * @returns {{ calls: [{name, input}], from: string }}
 */
function resolve(name, input, family) {
  const d = DIALECTS[family];
  const x = d && d[name];
  if (!x) return null;
  const mapped = x.input(input || {});
  const calls = x.multi ? mapped : [{ name: x.canonical, input: dropUndefined(mapped) }];
  return { calls, from: name };
}

/** The schemas a turn offers: rendered in the model's dialect, which the session remembers so execute() can resolve it. */
function forTurn(session, schemas, model, cfg) {
  const family = familyOf(model, cfg);
  if (session) session._toolDialect = family === 'canonical' ? null : family;
  return family === 'canonical' ? schemas : render(schemas, family);
}

function dropUndefined(o) { const r = {}; for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') r[k] = v; return r; }

module.exports = { OPS, DIALECTS, opOf, familyOf, render, resolve, forTurn, patchToCalls, argvToCommand };
