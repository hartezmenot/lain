'use strict';

/**
 * THE STALE-STEP DEFECT (Gate 3 §81–84, P0): "Continuing step 3… step 4… step 3…" — and, in real sessions,
 * "step 224", "step 3325". The root cause, pinned here:
 *
 *   1. A plan revision (plan_write with the remaining work reworded) DROPPED every open step and APPENDED the
 *      list again, numbered after everything before it: the same work came back as 6, 9, 224… while the model
 *      kept its own numbering. Every continuation then disagreed with the model about which step was which.
 *   2. Totals counted the dropped rows ("7/3328 done").
 *   3. `plan_step_done` moved the step in memory only; a save came later, on a throttle — a crash in between
 *      resumed at the step already finished.
 *
 * NOW: a revision reconciles (an open step keeps its id, place and findings); dropped work leaves the live list;
 * numbers are places among live steps; every step change is a CHECKPOINT COMMIT written before the tool
 * returns; receipts belong to a step by id.
 */

const assert = require('assert');
const fs = require('fs');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const { Plan } = require('../../src/plan');
  const { Session } = require('../../src/session');
  const { tools: planTools } = require('../../src/tools/plan');
  const cp = require('../../src/taskcheckpoint');
  const T = (name) => planTools[name];

  await test('STALE STEP: fifty reworded revisions keep the same steps, numbers and step in hand — no inflation', () => {
    const p = new Plan('ship it');
    p.addSteps(['Set up the schema', 'Wire the API', 'Write the UI', 'Test it end to end']);
    p.complete('schema ok');
    const idOf = (t) => p.steps.find((s) => s.text.toLowerCase().includes(t)).id;
    const wireId = idOf('api');
    const words = [['Wire the API', 'Wire up the API'], ['Write the UI', 'Write the UI screens'], ['Test it end to end', 'Test it all end to end']];
    for (let i = 0; i < 50; i++) {
      const pick = (k) => words[k][i % 2];
      // The model re-lists finished work, numbers its steps and marks one done — as models do.
      p.revise([`1. Set up the schema (done)`, `2. ${pick(0)}`, `3. ${pick(1)}`, `4. ${pick(2)}`]);
    }
    assert.strictEqual(p.steps.length, 4, `no inflation: ${p.steps.map((s) => s.n).join(',')}`);
    assert.strictEqual(p.dropped.length, 0, 'nothing was dropped — it was the same work');
    assert.strictEqual(p.current().id, wireId, 'the step in hand is still the step in hand');
    assert.deepStrictEqual(p.position(), { index: 2, total: 4 });
    assert.deepStrictEqual(p.steps.map((s) => s.n), [1, 2, 3, 4]);
  });

  await test('STALE STEP: work that is genuinely gone is dropped to history, and the numbers stay places', () => {
    const p = new Plan('x');
    p.addSteps(['a one', 'b two', 'c three', 'd four']);
    p.complete('a');
    const r = p.revise(['c three', 'e five']);
    assert.deepStrictEqual([r.kept, r.added, r.dropped], [1, 1, 2]);
    assert.deepStrictEqual(p.steps.map((s) => `${s.n}:${s.status}:${s.text}`), ['1:done:a one', '2:active:c three', '3:todo:e five']);
    assert.strictEqual(p.dropped.length, 2);
    assert.strictEqual(p.steps.filter((s) => s.status === 'active').length, 1, 'exactly one step in hand');
  });

  await test('STALE STEP: a plan saved by an older build (dropped rows, two active) comes back settled', () => {
    const q = Plan.from({ objective: 'y', steps: [
      { n: 1, text: 'a', status: 'done' }, { n: 2, text: 'b', status: 'dropped' }, { n: 3, text: 'c', status: 'dropped' },
      { n: 3325, text: 'b2', status: 'active' }, { n: 3326, text: 'c2', status: 'active' }, { n: 3327, text: 'd', status: 'todo' },
    ] });
    assert.deepStrictEqual(q.steps.map((s) => `${s.n}:${s.status}`), ['1:done', '2:active', '3:todo', '4:todo']);
    assert.ok(q.steps.every((s) => s.id), 'every step has an id');
    assert.strictEqual(q.dropped.length, 2);
  });

  await test('STALE STEP: plan_step_done COMMITS — on disk before the tool returns; a crash resumes at the next step', async () => {
    const s = new Session({ cwd: tmpdir('stale-') });
    const ctx = { session: s };
    const w = await T('plan_write').run({ steps: ['Read the config', 'Patch the loader', 'Run the tests'] }, ctx);
    assert.ok(!w.isError, w.output);
    const d = await T('plan_step_done').run({ note: 'read it' }, ctx);
    assert.ok(!d.isError, d.output);
    assert.match(d.output, /step 1 of 3 done \(1\/3\)\. Next: step 2 of 3: Patch the loader/);
    // THE CRASH: nothing else saves; the in-memory session is gone.
    const onDisk = JSON.parse(fs.readFileSync(s.file(), 'utf8'));
    assert.strictEqual(onDisk.plan.steps[0].status, 'done', 'the finished step is on disk');
    const back = Session.resume(s.id);
    assert.strictEqual(back.plan.current().text, 'Patch the loader');
    const v = cp.view(back);
    assert.deepStrictEqual([v.step.index, v.step.total], [2, 3]);
    assert.strictEqual(v.generation, 2, 'plan recorded (1), step done (2)');
    assert.strictEqual(v.committed, true);
    assert.match(cp.line(back), /^Step 2 of 3 — Patch the loader \(checkpoint 2\)$/);
  });

  await test('STALE STEP: the continuation and the handover name the committed step, counted the same way', () => {
    const s = new Session({ cwd: tmpdir('stale-h-') });
    s.plan = new Plan('x');
    s.plan.addSteps(['one thing', 'two things', 'three things']);
    s.plan.complete('done one');
    s.plan.revise(['two things', 'three things', 'four things']);
    cp.commit(s, 'test', { save: false });
    // THE PREVIOUS TURN DID NOT FINISH — the case a handover is written for.
    s.turns.push({ stopReason: 'crashed', steps: 3, model: 'test-model', actions: [] });
    const ins = require('../../src/continueactions').instruction({ step: s.plan.current(), plan: s.plan });
    assert.match(ins, /Resume at plan step 2 of 4: two things/);
    const packet = require('../../src/handover').build(s, { cwd: s.cwd });
    assert.match(packet, /Resume from the last committed checkpoint: Step 2 of 4 — two things/);
    assert.match(packet, /Plan: 1\/4 steps done\./, 'totals count live steps only');
  });

  await test('STALE STEP: a step\'s receipts stay its own after a revision renumbers the plan', () => {
    const s = new Session({ cwd: tmpdir('stale-r-') });
    s.plan = new Plan('x');
    s.plan.addSteps(['old first', 'set up the fixtures', 'patch the loader', 'test']);
    const loader = s.plan.steps[2];
    s.plan.complete('first');
    s.mutationReceipts = [{ verdict: 'KEEP', planStep: 3, planStepId: loader.id, targets: ['src/loader.js'] }];
    // A step inserted ahead of it moves its number from 3 to 4.
    s.plan.revise(['set up the fixtures', 'new urgent step', 'patch the loader', 'test']);
    const now = s.plan.steps.find((x) => x.id === loader.id);
    assert.strictEqual(now.n, 4, 'the loader step moved');
    const rec = require('../../src/planfindings').derive(s, now);
    assert.deepStrictEqual(rec.landed, ['src/loader.js'], 'its receipt followed it by id');
  });
};
