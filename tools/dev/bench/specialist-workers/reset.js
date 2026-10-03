'use strict';

/**
 * RESET — a fresh, byte-verified working copy of the fixture.
 *
 *   node bench/specialist-workers/reset.js <dest>
 *
 * Copies fixture/ to <dest> (which must not exist), proves every file is
 * byte-identical, links node_modules to the bench's installed deps (.deps,
 * `npm install` there once), and commits the copy to a new git repository so
 * a run's changes are exactly `git diff` afterwards. Every run of every arm
 * starts from this, never from a previous run's directory.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const FIXTURE = path.join(__dirname, 'fixture');
const DEPS = path.join(__dirname, '.deps', 'app', 'node_modules');

function sha(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

function files(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...files(root, r)); else out.push(r);
  }
  return out;
}

function reset(dest) {
  dest = path.resolve(dest);
  if (fs.existsSync(dest)) throw new Error(`refusing to reuse ${dest}: every run gets a fresh directory`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  dest = path.join(fs.realpathSync.native(path.dirname(dest)), path.basename(dest));
  fs.cpSync(FIXTURE, dest, { recursive: true });
  const list = files(FIXTURE);
  const mismatches = list.filter((r) => !fs.existsSync(path.join(dest, r)) || sha(path.join(FIXTURE, r)) !== sha(path.join(dest, r)));
  if (!fs.existsSync(DEPS)) throw new Error(`bench deps missing: run npm install in ${path.dirname(DEPS)}`);
  // A REAL COPY, not a link: Vite refuses to serve files outside its root, and
  // a model inspecting the project should see an ordinary install.
  fs.cpSync(DEPS, path.join(dest, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.gitignore'), 'node_modules\n.lain/\n');
  const git = (...a) => execFileSync('git', a, { cwd: dest, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-q', '-m', 'fixture');
  return { dest, files: list.length, ok: mismatches.length === 0, mismatches, fixtureHash: crypto.createHash('sha256').update(list.sort().map((r) => `${r}:${sha(path.join(FIXTURE, r))}`).join('\n')).digest('hex').slice(0, 16) };
}

module.exports = { reset, FIXTURE };

if (require.main === module) {
  const r = reset(path.resolve(process.argv[2]));
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
