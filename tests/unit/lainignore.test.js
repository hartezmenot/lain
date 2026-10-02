'use strict';

/**
 * OPENING A PROJECT PUTS NOTHING IN ITS SOURCE CONTROL (Phase 8.2).
 *
 * LAIN writes `.lain/` (its index, fingerprints, notes) into a project the
 * first time it opens it. LAIN's own repository ignores `.lain/` as machine
 * state (projectindex.test.js); a person's project had no such line, so the
 * IDE's Source Control listed files the person never made, ready to be
 * committed. A `.lain/` LAIN creates now carries a `.gitignore` of `*` — the
 * convention cache folders use — and a `.lain/` that already exists (perhaps
 * committed on purpose) is left exactly as it is.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, tmpdir } = require('../helpers');

function gitRepo(prefix) {
  const dir = tmpdir(prefix);
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = 1;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'initial');
  return { dir, git };
}

module.exports = async function () {
  let hasGit = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }

  await test('LAIN IGNORE: the .lain/ LAIN creates keeps itself out of git status — index, fingerprints, scratch alike', () => {
    if (!hasGit) { process.stdout.write('    (skipped: no git)\n'); return; }
    const { dir, git } = gitRepo('lainignore-');
    const pi = require('../../src/projectindex');
    pi.save(dir, { version: 1, files: {} });
    require('../../src/lainstore').write(dir, 'baseline', { files: {} });
    require('../../src/scratch').file(dir, 'S1', 'note.txt');
    assert.ok(fs.existsSync(path.join(dir, '.lain', 'index.json')), 'the index was written');
    assert.strictEqual(fs.readFileSync(path.join(dir, '.lain', '.gitignore'), 'utf8').trim().split('\n').pop(), '*');
    assert.strictEqual(git('status', '--porcelain').trim(), '', 'Source Control shows nothing LAIN wrote');
  });

  await test('LAIN IGNORE: a .lain/ that already exists is left as it is — no ignore file is added to it', () => {
    if (!hasGit) { process.stdout.write('    (skipped: no git)\n'); return; }
    const { dir, git } = gitRepo('lainkeep-');
    fs.mkdirSync(path.join(dir, '.lain', 'architecture'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.lain', 'architecture', 'skeleton.json'), '{}\n');
    git('add', '-A'); git('commit', '-q', '-m', 'the team commits its architecture');
    require('../../src/projectindex').save(dir, { version: 1, files: {} });
    assert.ok(!fs.existsSync(path.join(dir, '.lain', '.gitignore')), 'the person chose to commit .lain/; LAIN does not overrule that');
  });
};
