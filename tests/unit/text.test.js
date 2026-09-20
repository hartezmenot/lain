'use strict';

/**
 * WIDTH MATHS THAT SURVIVES COLOUR.
 *
 * Every drawn region pads its content out to a frame. With `String.length` that
 * arithmetic is a lie the moment a line carries an escape sequence — nine bytes
 * measured as nine cells for one visible character — and the frame tears open on
 * the right. That is the reason the whole workspace was plain text.
 *
 * These are the properties the rest of the UI now depends on.
 */

const assert = require('assert');
const { test } = require('../helpers');

const T = require('../../src/ui/text');

const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;

module.exports = async function () {
  await test('TEXT: width counts what the terminal shows, not what is in memory', () => {
    assert.strictEqual(T.width('abc'), 3);
    assert.strictEqual(T.width(GREEN('abc')), 3);
    assert.strictEqual(GREEN('abc').length, 12, 'the raw string really is longer');
    assert.strictEqual(T.width(''), 0);
    assert.strictEqual(T.width(null), 0);
  });

  await test('TEXT: clip truncates by VISIBLE characters and keeps the colour', () => {
    assert.strictEqual(T.clip('abcdef', 4), 'abc…');
    const clipped = T.clip(GREEN('abcdef'), 4);
    assert.strictEqual(T.width(clipped), 4, 'a coloured string clips where a plain one would');
    assert.match(clipped, /\x1b\[32m/, 'the colour it started with is still applied');
  });

  await test('TEXT: a truncated string never leaves its colour open', () => {
    // Bleeding a colour past the clip point paints the rest of the drawn row —
    // including the frame — in whatever the content happened to be using.
    const clipped = T.clip(GREEN('abcdef'), 4);
    assert.ok(clipped.endsWith('\x1b[0m'), `colour left open: ${JSON.stringify(clipped)}`);
  });

  await test('TEXT: nothing is clipped that already fits', () => {
    assert.strictEqual(T.clip('abc', 10), 'abc');
    assert.strictEqual(T.clip(GREEN('abc'), 10), GREEN('abc'));
  });

  await test('TEXT: pad and fit measure visibly, so a column stays a column', () => {
    assert.strictEqual(T.width(T.pad(GREEN('ab'), 6)), 6);
    assert.strictEqual(T.width(T.fit(GREEN('abcdefghij'), 6)), 6, 'fit clips as well as pads');
    assert.strictEqual(T.width(T.fit('ab', 6)), 6);
  });

  await test('TEXT: a box is exactly square at every width, coloured or not', () => {
    for (const w of [24, 40, 80]) {
      const lines = T.box(GREEN('TITLE'), ['plain', GREEN('coloured'), 'x'.repeat(200)], w);
      for (const l of lines) assert.strictEqual(T.width(l), w, `a box row was ${T.width(l)} wide at ${w}`);
      assert.ok(lines[0].startsWith('┌'));
      assert.ok(lines[lines.length - 1].startsWith('└'));
    }
  });

  await test('TEXT: shortPath keeps the end — the part that identifies the file', () => {
    const p = 'C:\\Users\\x\\Documents\\proj\\src\\a.js';
    const short = T.shortPath(p, 24);
    assert.ok(short.length <= 24);
    assert.ok(short.endsWith('a.js'), `the filename must survive: ${short}`);
  });

  await test('TEXT: projectName is the folder, whatever the separator', () => {
    assert.strictEqual(T.projectName('C:\\Users\\x\\scalpbot'), 'scalpbot');
    assert.strictEqual(T.projectName('/home/x/scalpbot/'), 'scalpbot');
  });

  /** A literal tab, named so the tests below read as prose. */
  const TAB = '\t';

  await test('DETAB: a tab never reaches a painted region', () => {
    // ---- SEEN ON SCREEN, as black rectangles through the diff surface ------
    //
    // `read_file` emits `  1990<TAB>    def implement(...)`. A terminal handling
    // a tab does not WRITE anything — it moves the cursor to the next stop, and
    // the cells it skips keep the DEFAULT background rather than the one the row
    // had opened. So the surface is simply not painted across the gap.
    const raw = '  1990' + TAB + 'def f():';
    assert.ok(!T.detab(raw).includes(TAB), 'no tab survives');
    assert.strictEqual(T.detab(raw), '  1990  def f():');
  });

  await test('DETAB: it fixes the ARITHMETIC too, which is the quiet half', () => {
    // A TAB HAS NO WIDTH OF ITS OWN. The terminal does not WRITE anything for
    // one - it moves the cursor to the next stop, advancing between one and
    // eight columns depending on where the row already was. So there is no
    // number `cells()` could return that is right, and it returns the one that
    // is honest about a control: zero.
    //
    // THE POINT IS THAT IT MUST NEVER REACH A PAINTED ROW UNEXPANDED. A row
    // measured short is padded too far and its right border lands past the
    // frame - the tearing this module exists to prevent, from an input nobody
    // thought to expand.
    const raw = 'a' + TAB + 'b';
    assert.ok(T.width(raw) < 9,
      "an unexpanded tab ALWAYS measures short of what the terminal will do");
    assert.strictEqual(T.width(T.detab(raw)), 9, 'and nine is what the terminal does');
  });

  await test('DETAB: stops are columns, and an escape occupies none', () => {
    assert.strictEqual(T.detab('ab' + TAB + 'c'), 'ab      c', 'to the next multiple of eight');
    assert.strictEqual(T.detab('12345678' + TAB + 'x'), '12345678        x', 'a full stop when already on one');
    // Colour must not push the stop along: it is not on screen.
    const coloured = '\x1b[2mab\x1b[0m' + TAB + 'c';
    assert.strictEqual(T.strip(T.detab(coloured)), 'ab      c');
  });

  await test('DETAB: text with no tab is returned untouched', () => {
    const plain = 'nothing to expand here';
    assert.strictEqual(T.detab(plain), plain);
  });
  // ------------------------------------------------------------ cell width --
  //
  // THE REPORTED FAILURE, and the one these cases exist to keep fixed: a
  // provider answered with a CJK error message, `String.length` measured eight
  // characters where the terminal drew sixteen cells, and every row carrying it
  // was padded eight columns past the right-hand rail. The report blamed the
  // rails; the cause was the ruler.

  await test('WIDTH: a CJK glyph is TWO cells, not one character', () => {
    assert.strictEqual(T.width('鉴权服务请求失败'), 16,
      'eight ideographs occupy sixteen terminal cells');
    assert.strictEqual('鉴权服务请求失败'.length, 8,
      'and String.length really does see eight - that was the bug');
    assert.strictEqual(T.width('ＡＢ'), 4, 'fullwidth ASCII is wide too');
    assert.strictEqual(T.width('한국어'), 6, 'Hangul syllables');
    assert.strictEqual(T.width('あい'), 4, 'kana');
  });

  await test('WIDTH: a combining mark costs nothing, and a surrogate pair costs one glyph', () => {
    assert.strictEqual(T.width('é'), 1, 'e + combining acute is one cell, two JS characters');
    assert.strictEqual('é'.length, 2);
    assert.strictEqual(T.width('❤️'), 1, 'a variation selector adds no cell of its own');
    assert.strictEqual(T.width('\u{1F600}'), 2, 'an emoji is two cells and two code units');
  });

  await test('WIDTH: a box rule, arrow or tick is still ONE cell', () => {
    // East Asian *Ambiguous*. Counting these as two would re-tear every frame
    // in the tree to fix a case nobody reported.
    for (const ch of ['─', '│', '┌', '✔', '↑', '↓', '⚡', '❯', '…']) {
      assert.strictEqual(T.width(ch), 1, `${JSON.stringify(ch)} must stay one cell`);
    }
  });

  await test('WIDTH: a row fitted to a rail occupies EXACTLY that many cells', () => {
    // The end-to-end property every painted region depends on. If this holds,
    // no row can draw past the right-hand rail whatever the provider sent.
    const msg = 'NOT AUTHENTICATED — 401 — {"error":{"message":'
      + '"鉴权服务请求失败: Invalid or expired api_key"}}';
    for (const w of [60, 80, 100, 120, 160]) {
      assert.strictEqual(T.width(T.fit(msg, w)), w, `a ${w}-column rail gets ${w} cells`);
    }
  });

  await test('CLIP: never splits a surrogate pair, never overshoots on wide text', () => {
    // The old fast path was `t.slice(0, w - 1)` - a CODE-UNIT index. On wide
    // text it returned roughly twice the width asked for, and it could land
    // between the halves of a pair and put a replacement character on screen.
    const cjk = '鉴权服务请求失败';
    for (const w of [3, 4, 5, 8, 11]) {
      assert.ok(T.width(T.clip(cjk, w)) <= w, `clip(${w}) must not exceed its budget`);
    }
    const emoji = '\u{1F600}\u{1F601}\u{1F602}';
    const cut = T.clip(emoji, 4);
    assert.ok(!/[\uD800-\uDBFF]$/.test(T.strip(cut).replace(/…$/, '')),
      'a clip must never end on a lone high surrogate');
  });

  await test('HARDSLICE: takes whole glyphs and loses nothing', () => {
    const cjk = '鉴权服务';
    const head = T.hardSlice(cjk, 5);
    assert.strictEqual(T.width(head), 4, 'a two-cell glyph is taken whole or not at all');
    assert.ok(cjk.startsWith(head), 'and it is a genuine prefix - nothing is dropped or rewritten');
  });

  await test('CELLS: the classification is exposed and total', () => {
    assert.strictEqual(T.cells(0x41), 1);
    assert.strictEqual(T.cells(0x4e00), 2);
    assert.strictEqual(T.cells(0x0301), 0);
    assert.strictEqual(T.cells(0x200d), 0, 'the zero-width joiner draws nothing');
    assert.strictEqual(T.cells(0x07), 0, 'a control is not a cell');
  });
};
