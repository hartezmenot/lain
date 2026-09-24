'use strict';

/**
 * WHAT A FEED ROW LOOKS LIKE — the paint, and nothing about the layout.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE. ui/feed.js decides WHAT ROWS EXIST and in what order;
 * this decides what weight each part of a row carries. They change for different
 * reasons — a new kind of entry touches the first and not the second; a change to
 * the hierarchy touches the second and not the first — and the split is what kept
 * feed.js under the god-object guard when the row gained three weights instead of
 * one.
 *
 * THE HIERARCHY THESE IMPLEMENT, loudest first:
 *
 *     the final answer       plain foreground — the durable thing
 *     what the user said     bold, on its own ground
 *     a call's outcome       green tick or red cross, the first glyph on the row
 *     a call's subject       the cyan every path in LAIN wears
 *     everything else        dim: verbs, counts, notes, finished work
 *
 * Tool progress is transient and subdued; the answer it was evidence for is not.
 * That ordering is the whole point, and it used to be flat.
 */

const V = () => require('./views');

/** The `verb - subject` separator a tool row is built with. See ui/phrasing.js. */
const SUBJECT_SEP = require('./phrasing').SUBJECT_SEP;

/** One row of an entry, painted for its kind. */
function paintRow(e, row, first, P, k) {
  // A command's own output lines (ui/shellrow.js) read in the text colour.
  if (e.kind === 'action' && e.out) return P.plain ? P.plain(row) : row;
  if (e.kind === 'action') return first ? paintMark(row, P, e.path || e.subject || '') : P.meta(row);
  // A user line is bright and marked, so it stands out of the scroll as the
  // thing that started everything below it.
  if (e.kind === 'user' && first) return P.key('❯ ') + P.key(row);
  if (e.kind === 'user') return P.key('  ' + row);
  // The body wears the kind's own weight, which for a note is its SEVERITY —
  // so a refused request is red text and not grey text with a red word above it.
  const paint = P[k.body];
  return paint && k.body !== 'plain' ? paint(row) : row;
}

/**
 * Green tick, red cross — the outcome, before anything else on the row.
 *
 * THE TEXT AFTER THE MARK IS SECONDARY, and it was not: the glyph was coloured
 * and the rest of the row left at full weight, so `✓ Read dashboard.py` carried
 * the same visual force as the sentence LAIN had just written — and the green
 * tick carried more. Three tool calls then outshouted the model's actual
 * answer, which is backwards: the calls are the EVIDENCE for that answer, not
 * the point of it.
 *
 * The mark keeps its colour, because passed-or-failed is the one thing worth
 * spotting from across the row. Everything after it goes quiet.
 */
function paintMark(row, P, subject = '') {
  const m = V().MARK;
  /**
   * ---- THREE WEIGHTS ON A ROW THAT USED TO HAVE ONE -----------------------
   *
   *     OK read - src/router.js
   *        |      \__ the subject: the accent every path in LAIN wears
   *        \__ the verb: dim, because "what kind of thing" is the least of it
   *     \__ the outcome: green or red, and the first thing the eye lands on
   *
   * SPLIT ON THE SEPARATOR, not by searching for the target. The row is BUILT as
   * `verb - subject` (ui/phrasing.js), so the separator is the structure rather
   * than a string that happens to be in there - which matters for a shell command
   * whose own text could contain its path twice.
   *
   * A ROW WITH NO SEPARATOR is a verb on its own (`plan`, `asked you`) and is all
   * dim. A wrapped continuation line never reaches here.
   */
  const SEP = ' ' + SUBJECT_SEP + ' ';
  // THE SIZE OF A CHANGE, and the control that may follow it. Additions green,
  // deletions red, and nothing else on the row takes either colour. The
  // pattern used to require the counts to END the row, so once `[Diff]` was
  // appended it never matched and `+18 -7` was painted as part of the path —
  // the "no useful colour distinction" that was reported.
  const COUNTS = /(\s+)\+(\d+) -(\d+)(\s+\[(?:× )?Diff\])?\s*$/;
  const counted = (m) => m[1] + P.ok(`+${m[2]}`) + ' ' + P.bad(`-${m[3]}`) + (m[4] ? P.meta(m[4]) : '');
  const parts = (rest) => {
    const at = rest.indexOf(SEP);
    if (at < 0) {
      const c = COUNTS.exec(rest);
      return c ? P.meta(rest.slice(0, c.index)) + counted(c) : P.meta(rest);
    }
    const tail = rest.slice(at + SEP.length);
    // THE SIZE OF A CHANGE IS METADATA, not part of the subject — it must not
    // inherit the path's accent.
    const counts = COUNTS.exec(tail);
    const control = !counts && /(\s+\[(?:× )?Diff\])\s*$/.exec(tail);
    const cut = counts || control;
    const subj = cut ? tail.slice(0, cut.index) : tail;
    return P.meta(rest.slice(0, at + 1) + SUBJECT_SEP + ' ')
      + P.path(subj)
      + (counts ? counted(counts) : control ? P.meta(control[1]) : '');
  };
  if (row.startsWith(m.done)) return P.ok(m.done) + parts(row.slice(m.done.length));
  if (row.startsWith(m.error)) return P.bad(m.error) + parts(row.slice(m.error.length));
  // A SHELL COMMAND (2026-09-23): `› npm test` — the command in the tool cyan,
  // the prompt mark in the outcome's colour. Its completion line is a detail row.
  if (row.startsWith('› ')) return P.cmd('›') + ' ' + P.cmd(row.slice(2));
  if (row.startsWith('✗› ')) return P.bad('›') + ' ' + P.cmd(row.slice(3));
  if (/^\s+Command (completed|failed)\b/.test(row)) return /failed/.test(row) ? P.bad(row) : P.meta(row);
  // A wrapped detail line under a call, not an outcome of its own.
  void subject;
  return P.meta(row);
}

module.exports = { paintRow, paintMark };
