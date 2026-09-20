'use strict';

/**
 * WHAT A STEP ALREADY ESTABLISHED, AND THE RULE THAT SAYS TO STOP READING.
 *
 * ------------------------------------------------------------------------
 * BOTH OF THESE WERE LEFT OPEN BY THE P0 AUDIT, deliberately and on the record:
 * neither was needed to EXPLAIN the Step-740 loop, whose cause was a scanner
 * that admitted TypeScript and refused to parse it. They are what stops the
 * same SHAPE recurring for a different reason.
 *
 * The loop is: a long step settles four facts, the conversation carrying them
 * gets shortened (compaction, a rate-limit resume, a continuation), and the
 * model rediscovers the same four facts from the same four files — busily,
 * without moving.
 *
 *   §22  the facts move OUT of the conversation and onto the step, which is
 *        persisted with the plan and survives every one of those.
 *   §23  and the policy says what to do once they are settled: patch.
 */

const assert = require('assert');
const { test } = require('../helpers');

const findings = require('../../src/planfindings');
const { Plan } = require('../../src/plan');

function planWithStep() {
  const p = new Plan('fix stalled downloads');
  p.addSteps(['schema + setting', 'scheduler', 'series sweep', 'tests']);
  return p;
}

module.exports = async function () {
  await test('FINDINGS: a step keeps what it settled, and it survives a round trip', () => {
    const p = planWithStep();
    findings.record(p.current(), {
      settled: ['tracked stall = cancel', 'untracked stall = pause', '409 prevents paused retry'],
      landed: ['schema', 'setting', 'scheduler'],
      remaining: ['series sweep', 'movie sweep', 'tests'],
      evidence: ['src/sched.ts:handleStalled'],
    });

    // THE ROUND TRIP IS THE WHOLE CLAIM. `toJSON`/`from` is the path a session
    // takes to disk and back, which is also the path it takes through a
    // compaction, a resume and a continuation — none of which touch the plan.
    const back = Plan.from(JSON.parse(JSON.stringify(p.toJSON())));
    const rec = back.current().findings;
    assert.deepStrictEqual(rec.settled, ['tracked stall = cancel', 'untracked stall = pause', '409 prevents paused retry']);
    assert.deepStrictEqual(rec.landed, ['schema', 'setting', 'scheduler']);
    assert.deepStrictEqual(rec.evidence, ['src/sched.ts:handleStalled']);
  });

  await test('FINDINGS: `remaining` may SHRINK; everything else accumulates', () => {
    const p = planWithStep();
    const step = p.current();
    findings.record(step, { settled: ['a'], remaining: ['x', 'y'] });
    findings.record(step, { settled: ['b'], remaining: ['y'] });
    // SETTLED IS A RECORD OF WHAT IS FIXED, so it grows.
    assert.deepStrictEqual(step.findings.settled, ['a', 'b']);
    // REMAINING IS A STATEMENT ABOUT WHAT IS LEFT. Merging it would make a step
    // that finished its last obligation still claim to owe it.
    assert.deepStrictEqual(step.findings.remaining, ['y']);
  });

  await test('FINDINGS: it is a record, not a scratchpad', () => {
    const p = planWithStep();
    const step = p.current();
    // ONE LINE PER FACT. A finding that does not fit on a line was not a
    // finding, and the failure mode of a scratchpad is becoming the transcript.
    findings.record(step, { settled: [`${'x'.repeat(500)}`] });
    assert.ok(step.findings.settled[0].length <= findings.MAX_CHARS);
    // BOUNDED IN COUNT TOO.
    findings.record(step, { landed: Array.from({ length: 50 }, (_, i) => `edit ${i}`) });
    assert.ok(step.findings.landed.length <= findings.MAX_ENTRIES, `${step.findings.landed.length} entries`);
    // AND THE SAME FACT TWICE IS ONE FACT.
    findings.record(step, { settled: ['dup', 'dup'] });
    assert.strictEqual(step.findings.settled.filter((x) => x === 'dup').length, 1);
    // NEWLINES ARE FLATTENED — a multi-line "finding" is prose wearing a list.
    findings.record(step, { evidence: ['a\n\nb\nc'] });
    assert.ok(!step.findings.evidence.some((e) => e.includes('\n')));
  });

  await test('FINDINGS: only the ACTIVE step reaches the prompt', () => {
    const p = planWithStep();
    findings.record(p.current(), { settled: ['step one fact'] });
    const first = p.current();
    p.complete('done');
    findings.record(p.current(), { settled: ['step two fact'] });

    const digest = p.digest(1200);
    assert.match(digest, /step two fact/, 'the step being worked on is shown');
    assert.ok(!digest.includes('step one fact'),
      'a finished step\'s findings are history, and history in a prompt is the cost this avoids');
    assert.ok(first.findings.settled.includes('step one fact'), 'though they are still kept on the step');
  });

  await test('FINDINGS: an empty record draws nothing at all', () => {
    const p = planWithStep();
    assert.strictEqual(findings.lines(p.current()), '');
    assert.ok(!/already established/.test(p.digest(900)));
  });

  await test('FINDINGS: the model has a bounded way to write one', () => {
    const tools = require('../../src/tools');
    assert.ok(tools.names().includes('plan_findings'), 'the tool is registered');
    const schema = tools.schemas().find((t) => (t.name || (t.function && t.function.name)) === 'plan_findings');
    assert.ok(schema, 'and it is offered to the model');
    const text = JSON.stringify(schema);
    for (const field of findings.FIELDS) assert.ok(text.includes(field), `${field} is part of the contract`);

    // AND THE MODEL IS TOLD IT EXISTS. A tool that is registered but never
    // named in guidance is one nothing reaches for — the schema list is long,
    // and the plan tools beside it are introduced by name for the same reason.
    const prompt = require('../../src/prompt');
    const built = prompt.build({ cwd: process.cwd(), platform: process.platform, model: 'm', separate: true });
    assert.match(`${built.stable}\n${built.live}`, /plan_findings/,
      'the prompt introduces it where it introduces plan_write and plan_step_done');
  });

  await test('DERIVED: LAIN knows what landed even if the model never said so', () => {
    // ---- THE LIMITATION THIS CLOSES -------------------------------------
    //
    // `plan_findings` is written by the MODEL, and a model that forgets to call
    // it loses the record — including the part nobody should have to be told:
    // what actually changed on disk. A turn that patched three files and then
    // crossed a context boundary would come back with no memory of having
    // patched them, which is exactly the loop the record exists to stop.
    const { Session } = require('../../src/session');
    const s = new Session({ cwd: process.cwd() });
    s.plan = planWithStep();

    // CORE'S OWN LEDGER, and not one model sentence.
    s.mutationReceipts = [
      { verdict: 'KEEP', planStep: 1, targets: ['src/scheduler.ts', 'src/db.ts'] },
      { verdict: 'REVERT', planStep: 1, targets: ['src/reverted.ts'] },
      { verdict: 'KEEP', planStep: 2, targets: ['src/another-step.ts'] },
    ];
    assert.strictEqual(s.plan.current().findings, undefined, 'the model recorded nothing');

    const digest = s.plan.digest(1200, { session: s });
    const rec = s.plan.current().findings;
    assert.deepStrictEqual(rec.landed, ['src/scheduler.ts', 'src/db.ts'],
      'what the transaction ledger says was KEPT, for THIS step');
    assert.match(digest, /LANDED/, 'and it reaches the model');

    // A CHANGE THAT WAS REVERTED DID NOT LAND. Reporting it would be worse than
    // silence: the model would skip re-doing work that is not there.
    assert.ok(!rec.landed.includes('src/reverted.ts'));
    // AND ANOTHER STEP'S WORK IS NOT THIS STEP'S.
    assert.ok(!rec.landed.includes('src/another-step.ts'));
  });

  await test('DERIVED: it adds to what the model said rather than replacing it', () => {
    const { Session } = require('../../src/session');
    const s = new Session({ cwd: process.cwd() });
    s.plan = planWithStep();
    findings.record(s.plan.current(), {
      settled: ['tracked stall = cancel'],
      landed: ['the schema, by hand'],
      remaining: ['sweeps'],
    });
    s.mutationReceipts = [{ verdict: 'KEEP', planStep: 1, targets: ['src/scheduler.ts'] }];

    findings.derive(s, s.plan.current());
    const rec = s.plan.current().findings;
    assert.ok(rec.landed.includes('the schema, by hand'), "the model's own record survives");
    assert.ok(rec.landed.includes('src/scheduler.ts'), "and Core's is added to it");
    // JUDGEMENTS STAY THE MODEL'S. Nothing in a receipt can say what a decision
    // was, and a machine inventing one would be guessing at intent.
    assert.deepStrictEqual(rec.settled, ['tracked stall = cancel']);
    assert.deepStrictEqual(rec.remaining, ['sweeps']);
  });

  await test('CLOSE: an interrupted turn has no record, and that is not an exception', async () => {
    // ---- THE LATENT DEFECT ON THE CTRL+C PATH ---------------------------
    //
    // `record` is set when a turn yields `done`. A turn cancelled with Ctrl+C
    // never gets there and arrives as `null` — and every branch of the close
    // asks the record a question. PRE-EXISTING (app.js read `record.text` and
    // `record.stopReason` unguarded in the same order before this code moved),
    // and the one moment it can fire is the moment a person has just pressed
    // Ctrl+C, where an exception is the last thing wanted.
    const close = require('../../src/submitclose');
    const app = { wantExit: false, drainSteers: () => [], session: { lifecycle: null }, ui: { enabled: false }, events: { emit() {} } };
    assert.strictEqual(await close.after(app, null, 'anything'), null, 'a cancelled turn closes quietly');

    // BUT THE STEER QUEUE IS STILL DRAINED. A sentence typed while the turn was
    // working is the user's own text; cancelling the work it was aimed at does
    // not forfeit it.
    let sent = null;
    const withSteer = {
      ...app,
      drainSteers: () => ['also check the logs'],
      submit: (t, o) => { sent = { t, o }; return 'resubmitted'; },
    };
    assert.strictEqual(await close.after(withSteer, null, 'anything'), 'resubmitted');
    assert.strictEqual(sent.t, 'also check the logs');
    assert.strictEqual(sent.o.from, 'steer', 'and it is delivered as the user\'s own text');

    // AND A REAL RECORD STILL GOES THROUGH EVERY BRANCH.
    const rec = { text: 'finished', stopReason: 'end' };
    assert.strictEqual((await close.after(app, rec, 'x')).text, 'finished');
  });

  await test('POLICY: the prompt says to stop reading once the reading is done', () => {
    // §23. The policy is the half a mechanism cannot supply: non-progress
    // detection catches the SAME read repeated, and this catches the endless
    // sequence of DIFFERENT reads that each look reasonable alone.
    const prompt = require('../../src/prompt');
    const built = prompt.build({ cwd: process.cwd(), platform: process.platform, model: 'm', separate: true });
    const all = `${built.stable}\n${built.live}`;
    assert.match(all, /WHEN THE READING IS DONE, PATCH/);
    // IT NAMES THE SENTENCES A LOOP TELLS ITSELF, because a general instruction
    // to "be efficient" is one every loop already believes it is following.
    for (const excuse of ['exact idiom', 'one more look', 'anchors', 'decisive batch']) {
      assert.ok(all.includes(excuse), `the policy names "${excuse}" as a non-reason`);
    }
    // AND IT LEAVES A REAL QUESTION A WAY THROUGH — the rule is "name it", not
    // "never read again", which would be a worse failure in the other direction.
    assert.match(all, /CONCRETE UNRESOLVED QUESTION/);
  });
};
