'use strict';

/**
 * HOW TO RUN IS CHECKED AGAINST THE MANIFEST (src/runcheck.js).
 * Live ECO run, 2026-09-19: "HOW TO RUN · npm start (if applicable)" for a
 * package.json with scripts {test, smoke} and no start.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const rc = require('../../src/runcheck');

function project(scripts, extra = {}) {
  const dir = tmpdir('runcheck-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts }));
  for (const [f, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, f), body);
  return dir;
}

module.exports = async function () {
  await test('RUNCHECK: the reported shape — npm start named, no start script — is flagged with the scripts that exist', () => {
    const dir = project({ test: 'node test/run.js', smoke: 'node scripts/smoke.js' });
    const w = rc.check('Fixed.\n\nHow to run: npm start (if applicable) or integrate as library\nHow to test: npm test', dir);
    assert.match(w, /npm start/);
    assert.match(w, /no "start" script/);
    assert.match(w, /test, smoke/);
  });

  await test('RUNCHECK: real scripts, "none (library)", built-ins, npm\'s server.js default, and no manifest all pass', () => {
    const dir = project({ test: 'x', smoke: 'y' });
    assert.strictEqual(rc.check('How to run: none (library)\nHow to test: npm test\n**How to test:** npm run smoke', dir), null);
    assert.strictEqual(rc.check('How to run: npm install && npm test', dir), null);
    assert.strictEqual(rc.check('How to run: npm start', project({}, { 'server.js': '' })), null);
    assert.strictEqual(rc.check('How to run: npm start', tmpdir('runcheck-none-')), null, 'no package.json → nothing to check against');
    assert.strictEqual(rc.check('I ran npm start earlier and it failed.', dir), null, 'only the How-to lines are checked');
    // Live subagent run, 2026-09-19: the report already said so — the warning only repeated it.
    assert.strictEqual(rc.check('How to run: npm start (not defined in package.json)', dir), null);
  });

  await test('RUNCHECK: the block form under a How-to label is read too; yarn/pnpm scripts are checked the same way', () => {
    const dir = project({ build: 'tsc' });
    assert.match(rc.check('How to run:\n```\npnpm run dev\n```', dir), /pnpm run dev/);
    assert.strictEqual(rc.check('How to run:\n```\nyarn build\n```', dir), null);
  });
};
