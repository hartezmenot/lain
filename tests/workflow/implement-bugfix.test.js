'use strict';

/**
 * WORKFLOW SMOKE — IMPLEMENTATION and BUG FIX, through the real binary (§34, §73, §75).
 *
 * The scripted provider replaces only the network call; the binary, the
 * classifier, the turn loop, the tools, the gates, the filesystem and the test
 * run are real. Evidence tier: WORKFLOW VERIFIED (never LIVE PROVIDER).
 *
 * FAILS IF: only prose; no tool call; a stale plan blocks execution; "no
 * implementation target" appears; discovery loops; verification is claimed
 * without having been run.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, runCli, tmpdir } = require('../helpers');

function project(files) {
  const dir = tmpdir('wf-');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

function lastSession(configDir) {
  const d = path.join(configDir, 'sessions');
  const files = fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => path.join(d, f));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return JSON.parse(fs.readFileSync(files[0], 'utf8'));
}

const node = (cwd, file) => spawnSync(process.execPath, [file], { cwd, encoding: 'utf8' });

module.exports = async function () {
  const BUG = {
    'package.json': JSON.stringify({ name: 'wf', scripts: { test: 'node test/retry.test.js' } }),
    'src/retry.js': 'function nextDelay(attempt) {\n  return attempt * 100;\n}\nmodule.exports = { nextDelay };\n',
    'test/retry.test.js': "const a = require('assert');\nconst { nextDelay } = require('../src/retry');\na.strictEqual(nextDelay(3), 800);\nconsole.log('1 passed, 0 failed');\n",
  };

  let bug;
  await test('WORKFLOW BUGFIX: locate → targeted read → edit → targeted test → disk verified → DONE', async () => {
    const cwd = project(BUG);
    assert.notStrictEqual(node(cwd, 'test/retry.test.js').status, 0, 'precondition: the bug reproduces');
    bug = await runCli(['-p', 'the retry delay is wrong: nextDelay(3) should be 800 — fix the bug'], {
      cwd, timeoutMs: 60000,
      script: [
        { text: '', tool_calls: [{ name: 'grep', input: { pattern: 'nextDelay' } }] },
        { text: '', tool_calls: [{ name: 'read_file', input: { path: 'src/retry.js' } }] },
        { text: 'The delay is linear; it must double per attempt.', tool_calls: [{ name: 'edit_file', input: { path: 'src/retry.js', old: 'return attempt * 100;', new: 'return 100 * 2 ** attempt;' } }] },
        { text: '', tool_calls: [{ name: 'run_tests', input: { command: 'node test/retry.test.js' } }] },
        { text: 'Fixed: nextDelay doubles per attempt. test/retry.test.js passes (1 passed).' },
      ],
    });
    assert.strictEqual(bug.code, 0, bug.out);
    assert.match(fs.readFileSync(path.join(cwd, 'src/retry.js'), 'utf8'), /100 \* 2 \*\* attempt/, 'the edit is on disk');
    assert.strictEqual(node(cwd, 'test/retry.test.js').status, 0, 'and the fixed code really passes, re-run independently');
    const s = lastSession(bug.configDir);
    const t = s.turns[s.turns.length - 1];
    assert.ok(t.toolCalls >= 4, `tools were really called: ${t.toolCalls}`);
    assert.deepStrictEqual(t.actions.map((a) => a.name), ['grep', 'read_file', 'edit_file', 'run_tests']);
    assert.strictEqual(t.stopReason, 'end');
    assert.ok(!/no implementation target/i.test(bug.out), 'never "no implementation target"');
    assert.ok(!/NON_PROGRESS/.test(JSON.stringify(s.messages)), 'no discovery loop');
    assert.ok(s.taskClassVerdict && s.taskClassVerdict.cls === 'PROJECT_IMPLEMENTATION', `classified as project work: ${JSON.stringify(s.taskClassVerdict)}`);
  });

  await test('WORKFLOW IMPLEMENTATION: a new capability is added where the project already keeps it, and verified', async () => {
    const cwd = project({
      'package.json': JSON.stringify({ name: 'wf2', scripts: { test: 'node test/format.test.js' } }),
      'src/format.js': "function money(n) { return '$' + n.toFixed(2); }\nmodule.exports = { money };\n",
      'test/format.test.js': "const a = require('assert');\nconst f = require('../src/format');\na.strictEqual(f.money(2), '$2.00');\nif (f.percent) a.strictEqual(f.percent(0.25), '25%');\nelse { console.error('percent missing'); process.exit(1); }\nconsole.log('2 passed, 0 failed');\n",
    });
    const r = await runCli(['-p', 'add a percent(x) formatter beside money()'], {
      cwd, timeoutMs: 60000,
      script: [
        { text: '', tool_calls: [{ name: 'read_file', input: { path: 'src/format.js' } }] },
        { text: '', tool_calls: [{ name: 'edit_file', input: { path: 'src/format.js', old: "module.exports = { money };", new: "function percent(x) { return Math.round(x * 100) + '%'; }\nmodule.exports = { money, percent };" } }] },
        { text: '', tool_calls: [{ name: 'run_tests', input: { command: 'node test/format.test.js' } }] },
        { text: 'Added percent() beside money(); test/format.test.js passes.' },
      ],
    });
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(node(cwd, 'test/format.test.js').status, 0);
    const t = lastSession(r.configDir).turns.slice(-1)[0];
    assert.ok(t.mutations.some((m) => /format\.js$/.test(m)));
  });

  await test('WORKFLOW WAKEUP: a provider that answers the bug fix with prose is woken ONCE, hidden, and the same turn acts', async () => {
    const cwd = project(BUG);
    const r = await runCli(['-p', 'the retry delay is wrong: nextDelay(3) should be 800 — fix the bug'], {
      cwd, timeoutMs: 60000,
      script: [
        { text: 'I will look into the retry delay calculation.' },
        { text: '', tool_calls: [{ name: 'edit_file', input: { path: 'src/retry.js', old: 'return attempt * 100;', new: 'return 100 * 2 ** attempt;' } }] },
        { text: '', tool_calls: [{ name: 'run_tests', input: { command: 'node test/retry.test.js' } }] },
        { text: 'Fixed and verified.' },
      ],
    });
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(node(cwd, 'test/retry.test.js').status, 0, 'the woken turn really fixed it');
    const s = lastSession(r.configDir);
    assert.strictEqual(s.turns.length, 1, 'no new user turn was created');
    assert.strictEqual(s.turns[0].wakeups, 1);
    assert.ok(!s.messages.some((m) => m.role === 'user' && /still pending/.test(String(m.content))), 'never impersonates the user');
    assert.ok(!/still pending|wake/i.test(r.out), 'nothing about it is shown');
  });
};
