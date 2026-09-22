'use strict';

/**
 * `/goal` STARTS THE WORK (2026-09-23).
 *
 *   /goal <text>          → durable goal → executes, one USER turn
 *   /goal ⏎ <paste> ⏎     → capture → durable goal → executes immediately
 *   /goal show | continue | clear
 *
 * Before: both forms stored the goal and stopped; a pasted task then needed a
 * second `/goal continue`. Driven through the real App.handle with the mock
 * provider, so the assertion is on what actually reached the model.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const { App } = require('../../src/app');
const mock = require('../../src/mockprovider');
const goal = require('../../src/goal');
const compose = require('../../src/composemode');

function scripted(steps) {
  const dir = tmpdir('goalexec-');
  const file = path.join(dir, 'script.json');
  fs.writeFileSync(file, JSON.stringify(steps), 'utf8');
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = file;
  mock._reset();
  return dir;
}
function unscript() {
  delete process.env.LAIN_PROVIDER;
  delete process.env.LAIN_MOCK_SCRIPT;
  mock._reset();
}

function app(cwd) {
  const a = new App({ interactive: false, cwd });
  const out = [];
  a.render.write = (s) => out.push(String(s));
  a.render.notice = () => {};
  a.render.turnSummary = () => {};
  a.render.nl = () => {};
  a.session.save = () => {};
  a.input = { line: '', setLine(t) { this.line = String(t == null ? '' : t); } };
  a.out = out;
  return a;
}

/** The user messages the session recorded — what the model was actually handed. */
function userTurns(a) {
  return (a.session.messages || []).filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
}

const TASK = 'Fix the retry scheduler.\nKeep the public API.\nRun the tests.';

module.exports = async function () {
  await test('GOAL EXECUTE: `/goal <text>` sets the goal AND runs it as one user turn', async () => {
    const dir = scripted([{ text: 'on it' }]);
    try {
      const a = app(dir);
      await a.handle('/goal ' + TASK.replace(/\n/g, ' '));
      assert.strictEqual(goal.text(a.session), TASK.replace(/\n/g, ' '));
      const users = userTurns(a).filter((u) => /retry scheduler/.test(u));
      assert.strictEqual(users.length, 1, 'exactly one user turn carries the goal');
      assert.strictEqual((a.session.turns || []).length, 1, 'and it ran — no /goal continue needed');
    } finally { unscript(); }
  });

  await test('GOAL EXECUTE: capture — `/goal`, then a multi-line PASTE, runs immediately', async () => {
    const dir = scripted([{ text: 'on it' }]);
    try {
      const a = app(dir);
      // A REAL terminal opens capture; this App has no TTY, so open it the way
      // the command does on one.
      compose.open(a, compose.KIND.GOAL, { prefill: '', intent: 'new' });
      await a.handle(TASK, { isPaste: true });
      assert.strictEqual(compose.pending(a), null, 'the composer closed');
      assert.strictEqual(goal.text(a.session), TASK, 'the whole paste is the goal');
      assert.strictEqual((a.session.turns || []).length, 1, 'the goal executed at once');
      const users = userTurns(a).filter((u) => /retry scheduler/.test(u));
      assert.strictEqual(users.length, 1, 'one user turn — not the paste AND a continuation');
      assert.ok(users[0].includes('Keep the public API.'), 'multi-line content intact');
    } finally { unscript(); }
  });

  await test('GOAL EXECUTE: a captured goal starting with "/" is text, never a command', async () => {
    const dir = scripted([{ text: 'ok' }]);
    try {
      const a = app(dir);
      compose.open(a, compose.KIND.GOAL, { prefill: '', intent: 'new' });
      await a.handle('/exit the old code path from the router');
      assert.ok(!a.wantExit, '/exit was not run');
      assert.strictEqual((a.session.turns || []).length, 1);
    } finally { unscript(); }
  });

  await test('GOAL EXECUTE: editing a goal from the shelf edits only — nothing runs', async () => {
    const dir = scripted([{ text: 'should not be asked' }]);
    try {
      const a = app(dir);
      const g = goal.create(a.session, 'old');
      compose.open(a, compose.KIND.GOAL, { prefill: 'old', intent: 'edit', target: g.id });
      await a.handle('old, revised');
      assert.strictEqual(goal.text(a.session), 'old, revised');
      assert.strictEqual((a.session.turns || []).length, 0, 'an edit is not a request');
    } finally { unscript(); }
  });

  await test('GOAL EXECUTE: `/goal show` and `/goal clear` run nothing', async () => {
    const dir = scripted([{ text: 'should not be asked' }]);
    try {
      const a = app(dir);
      goal.create(a.session, 'ship it');
      await a.handle('/goal show');
      assert.ok(a.out.join('').includes('ship it'), 'show reads it out on a pipe');
      await a.handle('/goal clear');
      assert.strictEqual(goal.text(a.session), '');
      assert.strictEqual((a.session.turns || []).length, 0);
    } finally { unscript(); }
  });

  await test('GOAL EXECUTE: `/goal continue` resumes the existing goal (a turn starts)', async () => {
    const dir = scripted([{ text: 'continuing' }]);
    try {
      const a = app(dir);
      goal.create(a.session, 'finish the harness');
      const r = await a.handle('/goal continue');
      if (r && r.submitted) await r.submitted;
      assert.strictEqual((a.session.turns || []).length, 1);
    } finally { unscript(); }
  });

  await test('GOAL EXECUTE: `/goal <text>` mid-turn is queued behind it, never a second concurrent turn', async () => {
    const dir = scripted([{ text: 'x' }]);
    try {
      const a = app(dir);
      a.abort = new AbortController();          // a turn is in flight
      const r = await a.handle('/goal migrate the store');
      assert.strictEqual(r, null);
      assert.ok(a._queuedContinue && a._queuedContinue.goal, 'queued for when the turn ends');
      assert.strictEqual(goal.text(a.session), 'migrate the store');
      assert.strictEqual((a.session.turns || []).length, 0, 'nothing ran concurrently');
      a.abort = null;
    } finally { unscript(); }
  });
};
