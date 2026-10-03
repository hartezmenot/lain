'use strict';

/** WIDTH MATHS THAT SURVIVES COLOUR. */

/** One SGR sequence — the only escape LAIN ever emits into drawn content. */
const SGR = /\x1b\[[0-9;]*m/;
const SGR_G = /\x1b\[[0-9;]*m/g;
const SGR_HEAD = /^\x1b\[[0-9;]*m/;
const RESET = '\x1b[0m';

/** The string as the terminal will show it, with all colour removed. */
function strip(s) {
  return String(s == null ? '' : s).replace(SGR_G, '');
}

/** EAST ASIAN WIDE AND FULLWIDTH, as inclusive code-point ranges. */
const WIDE = [
  [0x1100, 0x115f],   // Hangul Jamo, initial consonants
  [0x2e80, 0x303e],   // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff],   // kana, Bopomofo, Hangul compatibility, CJK compatibility
  [0x3400, 0x4dbf],   // CJK unified ideographs extension A
  [0x4e00, 0x9fff],   // CJK unified ideographs  <- the reported failure lives here
  [0xa000, 0xa4cf],   // Yi
  [0xa960, 0xa97f],   // Hangul Jamo extended-A
  [0xac00, 0xd7a3],   // Hangul syllables
  [0xf900, 0xfaff],   // CJK compatibility ideographs
  [0xfe10, 0xfe19],   // vertical forms
  [0xfe30, 0xfe6f],   // CJK compatibility forms, small form variants
  [0xff00, 0xff60],   // fullwidth ASCII and punctuation
  [0xffe0, 0xffe6],   // fullwidth currency and signs
  [0x16fe0, 0x16fe4],
  [0x17000, 0x187f7], // Tangut
  [0x18800, 0x18cd5],
  [0x1b000, 0x1b2ff], // kana supplement and extended
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f300, 0x1f64f], // emoji: symbols, pictographs, emoticons
  [0x1f680, 0x1f6ff], // transport and map
  [0x1f900, 0x1f9ff], // supplemental symbols and pictographs
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // CJK extensions B and beyond
  [0x30000, 0x3fffd],
];

/** ZERO CELLS: a mark that composes onto the character before it, a format character that is never drawn, or a control. */
const ZERO_RE = /[\p{Mn}\p{Me}\p{Cf}]/u;

/** How many terminal cells ONE code point occupies. 0, 1 or 2. */
function cells(cp) {
  if (cp === 0) return 0;
  // C0 and C1 controls draw nothing.
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;                       // the whole ASCII/Latin-1 fast path
  const ch = String.fromCodePoint(cp);
  if (ZERO_RE.test(ch)) return 0;
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < WIDE[mid][0]) hi = mid - 1;
    else if (cp > WIDE[mid][1]) lo = mid + 1;
    else return 2;
  }
  return 1;
}

