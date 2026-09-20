'use strict';

/**
 * WHAT A FRAME IS ALLOWED TO WRITE — two rules, one module.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT BOTH RULES CLOSE, reproduced in a real pseudo-console: paste text
 * into the composer, delete it, and parts of it stay painted beside the empty
 * `Ask LAIN…` — in the columns LEFT of the content frame. Two causes put cells
 * there, and one property kept them there:
 *
 *   1. a raw `\r` inside content (a Windows Terminal paste separates its lines
 *      with one) sent the cursor to column 1 mid-row;
 *   2. a row measured in code units drew CJK text twice as wide as counted,
 *      overran the right edge and autowrapped into the next row's gutter;
 *
 *   and every row was positioned at the frame's left edge and erased only to
 *   its RIGHT, so nothing ever repainted the gutter again.
 *
 * The owners of 1 and 2 are fixed where they live (pastebuffer.js `lf`,
 * viewport.js `unitsIn`, inputbox.js cell measurement). These two rules make
 * the class of defect impossible to see again whatever the next cause is.
 */

const ERASE_LINE = '\x1b[2K';
const EOL = '\x1b[K';

/**
 * ONE FRAME ROW, owning its entire terminal line — gutter included.
 *
 * Every row a frame writes is ONE positioned write (a cursor-address escape,
 * then the whole row), never two pieces on the same line, so erasing the line
 * right after positioning can only remove what a previous frame left there.
 */
function row(s) {
  return String(s).replace(/^(\x1b\[\d+;\d+H)/, `$1${ERASE_LINE}`) + EOL;
}

/**
 * NO CONTROL BYTE REACHES THE TERMINAL AS A CONTROL.
 *
 * A frame places every row by address and never means CR, LF, BS or BEL. One
 * arriving inside content becomes a space, so the columns every renderer
 * already counted (one per such byte) still hold. ESC is kept: it is how the
 * frame positions and styles everything. The window title (termtitle.js),
 * which does use BEL, is written outside the frame.
 */
function sanitize(frame) {
  return String(frame).replace(/[\x00-\x1a\x1c-\x1f\x7f]/g, ' ');
}

module.exports = { row, sanitize, ERASE_LINE, EOL };
