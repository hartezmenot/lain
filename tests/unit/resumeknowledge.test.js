'use strict';

/**
 * RESUMING MUST NOT RESET WHAT LAIN ALREADY KNOWS.
 *
 * ------------------------------------------------------------------------
 * THE LOOP THIS GUARDS, and it is the expensive one.
 *
 * A session reads a project, settles some facts, and then crosses a boundary —
 * `/resume`, a new process, a context compaction. If the evidence goes with the
 * conversation, the next turn starts blind: grep, sed, read_file, grep, sed,
 * rediscovering the same facts from the same unchanged files. That is the
 * Step-740 shape, and it costs a whole budget while looking like work.
 *
 * Four things must survive, and each is owned by a different module, which is
 * exactly why this is tested together rather than four times separately:
 *
 *   READ RECEIPTS       readreceipts.js — what was read, and the fingerprint
 *   NON-PROGRESS STATE  progress.js — how many times, under what state
 *   PLAN STEP FINDINGS  planfindings.js — what the step established (§22)
 *   THE PROJECT INDEX   projectindex.js — on disk, keyed by size+mtime
 *
 * ------------------------------------------------------------------------
 * AND IT MUST STILL NOTICE A REAL CHANGE. Knowledge that survives a file edit
 * is not knowledge, it is a stale cache — so both halves are asserted.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const { Session } = require('../../src/session');

/** A small real TypeScript project, written to disk. */
function project() {
  const root = tmpdir('resume-know-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'sched.ts'), [
    'import { Db } from "./db";',
    'export interface StallPolicy { tracked: "cancel" | "pause"; grace: number }',
    'export async function handleStalled(db: Db, id: string): Promise<void> { await db.mark(id); }',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'db.ts'), 'export class Db { async mark(id: string): Promise<void> {} }\n');
  return root;
}

module.exports = async function () {
  await test('RESUME: the project index reloads instead of reparsing an unchanged tree', () => {
    const projectindex = require('../../src/projectindex');
    const root = project();

    const cold = projectindex.refresh(root);
    assert.strictEqual(cold.persisted, true, 'the index reaches disk');
    assert.ok(fs.existsSync(path.join(root, '.lain', 'index.json')));

    // A SECOND PASS — which is what a resume, a restart or the next turn does.
    // `reused` is the number NOT reparsed, and it must be all of them.
    const warm = projectindex.refresh(root);
    assert.strictEqual(warm.reused, warm.scanned,
      `an unchanged tree must reparse nothing: ${warm.scanned - warm.reused} file(s) were reparsed`);

    // AND THE ANSWERS ARE STILL THERE — reuse that loses the symbols is just a
    // faster way of knowing nothing.
    assert.strictEqual(projectindex.definitionsOf(warm.index, 'handleStalled').length, 1);
    assert.strictEqual(projectindex.definitionsOf(warm.index, 'StallPolicy').length, 1);
    assert.deepStrictEqual(projectindex.importersOf(warm.index, 'src/db.ts'), ['src/sched.ts']);

    // ---- AND A REAL EDIT IS STILL NOTICED --------------------------------
    fs.appendFileSync(path.join(root, 'src', 'db.ts'), '\nexport const VERSION = 2;\n');
    const after = projectindex.refresh(root);
    assert.strictEqual(after.scanned - after.reused, 1, 'exactly the edited file is reparsed');
    assert.strictEqual(projectindex.definitionsOf(after.index, 'VERSION').length, 1, 'and the new symbol is found');
  });

  await test('RESUME: read receipts and non-progress state cross the session boundary', () => {
    const root = project();
    const file = path.join(root, 'src', 'sched.ts');
    const s = new Session({ cwd: root });

    // A READ HAPPENS, and is recorded the way the gate records one.
    const progress = require('../../src/progress');
    const before = progress.before(s, 'read_file', { path: file }, { cwd: root });
    progress.after(s, 'read_file', { path: file }, { output: fs.readFileSync(file, 'utf8') }, before, { toolCallId: 'c1' });
    const receiptsBefore = require('../../src/readreceipts').toJSON(s.evidence).length;
    assert.ok(receiptsBefore > 0, 'the read left a receipt');

    // THE SESSION CROSSES A BOUNDARY: written, and restored as a new object.
    s.save();
    const back = Session.resume(s.id);
    assert.ok(back, 'the session came back');

    // THE RECEIPTS CAME WITH IT …
    assert.strictEqual(require('../../src/readreceipts').toJSON(back.evidence).length, receiptsBefore,
      'a resumed session must not start blind — the receipts are the reason it can answer without re-reading');
    // … AND SO DID WHAT IT HAD ALREADY SEEN, which is what makes the SECOND
    // read of an unchanged file recognisable as a repeat rather than as news.
    assert.deepStrictEqual(Object.keys(back.progress.seen), Object.keys(s.progress.seen));

    try { require('../../src/sessionstore').forget(s.id); } catch { /* best effort */ }
  });

  await test('RESUME: a step\'s findings survive, so the step is not re-derived', () => {
    // §22, through the real persistence path rather than a JSON round trip.
    const { Plan } = require('../../src/plan');
    const findings = require('../../src/planfindings');
    const root = project();
    const s = new Session({ cwd: root });
    s.plan = new Plan('fix stalled downloads');
    s.plan.addSteps(['schema + setting', 'scheduler', 'sweeps', 'tests']);
    findings.record(s.plan.current(), {
      settled: ['tracked stall = cancel', '409 prevents paused retry'],
      landed: ['schema', 'setting'],
      remaining: ['sweeps', 'tests'],
      evidence: ['src/sched.ts:handleStalled'],
    });
    s.save();

    const back = Session.resume(s.id);
    const rec = back.plan.current().findings;
    assert.deepStrictEqual(rec.settled, ['tracked stall = cancel', '409 prevents paused retry']);
    assert.deepStrictEqual(rec.remaining, ['sweeps', 'tests']);
    // AND IT REACHES THE MODEL, which is the only reason any of it was kept.
    assert.match(back.plan.digest(1200), /already established/);
    assert.match(back.plan.digest(1200), /409 prevents paused retry/);

    try { require('../../src/sessionstore').forget(s.id); } catch { /* best effort */ }
  });
};
