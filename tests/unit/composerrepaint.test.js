'use strict';

/**
 * COMPOSER CORRUPTION AFTER PASTE + DELETE — the three causes, pinned.
 *
 * ------------------------------------------------------------------------
 * REPORTED: paste into the composer, delete it (Ctrl+Backspace, as the person
 * actually does), and old pasted rows stay painted around the empty
 * `Ask LAIN…`. Reproduced in a real pseudo-console (tests/tty); every stale
 * cell sat LEFT of the content frame, in the gutter. The causes, each with
 * its owner:
 *
 *   1. LONE `\r` IN THE BUFFER. Windows Terminal separates pasted lines with
 *      `\r`; pastebuffer.js normalised only `\r\n`. The composer wrote the `\r`
 *      verbatim and the terminal returned the cursor to column 1 mid-row.
 *   2. DELETE UNFOLDED THE PASTE. A large paste is drawn as one
 *      `<pasted text>` marker, but Ctrl+Backspace deleted one WORD of it, the
 *      buffer no longer matched the payload, and the whole raw paste (with its
 *      `\r`s) appeared in the composer. It now goes as one unit.
 *   3. WIDTH IN CODE UNITS. CJK counted one column and drew two; the grey fill
 *      overran the right edge and autowrapped into the next row's gutter.
 *
 *   and the property that kept every one of them on screen: rows erased only to
 *   their RIGHT, so nothing repainted the gutter. Each row now owns its line.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { test } = require('../helpers');

const composer = require('../../src/ui/composer');
const frameout = require('../../src/ui/frameout');
const T = require('../../src/ui/text');

const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const bigPaste = (eol) => Array.from({ length: 30 }, (_, i) => `Final acceptance ${i}: ACTION COMPILER PC CONTROL`).join(eol);

function input() {
  const { Input } = require('../../src/input');
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = () => {}; stdin.resume = () => {}; stdin.pause = () => {}; stdin.setEncoding = () => {};
  const r = new Input({ stdin, stdout: { write() {} } });
  r.echo = false;
  r.start();
  return { r, type: (s) => stdin.emit('data', Buffer.from(s, 'utf8')) };
}

function screen({ cols = 100, rows = 26 } = {}) {
  const { Screen } = require('../../src/ui/layout');
  const writes = [];
  const s = new Screen({ out: { columns: cols, rows, isTTY: true, write(x) { writes.push(String(x)); }, on() {}, removeListener() {} } });
  s.active = true;
  s.state = {
    cwd: process.cwd(), session: { cwd: process.cwd(), task: null, turns: [] },
    transcript: [], liveActions: [], liveNarration: [], extras: [], llm: { phase: null },
  };
  s.inputText = '';
  s.inputPastes = [];
  s.inputCursorAt = 0;
  return { s, writes };
}

/** Composer rows as written: one string per positioned row. */
function composerRows(s) {
  if (!s.rowMap) s.rowMap = {};
  return require('../../src/ui/inputbox').draw(s, { row: 20, cols: 90, textRows: 5, col: 4 });
}

