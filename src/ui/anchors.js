'use strict';

/** WHAT THE USER SAID, AS SOMETHING YOU CAN NAVIGATE BACK TO. */

/** The words that are a decision rather than a message. */
const DECISION = new RegExp(
  '^(?:'
  + 'y|n|yes|no|yeah|yep|nope|ok|okay|sure|go|go\\s+ahead|do\\s+it|proceed|continue|carry\\s+on|'
  + 'approved|approve|accept|confirm|confirmed|'
  + 'stop|cancel|abort|halt|undo|revert|retry|again|skip|'
  + 'option\\s+[a-z0-9]|[a-z]|[0-9]{1,2}'
  + ')$', 'i');

/** Words a decision may be padded with without becoming a message. */
const POLITE = /^(?:please|just|now|then|ok|okay|right|thanks|thank\s+you)\b/i;

/** At most this many words, or it is a message. */
const MAX_WORDS = 4;

/** Which of the three this text is. */
function kindOf(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return 'MESSAGE';
  if (require('./pasted').isPaste(s)) return 'REQUEST';
  let t = s.trim().replace(/[.!,;:]+$/, '');
  // Strip one leading politeness — "please proceed" is still a decision.
  const p = POLITE.exec(t);
  if (p && t.length > p[0].length) t = t.slice(p[0].length).trim().replace(/^[,;:]\s*/, '');
  if (!t) return 'MESSAGE';
  if (t.split(/\s+/).length > MAX_WORDS) return 'MESSAGE';
  return DECISION.test(t) ? 'DECISION' : 'MESSAGE';
}

/** The label drawn above the block: USER · USER DECISION · USER REQUEST — and USER STEER for words sent into a running turn. */
function label(text, { steer = false } = {}) {
  const k = kindOf(text);
  return k === 'DECISION' ? 'USER DECISION' : k === 'REQUEST' ? 'USER REQUEST' : steer ? 'USER STEER' : 'USER';
}

/** WHERE THE ANCHORS ARE in a rendered feed, as row indices. */
function rowsIn(lines) {
  if (!lines || !lines.userAt) return [];
  const rows = Object.keys(lines.userAt).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  // EVERY MAPPED ROW IS AN ANCHOR: a message is drawn as ONE row now (ui/feeduser.js),
  // so two adjacent rows are two messages, never one message's two lines.
  return rows;
}

/** How much of a long prompt the anchor shows before it trails off. */
const ANCHOR_MAX = 52;

/** THE PROMPT AS ONE LINE — what the anchor previews. */
function preview(text, width = ANCHOR_MAX) {
  const T = require('./text');
  let t = T.strip(String(text == null ? '' : text));
  // A WALL IS MARKED, NOT QUOTED
  try {
    if (require('./pasted').isPaste(t)) {
      const lines = t.split(/\r?\n/);
      const first = lines.find((l) => l.trim()) || '';
      const rest = lines.slice(lines.indexOf(first) + 1).some((l) => l.trim());
      t = rest ? `${first.trim()} ${require('./composer').PLACEHOLDER}` : first.trim();
    }
  } catch { /* a preview that cannot mark a paste still previews the text */ }
  // NEWLINES AND RUNS OF WHITESPACE COLLAPSE: four paragraphs read as one
  // sentence rather than as a row of fragments.
  t = t.replace(/\s+/g, ' ').trim();
  // TRUNCATED BY VISIBLE WIDTH. `clip` appends the ellipsis itself, so adding one
  // here produced `……` — which is what happens when two layers both own the mark.
  return T.width(t) <= Math.max(8, Math.floor(width)) ? t : T.clip(t, Math.max(8, Math.floor(width)));
}

/** THE SCROLL ANCHOR — `USER · fix the continuation bug…`, or null. */
function scrollAnchor(lines, scroll = 0, height = 0) {
  const rows = rowsIn(lines);
  if (!rows.length) return null;
  const row = rows[rows.length - 1];
  // ALREADY IN VIEW: THERE IS NOTHING TO ANCHOR TO
  const rowsShown = Math.max(0, Math.floor(height));
  if (!rowsShown) return null;
  if (row >= scroll && row < scroll + rowsShown) return null;
  const text = String((lines.userAt && lines.userAt[row]) || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const kind = label(text);
  const body = preview(text, ANCHOR_MAX);
  // THE MARK IS NAVIGATION, NOT CONTENT
  return { row, kind, text, mark: `USER · ${body}`, label: `${kind} · ${body}` };
}

module.exports = { kindOf, label, rowsIn, scrollAnchor, preview, DECISION, MAX_WORDS, ANCHOR_MAX };
