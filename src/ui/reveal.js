'use strict';

/** PROSE THAT RESOLVES — the model's words, presented rather than dumped. */

/** Cost of one visible character. The unit everything else is priced in. */
const CHAR = 1;
/** A line ending — a small beat at the end of a line. */
const NEWLINE = 6;
/** A blank line: the settle between two paragraphs. */
const PARAGRAPH = 40;
/** Units per second. Fast enough to read as motion rather than as typing. */
const UNITS_PER_SEC = 520;
/** However long the text, it is resolved by here. */
const MAX_MS = 1500;
/** How deep behind the leading edge characters are still unsettled. */
const BAND = 14;
/** How often the unsettled glyphs change. Fast, but not every frame. */
const SCRAMBLE_MS = 55;

/** The unsettled glyphs. */
const GLYPHS = '░▒▓#%&$@*+=<>/\\|~^';

/** Only letters and digits are ever scrambled. Structure is left alone. */
const SCRAMBLABLE = /[A-Za-z0-9]/;

/** Cheap, stable, and different for adjacent positions. */
function pick(i, tick) {
  const h = ((i * 2654435761) ^ (tick * 40503)) >>> 0;
  return GLYPHS[(h >>> 7) % GLYPHS.length];
}

/** A DETERMINISTIC 0..1 FOR THIS POSITION AT THIS TICK. */
function noise(i, tick) {
  const h = ((i * 374761393) ^ (tick * 668265263) ^ (i << 5)) >>> 0;
  return (h % 10007) / 10007;
}

/** EVERYTHING UP TO `end`, WITH AN UNSETTLED FRONT ON IT. */
function front(s, end, p, tick) {
  if (end <= 0) return '';
  const band = Math.round(BAND * Math.min(1, Math.max(0, 1 - p) * 3));
  const from = Math.max(0, end - band);
  let out = s.slice(0, from);
  for (let i = from; i < end; i++) {
    const ch = s[i];
    if (!SCRAMBLABLE.test(ch)) { out += ch; continue; }
    // THE WAVE
    const k = (end - 1 - i) / Math.max(1, band);
    out += noise(i, tick) < 1 - k ? pick(i, tick) : ch;
  }
  return out;
}

/** THE SAME EFFECT, DRIVEN BY A FRACTION RATHER THAN BY A CLOCK. */
function emerge(text, p, tick = 0) {
  const s = String(text == null ? '' : text);
  if (!s) return s;
  const f = Math.max(0, Math.min(1, Number(p) || 0));
  if (f >= 1) return s;
  return front(s, Math.ceil(s.length * f), f, Math.floor(tick) || 0);
}

/** What one character of this text costs to emit. */
function costOf(ch, prev) {
  if (ch === '\n') return prev === '\n' ? PARAGRAPH : NEWLINE;
  return CHAR;
}

/** Total cost of the text, in units. */
function unitsOf(text) {
  let n = 0;
  let prev = '';
  for (const ch of text) { n += costOf(ch, prev); prev = ch; }
  return n;
}

/** How long this text takes to resolve, in milliseconds. */
function duration(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  return Math.ceil(Math.min(MAX_MS, (unitsOf(s) / UNITS_PER_SEC) * 1000));
}

/** Structure that must arrive whole lines at a time. */
function marked(text) {
  return require('./markdown').looksMarked(text);
}

/** The text as it stands at `now`. */
function resolve(text, startedAt, now) {
  const s = String(text == null ? '' : text);
  if (!s || !startedAt) return s;
  // SETTLED LONG AGO, WITHOUT MEASURING IT
  if (Number(now) - Number(startedAt) >= MAX_MS) return s;
  const total = duration(s);
  const elapsed = Math.max(0, Number(now) - Number(startedAt));
  if (!total || elapsed >= total) return s;

  const budget = unitsOf(s) * (elapsed / total);

  // ---- MARKED TEXT: WHOLE LINES ----------------------------------------
  if (marked(s)) {
    const lines = s.split('\n');
    let spent = 0;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const cost = lines[i].length + (i ? (lines[i - 1] === '' ? PARAGRAPH : NEWLINE) : 0);
      if (spent + cost > budget) break;
      spent += cost;
      out.push(lines[i]);
    }
    return out.length ? out.join('\n') : '';
  }

  // ---- PLAIN PROSE: CHARACTER BY CHARACTER, WITH A BAND -----------------
  const tick = Math.floor(elapsed / SCRAMBLE_MS);
  let spent = 0;
  let end = 0;
  let prev = '';
  for (let i = 0; i < s.length; i++) {
    const c = costOf(s[i], prev);
    if (spent + c > budget) break;
    spent += c;
    prev = s[i];
    end = i + 1;
  }
  if (!end) return '';
  return front(s, end, elapsed / total, tick);
}

/** Is anything still resolving? */
function pending(entries, now) {
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || !e.at) continue;
    // Past the cap it is settled, whatever it says — see `resolve`.
    const age = Number(now) - Number(e.at);
    if (age >= MAX_MS) continue;
    if (age < duration(e.text)) return true;
  }
  return false;
}

module.exports = {
  resolve, pending, duration, unitsOf, marked, noise, front, emerge,
  CHAR, NEWLINE, PARAGRAPH, UNITS_PER_SEC, MAX_MS, BAND, SCRAMBLE_MS, GLYPHS,
};
