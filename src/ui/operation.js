'use strict';

/** THE TRANSIENT OPERATION NOTE — `> Recovering interrupted turn`, and then gone. */

/** How long a note stands before the row goes back to READY. */
const LIFE_MS = 6000;

/** Longer than this is a paragraph, and a paragraph is not an operation. */
const MAX = 72;

/** Record one operation, replacing whatever the last one was. */
function note(ui, text, { level = 'info' } = {}) {
  if (!ui) return;
  const say = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!say) return;
  ui.op = { text: say.slice(0, MAX), level, at: Date.now() };
  if (ui._opTimer) { clearTimeout(ui._opTimer); ui._opTimer = null; }
  const t = setTimeout(() => {
    ui._opTimer = null;
    // GUARDED ON IDENTITY. In six seconds a newer note may have taken the row;
    // clearing whatever happens to be there would erase somebody else's.
    if (ui.op && Date.now() - ui.op.at >= LIFE_MS) { ui.op = null; try { ui.refresh(); } catch { /* chrome */ } }
  }, LIFE_MS + 50);
  if (t.unref) t.unref();
  ui._opTimer = t;
  try { ui.refresh(); } catch { /* a note that cannot be drawn is still only a note */ }
}

/** Forget the current note. Called when a turn begins: its phase owns the row. */
function clear(ui) {
  if (!ui) return;
  ui.op = null;
  if (ui._opTimer) { clearTimeout(ui._opTimer); ui._opTimer = null; }
}

/** The note to draw, or null. Pure — expiry is read from the clock, not a flag. */
function current(ui, now = Date.now()) {
  const o = ui && ui.op;
  if (!o || !o.text) return null;
  return now - o.at > LIFE_MS ? null : { text: o.text, level: o.level || 'info' };
}

/** THE ONE DOOR CALLERS USE, so neither of them has to know whether a screen exists. */
function say(app, text, level = 'info') {
  if (!app) return;
  const ui = app.ui;
  if (ui && ui.enabled) return void note(ui, text, { level });
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return;
  try { app.render.write(`  › ${t}
`); } catch { /* an operation nobody can see is still only an operation */ }
}

module.exports = { note, clear, current, say, LIFE_MS, MAX };
