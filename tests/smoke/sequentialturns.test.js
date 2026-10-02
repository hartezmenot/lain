'use strict';

/**
 * A PROMPT AFTER DONE IS A NEW TURN — in a real terminal, with no restart.
 *
 * Evidence tier: REAL_TTY_VERIFIED (see tests/tty/realtty.js). SKIPS, and says
 * so, when no pseudo-console driver is configured — that is not a pass.
 *
 * THE REPORTED FAILURE: after DONE, typing a new prompt and pressing Enter did
 * nothing; DONE stayed; only restarting LAIN helped. Measured in the real
 * session (route glm-5.3-free) it was two defects that read as one:
 *
 *   AN EMPTY PROVIDER REPLY SETTLED AS DONE. 53K input tokens, 0 output, no
 *     text, no calls — and turn.js ended the turn normally. Every next prompt
 *     got another instant, identical DONE.
 *   THE FEED MERGED THE PROMPTS. Two user messages with nothing between them
 *     drew as ONE block, so the new prompt appeared as a continuation line of
 *     the old one — `❯ reply with second` / `  reply with third` — and looked
 *     swallowed.
 *
 * Run against the pre-repair turn.js and feed.js, case 1 times out waiting for
 * SECOND_REPLY and case 1's screen shows the merged block.
 *
 * Case 2 is the acceptance sequence from the brief: three prompts, /goal,
 * a prompt, /model, a prompt, a rate-limit wait that recovers, a prompt, an
 * interrupt, a prompt — one process, no /resume.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');
const tty = require('../tty/realtty');

const text = (snap) => tty.visible(snap);
const rows = (snap) => snap.text.map((l) => l.trim());
/** The live row: the one row that ends in the work clock. */
const liveRow = (snap) => snap.text.find((l) => /\d\d:\d\d:\d\d\s*$/.test(l)) || '';
/** The work clock at the right of the live row, e.g. `00:00:02`. */
const clock = (snap) => { const m = /(\d\d:\d\d:\d\d)\s*$/.exec(liveRow(snap)); return m ? m[1] : null; };

