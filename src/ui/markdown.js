'use strict';

/** WHAT THE MODEL WROTE, RENDERED — instead of its markup shown raw. */

const T = require('./text');
const { P } = require('./paint');
const { wrap } = require('./doc');

/** Code is indented under a quiet gutter, so a block is findable at a glance. */
const CODE_GUTTER = '▏';

/** FOLD A PREFORMATTED LINE AT A CHARACTER BOUNDARY — losslessly, and in place. */
function foldPre(line, room) {
  const s = String(line == null ? '' : line).replace(/	/g, '  ');
  const w = Math.max(4, Math.floor(room));
  if (T.width(s) <= w) return [s];
  const indent = ((/^ */.exec(s) || [''])[0]).slice(0, 8);
  const out = [];
  let i = 0;
  let first = true;
  while (i < s.length) {
    const lead = first ? '' : indent;
    const room2 = Math.max(1, w - T.width(lead));
    let used = 0;
    let j = i;
    while (j < s.length) {
      const cw = T.width(s[j]) || 1;
      if (used + cw > room2) break;
      used += cw;
      j += 1;
    }
    if (j === i) j = i + 1;            // never fail to advance
    out.push(lead + s.slice(i, j));
    i = j;
    first = false;
  }
  return out;
}
/** Any fence line, opening or closing — used when unwrapping a how-to block. */
const FENCE_ANY = /^\s*(?:```|~~~)/;
const BULLET = '•';
/** A newline, as a value — this file avoids a bare escape in a joiner. */
const NL = String.fromCharCode(10);

/** THE TWO LINES OF A SUMMARY SOMEBODY IS ACTUALLY LOOKING FOR. */
const HOWTO = /^\s*(how\s+to\s+(?:run|test)|to\s+run|to\s+test)\s*[:—–-]\s*(\S.*)?$/i;

/** The line with its list marker and bold markers taken off, for matching only. */
function unmarked(line) {
  return String(line).replace(/^\s*[-*+•]\s+/, '').replace(/\*\*/g, '').replace(/`/g, '');
}

/** HOW WIDE A HOW-TO FRAME MAY GET, and why there is a ceiling at all. */
/** Never narrower than this, however narrow the pane. */
const HOWTO_MIN = 24;
/** A wrapped continuation is indented, so a command that needed two rows reads as one command rather than as two. */
const CONT = '  ';

/** THE SOURCE LINES OF A HOW-TO BLOCK, with its structure intact. */
function howtoLines(command) {
  const raw = String(command == null ? '' : command).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of raw) {
    if (FENCE_ANY.test(line)) continue;
    out.push(String(line).replace(/\s+$/, ''));
  }
  // Blank rows at either end are the seam of the block, not part of it.
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.length ? out : [''];
}

/** `HOW TO RUN` / `HOW TO TEST`, as a LABELLED FRAME THAT NEVER LOSES A CHARACTER. */
function howtoBox(label, command, cols) {
  const title = String(label).replace(/\s+/g, ' ').toUpperCase();
  const source = howtoLines(command);
  const longest = source.reduce((n, l) => Math.max(n, T.width(l)), 0);
  // WIDE ENOUGH FOR THE CONTENT, NEVER WIDER THAN THE PANE.
  const want = Math.max(T.width(title) + 6, longest + 4 + CONT.length);
  const w = Math.max(HOWTO_MIN, Math.min(cols, want));
  const inner = w - 4;

  const body = [];
  for (const line of source) {
    const lead = (/^[ \t]*/.exec(line) || [''])[0].replace(/\t/g, '  ').slice(0, 8);
    const text = line.slice((/^[ \t]*/.exec(line) || [''])[0].length);
    if (!text) { body.push(''); continue; }
    // ROOM RESERVED FOR THE CONTINUATION INDENT ON EVERY PART, including the first.
    const room = Math.max(8, inner - lead.length - CONT.length);
    const parts = wrap(text, room);
    body.push(lead + parts[0]);
    for (const p of parts.slice(1)) body.push(lead + CONT + p);
  }

  const rows = T.box(title, body, w);
  return [
    '',
    P.meta(rows[0]),
    // The command itself keeps full weight inside quiet rules — it is the one
    // thing in a summary somebody is scanning for.
    ...body.map((b) => P.meta('│ ') + P.cmd(T.fit(b, inner)) + P.meta(' │')),
    P.meta(rows[rows.length - 1]),
    '',
  ];
}

