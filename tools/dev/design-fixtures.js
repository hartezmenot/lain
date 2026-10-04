'use strict';

/**
 * INSTALL THE LAIN DESIGN FIXTURES' DEPENDENCIES (D9) — node_modules are never committed.
 *
 *   node tools/dev/design-fixtures.js            install what is missing (and the engine's own deps)
 *   node tools/dev/design-fixtures.js --force    reinstall every fixture
 *   node tools/dev/design-fixtures.js --list     say which are installed
 *
 * Each fixture under tests/fixtures/design/<name> with dependencies gets `npm install` from its own package.json
 * (a package-lock.json is written beside it the first time and kept). Tests that need a fixture skip with a clear
 * message when it is not installed; LAIN_DESIGN_REQUIRE_FIXTURES=1 turns that skip into a failure (CI).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'design');

function needsDeps(dir) {
  try { const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); return Boolean(Object.keys({ ...(p.dependencies || {}), ...(p.devDependencies || {}) }).length); } catch { return false; }
}

/** Fixtures that need an install, and whether each has one. */
function fixtures() {
  return fs.readdirSync(FIX, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(FIX, d.name)).filter(needsDeps)
    .map((dir) => ({ name: path.basename(dir), dir, installed: fs.existsSync(path.join(dir, 'node_modules', '.package-lock.json')) }));
}

function installed(name) { const f = fixtures().find((x) => x.name === name); return f ? f.installed : true; }

function main(argv) {
  const force = argv.includes('--force');
  if (argv.includes('--list')) { for (const f of fixtures()) process.stdout.write(`${f.installed ? 'installed ' : 'MISSING   '} ${f.name}\n`); return 0; }
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ASTRO_TELEMETRY_DISABLED: '1', npm_config_fund: 'false', npm_config_audit: 'false' };
  const engine = path.join(ROOT, 'packages', 'design-core');
  if (force || !fs.existsSync(path.join(engine, 'node_modules', '.package-lock.json'))) {
    process.stdout.write('design-core: npm ci --omit=dev\n');
    execSync('npm ci --omit=dev', { cwd: engine, stdio: 'inherit', env });
  }
  let bad = 0;
  for (const f of fixtures()) {
    if (f.installed && !force) { process.stdout.write(`${f.name}: installed\n`); continue; }
    process.stdout.write(`${f.name}: npm install\n`);
    try { execSync(fs.existsSync(path.join(f.dir, 'package-lock.json')) ? 'npm ci' : 'npm install', { cwd: f.dir, stdio: 'inherit', env }); } catch (e) { bad += 1; process.stdout.write(`${f.name}: FAILED (${e.message.split('\n')[0]})\n`); }
  }
  return bad ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { fixtures, installed, FIX };
