'use strict';

/** HOW A USER MESSAGE IS DRAWN — one concern, taken out of ui/feed.js. */

const T = require('./text');

function userAnchor(out, text, width, P, { steer = false } = {}) {
  const anchors = require('./anchors');
  const w = Math.max(8, width);
  const head = `${anchors.label(text, { steer })} · `;
  const room = Math.max(4, w - T.width(head) - 1);
  const body = anchors.preview(text, room);
  out.userAt[out.length] = text;
  // The content frame owns the outer margin, so no gutter of our own here.
  // ONE PAINT, NOT NESTED: an inner reset would cancel the gray ground mid-row.
  out.push(P.surface(T.pad(head + body, w)));
}

module.exports = { userAnchor };