/** THE LINES A BARE `How to run:` LABEL OWNS, and where the block ends. */
function howtoBlock(src, at) {
  let j = at + 1;
  while (j < src.length && !String(src[j] == null ? '' : src[j]).trim()) j++;
  if (j >= src.length) return { lines: [], next: at + 1 };

  const first = String(src[j]);
  if (FENCE_ANY.test(first)) {
    const body = [];
    let k = j + 1;
    for (; k < src.length; k++) {
      const l = String(src[k] == null ? '' : src[k]);
      if (FENCE_ANY.test(l)) { k++; break; }
      body.push(l);
    }
    return { lines: body, next: k };
  }

  if (/^\s{2,}\S/.test(first)) {
    const body = [];
    let k = j;
    for (; k < src.length; k++) {
      const l = String(src[k] == null ? '' : src[k]);
      if (!/^\s{2,}\S/.test(l)) break;
      // The block's own indentation is relative to itself: two spaces in front
      // of every line is the marker that made it a block, not part of it.
      body.push(l.replace(/^\s{2}/, ''));
    }
    return { lines: body, next: k };
  }

  return { lines: [], next: at + 1 };
}

/** THE CLOSING REPORT'S OWN SECTION LABELS, drawn as labels. */
const { SCHEMA_HEADING } = require('./classify');