module.exports = async function () {
  // ---- 1. THE BUFFER HOLDS LF ONLY -----------------------------------------

  await test('COMPOSER: a bracketed paste with lone CR separators lands as LF lines', () => {
    const { r, type } = input();
    type(`${ESC}[200~${bigPaste(CR)}${ESC}[201~`);
    assert.ok(!r.line.includes(CR), 'no carriage return may survive into the editor buffer');
    assert.strictEqual(r.line.split(NL).length, 30);
  });

  await test('COMPOSER: Ctrl+V as a key (insertText) normalises CRLF the same way', () => {
    const { r } = input();
    r.insertText(`one${CR}${NL}two${CR}three`, { pasted: true });
    assert.strictEqual(r.line, `one${NL}two${NL}three`);
  });

  // ---- 2. A COLLAPSED PASTE IS DELETED AS ONE THING ------------------------

  await test('COMPOSER: Ctrl+Backspace at the end of a collapsed paste removes the whole block — it does not unfold it', () => {
    const { r, type } = input();
    type(`${ESC}[200~${bigPaste(CR)}${ESC}[201~`);
    type('\b');   // Windows Terminal's Ctrl+Backspace
    assert.strictEqual(r.line, '', 'one keystroke, the whole paste');
    r.undo();
    assert.strictEqual(r.line, bigPaste(NL), 'and one undo brings it all back');
  });

  await test('COMPOSER: typed words survive; Ctrl+Backspace takes the paste, then keeps deleting WORDS', () => {
    const { r, type } = input();
    type('please review ');
    type(`${ESC}[200~${bigPaste(NL)}${ESC}[201~`);
    type('\b');
    assert.strictEqual(r.line, 'please review ');
    type('\b');
    assert.strictEqual(r.line, 'please ', 'ordinary word deletion is unchanged');
  });

  await test('COMPOSER: PLAIN Backspace/Delete still edit the payload one character (pasteflow contract); Ctrl+Delete takes the block forward', () => {
    const a = input();
    a.type(`${ESC}[200~${bigPaste(NL)}${ESC}[201~`);
    a.type('\x7f');
    assert.strictEqual(a.r.line, bigPaste(NL).slice(0, -1), 'the character-level key does the character-level thing');
    const b = input();
    b.type(`${ESC}[200~${bigPaste(NL)}${ESC}[201~`);
    b.r.cursor = 0;
    require('../../src/lineedit').editKey(b.r, 'delete');   // what the REPL does with ESC[3~
    assert.strictEqual(b.r.line, bigPaste(NL).slice(1));
    const c = input();
    c.type(`${ESC}[200~${bigPaste(NL)}${ESC}[201~`);
    c.r.cursor = 0;
    require('../../src/lineedit').editKey(c.r, 'ctrl-delete');
    assert.strictEqual(c.r.line, '', 'the word-level key takes the collapsed block as one word');
  });

  await test('COMPOSER: a SMALL paste is ordinary text — Backspace still deletes one character', () => {
    const { r, type } = input();
    type(`${ESC}[200~short url${ESC}[201~`);
    type('\x7f');
    assert.strictEqual(r.line, 'short ur');
  });

  // ---- 3. EVERY ROW OWNS ITS WHOLE LINE; NO CONTROL BYTE IS A CONTROL -----

  await test('COMPOSER: a frame row erases its whole line after positioning — the gutter included', () => {
    const row = frameout.row(`${ESC}[5;4Hhello`);
    assert.strictEqual(row, `${ESC}[5;4H${ESC}[2Khello${ESC}[K`);
    for (const r of composerRows(screen().s)) assert.ok(r.includes(`${ESC}[2K`), 'every composer row too');
  });

  await test('COMPOSER: CR, LF, BS and BEL inside a frame become spaces; ESC sequences survive', () => {
    const out = frameout.sanitize(`${ESC}[1;4Ha${CR}b${NL}c\bd\x07e${ESC}[0m`);
    assert.strictEqual(out, `${ESC}[1;4Ha b c d e${ESC}[0m`);
  });

  await test('COMPOSER: the frame written to the terminal carries no raw CR even when the buffer did', () => {
    const { s, writes } = screen();
    s.inputText = `abc${CR}def`;   // as if some other path got one past the editor
    s.inputCursorAt = s.inputText.length;
    s.draw();
    assert.ok(!writes.join('').includes(CR));
  });

  // ---- WIDTH IS MEASURED IN CELLS ------------------------------------------

  await test('COMPOSER: CJK wraps by cells — no wrapped row is wider than the room', () => {
    const { wrapInput } = require('../../src/ui/viewport');
    const rows = wrapInput('日本語のテキスト'.repeat(20), 40);
    for (const row of rows) assert.ok(T.width(row.text) <= 39, `row is ${T.width(row.text)} cells: ${row.text}`);
  });

  await test('COMPOSER: every composer row paints EXACTLY the frame width, CJK included — the fill cannot overrun and wrap', () => {
    const { s } = screen();
    s.inputText = '混合テキスト 🚀 '.repeat(30);
    s.inputCursorAt = s.inputText.length;
    for (const r of composerRows(s)) {
      const painted = T.width(r.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
      assert.strictEqual(painted, 90, `a composer row painted ${painted} cells in a 90-cell frame`);
    }
  });

  // ---- SHRINK AND PLACEHOLDER ------------------------------------------------

  await test('COMPOSER: paste → delete all shrinks the region back and restores the placeholder', () => {
    const { s } = screen();
    const ib = require('../../src/ui/inputbox');
    s.inputText = bigPaste(NL).replace(/Final/g, 'final');   // a typed-looking body, not collapsed
    s.inputPastes = [];
    s.inputCursorAt = s.inputText.length;
    const tall = ib.shownRows(s);
    s.inputText = '';
    s.inputCursorAt = 0;
    const short = ib.shownRows(s);
    assert.ok(short < tall, `the region must shrink (${tall} -> ${short})`);
    const drawn = composerRows(s).join('');
    assert.match(drawn, /Ask Noema/, 'the empty composer shows its placeholder again');
  });

  await test('COMPOSER: after the region shrinks, the rows it gave up are repainted by the rows that now own them', () => {
    const { s, writes } = screen();
    s.inputText = bigPaste(NL).replace(/Final/g, 'final');
    s.inputCursorAt = s.inputText.length;
    s.draw();
    writes.length = 0;
    s.inputText = '';
    s.inputCursorAt = 0;
    s.draw();
    const frame = writes.join('');
    // Every terminal row is addressed and erased whole in the new frame.
    for (let row = 1; row <= 26; row++) {
      assert.ok(new RegExp(`\\x1b\\[${row};\\d+H\\x1b\\[2K`).test(frame), `row ${row} was not repainted after the composer shrank`);
    }
    assert.ok(!/final acceptance/i.test(frame), 'no pasted text survives in the frame');
  });
};
