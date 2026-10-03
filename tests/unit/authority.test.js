'use strict';

/**
 * THE AUTHORITY CHAIN — goal → task → plan → work order.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THESE EXIST FOR was found by audit, not by a failure, which is why
 * it had survived. Every consumer that needed to know "what is this work FOR"
 * reached into the session and picked its own fields, and the lists disagreed:
 * `jobrunner.forkSession` named `task` and `mode` and NOT `goal`, so every
 * background job — `/bg`, a Bot `/bg`, a Harness-app job — ran without the
 * user's standing direction and nothing reported it.
 *
 * Meanwhile `plan_write` took the MODEL's objective in preference to the task's,
 * so this could coexist with nothing noticing:
 *
 *     GOAL   stabilise provider continuation
 *     TASK   repair handover
 *     PLAN   redesign frontend
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

const authority = require('../../src/authority');
const goalMod = require('../../src/goal');
const { Task, EXECUTOR } = require('../../src/task');
const { Plan } = require('../../src/plan');
const { App } = require('../../src/app');

/** A session with the whole chain populated, as a real one would be. */
function chained() {
  const s = {};
  goalMod.set(s, 'stabilise provider continuation');
  s.task = new Task('repair handover');
  s.task.assignExecutor({ provider: 'anthropic', model: 'opus-5' });
  s.plan = new Plan('repair handover');
  s.plan.addSteps(['read the packet builder', 'add the authority sentence', 'test it']);
  return s;
}

/** An App with no terminal. Everything that decides behaviour is real. */
function app(cwd) {
  const a = new App({ interactive: false, cwd });
  a.render.write = () => {};
  a.render.notice = () => {};
  a.render.turnSummary = () => {};
  a.render.nl = () => {};
  a.session.save = () => {};
  return a;
}

