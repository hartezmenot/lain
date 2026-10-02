'use strict';

/**
 * EXTENSIONS — installing VS Code-format extensions (.vsix) into LAIN, and
 * using the part of them LAIN can use.
 *
 * ------------------------------------------------------------------------
 * WHAT LAIN DOES WITH AN EXTENSION, AND WHAT IT DOES NOT.
 *
 * LAIN does not run the VS Code extension host. An extension whose package
 * declares code (`main` / `browser`) is stored and listed, and that code is
 * NEVER loaded, required or executed — installed code would be privileged, and
 * there is no sandbox here to run it in. What LAIN uses is declarative:
 *
 *   contributes.snippets   → offered in the IDE editor for that language
 *
 * Everything else an extension contributes is shown as "not used by LAIN"
 * rather than implied to work.
 *
 * ------------------------------------------------------------------------
 * WHERE ONE COMES FROM:
 *
 *   a .vsix file           zipread.js, every entry path checked
 *   a folder               an unpacked extension (package.json at its root)
 *   an https URL           a .vsix download, size-capped
 *   Open VSX               open-vsx.org's public API — the registry that
 *                          publishes a sha256 for every file, which is checked
 *                          before anything is kept. The Microsoft Marketplace
 *                          is not used: its terms limit it to Microsoft's own
 *                          products.
 *
 * SCOPE: `global` lives in LAIN's config directory; `workspace` in the
 * project's own `.lain/extensions`. Enabled state is kept per scope.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zip = require('./zipread');

const OPENVSX = 'https://open-vsx.org/api';
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}\.[a-z0-9][a-z0-9._-]{0,127}$/i;

function bad(why, extra = {}) { return { ok: false, why: String(why), ...extra }; }

function rootFor(scope, { configDir = null, project = null } = {}) {
  if (scope === 'workspace') return project ? require('./projectmeta').file(project, 'extensions') : null;
  return path.join(configDir || require('./config').configDir(), 'extensions');
}

function registryFile(root) { return path.join(root, 'extensions.json'); }
function readRegistry(root) {
  try { const r = JSON.parse(fs.readFileSync(registryFile(root), 'utf8')); return Array.isArray(r.installed) ? r : { installed: [] }; } catch { return { installed: [] }; }
}
function writeRegistry(root, reg) {
  fs.mkdirSync(root, { recursive: true });
  const f = registryFile(root);
  fs.writeFileSync(`${f}.tmp`, `${JSON.stringify(reg, null, 2)}\n`);
  fs.renameSync(`${f}.tmp`, f);
}

/** What the package says, and what LAIN will and will not do with it. */
function describe(pkg) {
  const c = (pkg && pkg.contributes) || {};
  const snippets = Array.isArray(c.snippets) ? c.snippets.filter((s) => s && s.path).map((s) => ({ language: require('./editorprofile').language(s.language || '*'), path: String(s.path) })) : [];
  const code = Boolean(pkg.main || pkg.browser);
  const other = Object.keys(c).filter((k) => k !== 'snippets');
  return {
    snippets,
    code,
    uses: snippets.length ? [`snippets for ${[...new Set(snippets.map((s) => s.language))].join(', ')}`] : [],
    notUsed: [...(code ? ['its code (LAIN does not run the VS Code extension host)'] : []), ...other.slice(0, 8).map((k) => `contributes.${k}`)],
  };
}

