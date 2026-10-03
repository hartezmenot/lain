'use strict';

/** MOVING THE VIEWPORT — the two jumps, and nothing that draws. */

/** GO BACK TO ONE EXACT FEED ROW — what clicking the scroll anchor does. */
function jumpToRow(screen, row) {
  const target = Number(row);
  if (!Number.isFinite(target) || target < 0) return false;
  const feedRows = Math.max(1, screen.geometry().workspace);
  const total = (screen.lastFeedLines && screen.lastFeedLines.length) || 0;
  const maxScroll = Math.max(0, total - feedRows);
  const to = Math.max(0, Math.min(target, maxScroll));
  if (to === screen.workspaceScroll) return false;
  screen.workspaceScroll = to;
  screen.stickToBottom = to >= maxScroll;
  screen.draw();
  return true;
}

function jumpToAnchor(screen, dir) {
  const anchors = require('./anchors').rowsIn(screen.lastFeedLines);
  if (!anchors.length) return false;
  const at = screen.workspaceScroll;
  const target = dir < 0
    ? anchors.filter((r) => r < at).pop()
    : anchors.find((r) => r > at);
  if (target == null) return false;
  // CLAMPED THE SAME WAY EVERY OTHER SCROLL IS
  const feedRows = Math.max(1, screen.geometry().workspace);
  const total = (screen.lastFeedLines && screen.lastFeedLines.length) || 0;
  const maxScroll = Math.max(0, total - feedRows);
  const to = Math.max(0, Math.min(target, maxScroll));
  // ALREADY THERE IS NOT A JUMP.
  if (to === at) return false;
  screen.stickToBottom = to >= maxScroll;
  screen.workspaceScroll = to;
  screen.draw();
  return true;
}

module.exports = { jumpToRow, jumpToAnchor };
