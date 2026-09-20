'use strict';

/**
 * NON-PROGRESS IS ABOUT THE QUESTION, NOT THE COMMAND.
 *
 * ------------------------------------------------------------------------
 * THE LOOP THIS CATCHES, as observed: an implementation decision is settled,
 * and the same file is read again and again under an unchanged state — each
 * time by a slightly different route, each time announced as the last one.
 *
 *     read_file api.ts              "one decisive read"
 *     sed -n '120,180p' api.ts      "pinning the exact idiom"
 *     grep -n addMovie api.ts       "final anchors"
 *
 * That is ONE question asked three ways. The gate used to count repeats under
 * the tool name and its arguments, so each spelling started the count at zero
 * and no steer ever fired — and `grep` was not recognised as a read at all, so
 * the shape a model reaches for most was the one thing that could never count.
 *
 * What must still be left alone: reading a DIFFERENT part of a file, and
 * reading anything after something was written or checked. Both are here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const progress = require('../../src/progress');
const receipts = require('../../src/readreceipts');
const { Session } = require('../../src/session');
const { Task } = require('../../src/task');
const { Plan } = require('../../src/plan');

function world() {
  const root = tmpdir('lain-semantic-');
  fs.writeFileSync(path.join(root, 'api.ts'),
    Array.from({ length: 300 }, (_, i) => `export function f${i}(): number { return ${i}; }`).join('\n'));
  const s = new Session({ cwd: root });
  s.task = new Task('finish the sweep');
  s.plan = Plan.from({ objective: 'finish the sweep', steps: [{ text: 'series sweep' }, { text: 'movie sweep' }] })
    || new Plan('finish the sweep', ['series sweep', 'movie sweep']);
  return { root, s };
}

/**
 * One read, driven the way toolstep.js drives it: `before`, the call, `after`.
 * Going through `after` matters — recording the FIRST observation of a file is
 * itself a state change, and it is `after` that re-stamps it.
 */
function read(s, name, input, id) {
  const gate = progress.before(s, name, input);
  const result = gate && gate.substitute ? gate.substitute : { output: 'x'.repeat(40) };
  const out = progress.after(s, name, input, result, gate, { toolCallId: id });
  return { ...gate, output: String((out && out.output) || '') };
}

