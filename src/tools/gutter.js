'use strict';

/**
 * read_file's LINE-NUMBER GUTTER, copied back into an edit (2026-09-23).
 *
 * read_file shows `    5\tconst FILE = …` — a right-aligned number and a tab
 * before every line. A model that copies that view into `expect` (apply_patch)
 * or `old` (edit_file) sends text the file does not contain. Live, gpt-oss:120b
 * via Ollama Cloud: 27 of 27 patches in one run were rejected for exactly this,
 * 19 of them against one file, and the run ended at its step cap having changed
 * nothing.
 *
 * The repair is deterministic and narrow. It applies only when the text as
 * sent is NOT in the file, EVERY non-empty line carries the gutter, and the
 * text without it IS in the file. The edit tool then uses the stripped text
 * and says so. Anything else is left exactly as sent.
 */

const GUTTER = /^ *\d+\t/;

/** The text without read_file's gutter, or null when not every non-empty line has one. */
function strip(s) {
  const lines = String(s == null ? '' : s).replace(/\r\n/g, '\n').split('\n');
  const body = lines.filter((l) => l.length);
  if (!body.length || !body.every((l) => GUTTER.test(l))) return null;
  return lines.map((l) => l.replace(GUTTER, '')).join('\n');
}

/**
 * Resolve the edit's old/new pair against the file's text. Returns the pair to
 * use and whether the gutter was removed. `replacement` loses its gutter only
 * when it carries one on every non-empty line, as the copied `old` did.
 */
function resolve(hay, old, replacement) {
  if (hay.includes(old)) return { old, replacement, stripped: false };
  const s = strip(old);
  if (s == null || !s.length || !hay.includes(s)) return { old, replacement, stripped: false };
  const r = strip(replacement);
  return { old: s, replacement: r == null ? replacement : r, stripped: true };
}

const NOTE = '(read_file\'s line-number prefixes were removed from the expected text — send file text without them)';

module.exports = { strip, resolve, NOTE, GUTTER };
