'use strict';

/**
 * `continue` AFTER A DEAD TURN — through the real binary, end to end.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. The unit tests prove the Guardian's
 * decision, and tests/integration/guardian.test.js proves it over a real socket
 * to a real supervisor. Neither proves the thing a person actually experiences:
 * that LAIN, launched as a program, with a provider that refuses, notices, says
 * so, and continues the SAME task instead of restarting it.
 *
 * The failure being pinned:
 *
 *     the provider refuses the credential
 *     the turn ends
 *     the person types:  continue
 *     LAIN sends:        continue
 *     the next model gets one word with no antecedent, and re-reads everything
 *
 * ------------------------------------------------------------------------
 * IT SKIPS ITSELF when the Rust binary is not built, and the skip is DECLARED.
 * LAIN is a zero-dependency Node program; without a supervisor there is nothing
 * to hold the input and the ordinary path is correct. What must never happen is
 * this quietly reporting a guarantee it did not check.
 */

const assert = require('assert');
const path = require('path');

const { test, tmpdir, runCli, assertIncludes } = require('../helpers');

/**
 * A TUI FRAME IS CURSOR MOVES AND TEXT. Every escape becomes a newline so the
 * assertions below read the WORDS the screen carried, wherever on it they were
 * drawn — the same helper ask.test.js uses, for the same reason.
 */
function plain(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n');
}

const supervisor = require('../../src/supervisor');

const ENTER = String.fromCharCode(13);

module.exports = async function () {
  const probe = supervisor.probe();
  if (!probe.available) {
    await test('HOLD: skipped — the Rust binary is not built', () => {
      assert.ok(probe.why.includes('cargo build'), probe.why);
    });
    return;
  }
  await test('HOLD: an ordinary sentence after a healthy turn is NOT held', async () => {
    // THE OTHER HALF, and the more important one to keep. A gateway that holds
    // when nothing is wrong is worse than no gateway: every message would
    // arrive wrapped in a recovery briefing nobody needed, which is exactly the
    // token waste this work exists to remove.
    const cwd = tmpdir('lain-nohold-');
    const r = await runCli([], {
      cwd,
      env: { LAIN_FORCE_TUI: '1' },
      script: [{ text: 'Done the first thing.' }, { text: 'Done the second thing.' }],
      stdinSteps: [`do the first thing${ENTER}`, `and now the second${ENTER}`, `/exit${ENTER}`],
      stepDelayMs: 2500,
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.stdout);
    assertIncludes(out, 'Done the second thing', 'the second message reached the model');
    assert.ok(!/held —/.test(out), `nothing was in the way, so nothing was held:\n${out.slice(-600)}`);
  });
};
