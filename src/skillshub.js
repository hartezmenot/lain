'use strict';

/**
 * THE SKILLS HUB (Phase 8.3) — discover, inspect, install, validate, enable and
 * update compatible skills from outside LAIN, into LAIN's OWN skill store.
 *
 *     external compatible skill ─▶ LAIN Skill Importer ─▶ LAIN Skill Store ─▶ capability registry
 *
 * NEVER "start another agent runtime and ask it to run the skill". A Hermes
 * skill, an agentskills-format folder, a skills.sh-style GitHub repository: each
 * is READ as files (SKILL.md and what sits beside it), copied into
 * <configDir>/skills/<id>/, and offered to LAIN's Agent the way every enabled
 * skill is (integrations.skillsPrompt). Nothing here spawns Hermes or any
 * other runtime, and nothing downloaded is ever executed by LAIN on its own.
 *
 * FORMAT: a folder with SKILL.md — YAML front matter (name, description, and
 * optionally version, license, author, tags, allowed-tools, dependencies,
 * platforms, metadata) followed by instructions. That is the open Agent Skills
 * format Anthropic's skills, Hermes and skills.sh repositories use. A package
 * without SKILL.md is not pretended to be supported: it is listed as
 * incompatible, with the reason.
 *
 * SOURCES (index.sources):
 *   git      a repository (https URL or a local path) — shallow-cloned into
 *            LAIN's cache, scanned for SKILL.md folders (skills.sh-compatible)
 *   folder   a local folder of skill folders — scanned in place
 *   index    a catalog JSON (URL or file): { skills: [ { name, description,
 *            tags, version, source: { type: 'git'|'folder', url|path, subdir } } ] }
 *
 * THE INDEX (<configDir>/skills/hub-index.json) is what Discover draws — at
 * once, from disk; refreshing a source is a background job that rewrites it.
 * Opening Discover or searching never waits on a network.
 *
 * INSTALL SAFETY: before anything is enabled the person sees the source,
 * author, version, license, files, dependencies and requested capabilities. A
 * skill that carries scripts or dependencies is installed DISABLED and needs an
 * explicit, confirmed enable; a pure instruction skill may be enabled at
 * install. Every installed file is hashed (.lain-skill.json) so an update never
 * silently overwrites a local change: View diff · Update and overwrite · Keep
 * local · Duplicate.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST = '.lain-skill.json';
const SCRIPT_RE = /\.(js|mjs|cjs|ts|py|ps1|psm1|sh|bash|bat|cmd|exe|dll|so|rb|pl)$/i;
const DEP_FILES = ['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'Gemfile', 'go.mod', 'Cargo.toml'];

/** THE LAIN CATALOG: sources worth knowing, offered — never fetched until the person adds or refreshes one. */
const SUGGESTED = Object.freeze([
  { id: 'anthropic-skills', type: 'git', label: 'Anthropic Skills', url: 'https://github.com/anthropics/skills', compat: 'SKILL.md (Agent Skills format)' },
  { id: 'hermes-skills', type: 'git', label: 'Hermes Agent skills', url: 'https://github.com/NousResearch/hermes-agent', subdir: 'skills', compat: 'SKILL.md (Hermes / Agent Skills format) — read as files; Hermes is never run' },
]);

