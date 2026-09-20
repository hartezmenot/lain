'use strict';

/**
 * THE NUMBERS ON THE LIVE ROW — what a turn has cost, and how long until it can go.
 *
 * Split out of ui/status.js when that file reached the god-object guard, on a seam
 * that was already there: everything left in status.js decides WHAT THE ROW SAYS,
 * and this is how its FIGURES are spelled. They change for different reasons — a
 * new state word touches the first and not the second.
 *
 * EVERY ONE OF THESE IS SHORT ON PURPOSE. They share a row with the one sentence
 * that says whether LAIN is alive, and that sentence must never be crowded out by
 * an accounting figure: `42.1K` rather than `42,118`, `00:23` rather than
 * `23 seconds remaining`.
 */

const T = require('./text');
const { P } = require('./paint');

/**
 * A TOKEN COUNT, SHORT ENOUGH TO SHARE A ROW.
 *
 * Three significant figures is the resolution anybody acts on: the difference
 * between 42,118 and 42,131 changes nothing a person would do, and the seven
 * characters it costs are seven the detail beside it needed.
 */
function tok(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return String(v);
  // ---- THE CARRY, WHICH THIS USED TO GET WRONG ---------------------------
  //
  // `999,600` took the K branch, divided to `999.6`, rounded to `1000` and
  // printed `1000K`. That is four significant figures in a formatter whose
  // entire purpose is three, and it is a unit nobody writes: past a thousand
  // thousand you say `1.0M`. The rounding has to happen BEFORE the unit is
  // chosen, or the unit is chosen from a number that no longer exists.
  //
  // So each scale is tried in turn and a scale that rounds up out of its own
  // range is REJECTED rather than printed — `999,600` fails the K test on the
  // rounded value and falls through to M, where it belongs.
  for (const [div, suffix] of SCALES) {
    const x = v / div;
    // ONE DECIMAL UNTIL THE INTEGER PART NEEDS THREE DIGITS: `1.0K`, `12.4K`,
    // `999K`. The cut is at 99.95 rather than 100 so a value that would ROUND
    // to three digits takes the integer form — without it, `99,960` printed
    // `100.0K`, which is four significant figures in a three-figure formatter.
    const text = x < 99.95 ? x.toFixed(1) : String(Math.round(x));
    // `1000` here means the rounding carried past this scale's ceiling.
    if (Number(text) < 1000) return text + suffix;
  }
  // Beyond the last scale there is nothing left to carry into, so the figure is
  // printed at whatever width it needs. A session cannot reach this.
  return `${Math.round(v / 1_000_000_000)}B`;
}

/** Largest unit first; `tok` takes the first that does not carry out of range. */
const SCALES = Object.freeze([
  [1_000, 'K'],
  [1_000_000, 'M'],
  [1_000_000_000, 'B'],
]);

/**
 * ------------------------------------------------------------------------
 * WHAT THIS SESSION HAS COST — and what took the second progress bar's place.
 *
 * THE BAR THAT WAS HERE WAS THE SAME BAR AS THE ONE AT THE TOP. `STEP 3/5
 * ████░░ 60%` was drawn by the task banner and again in this row's right-hand
 * column: one fact, two indicators, on one screen, and neither of them the
 * thing a person watching a long turn actually wants to know. The banner keeps
 * it — it belongs beside the objective it measures. This corner answers the
 * question the banner cannot: what is this costing.
 *
 * ------------------------------------------------------------------------
 * ONE FIGURE, AND IT IS OUTPUT.
 *
 * THIS ROW USED TO CARRY FOUR — `↑42.1K ⚡38.0K ↓2.1K +…`: input, cache reads,
 * output, and the input side of the open request. Every one of them was true
 * and the row was still the wrong answer, for a reason that only shows up once
 * you watch somebody read it: FOUR NUMBERS IN A CORNER IS NOT A READING, IT IS
 * A TABLE, and a table on the status row is scanned by nobody and reasoned
 * about by nobody. It also put the LARGEST number first — input, which on a
 * cached session is almost entirely the same prompt being re-sent — so the
 * figure the eye landed on was the one least connected to what the model was
 * actually doing.
 *
 * OUTPUT IS WHAT THE MODEL PRODUCED. It is the quantity that tracks work, the
 * one that moves when a turn is generating and holds still when it is not, and
 * the only one of the four a person can act on while a turn is in flight.
 *
 * THE OTHER THREE ARE NOT GONE, THEY ARE ONE KEYSTROKE AWAY. `/token`
 * (ui/tokenview.js) states input, cache reads, cache writes, the ratio between
 * input and output, and the cache hit rate — with the PROVENANCE of each, which
 * is the thing a corner of a status row could never carry. The incident that
 * pane was built for (59M input against 202K output) is diagnosed there, in
 * full, and was never diagnosable from a four-figure strip anyway.
 *
 * ------------------------------------------------------------------------
 * IT IS THE PROVIDER'S FIGURE, NOT LAIN'S ESTIMATE. Output is stated once, in
 * `message_delta` on the Anthropic shape and in the final chunk on the OpenAI
 * one, and `usage` here is accumulated from those receipts. Nothing in this
 * function counts characters and divides.
 *
 * `↓2.1K +` MEANS "2,100 MEASURED, AND A REQUEST IS OPEN WHOSE OUTPUT IS NOT
 * STATED YET". No provider LAIN speaks to reports output mid-stream, so the
 * marker is a bare `+`: a rising invented number would be worse than no number,
 * and a `+0` would be a measurement nobody made. §10: never fake a live figure.
 */
function tokens(s) {
  const u = s && s.usage;
  const open = Boolean(s && s.requestOpen);
  const output = u ? Math.max(0, Number(u.outputTokens) || 0) : 0;
  // NOTHING MEASURED AND NOTHING OPEN IS AN EMPTY STRING, not a `↓0`. A session
  // that has not spoken yet has no output figure, and zero is a measurement.
  if (!output && !open) return '';
  // A REQUEST WITH NOTHING BANKED YET SAYS SO. `↓…` rather than `↓0 +`, because
  // on the first request of a session there is no total to qualify.
  if (!output) return '↓…';
  return open ? `↓${tok(output)} +` : `↓${tok(output)}`;
}

/** `00:23` — a countdown a person can watch tick. */
function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** `12:50:00` in the user's own clock — the answer to "when can I work again?". */
function clockAt(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

module.exports = { tok, tokens, mmss, clockAt };
