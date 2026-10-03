'use strict';

/**
 * A MODEL TURN IS NOT A TASK (2026-09-29) — the ending is classified, and the
 * task carries on across model boundaries unless there is a real reason to stop.
 *
 *   - every stop reason maps to one of ten outcomes (turnoutcome.js)
 *   - NORMAL continues the approved plan by itself; PHASED stops for review;
 *     LONG_CONTEXT continues and compacts at the boundary
 *   - recoverable tool errors (a missing temp file, a stale evidence id, a
 *     delegate role in the wrong case) never pause the task; the next
 *     instruction names them so the model does not repeat them
 *   - the budget: two continuations without progress, three provider restarts
 *     (20 s · 60 s · 180 s), two crash resumes — then the PERSON is asked,
 *     never a failure; anything a person does resets it
 *   - a person's stop, a question, a blocking finding, a refusal, a step cap
 *     they configured, a quota: the task stops, as before
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const T = require('../../src/turnoutcome');
  const ac = require('../../src/autocontinue');
  const rs = require('../../src/runstrategy');
  const wb = require('../../src/workbench');
  const { Session } = require('../../src/session');

  const session = (steps = ['Scaffold the crate', 'Tree view', 'Preview', 'Inspector', 'Timeline', 'Run cargo test', 'Report', 'Live smoke'], done = 4) => {
    const s = new Session({ cwd: tmpdir('autocont-') });
    require('../../src/plan').seedFromCore(s, { objective: 'Game Decoder inspector', remaining: steps });
    for (let i = 0; i < done; i++) s.plan.complete(`step ${i + 1}`);
    return s;
  };
  const turn = (o = {}) => ({ stopReason: 'end', from: null, toolCalls: 3, errors: [], mutations: [], ...o });
  const toolErr = (tool, message, extra = {}) => ({ kind: 'TOOL', tool, message: `${tool}: ${message}`, ...extra });

  await test('CLASSIFY: every ending is one of ten outcomes, and only four may carry on', () => {
    const s = session();
    const c = (rec, o = {}) => T.classify(rec, { session: s, ...o }).outcome;
    assert.strictEqual(c(turn()), 'COMPLETED');
    assert.strictEqual(c(turn({ errors: [toolErr('file_info', 'no such file: /tmp/p45.log')] })), 'TOOL_RECOVERABLE');
    assert.strictEqual(c(turn({ stopReason: 'aborted' })), 'CANCELLED');
    assert.strictEqual(c(turn({ stopReason: 'aborted' }), { hostClosing: true }), 'HOST_CRASH');
    assert.strictEqual(c(turn({ stopReason: 'crashed' })), 'HOST_CRASH');
    assert.strictEqual(c(turn({ stopReason: 'rate-limited', providerFailure: { kind: 'QUOTA' } })), 'QUOTA_EXHAUSTED');
    assert.strictEqual(c(turn({ stopReason: 'rate-limited', providerFailure: { kind: 'RATE_LIMITED' } })), 'PROVIDER_RATE_LIMIT');
    assert.strictEqual(c(turn({ stopReason: 'provider', providerFailure: { kind: 'UNAVAILABLE' } })), 'PROVIDER_CRASH');
    assert.strictEqual(c(turn({ stopReason: 'provider', providerFailure: { kind: 'AUTH' } })), 'NEEDS_USER_DECISION');
    assert.strictEqual(c(turn({ stopReason: 'max-steps' })), 'EXPLICIT_PAUSE', 'a cap the person set is honoured');
    assert.strictEqual(c(turn({ stopReason: 'refused' })), 'NEEDS_USER_DECISION');
    assert.strictEqual(c(turn({ stopReason: 'no-credential' })), 'NEEDS_USER_DECISION');
    assert.strictEqual(c(turn({ errors: [toolErr('run_bash', 'DENIED by you', { denied: true })] })), 'NEEDS_USER_DECISION', 'a refusal the person gave, last');
    assert.strictEqual(c(null), 'CANCELLED');
    const gone = new Session({ cwd: require('path').join(tmpdir('autocont-gone-'), 'nope') });
    assert.strictEqual(T.classify(turn(), { session: gone }).outcome, 'TOOL_FATAL', 'the project folder is missing');
    assert.deepStrictEqual([...T.CONTINUABLE].sort(), ['COMPLETED', 'HOST_CRASH', 'PROVIDER_CRASH', 'TOOL_RECOVERABLE']);
  });

  await test('NORMAL: an eight-phase plan at phase 5 carries on by itself — no "each request is its own run"', () => {
    const s = session();
    assert.strictEqual(rs.get(s).kind, 'NORMAL');
    const d = rs.afterPhase(s, [], { record: turn({ from: 'phase-continue' }), planDoneBefore: 3 });
    assert.strictEqual(d.continue, true, d.why);
    assert.strictEqual(d.cause, 'phase-continue');
    assert.match(d.prompt, /phase 5 — Timeline/);
    assert.ok(!/each request is its own run/.test(JSON.stringify(d)));
  });

  await test('RECOVERABLE: a missing temp file, a stale evidence id and a wrong delegate role do not pause the task', () => {
    const s = session();
    const rec = turn({ from: 'phase-continue', errors: [
      toolErr('file_info', 'no such file: /tmp/p45.log'),
      toolErr('recall_evidence', 'no evidence R274 in this session'),
      toolErr('delegate', 'DELEGATION REFUSED: role must be one of SCOUT, FOUNDATION, IMPLEMENTER, VERIFIER, RESEARCHER'),
    ] });
    const cls = T.classify(rec, { session: s });
    assert.strictEqual(cls.outcome, 'TOOL_RECOVERABLE');
    const d = rs.afterPhase(s, [], { record: rec, cls, planDoneBefore: 3 });
    assert.strictEqual(d.continue, true, d.why);
    assert.match(d.prompt, /failed tool calls/, 'the next instruction names what failed');
    assert.match(d.prompt, /Do not repeat a call that failed/);
  });

  await test('BUDGET: two continuations without progress, then the PERSON is asked (paused, never failed); a person resets it', () => {
    const s = session();
    const idle = () => turn({ from: 'phase-continue', toolCalls: 0 });
    const r1 = rs.afterPhase(s, [], { record: idle(), planDoneBefore: 4 });
    const r2 = rs.afterPhase(s, [], { record: idle(), planDoneBefore: 4 });
    const r3 = rs.afterPhase(s, [], { record: idle(), planDoneBefore: 4 });
    assert.deepStrictEqual([r1.continue, r2.continue, r3.continue], [true, true, false]);
    assert.ok(r3.needsUser);
    assert.match(r3.why, /no progress on step 5/);
    // THE PERSON TYPES: the budget starts again.
    const r4 = rs.afterPhase(s, [], { record: turn({ from: null, toolCalls: 0 }), planDoneBefore: 4 });
    assert.strictEqual(r4.continue, true);
    assert.ok(ac.view(s).log.length >= 3, 'every automatic continuation is logged with its cause');
    assert.strictEqual(ac.view(s).last.cause, 'phase-continue');
  });

  await test('PROVIDER CRASH: restarts 3 times (20 s · 60 s · 180 s) when a plan has work left; a plain request is the person\'s to retry', () => {
    const s = session();
    const crash = () => turn({ stopReason: 'provider', from: 'provider-restart', toolCalls: 0, providerFailure: { kind: 'UNAVAILABLE', message: '503' } });
    const ds = [1, 2, 3, 4].map(() => rs.afterPhase(s, [], { record: crash(), planDoneBefore: 4 }));
    assert.deepStrictEqual(ds.map((d) => d.continue), [true, true, true, false]);
    assert.deepStrictEqual(ds.slice(0, 3).map((d) => d.delayMs), [20000, 60000, 180000]);
    assert.match(ds[3].why, /kept failing/);
    const plain = new Session({ cwd: tmpdir('autocont-plain-') });
    assert.strictEqual(rs.afterPhase(plain, [], { record: crash() }).continue, false, 'no plan: no automatic restart');
  });

  await test('STOPS: a person\'s stop, a blocking finding, a question, PHASED review, a finished plan', () => {
    const s = session();
    assert.strictEqual(rs.afterPhase(s, [], { record: turn({ stopReason: 'aborted' }) }).continue, false);
    assert.strictEqual(rs.afterPhase(s, ['blocking finding: two incompatible designs'], { record: turn() }).continue, false);
    s.lifecycle = { state: 'NEEDS_USER' };   // what lifecycle.needsUser('choose A or B') leaves behind
    assert.strictEqual(rs.afterPhase(s, [], { record: turn() }).outcome, 'NEEDS_USER_DECISION');
    const p = session(); rs.set(p, 'PHASED');
    assert.match(rs.afterPhase(p, [], { record: turn() }).why, /Phased/);
    const done = session(['a', 'b'], 2);
    const f = rs.afterPhase(done, [], { record: turn() });
    assert.deepStrictEqual([f.continue, f.complete], [false, true]);
  });

  await test('LONG CONTEXT: continues and marks the boundary for compaction; the review policy still applies', () => {
    const s = session();
    rs.set(s, 'LONG_CONTEXT', 'EVERY_3');
    const ds = [1, 2, 3].map(() => rs.afterPhase(s, [], { record: turn({ from: 'phase-continue' }), planDoneBefore: 3 }));
    assert.deepStrictEqual(ds.map((d) => d.continue), [true, true, false]);
    assert.strictEqual(ds[0].compact, true);
    assert.match(ds[2].why, /every 3 phases/);
  });

  await test('HOST CRASH: a recovered Coding turn resumes (twice without progress at most); a Telegram turn does not', () => {
    const s = session();
    s.recovered = { turnId: 'tx', step: 3, calls: 5, from: null, lastActiveAt: Date.now() };
    const d = ac.onRecovered(s);
    assert.strictEqual(d.continue, true, d.why);
    assert.strictEqual(d.cause, 'auto-resume');
    assert.match(d.prompt, /stopped mid-turn/);
    assert.match(d.prompt, /phase 5/);
    assert.strictEqual(ac.onRecovered(s).continue, false, 'decided once per recovery');
    const tg = session();
    tg.recovered = { turnId: 'ty', step: 1, from: 'messaging', lastActiveAt: Date.now() };
    assert.strictEqual(ac.onRecovered(tg).continue, false);
  });

  await test('PERSISTENCE: the budget and its log survive save and resume', () => {
    const s = session();
    rs.afterPhase(s, [], { record: turn({ from: 'phase-continue', toolCalls: 0 }), planDoneBefore: 4 });
    s.save();
    const back = Session.resume(s.id);
    assert.strictEqual(wb.of(back).autoRun.noProgress, 1);
    assert.strictEqual(ac.view(back).last.cause, 'phase-continue');
  });
};
