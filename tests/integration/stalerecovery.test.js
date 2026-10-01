'use strict';

/**
 * STALE-STEP RECOVERY, REAL PROCESS (the four-gate spec §110) — the real binary, hard-killed after a committed
 * checkpoint, restarted with `--resume`. The model is scripted; the crash, the restart and the recovery are real.
 *
 * The bug this guards (Gate 3): a long task resumed "Step 3" again and again. Plan revisions renumbered the same
 * open work, dropped rows were counted as steps, and a throttled save lost the last completion — so the resumed
 * position was older than the work. Now every plan_step_done COMMITS a checkpoint (taskcheckpoint.js) before the
 * tool returns, and a resumed task continues from that commit.
 *
 *   run 1: plan of five → steps 1–3 done (each committed) → step 4 starts a long command → TerminateProcess
 *   run 2: --resume → it continues at step 4 of 5 by itself, never step 3; steps 4–5 finish; 5/5, each step once
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli } = require('../helpers');

const STEPS = ['scaffold the parser package', 'write the lexer', 'write the recursive-descent parser', 'report syntax errors with positions', 'document the grammar'];

module.exports = async function () {
  await test('STALE RECOVERY (§110): killed after checkpoint 3, restarted — resumes AFTER the commit, at step 4 of 5, never step 3 again', async () => {
    const cwd = tmpdir('stalerec-');
    const configDir = path.join(cwd, '.config');
    const done = (n, note) => ({ name: 'plan_step_done', input: { note } });
    const write = (n) => ({ name: 'write_file', input: { path: `s${n}.txt`, content: `step ${n}` } });
    const r1 = await runCli([], {
      cwd, configDir,
      stdin: 'build the expression parser in five steps\n',
      script: [
        { text: 'Planning the work.', tool_calls: [{ name: 'plan_write', input: { steps: STEPS } }] },
        { text: 'Scaffolding.', tool_calls: [write(1), done(1, 'package scaffolded')] },
        { text: 'The lexer.', tool_calls: [write(2), done(2, 'lexer written, 12 tokens')] },
        { text: 'The parser.', tool_calls: [write(3), done(3, 'parser written, precedence climbing')] },
        { text: 'Error reporting — running the long conformance check.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 25' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 12000,          // runCli kills the child HARD (TerminateProcess) when this expires
    });
    assert.notStrictEqual(r1.code, 0, 'the process was killed, not finished');
    const dir = path.join(configDir, 'sessions');
    const file = () => path.join(dir, fs.readdirSync(dir).filter((f) => f.endsWith('.json'))[0]);
    const s1 = JSON.parse(fs.readFileSync(file(), 'utf8'));
    // THE COMMIT SURVIVED THE KILL: three steps done, the position is step 4 of 5.
    assert.ok(s1.checkpoint, 'a committed checkpoint is on disk');
    assert.strictEqual(s1.checkpoint.done, 3, `three steps committed: ${JSON.stringify(s1.checkpoint)}`);
    assert.strictEqual(s1.checkpoint.stepIndex, 4, 'the committed position is step 4');
    assert.strictEqual(s1.checkpoint.stepTotal, 5);
    assert.match(s1.checkpoint.stepText, /report syntax errors/);
    assert.ok(s1.inflight, 'the killed turn is on disk as in-flight');

    const id = s1.id;
    const r2 = await runCli(['--resume', id], {
      cwd, configDir,
      // NOTHING TYPED until the recovery has run by itself; then look at the plan and leave.
      stdinSteps: ['/plan\n', '/exit\n'],
      stepDelayMs: 9000,
      script: [
        { text: 'Resuming at error reporting.', tool_calls: [write(4), done(4, 'errors carry line and column')] },
        { text: 'Documenting the grammar.', tool_calls: [write(5), done(5, 'GRAMMAR.md written')] },
        { text: 'All five steps are done.' },
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r2.code, 0, `the resumed run exits cleanly:\n${r2.stdout.slice(-1500)}\n${r2.stderr.slice(-800)}`);
    assert.match(r2.stdout, /5\/5 done/, 'the plan finished');
    const s2 = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const raw = JSON.stringify(s2);
    // WHAT LAIN SENT AFTER THE RESTART names step 4 — the first continuation after the crash.
    const sent = (s2.messages || s2.conversation || []).filter((m) => m && m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    const resumed = sent.find((t) => /Continue the approved plan|Resume at plan step|stopped mid-turn/.test(t));
    assert.ok(resumed, `a continuation was sent after the restart: ${sent.map((t) => t.slice(0, 80)).join(' | ')}`);
    assert.match(resumed, /phase 4 — report syntax errors|step 4 of 5/, `it resumed at step 4: ${resumed.slice(0, 300)}`);
    assert.ok(!/phase 3 —|step 3 of 5/.test(resumed), 'never step 3 again');
    // EACH STEP ONCE: five steps, all done, the third step's note recorded once.
    const steps = (s2.plan && s2.plan.steps || []).filter((x) => x.status !== 'dropped');
    assert.strictEqual(steps.length, 5, `five steps, no duplicates: ${steps.map((x) => x.text).join(' / ')}`);
    assert.ok(steps.every((x) => x.status === 'done'), 'all done');
    assert.strictEqual(steps.filter((x) => /recursive-descent/.test(x.text)).length, 1, 'step 3 exists once — it was not re-added or re-run');
    assert.ok(!/Resume at plan step 3|phase 3 — write the recursive-descent/.test(raw), 'nothing after the restart asked for step 3');
    assert.strictEqual(s2.checkpoint.done, 5, 'the last commit is 5/5');
    for (const n of [1, 2, 3, 4, 5]) assert.strictEqual(fs.readFileSync(path.join(cwd, `s${n}.txt`), 'utf8'), `step ${n}`);
  });
};
