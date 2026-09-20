'use strict';

/**
 * WHAT A CLICK ON A DIFF DOES — secondary, because the diff is already there.
 *
 * A change row shows its hunks by default (ui/turnsections.js). The controls
 * only adjust that:
 *
 *   click [× Diff]        → COLLAPSE that file's diff to its summary row
 *   click [Diff]          → REOPEN it
 *   click [Show all]      → EXPAND a large diff past its bounded preview, and
 *                           scroll straight to it
 *   Esc (or the collapse) → an expanded diff returns to its bounded preview and
 *                           the feed to the exact scroll position (and bottom-
 *                           follow state) it had before the expansion
 *
 * Presentation state only, on the Screen: `closedDiffs` (keys `turn:path`) and
 * `openDiff` (the one expanded diff). Nothing here touches the work.
 */

function same(a, b) { return Boolean(a && b && a.turn === b.turn && a.path === b.path); }
const keyOf = (t) => `${t.turn}:${t.path}`;

/**
 * The row control does the OPPOSITE of what the row currently shows. `shown`
 * rides on the click target (ui/turnsections.js) because whether a file's diff
 * is open by default depends on how recent it is — the row knows, this does not.
 */
function toggle(screen, target) {
  if (!screen || !target) return false;
  if (target.full) return expand(screen, target);
  if (!screen.closedDiffs) screen.closedDiffs = new Set();
  if (!screen.shownDiffs) screen.shownDiffs = new Set();
  const k = keyOf(target);
  const shown = target.shown != null ? Boolean(target.shown) : !screen.closedDiffs.has(k);
  if (shown) {
    if (same(screen.openDiff, target)) close(screen);
    screen.shownDiffs.delete(k);
    screen.closedDiffs.add(k);
  } else {
    screen.closedDiffs.delete(k);
    screen.shownDiffs.add(k);
  }
  return true;
}

/** Past the bounded preview, landing on the hunk. */
function expand(screen, target) {
  if (screen.closedDiffs) screen.closedDiffs.delete(keyOf(target));
  if (!screen.shownDiffs) screen.shownDiffs = new Set();
  screen.shownDiffs.add(keyOf(target));
  if (same(screen.openDiff, target)) return true;
  const saved = screen.openDiff
    ? { scroll: screen.openDiff.savedScroll, stick: screen.openDiff.savedStick }
    : { scroll: screen.workspaceScroll, stick: screen.stickToBottom };
  screen.openDiff = { turn: target.turn, path: target.path, savedScroll: saved.scroll, savedStick: saved.stick, landing: true };
  screen.stickToBottom = false;
  return true;
}

/** Back to the bounded preview, and back to where the person was. */
function close(screen) {
  const o = screen && screen.openDiff;
  if (!o) return false;
  screen.openDiff = null;
  screen.workspaceScroll = o.savedScroll;
  screen.stickToBottom = o.savedStick;
  return true;
}

/**
 * Called by the layout once the feed is built: the first frame after an
 * expansion scrolls to the hunk (its row just above it), then never again.
 */
function landing(screen, lines, feedRows) {
  const o = screen && screen.openDiff;
  if (!o || !o.landing || !lines || !lines.hunkAt) return;
  const at = Object.keys(lines.hunkAt).map(Number).find((i) => same(lines.hunkAt[i], o));
  if (at == null) return;
  o.landing = false;
  const maxScroll = Math.max(0, lines.length - feedRows);
  screen.workspaceScroll = Math.max(0, Math.min(maxScroll, at - 2));
  screen.stickToBottom = false;
}

module.exports = { toggle, expand, close, landing, same };
