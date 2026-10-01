'use strict';

/**
 * THE CLIENT SIDE OF REMOTE CONTROL — and it is a client, not an implementation.
 *
 * ------------------------------------------------------------------------
 * WHAT IS NOT IN THIS FILE, and must never arrive in it.
 *
 * No Telegram polling. No bot token. No chat ids. No idea what a pairing code
 * is beyond a string to print. No second opinion about whether a session is
 * running. Every one of those lives in the supervisor, because every one of
 * them has to outlive this process — see rust/lain-supervisor/src/remote.rs.
 *
 * What IS here: the wire calls, and the shapes the terminal draws.
 *
 * ------------------------------------------------------------------------
 * THE CREDENTIAL PASSES THROUGH AND IS NOT KEPT.
 *
 * `connect` takes a token, puts it on a loopback socket, and returns. It is not
 * stored on `app`, not written to config.json, not added to the session, and
 * not returned by anything here — `status()` answers with an identity and a
 * count, which is what a person needs to see and the least that will do.
 *
 * The one thing this file does with it locally is hand it to redact.js, so that
 * if the value ever reaches a screen by some route nobody predicted, it is
 * drawn as `123…dsaw` rather than as itself.
 *
 * ------------------------------------------------------------------------
 * GATEWAY ONLY (2026-10-02). The supervisor keeps the Telegram poller and hands every message to Noema's own bot
 * gateway (src/bot/). The legacy "remote brain" — a second model and a capability catalog inside the supervisor that
 * answered a phone with Noema closed — was removed with the Rust Guardian it read from.
 */

const supervisor = require('./supervisor');

/** A wire call that must not wait forever on a wedged supervisor. */
const TIMEOUT_MS = 8000;

/**
 * Proving a token means a round trip to Telegram, which is a real network on
 * somebody's hotel wifi.
 */
const CONNECT_TIMEOUT_MS = 30000;

/** The answer when there is no runtime to ask. Frozen: a caller that mutates a
 * shared "nothing" would corrupt the next caller's nothing. */
const ABSENT = Object.freeze({ available: false, configured: false, link: 'STOPPED' });

async function ask(msg, { timeoutMs = TIMEOUT_MS, start = false } = {}) {
  try {
    const r = start
      ? await supervisor.call(msg, { timeoutMs })
      : await supervisor.callIfRunning(msg, { timeoutMs });
    return r || null;
  } catch {
    // A supervisor that cannot be reached is a STATE, not an exception — the
    // rule guardian.js already follows, for the reason stated there.
    return null;
  }
}

/**
 * WHAT IS CONNECTED, WITHOUT STARTING ANYTHING.
 *
 * Reading must not spawn a supervisor: a person who checks whether they ever
 * set this up has not asked to start a background process.
 */
async function status() {
  const r = await ask({ op: 'remote_status' });
  if (!r || !r.ok) return { ...ABSENT };
  return { available: true, ...(r.remote || {}) };
}

/**
 * PROVE IT, THEN STORE IT — in that order, and the order is the safety.
 *
 * The supervisor calls `getMe` before writing anything, so a typo is never
 * persisted and never reported as a working connection. `start: true` because
 * connecting a bot is precisely the case where a runtime is worth having: the
 * adapter has to keep listening after this terminal has gone.
 */
async function connect(token) {
  // ---- HELD BACK FROM EVERY SCREEN BEFORE IT IS SENT ANYWHERE ------------
  //
  // Same as the `/api` flow, and for the same reason: from here on the exact
  // bytes are known, so redact.js can keep them off the activity feed, an
  // error message, the transcript, the dashboard and a copied buffer. The
  // input history is scrubbed too — the panel keeps a secret answer out of
  // ↑/↓, and this is the belt to that pair of braces.
  const redact = require('./redact');
  redact.register(token);
  const r = await ask({ op: 'remote_connect', token }, { timeoutMs: CONNECT_TIMEOUT_MS, start: true });
  if (!r) return { ok: false, error: 'no runtime answered — the supervisor could not be started' };
  if (!r.ok) return { ok: false, error: r.error || 'the token was not accepted' };
  return { ok: true, remote: r.remote || {}, pairingCode: r.pairing_code || '' };
}

/** GONE MEANS GONE: the credential and the authorizations are removed, not hidden. */
async function disconnect() {
  const r = await ask({ op: 'remote_disconnect' });
  if (!r) return { ok: false, error: 'no runtime is running, so nothing is connected' };
  if (!r.ok) return { ok: false, error: r.error || 'the runtime refused' };
  return { ok: true, removed: Boolean(r.removed), remote: r.remote || {} };
}

/** Restart the adapter, keeping the credential and the authorizations. */
async function reconnect() {
  const r = await ask({ op: 'remote_reconnect' }, { start: true });
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'nothing is connected' };
  return { ok: true, remote: r.remote || {} };
}

/** A fresh pairing code, for a code that expired or a second device. */
async function pairCode() {
  const r = await ask({ op: 'remote_pair_code' });
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'nothing is connected' };
  return { ok: true, code: r.pairing_code || '', remote: r.remote || {} };
}

module.exports = { status, connect, disconnect, reconnect, pairCode, ABSENT };
