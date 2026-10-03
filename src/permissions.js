'use strict';

/** THE DESKTOP PERMISSION GATE. */

/** What can be asked for. Nothing outside this list is grantable. */
// The named-fact channel. A permission request is one of the few things a
// person needs to learn about from a room away — see `emit` below.
const { EVENT } = require('./events');

const CAPABILITY = Object.freeze({
  screen: 'see the screen',
  keyboard: 'send keystrokes',
  mouse: 'move and click the mouse',
  window: 'list and focus windows',
  clipboard: 'read and write the clipboard',
});

/** How long a grant lives. Deliberately short. */
const ONCE_MS = 60_000;
const SESSION_MS = 10 * 60_000;
const MAX_LOG = 200;

/** THE SCOPES. `once` and `session` are WALL-CLOCK grants: they expire after a fixed number of minutes whatever is happening. That is exactly right for… */
const SCOPE = Object.freeze({
  ONCE: 'once',
  SESSION: 'session',
  /** Computer MCP, authorized once for the LAIN session. See `grant`. */
  COMPUTER: 'computer',
});

class Permissions {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    /** cap -> { expiresAt, target, scope, session } */
    this.grants = new Map();
    this.log = [];
    /** Set while a request is on screen, so two cannot race. */
    this.pending = null;
  }

  _note(event, detail) {
    this.log.push({ at: this._now(), event, detail: String(detail || '') });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  /** Is this capability allowed RIGHT NOW? */
  check(cap) {
    const g = this.grants.get(cap);
    if (!g) return { ok: false, why: 'not granted' };
    if (g.expiresAt <= this._now()) {
      this.grants.delete(cap);
      this._note('expired', cap);
      return { ok: false, why: 'the grant expired' };
    }
    return { ok: true, grant: g, msLeft: g.expiresAt - this._now() };
  }

  /** Everything currently granted, for the status views. */
  state() {
    const out = {};
    for (const cap of Object.keys(CAPABILITY)) {
      const c = this.check(cap);
      out[cap] = c.ok
        ? { granted: true, msLeft: c.msLeft, target: c.grant.target || null, scope: c.grant.scope }
        : { granted: false, why: c.why };
    }
    const active = Object.values(out).some((v) => v.granted);
    return { active, capabilities: out, target: this.target(), log: this.log.slice(-20) };
  }

  /** The window a live grant is pointed at, if any. */
  target() {
    for (const g of this.grants.values()) {
      if (g.expiresAt > this._now() && g.target) return g.target;
    }
    return null;
  }

  /** Apply an answered request. */
  grant(caps, { scope = SCOPE.ONCE, target = null } = {}) {
    // COMPUTER: the Computer MCP session authorization (src/computermcp.js).
    const ms = scope === SCOPE.COMPUTER ? Infinity : scope === SCOPE.SESSION ? SESSION_MS : ONCE_MS;
    const expiresAt = this._now() + ms;
    const given = [];
    for (const cap of caps) {
      if (!CAPABILITY[cap]) continue;
      this.grants.set(cap, { expiresAt, target, scope });
      given.push(cap);
    }
    this._note('granted', `${given.join(', ')} · ${scope}${target ? ` · ${target}` : ''}`);
    return given;
  }

  deny(caps, why = 'you said no') {
    this._note('denied', `${[...caps].join(', ')} — ${why}`);
    return { ok: false, why };
  }

  /** Immediate and total. Cannot fail, and is the STOP button's whole job. */
  revoke(why = 'revoked') {
    const had = [...this.grants.keys()];
    this.grants.clear();
    if (had.length) this._note('revoked', `${had.join(', ')} — ${why}`);
    return had;
  }

  /** Record that a granted capability was actually used. */
  used(cap, detail) {
    this._note('used', `${cap}${detail ? ` · ${detail}` : ''}`);
  }
}

