'use strict';

/** DRAWING THE TIMELINE — the label, the target under it, the compact history. */

const T = require('./text');
const { P } = require('./paint');
const { PHASE } = require('./playback');

/** How wide the target line may be, however wide the pane. */
const MAX_TARGET = 52;
/** The target sits under its verb, and the indent is what says "of this". */
const TARGET_INDENT = '    ';
/** How many finished activities stay visible. Older ones are still in the record. */
const MAX_HISTORY = 40;

/** `+72 -40`, coloured semantically, or '' when this is not an edit. */
function counts(added, removed, dir) {
  if (!added && !removed) return '';
  const live = dir !== undefined;
  const up = !live ? '' : dir === 'add' ? '▲' : ' ';
  const down = !live ? '' : dir === 'remove' ? '▼' : ' ';
  return P.ok(`${up}+${added}`) + ' ' + P.bad(`${down}-${removed}`);
}

/** The ENTER and EXIT motion, in a terminal. */
function tone(phase) {
  if (phase === PHASE.ENTER || phase === PHASE.EXIT) return P.meta;
  return P.plain;
}

/** The active activity, as rows. */
function activeRows(active, width) {
  if (!active) return [];
  const room = Math.max(12, Math.min(MAX_TARGET, width - TARGET_INDENT.length - 2));
  const paint = tone(active.phase);
  const rows = [];

  // THE ONE THAT IS LEAVING, ABOVE THE ONE THAT IS ARRIVING
  if ((active.phase === PHASE.ENTER || active.still) && active.leaving) {
    // Already dim in its own right — `historyRow` paints the compact form, and
    // wrapping it in another dim would only be closed by its first inner reset.
    rows.push(historyRow(active.leaving, width));
  }

  // THE VERB, at the margin. It is what is happening, and it is the loud half.
  rows.push('  ' + paint(active.verb));

  const c = active.isEdit ? counts(active.added, active.removed, active.dir || null) : '';
  // NOT EVERY OPERATION HAS A SUBJECT.
  const subject = String(active.target || '') || String(active.name || '');
  // THE SUBJECT MATERIALISES; IT DOES NOT APPEAR
  const fit = T.clip(subject, room - (c ? T.width(c) + 3 : 0));
  const shown = active.phase === PHASE.ENTER
    ? require('./reveal').emerge(fit, active.enter == null ? 1 : active.enter, active.tick || 0)
    : fit;

  // SUBDUED, ALWAYS. The relationship is `WHAT IS HAPPENING` over `WHAT IT IS HAPPENING TO`, and the second one is support: it is read after the verb…
  rows.push(TARGET_INDENT + P.meta(shown) + (c && shown ? '   ' + c : ''));
  return rows;
}

/** HOW FAR BACK A FINISHED ROW IS, AS A WEIGHT. */
const SETTLING = 1;
const RECENT = 4;

function toneFor(indexFromEnd) {
  if (indexFromEnd < SETTLING) return { text: P.plain, quiet: P.meta };
  if (indexFromEnd < RECENT) return { text: P.meta, quiet: P.meta };
  return { text: P.faint, quiet: P.faint };
}

/** One finished activity, as the single quiet line it leaves behind. */
function historyRow(h, width, age = RECENT) {
  const tone = toneFor(age);
  const mark = h.ok === false ? P.bad('✗') : tone.quiet('·');
  const verb = tone.text(T.pad(h.verb, 8));
  const room = Math.max(10, width - 16);
  const target = tone.quiet(T.clip(String(h.target || ''), room));
  const c = h.isEdit && (h.added || h.removed) ? '   ' + counts(h.added, h.removed) : '';
  return `  ${mark} ${verb} ${target}${c}`;
}

