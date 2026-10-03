'use strict';

/** THE UPDATE, AS EVERY SURFACE SAYS IT (Phase 7, 2026-10-02) — one canonical view in Core, read by the CLI (its notice, its header, `/update`) and the… */

function U() { return require('./updater'); }
function LC() { return require('./lifecycle'); }

const BUTTON = 'Update ready ●';
function availableLabel(v) { return `↑ LAIN ${v} ready to update`; }
const INSTALLED = '✓ Update installed · Restart to activate';

// CACHED 2 s: the CLI header reads this on every frame; the state is a file the updater writes.
let memo = { at: 0, st: null };
function view(app, { fresh = false } = {}) {
  let st = null;
  if (!fresh && Date.now() - memo.at < 2000) st = memo.st;
  else { try { st = U().status(); } catch { st = null; } memo = { at: Date.now(), st }; }
  const b = U().build();
  const s = st || { state: 'current' };
  const version = s.state === 'staged' && s.staged ? s.staged.version : s.state === 'available' && s.available ? s.available.version : null;
  const label = s.state === 'staged' ? INSTALLED : s.state === 'available' && version ? availableLabel(version) : '';
  return {
    ...s, current: b.version, channel: b.channel, installed: Boolean(U().installRoot()),
    version, label, button: label ? BUTTON : '', busy: LC().busy(app), pendingRestart: LC().pending(app, 'update'),
    // What "Restart" may mean right now — never "now" over a running task.
    restartChoices: s.state !== 'staged' ? [] : LC().busy(app) ? ['checkpoint', 'task'] : ['now'],
  };
}

module.exports = { view, BUTTON, INSTALLED, availableLabel };
