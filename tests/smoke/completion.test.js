'use strict';

/**
 * THE COMPLETION GATE, THROUGH THE REAL BINARY.
 *
 * The unit tests assert the rules. These assert that the rules are WIRED —
 * which is the distinction that mattered here, because the completion screen
 * and its evidence check were fully implemented, fully unit-tested, and
 * unreachable on every real task for want of any way for the model to write a
 * plan. A green unit tier said nothing about that.
 *
 * So each case drives bin/lain.js as a child process with a scripted model and
 * a real filesystem and shell, and asserts on what a user would actually see.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes, assertNotIncludes } = require('../helpers');

/** A project whose one test passes or fails on demand. */
function project({ passing }) {
  const dir = tmpdir('lain-complete-');
  fs.writeFileSync(path.join(dir, 'target.txt'), 'original\n');
  fs.writeFileSync(
    path.join(dir, 'check.js'),
    passing ? 'process.exit(0);\n' : 'console.log("1 test failed");\nprocess.exit(1);\n'
  );
  return dir;
}

/** Plan → edit → run the check → tick every step. The shape of a real task. */
function script(cwd) {
  return [
    { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { steps: ['change the file', 'verify it'] } }] },
    { text: 'Reading the target first.', tool_calls: [{ name: 'read_file', input: { path: 'target.txt' } }] },
    { text: 'Editing.', tool_calls: [{ name: 'write_file', input: { path: 'target.txt', content: 'changed\n' } }] },
    { text: 'Done with step 1.', tool_calls: [{ name: 'plan_step_done', input: { note: 'wrote target.txt' } }] },
    { text: 'Verifying.', tool_calls: [{ name: 'run_bash', input: { command: 'node check.js' } }] },
    { text: 'Done with step 2.', tool_calls: [{ name: 'plan_step_done', input: { note: 'ran the check' } }] },
    { text: 'Finished.' },
  ];
}

module.exports = async function () {
  await test('COMPLETE: search tools are registered and run through the real binary', async () => {
    const cwd = tmpdir('lain-search-cli-');
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'const needle = 1;\n');
    const r = await runCli([], {
      cwd, stdin: 'find it\n', env: { LAIN_PROVIDER: 'mock' },
      script: [
        { text: 'Searching.', tool_calls: [{ name: 'grep', input: { pattern: 'needle' } }] },
        { text: 'Listing.', tool_calls: [{ name: 'glob', input: { pattern: '**/*.js' } }] },
        { text: 'Found it.' },
      ],
    });
    assertIncludes(r.out, 'src/a.js:1:', 'grep must return file and line through the real dispatch path');
    assertIncludes(r.out, 'src/a.js', 'glob must return project-relative paths');
  });
};
