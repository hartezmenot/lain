'use strict';

/** THE NUMBERS ON THE LIVE ROW — what a turn has cost, and how long until it can go. */

const T = require('./text');
const { P } = require('./paint');

/** A TOKEN COUNT, SHORT ENOUGH TO SHARE A ROW. */
function tok(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return String(v);
  // THE CARRY, WHICH THIS USED TO GET WRONG
  for (const [div, suffix] of SCALES) {
    const x = v / div;
    // ONE DECIMAL UNTIL THE INTEGER PART NEEDS THREE DIGITS: `1.0K`, `12.4K`, `999K`.
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

/** WHAT THIS SESSION HAS COST — and what took the second progress bar's place. */
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