module.exports = async function () {
  await test('SEMANTIC: the same file asked three different ways is ONE question', () => {
    const { s } = world();
    const first = read(s, 'read_file', { path: 'api.ts' }, 'c1');
    assert.strictEqual(first.verdict, progress.VERDICT.DISCOVERY, 'the first read is discovery');

    // A REGION ALREADY COVERED by the whole-file read.
    const second = read(s, 'run_bash', { command: "sed -n '120,180p' api.ts" }, 'c2');
    assert.ok(second, 'a sed read is recognised');
    assert.strictEqual(second.repeats, 1, `the second spelling continues the count: ${second.repeats}`);

    // AND A GREP AT THE SAME FILE — the shape that used to be invisible.
    const third = read(s, 'run_bash', { command: 'grep -n addMovie api.ts' }, 'c3');
    assert.ok(third, 'a grep naming one file is recognised as a read of it');
    assert.strictEqual(third.repeats, 2, `and so does the third: ${third.repeats}`);
    assert.strictEqual(third.verdict, progress.VERDICT.NON_PROGRESS,
      'three reads of one unchanged file under one unchanged state is non-progress');
    // THE READ STILL RUNS — a grep and a file read do not produce the same
    // bytes, so nothing is served from a receipt. The steer rides on the real
    // result instead, which is how it reaches the model at all.
    assert.strictEqual(third.substitute, null, 'the call is not substituted, only steered');
    assert.match(third.output, /NON_PROGRESS/,
      'and the steer is attached to the read that triggered it');
    assert.match(third.output, /Pending:/, 'naming what to do instead of reading again');
  });

  await test('SEMANTIC: a DIFFERENT part of the same file is ordinary discovery', () => {
    const { s } = world();
    read(s, 'run_bash', { command: "sed -n '1,50p' api.ts" }, 'c1');
    const next = read(s, 'run_bash', { command: "sed -n '200,250p' api.ts" }, 'c2');
    assert.strictEqual(next.repeats, 0,
      'walking a large file in windows is discovery, not a loop');
    const third = read(s, 'run_bash', { command: "sed -n '251,300p' api.ts" }, 'c3');
    assert.notStrictEqual(third.verdict, progress.VERDICT.NON_PROGRESS,
      'and it is never steered for reading parts it has not seen');
  });

  await test('SEMANTIC: distinct symbols of one file are distinct evidence — a first read is never NON_PROGRESS', () => {
    // LIVE, 2026-09-18: one batch read tierDiscount, applyDiscount, lineTotal
    // and cartTotal of pricing.js; the third and fourth came back "observation
    // 3/4 … under unchanged state" because a symbol receipt (no range) passed
    // for a whole-file read. The model then re-read the whole file.
    const { s } = world();
    const verdicts = ['f1', 'f2', 'f3', 'f4', 'f5'].map((name, i) => read(s, 'read_symbol', { path: 'api.ts', name }, `c${i}`));
    for (const v of verdicts) {
      assert.strictEqual(v.verdict, progress.VERDICT.DISCOVERY, `first read of a symbol is discovery: ${v.output.slice(-160)}`);
      assert.doesNotMatch(v.output, /NON_PROGRESS/);
    }
    // A grep of one pattern does not stand in for the whole file either.
    const g = read(s, 'run_bash', { command: 'grep -n f9 api.ts' }, 'g1');
    assert.strictEqual(g.verdict, progress.VERDICT.DISCOVERY);
    const whole = read(s, 'read_file', { path: 'api.ts' }, 'w1');
    assert.strictEqual(whole.repeats, 0, 'a whole read after symbol/grep reads asks for more than was read');
    // The SAME symbol again is still the same question.
    const again = read(s, 'read_symbol', { path: 'api.ts', name: 'f1' }, 'c9');
    assert.ok(again.repeats >= 1, 'the same symbol again continues the count');
  });

  await test('SEMANTIC: a tree-wide search is not recorded against a file it did not read', () => {
    const { s } = world();
    assert.strictEqual(receipts.parse('run_bash', { command: 'grep -rn addMovie .' }, s.cwd), null,
      'a recursive search has no single source to fingerprint');
    assert.strictEqual(receipts.parse('run_bash', { command: 'grep -n addMovie *.ts' }, s.cwd), null,
      'nor does a glob');
    assert.ok(receipts.parse('run_bash', { command: 'grep -n addMovie api.ts' }, s.cwd),
      'but one naming a single file is a read of that file');
  });

  await test('SEMANTIC: the Step-740 replay — many spellings, one question, and it survives a resume', () => {
    // ---- §20, AS THE LOOP ACTUALLY RAN ----------------------------------
    //
    // Same plan step, unchanged files, nothing written, and each read announced
    // as the decisive one. The count must keep CLIMBING through every spelling
    // — a model that finds a new way to ask must not thereby get a fresh
    // budget — and the steer must name what to do instead of reading again.
    const { s } = world();
    const spellings = [
      ['read_file', { path: 'api.ts' }],
      ['run_bash', { command: "sed -n '120,180p' api.ts" }],
      ['run_bash', { command: 'grep -n addMovie api.ts' }],
      ['run_bash', { command: "sed -n '1,300p' api.ts" }],
      ['read_file', { path: 'api.ts' }],
      ['run_bash', { command: 'grep -n handleStalled api.ts' }],
    ];
    let steered = 0;
    let last = null;
    spellings.forEach(([name, input], i) => {
      last = read(s, name, input, `c${i + 1}`);
      if (last.verdict === progress.VERDICT.NON_PROGRESS) steered += 1;
    });
    assert.ok(steered >= 3, `every read past the second is non-progress, got ${steered} of 6`);
    assert.ok(last.repeats >= 4, `the count climbs through the spellings: ${last.repeats}`);

    // AND IT SAYS WHERE TO GO — the pending write or check, by name. A steer
    // that only says "stop" leaves the model with nowhere to put the turn.
    assert.match(last.output, /Pending: plan step/, last.output.slice(-200));

    // ---- IT SURVIVES THE BOUNDARY THE LOOP USED TO ESCAPE THROUGH -------
    //
    // Compaction, a rate-limit resume and `/resume` all shorten the
    // conversation. If the count went with it, the model would come back and
    // begin the same six reads with a clean slate — which is what made the
    // original loop look endless rather than merely long.
    s.save();
    const back = Session.resume(s.id);
    const again = read(back, 'run_bash', { command: 'grep -n addMovie api.ts' }, 'c7');
    assert.strictEqual(again.verdict, progress.VERDICT.NON_PROGRESS,
      'a resumed session does not hand the loop a fresh budget');
    try { require('../../src/sessionstore').forget(s.id); } catch { /* best effort */ }
  });

  await test('SEMANTIC: writing or checking something resets it — that is real progress', () => {
    const { s } = world();
    read(s, 'read_file', { path: 'api.ts' }, 'c1');
    read(s, 'run_bash', { command: "sed -n '10,20p' api.ts" }, 'c2');
    // A MUTATION MOVES THE STATE, so the next read is a legitimate recheck.
    progress.after(s, 'write_file', { path: 'api.ts' }, { output: 'ok', mutated: ['api.ts'] }, null);
    const after = read(s, 'run_bash', { command: 'grep -n addMovie api.ts' }, 'c3');
    assert.strictEqual(after.repeats, 0, 'the count starts again once something actually changed');
    assert.notStrictEqual(after.verdict, progress.VERDICT.NON_PROGRESS);
  });
};
