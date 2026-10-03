'use strict';

/**
 * AGENT TYPES (Simplify S6): markdown files with frontmatter — `name`, `description`, `tools`, `model`, `effort` — in
 * `~/.lain/agents/` and the project's `.lain/agents/` (the project's win on a name clash). The body is the agent's own
 * instructions. Built-ins: `explore` (read-only, made for searching) and `general` (the core tools minus Agent).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const READ_ONLY = ['read_file', 'grep', 'glob', 'list_dir', 'web_fetch', 'Skill', 'tool_search', 'call_tool', 'job_status', 'todo_write'];

const BUILT_IN = Object.freeze({
  explore: { name: 'explore', description: 'reads and searches the project and answers; never edits or runs commands', tools: READ_ONLY, readOnly: true, effort: 'low', body: 'You are an explore agent: find what was asked, quickly. Read and search; never edit files or run commands. Your final message is the answer — the files, lines and facts found.' },
  general: { name: 'general', description: 'can read, edit and run commands', tools: null, readOnly: false, body: '' },
});

/** `key: value` frontmatter between `---` lines; lists as `[a, b]` or `a, b`. */
function parse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '');
  }
  const list = (v) => (v ? String(v).replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : null);
  const name = String(meta.name || '').trim().toLowerCase();
  if (!/^[a-z][\w-]{0,40}$/.test(name)) return null;
  return { name, description: String(meta.description || '').slice(0, 300), tools: list(meta.tools), model: meta.model || null, effort: meta.effort || null, body: m[2].trim().slice(0, 8000) };
}

function dirs(cwd) {
  const home = process.env.LAIN_AGENTS_HOME || os.homedir();
  return [path.join(home, '.lain', 'agents'), require('./projectmeta').file(cwd || process.cwd(), 'agents')];
}

/** Every type available in this project: built-ins, then the person's, then the project's. */
function all(cwd) {
  const out = { ...BUILT_IN };
  for (const d of dirs(cwd)) {
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      let t = null;
      try { t = parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { t = null; }
      if (t) out[t.name] = { ...t, readOnly: Array.isArray(t.tools) && t.tools.every((n) => READ_ONLY.includes(n)), file: path.join(d, f) };
    }
  }
  return out;
}

function get(cwd, name) { return all(cwd)[String(name || 'general').toLowerCase()] || null; }

/** May an agent of this type see this tool? Never Agent or computer; a read-only type only reads; a tools list limits. */
function allows(spec, name) {
  if (name === 'Agent' || name === 'computer' || /^computer_/.test(name)) return false;
  if (!spec) return true;
  if (Array.isArray(spec.tools)) return spec.tools.includes(name);
  return !spec.readOnly || READ_ONLY.includes(name);
}

module.exports = { all, get, allows, parse, BUILT_IN, READ_ONLY };
