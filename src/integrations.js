'use strict';

/**
 * MCP & SKILLS (Phase 8.1) — how LAIN is extended to other applications
 * (Godot, Unreal, Blender, OBS, a database, a company tool) without that
 * application's knowledge being hard-coded into Core.
 *
 * ------------------------------------------------------------------------
 * MCP SERVERS  cfg.integrations.mcp[id] = { name, transport: 'stdio' | 'http',
 *              command: [...], cwd, url, env: {K: value | {ref}}, headers: {K: value | {ref}},
 *              enabled, addedAt, source }
 *   A secret (an API token in an env var or header) is stored in the Windows
 *   secret store (credentials.js) and only its reference is kept; it is
 *   resolved when the server starts or a request is sent, never shown, never
 *   put in model context.
 *   Connected servers' tools are offered to the model as
 *   `mcp__<server>__<tool>`; a tool the server does not mark read-only asks the
 *   person before it runs (gate.js EXTERNAL effect).
 *
 * SKILLS       cfg.integrations.skills[id] = { name, description, path, source: 'folder' | 'git',
 *              repo, enabled, validated }
 *   A skill is a folder with SKILL.md (front matter: name, description). It is
 *   VALIDATED before it can be enabled; scripts inside it are listed and never
 *   run by LAIN on its own. An enabled skill is announced to the model by name,
 *   description and path — the model reads SKILL.md when the task needs it.
 *
 * NOTHING INSTALLS ITSELF. "Available" and a project's recommendations are
 * suggestions with the exact command shown; adding one is the person's action.
 *
 * The older desktop-bridge seam (cfg.mcp, mcp.js) and Computer MCP are
 * unchanged; they appear in the list as built-ins.
 */

const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/;

function root(app) { return (app && app._sibling) || app; }
function cfgOf(app) { const r = root(app); return (r && r.cfg) || {}; }
function store(app) {
  const c = cfgOf(app);
  if (!c.integrations || typeof c.integrations !== 'object') c.integrations = {};
  if (!c.integrations.mcp || typeof c.integrations.mcp !== 'object') c.integrations.mcp = {};
  if (!c.integrations.skills || typeof c.integrations.skills !== 'object') c.integrations.skills = {};
  return c.integrations;
}
function save(app) { try { require('./config').save(cfgOf(app)); } catch { /* in memory */ } }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item'; }
function uniqueId(map, base) { let id = slug(base); let n = 2; while (map[id]) id = `${slug(base)}-${n++}`; return id; }

// ---- live connections (one per process root) ------------------------------------
const live = new Map();   // id -> McpClient
let exitHook = false;
function ensureExitHook() {
  if (exitHook) return;
  exitHook = true;
  process.once('exit', () => { for (const c of live.values()) { try { c.close(); } catch { /* going */ } } });
}

