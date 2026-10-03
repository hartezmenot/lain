'use strict';

/** Terminal output. The ONLY module that writes to stdout during a turn. */

// LAIN_FORCE_COLOR=1 turns colour on over a pipe, the same way LAIN_FORCE_TUI runs the real draw path there: it is how the suite asserts on the…
const useColor = () => (Boolean(process.stdout.isTTY) || process.env.LAIN_FORCE_COLOR === '1')
  && !process.env.NO_COLOR && process.env.LAIN_NO_COLOR !== '1';

// A CREDENTIAL MAY EXIST INSIDE LAIN AND MAY NOT BE DRAWN.
const redact = require('./redact');
const PAL = require('./ui/palette');

const MAX_TRANSCRIPT = 400;

/** How many lines of ONE command's output the panel will hold. */
const MAX_SURFACE_LINES = 200;

/** Soft-wrap plain text to a width. */
function wrapPlain(s, width) {
  const words = String(s).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const C = {
  dim: (s) => (useColor() ? `\x1b[2m${s}\x1b[0m` : s),
  /** QUIETER THAN DIM — for work that is FINISHED and has become context. */
  faint: (s) => (useColor() ? `\x1b[${PAL.sgr('faint')}m${s}\x1b[39m` : s),
  /** A SUBTLE BACKGROUND, for a region that should read as a separate surface. */
  // AND IT SURVIVES A FOREGROUND COLOUR INSIDE IT, for the reason spelled out at `onSurface` below: an inner `\x1b[0m` resets the BACKGROUND too, so a…
  onGray: (s) => ground('raised2', s),
  bold: (s) => (useColor() ? `\x1b[1m${s}\x1b[0m` : s),
  // THE LAIN PALETTE (ui/palette.js, 2026-09-23): the named colours keep their names and meanings; their VALUES are the palette's.
  green: (s) => tint('ok', s),
  yellow: (s) => tint('warn', s),
  red: (s) => tint('bad', s),
  cyan: (s) => tint('tool', s),
  blue: (s) => tint('accent', s),
  violet: (s) => tint('violet', s),
  // Reserved for the EXTERNAL model, so "who said this" is answerable at a
  // glance when two models are working on one problem. See ui/paint.js.
  magenta: (s) => tint('external', s),
  /** Any palette token as a foreground / as a row ground. */
  fg: (token, s) => tint(token, s),
  bg: (token, s) => ground(token, s),
  /** CODE BEING WRITTEN RIGHT NOW — the third state a diff line can be in. */
  brightBlue: (s) => tint('violetHi', s),   // "this text is appearing" — violet, the edit emphasis
  /** STRUCK THROUGH — code being taken out, while it is still on screen. */
  strike: (s) => (useColor() ? `\x1b[9m${s}\x1b[29m` : s),
  /** THE DIFF SURFACE — a light ground the editor writes on. */
  onSurface: (s) => (useColor()
    // AND IT SURVIVES A FOREGROUND COLOUR INSIDE IT.
    ? ground('raised', s)
    : s),
};

/** A foreground from the palette, closed with a full reset (as every tint here is). */
function tint(token, s) { return useColor() ? `\x1b[${PAL.sgr(token)}m${s}\x1b[0m` : s; }
/** A ROW GROUND from the palette. */
function ground(token, s) {
  if (!useColor()) return s;
  const open = `\x1b[${PAL.sgr(token, 48)}m`;
  return `${open}${String(s).replace(/\x1b\[0m/g, `\x1b[0m${open}`)}\x1b[49m`;
}

/** ONE output owner, two strategies. */
/** How much of a provider's own error text is worth printing. */
const MAX_PROVIDER_MESSAGE = 200;

function clipMessage(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  // THE SENTENCE A PERSON NEEDS IS INSIDE THE OBJECT, not at the front of it.
  const body = s.indexOf("{");
  if (body > 0) {
    const said = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s.slice(body));
    if (said && said[1]) {
      const head = s.slice(0, body).replace(/[-–—:,]\s*$/, '').trim();
      let one = said[1].replace(/\\n/g, ' ').replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
      // A ROUTER NESTS THE UPSTREAM'S OBJECT inside its own `message` ("[codex/…] [401]: {"error":{"message":"Encountered invalidated oauth token…"}}").
      const inner = one.indexOf('{');
      const deeper = inner > 0 ? /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(one.slice(inner)) : null;
      if (deeper && deeper[1]) one = `${one.slice(0, inner).replace(/[-–—:,]\s*$/, '').trim()}: ${deeper[1].replace(/\\(.)/g, '$1').trim()}`;
      return (head ? head + ' — ' : '') + one;
    }
  }
  return s.length > MAX_PROVIDER_MESSAGE ? s.slice(0, MAX_PROVIDER_MESSAGE) + '…' : s;
}

class Renderer {
  constructor(out = process.stdout) {
    this.out = out;
    this.atLineStart = true;
    this.screen = null;   // set by the App when a TTY UI is active
    /** What commands printed while the TUI owned the screen. */
    this.transcript = [];
    /** ONE COMMAND'S OUTPUT, while it is being collected. */
    this._surfaceLines = [];
    this._surfaceTitle = '';
    this._surfaceOf = null;
    this._surfaceOn = false;
    this._surfaceBusy = false;
  }

  /** Attach the TTY screen. All region drawing then goes through it. */
  attachScreen(screen) { this.screen = screen; return screen; }
  get tui() { return Boolean(this.screen && this.screen.active); }

  /** THE ONE LINEAR DOOR, and therefore the one place a credential is caught. */
  write(s) {
    if (!s) return;
    const safe = redact.text(s);
    if (this.tui) return this.capture(safe);
    this.out.write(safe);
    this.atLineStart = safe.endsWith('\n');
  }

  /** THE TRANSIENT SURFACE */
  openSurface(title, { busy = false } = {}) {
    if (!this.tui || !this.screen.panel) return false;
    // A QUESTION OUTRANKS A NOTICE, ALWAYS.
    if (this.screen.panel.visible && !this.screen.panel.isPassive) return false;
    this._surfaceTitle = String(title || '').trim();
    // SAME SUBJECT, SAME BOX.
    if (!this._surfaceOn || this._surfaceOf !== this._surfaceTitle) this._surfaceLines = [];
    this._surfaceOf = this._surfaceTitle;
    this._surfaceOn = true;
    this._surfaceBusy = Boolean(busy);
    this._paintSurface();
    return true;
  }

  /** Put the collected lines into the panel — the SAME panel `/` and `/model` open. */
  _paintSurface() {
    const { outputAdapter } = require('./ui/adapters');
    const lines = this._surfaceLines.slice();
    if (this._surfaceBusy) lines.push('working…');
    const adapter = outputAdapter({ title: this._surfaceTitle, lines });
    if (this.screen.panel.visible) this.screen.panel.replace(adapter);
    else this.screen.panel.open(adapter);   // nobody awaits this; Esc closes it
    this.screen.draw();
  }

  /** The command finished. */
  doneSurface({ closeAfterMs = 0 } = {}) {
    if (!this._surfaceOn) return;
    this._surfaceOn = false;
    this._surfaceBusy = false;
    // A COMMAND THAT SAID NOTHING LEAVES NOTHING BEHIND.
    const { KIND } = require('./ui/panel');
    const panel = this.screen && this.screen.panel;
    if (!this._surfaceLines.length && panel && panel.visible
        && panel.kind === KIND.OUTPUT) panel.close(null);

    // A RECEIPT CLOSES ITSELF
    if (closeAfterMs > 0 && panel && panel.visible && panel.kind === KIND.OUTPUT) {
      const mine = panel.frame;
      const t = setTimeout(() => {
        if (panel.visible && panel.frame === mine) {
          panel.close(null);
          if (this.screen) this.screen.draw();
        }
      }, closeAfterMs);
      // NEVER HOLDS THE PROCESS OPEN. A pending timer that keeps node alive
      // would make `/exit` hang for the length of a cosmetic animation.
      if (t.unref) t.unref();
    }
    if (this.screen) this.screen.draw();
  }

  /** True while writes are being routed to the panel. */
  get surfaceOpen() { return Boolean(this._surfaceOn); }

  /** Buffer a linear write for the TUI. ANSI is stripped so widths stay true. */
  capture(s) {
    const plain = String(s).replace(/\x1b\[[0-9;]*m/g, '');

    // ROUTED TO THE SURFACE, NOT GLUED INTO CONTEXT
    if (this._surfaceOn && this.screen) {
      for (const line of plain.split('\n')) {
        if (line.trim()) this._surfaceLines.push(line);
      }
      if (this._surfaceLines.length > MAX_SURFACE_LINES) {
        this._surfaceLines.splice(0, this._surfaceLines.length - MAX_SURFACE_LINES);
      }
      this.atLineStart = true;
      this._lineDone = true;
      this._paintSurface();
      return;
    }

    const parts = plain.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && this.transcript.length && !this._lineDone) {
        this.transcript[this.transcript.length - 1] += parts[i];
      } else if (parts[i] !== '' || i < parts.length - 1) {
        this.transcript.push(parts[i]);
      }
    }
    this._lineDone = plain.endsWith('\n');
    if (this.transcript.length > MAX_TRANSCRIPT) {
      this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    }
    this.atLineStart = true;
    if (this.screen) this.screen.draw();
  }

  nl() { if (!this.atLineStart) this.write('\n'); }

  /** Model prose, streamed as it arrives. */
  text(chunk) { if (!this.tui) this.write(chunk); }

  toolStart(name, input) {
    if (this.tui) return;            // ACTIVITY shows the live call instead
    this.nl();
    const arg = summarizeInput(name, input);
    this.write(C.cyan(`  · ${name}`) + (arg ? C.dim(` ${arg}`) : '') + '\n');
  }

  toolResult(name, output, isError) {
    if (this.tui) return;            // ACTIVITY shows the outcome instead
    const text = String(output == null ? '' : output);
    const lines = text.split('\n');
    const shown = lines.slice(0, 8);
    const prefix = isError ? C.red('    ! ') : C.dim('    ');
    for (const l of shown) this.write(prefix + l.slice(0, 200) + '\n');
    if (lines.length > shown.length) {
      this.write(C.dim(`    … ${lines.length - shown.length} more line(s)\n`));
    }
  }

  /** Terminal width for wrapping, honouring COLUMNS the same way the Screen does. */
  get width() {
    return Math.max(20, (this.out.columns || Number(process.env.COLUMNS) || 80) - 2);
  }

  notice(level, message) {
    this.nl();
    const paint = level === 'error' ? C.red : level === 'warn' ? C.yellow : C.dim;
    for (const l of wrapPlain(message, this.width)) this.write(paint(`  ${l}`) + '\n');
  }

  /** A PROVIDER'S OWN WORDS, CLIPPED TO ONE SENTENCE. */
  providerFailure(f) {
    this.nl();
    f = { ...f, message: clipMessage(f && f.message) };
    if (f.skipped) {
      // The breaker held: no socket was opened. Say so, and name the way out —
      // otherwise "nothing happened" is indistinguishable from a hang.
      for (const l of wrapPlain(`${f.connectionId || f.provider} is ${f.kind}: ${f.message}`, this.width)) {
        this.write(C.yellow(`  ${l}`) + '\n');
      }
      for (const l of wrapPlain(`No request was sent. ${f.hint || ''}`, this.width)) {
        this.write(C.dim(`  ${l}`) + '\n');
      }
    } else {
      // WHAT THE PROVIDER DID, by kind. "is not answering" was printed for a
      // credential refusal and a rate limit too — both of which ARE answers.
      const did = {
        AUTH: 'refused the credential', RATE_LIMITED: 'is rate limiting this model',
        QUOTA: 'reports no quota left', MODEL_UNAVAILABLE: 'does not serve this model',
        BAD_REQUEST: 'rejected the request', CONTEXT_LIMIT: 'refused the conversation size',
      }[f.kind] || 'is not answering';
      for (const l of wrapPlain(`Provider ${f.provider} ${did}: ${f.message}`, this.width)) {
        this.write(C.yellow(`  ${l}`) + '\n');
      }
      for (const l of wrapPlain('Your session is intact. Try again, or switch provider. The prompt is yours.', this.width)) {
        this.write(C.dim(`  ${l}`) + '\n');
      }
    }
  }

  /** A thinking phase, folded to one dim line (ui/thoughtrow.js) — the line CLI's version of the TUI row. */
  thought(t) {
    if (this.tui) return;
    this.write(C.dim(`  ${require('./ui/thoughtrow').label(t)}`) + '\n');
  }

  turnSummary(record) {
    if (this.tui) return;            // the header carries these numbers live
    this.nl();
    if (!String(record.text || '').trim() && !record.toolCalls && String(record.reasoning || '').trim() && record.stopReason !== 'aborted') {
      const rows = [];
      require('./ui/thoughtrow').reasoningOnly(rows, record.reasoning);
      for (const r of rows) this.write(C.dim(`  ${r.text}`) + '\n');
    }
    const bits = [];
    if (record.toolCalls) bits.push(`${record.toolCalls} tool call${record.toolCalls === 1 ? '' : 's'}`);
    if (record.mutations.length) bits.push(`${record.mutations.length} file${record.mutations.length === 1 ? '' : 's'} changed`);
    const u = record.usage;
    // THE RECEIPT IN WORDS (ui/activityline.receipt): `in 18.2k · reasoning 7.4k · out 1.1k · cache 12.8k`, only what was stated.
    const receipt = require('./ui/activityline').receipt(u);
    if (receipt) bits.push(receipt);
    if (record.stopReason && record.stopReason !== 'end') bits.push(`stopped: ${record.stopReason}`);
    if (bits.length) this.write(C.dim(`  ${bits.join(' · ')}`) + '\n');
    for (const l of require('./factfooter').lines(record.facts)) this.write(C.dim(`  ${l}`) + '\n');   // the fact footer (S4)
  }
}

function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return String(input.command).replace(/\s+/g, ' ').slice(0, 120);
  if (input.path) {
    const range = input.offset ? `:${input.offset}${input.limit ? `-${input.offset + input.limit - 1}` : ''}` : '';
    return String(input.path) + range;
  }
  const keys = Object.keys(input);
  return keys.length ? `{${keys.slice(0, 3).join(', ')}}` : '';
}

module.exports = { Renderer, C, summarizeInput, clipMessage };
