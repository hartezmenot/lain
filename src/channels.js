'use strict';

/** WHICH WAYS OF ACTING AND SEEING ARE STILL OPEN — the refusal ledger. */

/** THE CHANNELS, named for what they GIVE YOU rather than for the syscall. */
const CHANNEL = Object.freeze({
  KEYBOARD: 'KEYBOARD',
  MOUSE: 'MOUSE',
  SCREEN: 'SCREEN',
  OCR: 'OCR',
  WINDOWS: 'WINDOWS',
});

const FALLBACK = Object.freeze({
  KEYBOARD: 'ask the user to press the keys themselves, then confirm what happened',
  MOUSE: 'ask the user to click it themselves, then confirm what happened',
  SCREEN: 'use logs, files and the target\'s own output, or ask the user what is on screen',
  OCR: 'use logs and files, or ask the user to read the text out',
  WINDOWS: 'ask the user which window is in front',
});

/** What each `computer` operation needs. One place, so a rename cannot drift. */
const OP_CHANNEL = Object.freeze({
  windows: CHANNEL.WINDOWS,
  focus: CHANNEL.WINDOWS,
  screenshot: CHANNEL.SCREEN,
  ocr: CHANNEL.OCR,
  move: CHANNEL.MOUSE,
  click: CHANNEL.MOUSE,
  type: CHANNEL.KEYBOARD,
  key: CHANNEL.KEYBOARD,
  hold: CHANNEL.KEYBOARD,
});

/** The state of one channel. */
const STATE = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  OPEN: 'OPEN',
  DENIED: 'DENIED',
  UNAVAILABLE: 'UNAVAILABLE',
});

class Channels {
  constructor() {
    /** channel -> { state, why, at, asked } */
    this.byName = new Map();
  }

  _entry(name) {
    return this.byName.get(name) || { state: STATE.UNKNOWN, why: '', at: 0, asked: 0 };
  }

  /** What a channel is, right now. Never throws, never guesses. */
  state(name) { return this._entry(name).state; }

  /** The whole record, for the surfaces that explain themselves. */
  get(name) { return { channel: name, ...this._entry(name), fallback: FALLBACK[name] || '' }; }

  /** The user said no. Final until they say otherwise. */
  deny(name, why = 'the user did not allow it') {
    if (!CHANNEL[name]) return this;
    const prev = this._entry(name);
    this.byName.set(name, { state: STATE.DENIED, why: String(why), at: Date.now(), asked: prev.asked + 1 });
    return this;
  }

  /** Nothing can carry it — no transport, no bridge, the feature is absent. */
  unavailable(name, why = 'nothing can carry it') {
    if (!CHANNEL[name]) return this;
    const prev = this._entry(name);
    this.byName.set(name, { state: STATE.UNAVAILABLE, why: String(why), at: Date.now(), asked: prev.asked });
    return this;
  }

  /** It worked. Recorded on success only — see STATE.UNKNOWN. */
  open(name) {
    if (!CHANNEL[name]) return this;
    const prev = this._entry(name);
    this.byName.set(name, { state: STATE.OPEN, why: '', at: Date.now(), asked: prev.asked });
    return this;
  }

  /** The user changed their mind. */
  reopen(name) {
    if (this.byName.has(name)) this.byName.delete(name);
    return this;
  }

  /** May this operation be attempted at all? */
  check(op) {
    const channel = OP_CHANNEL[op] || null;
    if (!channel) return { ok: true, channel: null, state: STATE.UNKNOWN, why: '', fallback: '' };
    const e = this._entry(channel);
    if (e.state === STATE.DENIED || e.state === STATE.UNAVAILABLE) {
      return { ok: false, channel, state: e.state, why: e.why, fallback: FALLBACK[channel] || '' };
    }
    return { ok: true, channel, state: e.state, why: '', fallback: '' };
  }

  /** Every channel that is shut, for the context block and the report. */
  closed() {
    const out = [];
    for (const [name, e] of this.byName) {
      if (e.state === STATE.DENIED || e.state === STATE.UNAVAILABLE) out.push(this.get(name));
    }
    return out;
  }

  /** What the model is told about the closed channels — facts and a way forward. */
  brief() {
    const shut = this.closed();
    if (!shut.length) return '';
    const lines = shut.map((c) => `${c.channel} UNAVAILABLE — ${c.why}. Instead: ${c.fallback}.`);
    return `These channels are closed for this session and asking again will not reopen them:\n${lines.join('\n')}`;
  }
}

module.exports = { Channels, CHANNEL, STATE, FALLBACK, OP_CHANNEL };