function cfgDir() { return require('./config').configDir(); }
function storeDir() { return path.join(cfgDir(), 'skills'); }
function cacheDir() { return path.join(cfgDir(), 'skills-cache'); }
function indexFile() { return path.join(storeDir(), 'hub-index.json'); }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill'; }
function sha(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

// ---------------------------------------------------------------- index --

let memo = null;
function sigOf(f) { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return 'none'; } }
function readIndex() {
  const f = indexFile();
  const sig = sigOf(f);
  if (memo && memo.f === f && memo.sig === sig) return memo.value;
  let v = { version: 1, sources: {}, skills: [] };
  try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (d && typeof d === 'object') v = { version: 1, sources: d.sources || {}, skills: Array.isArray(d.skills) ? d.skills : [] }; } catch { /* first run */ }
  memo = { f, sig, value: v };
  return v;
}
function writeIndex(v) {
  fs.mkdirSync(storeDir(), { recursive: true });
  const tmp = `${indexFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
  fs.renameSync(tmp, indexFile());
  memo = { f: indexFile(), sig: sigOf(indexFile()), value: v };
}

// ---------------------------------------------------------- SKILL.md ---

/** YAML-lite front matter: scalars, inline [a, b] lists, "- item" lists, one level of nesting. */
function frontMatter(text) {
  const out = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return out;
  let key = null; let nested = null;
  const val = (v) => {
    const s = String(v).trim();
    if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    return s.replace(/^["']|["']$/g, '');
  };
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (top) { key = top[1].toLowerCase(); nested = null; out[key] = top[2] === '' ? null : val(top[2]); continue; }
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && key) { if (!Array.isArray(out[key])) out[key] = []; out[key].push(val(item[1])); continue; }
    const sub = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (sub && key) { if (!out[key] || typeof out[key] !== 'object' || Array.isArray(out[key])) out[key] = {}; nested = sub[1].toLowerCase(); out[key][nested] = sub[2] === '' ? null : val(sub[2]); }
  }
  return out;
}

function walk(dir, { depth = 4, limit = 400 } = {}) {
  const files = [];
  const go = (d, n) => {
    if (n > depth || files.length >= limit) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === MANIFEST) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) go(p, n + 1); else if (e.isFile()) files.push(path.relative(dir, p).replace(/\\/g, '/'));
    }
  };
  go(dir, 0);
  return files.sort();
}

/** WHAT A SKILL FOLDER IS: its metadata, files, scripts, dependencies and the capabilities it asks for. */
function describeFolder(dir) {
  const md = path.join(dir, 'SKILL.md');
  let text = '';
  try { text = fs.readFileSync(md, 'utf8'); } catch { return null; }
  const fm = frontMatter(text);
  const base = require('./integrations').parseSkill(text);
  const files = walk(dir);
  const scripts = files.filter((f) => SCRIPT_RE.test(f));
  const meta = fm.metadata && typeof fm.metadata === 'object' ? fm.metadata : {};
  const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(/[,\s]+/).filter(Boolean) : []);
  const deps = [...list(fm.dependencies), ...list(fm.requirements), ...files.filter((f) => DEP_FILES.includes(path.basename(f)))];
  const hash = sha(Buffer.concat(files.map((f) => { try { return Buffer.concat([Buffer.from(f), fs.readFileSync(path.join(dir, f))]); } catch { return Buffer.from(f); } })));
  return {
    name: fm.name || base.name || path.basename(dir), description: fm.description || base.description || '',
    version: fm.version || meta.version || null, license: fm.license || meta.license || null, author: fm.author || meta.author || null,
    tags: [...new Set([...list(fm.tags), ...list(meta.tags), ...list(meta.hermes && meta.hermes.tags)])].slice(0, 20),
    platforms: list(fm.platforms || fm.platform || meta.platforms),
    capabilities: list(fm['allowed-tools'] || fm.allowed_tools || fm.capabilities || fm.permissions),
    dependencies: [...new Set(deps)], files, scripts, executable: scripts.length > 0 || deps.length > 0, hash,
    compatible: Boolean((fm.name || base.name) && (fm.description || base.description)),
  };
}

/** Every folder under `root` holding a SKILL.md — a repository, a folder of skills, or one skill. */
function scan(root, { depth = 4 } = {}) {
  const out = [];
  const go = (d, n) => {
    if (n > depth || out.length > 500) return;
    if (fs.existsSync(path.join(d, 'SKILL.md'))) { out.push(d); return; }
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') go(path.join(d, e.name), n + 1);
  };
  go(root, 0);
  return out;
}

// -------------------------------------------------------------- sources --

function git(args, cwd) {
  const r = require('child_process').spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 180000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  return { ok: r.status === 0, err: String(r.stderr || (r.error && r.error.message) || '').trim().split('\n').pop() };
}

function addSource({ type, url = '', path: p = '', label = '', subdir = '', ref = '' } = {}) {
  if (!['git', 'folder', 'index'].includes(type)) return { ok: false, why: 'a source is a git repository, a folder or a catalog index' };
  const where = String(type === 'folder' ? p : (url || p)).trim();
  if (!where) return { ok: false, why: 'say where it is' };
  if (type === 'git' && !/^(https:\/\/|git@|file:\/\/)/.test(where) && !fs.existsSync(where)) return { ok: false, why: 'a repository is an https:// address or a local path' };
  if (type === 'index' && !/^https?:\/\//.test(where) && !fs.existsSync(where)) return { ok: false, why: 'a catalog is an http(s) address or a local file' };
  if (type === 'folder' && !fs.existsSync(where)) return { ok: false, why: 'that folder does not exist' };
  const v = JSON.parse(JSON.stringify(readIndex()));
  const sug = SUGGESTED.find((s) => s.url === where);
  let id = sug ? sug.id : slug(label || path.basename(where).replace(/\.git$/, ''));
  let n = 2; while (v.sources[id] && v.sources[id].where !== where) id = `${slug(label || path.basename(where))}-${n++}`;
  v.sources[id] = { id, type, where, label: String(label || (sug && sug.label) || path.basename(where)).slice(0, 60), subdir: String(subdir || (sug && sug.subdir) || ''), ref: String(ref || ''), addedAt: Date.now(), refreshedAt: null, error: null, count: 0 };
  writeIndex(v);
  return { ok: true, id, source: v.sources[id] };
}
function removeSource(id) {
  const v = JSON.parse(JSON.stringify(readIndex()));
  if (!v.sources[id]) return { ok: false, why: 'no such source' };
  delete v.sources[id];
  v.skills = v.skills.filter((s) => s.source !== id);
  writeIndex(v);
  return { ok: true };
}

async function fetchJson(where) {
  if (/^https?:\/\//.test(where)) {
    const r = await fetch(where, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  return JSON.parse(fs.readFileSync(where, 'utf8'));
}

/** Where a source's files are on this machine once it is fetched. */
async function materialize(src) {
  if (src.type === 'folder') return { ok: true, root: path.resolve(src.where, src.subdir || '') };
  if (src.type === 'git') {
    const dest = path.join(cacheDir(), src.id);
    fs.mkdirSync(cacheDir(), { recursive: true });
    let r;
    if (fs.existsSync(path.join(dest, '.git'))) {
      // LAIN'S OWN CACHE: brought to the source's current head. The person's own clones are never touched.
      r = git(['fetch', '--depth', '1', 'origin', src.ref || 'HEAD'], dest);
      if (r.ok) r = git(['reset', '--hard', 'FETCH_HEAD'], dest);
    } else {
      r = git(['clone', '--depth', '1', ...(src.ref ? ['--branch', src.ref] : []), src.where, dest], cacheDir());
    }
    if (!r.ok) return { ok: false, why: `git: ${r.err}` };
    return { ok: true, root: path.join(dest, src.subdir || '') };
  }
  return { ok: false, why: 'unknown source type' };
}

function entryFor(src, dir, root, extra = {}) {
  const d = describeFolder(dir);
  if (!d) return null;
  const rel = path.relative(root, dir).replace(/\\/g, '/') || '.';
  return { key: `${src.id}:${rel}`, source: src.id, sourceLabel: src.label, rel, dir, ...d, tags: [...new Set([...(d.tags || []), ...(extra.tags || [])])], version: d.version || extra.version || null, indexedAt: Date.now() };
}

/**
 * REFRESH — fetch a source (or all) and rewrite the index. The page never
 * waits on this: it draws the index it has and is told when this lands.
 */
async function refresh({ id = null } = {}) {
  const v0 = readIndex();
  const ids = id ? [id] : Object.keys(v0.sources);
  const results = [];
  for (const sid of ids) {
    const src = readIndex().sources[sid];
    if (!src) { results.push({ id: sid, ok: false, why: 'no such source' }); continue; }
    let entries = []; let why = null;
    try {
      if (src.type === 'index') {
        const cat = await fetchJson(src.where);
        for (const s of (cat && cat.skills) || []) {
          const sub = s.source || {};
          const inner = { id: `${src.id}~${slug(s.name)}`, type: sub.type || 'git', where: sub.url || sub.path || '', label: `${src.label} · ${s.name}`, subdir: sub.subdir || '', ref: sub.ref || '' };
          if (!inner.where) continue;
          // eslint-disable-next-line no-await-in-loop -- one catalog entry at a time
          const m = await materialize(inner);
          if (!m.ok) { entries.push({ key: `${src.id}:${slug(s.name)}`, source: src.id, sourceLabel: src.label, name: s.name, description: s.description || '', tags: s.tags || [], version: s.version || null, compatible: false, why: m.why, indexedAt: Date.now() }); continue; }
          for (const dir of scan(m.root)) { const e = entryFor(src, dir, m.root, { tags: s.tags, version: s.version }); if (e) entries.push({ ...e, key: `${src.id}:${slug(s.name)}${e.rel === '.' ? '' : `/${e.rel}`}` }); }
        }
      } else {
        const m = await materialize(src);
        if (!m.ok) why = m.why;
        else for (const dir of scan(m.root)) { const e = entryFor(src, dir, m.root); if (e) entries.push(e); }
      }
    } catch (e) { why = e.message; }
    const v = JSON.parse(JSON.stringify(readIndex()));
    if (!v.sources[sid]) continue;
    if (!why) v.skills = [...v.skills.filter((s) => s.source !== sid), ...entries];
    v.sources[sid] = { ...v.sources[sid], refreshedAt: Date.now(), error: why, count: why ? v.sources[sid].count : entries.length };
    writeIndex(v);
    results.push({ id: sid, ok: !why, why, count: entries.length });
  }
  return { ok: true, results };
}

// ------------------------------------------------------------ installed --

function manifestOf(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch { return null; } }
function hashes(dir) { const out = {}; for (const f of walk(dir)) { try { out[f] = sha(fs.readFileSync(path.join(dir, f))); } catch { /* unreadable */ } } return out; }

function installed(app) {
  const integ = require('./integrations');
  return integ.listSkills(app).map((k) => {
    const man = manifestOf(k.path);
    return { ...k, hub: man ? { key: man.key, source: man.sourceLabel, version: man.version, installedAt: man.installedAt, executable: man.executable } : null };
  });
}

/** Local edits since install: files changed, added or removed against the install-time hashes. */
function localChanges(dir, man) {
  const now = hashes(dir);
  const was = (man && man.files) || {};
  const changed = Object.keys(now).filter((f) => was[f] && was[f] !== now[f]);
  const added = Object.keys(now).filter((f) => !was[f]);
  const removed = Object.keys(was).filter((f) => !now[f]);
  return { changed, added, removed, modified: changed.length + added.length + removed.length > 0 };
}

function updateState(app, k) {
  const man = manifestOf(k.path);
  if (!man) return null;
  const e = readIndex().skills.find((s) => s.key === man.key);
  if (!e) return { available: null, updateAvailable: false };
  const newer = e.hash && e.hash !== man.hash && !(man.skipHash && man.skipHash === e.hash);
  return { available: e.version, installedVersion: man.version, updateAvailable: Boolean(newer), local: localChanges(k.path, man) };
}

/** SEARCH THE INDEX — instant, from disk; installed and update state marked. */
function search(app, { query = '', tag = null, source = null, limit = 200 } = {}) {
  const t0 = process.hrtime.bigint();
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const inst = installed(app);
  const byKey = new Map();
  for (const k of inst) if (k.hub && k.hub.key) byKey.set(k.hub.key, k);
  const rows = readIndex().skills.filter((s) => (!source || s.source === source) && (!tag || (s.tags || []).includes(tag))
    && (!words.length || words.every((w) => `${s.name} ${s.description} ${(s.tags || []).join(' ')} ${s.sourceLabel}`.toLowerCase().includes(w))));
  const out = rows.slice(0, limit).map((s) => {
    const k = byKey.get(s.key);
    const u = k ? updateState(app, k) : null;
    return { key: s.key, name: s.name, description: s.description, tags: s.tags || [], version: s.version, source: s.source, sourceLabel: s.sourceLabel, compatible: s.compatible !== false, why: s.why || null,
      executable: Boolean(s.executable), platforms: s.platforms || [], requirements: s.dependencies || [], installed: k ? k.id : null, updateAvailable: Boolean(u && u.updateAvailable) };
  });
  return { skills: out, total: rows.length, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

/** EVERYTHING THE PERSON SHOULD SEE BEFORE INSTALLING: source, author, version, license, files, deps, capabilities. */
function inspect(key) {
  const s = readIndex().skills.find((x) => x.key === key);
  if (!s) return { ok: false, why: 'not in the index — refresh the source' };
  if (s.compatible === false || !s.dir) return { ok: true, skill: { ...s, compatible: false } };
  const d = describeFolder(s.dir);
  if (!d) return { ok: false, why: 'the source no longer has it — refresh the source' };
  const src = readIndex().sources[s.source] || {};
  return { ok: true, skill: { key, name: d.name, description: d.description, version: d.version, license: d.license, author: d.author, tags: d.tags, platforms: d.platforms,
    source: { id: s.source, label: s.sourceLabel, type: src.type || null, where: src.where || null }, files: d.files, scripts: d.scripts, dependencies: d.dependencies, capabilities: d.capabilities,
    executable: d.executable, compatible: d.compatible, policy: d.executable ? 'installed disabled — it carries scripts or dependencies; enabling asks you to confirm' : 'instruction-only — may be enabled at install' } };
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of walk(from, { depth: 8, limit: 2000 })) { const dst = path.join(to, f); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(from, f), dst); }
}

function writeManifest(dir, s, d) {
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ key: s.key, source: s.source, sourceLabel: s.sourceLabel, version: d.version, hash: d.hash, files: hashes(dir), executable: d.executable, installedAt: Date.now() }, null, 1));
}

/** INSTALL — copy, validate, register. Executable skills stay disabled until a confirmed enable. */
function install(app, key, { enable = true, as = null } = {}) {
  const s = readIndex().skills.find((x) => x.key === key);
  if (!s || !s.dir) return { ok: false, why: 'not in the index — refresh the source' };
  const d = describeFolder(s.dir);
  if (!d || !d.compatible) return { ok: false, why: 'not a compatible skill (SKILL.md with a name and a description)' };
  const integ = require('./integrations');
  const store = integ.store(app);
  let id = slug(as || d.name); let n = 2;
  while (store.skills[id] || fs.existsSync(path.join(storeDir(), id))) id = `${slug(as || d.name)}-${n++}`;
  const dir = path.join(storeDir(), id);
  copyDir(s.dir, dir);
  const v = integ.validateSkill(dir);
  if (!v.ok) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ } return { ok: false, why: v.problems.join('; ') }; }
  writeManifest(dir, s, d);
  const on = Boolean(enable) && !d.executable;
  store.skills[id] = { name: d.name, description: d.description, path: dir, source: 'hub', repo: null, enabled: on, validated: new Date().toISOString(), addedAt: new Date().toISOString() };
  integ.save(app);
  return { ok: true, id, enabled: on, needsConfirm: d.executable, validation: { warnings: v.warnings, scripts: d.scripts, dependencies: d.dependencies } };
}

/** ENABLE — an executable skill only with `confirm`, after its scripts and dependencies were shown. */
function enable(app, id, { confirm = false } = {}) {
  const integ = require('./integrations');
  const e = integ.store(app).skills[id];
  if (!e) return { ok: false, why: 'no such skill' };
  const d = describeFolder(e.path);
  if (d && d.executable && !confirm) return { ok: false, needsConfirm: true, why: 'this skill carries scripts or dependencies — confirm to enable it', scripts: d.scripts, dependencies: d.dependencies };
  return integ.setSkill(app, id, true);
}

/** A small line diff (LCS), for "View diff" before an update overwrites a local change. */
function lineDiff(a, b) {
  const A = String(a).split(/\r?\n/); const B = String(b).split(/\r?\n/);
  if (A.length * B.length > 4e6) return [`- (${A.length} lines)`, `+ (${B.length} lines)`];
  const T = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) T[i][j] = A[i] === B[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < A.length && j < B.length) { if (A[i] === B[j]) { i++; j++; } else if (T[i + 1][j] >= T[i][j + 1]) out.push(`- ${A[i++]}`); else out.push(`+ ${B[j++]}`); }
  while (i < A.length) out.push(`- ${A[i++]}`);
  while (j < B.length) out.push(`+ ${B[j++]}`);
  return out;
}

/**
 * UPDATE — never a silent overwrite of a local change.
 *   check       what is available, and what was changed locally
 *   diff        local vs incoming, per changed file
 *   overwrite   take the new version (a new script or dependency disables it until confirmed)
 *   keep        keep the local copy; this version is not offered again
 *   duplicate   install the new version beside it
 */
function update(app, id, { action = 'check' } = {}) {
  const integ = require('./integrations');
  const e = integ.store(app).skills[id];
  if (!e) return { ok: false, why: 'no such skill' };
  const man = manifestOf(e.path);
  if (!man) return { ok: false, why: 'this skill was not installed from a source Noema tracks' };
  const s = readIndex().skills.find((x) => x.key === man.key);
  if (!s || !s.dir) return { ok: false, why: 'its source is not in the index — refresh the source' };
  const inc = describeFolder(s.dir);
  const local = localChanges(e.path, man);
  const updateAvailable = Boolean(inc && inc.hash !== man.hash);
  if (action === 'check') return { ok: true, installedVersion: man.version, available: inc && inc.version, updateAvailable, local, choices: local.modified ? ['diff', 'overwrite', 'keep', 'duplicate'] : ['overwrite', 'keep'] };
  if (action === 'diff') {
    const files = [...new Set([...local.changed, ...local.added, ...local.removed, ...((inc && inc.files) || []).filter((f) => !(man.files || {})[f])])];
    return { ok: true, diff: files.slice(0, 40).map((f) => {
      let mine = ''; let theirs = '';
      try { mine = fs.readFileSync(path.join(e.path, f), 'utf8'); } catch { /* removed locally */ }
      try { theirs = fs.readFileSync(path.join(s.dir, f), 'utf8'); } catch { /* not in the new version */ }
      return { file: f, lines: lineDiff(mine, theirs).slice(0, 400) };
    }) };
  }
  if (action === 'keep') { man.skipHash = inc && inc.hash; fs.writeFileSync(path.join(e.path, MANIFEST), JSON.stringify(man, null, 1)); return { ok: true, kept: true }; }
  if (action === 'duplicate') return install(app, s.key, { enable: false, as: `${e.name} ${inc && inc.version ? inc.version : 'update'}` });
  if (action === 'overwrite') {
    if (!updateAvailable) return { ok: false, why: 'nothing newer to take' };
    const was = describeFolder(e.path);
    for (const f of walk(e.path, { depth: 8, limit: 2000 })) { try { fs.rmSync(path.join(e.path, f), { force: true }); } catch { /* locked */ } }
    copyDir(s.dir, e.path);
    writeManifest(e.path, s, inc);
    // A NEW SCRIPT OR DEPENDENCY is a new permission: the skill waits for a confirmed enable again.
    const newExec = inc.scripts.some((x) => !((was && was.scripts) || []).includes(x)) || inc.dependencies.some((x) => !((was && was.dependencies) || []).includes(x));
    if (newExec && e.enabled) { e.enabled = false; integ.save(app); }
    return { ok: true, updated: true, version: inc.version, disabledForReview: Boolean(newExec) };
  }
  return { ok: false, why: 'the action is check, diff, overwrite, keep or duplicate' };
}

function state(app) {
  const v = readIndex();
  const sugg = SUGGESTED.filter((s) => !Object.values(v.sources).some((x) => x.where === s.url));
  return { sources: Object.values(v.sources), suggested: sugg, indexed: v.skills.length, installed: installed(app).map((k) => ({ ...k, update: k.hub ? updateState(app, k) : null })) };
}

module.exports = { SUGGESTED, frontMatter, describeFolder, scan, addSource, removeSource, refresh, search, inspect, install, enable, update, installed, state, readIndex, lineDiff, indexFile };
