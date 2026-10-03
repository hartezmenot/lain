'use strict';

/** WHAT A FEED ROW LOOKS LIKE — the paint, and nothing about the layout. */

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

/** Green tick, red cross — the outcome, before anything else on the row. */
function paintMark(row, P, subject = '') {
  const m = V().MARK;
  /** THREE WEIGHTS ON A ROW THAT USED TO HAVE ONE */
  const SEP = ' ' + SUBJECT_SEP + ' ';
  // THE SIZE OF A CHANGE, and the control that may follow it.
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
