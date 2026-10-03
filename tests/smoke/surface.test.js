'use strict';

/**
 * THE TRANSIENT SURFACE —, from a live screen on 2026-08-22.
 *
 * What the user saw, and objected to:
 *
 *     --- USER
 *     summarise the dashboard
 *     --- ASSISTANT
 *     The dashboard swallows two exceptions.
 *     …
 *     296k → 294k chars (budget 432k)
 *     Old tool output was replaced by a one-line stub naming the call…
 *
 * The last two lines are not the conversation. They are LAIN's own housekeeping
 * — nobody said them to the model, the model will never read them, and they are
 * of no interest at all ten minutes later. Glued into Context they push the
 * actual work off the screen and stay there for the rest of the session. The
 * same was true of `/dash on`, which wrote a URL and a token into the
 * transcript permanently.
 *
 * These drive the REAL BINARY, because every one of them is a claim about what
 * reached the screen and where — which only the screen can settle.
 */

const assert = require('assert');
const { test, runCli, tmpdir, frames, rowsOf, assertIncludes, isRuleRow } = require('../helpers');

const E = String.fromCharCode(27);
const plain = (s) => String(s).split(new RegExp(E + '\\[[0-9;?]*[A-Za-z]', 'g')).join('');

/**
 * The rows of the first frame that shows the surface, and of a later frame that
 * does not — which is the pair every assertion below is really about.
 *
 * ROWS COME FROM `rowsOf`, NOT FROM SPLITTING PLAIN TEXT. A drawn frame contains
 * no newlines: rows are positioned with `ESC[<row>;1H`, so the row boundaries
 * ARE escape sequences. Stripping the escapes first and then looking for row
 * breaks finds none, and the whole frame reads as one row — which is exactly the
 * false negative this note exists to prevent.
 */
function framePair(out, marker) {
  const raw = frames(out);
  const has = raw.map((f, i) => (plain(f).includes(marker) ? i : -1)).filter((i) => i >= 0);
  // THE LAST FRAME THAT SHOWS IT, not the first. A command that does real work
  // — `/dash` starts a server — paints its panel the moment it opens and fills
  // it as the work completes, so the FIRST frame carrying the title has an
  // empty body. Asserting against that frame tests the render order, not the
  // output, and reports "the panel is empty" for a panel that fills correctly
  // a frame later.
  const withIdx = has.length ? has[has.length - 1] : -1;
  const withoutIdx = raw.findIndex((f, i) => i > withIdx && !plain(f).includes(marker));
  return {
    withIdx,
    withoutIdx,
    withRows: withIdx >= 0 ? rowsOf(raw[withIdx]) : [],
    withoutRows: withoutIdx > withIdx ? rowsOf(raw[withoutIdx]) : [],
  };
}

/** The row index of the input box's own border, or -1. */
/**
 * WHERE THE INPUT IS, on a set of drawn rows.
 *
 * It used to be found by its border label (`─ INPUT ─`). The region has no
 * border and no label now — it is a grey fill (ui/inputbox.js) — so the anchor
 * is what it says when it is empty, which is the row a person looks at anyway.
 */
const inputAt = (rows) => rows.findIndex((l) => /Ask LAIN|ANSWER — /.test(l));
/** The header's rule — the boundary between metadata and the conversation. */
const feedAt = (rows) => rows.findIndex((l) => isRuleRow(l));

const TUI = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' };

module.exports = async function () {
  await test('SURFACE: a command about THE WORK stays in Context', async () => {
    // THE LINE, AND THE MISTAKE THAT FOUND IT. The first version routed EVERY
    // command to the panel. `/plan done` then answered "not complete — nothing
    // has been run to check" inside a box that closes on Esc: a statement about
    // the task, in the record of the task, discarded on a keystroke and absent
    // from the next turn's context.
    //
    // Machinery is about LAIN; this is about the work. It stays in Context.
    //
    // KEYED ON THE PANEL TITLE, not on the footer. `Esc close` is also the
    // footer of the command palette and the help list, so asserting its absence
    // would pass for the wrong reason the moment any panel opened.
    const r = await runCli([], {
      cwd: tmpdir('surface-'),
      env: TUI,
      stdinSteps: ['/plan step check the parser\n', '/exit\n'],
      stepDelayMs: 1400,
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'check the parser', 'the step itself must be recorded');
    // ---- THE PANEL'S TITLE ROW, NOT THE WORD -------------------------
    //
    // It was `!out.includes('/PLAN')`, which worked only because the panel
    // SHOUTED its title: the command the user typed is `/plan step …` and appears
    // in the conversation, so the lower-case word is in the output either way. The
    // panel titles itself in a sentence-case row now, so the landmark has to be
    // the ROW — which is what the claim was always about.
    const titled = frames(r.out).some((f) => rowsOf(f).some((row) => row.trim() === '/plan'));
    assert.ok(!titled, 'the work record must not be routed into the machinery panel');
  });
};
