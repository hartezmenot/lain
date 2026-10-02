'use strict';

/**
 * ALLOW / DENY RULES (Simplify S5). The person's rules live in their config (`permissions: {allow, deny,
 * defaultMode}`); a project's `.lain/settings.json` may only narrow them: its `deny` rules are added, a stricter
 * `defaultMode` is honoured, and its `allow` rules are ignored. A rule is `Tool` or `Tool(spec)`: for a shell the
 * spec is the command (`*` matches anything, `npm run:*` a prefix); for a file tool it is a path glob.
 */

const fs = require('fs');
const path = require('path');

const MODES = ['ASK', 'ACCEPT_EDITS', 'PLAN', 'AUTO'];
const STRICTNESS = { PLAN: 3, ASK: 2, ACCEPT_EDITS: 1, AUTO: 0 };
const ALIAS = {
  shell: ['shell', 'run_bash', 'run_powershell', 'run_cmd', 'bash'],
  edit: ['edit_file', 'write_file', 'apply_patch', 'move_file', 'rename_symbol'],
  write: ['write_file'],
  read: ['read_file', 'grep', 'glob', 'list_dir'],
  webfetch: ['web_fetch'],
  computer: ['computer'],
};

/** `acceptEdits`, `accept-edits`, `Accept edits` → ACCEPT_EDITS. */
function modeName(v) {
  const m = String(v || '').trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/^ACCEPTEDITS$/, 'ACCEPT_EDITS').replace(/^MANUAL$|^DEFAULT$/, 'ASK');
  return MODES.includes(m) ? m : null;
}

function readProject(root) {
  try {
    const f = require('./projectmeta').file(root, 'settings.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j && typeof j === 'object' && j.permissions && typeof j.permissions === 'object' ? { file: f, p: j.permissions } : null;
  } catch { return null; }
}

function list(v) { return Array.isArray(v) ? v.map(String).filter(Boolean) : []; }

/** The rules in force for a project: the person's allow/deny, plus the project's deny; the stricter default mode. */
function of(cfg, root) {
  const user = (cfg && cfg.permissions && typeof cfg.permissions === 'object') ? cfg.permissions : {};
  const proj = root ? readProject(root) : null;
  const userMode = modeName(user.defaultMode) || 'AUTO';
  const projMode = proj ? modeName(proj.p.defaultMode) : null;
  return {
    allow: list(user.allow),
    deny: [...list(user.deny), ...(proj ? list(proj.p.deny) : [])],
    defaultMode: projMode && STRICTNESS[projMode] > STRICTNESS[userMode] ? projMode : userMode,
    ignored: proj ? list(proj.p.allow) : [],
    projectFile: proj ? proj.file : null,
  };
}

function parse(rule) {
  const m = /^\s*([A-Za-z_][\w.-]*)\s*(?:\((.*)\))?\s*$/.exec(String(rule));
  return m ? { tool: m[1], spec: m[2] == null ? null : m[2].trim() } : null;
}

const KEY = { bash: 'shell', shell: 'shell', edit: 'edit', write: 'write', read: 'read', webfetch: 'webfetch', computer: 'computer' };

/** The tool names a rule's tool word covers: Claude Code's words (Bash, Edit, Read…) and LAIN's own. */
function names(tool) {
  const k = KEY[tool.toLowerCase()];
  return k ? ALIAS[k] : [tool];
}

function globRe(glob) {
  const s = String(glob).replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*' && s[i + 1] === '*') { re += '.*'; i += 1; if (s[i + 1] === '/') i += 1; } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

function commandMatches(spec, command) {
  const c = String(command || '').trim().replace(/\s+/g, ' ');
  if (spec.endsWith(':*')) { const p = spec.slice(0, -2).trim(); return c === p || c.startsWith(`${p} `); }
  const re = new RegExp(`^${spec.trim().replace(/\s+/g, ' ').split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(c);
}

/** Does one rule cover this call? */
function matches(rule, name, input, cwd) {
  const r = parse(rule);
  if (!r || !names(r.tool).includes(name)) return false;
  if (r.spec == null || r.spec === '' || r.spec === '*') return true;
  const i = input || {};
  if (ALIAS.shell.includes(name)) return commandMatches(r.spec, i.command || i.cmd || '');
  if (name === 'web_fetch') return commandMatches(r.spec.replace(/^domain:/, ''), (() => { try { return new URL(i.url).hostname; } catch { return ''; } })());
  const p = i.path || i.file || i.to || null;
  if (!p) return false;
  const abs = path.resolve(cwd || process.cwd(), String(p));
  const rel = path.relative(cwd || process.cwd(), abs).replace(/\\/g, '/');
  const re = globRe(r.spec);
  return re.test(rel) || re.test(abs.replace(/\\/g, '/'));
}

function first(rules, name, input, cwd) { return rules.find((r) => matches(r, name, input, cwd)) || null; }

module.exports = { MODES, STRICTNESS, modeName, of, parse, matches, first };
