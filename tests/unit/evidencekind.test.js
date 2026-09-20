'use strict';

/**
 * §16/§17 — A COMPOUND COMMAND'S TRAILING ECHO IS NOT VERIFICATION.
 *
 * ------------------------------------------------------------------------
 * THE REGRESSION, VERBATIM FROM A STALE HANDOFF:
 *
 *     where lua luau lune lua5.1 2>nul & echo DONE — passed
 *
 * `&` is cmd.exe's UNCONDITIONAL sequencing operator — unlike `&&`, the
 * chain's reported exit code is whichever the LAST segment returns, no
 * matter what happened before it. `echo` always exits 0, so this chain
 * reports exit 0 whether or not `where` found any of those interpreters.
 * The shell tool telling the truth about that exit code is CORRECT — the
 * defect is any downstream narration that reads "exit 0" as "lua is
 * installed" or "the check passed".
 *
 * This file pins two things: the classifier's own behaviour in isolation,
 * and that a `Lifecycle` fed exactly this command end-to-end never lets it
 * reach TEST_PASSED/REQUIREMENT_VERIFIED/PASSED anywhere a person or a model
 * would read it back.
 */

const assert = require('assert');
const { test } = require('../helpers');

const evidencekind = require('../../src/evidencekind');
const { Lifecycle } = require('../../src/lifecycle');

const MASKED_CMD = 'where lua luau lune lua5.1 2>nul & echo DONE';

module.exports = async function () {
  // ---- THE CLASSIFIER ITSELF ---------------------------------------------

  await test('EVIDENCE: a `&`-masked compound command is INCONCLUSIVE, never PASS, regardless of its real exit code', () => {
    const v = evidencekind.classifyCommand({ command: MASKED_CMD, exitCode: 0, isError: false });
    assert.strictEqual(v.kind, evidencekind.KIND.INCONCLUSIVE);
    assert.strictEqual(v.ok, null, 'never true, never false — the exit code proves nothing about the check');
    assert.strictEqual(v.masked, true);
    assert.match(v.note, /echo DONE/);
  });

  await test('EVIDENCE: `&&` (conditional) is NOT flagged — its own status already depends on what ran before it', () => {
    const v = evidencekind.classifyCommand({ command: 'npm test && echo DONE', exitCode: 0, isError: false });
    assert.strictEqual(v.masked, false);
    assert.strictEqual(v.kind, evidencekind.KIND.COMMAND_EXIT_STATUS);
    assert.strictEqual(v.ok, true);
  });

  await test('EVIDENCE: a single command is never flagged as masking', () => {
    assert.strictEqual(evidencekind.masksEarlierFailure('npm test'), false);
    assert.strictEqual(evidencekind.masksEarlierFailure('echo DONE'), false);
  });

  await test('EVIDENCE: two prints joined unconditionally is not masking anything — there is no check to mask', () => {
    assert.strictEqual(evidencekind.masksEarlierFailure('echo a & echo b'), false);
  });

  await test('EVIDENCE: POSIX `;` sequencing is caught the same way as cmd.exe `&`', () => {
    const v = evidencekind.classifyCommand({ command: 'grep -q NEEDLE file.txt; echo DONE', exitCode: 0, isError: false });
    assert.strictEqual(v.masked, true);
    assert.strictEqual(v.ok, null);
  });

  await test('EVIDENCE: a no-match search is neither PASS nor FAIL', () => {
    const v = evidencekind.classifyCommand({ command: 'grep foo file.txt', exitCode: 1, isError: false, noMatch: true });
    assert.strictEqual(v.kind, evidencekind.KIND.SEARCH_NO_MATCH);
    assert.strictEqual(v.ok, null);
  });

  await test('EVIDENCE: a search that found something is SEARCH_MATCH_FOUND, and that IS a pass', () => {
    const v = evidencekind.classifyCommand({ command: 'grep foo file.txt', exitCode: 0, isError: false, searchLike: true });
    assert.strictEqual(v.kind, evidencekind.KIND.SEARCH_MATCH_FOUND);
    assert.strictEqual(v.ok, true);
  });

  await test('EVIDENCE: an ordinary failing command is still COMMAND_EXIT_STATUS / ok:false — nothing here weakens a real failure', () => {
    const v = evidencekind.classifyCommand({ command: 'npm test', exitCode: 1, isError: true });
    assert.strictEqual(v.kind, evidencekind.KIND.COMMAND_EXIT_STATUS);
    assert.strictEqual(v.ok, false);
  });

  // ---- END TO END THROUGH Lifecycle --------------------------------------

  await test('EVIDENCE: Lifecycle.observeTool never records ok:true for the masked regression command', () => {
    const life = new Lifecycle('check for a lua interpreter');
    life.observeTool({
      name: 'run_cmd',
      input: { command: MASKED_CMD },
      output: 'DONE',
      isError: false,
      exitCode: 0,
    });
    assert.strictEqual(life.lastCommand.ok, null);
    assert.strictEqual(life.lastCommand.kind, evidencekind.KIND.INCONCLUSIVE);
  });

  await test('EVIDENCE: a masked command never increments verifiedChecks, even after a file changed', () => {
    const life = new Lifecycle('check for a lua interpreter');
    life.observeTool({ name: 'write_file', input: {}, output: '', mutated: ['a.txt'] });
    const before = life.evidence.verifiedChecks;
    life.observeTool({ name: 'run_cmd', input: { command: MASKED_CMD }, output: 'DONE', isError: false, exitCode: 0 });
    assert.strictEqual(life.evidence.verifiedChecks, before, 'a masked result must not count as a verification');
  });

  await test('EVIDENCE: complete() refuses to finish on a masked last command, and says why honestly', () => {
    const life = new Lifecycle('check for a lua interpreter');
    life.observeTool({ name: 'write_file', input: {}, output: '', mutated: ['a.txt'] });
    life.observeTool({ name: 'run_cmd', input: { command: MASKED_CMD }, output: 'DONE', isError: false, exitCode: 0 });
    const r = life.complete({});
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /does not verify this/);
    assert.ok(!/failed/i.test(r.why), 'must not call an inconclusive result a failure — it is neither');
  });

  await test('EVIDENCE: contradiction() flags a success claim resting on a masked check, without calling it "failing"', () => {
    const life = new Lifecycle('check for a lua interpreter');
    life.observeTool({ name: 'run_cmd', input: { command: MASKED_CMD }, output: 'DONE', isError: false, exitCode: 0 });
    const msg = life.contradiction('All done — lua is installed and everything works.');
    assert.ok(msg, 'a claim of success resting on an inconclusive check must be contradicted');
    assert.match(msg, /does not verify/);
    assert.ok(!/still failing/i.test(msg));
  });

  await test('EVIDENCE: handover.js narrates the masked command as INCONCLUSIVE, never PASSED', () => {
    const handover = require('../../src/handover');
    const life = new Lifecycle('check for a lua interpreter');
    life.observeTool({ name: 'run_cmd', input: { command: MASKED_CMD }, output: 'DONE', isError: false, exitCode: 0 });
    const session = { task: { objective: 'check for a lua interpreter', handovers: [] }, lifecycle: life, plan: null };
    const text = handover.build ? handover.build(session, { model: 'm', stopReason: 'max-steps' }) : null;
    if (text) {
      assert.ok(!/DONE.*PASSED|PASSED.*DONE/i.test(text), 'must never read as the DONE echo having passed anything');
      assert.match(text, /INCONCLUSIVE/);
    }
  });
};
