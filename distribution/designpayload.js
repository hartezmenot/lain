'use strict';

/**
 * LAIN DESIGN IN A RELEASE — its own package, separately versioned. `stage(appDir)` puts packages/design-core into
 * <app>/design: the engine's source, its package.json and lockfile, and its three runtime dependencies (pure
 * JavaScript, exact pins, from the lockfile — nothing else). Whether it is INSTALLED is the person's choice at setup
 * (components.json `"design"`), read by Core's src/design.js; a payload carrying the files is not an install.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'packages', 'design-core');

function copyTree(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(from)) copyTree(path.join(from, f), path.join(to, f)); } else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
}

/** What the lockfile says ships: [{ name, version, dir }] for every runtime (non-dev) package. */
function runtimePackages(src = SRC) {
  const lock = JSON.parse(fs.readFileSync(path.join(src, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages || {}).filter(([k, v]) => k.startsWith('node_modules/') && !v.dev).map(([k, v]) => ({ name: k.slice('node_modules/'.length), version: v.version, dir: k }));
}

/** Stage Design into <appDir>/design. Throws when a pinned dependency is missing or at another version. */
function stage(appDir, { src = SRC } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  const dest = path.join(appDir, 'design');
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(path.join(src, 'src'), path.join(dest, 'src'));
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(src, f), path.join(dest, f));
  const shipped = [];
  for (const p of runtimePackages(src)) {
    const from = path.join(src, p.dir);
    let have = null;
    try { have = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8')).version; } catch { have = null; }
    if (have !== p.version) throw new Error(`LAIN Design needs ${p.name}@${p.version} (found ${have || 'nothing'}) — run \`npm ci --omit=dev\` in packages/design-core first`);
    copyTree(from, path.join(dest, p.dir));
    shipped.push(`${p.name}@${p.version}`);
  }
  return { dir: dest, version: pkg.version, dependencies: shipped };
}

module.exports = { stage, runtimePackages, SRC };