/** A prompt is its OWN anchor row: `USER · <prompt>`, one row per message. */
function assertOwnBlock(snap, prompt) {
  const r = rows(snap);
  const at = r.findIndex((l) => new RegExp(`^USER[A-Z ]* · ${prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(l));
  assert.ok(at >= 0, `${snap.name}: "${prompt}" is on screen as its own user anchor:\n${text(snap)}`);
}

function trace() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lain-seq-')), 'admission.jsonl');
  return { file, events: () => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } } };
}

module.exports = async function () {
  const probe = tty.available();
  if (!probe.ok) {
    await test('SEQUENTIAL TURNS: skipped — no pseudo-console driver', () => {
      process.stdout.write(`    (skipped: ${probe.why}; set LAIN_TTY_PYTHON to a Python with pywinpty and pyte)\n`);
    });
    return;
  }

  await test('SEQUENTIAL TURNS: A → DONE, B after an empty reply is a visible new turn, C too', async () => {
    const t = trace();
    const out = await tty.runTty({
      cols: 110, rows: 34, env: { LAIN_TRACE_ADMISSION: t.file },
      // The observed shape: the provider answers B with nothing at all.
      script: [{ text: 'FIRST_REPLY' }, { text: '' }, { text: 'SECOND_REPLY' }, { text: 'THIRD_REPLY' }],
      steps: [
        { until: 'Ask LAIN', timeout: 40000 },
        { send: 'reply with first\r' }, { until: 'FIRST_REPLY', timeout: 30000 }, { snap: 'A', settle: 1200 },
        { send: 'reply with second\r' }, { until: 'SECOND_REPLY', timeout: 20000 }, { snap: 'B', settle: 1200 },
        { send: 'reply with third\r' }, { until: 'THIRD_REPLY', timeout: 20000 }, { snap: 'C', settle: 1200 },
      ],
    });
    assert.deepStrictEqual(out.timeouts, [], `every prompt produced its answer:\n${out.snaps.map(text).join('\n----\n')}`);
    const { A, B, C } = out.byName;
    assert.match(liveRow(A), /DONE/);
    assertOwnBlock(B, 'reply with second');
    assertOwnBlock(C, 'reply with second');
    assertOwnBlock(C, 'reply with third');
    assert.match(text(C), /THIRD_REPLY/);
    // THE RUNTIME HALF: each Enter reached submit and made a new turn.
    const begins = t.events().filter((e) => e.event === 'submit:begin');
    assert.deepStrictEqual(begins.map((e) => e.state.turns), [0, 1, 2], 'three submissions, three new turns');
    for (const e of begins) assert.strictEqual(e.state.abort, 'live', 'each submission owns a live turn');
    const settled = t.events().filter((e) => e.event === 'submit:settled');
    for (const e of settled) assert.strictEqual(e.state.abort, null, 'and releases it when it settles');
  });

  await test('SEQUENTIAL TURNS: the acceptance sequence — prompts, /goal, /model, rate limit, interrupt — no restart', async () => {
    const t = trace();
    const out = await tty.runTty({
      cols: 110, rows: 34, env: { LAIN_TRACE_ADMISSION: t.file },
      script: [
        { text: 'R_FIRST' }, { text: 'R_SECOND' }, { text: 'R_THIRD' },
        { text: 'R_AFTER_GOAL' }, { text: 'R_AFTER_MODEL' },
        { text: 'looking', tool_calls: [{ name: 'read_file', input: { path: 'missing.txt' } }], delayMs: 2500 },
        { error: { status: 429, message: 'rate limited', retryAfter: 5 } },
        { text: 'R_RECOVERED' },
        { text: 'R_AFTER_RECOVERY' },
        { text: 'R_NEVER', delayMs: 8000 },
        { text: 'R_AFTER_CANCEL' },
      ],
      steps: [
        { until: 'Ask LAIN', timeout: 40000 },
        { send: 'reply with first\r' }, { until: 'R_FIRST', timeout: 20000 }, { snap: 'first', settle: 1200 },
        { send: 'reply with second\r' }, { until: 'R_SECOND', timeout: 20000 }, { snap: 'second', settle: 1200 },
        { send: 'reply with third\r' }, { until: 'R_THIRD', timeout: 20000 }, { snap: 'third', settle: 1200 },
        { send: '/goal\r' }, { snap: 'goal', settle: 1500 }, { key: 'escape' }, { snap: 'goalclosed', settle: 800 },
        { send: 'after goal\r' }, { until: 'R_AFTER_GOAL', timeout: 20000 }, { snap: 'aftergoal', settle: 1200 },
        { send: '/model\r' }, { snap: 'model', settle: 1500 }, { key: 'escape' }, { snap: 'modelclosed', settle: 800 },
        { send: 'after model\r' }, { until: 'R_AFTER_MODEL', timeout: 20000 }, { snap: 'aftermodel', settle: 1200 },
        { send: 'hit the limit\r' }, { until: 'Rate limited', timeout: 20000 },
        { snap: 'waiting', settle: 400 }, { wait: 2000 }, { snap: 'waiting2', settle: 100 },
        { until: 'R_RECOVERED', timeout: 30000 }, { snap: 'recovered', settle: 1200 },
        { send: 'after recovery\r' }, { until: 'R_AFTER_RECOVERY', timeout: 20000 }, { snap: 'afterrecovery', settle: 1200 },
        { send: 'slow one\r' }, { snap: 'slow', settle: 2500 }, { key: 'ctrl-c' }, { snap: 'interrupted', settle: 1500 },
        { send: 'after cancel\r' }, { until: 'R_AFTER_CANCEL', timeout: 20000 }, { snap: 'aftercancel', settle: 1200 },
      ],
    });
    assert.deepStrictEqual(out.timeouts, [], `every step completed:\n${out.snaps.map((s) => `== ${s.name}\n${text(s)}`).join('\n')}`);
    const s = out.byName;

    for (const [name, prompt] of [['second', 'reply with second'], ['third', 'reply with third'], ['aftergoal', 'after goal'],
      ['aftermodel', 'after model'], ['afterrecovery', 'after recovery'], ['aftercancel', 'after cancel']]) {
      assertOwnBlock(s[name], prompt);
      assert.match(liveRow(s[name]), /DONE/, `${name}: settles DONE`);
    }

    // /goal with no goal is `GOAL › _` — the composer label, and nothing narrated.
    assert.match(text(s.goal), /GOAL ›/, 'the composer says what the line is for');
    assert.ok(!/GOAL ›/.test(text(s.goalclosed)), 'Esc gives the line back');
    assert.match(text(s.goalclosed), /Ask LAIN/);
    assert.ok(!/GOAL ›|What are you trying to achieve/.test(text(s.aftergoal)), 'and nothing about it lingers under later turns');

    // ONE CLOCK: it pauses in the rate-limit wait, and every new turn starts at zero.
    assert.strictEqual(clock(s.waiting), clock(s.waiting2), 'the work clock holds still while waiting for the limit');
    assert.match(liveRow(s.waiting2), /Rate limited/);
    assert.match(liveRow(s.recovered), /DONE/, 'the wait recovers to DONE');
    for (const name of ['second', 'third', 'aftergoal', 'aftermodel', 'afterrecovery', 'aftercancel']) {
      assert.strictEqual(clock(s[name]), '00:00:00', `${name}: a quick new turn does not inherit an earlier turn's time`);
    }
    for (const snap of out.snaps) {
      assert.ok((text(snap).match(/\d\d:\d\d:\d\d\s*$/gm) || []).length <= 1, `${snap.name}: exactly one work clock on screen`);
      // NO TELEMETRY CLUSTER: the header carries this response's output only.
      assert.ok(!/[↑⚡↓]\s*\d/.test(text(snap)), `${snap.name}: no ↑/⚡/↓ token cluster on the primary surface`);
    }

    assert.match(liveRow(s.interrupted), /Interrupted/);
    assert.ok(!/R_NEVER/.test(text(s.aftercancel)), 'the interrupted turn did not finish behind the next one');

    const events = t.events();
    const begins = events.filter((e) => e.event === 'submit:begin');
    assert.strictEqual(begins.length, 9, 'nine prompts, nine submissions');
    // `input:queued` is the ordinary idle path into the dispatch loop; a STEER
    // is what a line typed at a turn that never ended would have become.
    assert.deepStrictEqual(events.filter((e) => e.event === 'input:steer'), [],
      'no prompt was mistaken for a steer on a turn that had already ended');
    assert.strictEqual(events.filter((e) => e.event === 'queue:dequeue').length,
      events.filter((e) => e.event === 'input:queued').length, 'every queued line was taken off the queue');
  });
};
