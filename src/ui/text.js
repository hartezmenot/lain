'use strict';

/**
 * WIDTH MATHS THAT SURVIVES COLOUR.
 *
 * Every region of the screen is drawn by measuring a string and padding it out
 * to the frame — `'│ ' + line + ' '.repeat(inner - line.length) + ' │'`. With
 * `String.length` that arithmetic is a lie the moment a line carries an ANSI
 * escape: `\x1b[32m✓\x1b[0m` is ONE visible character and nine in memory, so a
 * coloured row loses its right-hand border and the frame tears open.
 *
 * That is why every workspace pane was plain text: the clipper could not see
 * colour, so colour was banned rather than measured. This module measures it,
 * and the ban goes away.
 *
 * THE RULE: nothing on screen is ever measured with `.length` again. `width()`
 * counts the CELLS the terminal will actually use; `clip()` truncates by cells
 * while copying the escapes through (they cost none); `pad()` fills to a cell
 * width. A clipped string that still had colour open is
 * closed with a reset, because a truncation must never leak its colour into the
 * rest of the row.
 *
 * ------------------------------------------------------------------------
 * ZERO-WIDTH AND DOUBLE-WIDTH ARE HANDLED HERE, AND ONLY HERE.
 *
 * This paragraph used to say they were not, and that "if that changes, it
 * changes HERE, in one function, and every region inherits it". It changed, for
 * the reason predicted: LAIN stopped drawing only box rules and ASCII the day a
 * provider answered
 *
 *     {"error":{"message":"鉴权服务请求失败: Invalid or expired api_key"}}
 *
 * and that message went onto the screen through the ordinary public-error path.
 * Eight CJK characters occupy SIXTEEN terminal cells and `String.length` sees
 * eight, so every row carrying them was measured at half its true size, padded
 * eight columns too far, and drew straight through the right-hand rail. The
 * report was "text escapes the content rails on resize"; the cause was never
 * the rails.
 *
 * THREE CLASSES, and every one of them is a real thing a provider can send:
 *
 *   ZERO   combining marks (`e` + U+0301 is one cell, two JS characters),
 *          variation selectors, the zero-width joiner, and C0/C1 controls,
 *          which must never be counted as the cell they do not occupy.
 *   WIDE   East Asian Wide and Fullwidth — CJK, kana, Hangul, fullwidth ASCII —
 *          and the emoji blocks, at two cells each.
 *   ONE    everything else, including every box rule, arrow and tick LAIN
 *          already drew. Those are East Asian *Ambiguous* and are deliberately
 *          counted as one: treating them as two would re-tear every frame in
 *          the tree to fix a case nobody reported.
 *
 * THE ERROR IS BIASED ON PURPOSE. Where a width is genuinely ambiguous — a ZWJ
 * emoji sequence that one terminal composes into a single glyph and another
 * draws as three — this OVERCOUNTS. An overcount wraps a line early, which
 * costs a column of whitespace; an undercount draws past the rail, which is the
 * defect this exists to end. Safe direction only.
 *
 * NOTHING HERE ITERATES JS CHARACTERS. A surrogate pair is one code point and
 * one glyph; `.slice()` on a code-unit index can cut it in half and put a
 * replacement character on the screen, so `clip` and `hardSlice` advance by
 * CODE POINT and can never split one.
 */

