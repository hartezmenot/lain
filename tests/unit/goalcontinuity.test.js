'use strict';

/**
 * GOALS ARE RESUMABLE — New pauses, Continue activates, Edit keeps identity,
 * Delete removes one and never promotes another behind the person's back.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');
const goal = require('../../src/goal');
const { Session } = require('../../src/session');
const compose = require('../../src/composemode');

module.exports = async function () {
  await test('GOAL CONTINUITY: New keeps the previous goal as PAUSED', () => {
    const s = new Session({ cwd: tmpdir('gc-') });
    const a = goal.create(s, 'Finish LAIN Harness');
    goal.create(s, 'Fix the release blocker');
    const l = goal.list(s);
    assert.deepStrictEqual(l.map((g) => [g.text, g.state]), [['Fix the release blocker', 'ACTIVE'], ['Finish LAIN Harness', 'PAUSED']]);
    assert.strictEqual(l[1].id, a.id, 'the paused goal keeps its identity');
  });

  await test('GOAL CONTINUITY: Continue swaps active and paused, text untouched', () => {
    const s = new Session({ cwd: tmpdir('gc-') });
    const a = goal.create(s, 'first');
    goal.create(s, 'second');
    goal.activate(s, a.id);
    assert.strictEqual(goal.text(s), 'first');
    assert.strictEqual(goal.id(s), a.id);
    assert.deepStrictEqual(goal.list(s).map((g) => g.text), ['first', 'second']);
  });

  await test('GOAL CONTINUITY: Edit changes words and keeps the id, active or paused', () => {
    const s = new Session({ cwd: tmpdir('gc-') });
    const a = goal.create(s, 'first');
    const b = goal.create(s, 'second');
    goal.edit(s, b.id, 'second, plus Computer MCP');
    assert.strictEqual(goal.id(s), b.id);
    assert.strictEqual(goal.text(s), 'second, plus Computer MCP');
    goal.edit(s, a.id, 'first, revised');
    assert.strictEqual(goal.list(s)[1].text, 'first, revised');
    assert.strictEqual(goal.list(s)[1].id, a.id);
  });

  await test('GOAL CONTINUITY: Delete removes one; deleting the active leaves NO active goal', () => {
    const s = new Session({ cwd: tmpdir('gc-') });
    goal.create(s, 'first');
    const b = goal.create(s, 'second');
    goal.remove(s, b.id);
    assert.strictEqual(goal.text(s), '', 'nothing is promoted automatically');
    assert.strictEqual(goal.list(s).length, 1);
    assert.strictEqual(goal.forPrompt(s), '', 'and the model is told no direction');
  });

  await test('GOAL CONTINUITY: active and paused goals survive save and resume', () => {
    const s = new Session({ cwd: tmpdir('gc-') });
    goal.create(s, 'first');
    goal.create(s, 'second');
    s.save();
    const back = Session.resume(s.id);
    assert.deepStrictEqual(goal.list(back).map((g) => [g.text, g.state]), [['second', 'ACTIVE'], ['first', 'PAUSED']]);
  });

  await test('GOAL CONTINUITY: the composer commits New and Edit by intent', () => {
    const app = { session: new Session({ cwd: tmpdir('gc-') }), transient() {}, input: null };
    goal.create(app.session, 'old');
    compose.open(app, compose.KIND.GOAL, { intent: 'new' });
    compose.take(app, 'brand new');
    assert.deepStrictEqual(goal.list(app.session).map((g) => g.text), ['brand new', 'old']);
    const oldId = goal.list(app.session)[1].id;
    compose.open(app, compose.KIND.GOAL, { intent: 'edit', target: oldId });
    compose.take(app, 'old, edited');
    assert.strictEqual(goal.list(app.session)[1].text, 'old, edited');
    assert.strictEqual(goal.text(app.session), 'brand new', 'editing a paused goal does not activate it');
  });
};
