'use strict';

/** ESCAPE SEQUENCES — bytes in, one named thing out. */

/** The sequences that are simply a named key. */
const NAMED = Object.freeze({
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  // CTRL+PAGE DOWN — jump the conversation to the newest output. `;5` is Ctrl
  // (xterm, Windows Terminal, VS Code); rxvt spells it `ESC[6^`, see decodeEscape.
  '\x1b[6;5~': 'ctrl-pagedown',
  '\x1b[Z': 'shift-tab',

  // KEYS THAT WERE BEING SWALLOWED

  // DELETE — forward delete. Backspace worked; this did not.
  '\x1b[3~': 'delete',
  // CTRL+DELETE — forward delete a whole WORD, the mirror of Ctrl+Backspace.
  '\x1b[3;5~': 'ctrl-delete',

  // HOME / END, THE OTHER SPELLINGS.
  '\x1b[1~': 'home',
  '\x1b[4~': 'end',
  '\x1b[7~': 'home',
  '\x1b[8~': 'end',

  // CTRL+HOME / CTRL+END — jump the WHOLE buffer, not just the current line
  // of a multi-line prompt. `;5` is Ctrl, the same modifier word movement uses.
  '\x1b[1;5H': 'ctrl-home',
  '\x1b[1;5F': 'ctrl-end',

  // WORD MOVEMENT. Ctrl+←/→ is how a long line is edited without holding an arrow down. `;5` is Ctrl; `;3` is Alt, which is what macOS terminals send for…
  '\x1b[1;3A': 'alt-up',
  '\x1b[1;3B': 'alt-down',

  '\x1b[1;5D': 'word-left',
  '\x1b[1;5C': 'word-right',
  '\x1b[1;3D': 'word-left',
  '\x1b[1;3C': 'word-right',
  '\x1bb': 'word-left',            // Alt+b — the readline spelling
  '\x1bf': 'word-right',           // Alt+f

  // SELECTION FROM THE KEYBOARD.
  '\x1b[1;2D': 'shift-left',
  '\x1b[1;2C': 'shift-right',
  '\x1b[1;2A': 'shift-up',
  '\x1b[1;2B': 'shift-down',
  '\x1b[1;2H': 'shift-home',
  '\x1b[1;2F': 'shift-end',
  '\x1b[1;6D': 'shift-word-left',  // Ctrl+Shift+←
  '\x1b[1;6C': 'shift-word-right',
});

/** True while the buffer could still become a longer sequence. */
const PARTIAL = /^\x1b(?:\[<?[0-9;]*)?$/;

function decodeEscape(buf) {
  const s = String(buf || '');
  if (s[0] !== '\x1b') return null;

  // A MOUSE REPORT FIRST.
  const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
  if (mouse) {
    return {
      take: mouse[0].length,
      mouse: {
        button: Number(mouse[1]), x: Number(mouse[2]), y: Number(mouse[3]), final: mouse[4],
      },
    };
  }
  // A partial mouse report split across chunks. Waiting is right for the same
  // reason it is right for a split arrow key.
  if (PARTIAL.test(s)) return { wait: true };

  // ALT+BACKSPACE — one of the word-deletes a terminal may send.
  if (/^\x1b\x7f/.test(s)) return { take: 2, action: 'deleteWord' };

  // SHIFT+ENTER AND ALT+ENTER — a new line of prompt, not a submission.
  const soft = /^\x1b(?:\[13;[0-9]+u|[\r\n])/.exec(s);
  if (soft) return { take: soft[0].length, action: 'newline' };

  // ALT+DIGIT — ESC then the digit, which is what a terminal sends.
  const alt = /^\x1b([1-9])/.exec(s);
  if (alt) return { take: 2, key: `alt-${alt[1]}` };

  if (s.startsWith('\x1b[6^')) return { take: 4, key: 'ctrl-pagedown' };   // rxvt's Ctrl+PgDn
  const csi = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(s);
  if (!csi) {
    if (PARTIAL.test(s)) return { wait: true };
    return { take: 1, key: 'escape' };
  }
  const named = NAMED[csi[0]];
  // A recognised CSI sequence with no name is CONSUMED, not typed: rendering
  // `[200~` into the prompt as literal characters is worse than ignoring it.
  return named ? { take: csi[0].length, key: named } : { take: csi[0].length };
}

/** What a decoded SGR report MEANS. */
function mouseEvent({ button, x, y, final }) {
  const moving = (button & 32) !== 0;
  const b = button & ~32;
  const kind = b === 64 ? 'wheel-up'
    : b === 65 ? 'wheel-down'
      : moving ? 'drag'
        : final === 'm' ? 'release' : 'press';
  return { kind, button: b, x, y };
}

module.exports = { decodeEscape, mouseEvent, NAMED, PARTIAL };
