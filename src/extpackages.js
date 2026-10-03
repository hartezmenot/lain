'use strict';

/**
 * EXTENSIONS ALREADY ON THIS MACHINE, AND ONE COPY OF EACH PACKAGE.
 *
 * ------------------------------------------------------------------------
 * DISCOVER (read-only): the extensions VS Code and Cursor have installed —
 *   id, publisher, version, location, manifest, a manifest hash, and what LAIN
 *   can actually do with it (exthost/manager.js `compatibility`: FULL /
 *   PARTIAL / UNSUPPORTED, honest to the API LAIN implements). Their folders
 *   are listed and their package.json read; nothing in them is written.
 *
 * REUSE: the package is copied ONCE into a content-addressed store
 *
 *       <configDir>/packages/<sha256 of every file's path+bytes>/
 *
 *   verified against that hash, and registered with extensions.js as a
 *   global extension pointing at it. The same package from VS Code and Cursor
 *   is one directory. The original is never modified, moved or linked, so an
 *   editor updating or removing its copy cannot change what LAIN runs.
 *
 * MUTABLE STATE IS NOT IN THE PACKAGE: an extension's globalState/storage is
 *   LAIN's own (exthost `extension-storage/<id>`), so reusing VS Code's package
 *   never shares VS Code's state for it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;
const SKIP = /[\\/](node_modules[\\/]\.cache|\.git)([\\/]|$)/;

function storeDir() { return path.join(require('./config').configDir(), 'packages'); }

function readPkg(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; } }

function walk(dir, base = dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p.slice(base.length))) continue;
    if (e.isSymbolicLink()) continue;          // a link out of the package is not part of it
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

/** The package's content hash: every file's relative path and bytes, in order. */
function contentHash(dir) {
  const h = crypto.createHash('sha256');
  let bytes = 0;
  for (const f of walk(dir)) {
    const rel = path.relative(dir, f).split(path.sep).join('/');
    const buf = fs.readFileSync(f);
    bytes += buf.length;
    if (bytes > MAX_PACKAGE_BYTES) throw new Error('the package is larger than LAIN will copy');
    h.update(rel); h.update('\0'); h.update(String(buf.length)); h.update('\0'); h.update(buf);
  }
  return { sha256: h.digest('hex'), bytes };
}

function manifestHash(pkg) { return crypto.createHash('sha256').update(JSON.stringify(pkg)).digest('hex').slice(0, 16); }

/** Every extension VS Code / Cursor has installed. Nothing written. */
function discover({ env = process.env, configDir = null } = {}) {
  const vi = require('./vscodeimport');
  const mgr = require('./exthost/manager');
  let reused = [];
  try { reused = require('./extensions').list({ configDir }).filter((e) => e.packageRef); } catch { reused = []; }
  const out = [];
  for (const product of Object.keys(vi.PRODUCTS)) {
    const d = vi.dirs(product, env);
    let names = [];
    try { names = fs.readdirSync(d.extensions, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch { names = []; }
    for (const name of names) {
      const location = path.join(d.extensions, name);
      const pkg = readPkg(location);
      if (!pkg || !pkg.publisher || !pkg.name) continue;
      const id = `${pkg.publisher}.${pkg.name}`.toLowerCase();
      let scan = null;
      try { scan = require('./exthost/surface').scanExtension(location, pkg); } catch { scan = null; }
      const compat = mgr.compatibility(pkg, null, scan);
      const mine = reused.find((e) => e.id.toLowerCase() === id);
      out.push({
        product, productLabel: vi.PRODUCTS[product].label, id, publisher: String(pkg.publisher), name: String(pkg.displayName || pkg.name).slice(0, 120),
        version: String(pkg.version || '0.0.0').slice(0, 40), location, manifestHash: manifestHash(pkg),
        engines: pkg.engines && pkg.engines.vscode ? String(pkg.engines.vscode) : null,
        compatibility: { level: compat.level, rows: compat.rows.slice(0, 20) },
        reused: mine ? { version: mine.version, packageRef: mine.packageRef, sameVersion: mine.version === String(pkg.version || '') } : null,
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.product.localeCompare(b.product));
}

/** Reuse one discovered extension: copy into the store (once per content), verify, register. */
function reuse({ product, id, configDir = null, env = process.env } = {}) {
  const row = discover({ env, configDir }).find((x) => x.product === product && x.id === String(id || '').toLowerCase());
  if (!row) return { ok: false, why: 'that extension was not found in that editor' };
  if (row.compatibility.level === 'UNSUPPORTED') return { ok: false, why: 'nothing in this extension is something LAIN can use yet', compatibility: row.compatibility };
  const before = contentHash(row.location);
  const target = path.join(configDir ? path.join(configDir, 'packages') : storeDir(), before.sha256);
  let copied = false;
  if (!fs.existsSync(target)) {
    const stage = `${target}.staging-${process.pid}`;
    fs.rmSync(stage, { recursive: true, force: true });
    for (const f of walk(row.location)) {
      const rel = path.relative(row.location, f);
      fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
      fs.copyFileSync(f, path.join(stage, rel));
    }
    // THE COPY IS THE PACKAGE, OR IT IS NOT KEPT.
    const after = contentHash(stage);
    if (after.sha256 !== before.sha256) { fs.rmSync(stage, { recursive: true, force: true }); return { ok: false, why: 'the copy did not match the package (it changed while being read); nothing kept' }; }
    fs.renameSync(stage, target);
    copied = true;
  }
  const r = require('./extensions').registerPackage({ packageDir: target, packageRef: before.sha256, origin: { kind: 'reused', product: row.product, location: row.location }, configDir });
  if (!r.ok) return r;
  return { ok: true, id: row.id, version: row.version, packageRef: before.sha256, copied, bytes: before.bytes, extension: r.extension, compatibility: row.compatibility };
}

/** Store directories no registry entry refers to any more. Reported; removed only when asked. */
function orphans({ configDir = null, remove = false } = {}) {
  const dir = configDir ? path.join(configDir, 'packages') : storeDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{64}$/.test(n)); } catch { return []; }
  const used = new Set(require('./extensions').list({ configDir }).map((e) => e.packageRef).filter(Boolean));
  const gone = names.filter((n) => !used.has(n));
  if (remove) for (const n of gone) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  return gone;
}

module.exports = { discover, reuse, orphans, contentHash, storeDir };
