'use strict';

/**
 * THE GOAL LOOP'S CUE (autocontinue.goalCue) — explicit unfinished work continues; narration and endings do not.
 * A false positive is expensive: the continuation turn that follows a finished one has nothing to do, so it must
 * never be read as idleness (turn.js skips the hidden wake-up for `goal-continue` turns).
 */

const assert = require('assert');
const { test } = require('../helpers');
const ac = require('../../src/autocontinue');

const cue = (last, earlier = []) => ac.goalCue({ task: { objective: 'x' } }, { text: [...earlier, last].join('\n'), narration: [...earlier, last].map((t) => ({ text: t })) });

module.exports = async function () {
  await test('GOAL CUE: explicit remaining work continues', () => {
    assert.ok(cue('Moved the settings. Next I will update store.js to load it.'));
    assert.ok(cue('The tests still need updating for the new path.'));
    assert.ok(cue('Remaining: remove the inline copy in app.ts.'));
  });
  await test('GOAL CUE: narration, endings, questions and blockers do not', () => {
    assert.strictEqual(cue('Continuing with what the browser request returned.'), null, 'present-tense narration is not a plan');
    assert.strictEqual(cue('Nothing further to do.'), null);
    assert.strictEqual(cue('Fixed and verified.', ['I will look into the retry delay calculation.']), null, 'only the LAST step\'s words count');
    assert.strictEqual(cue('Should I also migrate the old config?'), null);
    assert.strictEqual(cue('I cannot proceed without the API key.'), null);
  });
  await test('GOAL CUE: a continuation turn is never forced to act by the hidden wake-up', () => {
    const src = require('fs').readFileSync(require.resolve('../../src/turn'), 'utf8');
    assert.match(src, /required: Boolean\(opts\.requiresExecution\) && record\.from !== 'goal-continue'/);
  });
};