module.exports = async function () {
  // ---------------------------------------------------------- projection ----

  await test('CHAIN: one call answers what the work is for, at every rung', () => {
    const c = authority.project(chained(), { request: 'also fix the timer' });
    assert.strictEqual(c.goal.text, 'stabilise provider continuation');
    assert.strictEqual(c.task.objective, 'repair handover');
    assert.strictEqual(c.plan.current, 'read the packet builder');
    assert.strictEqual(c.executor.model, 'opus-5');
    assert.strictEqual(c.executor.epoch, 1, 'the first executor is epoch one');
    assert.ok(c.goal.id, 'the goal has a stable identity');
    assert.ok(c.task.id, 'and so does the task');
  });

  await test('CHAIN: it is a PROJECTION — nothing here is a second store', () => {
    // The rule the module lives or dies by. If the projection held state, it
    // would be a fifth answer to the question it exists to give one answer to.
    const s = chained();
    const before = authority.project(s);
    goalMod.set(s, 'ship the installer');
    const after = authority.project(s);
    assert.notStrictEqual(before.goal.text, after.goal.text,
      'a projection re-reads its sources; it does not remember them');
    assert.strictEqual(after.goal.text, 'ship the installer');
  });

  await test('CHAIN: a null session projects nulls rather than throwing', () => {
    // Consulted from prompt building, from a fork and from a handover. None of
    // those may fail over an absent rung.
    const c = authority.project(null);
    assert.strictEqual(c.goal, null);
    assert.strictEqual(c.task, null);
    assert.strictEqual(c.plan, null);
    assert.strictEqual(c.executor, null);
    assert.strictEqual(c.scopeRevision, 0);
  });

  await test('CHAIN: the plan rung carries no objective at all', () => {
    // Two objective-shaped strings in one projection is a choice no consumer
    // should be asked to make. See plan.js on why the field still exists.
    const c = authority.project(chained());
    assert.ok(!('objective' in c.plan), 'the plan rung states strategy, never authority');
  });

  await test('CHAIN: a steer raises the scope revision', () => {
    // A work order issued before a steer was issued against a different scope
    // than one issued after, and without a revision the two are identical.
    const s = chained();
    assert.strictEqual(authority.project(s).scopeRevision, 0);
    s.task.steer('keep the old format working');
    assert.strictEqual(authority.project(s).scopeRevision, 1);
  });

  // ------------------------------------------------- 14.A goal survives /bg --

  await test('14.A: a /bg fork inherits the GOAL — the reported defect', async () => {
    const a = app(tmpdir('authority-bg-'));
    goalMod.set(a.session, 'authority foundation');
    a.session.task = new Task('fix continuation');

    const fork = require('../../src/jobrunner').forkSession(a);

    assert.ok(fork.goal, 'the fork must have a goal at all — it used to have none');
    assert.strictEqual(goalMod.text(fork), 'authority foundation');
    assert.strictEqual(goalMod.id(fork), goalMod.id(a.session),
      'the SAME goal identity, so a work order is traceable to the direction it served');
  });

  await test('14.A: the fork gets a real Task, not a spread of one', () => {
    // `{ ...task }` produced a plain object with no methods, so a forked
    // session's task could not be asked whether it was live and could not record
    // a provider block. Worse, it shared the parent's ARRAYS by reference.
    const a = app(tmpdir('authority-fork-'));
    goalMod.set(a.session, 'authority foundation');
    a.session.task = new Task('fix continuation');
    a.session.task.assignExecutor({ provider: 'anthropic', model: 'opus-5' });

    const fork = require('../../src/jobrunner').forkSession(a);

    assert.strictEqual(typeof fork.task.blockExecutor, 'function', 'it must be a real Task');
    assert.strictEqual(fork.task.live, true);
    assert.strictEqual(fork.task.id, a.session.task.id, 'the same task identity');

    // THE ARRAYS MUST NOT BE SHARED. A steer in the fork appearing in the
    // conversation's own task is a corruption, not a style point.
    assert.notStrictEqual(fork.task.steers, a.session.task.steers);
    fork.task.steer('something the worker was told');
    assert.strictEqual(a.session.task.steers.length, 0,
      'the parent conversation must not acquire the fork\'s steers');

    // And a block in the fork is the fork's own business.
    fork.task.blockExecutor('the worker was limited');
    assert.strictEqual(a.session.task.executor.state, EXECUTOR.ACTIVE);
  });

  await test('14.A: the fork does NOT inherit the parent\'s plan or lifecycle', () => {
    // A worker is given its assignment through its work order, not by being
    // handed somebody else's strategy.
    const a = app(tmpdir('authority-noplan-'));
    goalMod.set(a.session, 'authority foundation');
    a.session.task = new Task('fix continuation');
    a.session.plan = new Plan('fix continuation');
    a.session.plan.addSteps(['a', 'b']);

    const fork = require('../../src/jobrunner').forkSession(a);
    assert.strictEqual(fork.plan, null, 'the plan belongs to the conversation that owns it');
  });

  await test('14.A: a background job is issued exactly one work order, hung from the chain', () => {
    const a = app(tmpdir('authority-wo-'));
    goalMod.set(a.session, 'authority foundation');
    a.session.task = new Task('fix continuation');

    const w = authority.issue(a.session, { id: '7', objective: 'inspect the README too' });
    assert.strictEqual(w.id, '7', 'the order\'s id is the job number, not a second handle');
    assert.strictEqual(w.goalId, goalMod.id(a.session));
    assert.strictEqual(w.taskId, a.session.task.id);
    assert.strictEqual(w.objectiveProjection, 'inspect the README too');
    assert.strictEqual(w.state, authority.WO_STATE.ISSUED);
  });

  await test('14.A: the worker\'s brief names all four rungs and stays a briefing', () => {
    const s = chained();
    s.task.steer('keep the old format working');
    const w = authority.issue(s, { id: '3', objective: 'fix expired-session refresh' });
    const text = authority.brief(authority.project(s, { workOrder: w }));

    assert.match(text, /^GOAL/m);
    assert.match(text, /^TASK/m);
    assert.match(text, /^PLAN/m);
    assert.match(text, /^WORK ORDER 3/m);
    assert.match(text, /keep the old format working/, 'the user\'s later words come too');
    assert.ok(text.length < 1200, `the brief grew to ${text.length} chars — it rides every request`);
  });

  // ------------------------------------------- 14.B plan contradiction ------

  await test('14.B: a plan objective that contradicts the task is reported', () => {
    const s = {};
    goalMod.set(s, 'stabilise handover');
    s.task = new Task('fix continuation');

    const clash = authority.contradictions(s, { planObjective: 'redesign frontend' });
    assert.strictEqual(clash.length, 1, 'the brief\'s own example must be caught');
    assert.strictEqual(clash[0].rung, 'plan');
    assert.strictEqual(clash[0].contradicts, 'task');
    assert.strictEqual(clash[0].authority, 'fix continuation');
  });

  await test('14.B: a legitimate restatement is NOT flagged', () => {
    // Flagging mere difference would flag everything and be ignored within a
    // day. Only a label sharing NO content with the rung above it is a clash.
    const s = {};
    goalMod.set(s, 'stabilise handover');
    s.task = new Task('fix continuation');
    for (const label of [
      'fix continuation',
      'repair the continuation path',
      'stabilise handover',          // restates the GOAL, which is legitimate
      'fix continuation in handover',
    ]) {
      assert.deepStrictEqual(authority.contradictions(s, { planObjective: label }), [],
        `"${label}" is a narrowing, not a contradiction`);
    }
  });
  await test('14.B: a compatible label from the model IS kept', () => {
    // The guard must not become "the model may never label a plan".
    const s = {};
    goalMod.set(s, 'stabilise handover');
    s.task = new Task('fix continuation');
    assert.deepStrictEqual(authority.contradictions(s, { planObjective: 'continuation repair' }), []);
  });

  // ----------------------------------------------- 14.C executor switch -----

  await test('14.C: an executor switch changes the epoch and NOTHING else', () => {
    const s = chained();
    const w = authority.issue(s, { id: 'W52', objective: 'fix expired-session refresh' });
    const identity = { id: w.id, goalId: w.goalId, taskId: w.taskId, scope: w.scopeRevision };

    // Opus is blocked; GLM picks it up. Both rungs above must be untouched.
    s.task.blockExecutor('weekly limit reached');
    w.block('weekly limit reached');
    assert.strictEqual(w.state, authority.WO_STATE.BLOCKED, 'the ORDER stays open');

    s.task.assignExecutor({ provider: 'zai', model: 'glm-5.3' });
    w.reassign({ provider: 'zai', model: 'glm-5.3' });

    assert.deepStrictEqual(
      { id: w.id, goalId: w.goalId, taskId: w.taskId, scope: w.scopeRevision },
      identity,
      'a model name is not part of a work order\'s identity');
    assert.strictEqual(w.executorEpoch, 2, 'only the epoch moves');
    assert.strictEqual(w.executor.model, 'glm-5.3');

    const c = authority.project(s);
    assert.strictEqual(c.goal.text, 'stabilise provider continuation', 'the goal is unchanged');
    assert.strictEqual(c.task.objective, 'repair handover', 'the task is unchanged');
    assert.strictEqual(c.executor.epoch, 2, 'the chain agrees with the order');
  });

  await test('14.C: the projection\'s epoch is DERIVED from the handover log', () => {
    // A separately maintained counter could only ever disagree with the thing it
    // counts. `assignExecutor` already appends a row per change.
    const s = chained();
    assert.strictEqual(authority.project(s).executor.epoch, 1);
    s.task.assignExecutor({ provider: 'zai', model: 'glm-5.3' });
    assert.strictEqual(authority.project(s).executor.epoch, 2);
    s.task.assignExecutor({ provider: 'anthropic', model: 'opus-5' });
    assert.strictEqual(authority.project(s).executor.epoch, 3);
  });

  // --------------------------------------------------- claims vs evidence ---

  await test('CLAIM: a worker saying it is done does not make the order verified', () => {
    const w = authority.issue(chained(), { id: '1', objective: 'anything' });
    w.claim('implemented and tested', { observed: ['session.js changed'] });
    assert.strictEqual(w.state, authority.WO_STATE.CLAIMED,
      'CLAIMED and VERIFIED are two states, which is the only reason the list is worth having');
    assert.strictEqual(w.verified(), false, 'no receipts, no verdict');
    assert.strictEqual(w.state, authority.WO_STATE.CLAIMED);
  });

  await test('CLAIM: only LAIN-gathered receipts reach VERIFIED', () => {
    const w = authority.issue(chained(), { id: '1', objective: 'anything' });
    w.claim('implemented and tested');
    w.receipt('test', 'session.test.js::expired_refresh PASSED');
    assert.strictEqual(w.verified(), true);
    assert.strictEqual(w.state, authority.WO_STATE.VERIFIED);
    // The claim is KEPT beside the evidence rather than replaced by it — the
    // disagreement between the two is the interesting part.
    assert.match(w.resultClaim.text, /implemented and tested/);
  });

  await test('CLAIM: a work order survives a save and restore with its ladder intact', () => {
    const w = authority.issue(chained(), { id: '9', objective: 'fix the thing' });
    w.reassign({ provider: 'zai', model: 'glm-5.3' });
    w.claim('done');
    w.receipt('test', 'suite PASSED');
    w.verified();

    const back = authority.WorkOrder.from(JSON.parse(JSON.stringify(w.toJSON())));
    assert.strictEqual(back.id, '9');
    assert.strictEqual(back.goalId, w.goalId);
    assert.strictEqual(back.taskId, w.taskId);
    assert.strictEqual(back.executorEpoch, 2);
    assert.strictEqual(back.state, authority.WO_STATE.VERIFIED);
    assert.strictEqual(back.evidenceReceipts.length, 1);
  });

  // ------------------------------------------------------ verify contract ---

  await test('VERIFY: the level is UNSPECIFIED, and does not pretend otherwise', () => {
    // The TARGETED → IMPACT → SUBSYSTEM → PROJECT → RELEASE ladder is NOT built.
    // Defaulting to TARGETED would assert a verification level nothing selected.
    const v = authority.verifyContract(chained());
    assert.strictEqual(v.level, authority.LEVEL.UNSPECIFIED);
  });

  await test('VERIFY: task complete and project clean stay two separate claims', () => {
    const s = chained();
    s.task.noteForeignFailure('tests/unit/bot-check.test.js', 'another task\'s unfinished work');
    s.task.settle(require('../../src/task').STATE.COMPLETED);

    const v = authority.verifyContract(s);
    assert.strictEqual(v.taskComplete, true);
    assert.strictEqual(v.projectClean, false, 'one number for both would erase the distinction');
    assert.strictEqual(v.foreignFailures.length, 1);
  });

  // ------------------------------------------------- goal supersession ------

  await test('RELATION: ordinary requests do not touch the standing goal', () => {
    const s = chained();
    for (const t of ['also fix the timer', 'check that test too', 'implement the next step', 'use a map instead']) {
      const r = goalMod.relate(s, t);
      assert.strictEqual(r.relation, goalMod.RELATION.CONTINUES_GOAL, `"${t}" is an ordinary task`);
      assert.strictEqual(r.consequential, false, 'and must not prompt anybody');
    }
  });

  await test('RELATION: an explicit change of direction is recognised and flagged', () => {
    const s = chained();
    for (const t of ['stop working on the bot', 'forget the previous direction',
      'the new goal is ship the installer', 'instead focus entirely on compaction']) {
      const r = goalMod.relate(s, t);
      assert.strictEqual(r.relation, goalMod.RELATION.SUPERSEDES_GOAL, `"${t}" supersedes`);
      assert.strictEqual(r.consequential, true);
    }
  });

  await test('RELATION: only a cancellation with no successor is AMBIGUOUS', () => {
    // §4: ask then, and only then. "the new goal is X" says what to do next;
    // "stop working on X" does not, and LAIN must not invent the successor.
    const s = chained();
    assert.strictEqual(goalMod.relate(s, 'stop working on the bot').ambiguous, true);
    assert.strictEqual(goalMod.relate(s, 'the new goal is ship the installer').ambiguous, false);
  });

  await test('RELATION: classifying never WRITES the goal — the one door still holds', () => {
    // goal.js's invariant: only `/goal` changes the goal. A classifier that
    // acted on its own verdict would be the turn quietly rewriting it.
    const s = chained();
    const before = JSON.stringify(goalMod.toJSON(s));
    goalMod.relate(s, 'the new goal is something else entirely');
    assert.strictEqual(JSON.stringify(goalMod.toJSON(s)), before,
      'reporting a relation must not change the thing it is about');
  });

  await test('RELATION: with no goal set, the answer is NO_GOAL and not "unrelated"', () => {
    assert.strictEqual(goalMod.relate({}, 'anything').relation, goalMod.RELATION.NO_GOAL);
  });

  // ------------------------------------------------------- goal identity ----

  await test('GOAL: an id survives a save and restore, and is recovered for old records', () => {
    const s = {};
    goalMod.set(s, 'stabilise the CLI');
    const id = goalMod.id(s);
    assert.ok(id);
    assert.strictEqual(goalMod.from(goalMod.toJSON(s)).id, id);
    // A record written before ids existed gets the id it WOULD have had, so
    // "same goal identity" is answerable for it too.
    const legacy = goalMod.from({ text: 'stabilise the CLI', setAt: '2026-01-01T00:00:00Z' });
    assert.strictEqual(legacy.id, goalMod.idFor('stabilise the CLI', '2026-01-01T00:00:00Z'));
  });

  await test('GOAL: re-entering the same text keeps the same identity', () => {
    // Someone re-typing their own direction has not changed it, and a new id
    // would make every work order issued before look like it served another.
    const s = {};
    goalMod.set(s, 'stabilise the CLI');
    const id = goalMod.id(s);
    goalMod.set(s, 'stabilise the CLI');
    assert.strictEqual(goalMod.id(s), id);
    goalMod.set(s, 'something genuinely different');
    assert.notStrictEqual(goalMod.id(s), id, 'but a real change is a real change');
  });
  // --------------------------------------------------- brief and the prompt --

  await test('BRIEF: `omit` suppresses a rung the caller has already stated', () => {
    // THE ANTI-DUPLICATION RULE. A system prompt does not grow because somebody
    // adds a paragraph; it grows because two places each correctly state one
    // fact. The first wiring of this printed the standing goal directly under a
    // `# Goal` heading that had just printed it.
    const s = chained();
    const w = authority.issue(s, { id: '7', objective: 'inspect the README too' });
    const chain = authority.project(s, { workOrder: w });

    const full = authority.brief(chain);
    assert.match(full, /^GOAL/m);
    assert.match(full, /^TASK/m);
    assert.match(full, /^PLAN/m);

    const only = authority.brief(chain, { omit: ['goal', 'task', 'plan'] });
    assert.match(only, /^WORK ORDER 7/m, 'the assignment is what is left');
    assert.ok(!/^GOAL/m.test(only), 'the goal was already stated by the caller');
    assert.ok(!/^TASK/m.test(only));
    assert.ok(!/^PLAN/m.test(only));
  });

  await test('BRIEF: it is called with arguments that actually work', () => {
    // THIS TEST EXISTS BECAUSE A try/catch HID A ReferenceError. appprompt.js
    // wraps the briefing so a failure cannot take a turn down — correct, and it
    // meant a broken `brief` produced a silently missing section rather than a
    // crash. So the call is exercised directly here, where nothing swallows it.
    const s = chained();
    const w = authority.issue(s, { id: '1', objective: 'anything' });
    const chain = authority.project(s, { workOrder: w });
    assert.doesNotThrow(() => authority.brief(chain));
    assert.doesNotThrow(() => authority.brief(chain, { omit: ['goal'] }));
    assert.doesNotThrow(() => authority.brief(chain, {}));
    assert.strictEqual(authority.brief(null), '');
  });
};
