'use strict';

/** WHAT A FRAME IS ALLOWED TO WRITE — two rules, one module. */

const ERASE_LINE = '\x1b[2K';
const EOL = '\x1b[K';

/** ONE FRAME ROW, owning its entire terminal line — gutter included. */
function row(s) {
  return String(s).replace(/^(\x1b\[\d+;\d+H)/, `$1${ERASE_LINE}`) + EOL;
}

/** NO CONTROL BYTE REACHES THE TERMINAL AS A CONTROL. */
function sanitize(frame) {
  return String(frame).replace(/[\x00-\x1a\x1c-\x1f\x7f]/g, ' ');
}

module.exports = { row, sanitize, ERASE_LINE, EOL };
