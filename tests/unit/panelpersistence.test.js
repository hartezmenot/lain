'use strict';

/**
 * A PANEL CLOSES WHEN THE READER SAYS SO — §51.
 *
 * ------------------------------------------------------------------------
 * THE REPORTED DEFECT: `/lain` and `/jobs` "disappear without user
 * interaction". They did, and nothing was wrong with either command. Neither
 * declared a `flashMs`, so both inherited the registry default of 1,500ms, and
 * a panel full of project state wiped itself off the screen a second and a half
 * after it was asked for — mid-sentence, for anyone actually reading it.
 *
 * The fix was to the DEFAULT, not to the two commands, because a per-command
 * patch leaves the next inspector somebody adds with the same bug.
 *
 * THE DISTINCTION, and it is not about which command it is:
 *
 *   A RECEIPT confirms an action the user just took. It clears itself.
 *   AN INSPECTOR is state they asked to look at. It waits to be dismissed.
 */

const assert = require('assert');
const { test } = require('../helpers');

const commands = require('../../src/commands');

/** Commands whose whole output confirms something the user just did. */
const RECEIPTS = new Set([
  '/new', '/clear', '/model', '/models', '/effort',
  '/oauth', '/undo', '/steer', '/cancel', '/stop', '/compact', '/mouse',
  // A toggle you just flipped: the confirmation is read as it is written.
  '/focus', '/fast', '/normal', '/eco', '/subagents',
]);

/**
 * Commands that LOOK like receipts and are not. `/api` and `/provider` both
 * perform actions, and both DEFAULT to a status listing — which is read exactly
 * when a route is dead, the last moment anything should vanish on a timer.
 */
const DELIBERATE_INSPECTORS = ['/api', '/provider'];

module.exports = async function () {
  await test('PANEL: an inspector stays open until it is dismissed', () => {
    // The two from the report, named explicitly so a regression names itself.
    for (const name of ['/lain', '/jobs', '/status', '/plan', '/task', '/tasks', ...DELIBERATE_INSPECTORS]) {
      const cmd = commands.REGISTRY.get(name);
      assert.ok(cmd, `${name} must be a registered command`);
      assert.strictEqual(cmd.flashMs || 0, 0,
        `${name} shows state to READ — a timer must not take it off the screen`);
    }
  });

  await test('PANEL: the DEFAULT is to stay — this is the actual fix', () => {
    // A command defined with no opinion must not inherit a self-destruct. If
    // this inverts again, every inspector added afterwards silently regresses.
    const probe = '/zzz-persistence-probe';
    commands.define(probe, { desc: 'probe', run() {} });
    try {
      assert.strictEqual(commands.REGISTRY.get(probe).flashMs, 0,
        'a command that says nothing about it must STAY');
    } finally {
      commands.REGISTRY.delete(probe);
    }
  });

  await test('PANEL: a receipt still clears itself', () => {
    // The inversion must not have made every confirmation something to dismiss
    // by hand — that trades one annoyance for another.
    for (const name of RECEIPTS) {
      const cmd = commands.REGISTRY.get(name);
      if (!cmd) continue;
      assert.ok(cmd.flashMs > 0,
        `${name} confirms an action the user just took — it should clear itself`);
    }
  });

  await test('PANEL: nothing outside the receipt list clears itself', () => {
    // The list is the policy. A command that starts flashing without being
    // argued for is the old default creeping back one file at a time.
    const unexpected = [...commands.REGISTRY.entries()]
      .filter(([name, c]) => c.flashMs > 0 && !RECEIPTS.has(name))
      .map(([name]) => name);
    assert.deepStrictEqual(unexpected, [],
      'these clear themselves but are not receipts — is each one really a confirmation?');
  });
};
