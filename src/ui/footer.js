'use strict';

/** THE FOOTER — one restrained row under the composer (2026-09-23). */

const RUNNING = [['esc', 'interrupt'], ['ctrl+o', 'activity'], ['shift+tab', 'mode']];
const IDLE = [['/', 'commands'], ['@', 'files'], ['shift+tab', 'mode']];

function hints(run) {
  const busy = Boolean(run && (run.busy || (Array.isArray(run.parts) && run.parts[0] === 'RUNNING')));   // headerstate says busy explicitly now (2026-10-01)
  return busy ? RUNNING : IDLE;
}

/** The painted row, right-aligned to `width`. */
function line(screen, width, P = require('./paint')) {
  const pairs = hints(screen && screen.state && screen.state.run);
  const plain = pairs.map(([k, w]) => `${k} ${w}`).join(' · ');
  if (plain.length + 2 > width) return '';
  const painted = pairs.map(([k, w]) => `${P.plain ? P.plain(k) : k} ${P.meta(w)}`).join(P.meta(' · '));
  return ' '.repeat(Math.max(0, width - plain.length - 1)) + painted;
}

module.exports = { line, hints, RUNNING, IDLE };
