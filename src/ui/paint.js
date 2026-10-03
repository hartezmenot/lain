'use strict';

/** THE SEMANTIC PALETTE — colour that means something. */

const { C } = require('../render');

const P = {
  ok: (s) => C.green(s),
  warn: (s) => C.yellow(s),
  bad: (s) => C.red(s),
  // LAIN'S OWN VOICE AND STATUS: the identity blue (ui/palette.js, 2026-09-23).
  info: (s) => C.blue(s),
  accent: (s) => C.blue(s),
  /** The model working — thinking, streaming, an edit arriving. */
  violet: (s) => C.violet(s),
  /** Diff roles (ui/panes.js diffRow): foreground on its own row ground. */
  diffAdd: (s) => C.bg('addBg', C.fg('addFg', s)),
  diffDel: (s) => C.bg('delBg', C.fg('delFg', s)),
  diffCtx: (s) => C.bg('raised', C.fg('ctx', s)),
  diffGap: (s) => C.bg('raised', C.fg('separator', s)),
  lineNo: (s) => C.fg('lineNo', s),
  separator: (s) => C.fg('separator', s),
  // CYAN, as the table above has always said.
  path: (s) => C.cyan(s),
  cmd: (s) => C.cyan(s),
  head: (s) => C.bold(C.blue(s)),
  key: (s) => C.bold(s),
  meta: (s) => C.dim(s),
  /** WORK THAT IS DONE AND HAS BECOME CONTEXT — one step quieter than `meta`. */
  faint: (s) => C.faint(s),
  /** A distinct reading surface — currently the diff, which is its own thing. */
  surface: (s) => C.onGray(s),
  /** THE DIFF EDITOR'S GROUND — lighter than `surface`, and that is the point. */
  editor: (s) => C.onSurface(s),
  /** CODE THAT IS APPEARING RIGHT NOW. */
  writing: (s) => C.brightBlue(s),
  /** Code on its way out, while it is still on screen. Composes with `bad`. */
  struck: (s) => C.strike(s),
  plain: (s) => String(s),
  /** THE SECOND MODEL, in its own colour. */
  external: (s) => C.magenta(s),
};

/** WHO IS ACTING. Five actors, five fixed colours, one place. */
const ACTOR = Object.freeze({
  LAIN: { id: 'LAIN', short: 'LAIN', paint: 'info' },
  EXTERNAL: { id: 'EXTERNAL', short: 'EXT', paint: 'external' },
  TOOL: { id: 'TOOL', short: 'TOOL', paint: 'ok' },
  MCP: { id: 'MCP', short: 'MCP', paint: 'warn' },
  USER: { id: 'USER', short: 'YOU', paint: 'key' },
  // THE NETWORK IS AN ACTOR, and separating it is the point of: a gateway timeout is not LAIN failing, not the model refusing and not a tool going wrong.
  NET: { id: 'NET', short: 'NET', paint: 'warn' },
});

function paintActor(actor, text) {
  const a = ACTOR[actor] || ACTOR.LAIN;
  const fn = P[a.paint];
  return fn ? fn(text) : String(text);
}

/** Paint by STATE NAME, for the tables whose rows already carry one. */
const BY_COLOUR = { green: P.ok, yellow: P.warn, red: P.bad, cyan: P.info, dim: P.meta };

function byColour(name, s) {
  const fn = BY_COLOUR[name];
  return fn ? fn(s) : String(s);
}

module.exports = { P, byColour, ACTOR, paintActor };
