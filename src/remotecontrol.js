'use strict';

/** THE CLIENT SIDE OF REMOTE CONTROL — and it is a client, not an implementation. */

const supervisor = require('./supervisor');

/** A wire call that must not wait forever on a wedged supervisor. */
const TIMEOUT_MS = 8000;

/** Proving a token means a round trip to Telegram, which is a real network on somebody's hotel wifi. */
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

/** WHAT IS CONNECTED, WITHOUT STARTING ANYTHING. */
async function status() {
  const r = await ask({ op: 'remote_status' });
  if (!r || !r.ok) return { ...ABSENT };
  return { available: true, ...(r.remote || {}) };
}

/** PROVE IT, THEN STORE IT — in that order, and the order is the safety. */
async function connect(token) {
  // HELD BACK FROM EVERY SCREEN BEFORE IT IS SENT ANYWHERE
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