/** The whole timeline: quiet history, then the live operation. */
function rows(state, width = 80) {
  if (!state) return [];
  const out = [];
  let hist = (state.history || []).slice(-MAX_HISTORY);
  // ONE ACTIVITY, ONE ROW, ALWAYS
  const leaving = state.active && state.active.leaving;
  if (leaving) {
    const last = hist[hist.length - 1];
    if (last && last.name === leaving.name && last.target === leaving.target) hist = hist.slice(0, -1);
  }
  // Newest finished row is age 0 and carries the most weight; the ones above it
  // recede. See `toneFor`.
  hist.forEach((h, i) => out.push(historyRow(h, width, hist.length - 1 - i)));
  const act = activeRows(state.active, width);
  if (act.length) {
    if (out.length) out.push('');
    for (const r of act) out.push(r);
  }
  return out;
}

/** THE DIFF WINDOW, as rows — see ui/diffreel.js for its lifecycle. */
/** The caret the editor is writing at. Drawn only on the line being written. */
const CARET = '▌';

/** ONE ROW OF THE EDITOR, painted for the state the reel says it is in. */
function editorRow(r, inner, tick = 0) {
  const no = P.meta(T.padStart(r.no ? String(r.no) : '', 4));
  if (r.state === 'gap') return no + ' ' + P.meta(T.pad(T.clip(r.text, inner - 5), inner - 5));
  const mark = r.kind === 'removed' ? '-' : r.kind === 'added' ? '+' : ' ';
  const room = inner - 7;
  // TABS ARE EXPANDED BEFORE ANYTHING MEASURES OR PAINTS THEM.
  const body = T.clip(T.detab(String(r.text || '')), room);
  let painted;
  if (r.state === 'struck') painted = P.bad(mark + ' ' + P.struck(body));
  else if (r.state === 'striking') {
    // THE PEN IS PART WAY ACROSS THIS LINE
    const cut = Math.max(0, Math.min(body.length, Number(r.cut) || 0));
    painted = P.bad(mark + ' ' + P.struck(body.slice(0, cut)) + body.slice(cut));
  }
  else if (r.state === 'writing') {
    // THE CHARACTER UNDER THE CURSOR IS STILL RESOLVING
    const edge = require('./reveal').emerge(body, 1 - Math.min(0.35, 6 / Math.max(6, body.length)), tick);
    painted = P.writing(mark + ' ' + edge + CARET);
  }
  else if (r.state === 'added') painted = P.ok(mark + ' ' + body);
  else if (r.state === 'blank') painted = P.meta(mark + ' ');
  else painted = P.plain(mark + ' ' + body);
  const used = 2 + T.width(body) + (r.state === 'writing' ? 1 : 0);
  return no + ' ' + painted + ' '.repeat(Math.max(0, room + 2 - used));
}

/** THE DIFF WINDOW, as rows — see ui/diffreel.js for its lifecycle. */
function diffRows(reel, width = 80) {
  if (!reel || !reel.open || reel.height <= 0) return [];
  const w = Math.min(Math.max(30, width - 4), 96);
  const inner = w - 4;
  const head = T.clip(String(reel.file || ''), Math.max(8, inner - 20));
  // WHERE IN THE CHANGE THIS IS — the hunk being performed, and the running
  // count. Both come from the reel, which derives them from the real script.
  const where = reel.hunks > 1 ? `${Math.min(reel.hunk + 1, reel.hunks)}/${reel.hunks}` : '';
  const tally = (reel.finalAdded || reel.finalRemoved)
    ? `+${reel.added} -${reel.removed}` : '';
  const right = [where, tally].filter(Boolean).join('  ');
  const fill = Math.max(1, w - 6 - T.width(head) - T.width(right));
  const out = [];
  out.push('  ' + P.editor('┌─ ' + head + ' ' + '─'.repeat(fill) + (right ? ' ' + right : '─') + '┐'));
  for (const r of reel.rows) {
    out.push('  ' + P.editor('│ ' + T.pad(editorRow(r, inner, reel.tick || 0), inner) + ' │'));
  }
  out.push('  ' + P.editor('└' + '─'.repeat(w - 2) + '┘'));
  return out;
}

module.exports = {
  rows, activeRows, historyRow, diffRows, editorRow, counts, tone,
  MAX_TARGET, MAX_HISTORY, CARET, TARGET_INDENT,
};
