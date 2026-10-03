'use strict';

/** PENDING USER INPUT — what you said while LAIN was still working. */

const T = require('./text');
const { P } = require('./paint');

/** At most this many are drawn; the rest are counted. */
const MAX_SHOWN = 3;

/** The pending list as `{ text, now }`, however the snapshot carries it. */
function itemsOf(state) {
  const raw = (state && state.pending) || [];
  return raw
    .map((s) => (s && typeof s === 'object'
      ? { text: String(s.text || '').trim(), now: s.mode === 'NOW' }
      : { text: String(s || '').trim(), now: false }))
    .filter((s) => s.text);
}

/** THE WHOLE SHAPE IN ONE PLACE: how many lines are drawn, how many are only counted, and how many rows that adds up to. */
function plan(state, room = 99) {
  const items = itemsOf(state);
  if (!items.length || room < 2) return { shown: 0, hidden: 0, rows: 0 };
  let shown = Math.min(items.length, MAX_SHOWN, room - 1);
  // A count line is needed the moment anything is left out, and it needs a row
  // of its own — so making space for it can cost one of the lines it counts.
  if (items.length > shown && 1 + shown + 1 > room) shown = room - 2;
  if (shown < 1) return { shown: 0, hidden: 0, rows: 0 };
  const hidden = items.length - shown;
  return { shown, hidden, rows: 1 + shown + (hidden > 0 ? 1 : 0) };
}

/** How many rows the region wants. Zero when nothing is waiting. */
function rows(state, room = 99) { return plan(state, room).rows; }

/** How many of them a given height can actually show. */
function shownCount(state, height) { return plan(state, height).shown; }

/** The region as exactly `height` lines of `width` cells. */
function draw(state, width = 80, height = 0) {
  if (height <= 0) return [];
  const out = [];
  const items = itemsOf(state);
  const shown = shownCount(state, height);
  // WHAT THE HEADING PROMISES DEPENDS ON WHEN IT WILL BE DELIVERED.
  const anyNow = items.some((s) => s.now);
  // A LABEL, NOT A RULE — see ui/jobsview.js for why the surface keeps exactly
  // one horizontal line and it belongs to the header.
  const label = anyNow ? 'Steering now' : 'Waiting to send';
  out.push(T.fit(P.meta(label), width));
  for (let i = 0; i < shown; i++) {
    // The text is the USER's, painted as the user — it is not LAIN speaking and it is not something that has happened.
    const marker = items[i].now ? P.warn('⚑ ') : P.meta('▸ ');
    out.push(T.fit('  ' + marker + T.clip(items[i].text, Math.max(4, width - 4)), width));
  }
  const hidden = items.length - shown;
  if (hidden > 0 && out.length < height) {
    out.push(T.fit('  ' + P.meta(`… and ${hidden} more waiting`), width));
  }
  while (out.length < height) out.push(T.fit('', width));
  return out.slice(0, height);
}

module.exports = { rows, draw, itemsOf, shownCount, plan, MAX_SHOWN };
