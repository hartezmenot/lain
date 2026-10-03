'use strict';

/** read_file's LINE-NUMBER GUTTER, copied back into an edit (2026-09-23). */

const GUTTER = /^ *\d+\t/;

/** The text without read_file's gutter, or null when not every non-empty line has one. */
function strip(s) {
  const lines = String(s == null ? '' : s).replace(/\r\n/g, '\n').split('\n');
  const body = lines.filter((l) => l.length);
  if (!body.length || !body.every((l) => GUTTER.test(l))) return null;
  return lines.map((l) => l.replace(GUTTER, '')).join('\n');
}

/** Resolve the edit's old/new pair against the file's text. */
function resolve(hay, old, replacement) {
  if (hay.includes(old)) return { old, replacement, stripped: false };
  const s = strip(old);
  if (s == null || !s.length || !hay.includes(s)) return { old, replacement, stripped: false };
  const r = strip(replacement);
  return { old: s, replacement: r == null ? replacement : r, stripped: true };
}

const NOTE = '(read_file\'s line-number prefixes were removed from the expected text — send file text without them)';

module.exports = { strip, resolve, NOTE, GUTTER };