/** How many cells this string occupies. */
function width(s) {
  const t = String(s == null ? '' : s);
  let n = 0;
  let i = 0;
  while (i < t.length) {
    if (t.charCodeAt(i) === 0x1b) {
      const m = SGR_HEAD.exec(t.slice(i));
      if (m) { i += m[0].length; continue; }
    }
    const cp = t.codePointAt(i);
    n += cells(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return n;
}

/** Does this string carry colour? Cheap enough to gate the slow path on. */
function hasAnsi(s) {
  return SGR.test(String(s == null ? '' : s));
}

/** Truncate to `w` CELLS, ellipsis included, colour preserved. */
function clip(s, w) {
  const t = String(s == null ? '' : s);
  if (w <= 1) return '';
  if (width(t) <= w) return t;
  // THE BUDGET IS CELLS, AND THE ELLIPSIS COSTS ONE OF THEM
  const budget = w - 1;
  let out = '';
  let used = 0;
  let i = 0;
  while (i < t.length) {
    if (t.charCodeAt(i) === 0x1b) {
      const m = SGR_HEAD.exec(t.slice(i));
      // Escapes cost no cells and are copied through, so a clip lands in the
      // same place a plain equivalent would.
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = t.codePointAt(i);
    const n = cells(cp);
    // A WIDE GLYPH IS TAKEN WHOLE OR NOT AT ALL.
    if (used + n > budget) break;
    out += cp > 0xffff ? t.slice(i, i + 2) : t[i];
    used += n;
    i += cp > 0xffff ? 2 : 1;
  }
  // The truncation may have cut before the closing reset. Leaving colour open
  // would bleed it across the rest of the drawn row.
  return out + '…' + (hasAnsi(out) ? RESET : '');
}

/** A TAB IS NOT A CHARACTER, AND IT MUST NEVER REACH A PAINTED REGION. */
function detab(s, stop = 8) {
  const t = String(s == null ? '' : s);
  if (!t.includes('\t')) return t;
  let out = '';
  let col = 0;
  let i = 0;
  while (i < t.length) {
    // A WHOLE ESCAPE SEQUENCE OCCUPIES NO COLUMNS — not just its first byte.
    const esc = SGR_HEAD.exec(t.slice(i));
    if (esc) { out += esc[0]; i += esc[0].length; continue; }
    if (t[i] === '\t') {
      const n = stop - (col % stop);
      out += ' '.repeat(n);
      col += n;
      i += 1;
      continue;
    }
    out += t[i];
    col += 1;
    i += 1;
  }
  return out;
}

/** Fill to `w` cells. Never truncates — see `fit` for that. */
function pad(s, w) {
  const t = String(s == null ? '' : s);
  const n = width(t);
  return n >= w ? t : t + ' '.repeat(w - n);
}

/** Right-align to `w` cells. */
function padStart(s, w) {
  const t = String(s == null ? '' : s);
  const n = width(t);
  return n >= w ? t : ' '.repeat(w - n) + t;
}

/** Clip AND pad: exactly `w` cells, whatever came in. */
function fit(s, w) {
  return pad(clip(s, w), w);
}

/** Centre within `w`, measuring visibly. */
function center(s, w) {
  const t = clip(s, w);
  const n = width(t);
  return ' '.repeat(Math.max(0, Math.floor((w - n) / 2))) + t;
}

/** Shorten a path from the LEFT, keeping the end — the part that identifies the project. */
function shortPath(p, w) {
  const s = String(p || '');
  if (s.length <= w) return s;
  const sep = s.includes('\\') ? '\\' : '/';
  const parts = s.split(sep);
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i > 0; i--) {
    const next = parts[i] + sep + out;
    // The result gets an ellipsis AND a separator in front of it — two characters, not one.
    if (next.length + 2 > w) break;
    out = next;
  }
  return clip('…' + sep + out, w);
}

/** The folder name — what the user calls the project. */
function projectName(cwd) {
  const s = String(cwd || '').replace(/[\\/]+$/, '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

/** A LABELLED FRAME around a block of lines. */
function box(title, lines, w) {
  const width_ = Math.max(20, w);
  const inner = width_ - 4;
  const head = title ? ' ' + String(title) + ' ' : '';
  const room = width_ - 3 - width(head);
  const out = [room >= 0 ? '┌─' + head + '─'.repeat(room) + '┐' : '┌' + '─'.repeat(width_ - 2) + '┐'];
  for (const l of lines) out.push('│ ' + fit(l, inner) + ' │');
  out.push('└' + '─'.repeat(width_ - 2) + '┘');
  return out;
}

/** TAKE AS MANY CODE POINTS AS FIT IN `w` CELLS. */
function hardSlice(s, w) {
  const t = String(s == null ? '' : s);
  let out = '';
  let used = 0;
  let i = 0;
  while (i < t.length && used < w) {
    if (t.charCodeAt(i) === 0x1b) {
      const m = SGR_HEAD.exec(t.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }   // escapes cost no columns
    }
    const cp = t.codePointAt(i);
    const n = cells(cp);
    if (used + n > w) break;                                 // whole glyph, or none
    out += cp > 0xffff ? t.slice(i, i + 2) : t[i];
    used += n;
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

module.exports = {
  strip, width, cells, hasAnsi, detab, clip, hardSlice, pad, padStart, fit, center,
  shortPath, projectName, box, RESET,
};
