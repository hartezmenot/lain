'use strict';

/**
 * AGENTS.md, AND THE PROMPT THE LIVE TURN ACTUALLY SENDS.
 *
 * The second half pins a defect found while wiring the first: the goal, the
 * Cowork context and a worker's assignment were assembled only by
 * `app.systemPrompt()`, which no live turn calls. Every assertion here is made
 * against `promptparts.of`, the builder app.js and `/bg` really use.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const agentsmd = require('../../src/agentsmd');
const promptparts = require('../../src/promptparts');
const goal = require('../../src/goal');
const authority = require('../../src/authority');
const { Session } = require('../../src/session');
const { Task } = require('../../src/task');

function realApp(cwd) {
  const { App } = require('../../src/app');
  return new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd });
}

module.exports = async function () {
  await test('AGENTS: global then project instructions, labelled as instructions and not permissions', () => {
    const home = tmpdir('agents-home-');
    const project = tmpdir('agents-proj-');
    fs.mkdirSync(path.join(home, '.lain'), { recursive: true });
    fs.mkdirSync(path.join(project, '.lain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lain', 'AGENTS.md'), 'Workers return evidence, never prose alone.');
    fs.writeFileSync(path.join(project, '.lain', 'AGENTS.md'), 'Test workers are read-only. No unrelated refactors.');
    const was = process.env.LAIN_AGENTS_HOME;
    process.env.LAIN_AGENTS_HOME = home;
    try {
      const text = agentsmd.forPrompt(project);
      assert.ok(text.indexOf('Workers return evidence') < text.indexOf('Test workers are read-only'), 'global first, project refines it');
      assert.match(text, /instructions, not permissions/);
      process.env.LAIN_AGENTS_HOME = tmpdir('agents-empty-home-');
      assert.strictEqual(agentsmd.forPrompt(tmpdir('agents-none-')), '', 'absent files add nothing');
    } finally {
      if (was == null) delete process.env.LAIN_AGENTS_HOME; else process.env.LAIN_AGENTS_HOME = was;
    }
  });
  await test('LIVE PROMPT: the standing goal reaches the prompt a real turn sends', () => {
    const cwd = tmpdir('live-goal-');
    const app = realApp(cwd);
    goal.set(app.session, 'Finish the LAIN foundation');
    const p = promptparts.of(app);
    assert.match(p.stable, /# Goal[\s\S]*Finish the LAIN foundation/, 'it was missing from every live turn before');
    assert.strictEqual((app.systemPrompt().match(/Finish the LAIN foundation/g) || []).length, 1, 'and the one-string path states it once');
  });

  await test('LIVE PROMPT: a /bg fork is prompted from ITS session, carrying its own assignment', () => {
    const cwd = tmpdir('live-bg-');
    const app = realApp(cwd);
    app.session.task = new Task('parent task');
    const fork = new Session({ cwd });
    fork.task = Task.from(app.session.task.toJSON());
    fork.workOrder = authority.issue(app.session, { id: '7', objective: 'measure the timer drift' });
    const parent = promptparts.of(app);
    const worker = promptparts.of(app, { session: fork });
    assert.ok(!/Your assignment/.test(parent.stable), 'the foreground issues orders; it does not execute one');
    assert.match(worker.stable, /# Your assignment[\s\S]*WORK ORDER 7[\s\S]*measure the timer drift/);
  });
};
