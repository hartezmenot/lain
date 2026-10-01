'use strict';

/**
 * THE FOOTER — one restrained row under the composer (2026-09-23).
 *
 *                                   ctrl+c interrupt · ctrl+o activity · shift+tab mode
 *
 * Only the keys that work RIGHT NOW, read from the same run state the header
 * draws (ui/headerstate.js): while a turn runs, how to stop it and look inside
 * it; when idle, how to reach commands and files. It repeats nothing the header
 * says (project, model, state, tokens). The key in the text colour, its word
 * muted, right-aligned. Given up first on a short terminal and hidden while a
 * panel is open, since the panel sits in its place (ui/geometry.js).
 */

const RUNNING = [['ctrl+c', 'interrupt'], ['ctrl+o', 'activity'], ['shift+tab', 'mode']];
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
