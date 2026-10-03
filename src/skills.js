'use strict';

/** LAIN SKILLS — one index over three scopes; METADATA ONLY until a skill is used (Phase CAP, 2026-10-02). */

const fs = require('fs');
const path = require('path');

const HEAD_BYTES = 4096;
const BODY_LIMIT = 24 * 1024;
const LISTED = 30;                 // skills named in one prompt; the rest are found by search_capabilities
const DESC_CHARS = 120;
const STAT_TTL_MS = 2000;

function slug(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

/** Front matter: `key: value`, `key: [a, b]`, and `- item` lists under a key. Nothing else is needed or trusted. */
function frontMatter(text) {
  const t = String(text || '').replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(t);
  const meta = {};
  if (m) {
    let list = null;
    for (const line of m[1].split(/\r?\n/)) {
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item && list) { meta[list].push(unq(item[1])); continue; }
      const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const v = kv[2].trim();
      if (v === '') { meta[key] = []; list = key; continue; }
      list = null;
      meta[key] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(',').map((x) => unq(x.trim())).filter(Boolean) : unq(v);
    }
  }
  const body = m ? t.slice(m[0].length) : t;
  if (!meta.name) { const h = /^#\s+(.+)$/m.exec(body); if (h) meta.name = h[1].trim(); }
  return { meta, body };
}
function unq(s) { return String(s).replace(/^(['"])(.*)\1$/, '$2'); }
function truthy(v) { return v === true || /^(true|yes|1)$/i.test(String(v || '')); }

function readHead(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ } }
}

/** One entry from a SKILL.md (or a plugin's plain .md). Null when it is not a skill. */
function entry(file, scope, extra = {}) {
  const { meta } = frontMatter(readHead(file));
  const name = slug(meta.name || extra.name || path.basename(path.dirname(file)));
  if (!name) return null;
  const description = String(meta.description || extra.description || '').replace(/\s+/g, ' ').trim();
  return {
    name, title: String(meta.name || extra.name || name), description, scope, file, dir: path.dirname(file),
    manualOnly: truthy(meta.manual_only) || truthy(meta['manual-only']) || truthy(meta['disable-model-invocation']),
    context: String(meta.context || '').toLowerCase() === 'scout' ? 'scout' : 'inline',
    allowedTools: Array.isArray(meta['allowed-tools']) ? meta['allowed-tools'].map(String) : meta['allowed-tools'] ? String(meta['allowed-tools']).split(/[,\s]+/).filter(Boolean) : [],
    argumentHint: meta['argument-hint'] ? String(meta['argument-hint']).slice(0, 120) : '',
    valid: Boolean(description),
    ...(extra.plugin ? { plugin: extra.plugin } : {}),
  };
}

function scanRoot(root, scope, { disabled = new Set() } = {}) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')); } catch { return out; }
  for (const d of dirs) {
    const file = path.join(root, d.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    if (disabled.has(path.resolve(path.dirname(file)).toLowerCase())) continue;
    const e = entry(file, scope);
    if (e) out.push(e);
  }
  return out;
}

function homeDir() { return require('./home').resolve(); }
function userRoot() { return path.join(homeDir(), 'skills'); }
function projectRoots(projectRoot) {
  if (!projectRoot) return [];
  const pm = require('./projectmeta');
  return [...new Set([path.join(projectRoot, pm.name(projectRoot), 'skills'), path.join(projectRoot, pm.CANON, 'skills'), path.join(projectRoot, pm.LEGACY, 'skills')])].filter(isDir);
}

/** User skills the person registered as disabled (Settings › Skills, the Hub). Registered folders elsewhere count too. */
function registered(cfg) {
  const s = (cfg && cfg.integrations && cfg.integrations.skills) || {};
  const disabled = new Set();
  const extra = [];
  const root = path.resolve(userRoot()).toLowerCase();
  for (const e of Object.values(s)) {
    if (!e || !e.path) continue;
    const p = path.resolve(e.path).toLowerCase();
    if (e.enabled === false) { disabled.add(p); continue; }
    if (path.dirname(p) !== root && fs.existsSync(path.join(e.path, 'SKILL.md'))) extra.push(path.join(e.path, 'SKILL.md'));
  }
  return { disabled, extra };
}

function pluginSkills(configDir) {
  const out = [];
  let list = [];
  try { list = require('./plugins').list({ configDir }); } catch { list = []; }
  for (const p of list) {
    if (!p.enabled || p.broken) continue;
    const base = path.join(configDir || require('./config').configDir(), 'plugins', p.id);
    for (const s of p.skills || []) {
      const rel = String(s.path || '');
      let file = path.resolve(base, rel);
      if (!file.toLowerCase().startsWith(path.resolve(base).toLowerCase() + path.sep)) continue;   // never outside the plugin
      if (isDir(file)) file = path.join(file, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const e = entry(file, 'plugin', { name: s.name, description: s.description, plugin: p.id });
      if (e) out.push(e);
    }
  }
  return out;
}

// ---- the index, cached by what it was built from ------------------------------------------------------------------
const cache = new Map();   // key -> { sig, at, index }

function signature(roots, files) {
  return [...roots.map((r) => `${r}:${mtime(r)}`), ...files.map((f) => `${f}:${mtime(f)}`)].join('|');
}

/** THE INDEX for a project (or none): { skills: [...winners], shadowed: [...], byName: Map }. */
function index({ cfg = null, projectRoot = null, configDir = null, now = Date.now() } = {}) {
  const key = `${projectRoot || ''}|${configDir || ''}|${homeDir()}`;
  const hit = cache.get(key);
  // A REGISTRATION CHANGE (enable / disable in Settings) is seen at once; file changes within STAT_TTL_MS.
  const regSig = JSON.stringify(Object.values((cfg && cfg.integrations && cfg.integrations.skills) || {}).map((e) => [e && e.path, e && e.enabled]));
  if (hit && hit.regSig === regSig && now - hit.at < STAT_TTL_MS) return hit.index;
  const reg = registered(cfg);
  const pRoots = projectRoots(projectRoot);
  const uRoot = userRoot();
  const files = [];
  for (const r of [...pRoots, uRoot]) { try { for (const d of fs.readdirSync(r)) files.push(path.join(r, d, 'SKILL.md')); } catch { /* none */ } }
  files.push(...reg.extra);
  const pluginState = path.join(configDir || require('./config').configDir(), 'plugins', 'plugins.json');
  const sig = `${signature([...pRoots, uRoot, pluginState], files)}#${regSig}`;
  if (hit && hit.sig === sig) { hit.at = now; hit.regSig = regSig; return hit.index; }
  const all = [
    ...pRoots.flatMap((r) => scanRoot(r, 'project')),
    ...scanRoot(uRoot, 'user', { disabled: reg.disabled }),
    ...reg.extra.map((f) => entry(f, 'user')).filter(Boolean),
    ...pluginSkills(configDir),
    ...scanRoot(path.join(__dirname, '..', 'skills'), 'builtin'),   // shipped with LAIN (migrate), lowest precedence
  ];
  const byName = new Map();
  const shadowed = [];
  for (const e of all) {
    if (!e.valid) continue;
    if (byName.has(e.name)) { shadowed.push({ ...e, by: byName.get(e.name).scope }); continue; }
    byName.set(e.name, e);
  }
  const idx = { skills: [...byName.values()], shadowed, invalid: all.filter((e) => !e.valid), byName, builtAt: now };
  cache.set(key, { sig, regSig, at: now, index: idx });
  return idx;
}

function forApp(app, session = null) {
  const s = session || (app && app.session) || null;
  let projectRoot = null;
  try { const p = require('./sessionviews').project(s); projectRoot = p && p.attached && !p.missing ? p.root : null; } catch { projectRoot = null; }
  if (!projectRoot && s && s.cwd && isDir(path.join(s.cwd, '.lain', 'skills'))) projectRoot = s.cwd;
  const root = (app && app._sibling) || app;
  return index({ cfg: root && root.cfg, projectRoot });
}

/** Skills the MODEL may be told about (manual_only ones are the person's to run). */
function invocable(idx) { return idx.skills.filter((e) => !e.manualOnly); }

/** THE PROMPT SECTION — names and one line each, bounded; empty when there is nothing to offer. */
function prompt(app, session = null) {
  const list = invocable(forApp(app, session));
  if (!list.length) return '';
  const shown = list.slice(0, LISTED);
  const lines = shown.map((e) => `- ${e.name}: ${e.description.slice(0, DESC_CHARS)}${e.description.length > DESC_CHARS ? '…' : ''}${e.context === 'scout' ? ' [runs as a scout]' : ''}`);
  const more = list.length - shown.length;
  return `# Skills\nLoad a skill with the Skill tool when the task matches it — never all of them.${more > 0 ? ` ${more} more: tool_search finds them.` : ''}\n${lines.join('\n')}`;
}

/** THE BODY, read now: instructions (bounded) and the files beside them. */
function body(e) {
  let text = '';
  try { text = fs.readFileSync(e.file, 'utf8'); } catch (err) { return { ok: false, why: `${e.name}: SKILL.md could not be read (${err.code || err.message})` }; }
  const { body: b } = frontMatter(text);
  const truncated = Buffer.byteLength(b) > BODY_LIMIT;
  let files = [];
  try { files = fs.readdirSync(e.dir, { withFileTypes: true }).filter((d) => d.name !== 'SKILL.md' && !d.name.startsWith('.')).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).slice(0, 30); } catch { files = []; }
  return { ok: true, name: e.name, scope: e.scope, dir: e.dir, context: e.context, text: truncated ? `${Buffer.from(b).slice(0, BODY_LIMIT).toString('utf8')}\n[… truncated at ${BODY_LIMIT / 1024} KB — read ${e.file} for the rest]` : b.trim(), files };
}

function find(app, name, session = null) {
  const idx = forApp(app, session);
  return idx.byName.get(slug(name)) || null;
}

/** WHAT A SLASH INVOCATION SENDS (`/skill <name> args` or `/<name> args`): the skill's instructions and the person's request, as one message. */
function expand(app, name, args = '') {
  const e = find(app, name);
  if (!e) return { ok: false, why: `no skill named "${name}" — /skill list shows what is installed` };
  const b = body(e);
  if (!b.ok) return b;
  const request = String(args || '').trim();
  const text = [
    `Use the skill "${e.name}" (${e.scope}${e.plugin ? ` · plugin ${e.plugin}` : ''}). Its instructions:`,
    '<skill>', b.text, b.files.length ? `Files beside it (${e.dir}): ${b.files.join(', ')}` : '', '</skill>',
    request ? `Request: ${request}` : 'Request: apply this skill to the current task.',
  ].filter(Boolean).join('\n');
  return { ok: true, skill: e, text, scout: e.context === 'scout' };
}

/** `/skill`, `/skill list`, `/skill <name> [request]` — and the rows the Harness page draws. */
function rows(app) {
  const idx = forApp(app);
  const tokens = (s) => Math.ceil(Buffer.byteLength(String(s || '')) / 4);
  const listedNames = new Set(invocable(idx).slice(0, LISTED).map((e) => e.name));
  return {
    skills: idx.skills.map((e) => ({
      name: e.name, title: e.title, description: e.description, scope: e.scope, plugin: e.plugin || null, path: e.file,
      manualOnly: e.manualOnly, context: e.context, allowedTools: e.allowedTools, argumentHint: e.argumentHint,
      // CONTEXT IMPACT: what it costs every request while installed (its prompt line), and what loading it costs once.
      impact: { perRequestTokens: listedNames.has(e.name) ? tokens(`- ${e.name}: ${e.description.slice(0, DESC_CHARS)}`) + 1 : 0, onUseTokens: Math.ceil(mtimeSize(e.file) / 4) },
    })),
    shadowed: idx.shadowed.map((e) => ({ name: e.name, scope: e.scope, by: e.by, path: e.file })),
    invalid: idx.invalid.map((e) => ({ name: e.name, scope: e.scope, path: e.file, why: 'SKILL.md has no description' })),
    promptTokens: tokens(prompt(app)),
    roots: { user: userRoot() },
  };
}
function mtimeSize(f) { try { return Math.min(fs.statSync(f).size, BODY_LIMIT); } catch { return 0; } }

/** Search names and descriptions — the cheap half of search_capabilities. */
function search(app, query, { limit = 12, session = null } = {}) {
  const words = String(query || '').toLowerCase().split(/\W+/).filter((w) => w.length > 1 || /\d/.test(w));
  const list = invocable(forApp(app, session));
  if (!words.length) return list.slice(0, limit);
  const scored = list.map((e) => {
    const hay = `${e.name} ${e.description}`.toLowerCase();
    return { e, s: words.reduce((n, w) => n + (e.name.includes(w) ? 3 : 0) + (hay.includes(w) ? 1 : 0), 0) };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.e);
}

function clearCache() { cache.clear(); }

module.exports = { index, forApp, invocable, prompt, body, find, expand, rows, search, frontMatter, clearCache, LISTED, BODY_LIMIT };
