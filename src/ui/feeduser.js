'use strict';

/**
 * HOW A USER MESSAGE IS DRAWN — one concern, taken out of ui/feed.js.
 *
 * ------------------------------------------------------------------------
 * ONE ROW: THE ANCHOR.
 *
 *     USER · implement Computer MCP and test the native picker…
 *
 * A turn starts with what the person asked, as a single gray row carrying the
 * real prompt — never a model-written title, never a bare `USER`. It is the
 * reading rhythm of the conversation: the eye finds every exchange by its
 * anchor, and LAIN's result follows beneath a quiet rule.
 *
 * THE ROW IS A PREVIEW, NOT THE MESSAGE. It used to be the whole prompt,
 * rendered as a document (a structured brief kept its headings and lists), so
 * a four-page brief pushed its own answer off the screen. The row now shows the
 * first sentence with an ellipsis, and the MESSAGE travels with it: `userAt`
 * maps the row to the exact submitted text, so a click puts the original prompt
 * back on the input line (ui/mouse.js), Alt+↑/↓ jump between anchors
 * (ui/anchors.js), and `/copy context` exports the full text from the turn
 * record. Nothing about what was sent, stored or given to the model changes.
 *
 * `USER DECISION` / `USER REQUEST` still distinguish a one-word answer and a
 * paste from a sentence (ui/anchors.js `label`).
 */

const T = require('./text');

/**
 * @param {string[]} out   the feed being built; carries `userAt`
 * @param {string} text    the exact submitted prompt
 */
function userAnchor(out, text, width, P) {
  const anchors = require('./anchors');
  const w = Math.max(8, width);
  const head = `${anchors.label(text)} · `;
  const room = Math.max(4, w - T.width(head) - 1);
  const body = anchors.preview(text, room);
  out.userAt[out.length] = text;
  // The content frame owns the outer margin, so no gutter of our own here.
  // ONE PAINT, NOT NESTED: an inner reset would cancel the gray ground mid-row.
  out.push(P.surface(T.pad(head + body, w)));
}

module.exports = { userAnchor };
