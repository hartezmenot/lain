'use strict';

/**
 * THE INTELLIGENCE FABRIC'S OWN STATE (Phase 8.3) — one file every LAIN
 * process reads, so the Harness, the CLI, Telegram and `lain --serve` see one
 * registry. A change written by any of them is seen by the others on their
 * next read (memoised on the file's mtime + size — a stat, not a parse).
 *
 *   <configDir>/fabric.json
 *   {
 *     version: 1,
 *     families:     { <family>: { policy: 'auto'|'pinned'|'ask', pinned: <accountId>|null, order: [accountId…] } },
 *     aliases:      { <accountId>: 'Personal' }            display names — identity is never changed
 *     placeholders: { <id>: { family, label, identityHint, provenance, state, note, discoveredAt } }
 *     quota:        { <accountId>: { windows: [...], limited: {until, reason}|null, at } }
 *     defaults:     { <role>: { family, model, effort, execution, policy, pinned } }
 *     events:       [ { at, type, ... } ]                   the last 60 — fallback, source-added, migration
 *   }
 *
 * NOTHING SECRET IS EVER HERE. Credentials stay in the secret store
 * (credentials.js) or in a runtime's own home; this file holds names,
 * orderings, reported quota and what happened.
 */

const fs = require('fs');
const path = require('path');

const POLICY = Object.freeze({ AUTO: 'auto', PINNED: 'pinned', ASK: 'ask' });
const POLICY_LABEL = Object.freeze({ auto: 'Automatic fallback', pinned: 'Use one account only', ask: 'Ask before switching' });
const EVENTS_KEPT = 60;

function file() { return path.join(require('../config').configDir(), 'fabric.json'); }

function empty() { return { version: 1, families: {}, aliases: {}, placeholders: {}, quota: {}, defaults: {}, seen: {}, events: [] }; }

let memo = null;   // { file, sig, value }
// ANOTHER PROCESS'S WRITE is seen within 200 ms: the file is stat'ed at most that often (a poll reads the registry
// many times); this process's own writes (update) refresh the memo at once.
const STAT_MS = 200;
const stats = new Map();
function sigOf(f, { fresh = false } = {}) {
  const now = Date.now();
  const s = stats.get(f);
  if (!fresh && s && now - s.at < STAT_MS) return s.v;
  let v;
  try { const st = fs.statSync(f); v = `${st.mtimeMs}:${st.size}`; } catch { v = 'none'; }
  stats.set(f, { v, at: now });
  return v;
}

/** The registry as it stands on disk now. Callers must not mutate it — use `update`. */
function read() {
  const f = file();
  const sig = sigOf(f);
  if (memo && memo.file === f && memo.sig === sig) return memo.value;
  let value = empty();
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (d && typeof d === 'object') value = { ...empty(), ...d };
  } catch { /* first run, or unreadable: an empty registry */ }
  for (const k of ['families', 'aliases', 'placeholders', 'quota', 'defaults', 'seen']) if (!value[k] || typeof value[k] !== 'object') value[k] = {};
  if (!Array.isArray(value.events)) value.events = [];
  // GEMINI OAUTH IS ANTIGRAVITY (8.4.1): an old record is read under its real family — nothing is deleted or rewritten here.
  for (const p of Object.values(value.placeholders)) if (p && p.family === 'gemini') p.family = 'antigravity';
  memo = { file: f, sig, value };
  return value;
}

/** The generation readers key their own memos on: changes whenever the file does. */
function generation() { const f = file(); return `${f}|${sigOf(f)}`; }

/** Read, change, write — atomically (a temp file, then rename). */
function update(fn) {
  const cur = JSON.parse(JSON.stringify(read()));
  const out = fn(cur) || cur;
  if (out.events.length > EVENTS_KEPT) out.events = out.events.slice(-EVENTS_KEPT);
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
  memo = { file: f, sig: sigOf(f, { fresh: true }), value: out };
  return out;
}

/** A thing that happened, for the tray, the account detail and a waiting CLI. */
function event(type, fields = {}) {
  const ev = { at: Date.now(), type, ...fields };
  update((d) => { d.events.push(ev); return d; });
  return ev;
}

function events({ since = 0, type = null } = {}) {
  return read().events.filter((e) => e.at > since && (!type || e.type === type));
}

// ---------------------------------------------------------------- policy --

function familyState(family) {
  const f = read().families[family] || {};
  const policy = Object.values(POLICY).includes(f.policy) ? f.policy : POLICY.AUTO;
  return { policy, pinned: f.pinned || null, order: Array.isArray(f.order) ? f.order.slice() : [] };
}

function setPolicy(family, policy, pinned = undefined) {
  if (!Object.values(POLICY).includes(policy)) return { ok: false, why: `policy is one of ${Object.values(POLICY).join(', ')}` };
  update((d) => {
    const f = { ...(d.families[family] || {}) };
    f.policy = policy;
    if (pinned !== undefined) f.pinned = pinned || null;
    if (policy !== POLICY.PINNED && pinned === undefined) f.pinned = f.pinned || null;
    d.families[family] = f;
    return d;
  });
  return { ok: true };
}

