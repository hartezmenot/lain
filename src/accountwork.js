'use strict';

/** WHO IS WORKING RIGHT NOW (Phase 8.4 hotfix) — the requests in flight, per ACCOUNT. */

const running = new Map();   // key -> Map(token -> { at, pid, kind })
let seq = 0;

const keyOf = (driver, instanceId) => (instanceId ? String(instanceId) : `default:${driver}`);

/** Mark a run started. Returns the token to `end`. */
function begin(driver, instanceId, info = {}) {
  const k = keyOf(driver, instanceId);
  if (!running.has(k)) running.set(k, new Map());
  const token = ++seq;
  running.get(k).set(token, { at: Date.now(), kind: info.kind || 'request', pid: info.pid || null, turn: info.turn || null });
  return { key: k, token };
}
function end(h) {
  if (!h) return;
  const m = running.get(h.key);
  if (!m) return;
  m.delete(h.token);
  if (!m.size) running.delete(h.key);
}
/** The runs in flight through an account (a copy). */
function busy(driver, instanceId) {
  const m = running.get(keyOf(driver, instanceId));
  return m ? [...m.values()] : [];
}
/** BUSY, BY ACCOUNT ID as a lane holds it: an instance id, or `runtime:<driver>` for the person's own default profile. */
function busyAccount(accountId) {
  const id = String(accountId || '');
  if (!id) return [];
  const m = /^runtime:([\w-]+)$/.exec(id);
  return m ? busy(m[1], null) : busy('', id);
}
function isBusy(driver, instanceId) { return busy(driver, instanceId).length > 0; }
function attach(h, pid) { const m = h && running.get(h.key); const r = m && m.get(h.token); if (r) r.pid = pid; }
function counts() { const out = {}; for (const [k, m] of running) out[k] = m.size; return out; }
function _reset() { running.clear(); }

module.exports = { begin, end, busy, busyAccount, isBusy, attach, counts, keyOf, _reset };
