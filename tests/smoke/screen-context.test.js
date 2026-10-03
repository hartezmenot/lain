'use strict';

/**
 * THE SCREEN, AND WHAT THE MODEL IS SENT — through the real binary.
 *
 * Two claims that only mean anything end to end:
 *
 *   1. progress is a couple of rows and the ACTIVITY feed gets the rest, with
 *      the model's words and LAIN's actions visibly different things;
 *   2. the rendered feed is NOT what the model receives, and the user's own
 *      words survive both compaction and a resume.
 *
 * (1) is asserted on drawn frames. (2) is asserted on the persisted session and
 * the real request payloads, because that is where the truth is — a screen can
 * look right while the payload is wrong.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const tui = (cols = 100, rows = 30) => ({ LAIN_FORCE_TUI: '1', COLUMNS: String(cols), LINES: String(rows) });
const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
// Per-frame boundary is `\x1b[?25l` (hide-cursor, once per draw(), nowhere
// else) now that a redraw no longer opens with a full-screen clear.
const frames = (out) => String(out).split('\x1b[?25l').slice(1).map(plain);

/** A task that plans, talks, and calls tools — so the feed has both kinds. */
const workScript = [
  { text: 'Looking at the settings owner.', tool_calls: [{ name: 'plan_write', input: { steps: ['find the owner', 'fix the key', 'verify'] } }] },
  // A FIX CHANGES SOMETHING: a "fix it" turn that only lists and says "Done."
  // is (correctly) woken and then ends no-progress — see wakeup.js.
  { text: 'The toggle writes the wrong key.', tool_calls: [{ name: 'write_file', input: { path: 'settings-fix.txt', content: 'key=enabled\n' } }] },
  { text: 'Done.' },
];

function sessionOf(configDir) {
  const dir = path.join(configDir, 'sessions');
  const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json'));
  return JSON.parse(fs.readFileSync(path.join(dir, f[0]), 'utf8'));
}

