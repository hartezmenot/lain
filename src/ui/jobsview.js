'use strict';

/** WHAT IS RUNNING THAT YOU ARE NOT LOOKING AT — one compact region. */

const T = require('./text');
const { P } = require('./paint');

/** How many job rows the region will ever draw. Past this it counts. */
const MAX_SHOWN = 4;
/** How long a finished job keeps its row so its ending can be seen. */
const KEEP_DONE_MS = 20_000;

/** The jobs worth a row: background work, plus anything that just ended. */
function itemsOf(state, now = Date.now()) {
  const all = (state && state.jobs) || [];
  return all.filter((j) => {
    if (!j || j.primary) return false;               // the conversation is not a row
    if (!j.endedAt) return true;                     // still going
    return now - j.endedAt < KEEP_DONE_MS;           // just ended, briefly
  });
}

/** THE WHOLE SHAPE IN ONE PLACE: how many rows are drawn, how many are only counted, and what that adds up to. */
function plan(state, room = 99, now = Date.now()) {
  const items = itemsOf(state, now);
  if (!items.length || room < 2) return { shown: 0, hidden: 0, rows: 0 };
  let shown = Math.min(items.length, MAX_SHOWN, room - 1);
  if (items.length > shown && 1 + shown + 1 > room) shown = room - 2;
  if (shown < 1) return { shown: 0, hidden: 0, rows: 0 };
  const hidden = items.length - shown;
  // A PARKED JOB COSTS A SECOND ROW for its question.
  const asking = items.slice(-shown).filter((j) => j.needsInput && j.question).length;
  const want = 1 + shown + asking + (hidden > 0 ? 1 : 0);
  return { shown, hidden, rows: Math.min(want, Math.max(0, room)) };
}

/** How many rows the region wants. Zero when nothing is running. */
function rows(state, room = 99, now = Date.now()) { return plan(state, room, now).rows; }

/** HOW LONG THE JOB HAS BEEN AT IT — the one elapsed vocabulary in LAIN. */
const secs = (ms) => require('./workclock').hhmmss(ms);

/** One job, as one row: what it is, what state, and what it is doing now. */
function line(j, width) {
  // NEEDS INPUT IS THE LOUDEST NON-FAILURE STATE, because it is the only one that will not clear on its own.
  const mark = j.state === 'SUCCEEDED' ? P.ok('✓')
    : j.state === 'FAILED' ? P.bad('✗')
      : j.state === 'CANCELLED' ? P.meta('■')
        : j.needsInput ? P.warn('?') : j.waiting ? P.warn('◒') : P.info('●');
  const state = j.state === 'SUCCEEDED' ? P.ok('COMPLETED')
    : j.state === 'FAILED' ? P.bad('FAILED')
      : j.state === 'CANCELLED' ? P.meta('CANCELLED')
        : j.needsInput ? P.warn('NEEDS INPUT') : j.waiting ? P.warn('WAITING') : P.info('RUNNING');
  const head = `  ${mark} ${P.meta('#' + j.id)} `;
  // The request is what it IS; the activity is what it is doing about it. The
  // second only earns room once the first has had enough.
  const room = Math.max(10, width - 34);
  const what = T.clip(String(j.request || '').replace(/\s+/g, ' '), Math.max(8, Math.floor(room * 0.55)));
  const doing = j.done ? (j.error || '') : String(j.activity || '');
  const tail = doing ? P.meta('  ' + T.clip(doing.replace(/\s+/g, ' '), Math.max(6, room - what.length))) : '';
  return T.fit(`${head}${state}  ${P.plain(what)}${tail}  ${P.meta(secs(j.elapsedMs))}`, width);
}

/** The region as exactly `height` rows of `width` cells. */
function draw(state, width = 80, height = 0, now = Date.now()) {
  if (height <= 0) return [];
  const { shown, hidden } = plan(state, height, now);
  if (!shown) return new Array(height).fill(T.fit('', width));
  const items = itemsOf(state, now);
  // A LABEL, NOT A SECOND FULL-WIDTH RULE
  const out = [T.fit(P.meta('Background'), width)];
  // NEWEST LAST, so a job that has just started appears next to the input where
  // the eye already is, and the list does not reorder itself as jobs finish.
  for (const j of items.slice(-shown)) {
    out.push(line(j, width));
    // THE QUESTION GETS ITS OWN ROW when there is one.
    if (j.needsInput && j.question && out.length < height) {
      out.push(T.fit(P.meta('       ') + P.plain(T.clip(String(j.question), Math.max(10, width - 10))), width));
    }
  }
  if (hidden > 0) out.push(T.fit(P.meta(`    … and ${hidden} more · /jobs`), width));
  while (out.length < height) out.push(T.fit('', width));
  return out.slice(0, height);
}

module.exports = { rows, draw, plan, itemsOf, line, MAX_SHOWN, KEEP_DONE_MS };
