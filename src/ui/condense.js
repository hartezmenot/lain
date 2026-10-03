'use strict';

/** NARRATION THAT THE SCREEN ALREADY SAYS — dropped, because it is a second copy. */

const { trimRestatement } = require('./phrasing');

/** A newline, as a value. */
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/** THE VOCABULARY MOVED, AND THAT IS THE WHOLE OF THE CHANGE HERE. */
const classify = require('./classify');

const {
  MAX_LINE, CARRIES_RESULT, SENTENCE_SPLIT, FENCE,
} = classify;

/** Is this line, on its own, nothing but narration of what the screen shows? */
function isNarration(line) {
  const t = String(line == null ? '' : line).trim();
  if (!t) return false;
  return classify.renderPolicy(classify.classifySentence(t).class) === classify.DECISION.SUPPRESS;
}

/** Why a line was hidden — the class and the rule, for the audit tool. */
function why(line) {
  const c = classify.classifySentence(String(line == null ? '' : line).trim());
  return { class: c.class, decision: classify.renderPolicy(c.class), why: c.why };
}

/** THROAT-CLEARING IN FRONT OF A REAL FACT — removed WITHOUT the fact. */
const PREFACE = new RegExp(
  // ONE LEADING-WHITESPACE GROUP for both families.
  '^(\\s*)(?:'
  // ANNOUNCING THAT SOMETHING IS ABOUT TO BE SAID
  + '(?:and\\s+)?(?:also[,]?\\s+)?'
  + '(?:(?:it(?:’s|\'s| is)\\s+)?worth\\s+(?:noting|mentioning|pointing\\s+out)'
  + '|interestingly'
  + '|one\\s+thing\\s+(?:to\\s+note|worth\\s+noting))'
  + '[,:]?\\s+(?:that\\s+)?'
  // THE SEAM OF A MONOLOGUE, RIDING ON A REAL FACT
  + '|(?:actually|hmm+|wait|but\\s+wait|so\\s+actually|in\\s+fact)[,:]\\s+'
  + ')(?=\\S)', 'i');

/** The sentence with any such preface taken off, or unchanged. */
function unpreface(line) {
  const t = String(line);
  const m = PREFACE.exec(t);
  if (!m) return t;
  const rest = t.slice(m[0].length);
  if (!rest.trim()) return t;                 // the preface WAS the whole sentence
  return m[1] + rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** ONE LINE, WITH THE ANNOUNCEMENTS INSIDE IT TAKEN OUT. */
function trimSentences(line) {
  const parts = String(line).split(SENTENCE_SPLIT);
  // A PREFACE IS TAKEN OFF WHETHER OR NOT ANYTHING IS DROPPED — it is a trim of one sentence, not a decision about the line, so it applies to the…
  const prefaced = parts.map(unpreface);
  const moved = prefaced.some((p, i) => p !== parts[i]);
  if (parts.length < 2) return moved ? prefaced[0] : line;
  const kept = prefaced.filter((p) => !isNarration(p));
  if (kept.length === prefaced.length && !moved) return line;
  if (!kept.length) return null;
  // The indentation of the line is the line's, and survives the rebuild.
  const lead = (/^[ \t]*/.exec(line) || [''])[0];
  return lead + kept.join(' ').trim();
}

/** The message, with the narration taken out. */
function prose(text, { last = true } = {}) {
  const src = trimRestatement(String(text == null ? '' : text));
  if (!src.trim()) return src;
  const lines = src.split(CR + NL).join(NL).split(NL);
  const out = [];
  let fenced = false;
  let cut = 0;
  for (const line of lines) {
    if (FENCE.test(line)) { fenced = !fenced; out.push(line); continue; }
    if (!fenced && isNarration(line)) { cut += 1; continue; }
    if (fenced) { out.push(line); continue; }
    // A PARAGRAPH ON ONE LINE is the shape a real model writes in, and the
    // announcement is one sentence inside it. See SENTENCE_SPLIT.
    const trimmed = trimSentences(line);
    if (trimmed === null) { cut += 1; continue; }
    if (trimmed !== line) cut += 1;
    out.push(trimmed);
  }
  if (!cut) return src;
  // A GAP LEFT BY A REMOVED LINE IS NOT A PARAGRAPH BREAK.
  const joined = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
  if (joined.trim()) return joined;
  // EVERYTHING WAS NARRATION.
  return last ? src : '';
}


/** PAST THIS MUCH PROSE MID-TURN, THE FEED SHOWS THE FINDING AND POINTS AT THE REST. */
const FOLD_CHARS = 320;
/** At most this many result-bearing sentences survive the fold. */
const FOLD_KEEP = 2;

/** The message as ACTIVITY should draw it, and whether anything was held back. */
function fold(text, { last = true } = {}) {
  const src = String(text == null ? '' : text);
  const plain = { text: src, folded: false };
  if (last || src.length <= FOLD_CHARS) return plain;
  // A fence means the substance is code, and code does not fold.
  const lines = src.split(CR + NL).join(NL).split(NL);
  if (lines.some((l) => FENCE.test(l))) return plain;

  const sentences = [];
  for (const line of lines) {
    // A markdown heading ("## Fix") labels a section; it is not a sentence to keep.
    if (!line.trim() || /^\s*#{1,6}\s/.test(line)) continue;
    for (const part of line.split(SENTENCE_SPLIT)) if (part.trim()) sentences.push(part.trim());
  }
  if (sentences.length < 2) return plain;

  // WHAT SURVIVES A FOLD IS CHOSEN BY CLASS FIRST
  const preserved = sentences.filter(
    (x) => classify.renderPolicy(classify.classifySentence(x).class) === classify.DECISION.PRESERVE);
  const carrying = sentences.filter((x) => CARRIES_RESULT.test(x) && !preserved.includes(x));
  const chosen = [...preserved, ...carrying].slice(0, FOLD_KEEP);
  // EACH KEPT SENTENCE ENDS AS ONE.
  const stop = (x) => (/[.!?:;…]["')\]]?$/.test(x) ? x : `${x}.`);
  const kept = (chosen.length ? chosen : [sentences[0]]).map(stop).join(' ');
  // NOT WORTH FOLDING. If what survives is most of what went in, the fold has
  // bought a pointer and nothing else, and the pointer is then pure noise.
  if (kept.length >= src.length * 0.7) return plain;
  return { text: kept, folded: true };
}

/** How many SENTENCES this message would lose. */
function cutCount(text) {
  const src = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  let fenced = false;
  let n = 0;
  for (const line of src) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line.trim()) continue;
    if (isNarration(line)) { n += 1; continue; }
    for (const s of line.split(SENTENCE_SPLIT)) if (isNarration(s)) n += 1;
  }
  return n;
}

module.exports = {
  prose, isNarration, why, trimSentences, unpreface, fold, cutCount,
  MAX_LINE, FOLD_CHARS, FOLD_KEEP,
};
