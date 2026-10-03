'use strict';

/** IS THIS BLOCK AN ATTACHMENT, OR SOMETHING SOMEBODY TYPED? */

/** Lines a message must exceed before it can be an attachment rather than a sentence. */
const MIN_LINES = 6;
/** Characters a message must exceed before the same applies. */
const MIN_CHARS = 200;

/** PAST THIS MUCH TEXT, BULK ALONE IS ENOUGH — WHATEVER THE LINE COUNT. */
const MAX_TYPED = 600;

/** Is this message an attachment rather than something the user said? */
function isPaste(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= MIN_CHARS) return false;
  if (s.split('\n').length > MIN_LINES) return true;
  return s.length > MAX_TYPED;
}

/** `label`, `compact`, `count`, `reset` AND THE CONTENT-KEYED REGISTRY STOOD HERE, and all of them existed to serve the numbering in `[pasted text #N]`. */

module.exports = { isPaste, MIN_LINES, MIN_CHARS, MAX_TYPED };