/** One SGR sequence — the only escape LAIN ever emits into drawn content. */
const SGR = /\x1b\[[0-9;]*m/;
const SGR_G = /\x1b\[[0-9;]*m/g;
const SGR_HEAD = /^\x1b\[[0-9;]*m/;
const RESET = '\x1b[0m';

/** The string as the terminal will show it, with all colour removed. */
function strip(s) {
  return String(s == null ? '' : s).replace(SGR_G, '');
}

/**
 * EAST ASIAN WIDE AND FULLWIDTH, as inclusive code-point ranges.
 *
 * A TABLE RATHER THAN A REGEX because JavaScript does not expose the
 * East_Asian_Width property to `\p{...}` — `\p{Script=Han}` is a different
 * question and gets a different (wrong) answer for kana, Hangul and the
 * fullwidth forms. Zero-width IS expressible as a property test, and is done
 * that way below, so this table stays as small as the problem allows.
 *
 * Sorted, so the lookup can binary-search rather than walk.
 */
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

/**
 * ZERO CELLS: a mark that composes onto the character before it, a format
 * character that is never drawn, or a control.
 *
 * `Mn`/`Me` cover combining accents and enclosing marks; `Cf` covers the
 * zero-width joiner and the variation selectors' siblings. Controls are listed
 * explicitly because `Cc` includes tab and newline, which are not zero-width —
 * they are not characters at all, and `detab` deals with the one of them that
 * can reach a painted row.
 */
const ZERO_RE = /[\p{Mn}\p{Me}\p{Cf}]/u;

/** How many terminal cells ONE code point occupies. 0, 1 or 2. */
function cells(cp) {
  if (cp === 0) return 0;
  // C0 and C1 controls draw nothing. A tab reaching here has already been
  // expanded by `detab`; anything else is a control that should not be drawn
  // and must not be paid for.
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

/**
 * How many cells this string occupies. THE measurement, used everywhere.
 *
 * Walks the string ONCE, skipping SGR escapes in place rather than allocating a
 * stripped copy first — this is called on every row of every redraw, and a
 * `.replace()` per row per frame is a cost the frame rate can see.
 */
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

/**
 * Truncate to `w` CELLS, ellipsis included, colour preserved.
 *
 * Escapes are copied through and cost nothing, so a coloured line clips at the
 * same place its plain equivalent would.
 */
function clip(s, w) {
  const t = String(s == null ? '' : s);
  if (w <= 1) return '';
  if (width(t) <= w) return t;
  // ---- THE BUDGET IS CELLS, AND THE ELLIPSIS COSTS ONE OF THEM ------------
  //
  // The old fast path was `t.slice(0, w - 1)`, which is a CODE-UNIT index. On
  // `鉴权服务请求失败` that took `w - 1` characters worth of two-cell glyphs and
  // returned a string roughly twice the width asked for — a clipper that
  // overflows is worse than no clipper, because every caller pads to the width
  // it believes it got. It could also land between the halves of a surrogate
  // pair and put a lone replacement character on the screen.
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
    // A WIDE GLYPH IS TAKEN WHOLE OR NOT AT ALL. Stopping when it would not
    // fit leaves one cell of slack that the ellipsis and `pad` absorb; taking
    // it anyway would put the row one column past the rail, which is the entire
    // failure this module exists to prevent.
    if (used + n > budget) break;
    out += cp > 0xffff ? t.slice(i, i + 2) : t[i];
    used += n;
    i += cp > 0xffff ? 2 : 1;
  }
  // The truncation may have cut before the closing reset. Leaving colour open
  // would bleed it across the rest of the drawn row.
  return out + '…' + (hasAnsi(out) ? RESET : '');
}

/**
 * A TAB IS NOT A CHARACTER, AND IT MUST NEVER REACH A PAINTED REGION.
 *
 * ------------------------------------------------------------------------
 * SEEN ON SCREEN, as black rectangles punched through the diff window's grey
 * surface. `read_file` emits `  1990\t    def implement(…)`, that tab was drawn
 * verbatim, and a terminal handling a tab does not WRITE anything — it moves
 * the cursor to the next tab stop. The cells it skips keep whatever background
 * was already there, which is the terminal's default and not the one this row
 * had opened. So the surface simply is not painted across the gap.
 *
 * IT BREAKS THE ARITHMETIC TOO, which is the half that would have gone on
 * hurting quietly. `width()` counts a tab as ZERO cells — it is a control, and
 * there is no number a per-code-point function could return that is right, since
 * the terminal advances between one and eight columns depending on where the row
 * already was. Every row containing one is measured short, so it is padded too far
 * and its right-hand border lands past the frame — the same tearing this whole
 * module exists to prevent, from an input nobody thought to expand.
 *
 * Expanded HERE rather than at each call site, because "how wide is this
 * string" and "what does the terminal do with it" have to be answered by one
 * function or they disagree.
 */
function detab(s, stop = 8) {
  const t = String(s == null ? '' : s);
  if (!t.includes('\t')) return t;
  let out = '';
  let col = 0;
  let i = 0;
  while (i < t.length) {
    // A WHOLE ESCAPE SEQUENCE OCCUPIES NO COLUMNS — not just its first byte.
    // Skipping only the ESC left `[2m` counted as three visible characters, so
    // a tab after any colour change landed at the wrong stop. Every other
    // function here already measures this way (`strip`); this one has to agree
    // with them or two parts of the same row disagree about where column eight
    // is.
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

/**
 * Shorten a path from the LEFT, keeping the end — the part that identifies the
 * project. `C:\Users\x\Documents\proj\src\a.js` → `…\proj\src\a.js`. Trimming
 * the tail instead would hide the filename, which is the only part that matters.
 */
function shortPath(p, w) {
  const s = String(p || '');
  if (s.length <= w) return s;
  const sep = s.includes('\\') ? '\\' : '/';
  const parts = s.split(sep);
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i > 0; i--) {
    const next = parts[i] + sep + out;
    // The result gets an ellipsis AND a separator in front of it — two
    // characters, not one. Budgeting for one accepted a segment that then
    // pushed the string one over the width, and the clip took it off the END:
    // the filename, which is the only part this function exists to keep.
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

/**
 * A LABELLED FRAME around a block of lines.
 *
 * `┌─ PROJECT HEALTH — scalpbot ─────┐` … `└──────┘`. A report that fills a pane
 * needs an edge, or it reads as text that happens to be on the screen rather
 * than a thing you are looking at. Every row is fitted to the same inner width,
 * so the right-hand border is straight whatever the content did — including
 * content that carries colour.
 */
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

/**
 * TAKE AS MANY CODE POINTS AS FIT IN `w` CELLS. No ellipsis, nothing dropped.
 *
 * `clip` is for a row that must not exceed a column and may say so with a `…`.
 * THIS is for a wrapper, which must place every character somewhere — the
 * remainder goes on the next line. ui/doc.js had its own copy that counted one
 * cell per JS character; two functions answering "how much of this fits" is one
 * too many, and the copy was the one that could split a surrogate pair.
 */
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
