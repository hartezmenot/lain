'use strict';

/**
 * `lain -p` WAITS FOR THE BACKGROUND WORK IT STARTED (S12): the job's result is printed before the process exits.
 * `--no-wait` keeps the old behaviour: the turn ends, and so does the process.
 */

const assert = require('assert');
const { test, runCli, tmpdir } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const script = [
  { text: 'starting it in the background', tool_calls: [{ name: 'shell', input: { command: 'sleep 1 && echo bg-finished-marker', background: true, shell: 'bash' } }] },
  { text: 'started; its result rejoins the session' },
];

module.exports = async function () {
  if (process.platform === 'win32') return;   // the job is a bash one-liner; the waiting itself is platform-neutral
  await test('-p: waits for the job this run started, prints its result, then exits', async () => {
    const r = await runCli(['-p', 'run the slow thing in the background', '--cwd', tmpdir('pw-')], { script, timeoutMs: 60000 });
    const out = plain(r.out);
    assert.strictEqual(r.code, 0, out);
    assert.match(out, /waiting for 1 background job started in this run/);
    assert.match(out, /^job #j?\d+ · SUCCEEDED · exit 0 · sleep 1/m);
    assert.match(out, /^  bg-finished-marker$/m, 'the job\'s own output is printed');
  });

  await test('-p --no-wait: the old behaviour — nothing is waited for and no job result is printed', async () => {
    const r = await runCli(['-p', 'run the slow thing in the background', '--no-wait', '--cwd', tmpdir('pw-')], { script, timeoutMs: 60000 });
    const out = plain(r.out);
    assert.strictEqual(r.code, 0, out);
    assert.ok(!/waiting for/.test(out) && !/^  bg-finished-marker$/m.test(out) && !/^job #/m.test(out), out);
  });
};