function setOrder(family, order) {
  const ids = (Array.isArray(order) ? order : []).map(String).filter(Boolean);
  update((d) => { d.families[family] = { ...(d.families[family] || {}), order: [...new Set(ids)] }; return d; });
  return { ok: true };
}

/**
 * WHEN AN ACCOUNT BECAME CAPACITY (a sign-in completing). Accounts the person has not ordered are kept
 * in the order they were connected, so a new account joins at the END of its provider's list and never
 * jumps ahead of one that was already there.
 */
function stampSeen(accountId, at = Date.now()) { update((d) => { if (!d.seen[accountId]) d.seen[accountId] = at; return d; }); return { ok: true }; }
function seenAt(accountId) { return read().seen[String(accountId || '')] || 0; }

function alias(accountId) { return read().aliases[String(accountId || '')] || null; }
function setAlias(accountId, name) {
  const n = String(name || '').trim().slice(0, 60);
  update((d) => { if (n) d.aliases[accountId] = n; else delete d.aliases[accountId]; return d; });
  return { ok: true };
}

// ----------------------------------------------------------------- quota --

/**
 * What a provider REPORTED about an account's windows, and a limit it hit.
 * Only reported windows are kept — nothing is estimated from token counts.
 */
function quotaOf(accountId) { return read().quota[String(accountId || '')] || null; }
function recordQuota(accountId, { windows = undefined, limited = undefined, source = null } = {}) {
  const id = String(accountId || '');
  if (!id) return null;
  let changed = false;
  const out = update((d) => {
    const prev = d.quota[id] || {};
    const next = { ...prev, at: Date.now() };
    if (windows !== undefined) next.windows = (windows || []).filter((w) => w && (w.usedPercent != null || w.remainingPercent != null || w.resetsAt || w.credits != null)).map((w) => {
      // THE WINDOW'S ID AND LENGTH are kept (2026-10-01): without them a reset could not be rolled past or a previous window bounded (resetwindows.js).
      const rec = { id: w.id || null, windowMins: Number(w.windowMins || w.mins) || null, label: String(w.label || w.id || ''), usedPercent: w.usedPercent == null ? null : Math.round(Number(w.usedPercent)), resetsAt: w.resetsAt || null, credits: w.credits == null ? null : w.credits };
      // A PROVIDER THAT REPORTS WHAT REMAINS is kept as it said it — used is derived from that, and the record says which it was.
      if (w.usedPercent == null && w.remainingPercent != null) { const rem = Math.max(0, Math.min(100, Math.round(Number(w.remainingPercent)))); rec.usedPercent = 100 - rem; rec.remainingPercent = rem; rec.reported = 'remaining'; }
      return rec;
    });
    if (limited !== undefined) next.limited = limited ? { until: limited.until || null, reason: String(limited.reason || 'rate limited').slice(0, 200) } : null;
    if (source) next.source = source;
    changed = JSON.stringify({ ...prev, at: 0 }) !== JSON.stringify({ ...next, at: 0 });
    d.quota[id] = next;
    return d;
  });
  return { value: out.quota[id], changed };
}

/** Is an account held by a limit right now? A past `until` is no longer a limit. */
function limitedNow(accountId, now = Date.now()) {
  const q = quotaOf(accountId);
  const l = q && q.limited;
  if (!l) return null;
  if (l.until && now >= l.until) return null;
  return l;
}

// ---------------------------------------------------------- placeholders --

function placeholders() { return read().placeholders; }
function putPlaceholder(id, rec) { update((d) => { d.placeholders[id] = { ...(d.placeholders[id] || {}), ...rec }; return d; }); return { ok: true, id }; }
function dropPlaceholder(id) { update((d) => { delete d.placeholders[id]; return d; }); return { ok: true }; }

// -------------------------------------------------------------- defaults --

const ROLES = Object.freeze(['chat', 'assistant', 'coding', 'research', 'vision', 'auxiliary']);
function roleDefault(role) { return read().defaults[role] || null; }
function setRoleDefault(role, value) {
  if (!ROLES.includes(role)) return { ok: false, why: `role is one of ${ROLES.join(', ')}` };
  update((d) => { if (value) d.defaults[role] = value; else delete d.defaults[role]; return d; });
  return { ok: true };
}

/** For tests: forget the memo (a test swapping LAIN_CONFIG_DIR mid-process). */
function reset() { memo = null; stats.clear(); }

module.exports = {
  POLICY, POLICY_LABEL, ROLES, file, read, update, generation, event, events,
  familyState, setPolicy, setOrder, alias, setAlias,
  quotaOf, recordQuota, limitedNow,
  placeholders, putPlaceholder, dropPlaceholder, stampSeen, seenAt,
  roleDefault, setRoleDefault, reset,
};
