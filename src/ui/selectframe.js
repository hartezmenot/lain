'use strict';

/**
 * SELECTION FRAMES — real time, renderer-local (Phase 6, 2026-10-02).
 *
 * A selection move (↑↓ in a picker, a drag across the feed or the input) changes RENDERER state only: the panel's
 * highlighted row, the screen's text selection. So its frame does not re-project Core (`ui.refresh` → snapshot): it
 * redraws the last projection with the new selection — `screen.draw()` keeps the state it was last given, and reads
 * the panel and the selection live.
 *
 * AND IT IS PACED, not queued: a drag reports a motion per mouse sample (hundreds a second); every one of them used to
 * be a full projection and a full frame. Now the first move of a burst is drawn at once, later ones within FRAME_MS
 * are folded into one trailing frame — so the newest selection is on screen within 16 ms of the event that made it,
 * and never more than one frame is spent per 16 ms.
 *
 * Measured before the change (120×40, 3 000-line feed): ↓ p95 1.4 ms, drag p95 0.9 ms per event — already inside the
 * budget on a quiet screen; this makes the budget hold under bursts and a heavy projection.
 */

const FRAME_MS = 16;

/** Draw the selection now, from the last projection. */
function paintLocal(ui) {
  if (!ui || !ui.enabled || !ui.screen || typeof ui.screen.draw !== 'function') return;
  ui.screen.draw();
  ui._localAt = Date.now();
  ui._localFrames = (ui._localFrames || 0) + 1;
}

/** A high-rate selection event: the first of a burst is drawn now, the rest fold into one frame FRAME_MS later. */
function requestLocalFrame(ui) {
  if (!ui || !ui.enabled) return;
  if (ui._localTimer) { ui._localDirty = true; return; }
  paintLocal(ui);
  ui._localTimer = setTimeout(function tail() {
    ui._localTimer = null;
    if (ui._localDirty) { ui._localDirty = false; requestLocalFrame(ui); }
  }, FRAME_MS);
  if (ui._localTimer.unref) ui._localTimer.unref();
}

module.exports = { paintLocal, requestLocalFrame, FRAME_MS };
