'use strict';

/** SELECTION FRAMES — real time, renderer-local (Phase 6, 2026-10-02). */

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
