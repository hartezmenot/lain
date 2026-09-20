'use strict';

/**
 * EXECUTOR STATE IS NOT TASK STATE — Regression #3.
 *
 * ------------------------------------------------------------------------
 * THE INCIDENT. A model reached its weekly limit mid-task. The only state
 * anybody kept said the work had FAILED, so the next model was handed a dead
 * task: the objective was restated by the user, the evidence was discarded, and
 * work that was nine tenths finished began again from nothing.
 *
 * A PROVIDER LIMIT IS A FACT ABOUT A PROVIDER. Whether the account backend
 * still needs writing is a different question, and these are the assertions
 * that keep the two apart.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Task, STATE, EXECUTOR } = require('../../src/task');

/** A task mid-flight, with an executor on it. */
function working() {
  const t = new Task('implement the account backend');
  t.steer('keep the old session format working');
  t.assignExecutor({ provider: 'anthropic', model: 'opus-5' });
  return t;
}

/** What a save/restore cycle really does to it. */
const roundTrip = (t) => Task.from(JSON.parse(JSON.stringify(t.toJSON())));

module.exports = async function () {
  await test('EXECUTOR: a provider limit blocks the EXECUTOR and leaves the TASK active', () => {
    const t = working();
    t.blockExecutor('weekly limit reached');
    assert.strictEqual(t.state, STATE.ACTIVE, 'the task did not fail — a provider did');
    assert.strictEqual(t.executor.state, EXECUTOR.PROVIDER_BLOCKED);
    assert.strictEqual(t.executor.why, 'weekly limit reached', 'and the reason is kept');
    assert.ok(t.live, 'work on it is still legitimate');
    assert.ok(t.stranded, 'it simply has nobody on it this minute');
  });

  await test('EXECUTOR: switching model continues the SAME task', () => {
    const t = working();
    const id = t.id;
    t.blockExecutor('weekly limit reached');
    t.assignExecutor({ provider: 'zai', model: 'glm-4.6' });

    assert.strictEqual(t.id, id, 'the task id survives — it is the same task');
    assert.strictEqual(t.objective, 'implement the account backend', 'and so does the objective');
    assert.strictEqual(t.steers.length, 1, 'and the corrections the user made');
    assert.strictEqual(t.state, STATE.ACTIVE);
    assert.strictEqual(t.executor.model, 'glm-4.6');
    assert.strictEqual(t.executor.state, EXECUTOR.ACTIVE);
    assert.ok(!t.stranded, 'somebody is carrying it again');
  });

  await test('EXECUTOR: the switch leaves PROVENANCE, and provenance carries the reason', () => {
    const t = working();
    t.blockExecutor('weekly limit reached');
    t.assignExecutor({ provider: 'zai', model: 'glm-4.6' });
    assert.deepStrictEqual(
      t.handovers.map((h) => [h.from, h.to, h.why]),
      [['opus-5', 'glm-4.6', 'weekly limit reached']],
      'who had it, who has it, and why the first one stopped');
  });

  await test('EXECUTOR: a clean swap is RELEASED, not blocked', () => {
    // The user exercising §1.1 authority. Nothing failed, and the record must
    // not imply anything did.
    const t = working();
    t.assignExecutor({ provider: 'zai', model: 'glm-4.6' });
    assert.strictEqual(t.handovers[0].why, '', 'no reason invented for a deliberate change');
    assert.strictEqual(t.executor.state, EXECUTOR.ACTIVE);
  });

  await test('EXECUTOR: a blocked executor survives a save and restore', () => {
    // THE FAILURE MODE THIS CATCHES is the one task.js already documents: the
    // allowlist in `toJSON`. A field set correctly, read correctly and dropped
    // on save only shows up after the thing that would have revealed it is
    // gone — and a session resumed after a weekly limit that came back thinking
    // it was ACTIVE would walk straight back into the limit.
    const t = working();
    t.blockExecutor('weekly limit reached');
    const back = roundTrip(t);
    assert.strictEqual(back.id, t.id);
    assert.strictEqual(back.state, STATE.ACTIVE);
    assert.strictEqual(back.executor.state, EXECUTOR.PROVIDER_BLOCKED);
    assert.strictEqual(back.executor.why, 'weekly limit reached');
    assert.strictEqual(back.steers.length, 1);
  });

  await test('EXECUTOR: the same model returning from a block RESUMES, and adds no handover', () => {
    const t = working();
    t.blockExecutor('weekly limit reached');
    t.resumeExecutor();
    assert.strictEqual(t.executor.state, EXECUTOR.ACTIVE);
    assert.strictEqual(t.executor.why, '', 'the block is over, and the reason with it');
    assert.strictEqual(t.handovers.length, 0, 'a limit that expired did not change who is working');
  });

  await test('FOREIGN: a failure this task did not cause is recorded, never adopted', () => {
    // §43. A broad suite shows every broken thing in the repository, including
    // another task's unfinished work. That is evidence, not authorisation.
    const t = working();
    t.noteForeignFailure('tests/unit/bot-check.test.js', 'unfinished work from another task');
    t.noteForeignFailure('tests/unit/bot-check.test.js', 'seen again on the next run');
    assert.strictEqual(t.foreignFailures.length, 1, 'the same failure re-seen is not a second failure');

    // §44: TASK COMPLETE and PROJECT CLEAN are two claims, and finishing the
    // task must not require silencing somebody else's.
    t.settle(STATE.COMPLETED);
    assert.strictEqual(t.state, STATE.COMPLETED);
    assert.strictEqual(t.foreignFailures.length, 1,
      'the foreign failure survives into the record, unrepaired and unhidden');
  });

  await test('FOREIGN: the list is bounded', () => {
    const t = working();
    for (let i = 0; i < 100; i++) t.noteForeignFailure(`suite/case-${i}.test.js`);
    assert.ok(t.foreignFailures.length <= require('../../src/task').MAX_FOREIGN);
    assert.ok(t.foreignFailures.some((f) => /case-99/.test(f.what)), 'the newest are kept');
  });

  await test('COMPAT: a task saved before any of this existed comes back ACTIVE', () => {
    // A restored record with `state: undefined` would be `live === false`, and
    // the session would come back looking finished.
    const old = Task.from({ objective: 'an older task', steers: [], turnIds: [] });
    assert.strictEqual(old.state, STATE.ACTIVE);
    assert.ok(old.live);
    assert.ok(old.id, 'and it is given an id it never had');
    assert.strictEqual(old.executor, null, 'but no model is invented for work it never saw');
    assert.ok(!old.stranded, 'a task with no executor is not stranded, it is unassigned');
  });

  await test('AUTHORITY: nothing here can express ownership of a file', () => {
    // §14. There is deliberately no field in which "Opus owns src/auth" could
    // be written down — the absence is the design.
    const t = working();
    const shape = JSON.stringify(t.toJSON());
    for (const word of ['owns', 'ownedBy', 'owner', 'lockedBy', 'exclusive']) {
      assert.ok(!shape.includes(word), `a task record must not carry \`${word}\``);
    }
  });
  await test('HANDOVER: the packet names WHY the previous executor stopped', () => {
    // END TO END, and it catches a real wiring bug: the packet first read
    // `task.executor.why`, which by the time a replacement is reading it
    // belongs to the REPLACEMENT — whose `why` is empty, because nothing has
    // gone wrong for it yet. The reason lives on the handover row.
    const handover = require('../../src/handover');
    const t = working();
    t.blockExecutor('weekly limit reached');
    t.assignExecutor({ provider: 'zai', model: 'glm-4.6' });

    const packet = handover.build({
      cwd: process.cwd(), task: t,
      turns: [{ model: 'opus-5', stopReason: 'provider', steps: 9, actions: [] }],
    }, { toModel: 'glm-4.6' });

    assert.match(packet, /continuing this task from a different model \(opus-5\)/);
    assert.match(packet, /opus-5 stopped because: weekly limit reached/,
      'the incoming model must know it was a provider limit, not a dead end');
    assert.match(packet, /provenance, not ownership/i);
    assert.match(packet, /implement the account backend/, 'and the objective survives');
  });

  await test('HANDOVER: a task that never had an executor still hands over cleanly', () => {
    // Total: the packet is built for sessions whose `task` is a plain object
    // with nothing but an objective, and it must not throw on the new fields.
    const handover = require('../../src/handover');
    const packet = handover.build({
      cwd: process.cwd(), task: { objective: 'something older' },
      turns: [{ model: 'model-a', stopReason: 'provider', steps: 1, actions: [] }],
    }, { toModel: 'model-b' });
    assert.match(packet, /continuing this task from a different model/);
    assert.ok(!/stopped because:/.test(packet), 'and invents no reason it does not have');
  });
};
