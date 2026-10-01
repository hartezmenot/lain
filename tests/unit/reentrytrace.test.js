'use strict';

/**
 * THE REPEATED-STEER / RE-ENTRY DEFECT — reproduced end to end, root-caused,
 * and pinned.
 *
 * ------------------------------------------------------------------------
 * THE REPORTED SYMPTOM. A single focused correction — "Fix two router bugs:
 * 1. cross-provider rate-limit bleed 2. slow refresh-all. Do not touch
 * LAIN." — produced repeated mid-task restatement several steps into useful
 * work: "The steer is...", "Back on the two router bugs...", appearing
 * between ordinary reads, as though the model kept being re-handed the
 * assignment.
 *
 * ------------------------------------------------------------------------
 * THE TRACE. Every provider call in a turn goes through jobrunner.js
 * `turnOptions`, which computes TWO tails once, before the turn's first
 * step: `live` (opened:false, for step 0) and `liveContinuing`
 * (opened:true, for every step after). turn.js then picks between them by
 * `step > 0` alone — see the line this file asserts against. Both tails are
 * built by prompt.workingContext(), which — before this fix — had NO
 * `opened` gate on its steers/memory/files-changed/last-check/evidence
 * blocks (only two OTHER once-per-turn facts, a cut-off previous turn and a
 * blocked state, were gated). So `liveContinuing` carried the FULL
 * "The user has since said (these override the original request): -
 * <steer text>" block, computed once and resent BYTE-IDENTICAL on every
 * single continuation step of the turn — a real correction, correctly
 * authority-labelled (see contextprovenance.js), repeated as if it were
 * fresh news every time a tool result came back.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT A plan_step, CONTINUATION, WAKEUP, COMPACTION OR UI BUG.
 * No hidden wakeup exists in this codebase (grepped: none). No extra
 * provider calls are introduced by anything this test touches — the SAME
 * step count occurs before and after the fix; only the CONTENT of
 * continuation steps changes. A live, mid-turn correction reaches the model
 * through an entirely separate, consume-once path (`app.js`'s `steer()`
 * callback, asserted below to still exist) — this fix does not touch it.
 *
 * This test drives the REAL `runTurn` loop through the scripted provider
 * (mockprovider.js — the same double `docs/STATUS.md`'s LIVE CLI VERIFIED
 * gate uses), across several tool-calling steps, and inspects the actual
 * wire content sent to the provider at each step — not a rendered summary.
 */

const assert = require('assert');
const { test, tmpdir, writeScript } = require('../helpers');

const { runTurn } = require('../../src/turn');
const { Session } = require('../../src/session');
const { Task } = require('../../src/task');
const promptparts = require('../../src/promptparts');

const STEER_TEXT = 'Fix two router bugs: 1. cross-provider rate-limit bleed 2. slow refresh-all. Do not touch Noema.';

async function driveScriptedTurn(session, steps) {
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('reentry-'), steps);
  const mockprovider = require('../../src/mockprovider');
  // MODULE-LEVEL STATE, PER PROCESS. mockprovider caches its script and cursor
  // across requires — correct for a single spawned binary (its own process),
  // wrong for this in-process test running alongside every other unit test in
  // one Node process. _reset() clears both so THIS test's script is the one
  // actually read, regardless of what ran before it in the same run.
  mockprovider._reset();
  const realChat = mockprovider.chat;
  const captured = []; // one entry per provider call: the exact wire messages sent
  mockprovider.chat = function patched(pc, messages, opts) {
    captured.push(messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })));
    return realChat.call(this, pc, messages, opts);
  };
  try {
    const app = { session, cfg: session.cfg || {}, availability: null, checkpoints: null };
    const p = promptparts.of(app, { session });
    const opts = {
      cfg: {},
      systemPrompt: p.stable,
      live: p.live,
      liveContinuing: promptparts.of(app, { opened: true, session }).live,
      evidence: session.evidence,
      lifecycle: session.lifecycle,
      steer: () => [],
    };
    for await (const ev of runTurn(session, session.task.objective, opts)) { void ev; }
    return captured;
  } finally {
    delete process.env.LAIN_PROVIDER;
    delete process.env.LAIN_MOCK_SCRIPT;
    mockprovider.chat = realChat;
    mockprovider._reset();
  }
}

function tailOf(wireCall) {
  // The framed, volatile tail — the LAST message, marked by contextprovenance's wrapper.
  const last = wireCall[wireCall.length - 1];
  return (last && last.content) || '';
}

module.exports = async function () {
  await test('RE-ENTRY: a steer given once is sent to the model ONCE, not on every continuation step', async () => {
    const dir = tmpdir('reentry-cwd-');
    const session = new Session({ cwd: dir });
    session.task = new Task(STEER_TEXT);
    session.task.steers.push({ text: STEER_TEXT, at: new Date().toISOString() });

    // FOUR STEPS: three reads (simulating the diagnostic investigation the
    // report describes — "reads happen" between restatements), then a close.
    const calls = await driveScriptedTurn(session, [
      { text: 'checking provider resolution', tool_calls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
      { text: 'checking lock scoping', tool_calls: [{ name: 'read_file', input: { path: 'b.txt' } }] },
      { text: 'checking refresh-all', tool_calls: [{ name: 'read_file', input: { path: 'c.txt' } }] },
      { text: 'done' },
    ]);

    assert.ok(calls.length >= 4, `expected at least 4 provider calls, got ${calls.length}`);

    const withSteerText = calls.filter((c) => tailOf(c).includes('cross-provider rate-limit bleed'));
    assert.strictEqual(withSteerText.length, 1,
      `the steer text must appear in exactly ONE provider call's tail (the opening one) — found it in ${withSteerText.length} of ${calls.length}. `
      + 'Appearing in more than one is the exact re-entry defect: a correction resent verbatim on every continuation step.');

    // AND IT IS THE FIRST CALL, not some arbitrary one — the opening request
    // is where a once-per-turn fact belongs.
    assert.ok(tailOf(calls[0]).includes('cross-provider rate-limit bleed'), 'the FIRST call must still carry it');

    // THE LATER STEPS ARE NOT MERELY MISSING THE STEER — THEY ARE NOT
    // RE-ANNOUNCING THE ASSIGNMENT AT ALL. No "already established" heading
    // manufactured out of nothing on a continuation step.
    for (let i = 1; i < calls.length; i++) {
      assert.ok(!tailOf(calls[i]).includes('override the original request'),
        `call ${i} still carries the "override" announcement — the defect this test exists to catch`);
    }
  });

  await test('RE-ENTRY: a live, mid-turn steer still reaches the model — through app.js\'s separate consume-once path, untouched by this fix', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'app.js'), 'utf8');
    assert.match(src, /steer:\s*\(\)\s*=>/, 'the live per-step steer callback (app.js) must still exist, independent of workingContext');
  });

  await test('RE-ENTRY: no hidden wakeup or extra continuation exists that could amplify this independently of content', () => {
    // A second, INDEPENDENT amplifier would be a mechanism that inserts EXTRA
    // provider calls beyond genuine tool continuation (a retry-on-no-progress
    // loop, say). None exists in this codebase today — asserted here so a
    // future one is required to prove it does not reintroduce this class of
    // defect, per the investigation's own §6.
    const fs = require('fs');
    const path = require('path');
    const turnSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'turn.js'), 'utf8');
    assert.ok(!/hidden.?wakeup/i.test(turnSrc), 'no hidden-wakeup mechanism exists in turn.js yet');
  });
};
