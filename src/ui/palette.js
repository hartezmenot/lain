'use strict';

/**
 * THE LAIN PALETTE (2026-09-23) — one place that says what each colour is.
 *
 * Identity is a cool electric BLUE. VIOLET is the secondary emphasis for the
 * model working (thinking, streaming, an edit being made). CYAN is a command or
 * a tool. Green and red stay semantic and restrained. Everything else is dark
 * neutral: most of the screen should carry no hue at all.
 *
 * Colours are 24-bit where the terminal takes them (Windows Terminal, conhost
 * since Windows 10, and anything declaring COLORTERM=truecolor), else the
 * nearest xterm-256 cell. `LAIN_TRUECOLOR=0|1` overrides the guess.
 */

const TOKENS = Object.freeze({
  base: '#090B0D',
  raised: '#0E1113',
  raised2: '#121517',
  border: '#242A2E',
  text: '#D8DDE2',
  muted: '#777F87',
  faint: '#5A6168',
  accent: '#4DA3FF',     // LAIN — identity
  tool: '#67C7F7',       // a command or tool
  violet: '#9B8CFF',     // the model working; an edit
  violetHi: '#B69BFF',
  ok: '#6CCB8F',
  bad: '#F2777A',
  warn: '#E5B567',
  external: '#D78BD6',   // the second model, when one is relaying
  // Diff
  delFg: '#FF7E88', delBg: '#35171D', delHi: '#4A2028',
  addFg: '#72E6A2', addBg: '#103638', addHi: '#12494A',
  ctx: '#BEC5CB', lineNo: '#747D84', separator: '#293035',
});

function truecolor() {
  const o = process.env.LAIN_TRUECOLOR;
  if (o === '1') return true;
  if (o === '0') return false;
  if (/truecolor|24bit/i.test(String(process.env.COLORTERM || ''))) return true;
  if (process.env.WT_SESSION) return true;
  return process.platform === 'win32';
}

function rgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** The nearest xterm-256 cell (6×6×6 cube or the grey ramp). */
function to256([r, g, b]) {
  const cube = [0, 95, 135, 175, 215, 255];
  const near = (v) => cube.reduce((best, c, i) => (Math.abs(c - v) < Math.abs(cube[best] - v) ? i : best), 0);
  const ci = 16 + 36 * near(r) + 6 * near(g) + near(b);
  const cc = [cube[near(r)], cube[near(g)], cube[near(b)]];
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + grey * 10;
  const d = (x) => (x[0] - r) ** 2 + (x[1] - g) ** 2 + (x[2] - b) ** 2;
  return d([gv, gv, gv]) < d(cc) ? 232 + grey : ci;
}

/** SGR parameters for a foreground (`38`) or background (`48`) colour token. */
function sgr(hex, layer = 38) {
  const c = rgb(TOKENS[hex] || hex);
  return truecolor() ? `${layer};2;${c[0]};${c[1]};${c[2]}` : `${layer};5;${to256(c)}`;
}

module.exports = { TOKENS, sgr, rgb, to256, truecolor };