/** The prompt, as data. */
function requestAdapterSpec({ caps, target = null, reason = '' }) {
  const wanted = caps.filter((c) => CAPABILITY[c]);
  return {
    title: 'DESKTOP CONTROL REQUEST',
    // NO BLANK SPACER ROWS.
    lines: [
      'An external model is asking for temporary control of this machine.',
      ...wanted.map((c) => `  ✓ ${CAPABILITY[c]}`),
      target ? `  target window: ${target}` : null,
      reason ? `  reason: ${reason}` : null,
    ].filter((x) => x !== null),
    options: [
      { label: 'Allow once (1 minute)', value: SCOPE.ONCE },
      { label: 'Allow for this session (10 minutes)', value: SCOPE.SESSION },
      { label: 'Deny', value: 'deny' },
    ],
    caps: wanted,
    target,
  };
}

/** ASK THE PERSON AT THE KEYBOARD, and apply what they say. */
/** State a fact on the shared bus. */
function emit(app, name, payload) {
  try { require('./events').busOf(app).emit(name, payload); } catch { /* the question still gets asked */ }
}

async function request(app, { caps = [], target = null, reason = '' } = {}) {
  const perms = app.desktop().permissions;
  const spec = requestAdapterSpec({ caps, target, reason });
  if (!spec.caps.length) return { ok: false, why: 'nothing was actually requested' };

  if (perms.pending) return { ok: false, why: 'another desktop request is already on screen' };
  if (!require('./interaction').available(app)) {
    perms.deny(spec.caps, 'there is no interactive terminal to ask');
    return { ok: false, why: 'no interactive terminal — desktop access is never granted unattended' };
  }

  perms._note('requested', `${spec.caps.join(', ')}${target ? ` · ${target}` : ''}`);
  // THE BRIDGE ASKS OUT LOUD, IN THE CONVERSATION.
  if (app.ui) {
    app.ui.noteActor('mcp', `Permission required: ${spec.caps.join(', ')}${target ? ` · ${target}` : ''}`);
  }
  perms.pending = spec;
  // AND A NAMED FACT, SO A SECOND WINDOW CAN SEE IT
  emit(app, EVENT.APPROVAL_REQUIRED, {
    what: spec.caps.join(', '), target: target || '', reason: reason || '', kind: 'desktop',
  });
  let picked = null;
  try {
    picked = await require('./interaction').ask(app, {
      // The panel's own title carries the headline, and each line of the request is its own row — the capability list is the whole point of showing this, and…
      title: spec.title,
      question: spec.lines.join('\n'),
      options: spec.options.map((o) => o.label),
    });
  } finally {
    perms.pending = null;
  }

  // Escape, Ctrl+C, a closed panel and EOF all arrive here as null. None of
  // them is a yes.
  const chosen = spec.options.find((o) => o.label === picked);
  if (!chosen || chosen.value === 'deny') {
    emit(app, EVENT.APPROVAL_RESOLVED, { what: spec.caps.join(', '), granted: false, kind: 'desktop' });
    perms.deny(spec.caps, picked ? 'you denied it' : 'you dismissed the request');
    if (app.ui) app.ui.noteActor('mcp', picked ? 'Permission denied — nothing was touched.' : 'Request dismissed — nothing was touched.');
    return { ok: false, why: picked ? 'denied' : 'dismissed' };
  }
  emit(app, EVENT.APPROVAL_RESOLVED, {
    what: spec.caps.join(', '), granted: true, scope: chosen.value, target: target || '', kind: 'desktop',
  });
  const given = perms.grant(spec.caps, { scope: chosen.value, target });
  // SOMETHING IS ABOUT TO MOVE YOUR MOUSE.
  try { require('./controlwindow').open(app); } catch { /* the terminal is still the stop button */ }
  // Said AFTER the stop window is up, not before: the announcement is part of
  // the story, and the safety surface comes first.
  if (app.ui) app.ui.noteActor('mcp', `Granted ${spec.caps.join(', ')} · ${chosen.value}${target ? ` · ${target}` : ''}`);
  return { ok: true, granted: given, scope: chosen.value, target };
}

module.exports = { Permissions, CAPABILITY, SCOPE, requestAdapterSpec, request, ONCE_MS, SESSION_MS };