// ---- secrets in env / headers ----------------------------------------------------
function keepSecrets(id, kind, obj = {}, secretKeys = []) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,80}$/.test(k)) throw new Error(`"${k}" is not a valid ${kind} name`);
    if (secretKeys.includes(k) && v && typeof v === 'string') {
      const creds = require('./credentials');
      const ref = creds.ref(`mcp-${id}-${kind}-${k}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-'), 'token');
      const r = creds.store(ref, v, { kind: 'token' });
      if (!r.ok) throw new Error(r.why || 'the secret store refused');
      out[k] = { ref };
    } else out[k] = v && typeof v === 'object' && v.ref ? { ref: String(v.ref) } : String(v == null ? '' : v);
  }
  return out;
}
function describeValues(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = v && typeof v === 'object' && v.ref ? { secret: true, masked: (require('./credentials').describe(v.ref) || {}).masked || '••••' } : { secret: false, value: String(v) };
  return out;
}

// ---- MCP servers -------------------------------------------------------------------
function addMcp(app, body = {}) {
  const s = store(app);
  const transport = body.transport === 'http' ? 'http' : 'stdio';
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return { ok: false, why: 'name the server' };
  const id = body.id && ID_RE.test(body.id) && !s.mcp[body.id] ? body.id : uniqueId(s.mcp, name);
  const entry = { name, transport, enabled: true, addedAt: new Date().toISOString(), source: body.source || 'custom' };
  if (transport === 'stdio') {
    const cmd = Array.isArray(body.command) ? body.command.map(String).filter(Boolean) : String(body.command || '').trim().split(/\s+/).filter(Boolean);
    if (!cmd.length) return { ok: false, why: 'give the command that starts the server (e.g. npx -y some-mcp-server)' };
    entry.command = cmd;
    if (body.cwd) entry.cwd = String(body.cwd);
  } else {
    const url = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, why: 'give the server URL (http:// or https://)' };
    const u = new URL(url);
    if (u.protocol === 'http:' && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) return { ok: false, why: 'a remote MCP server must use https://' };
    entry.url = url;
  }
  try {
    entry.env = keepSecrets(id, 'env', body.env, body.secretEnv || []);
    entry.headers = keepSecrets(id, 'header', body.headers, body.secretHeaders || Object.keys(body.headers || {}).filter((k) => /^authorization$|token|key|secret/i.test(k)));
  } catch (e) { return { ok: false, why: e.message }; }
  s.mcp[id] = entry;
  save(app);
  return { ok: true, id, server: describeMcp(app, id) };
}

function describeMcp(app, id) {
  const e = store(app).mcp[id];
  if (!e) return null;
  const c = live.get(id);
  return {
    id, name: e.name, transport: e.transport, enabled: e.enabled !== false, source: e.source || 'custom', addedAt: e.addedAt || null,
    // THE PROGRAM, NOT ITS ARGUMENTS OR ENVIRONMENT — either can carry a token (arguments are shown on the detail only).
    command: e.command ? e.command[0] : null, args: e.command ? e.command.slice(1) : [], url: e.url || null,
    env: describeValues(e.env), headers: describeValues(e.headers),
    state: e.enabled === false ? 'DISABLED' : c ? c.state : 'NOT_CONNECTED',
    why: c ? c.why : '',
    server: c && c.server ? c.server : null,
    capabilities: c && c.state === 'CONNECTED' ? {
      tools: c.tools.map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 300), readOnly: Boolean(t.annotations && t.annotations.readOnlyHint) })),
      resources: c.resources.map((r) => ({ name: r.name || r.uri, uri: r.uri })).slice(0, 100),
      prompts: c.prompts.map((p) => ({ name: p.name, description: String(p.description || '').slice(0, 200) })).slice(0, 100),
    } : null,
  };
}

async function connect(app, id) {
  const e = store(app).mcp[id];
  if (!e) return { ok: false, why: 'no such MCP server' };
  if (e.enabled === false) return { ok: false, why: 'enable it first' };
  disconnect(app, id);
  const { McpClient } = require('./mcpclient');
  const c = new McpClient({ id, transport: e.transport, command: e.command, cwd: e.cwd, env: e.env, url: e.url, headers: e.headers });
  live.set(id, c);
  ensureExitHook();
  const r = await c.connect();
  return r.ok ? { ok: true, server: describeMcp(app, id) } : { ok: false, why: r.why, server: describeMcp(app, id) };
}

function disconnect(app, id) {
  const c = live.get(id);
  if (c) { try { c.close(); } catch { /* gone */ } live.delete(id); }
  return { ok: true };
}

function setEnabled(app, id, enabled) {
  const e = store(app).mcp[id];
  if (!e) return { ok: false, why: 'no such MCP server' };
  e.enabled = Boolean(enabled);
  if (!e.enabled) disconnect(app, id);
  save(app);
  return { ok: true, server: describeMcp(app, id) };
}

function removeMcp(app, id) {
  const s = store(app);
  const e = s.mcp[id];
  if (!e) return { ok: false, why: 'no such MCP server' };
  disconnect(app, id);
  // Its secrets go with it — LAIN kept them only for this server.
  for (const v of [...Object.values(e.env || {}), ...Object.values(e.headers || {})]) if (v && typeof v === 'object' && v.ref) { try { require('./credentials').remove(v.ref); } catch { /* gone */ } }
  delete s.mcp[id];
  save(app);
  return { ok: true };
}

function listMcp(app) { return Object.keys(store(app).mcp).map((id) => describeMcp(app, id)); }

/** Connected servers' tools, as LAIN tools (tools/index.js). */
function toolDefs(app) {
  const out = {};
  const s = store(app).mcp;
  for (const [id, c] of live) {
    if (c.state !== 'CONNECTED' || !s[id] || s[id].enabled === false) continue;
    for (const t of c.tools) {
      const name = `mcp__${id.replace(/[^a-z0-9_]/gi, '_')}__${String(t.name).replace(/[^a-z0-9_]/gi, '_')}`.slice(0, 64);
      const readOnly = Boolean(t.annotations && t.annotations.readOnlyHint);
      out[name] = {
        mutates: false,
        effect: readOnly ? null : 'EXTERNAL',
        approval: readOnly ? null : (input) => `MCP ${s[id].name} › ${t.name}\n${JSON.stringify(input || {}).slice(0, 400)}`,
        schema: { name, description: `[MCP ${s[id].name}] ${String(t.description || t.name).slice(0, 900)}`, parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} } },
        async run(input) {
          try {
            const r = await c.call(t.name, input);
            const text = ((r && r.content) || []).map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : p.type === 'resource' ? `[resource ${p.resource && p.resource.uri}]` : `[${p.type}]`)).join('\n');
            return { output: require('./redact').text(text || JSON.stringify(r || {})).slice(0, 60000), isError: Boolean(r && r.isError) };
          } catch (e) { return { output: `MCP ${s[id].name}: ${e.message}`, isError: true }; }
        },
      };
    }
  }
  return out;
}

// ---- skills --------------------------------------------------------------------------
function skillsDir() { return path.join(require('./config').configDir(), 'skills'); }

/** Front matter (--- name: … description: … ---) and a first heading as fallback. */
function parseSkill(text) {
  const out = { name: null, description: null };
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (m) for (const line of m[1].split(/\r?\n/)) { const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line); if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, ''); }
  if (!out.name) { const h = /^#\s+(.+)$/m.exec(text); if (h) out.name = h[1].trim(); }
  if (!out.description) { const p = text.replace(/^---[\s\S]*?---/, '').split(/\r?\n\r?\n/).map((x) => x.trim()).find((x) => x && !x.startsWith('#')); if (p) out.description = p.slice(0, 300); }
  return out;
}

function validateSkill(dir) {
  const problems = [];
  const warnings = [];
  let skill = null;
  const md = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, problems: ['that folder does not exist'] };
  if (!fs.existsSync(md)) return { ok: false, problems: ['no SKILL.md in that folder'] };
  const text = fs.readFileSync(md, 'utf8');
  if (Buffer.byteLength(text) > 64 * 1024) problems.push('SKILL.md is larger than 64 KB');
  skill = parseSkill(text);
  if (!skill.name) problems.push('SKILL.md names no skill (front matter `name:` or a # heading)');
  if (!skill.description) problems.push('SKILL.md has no description');
  const files = [];
  const walk = (d, depth) => { if (depth > 3 || files.length > 200) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git' || e.name === 'node_modules') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else files.push(path.relative(dir, p)); } };
  walk(dir, 0);
  const scripts = files.filter((f) => /\.(js|mjs|cjs|py|ps1|sh|bat|cmd|exe)$/i.test(f));
  if (scripts.length) warnings.push(`contains ${scripts.length} script(s) — LAIN never runs them on its own; the Agent may, with your permission`);
  return { ok: !problems.length, problems, warnings, skill, files: files.slice(0, 50), scripts };
}

function addSkill(app, body = {}) {
  const s = store(app);
  let dir = null; let source = 'folder'; let repo = null;
  if (body.repo) {
    repo = String(body.repo).trim();
    if (!/^(https:\/\/|git@)[\w.@:/~-]+?(\.git)?$/.test(repo)) return { ok: false, why: 'give an https:// (or git@) repository address' };
    const id0 = uniqueId(s.skills, (body.name || repo.split('/').pop().replace(/\.git$/, '')));
    dir = path.join(skillsDir(), id0);
    if (fs.existsSync(dir)) return { ok: false, why: `${dir} already exists` };
    fs.mkdirSync(skillsDir(), { recursive: true });
    const r = require('child_process').spawnSync('git', ['clone', '--depth', '1', repo, dir], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
    if (r.status !== 0) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* none */ } return { ok: false, why: `git clone failed: ${String(r.stderr || r.error || '').trim().split('\n').pop()}` }; }
    source = 'git';
  } else {
    dir = path.resolve(String(body.path || ''));
    if (!body.path) return { ok: false, why: 'choose the skill folder (it holds SKILL.md)' };
  }
  const v = validateSkill(dir);
  if (!v.ok) { if (source === 'git') try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* none */ } return { ok: false, why: v.problems.join('; '), validation: v }; }
  const id = uniqueId(s.skills, v.skill.name);
  // ADDED DISABLED: the person reads the validation, then enables it.
  s.skills[id] = { name: v.skill.name, description: v.skill.description, path: dir, source, repo, enabled: false, validated: new Date().toISOString(), addedAt: new Date().toISOString() };
  save(app);
  return { ok: true, id, skill: describeSkill(app, id), validation: v };
}
function describeSkill(app, id) {
  const e = store(app).skills[id];
  if (!e) return null;
  const present = fs.existsSync(path.join(e.path, 'SKILL.md'));
  return { id, name: e.name, description: e.description, path: e.path, source: e.source, repo: e.repo || null, enabled: Boolean(e.enabled) && present, present, validated: e.validated || null };
}
function listSkills(app) { return Object.keys(store(app).skills).map((id) => describeSkill(app, id)); }
function setSkill(app, id, enabled) {
  const e = store(app).skills[id];
  if (!e) return { ok: false, why: 'no such skill' };
  if (enabled) { const v = validateSkill(e.path); if (!v.ok) return { ok: false, why: v.problems.join('; ') }; e.validated = new Date().toISOString(); }
  e.enabled = Boolean(enabled);
  save(app);
  return { ok: true, skill: describeSkill(app, id) };
}
function removeSkill(app, id, { deleteFiles = false } = {}) {
  const s = store(app);
  const e = s.skills[id];
  if (!e) return { ok: false, why: 'no such skill' };
  // Only a copy LAIN cloned into its own folder may be deleted, and only when asked.
  if (deleteFiles && (e.source === 'git' || e.source === 'hub') && path.resolve(e.path).startsWith(path.resolve(skillsDir()))) { try { fs.rmSync(e.path, { recursive: true, force: true }); } catch { /* locked */ } }
  delete s.skills[id];
  save(app);
  return { ok: true };
}
/** The skills section of the prompt: names, descriptions, where SKILL.md is. */
function skillsPrompt(app) {
  const on = listSkills(app).filter((k) => k.enabled);
  if (!on.length) return '';
  return `# Skills available\nRead a skill's SKILL.md (read_file) when the task calls for it; do not load them all.\n${on.map((k) => `- ${k.name}: ${k.description} (${path.join(k.path, 'SKILL.md')})`).join('\n')}`;
}

// ---- available, and what a project recommends ------------------------------------------
// SUGGESTIONS, with the command shown — nothing here is installed by LAIN.
const CATALOG = Object.freeze([
  { key: 'godot', name: 'Godot MCP', for: 'Godot projects', transport: 'stdio', command: 'npx -y @coding-solo/godot-mcp', homepage: 'https://github.com/Coding-Solo/godot-mcp', detect: ['project.godot'] },
  { key: 'unreal', name: 'Unreal Engine MCP', for: 'Unreal Engine projects', transport: 'stdio', command: '', homepage: 'https://github.com/chongdashu/unreal-mcp', detect: ['*.uproject'], note: 'needs the Unreal plugin installed in the project first' },
  { key: 'blender', name: 'Blender MCP', for: 'Blender scenes', transport: 'stdio', command: 'uvx blender-mcp', homepage: 'https://github.com/ahujasid/blender-mcp', detect: ['*.blend'], note: 'needs the Blender add-on running' },
  { key: 'playwright', name: 'Playwright (browser automation)', for: 'web apps and browser tasks', transport: 'stdio', command: 'npx -y @playwright/mcp@latest', homepage: 'https://github.com/microsoft/playwright-mcp', detect: [] },
  { key: 'obs', name: 'OBS Studio', for: 'streaming and recording', transport: 'stdio', command: '', homepage: 'https://github.com/royshil/obs-mcp', detect: [], note: 'needs obs-websocket enabled' },
  { key: 'postgres', name: 'PostgreSQL', for: 'databases', transport: 'stdio', command: 'npx -y @modelcontextprotocol/server-postgres postgresql://localhost/db', homepage: 'https://github.com/modelcontextprotocol/servers-archived', detect: [] },
  { key: 'filesystem', name: 'Filesystem (scoped)', for: 'a folder outside the project', transport: 'stdio', command: 'npx -y @modelcontextprotocol/server-filesystem <folder>', homepage: 'https://github.com/modelcontextprotocol/servers', detect: [] },
]);

function recommended(projectRoot) {
  if (!projectRoot) return [];
  let names = [];
  try { names = fs.readdirSync(projectRoot); } catch { return []; }
  const out = [];
  for (const c of CATALOG) {
    if (!c.detect.length) continue;
    const hit = c.detect.some((d) => (d.startsWith('*') ? names.some((n) => n.toLowerCase().endsWith(d.slice(1).toLowerCase())) : names.includes(d)));
    if (hit) out.push({ key: c.key, why: `this project has ${c.detect.join(' / ')}` });
  }
  // A project may state its own (.lain/project.json { "recommends": { "mcp": [...], "skills": [...] } }).
  try {
    const pf = require('./projectmeta').file(projectRoot, 'project.json');
    const j = JSON.parse(fs.readFileSync(pf, 'utf8'));
    const rel = `${path.basename(path.dirname(pf))}/project.json`;
    for (const k of ((j.recommends && j.recommends.mcp) || [])) if (!out.some((o) => o.key === k)) out.push({ key: String(k), why: `the project recommends it (${rel})` });
  } catch { /* none */ }
  return out;
}

function state(app) {
  let projectRoot = null;
  try { const p = require('./sessionviews').project(app.session); projectRoot = p.attached && !p.missing ? p.root : null; } catch { projectRoot = null; }
  return { mcp: listMcp(app), skills: listSkills(app), catalog: CATALOG, recommended: recommended(projectRoot), skillsDir: skillsDir() };
}

module.exports = {
  addMcp, connect, disconnect, setEnabled, removeMcp, listMcp, describeMcp, toolDefs,
  addSkill, validateSkill, listSkills, setSkill, removeSkill, skillsPrompt, parseSkill,
  recommended, state, CATALOG, _live: live, store, save,
};
