'use strict';

/** `/help` — WHAT LAIN CAN BE TOLD TO DO, AND WHICH KEYS DO IT. */

/** Keys, and what they do. */
const NL = String.fromCharCode(10);

const KEYS = [
  ['Shift+Enter, Alt+Enter', 'new line in the prompt — if your terminal reports it'],
  ['Ctrl+J', 'new line in the prompt — works in every terminal'],
  ['Enter', 'send the prompt'],
  ['↑ ↓', 'move within a multi-line prompt, then through history'],
  ['PgUp/PgDn, Home/End', 'scroll the conversation'],
  ['Ctrl+PgDn', 'jump straight to the newest output, and keep following it'],
  ['Alt+↑ Alt+↓', 'jump to the previous or next thing YOU said'],
  ['Esc', 'close a panel, or stop a retry wait'],
  ['drag in the prompt', 'select text — Shift+drag keeps the terminal own selection'],
  ['/mouse', 'if Shift+drag does not work in your terminal, turn capture off'],
  ['Ctrl+C', 'copy the selection; with nothing selected, stop the turn'],
  ['Ctrl+X, Ctrl+V', 'cut the selection, paste the clipboard'],
  ['Ctrl+C twice', 'leave'],
];

/** WHICH COMMANDS COME FIRST, AND WHY THERE ARE GROUPS AT ALL. */
const GROUPS = [
  ['Working', [
    '/bg', '/ps', '/steer', '/plan', '/task', '/verify', '/cancel', '/answer', '/jobs',
  ]],
  ['Looking', [
    '/brief', '/changes', '/undo', '/note', '/tasks', '/artifacts', '/env', '/health', '/lain',
  ]],
  ['This session', [
    '/model', '/effort', '/provider', '/new', '/clear', '/compact', '/resume', '/sessions',
    '/token', '/status', '/help', '/exit',
  ]],
];

/** The group a command belongs to, or '' for the advanced tail. */
function groupOf(name) {
  for (const [label, names] of GROUPS) if (names.includes(name)) return label;
  return '';
}

function register({ define, REGISTRY, C, FLASH_MS }) {

  /** `/mouse` — GIVE THE TERMINAL ITS SELECTION BACK. */
  define('/mouse', {
    flashMs: FLASH_MS,   // a receipt, not an inspector - see FLASH_MS
    surface: true,
    args: '[on|off]',
    desc: 'Mouse capture on or off - off restores your terminal own text selection',
    run(app, ctx) {
      const w = (s) => app.render.write(s + NL);
      const input = app.input;
      if (!input || typeof input.enableMouse !== 'function') {
        w('');
        w(C.dim('  There is no terminal here to capture.'));
        w('');
        return;
      }
      const want = String((ctx.args && ctx.args[0]) || '').toLowerCase();
      const on = want === 'on' ? true : (want === 'off' ? false : !input.mouseCaptured());
      if (on) input.enableMouse(); else input.disableMouse();
      // AND IT STICKS
      try {
        const config = require('./config');
        const cfg = config.load();
        if (cfg.mouse !== on) { cfg.mouse = on; config.save(cfg); }
      } catch { /* an unwritable config still leaves the change live this session */ }
      w('');
      w(C.bold('  Mouse capture ') + (on ? C.green('ON') : C.yellow('OFF')));
      w('');
      if (on) {
        w(C.dim('  The prompt has a clickable caret, the conversation can be selected and clicked,'));
        w(C.dim('  and the WHEEL scrolls the transcript.'));
        w(C.dim('  Your terminal own drag-selection is taken; Shift+drag usually still works.'));
        w(C.dim('  If it does not in your terminal, run /mouse off.'));
      } else {
        w(C.dim('  Your terminal own selection and copy work exactly as they always do.'));
        // THE TRADE, STATED RATHER THAN DISCOVERED
        w(C.dim('  The wheel and the clickable caret are off; PgUp/PgDn scroll the transcript,'));
        w(C.dim('  and Alt+↑/Alt+↓ jump between your own messages. /mouse on for the wheel.'));
        w(C.dim('  /copy still works, and copies what LAIN knows rather than the screen.'));
      }
      w('');
    },
  });

  define('/help', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    desc: 'Show commands',
    run(app) {
      const w = (s) => app.render.write(s);
      /** One command as `  /name <args>    what it does`, wrapping if it must. */
      const row = (c) => {
        // A long argument list must not eat the gap before the description.
        const left = c.name + (c.args ? ' ' + c.args : '');
        if (left.length > 21) w('  ' + left + NL + ' '.repeat(24) + C.dim(c.desc) + NL);
        else w('  ' + left.padEnd(22) + C.dim(c.desc) + NL);
      };

      // ONE SURFACE, SO THE COMMANDS ARE THE MAP
      w(NL + C.bold('Commands') + C.dim('  — type anything to work; these reach the rest') + NL);
      const listed = new Set();
      for (const [label, names] of GROUPS) {
        const found = names.map((n) => REGISTRY.get(n)).filter(Boolean);
        if (!found.length) continue;
        w(NL + C.bold('  ' + label) + NL);
        // IN THE ORDER THE GROUP NAMES THEM, not the registry's.
        for (const c of found) { row(c); listed.add(c.name); }
      }
      // EVERYTHING ELSE, MARKED AS WHAT IT IS
      const rest = [...REGISTRY.values()].filter((c) => !listed.has(c.name) && !c.hidden);
      if (rest.length) {
        w(NL + C.bold('  Advanced') + C.dim('  — diagnostics and machinery') + NL);
        for (const c of rest) row(c);
      }

      // THE KEYS, not only the commands.
      w(NL + C.bold('  Keys') + NL);
      // The same two-column rule the command list above uses, for the same reason: a name exactly as wide as the column ran straight into its description…
      for (const [keys, what] of KEYS) {
        if (keys.length > 21) w('  ' + keys + NL + ' '.repeat(24) + C.dim(what) + NL);
        else w('  ' + keys.padEnd(22) + C.dim(what) + NL);
      }
      w(NL + C.dim('  Anything else is sent to the model. Multi-line input is never a command.') + NL);
      w(C.dim('  You never have to choose a workflow — describe the problem and LAIN routes it.') + NL);
    },
  });
}

module.exports = { register, KEYS, GROUPS, groupOf };