function readPackage(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

// ---- getting the bytes --------------------------------------------------------

async function download(url, to) {
  let u;
  try { u = new URL(String(url)); } catch { return bad('not a URL'); }
  if (u.protocol !== 'https:') return bad('extensions are downloaded over https only');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(u, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return bad(`the download answered ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_DOWNLOAD) return bad(`the file is larger than ${MAX_DOWNLOAD / 1048576} MB`);
    const chunks = [];
    let got = 0;
    for await (const ch of res.body) {
      got += ch.length;
      if (got > MAX_DOWNLOAD) { ctrl.abort(); return bad(`the file is larger than ${MAX_DOWNLOAD / 1048576} MB`); }
      chunks.push(Buffer.from(ch));
    }
    fs.writeFileSync(to, Buffer.concat(chunks));
    return { ok: true, bytes: got };
  } catch (e) {
    return bad(ctrl.signal.aborted ? 'the download timed out' : `the download failed: ${e.message}`);
  } finally { clearTimeout(timer); }
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return bad(`Open VSX answered ${r.status}`);
    return { ok: true, json: await r.json() };
  } catch (e) { return bad(ctrl.signal.aborted ? 'Open VSX did not answer in time' : `Open VSX could not be reached: ${e.message}`); } finally { clearTimeout(timer); }
}

/** Open VSX: what `publisher.name` is, at a version or the latest. */
async function openvsxInfo(id, version = null) {
  if (!ID_RE.test(String(id || ''))) return bad('an Open VSX id looks like publisher.name');
  const [ns, name] = String(id).split(/\.(.+)/);
  const r = await fetchJson(`${OPENVSX}/${encodeURIComponent(ns)}/${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ''}`);
  if (!r.ok) return r;
  const j = r.json || {};
  if (j.error) return bad(String(j.error));
  const files = j.files || {};
  if (!files.download) return bad('Open VSX lists no download for it');
  return { ok: true, id: `${j.namespace}.${j.name}`, version: String(j.version || ''), download: files.download, sha256: files.sha256 || null, verified: Boolean(j.verified), license: j.license || null, name: j.displayName || j.name, description: String(j.description || '').slice(0, 300) };
}

async function search(query) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, results: [] };
  const r = await fetchJson(`${OPENVSX}/-/search?query=${encodeURIComponent(q)}&size=20`);
  if (!r.ok) return r;
  const list = Array.isArray(r.json && r.json.extensions) ? r.json.extensions : [];
  return { ok: true, results: list.map((x) => ({ id: `${x.namespace}.${x.name}`, version: String(x.version || ''), name: x.displayName || x.name, description: String(x.description || '').slice(0, 200), verified: Boolean(x.verified) })) };
}

// ---- install -------------------------------------------------------------------

/**
 * A GIT SOURCE, checked before anything runs: an https address with no user or password in it (a token in a URL
 * ends up in logs and history), an optional branch/tag, and an optional sub-folder written as `url#path/in/repo`.
 */
function gitSource(raw, ref = null) {
  let s = String(raw || '').trim();
  let subdir = null;
  const hash = s.indexOf('#');
  if (hash >= 0) { subdir = s.slice(hash + 1).replace(/^[\\/]+|[\\/]+$/g, ''); s = s.slice(0, hash); }
  let u;
  try { u = new URL(s); } catch { return bad('a Git source is an https address, like https://github.com/owner/repo'); }
  if (u.protocol !== 'https:') return bad('only https Git addresses are accepted');
  if (u.username || u.password) return bad('an address with a user name or token in it is not used — credentials never go in a URL');
  if (!/^[\w.-]+$/.test(u.hostname) || !/^\/[\w.-]+\/[\w.-]+(\/[\w.-]+)*\/?$/.test(u.pathname)) return bad('that does not look like a repository address');
  if (subdir && (/\.\./.test(subdir) || !/^[\w./-]+$/.test(subdir))) return bad('the sub-folder after # must be a plain path inside the repository');
  const r = ref == null || ref === '' ? null : String(ref);
  if (r && !/^[\w./-]{1,100}$/.test(r)) return bad('a branch or tag is letters, digits and . _ / -');
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/$/, '')}`, ref: r, subdir: subdir || null };
}

/**
 * Install from `{ vsix }`, `{ folder }`, `{ url }` or `{ openvsx, version }`.
 * Nothing is kept until the package reads, its id is valid and (for Open VSX)
 * its sha256 matches.
 */
async function install(src = {}, { scope = 'global', configDir = null, project = null } = {}) {
  const root = rootFor(scope, { configDir, project });
  if (!root) return bad('a workspace install needs a project');
  fs.mkdirSync(root, { recursive: true });
  const stage = fs.mkdtempSync(path.join(root, '.staging-'));
  const tmpFile = path.join(os.tmpdir(), `lain-ext-${process.pid}-${crypto.randomBytes(4).toString('hex')}.vsix`);
  let origin = null;
  let verified = null;
  try {
    let vsix = null;
    if (src.vsix) {
      vsix = path.resolve(String(src.vsix));
      if (!fs.existsSync(vsix)) return bad('that .vsix file does not exist');
      origin = { kind: 'vsix', ref: path.basename(vsix) };
    } else if (src.folder) {
      const dir = path.resolve(String(src.folder));
      if (!readPackage(dir)) return bad('that folder has no readable package.json');
      fs.cpSync(dir, stage, { recursive: true, filter: (p) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(p.slice(dir.length)) });
      origin = { kind: 'folder', ref: dir };
    } else if (src.git) {
      // A GIT REPOSITORY (2026-09-30): https only, no credentials in the address, a shallow clone that can never
      // prompt — then installed exactly like a folder. Cloning runs nothing from the repository.
      const g = gitSource(src.git, src.ref);
      if (!g.ok) return g;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-ext-git-'));
      try {
        const args = ['clone', '--depth', '1', '--no-tags', '--single-branch', ...(g.ref ? ['--branch', g.ref] : []), '--', g.url, tmpDir];
        const r = require('child_process').spawnSync('git', args, { encoding: 'utf8', windowsHide: true, timeout: 180000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
        if (r.status !== 0) return bad(`the repository could not be cloned: ${String(r.stderr || r.error || '').trim().split('\n').pop() || 'git failed'}`);
        const sub = g.subdir ? path.join(tmpDir, g.subdir) : tmpDir;
        if (!readPackage(sub)) return bad('the repository has no readable package.json' + (g.subdir ? ` in ${g.subdir}` : ' at its root'));
        const head = require('child_process').spawnSync('git', ['-C', tmpDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
        fs.cpSync(sub, stage, { recursive: true, filter: (p) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(p.slice(sub.length)) });
        origin = { kind: 'git', ref: g.url, commit: head.status === 0 ? String(head.stdout).trim().slice(0, 40) : null, branch: g.ref || null };
      } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    } else if (src.url) {
      const d = await download(src.url, tmpFile);
      if (!d.ok) return d;
      vsix = tmpFile;
      origin = { kind: 'url', ref: String(src.url) };
    } else if (src.openvsx) {
      const info = await openvsxInfo(src.openvsx, src.version || null);
      if (!info.ok) return info;
      const d = await download(info.download, tmpFile);
      if (!d.ok) return d;
      if (!info.sha256) return bad('Open VSX published no checksum for this file, so it was not installed');
      const want = await fetch(info.sha256).then((r) => (r.ok ? r.text() : '')).catch(() => '');
      const have = crypto.createHash('sha256').update(fs.readFileSync(tmpFile)).digest('hex');
      if (!want || want.trim().split(/\s/)[0].toLowerCase() !== have) return bad('the download does not match the checksum Open VSX published — not installed');
      verified = { sha256: have, publisherVerified: info.verified };
      vsix = tmpFile;
      origin = { kind: 'openvsx', ref: info.id };
    } else {
      return bad('say where the extension comes from: a .vsix, a folder, a URL, a Git repository or an Open VSX id');
    }
    if (vsix) {
      try { zip.extract(vsix, stage, { prefix: 'extension/' }); } catch (e) { return bad(e.zip ? e.message : `the .vsix could not be read: ${e.message}`); }
    }
    const pkg = readPackage(stage);
    if (!pkg) return bad('the extension has no readable package.json');
    const id = `${pkg.publisher || ''}.${pkg.name || ''}`;
    if (!ID_RE.test(id)) return bad(`"${id}" is not a valid extension id (publisher.name)`);
    const version = String(pkg.version || '0.0.0').slice(0, 40);
    const dirName = `${id}-${version}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const target = path.join(root, dirName);
    const reg = readRegistry(root);
    const prev = reg.installed.find((x) => x.id === id);
    if (prev && prev.dir !== dirName) fs.rmSync(path.join(root, prev.dir), { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(stage, target);
    const d = describe(pkg);
    const entry = {
      id, version, dir: dirName, name: String(pkg.displayName || pkg.name).slice(0, 120), publisher: String(pkg.publisher),
      description: String(pkg.description || '').slice(0, 300), source: origin, verified,
      enabled: prev ? prev.enabled : true, installedAt: Date.now(), code: d.code, uses: d.uses, notUsed: d.notUsed,
    };
    reg.installed = [...reg.installed.filter((x) => x.id !== id), entry].sort((a, b) => a.id.localeCompare(b.id));
    writeRegistry(root, reg);
    return { ok: true, scope, extension: entry, updated: Boolean(prev), from: prev ? prev.version : null };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(tmpFile, { force: true });
  }
}

/**
 * REGISTER A PACKAGE FROM THE CONTENT-ADDRESSED STORE (extpackages.js reuse):
 * a global entry whose folder is that store directory. Nothing is copied here.
 */
function registerPackage({ packageDir, packageRef, origin, configDir = null } = {}) {
  const root = rootFor('global', { configDir });
  const pkg = readPackage(packageDir);
  if (!pkg) return bad('the stored package has no readable package.json');
  const id = `${pkg.publisher || ''}.${pkg.name || ''}`;
  if (!ID_RE.test(id)) return bad(`"${id}" is not a valid extension id (publisher.name)`);
  const reg = readRegistry(root);
  const prev = reg.installed.find((x) => x.id.toLowerCase() === id.toLowerCase());
  if (prev && !prev.packageRef) return bad(`${id} is already installed in LAIN from ${(prev.source && prev.source.kind) || 'elsewhere'}; uninstall it first to reuse the editor's copy`);
  const d = describe(pkg);
  const entry = {
    id, version: String(pkg.version || '0.0.0').slice(0, 40), dir: path.relative(root, packageDir), packageRef,
    name: String(pkg.displayName || pkg.name).slice(0, 120), publisher: String(pkg.publisher), description: String(pkg.description || '').slice(0, 300),
    source: origin, verified: { sha256: packageRef, of: 'package content' }, enabled: prev ? prev.enabled : true, installedAt: Date.now(),
    code: d.code, uses: d.uses, notUsed: d.notUsed,
  };
  reg.installed = [...reg.installed.filter((x) => x.id !== prev?.id), entry].sort((a, b) => a.id.localeCompare(b.id));
  writeRegistry(root, reg);
  return { ok: true, extension: { ...entry, scope: 'global' }, updated: Boolean(prev) };
}

function list({ configDir = null, project = null } = {}) {
  const out = [];
  for (const scope of ['global', 'workspace']) {
    const root = rootFor(scope, { configDir, project });
    if (!root) continue;
    for (const e of readRegistry(root).installed) out.push({ ...e, scope });
  }
  return out;
}

function find(id, scope, opts) {
  const root = rootFor(scope, opts);
  if (!root) return { root: null, reg: null, entry: null };
  const reg = readRegistry(root);
  return { root, reg, entry: reg.installed.find((x) => x.id === id) || null };
}

function setEnabled(id, enabled, { scope = 'global', ...opts } = {}) {
  const f = find(id, scope, opts);
  if (!f.entry) return bad(`${id} is not installed (${scope})`);
  f.entry.enabled = Boolean(enabled);
  writeRegistry(f.root, f.reg);
  return { ok: true, id, scope, enabled: f.entry.enabled };
}

function uninstall(id, { scope = 'global', ...opts } = {}) {
  const f = find(id, scope, opts);
  if (!f.entry) return bad(`${id} is not installed (${scope})`);
  // A REUSED PACKAGE lives in the content-addressed store (extpackages.js) and
  // may be the same bytes another entry uses: uninstall unregisters it; the
  // store keeps it until `extpackages.orphans({ remove: true })` is asked for.
  if (f.entry.packageRef) {
    f.reg.installed = f.reg.installed.filter((x) => x.id !== id);
    writeRegistry(f.root, f.reg);
    return { ok: true, id, scope, removed: true, packageKept: f.entry.packageRef };
  }
  const dir = path.join(f.root, f.entry.dir);
  if (path.dirname(path.resolve(dir)) !== path.resolve(f.root)) return bad('refusing to remove a folder outside the extensions store');
  fs.rmSync(dir, { recursive: true, force: true });
  f.reg.installed = f.reg.installed.filter((x) => x.id !== id);
  writeRegistry(f.root, f.reg);
  return { ok: true, id, scope, removed: true };
}

/** Open VSX installs can be updated; others are reinstalled from their file. */
async function update(id, { scope = 'global', ...opts } = {}) {
  const f = find(id, scope, opts);
  if (!f.entry) return bad(`${id} is not installed (${scope})`);
  if (!f.entry.source || f.entry.source.kind !== 'openvsx') return bad('only extensions installed from Open VSX can be updated here — install the newer .vsix instead');
  const info = await openvsxInfo(id);
  if (!info.ok) return info;
  if (info.version === f.entry.version) return { ok: true, id, current: true, version: info.version };
  return install({ openvsx: id, version: info.version }, { scope, ...opts });
}

/** Snippets from every enabled extension, by language — what the editor offers. */
function snippets(opts = {}) {
  const profile = require('./editorprofile');
  const readJsonc = require('./harnessapp/ideroutes').readJsonc;
  const out = {};
  for (const e of list(opts).filter((x) => x.enabled)) {
    const root = rootFor(e.scope, opts);
    const base = path.join(root, e.dir);
    const pkg = readPackage(base);
    if (!pkg) continue;
    for (const s of describe(pkg).snippets) {
      const abs = path.resolve(base, s.path);
      if (!abs.startsWith(path.resolve(base) + path.sep)) continue;
      const raw = readJsonc(abs);
      if (!raw || raw.unreadable) continue;
      for (const [name, def] of Object.entries(raw)) {
        const sn = profile.snippet(name, def);
        if (sn) (out[s.language] = out[s.language] || []).push({ ...sn, from: e.id });
      }
    }
  }
  return out;
}

module.exports = { install, gitSource, registerPackage, list, setEnabled, uninstall, update, search, openvsxInfo, snippets, describe, rootFor, ID_RE, OPENVSX };
