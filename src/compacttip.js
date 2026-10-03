'use strict';

/** AUTO-COMPACTION IS INTERNAL MAINTENANCE (§47). */

const TIP = 'TIP · /compact can reduce context usage.';
/** Usage at which the tip is worth a line. */
const HIGH = 0.7;
/** How much further usage must climb before the tip is shown again. */
const STEP = 0.15;

/** What turnevents does with a COMPACT-surface notice. Returns true when handled. */
function onNotice(app, ev) {
  if (!ev || ev.surface !== 'COMPACT') return false;
  if (ev.working) { require('./ui/operation').say(app, ev.message, 'info'); return true; }
  if (ev.level === 'warn' || ev.level === 'error') { app.ui.noteSystem(ev.message, ev.level); return true; }
  app._lastCompaction = { at: Date.now(), message: String(ev.message || '') };
  return true;
}

function usage(app) {
  try {
    const pc = require('./provider').resolve({ ...app.cfg, _evidence: app.connectionEvidence });
    const budget = require('./contextbudget').charsFor(pc, app.cfg);
    if (!budget) return 0;
    return app.session.contextChars() / budget;
  } catch { return 0; }
}

/** Decide the post-turn tip. */
function decide(ratio, shownAt = 0) {
  if (ratio < HIGH) return { show: false, level: ratio < shownAt - STEP ? 0 : shownAt };
  if (!shownAt || ratio >= shownAt + STEP) return { show: true, level: ratio };
  return { show: false, level: shownAt };
}

function afterTurn(app) {
  if (!app || !app.session) return false;
  // NOT AFTER A FAILURE /compact CANNOT FIX. Under a stalled stream the tip read
  // as the remedy for the error above it; only a context refusal earns it there.
  const turns = app.session.turns || [];
  const last = turns[turns.length - 1];
  if (last && last.stopReason === 'provider' && !(last.errors || []).some((e) => e && e.kind === 'CONTEXT_LIMIT')) return false;
  const d = decide(usage(app), app._compactTipAt || 0);
  app._compactTipAt = d.level;
  if (d.show) app.transient('info', TIP);
  return d.show;
}

module.exports = { TIP, HIGH, STEP, onNotice, decide, afterTurn };
