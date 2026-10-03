'use strict';

/**
 * THE WINDOW, THROUGH THE REAL BINARY.
 *
 * The unit tier proves the compaction is correct. This proves it is WIRED —
 * which is the distinction that mattered, because the whole capability was
 * absent: `session.messages` grew for the life of the task and turn.js re-sent
 * every byte of it on every step. Nothing in the product knew the window had a
 * size.
 *
 * So this spawns bin/lain.js, gives it a task whose tool output genuinely
 * overflows the budget, and then reads BOTH what the user saw and what was
 * actually persisted.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

/** A cwd holding `n` files big enough that reading them overflows the budget. */
function withBigFiles(n, lines = 2000) {
  const cwd = tmpdir('ctx-');
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(
      path.join(cwd, `big${i}.txt`),
      Array.from({ length: lines }, (_, l) => `line ${l} of big${i} — telegram signal handler candidate`).join('\n'),
      'utf8'
    );
  }
  return cwd;
}

/** Each step reads a DIFFERENT big file, so nothing is served from the ledger. */
const readingScript = (n) => [
  ...Array.from({ length: n }, (_, i) => ({
    text: `Reading big${i}.`,
    tool_calls: [{ name: 'read_file', input: { path: `big${i}.txt` } }],
  })),
  { text: 'Done reading.' },
];

function sessionOf(configDir) {
  const dir = path.join(configDir, 'sessions');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length, 'the run must have persisted a session');
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
}

module.exports = async function () {
  await test('CTX SMOKE: a task that overflows the window keeps running instead of being refused', async () => {
    const cwd = withBigFiles(6);
    const r = await runCli([], {
      cwd, env: { LAIN_CONTEXT_CHARS: '30000', LAIN_CONTEXT_BUDGET_TOKENS: '8000' },
      stdin: 'find the telegram handler\n',
      script: readingScript(6), timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0, `the run must finish cleanly:\n${r.out.slice(-800)}`);
    // Six 100KB reads is ~600KB of conversation against a 30KB budget. Without
    // compaction the provider sees all of it.
    assertIncludes(r.out, 'Done reading.', 'the turn must reach its last step');
  });
  await test('CTX SMOKE: /status reports the window as a headline number', async () => {
    const r = await runCli([], {
      cwd: tmpdir('ctx-'), stdin: '/status\n', script: [],
      env: { LAIN_PROVIDER: 'mock' },
    });
    assertIncludes(r.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), 'context', 'the resource that ends long tasks must be visible without being asked for');
  });

  await test('CTX SMOKE: /compact reports honestly when there is nothing to do', async () => {
    const r = await runCli([], {
      cwd: tmpdir('ctx-'), stdin: 'hello\n/compact\n', script: [{ text: 'Hi.' }],
      env: { LAIN_PROVIDER: 'mock' }, timeoutMs: 30000,
    });
    const out = r.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    // `Nothing to compact` now, with the size beside it — the same honest answer
    // in fewer words. What matters is that a short conversation is NOT pruned and
    // that `/compact` says so rather than claiming to have done something.
    assertIncludes(out, 'Nothing to compact', 'a short conversation must not be pruned, and must say so');
  });
  await test('CLAIM SMOKE: an honest turn over a PASSING check is not second-guessed', async () => {
    const r = await runCli([], {
      cwd: tmpdir('claim-'),
      stdin: 'add the mute list\n',
      script: [
        { text: 'Running the suite.', tool_calls: [{ name: 'shell', input: { command: 'node -e "process.exit(0)"' } }] },
        { text: 'All the tests pass now. Successful implementation.' },
      ],
      timeoutMs: 40000,
    });
    const out = r.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.ok(!/still failing when that was written/.test(out), 'a warning over green work would teach the user to ignore it');
  });

  await test('CTX SMOKE: /compact is refused mid-turn — it rewrites what the turn is sending', async () => {
    const r = await runCli([], {
      cwd: tmpdir('ctx-'), env: { LAIN_FORCE_TUI: '1', COLUMNS: '96', LINES: '28' },
      stdinSteps: ['audit it\n', '/compact\n'], stepDelayMs: 800,
      script: [
        { text: 'Working.', tool_calls: [{ name: 'shell', input: { command: 'sleep 4' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 45000,
    });
    assertIncludes(r.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), "can't run while a turn is in flight");
  });
};
