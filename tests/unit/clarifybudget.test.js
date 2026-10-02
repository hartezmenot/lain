'use strict';

/**
 * P0 — ONE CLARIFICATION BUDGET, ENFORCED EVERYWHERE THE MODEL CAN SEE.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT. `ask_user` (src/tools/ask.js) is the one TOOL-mediated gate,
 * and it was already correct on its own: `clarify.js`'s budget refuses a
 * fourth question and says so in that tool's result. The gap was what
 * happened next — the refusal lived in ONE tool result, on ONE step, and
 * nothing else ever repeated it. A model that took the refusal as a
 * suggestion rather than a wall could simply write its next question as
 * plain prose instead of calling the tool again, and by the following turn —
 * or after a compaction folded that one tool result away — there was no
 * standing reminder left that the budget was spent at all.
 *
 * `clarify.directive()` closes that: while the budget stays exhausted, the
 * fact is restated in the framed context on every step, through both the
 * ordinary working-context path and the handover path (§15's "recovery" and
 * "handoff" are exactly the turns that used to lose it, because a handover
 * REPLACES the working context rather than sitting beside it).
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Clarifications } = require('../../src/clarify');
const prompt = require('../../src/prompt');

module.exports = () => require('../helpers').legacyOnly(async () => {   // LEGACY path only (Simplify S10 deletes)
  await test('BUDGET: exhausted is false until the last round is spent', () => {
    const b = new Clarifications({ maxRounds: 2 });
    assert.strictEqual(b.exhausted, false);
    b.record('a?', 'yes');
    assert.strictEqual(b.exhausted, false);
    b.record('b?', 'no');
    assert.strictEqual(b.exhausted, true);
  });

  await test('BUDGET: directive() is empty while budget remains, and explicit once spent', () => {
    const b = new Clarifications({ maxRounds: 1 });
    assert.strictEqual(b.directive(), '');
    b.record('hold or tap?', 'hold');
    const d = b.directive();
    assert.match(d, /clarification budget for this task is spent/i);
    assert.match(d, /do not ask another question/i);
    assert.match(d, /through ask_user or in your own words/i, 'closes the free-text loophole explicitly');
  });

  await test('BUDGET: the directive is restated on the ORDINARY working-context path', () => {
    const b = new Clarifications({ maxRounds: 1 });
    b.record('q?', 'a');
    const app = { _clarify: b };
    const session = { task: null, lifecycle: null, turns: [], evidence: null };
    const built = prompt.build({ cwd: '/x', platform: 'win32', model: 'm', session, app, opened: true, separate: true });
    assert.match(built.live, /clarification budget for this task is spent/i);
  });

  await test('BUDGET: the directive SURVIVES a handover turn, which used to replace working context entirely', () => {
    // A handover packet is built when the previous turn did not finish — the
    // exact kind of turn §15 names as "recovery"/"handoff". Before this fix,
    // building that packet REPLACED workingContext(), silently dropping the
    // clarify directive on precisely the turns most likely to need it
    // restated (a model switch, a resume, a retry).
    const b = new Clarifications({ maxRounds: 1 });
    b.record('q?', 'a');
    const app = { _clarify: b };
    const session = {
      task: { objective: 'diagnose the crash', handovers: [] },
      lifecycle: null,
      turns: [{ model: 'model-a', stopReason: 'max-steps', steps: 3, actions: [{ name: 'run_bash', target: 'npm test' }] }],
      evidence: null,
    };
    const built = prompt.build({ cwd: '/x', platform: 'win32', model: 'model-b', session, app, opened: false, separate: true });
    assert.match(built.live, /previous turn did NOT finish/i, 'this really is the handover branch, not working-context');
    assert.match(built.live, /clarification budget for this task is spent/i, 'and the directive rode along with it');
  });

  await test('BUDGET: with budget remaining, nothing is said about it at all', () => {
    const b = new Clarifications({ maxRounds: 3 });
    b.record('q?', 'a');
    const app = { _clarify: b };
    const session = { task: null, lifecycle: null, turns: [], evidence: null };
    const built = prompt.build({ cwd: '/x', platform: 'win32', model: 'm', session, app, opened: true, separate: true });
    assert.ok(!/clarification budget/i.test(built.live), 'silent while there is budget left, same as every other fact here');
  });

  await test('BUDGET: with no App passed at all, prompt building still succeeds (backward compatible)', () => {
    const session = { task: null, lifecycle: null, turns: [], evidence: null };
    const built = prompt.build({ cwd: '/x', platform: 'win32', model: 'm', session, opened: true, separate: true });
    assert.ok(!/clarification budget/i.test(built.live));
  });

  await test('BUDGET: ask_user itself still refuses a fourth question with the answer already in hand (regression)', async () => {
    const ask = require('../../src/tools/ask');
    const app = {};
    const first = await ask.tools.ask_user.run(
      { question: 'hold or tap?', options: ['hold', 'tap'] },
      { app, ask: async () => 'hold' },
    );
    assert.match(first.output, /The user chose: hold/);
    const clarify = require('../../src/clarify');
    // Spend the rest of the budget directly, as two more real rounds would.
    const budget = clarify.forTask(app);
    while (!budget.exhausted) budget.record(`filler ${budget.spent}`, 'x');
    const refused = await ask.tools.ask_user.run(
      { question: 'a brand new question nobody asked before' },
      { app, ask: async () => 'should not be reached' },
    );
    assert.strictEqual(refused.meta && refused.meta.clarify, 'REFUSED');
    assert.match(refused.output, /budget for this task is spent/);
  });
});