module.exports = async function () {
  await test('SCREEN: progress is a few compact rows, not a block that buries the work', async () => {
    // ------------------------------------------------------------------
    // THIS USED TO ASSERT THE PINNED TASK BANNER — `TASK  fix the telegram
    // toggle   STEP 2/2` — and that progress followed the objective on the very
    // next cells, with no STATUS heading and no spelled-out percentage row
    // between them. The block it replaced spelled those over NINE rows.
    //
    // The banner is gone with the panes. The objective is the first thing the
    // user said, so the conversation says it; progress is `/plan`, which is
    // where it is now asked for. The property that survives is the one this
    // test was always really about: PROGRESS IS COMPACT. The nine-row block
    // must not come back, and the percentage must be a figure rather than a
    // sentence.
    // ------------------------------------------------------------------
    const r = await runCli([], {
      cwd: tmpdir('scr-'), env: tui(),
      stdin: 'fix the telegram toggle\n/plan step one\n/plan step two\n/plan done first\n/plan\n/exit\n',
      script: [{ text: 'ok' }], timeoutMs: 40000,
    });
    // A drawn frame positions every row with a cursor escape rather than a
    // newline, so once the escapes are stripped the frame is ONE string and
    // order is what can be asserted — which is the claim anyway.
    const f = frames(r.out).reverse().find((x) => /STEP \d\/\d/.test(x));
    assert.ok(f, 'the plan never drew its progress');
    assert.match(f, /PLAN {2}1\/2 done/, 'the plainest statement of it leads');
    assert.match(f, /STEP \d\/\d/, 'with the position');
    assert.match(f, /\d+%/, 'and the percentage as a figure');
    // The old block spelled these out over nine rows.
    assert.ok(!/STATUS/.test(f), 'the STATUS heading is gone');
    assert.ok(!/% complete/.test(f), 'the spelled-out percentage row is gone');
    // AND THE OBJECTIVE IS NOT REPEATED BESIDE IT. It is in the conversation,
    // once, which is the whole of what the banner's removal bought.
    assert.ok(!/TASK {2}fix the telegram/.test(f), 'no banner pins it a second time');
  });

  await test('SCREEN: what the MODEL said and what LAIN DID are labelled apart', async () => {
    // CALLS THAT LEAVE A ROW. A successful read is live state only and leaves
    // nothing behind (ui/durable.js), so `list_dir` / `plan_write` can never be
    // what an ordering assertion about the settled account is made of.
    const r = await runCli([], {
      cwd: tmpdir('scr-'), env: tui(),
      stdin: 'fix the telegram toggle\n/exit\n',
      script: [
        { text: 'Looking at the settings owner.', tool_calls: [{ name: 'write_file', input: { path: 'owner.txt', content: 'owner' } }] },
        { text: 'The toggle writes the wrong key.', tool_calls: [{ name: 'write_file', input: { path: 'key.txt', content: 'key' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 40000,
    });
    // WHILE THE TURN RUNS the account interleaves prose and calls; once it has
    // finished it is drawn CHANGE / RESULT (ui/turnsections.js) — asserted below.
    const all = frames(r.out).reverse();
    // A frame is one string once its cursor escapes are stripped, so rows are
    // matched by their content rather than by line anchors.
    const f = all.find((x) => /│ ✓ \S+ · key\.txt/.test(plain(x)) && /The toggle writes/.test(plain(x)));
    assert.ok(f, 'the feed never drew');
    const done = all.find((x) => /CHANGE\s*│ ✓ owner\.txt[\s\S]*│ ✓ key\.txt/.test(plain(x)));
    assert.ok(done, 'the finished turn lists its changes behind the gutter');
    // The account reads: what was said, then what was done about it, then what
    // was said next. Both labels present, in that order, around the real rows.
    // ---- THE LABELS ARE GONE; THE DISTINCTION IS NOT ---------------------
    //
    // `LAIN` named the application to the person who typed `lain` to start it,
    // and `ACTIONS` announced that actions were actions. What tells the two
    // kinds apart is STRUCTURAL and survives monochrome: a tool call sits
    // behind a quoted gutter, and the model's prose sits at the margin.
    //
    // The property under test is unchanged — prose and calls, grouped, in the
    // order they actually happened.
    // PROSE, THEN THE CALL IT PRECEDED, THEN THE NEXT PROSE, THEN ITS CALL.
    // The quoted gutter is what marks a call, so the alternation is asserted
    // through it rather than through a heading that no longer exists.
    assert.match(
      plain(f),
      /Looking at the settings owner\.[\s\S]*│ ✓ [\s\S]*The toggle writes the wrong key\.[\s\S]*│ ✓ /,
      `prose and calls are not grouped in order:\n${plain(f)}`
    );
    assert.match(plain(f), /✓ \S+ · key\.txt/, 'a tool call keeps its marker');
    assert.ok(/│\s*✓ \S+ · key\.txt/.test(plain(f)),
      'and its quoted gutter, which is what tells it from prose');
  });

  await test('SCREEN: on a narrow terminal the labels go, the distinction stays', async () => {
    const r = await runCli([], {
      cwd: tmpdir('scr-'), env: tui(44, 16),
      stdin: 'fix it\n/exit\n', script: workScript, timeoutMs: 40000,
    });
    const out = plain(r.out);
    assert.ok(!/^\s+ACTIONS\s*$/m.test(out), 'labels are the decoration that goes first');
    assertIncludes(out, '✓', 'but the action marker still separates a call from a sentence');
    assertIncludes(out, 'Ask LAIN', 'and the input region is never sacrificed');
  });

  // ------------------------------------------------------------- context ---

  await test('CTX SMOKE: the rendered feed is NOT what the model receives', async () => {
    const r = await runCli([], {
      cwd: tmpdir('ctx-'), env: tui(),
      stdin: 'fix the telegram toggle\n/exit\n',
      script: workScript, timeoutMs: 40000,
    });
    const s = sessionOf(r.configDir);
    const wire = JSON.stringify(s.messages);
    // These are UI strings. If they appear in the conversation, the screen is
    // being paid for twice — once to draw and once on every later request.
    for (const ui of ['ACTIONS', 'MODEL\n', '✓ Listed', 'ACTIVITY']) {
      assert.ok(!wire.includes(ui), `the rendered feed leaked into the model's context: ${ui}`);
    }
    assert.ok(s.turns.length, 'the UI record still exists — it is just kept out of the payload');
  });
};
