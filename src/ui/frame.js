'use strict';

/** THE HORIZONTAL FRAME — its own module, because everything consumes it. */

/** THE ONE CONTENT FRAME — every primary region is laid out inside this rectangle. */
const GUTTERS = Object.freeze([
  [48, 1],
  [100, 2],
  [160, 3],
]);

/** The widest gutter, for a terminal wider than every threshold. */
const GUTTER_MAX = 4;

/** Content narrower than this is not worth a margin. */
const MIN_CONTENT = 12;

function contentBounds(cols) {
  const w = Math.max(MIN_CONTENT, Math.floor(Number(cols) || 80));
  let g = GUTTER_MAX;
  for (const [upTo, val] of GUTTERS) {
    if (w < upTo) { g = val; break; }
  }
  // A GUTTER MAY NEVER EAT THE CONTENT. On a terminal too narrow to afford the
  // one its width asks for, it shrinks — symmetrically, which is the invariant.
  const room = Math.floor((w - MIN_CONTENT) / 2);
  const gut = Math.max(0, Math.min(g, room));
  return { left: gut, right: gut, width: w - gut * 2, cols: w };
}

/** HOW WIDE PROSE MAY BE — narrower than the frame on a very wide terminal. */
const PROSE_SOFT = 120;

function proseWidth(width) {
  const w = Math.max(MIN_CONTENT, Math.floor(Number(width) || 80));
  if (w <= PROSE_SOFT) return w;
  return Math.min(w, PROSE_SOFT + Math.round(Math.sqrt(w - PROSE_SOFT) * 4));
}

module.exports = { contentBounds, proseWidth, GUTTER_MAX, PROSE_SOFT, MIN_CONTENT };