/** ```lang … ``` — the fence, with an optional language after it. */
const FENCE = /^\s*(?:```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/;

// Per-line preformatting (D1) and pipe tables (D2) live in ui/mdtable.js.
const { preformatted, cells, TABLE_SEP, table } = require('./mdtable');
const HEADING = /^\s*(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.+)$/;
const NUMBERED = /^(\s*)(\d{1,3})[.)]\s+(.+)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** ` ` — A SEPARATOR LINE, AND THE STRUCTURE AROUND IT. */
const BANNER = /^\s*={3,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** INLINE MARKUP, applied to one line of prose. */
function inline(text) {
  const s = String(text == null ? '' : text);
  let out = '';
  let i = 0;
  while (i < s.length) {
    // Code first, so `**kwargs` INSIDE a span keeps its asterisks.
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) { out += P.cmd(s.slice(i + 1, end)); i = end + 1; continue; }
    }
    if (s[i] === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) { out += P.key(s.slice(i + 2, end)); i = end + 2; continue; }
    }
    if (s[i] === '*' && s[i + 1] !== '*') {
      const end = s.indexOf('*', i + 1);
      const body = end > i + 1 ? s.slice(i + 1, end) : '';
      // Emphasis wraps something, and does not straddle spaces — `2 * 3 * 4`
      // is arithmetic and must survive exactly as written.
      if (body && !/^\s/.test(body) && !/\s$/.test(body)) {
        out += P.key(body);
        i = end + 1;
        continue;
      }
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/** Render model prose into painted rows. */
/** HOW WIDE PROSE MAY BE HERE - narrower than the frame on a very wide terminal. */
function render(lines, width) {
  const cols = Math.max(20, Number(width) || 80);
  const measure = require('./views').proseWidth(cols);
  const out = [];
  let inCode = false;

  const push = (row) => {
    // Never two blank rows running: a model that separates every line with a
    // blank one would otherwise double-space the whole answer.
    const blank = !String(row).trim();
    if (blank && !out.length) return;
    if (blank && !String(out[out.length - 1] || '').trim()) return;
    out.push(row);
  };

  // INDEXED, because a `How to run:` label can own the BLOCK written under it and the branch that draws it has to be able to consume those rows.
  const src = Array.from(lines || []);
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const line = String(raw == null ? '' : raw);

    // ---- FENCED CODE ----------------------------------------------------
    const fence = FENCE.exec(line);
    if (fence) {
      if (!inCode) {
        inCode = true;
        push('');
        if (fence[1]) push(`  ${P.meta(CODE_GUTTER)} ${P.meta(fence[1])}`);
      } else {
        inCode = false;
        push('');
      }
      continue;                              // the fence itself is never drawn
    }
    if (inCode) {
      // CODE IS NOT REFLOWED.
      const room = Math.max(12, cols - 4);
      for (const p of foldPre(line, room)) push(`  ${P.meta(CODE_GUTTER)} ${P.cmd(p)}`);
      continue;
    }

    // A markdown table (D2), then any preformatted line (D1: drawn verbatim, every space kept, folded never reflowed).
    if (cells(line) && TABLE_SEP.test(String(src[i + 1] || ''))) {
      const rows = [cells(line)];
      let j = i + 2;
      while (j < src.length && cells(src[j])) { rows.push(cells(src[j])); j += 1; }
      for (const row of table(rows, cols)) push(row);
      i = j - 1;
      continue;
    }
    if (preformatted(line)) {
      for (const p of foldPre(line, Math.max(12, cols))) push(p);
      continue;
    }

    if (!line.trim()) { push(''); continue; }

    // HOW TO RUN / HOW TO TEST, as a callout
    const how = HOWTO.exec(unmarked(line));
    if (how) {
      // THE COMMAND MAY BE ON THIS LINE, OR IN A BLOCK UNDER IT
      const block = howtoBlock(src, i);
      const body = how[2] ? [how[2], ...block.lines] : block.lines;
      if (body.length) {
        for (const row of howtoBox(how[1], body.join(NL), cols)) push(row);
        i = block.next - 1;
        continue;
      }
      // A LABEL WITH NOTHING UNDER IT is not a callout — it is a heading the
      // model left empty, and the schema rule below draws it as one.
    }

    // THE SUMMARY SCHEMA, AS SECTION LABELS
    const sec = SCHEMA_HEADING.exec(line);
    if (sec) {
      push('');
      // ITS OWN CASE, NOT SHOUTED
      push(P.head(String(sec[1])));
      continue;
    }

    // SECTIONS AND `=` UNDERLINES. After the fence, so `=` inside a code
    // block stays code. See BANNER for why this is narrow.
    if (BANNER.test(line)) {
      const title = String(src[i + 1] == null ? '' : src[i + 1]).trim();
      const closing = String(src[i + 2] == null ? '' : src[i + 2]);
      if (title && !BANNER.test(title) && BANNER.test(closing)) {
        push('');
        for (const p of wrap(inline(title), measure)) push(P.head(p));
        push(P.meta('─'.repeat(Math.min(cols, 48))));
        i += 2;                               // the title and the closing bar
        continue;
      }
      // A lone separator is a DIVIDER, drawn in LAIN's own rule so a wall of
      // `=` is not the loudest thing on the screen.
      push(P.meta('─'.repeat(Math.min(cols, 48))));
      continue;
    }
    // `TITLE` on one line, `=====` under it — setext H1.
    if (line.trim() && BANNER.test(String(src[i + 1] == null ? '' : src[i + 1]))) {
      push('');
      for (const p of wrap(inline(line.trim()), measure)) push(P.head(p));
      push(P.meta('─'.repeat(Math.min(cols, 48))));
      i += 1;
      continue;
    }

    // ---- HEADINGS -------------------------------------------------------
    const h = HEADING.exec(line);
    if (h) {
      push('');
      const paint = h[1].length <= 2 ? P.head : P.key;
      for (const p of wrap(inline(h[2]), measure)) push(paint(p));
      continue;
    }

    if (RULE.test(line)) { push(P.meta('─'.repeat(Math.min(cols, 48)))); continue; }

    // ---- QUOTES ---------------------------------------------------------
    const q = QUOTE.exec(line);
    if (q) {
      for (const p of wrap(inline(q[1]), Math.max(12, measure - 2))) push(`${P.meta('│')} ${p}`);
      continue;
    }

    // ---- LISTS, with a hanging indent so wrapped text lines up ----------
    const b = BULLET_RE.exec(line);
    if (b) {
      const lead = `${b[1]}${BULLET} `;
      const parts = wrap(inline(b[2]), Math.max(12, measure - T.width(lead)));
      push(`${P.meta(b[1] + BULLET)} ${parts[0]}`);
      for (const p of parts.slice(1)) push(' '.repeat(T.width(lead)) + p);
      continue;
    }
    const n = NUMBERED.exec(line);
    if (n) {
      const lead = `${n[1]}${n[2]}. `;
      const parts = wrap(inline(n[3]), Math.max(12, measure - T.width(lead)));
      push(P.meta(lead) + parts[0]);
      for (const p of parts.slice(1)) push(' '.repeat(T.width(lead)) + p);
      continue;
    }

    // ORDINARY PROSE
    const leading = (/^[ \t]*/.exec(line) || [''])[0];
    const indent = leading.replace(/\t/g, '  ').slice(0, 12);
    for (const p of wrap(inline(line.slice(leading.length)), Math.max(12, measure - indent.length))) {
      push(indent + p);
    }
  }

  while (out.length && !String(out[out.length - 1]).trim()) out.pop();
  return out;
}

/** Does this text carry markup worth rendering? */
function looksMarked(text) {
  const s = String(text == null ? '' : text);
  // A SEPARATOR IS STRUCTURE.
  return /(?:^|\n)[ \t]*={3,}[ \t]*(?:\n|$)/.test(s)
    || /(?:^|\n)\s*(?:```|~~~|#{1,6}\s|[-*+]\s|\d{1,3}[.)]\s|>\s)/.test(s)
    || /`[^`\n]+`/.test(s)
    || /\*\*[^*\n]+\*\*/.test(s)
    // A BARE SCHEMA HEADING IS STRUCTURE TOO, and by exactly the argument above: `Issue` / `Fix` / `Changed` on their own lines carry no markup at all, so…
    || s.split('\n').some((line) => HOWTO.test(unmarked(line)))
    || s.split('\n').filter((line) => SCHEMA_HEADING.test(line)).length >= 2;
}

module.exports = { render, inline, looksMarked, foldPre, preformatted, CODE_GUTTER, BULLET, HOWTO };
