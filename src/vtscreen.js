'use strict';

/**
 * WHAT A TERMINAL SHOWS, FROM WHAT IT WAS SENT.
 *
 * A pseudoconsole does not print a transcript; it paints a screen. PSReadLine
 * redraws the line being typed with cursor moves, erases and colour, so the
 * raw bytes of `echo abc` after one backspace are "echo abcX", a move back, a
 * repaint, "echo abc". Stripping the escapes from that leaves both copies —
 * which is what the BOT was reading as "the terminal".
 *
 * This replays the bytes onto a grid, the way the window's terminal does, and
 * returns the lines. Deliberately small: printable text, CR / LF / BS / TAB,
 * cursor position (H f), column (G), relative moves (A B C D), erase in line
 * (K) and display (J). Colour and modes are read and ignored. Rows addressed
 * by CUP are relative to the visible screen, which is the last `rows` lines.
 */

const ESC = '\u001b';

function render(input, { cols = 120, rows = 30 } = {}) {
  const W = Math.max(20, Number(cols) || 120);
  const H = Math.max(5, Number(rows) || 30);
  const lines = [[]];
  let row = 0;
  let col = 0;
  const top = () => Math.max(0, lines.length - H);
  const line = () => { while (lines.length <= row) lines.push([]); return lines[row]; };
  const down = () => { row += 1; line(); };
  const put = (ch) => {
    if (col >= W) { col = 0; down(); }
    const l = line();
    while (l.length < col) l.push(' ');
    l[col] = ch;
    col += 1;
  };
  const s = String(input || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ESC) {
      const next = s[i + 1];
      if (next === ']') {                                   // OSC — a title; dropped
        const bel = s.indexOf('\u0007', i);
        const st = s.indexOf(`${ESC}\\`, i);
        const end = bel >= 0 && (st < 0 || bel < st) ? bel : (st >= 0 ? st + 1 : s.length);
        i = end;
        continue;
      }
      if (next === '[') {                                   // CSI
        let j = i + 2;
        while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x3f) j += 1;
        const fin = s[j];
        const args = s.slice(i + 2, j).replace(/[^0-9;]/g, '').split(';').map((n) => parseInt(n, 10));
        const n1 = Number.isFinite(args[0]) && args[0] > 0 ? args[0] : 1;
        if (fin === 'H' || fin === 'f') {
          const r = Number.isFinite(args[0]) && args[0] > 0 ? args[0] : 1;
          const c = Number.isFinite(args[1]) && args[1] > 0 ? args[1] : 1;
          row = top() + r - 1; col = Math.min(W - 1, c - 1); line();
        } else if (fin === 'G') col = Math.min(W - 1, n1 - 1);
        else if (fin === 'A') row = Math.max(top(), row - n1);
        else if (fin === 'B') { row += n1; line(); }
        else if (fin === 'C') col = Math.min(W - 1, col + n1);
        else if (fin === 'D') col = Math.max(0, col - n1);
        else if (fin === 'K') {
          const mode = Number.isFinite(args[0]) ? args[0] : 0;
          const l = line();
          if (mode === 0) l.length = Math.min(l.length, col);
          else if (mode === 1) for (let k = 0; k <= col && k < l.length; k++) l[k] = ' ';
          else l.length = 0;
        } else if (fin === 'J') {
          const mode = Number.isFinite(args[0]) ? args[0] : 0;
          if (mode === 0) { line().length = Math.min(line().length, col); lines.length = row + 1; }
          else if (mode >= 2) { for (let k = top(); k < lines.length; k++) lines[k] = []; }
        }
        i = j;
        continue;
      }
      i += 1;                                                // a two-character escape
      continue;
    }
    if (ch === '\r') { col = 0; continue; }
    if (ch === '\n') { down(); continue; }
    if (ch === '\b') { if (col > 0) col -= 1; continue; }
    if (ch === '\t') { col = Math.min(W - 1, (Math.floor(col / 8) + 1) * 8); continue; }
    if (ch < ' ' || ch === '\u007f') continue;
    put(ch);
  }
  return lines.map((l) => l.join('').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = { render };
