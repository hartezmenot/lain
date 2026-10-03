'use strict';

/** THE TERMINAL TAB TITLE. */

let installed = false;
let last = '';
let writer = null;

/** Let the terminal UI route OSC around its own stdout capture layer. */
function setWriter(fn = null) { writer = typeof fn === 'function' ? fn : null; }

function write(s) {
  const out = writer || ((text) => process.stdout.write(text));
  out(s);
}

function enabled() {
  // LAIN_FORCE_TUI runs the real draw path over a pipe so the suite can assert on what the real binary actually emits.
  if (!process.stdout || (!process.stdout.isTTY && process.env.LAIN_FORCE_TUI !== '1')) return false;
  if (process.env.LAIN_NO_TITLE) return false;
  if (String(process.env.TERM || '').toLowerCase() === 'dumb') return false;
  return true;
}

/** Collapse whitespace, drop control characters, clip to a tab's worth. */
function clean(s, max = 72) {
  const t = String(s == null ? '' : s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** THE FIVE TITLE STATES. */
const STATE = Object.freeze({
  IDLE: 'idle',
  WORKING: 'working',
  SUCCESS: 'success',
  PAUSED: 'paused',
  ERROR: 'error',
});

/** The glyphs. */
const SPIN = ['◐', '◓', '◑', '◒'];
const SPIN_MS = 250;
const TICK = '✓';
const PAUSE = 'Ⅱ';
const CROSS = '✕';

/** How long the success glyph holds before the title goes quiet again. */
const SUCCESS_MS = 4000;

/** STATES IN WHICH LAIN IS STOPPED RATHER THAN WORKING. */
const PAUSED_WORDS = new Set([
  'WAITING FOR LIMIT RESET', 'RATE LIMITED', 'RETRYING', 'NETWORK',
  'INTERRUPTING', 'INTERRUPTED', 'RETRY CANCELLED',
  'STOPPED', 'STEP LIMIT', 'BLOCKED',
  'WAITING FOR YOU', 'ASKING USER',
]);

/** Classify the live row's state into one of the five, in PRECEDENCE ORDER. */
function stateOf(live) {
  if (!live || !live.word) return STATE.IDLE;
  const word = String(live.word).toUpperCase();
  // A GENUINE FAILURE. `bad` is the live row's own colour for the states that
  // are over and went wrong — ERROR, FAILED, NOT AUTHENTICATED, CONTEXT FULL.
  if (live.colour === 'bad') return STATE.ERROR;
  // STOPPED, INCLUDING A RATE LIMIT — checked before `spin`, see the header.
  if (PAUSED_WORDS.has(word)) return STATE.PAUSED;
  if (live.spin) return STATE.WORKING;
  // SUCCESS IS THE TURN RECORD SAYING SO, never "output stopped arriving".
  if (live.tick) return STATE.SUCCESS;
  return STATE.IDLE;
}

/** The glyph for a state, at this moment. '' for idle. */
function glyph(state, now = Date.now()) {
  if (state === STATE.WORKING) return SPIN[Math.floor(now / SPIN_MS) % SPIN.length];
  if (state === STATE.SUCCESS) return TICK;
  if (state === STATE.PAUSED) return PAUSE;
  if (state === STATE.ERROR) return CROSS;
  return '';
}

/** Compose the title. */
function compose({ folder = '', state = STATE.IDLE, now = Date.now() } = {}) {
  const name = clean(folder, 28) || 'LAIN';
  const g = glyph(state, now);
  return g ? `${g} ${name}` : name;
}

/** Write a title. Identical repeats are dropped — this runs on every redraw. */
function set(text) {
  const title = clean(text, 100);
  if (!title || title === last) return false;
  if (!enabled()) { last = title; return false; }
  try {
    write(`\x1b]0;${title}\x07\x1b]2;${title}\x07`);
    installed = true;
    last = title;
    return true;
  } catch { return false; }
}

/** compose + set, plus the ONE thing the title does that the screen does not: it lets a success go quiet by itself. */
let successTimer = null;

function update(parts = {}) {
  if (successTimer) { clearTimeout(successTimer); successTimer = null; }
  const written = set(compose(parts));
  if (parts.state === STATE.SUCCESS) {
    const folder = parts.folder;
    successTimer = setTimeout(() => {
      successTimer = null;
      // Composed fresh rather than remembered: `set` drops an identical repeat, so if something else has since written the same idle title this costs nothing…
      try { set(compose({ folder, state: STATE.IDLE })); } catch { /* chrome */ }
    }, SUCCESS_MS);
    if (successTimer.unref) successTimer.unref();
  }
  return written;
}

/** Hand the tab back. */
function restore() {
  // A PENDING TICK MUST NOT WRITE ONTO A TAB WE HAVE ALREADY HANDED BACK.
  if (successTimer) { clearTimeout(successTimer); successTimer = null; }
  if (!installed) return false;
  try {
    write('\x1b]0;\x07\x1b]2;\x07');
    installed = false;
    last = '';
    return true;
  } catch { return false; }
}

module.exports = { set, update, compose, stateOf, glyph, clean, restore, enabled, setWriter, STATE, SPIN, SPIN_MS, TICK, PAUSE, CROSS, SUCCESS_MS, PAUSED_WORDS };
