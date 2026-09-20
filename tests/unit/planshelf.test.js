'use strict';

/**
 * /plan ON THE SHELF — Continue · Edit · Add · New · Delete.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');
const { Plan } = require('../../src/plan');
const { Session } = require('../../src/session');
const compose = require('../../src/composemode');

function appWith(answer) {
  const app = {
    frames: [],
    written: [],
    render: { write(s) { app.written.push(String(s)); } },
    ui: { enabled: true, refresh() {}, async ask(f) { app.frames.push(f); return answer; } },
    input: { isTTY: true, line: '', setLine(s) { this.line = s; } },
    session: new Session({ cwd: tmpdir('plshelf-') }),
    transient() {},
    // WHAT CONTINUE NEEDS NOW: it starts a turn. Recorded rather than run.
    submitted: [],
    abort: null,
    submit(text, opts) { app.submitted.push({ text, opts }); return 'submitted'; },
    pendingCompletion: 'plan finished but not verified',
  };
  app.session.plan = new Plan('ship it').addSteps(['stabilize CLI', 'build Harness shell', 'implement Computer MCP']);
  app.session.plan.complete('done');
  return app;
}

const run = (app) => require('../../src/plan').runCommand(app, { args: [], rest: '' }, { C: { dim: (s) => s, bold: (s) => s } });

module.exports = async function () {
  await test('PLAN SHELF: a live plan opens the shelf with its steps and five actions', async () => {
    const app = appWith(null);
    await run(app);
    const f = app.frames[0];
    assert.strictEqual(f.kind, 'SHELF');
    assert.deepStrictEqual(f.shelf.actions.map((a) => a.label), ['Continue', 'Edit', 'Add', 'New', 'Delete']);
    assert.ok(f.items.some((i) => /✓ 1\. stabilize CLI/.test(i.label)), 'finished steps are marked');
    assert.ok(f.items.some((i) => /◐ 2\. build Harness shell/.test(i.label)), 'the active step is marked');
    assert.strictEqual(app.written.join(''), '', 'nothing is narrated into the conversation');
  });

  await test('PLAN SHELF: Continue RESUMES THE PLAN; Edit prefills the remaining steps', async () => {
    // ---- THIS CASE USED TO ASSERT "Continue changes nothing" --------------
    //
    // And it was accurate: `continue` matched no branch, so the button did
    // exactly what Escape did. That was the defect, not the contract. Continue
    // now resumes execution at the first step that is NOT finished — step 2
    // here, because step 1 is done — and it never restarts at step 1.
    let app = appWith({ action: 'continue', choice: null });
    const before = JSON.stringify(app.session.plan.toJSON());
    await run(app);
    assert.strictEqual(JSON.stringify(app.session.plan.toJSON()), before,
      'continuing does not rewrite the plan it is continuing');
    assert.ok(!compose.pending(app), 'and it does not open the composer');
    assert.strictEqual(app.submitted.length, 1, 'it started the work');
    assert.match(app.submitted[0].text, /Resume at plan step 2 of 3: build Harness shell/);
    assert.ok(app.submitted[0].text.trim().toLowerCase() !== 'continue',
      'and it is not the bare word "continue"');

    app = appWith({ action: 'edit', choice: null });
    await run(app);
    assert.strictEqual(compose.label(app), 'PLAN');
    assert.strictEqual(app.input.line, 'build Harness shell → implement Computer MCP');
  });

  await test('PLAN SHELF: Add extends; New keeps the old plan in history, unmutated', async () => {
    let app = appWith({ action: 'add', choice: null });
    await run(app);
    assert.strictEqual(compose.label(app), 'PLAN +');
    compose.take(app, 'verify release');
    assert.strictEqual(app.session.plan.steps.length, 4);

    app = appWith({ action: 'new', choice: null });
    const old = app.session.plan;
    await run(app);
    compose.take(app, 'audit smoke → fix trust test');
    assert.notStrictEqual(app.session.plan, old, 'a new plan object');
    assert.deepStrictEqual(app.session.plan.steps.map((s) => s.text), ['audit smoke', 'fix trust test']);
    assert.strictEqual(app.session.planHistory[0], old, 'the previous plan is kept');
    assert.strictEqual(old.steps.length, 3, 'and not rewritten');
    app.session.save();
    const back = Session.resume(app.session.id);
    assert.strictEqual(back.planHistory.length, 1, 'history survives resume');
  });

  await test('PLAN SHELF: Delete removes the plan and its outstanding verification claim', async () => {
    const app = appWith({ action: 'delete', choice: null });
    await run(app);
    assert.strictEqual(app.session.plan, null);
    assert.strictEqual(app.pendingCompletion, null, 'no "plan finished" state outlives the plan');
  });
};
