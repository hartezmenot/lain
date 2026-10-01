'use strict';

/**
 * WHO MAY WRITE A SESSION — one lease per session, shared by every Noema process on this home (2026-10-02).
 *
 *   <sessions>/.lease/<id>.json  { v, owner:{pid,nonce,surface,host}|null, epoch, since, beat,
 *                                  pausedBy, at, from, handoff, reservedFor, request }
 *
 * THE ONE OWNER of "which process executes this session". It replaces the writer kept inside the session file
 * (workbench.surface — read once below for sessions written before this file existed) and the Rust Guardian's
 * owner_pid. surfacehandoff.js is the surface vocabulary on top of it (Continue in CLI, Take back, ▶ Continue).
 *
 * EVERY CHANGE IS A COMPARE-AND-SWAP. A change runs inside a tiny mutex (`.lease/<id>.lock`, created exclusively,
 * held for one read-modify-write, then removed). Two processes acquiring at once: exactly one wins, the other reads
 * the winner. A mutex left behind by a crash inside that window is older than MUTEX_STALE_MS and is broken.
 *
 * LIVENESS IS THE PID AND A HEARTBEAT. The owner rewrites `beat` every BEAT_MS. A lease whose pid is gone, or whose
 * beat is older than STALE_MS (a reused pid, a wedged process), is dead and may be taken — with the epoch advanced, so
 * a stale owner that wakes up finds it no longer holds what it thinks it holds.
 *
 * OWNERSHIP IS (pid, process nonce, surface). Within one process the CLI and every Harness view of its sessions are
 * one surface; tests that run a CLI App and a Harness App side by side in one process are two.
 *
 * NO AUTOMATIC MIGRATION. A live owner is never displaced: another surface may only `request` the session, and the
 * owner hands it over at its next idle moment (between turns) — see `tick`.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 2 s: an idle owner notices a hand-over request this quickly (a beat is one small file write per held session).
const BEAT_MS = 2_000;
const STALE_MS = 60_000;
const MUTEX_STALE_MS = 5_000;
const MUTEX_WAIT_MS = 2_000;
const REQUEST_TTL_MS = 10 * 60_000;

const NONCE = crypto.randomBytes(6).toString('hex');

/** Sessions this process holds: id → { surface, busy() } (busy: is a turn running there). */
const held = new Map();
let timer = null;

// A HIDDEN SUBFOLDER: everything `*.json` directly in the sessions folder is read as a session (Session.list, sessionindex).
function sessions() { return require('./config').sessionsDir(); }
function dir() { return path.join(sessions(), '.lease'); }
function fileOf(id) { return path.join(dir(), `${id}.json`); }
function lockOf(id) { return path.join(dir(), `${id}.lock`); }

function alive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function blank() { return { v: 1, owner: null, epoch: 0, since: 0, beat: 0, pausedBy: null, at: 0, from: null, handoff: null, reservedFor: null, request: null }; }

/** A lease from before this file existed lives in the session file (workbench.surface). Read once, never written. */
function legacy(id) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(sessions(), `${id}.json`), 'utf8'));
    const s = d && d.workbench && d.workbench.surface;
    if (!s) return null;
    const r = blank();
    if (s.writer && s.pid) r.owner = { pid: s.pid, nonce: null, surface: s.writer, host: os.hostname() };
    else if (s.writer && !s.pid) r.reservedFor = s.writer;
    r.pausedBy = s.pausedBy || null; r.at = s.at || 0; r.from = s.from || null; r.handoff = s.handoff || null;
    r.since = s.since || 0; r.beat = 0; r.legacy = true;
    return r;
  } catch { return null; }
}

function read(id) {
  if (!id) return null;
  try { const d = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); return d && typeof d === 'object' ? { ...blank(), ...d } : null; } catch { return legacy(id); }
}

/** Is the recorded owner still there? A legacy owner has no heartbeat: its pid alone decides. */
function ownerAlive(r, now = Date.now()) {
  const o = r && r.owner;
  if (!o || !alive(o.pid)) return false;
  if (o.nonce === NONCE && o.pid === process.pid) return true;
  if (r.legacy || !r.beat) return true;
  return now - r.beat < STALE_MS;
}

function isMine(r, surface) {
  const o = r && r.owner;
  return Boolean(o && o.pid === process.pid && o.nonce === NONCE && o.surface === surface);
}

function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best effort */ } }

/** Windows refuses to replace a file another process has open for a moment (EPERM/EACCES/EBUSY): try again briefly. */
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 50 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      sleepSync(4);
    }
  }
}

/** Run fn(record) → record|null under the per-session mutex; write what it returns. Returns { ok, lease, value }. */
function mutate(id, fn) {
  fs.mkdirSync(dir(), { recursive: true });
  const lock = lockOf(id);
  const until = Date.now() + MUTEX_WAIT_MS;
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > MUTEX_STALE_MS) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > until) return { ok: false, why: 'the session lease is busy — try again' };
      sleepSync(5);
    }
  }
  try {
    const cur = read(id) || blank();
    delete cur.legacy;
    const out = fn(cur);
    if (out && out.lease) {
      const tmp = `${fileOf(id)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out.lease));
      renameRetry(tmp, fileOf(id));
    }
    return { ok: true, lease: (out && out.lease) || cur, value: out ? out.value : undefined };
  } finally {
    try { fs.closeSync(fd); } catch { /* closed */ }
    try { fs.unlinkSync(lock); } catch { /* gone */ }
  }
}

function surfaceName(surface) { return String(surface || process.env.LAIN_SURFACE || 'cli'); }

/** Why a surface may not write, in words a person reads, and how to change it. */
function refusal(r, me) {
  const who = r.owner ? r.owner.surface : r.reservedFor;
  const name = who === 'cli' ? 'the CLI' : who === 'harness' ? 'the Harness' : who || 'another surface';
  const how = me === 'cli'
    ? (who === 'harness' ? '/takeover asks the Harness to hand it over' : '/takeover asks for it, or /resume a different session')
    : who === 'cli' ? 'Take over asks the CLI to hand it over at its next checkpoint' : 'Take over asks for it';
  return `This session continues in ${name} now${r.owner ? ` (pid ${r.owner.pid})` : ''}. ${how[0].toUpperCase()}${how.slice(1)}.`;
}

/**
 * TAKE THE SESSION FOR THIS SURFACE, or say who has it.
 *   force: ignore a reservation (an explicit Take back) — never a live owner
 * @returns {{ok:true, lease, took:boolean, previous:object|null}|{ok:false, why, lease}}
 */
function acquire(id, { surface, force = false, busy = null } = {}) {
  const me = surfaceName(surface);
  const r = mutate(id, (cur) => {
    if (isMine(cur, me)) return { value: { took: false, previous: null } };
    if (cur.owner && ownerAlive(cur)) return { value: { refused: refusal(cur, me) } };
    if (cur.reservedFor && cur.reservedFor !== me && !force) return { value: { refused: refusal(cur, me) } };
    const previous = cur.owner ? { ...cur.owner, dead: true } : null;
    const now = Date.now();
    const lease = { ...cur, owner: { pid: process.pid, nonce: NONCE, surface: me, host: os.hostname() }, epoch: (cur.epoch || 0) + 1, since: now, beat: now, reservedFor: null, request: null, handoff: null, from: (cur.owner && cur.owner.surface) || cur.from || null };
    return { lease, value: { took: true, previous } };
  });
  if (!r.ok) return { ok: false, why: r.why, lease: null };
  if (r.value && r.value.refused) return { ok: false, why: r.value.refused, lease: r.lease };
  held.set(id, { surface: me, busy: typeof busy === 'function' ? busy : (held.get(id) || {}).busy || (() => false) });
  arm();
  return { ok: true, lease: r.lease, took: Boolean(r.value && r.value.took), previous: (r.value && r.value.previous) || null };
}

/** Give it up. `pausedBy` records unfinished work ('cli-closed' | 'host-closed'); `handoff`/`reservedFor` a hand-over. */
function release(id, { surface, pausedBy = null, handoff = null, reservedFor = null } = {}) {
  const me = surfaceName(surface);
  held.delete(id);
  const r = mutate(id, (cur) => {
    if (!isMine(cur, me)) return null;
    return { lease: { ...cur, owner: null, pausedBy, at: Date.now(), from: me, handoff, reservedFor, request: null } };
  });
  return r.ok ? r.lease : null;
}

/** Hand a FREE (or own) session to another surface without an owner yet — "Continue in CLI". */
function reserve(id, { surface, to, handoff = null } = {}) {
  const me = surfaceName(surface);
  held.delete(id);
  const r = mutate(id, (cur) => {
    if (cur.owner && ownerAlive(cur) && !isMine(cur, me)) return { value: { refused: refusal(cur, me) } };
    return { lease: { ...cur, owner: null, reservedFor: to, handoff, from: me, at: Date.now(), pausedBy: null, request: null } };
  });
  if (!r.ok) return { ok: false, why: r.why };
  if (r.value && r.value.refused) return { ok: false, why: r.value.refused };
  return { ok: true, lease: r.lease };
}

/** Is there a hand-over request from THIS process and surface still waiting on the owner? */
function requested(id, { surface } = {}) {
  const r = read(id);
  return Boolean(r && r.request && r.request.pid === process.pid && r.request.nonce === NONCE && r.request.surface === surfaceName(surface) && Date.now() - r.request.at < REQUEST_TTL_MS);
}

/** Ask the live owner to hand the session over at its next idle moment. */
function request(id, { surface } = {}) {
  const me = surfaceName(surface);
  const r = mutate(id, (cur) => {
    if (!cur.owner || !ownerAlive(cur) || isMine(cur, me)) return null;
    return { lease: { ...cur, request: { pid: process.pid, nonce: NONCE, surface: me, at: Date.now() } } };
  });
  return r.ok ? r.lease : null;
}

/** A dead owner is recorded as the pause it left: host-crashed when its turn was in flight. */
function reap(id, { inflight = false } = {}) {
  const r = mutate(id, (cur) => {
    if (!cur.owner || ownerAlive(cur)) return null;
    const o = cur.owner;
    const pausedBy = inflight ? 'host-crashed' : o.surface === 'cli' ? 'cli-closed' : 'host-closed';
    return { lease: { ...cur, owner: null, pausedBy, at: Date.now(), from: o.surface, handoff: null, deadPid: o.pid } };
  });
  return r.ok && r.lease && !r.lease.owner && r.lease.deadPid ? r.lease : null;
}

/** Edit descriptive fields of a lease this surface holds, or of a free one (e.g. clear a pause on resume). */
function note(id, fields, { surface } = {}) {
  const me = surfaceName(surface);
  const r = mutate(id, (cur) => {
    if (cur.owner && ownerAlive(cur) && !isMine(cur, me)) return null;
    return { lease: { ...cur, ...fields } };
  });
  return r.ok ? r.lease : null;
}

/** The shape surfaces draw (unchanged from workbench.surface): writer, pid, pausedBy, handoff — plus mine/request. */
function view(id, { surface } = {}) {
  const r = read(id);
  if (!r) return null;
  const live = Boolean(r.owner && ownerAlive(r));
  return {
    writer: live ? r.owner.surface : (r.reservedFor || null),
    pid: live ? r.owner.pid : null,
    since: r.since || null,
    pausedBy: live ? null : (r.pausedBy || null),
    from: r.from || null,
    at: r.at || null,
    handoff: r.handoff || null,
    epoch: r.epoch || 0,
    mine: surface ? isMine(r, surfaceName(surface)) : false,
    request: r.request && Date.now() - r.request.at < REQUEST_TTL_MS ? { surface: r.request.surface, at: r.request.at } : null,
    deadPid: !live && r.owner ? r.owner.pid : (r.deadPid || null),
  };
}

/** Every session this process holds — heartbeats, and hands over the requested ones that are idle. */
function tick() {
  const now = Date.now();
  for (const [id, h] of [...held.entries()]) {
    let busy = false;
    try { busy = Boolean(h.busy()); } catch { busy = false; }
    mutate(id, (cur) => {
      if (!isMine(cur, h.surface)) { held.delete(id); return null; }
      const req = cur.request && now - cur.request.at < REQUEST_TTL_MS && alive(cur.request.pid) ? cur.request : null;
      if (req && !busy) {
        held.delete(id);
        return { lease: { ...cur, owner: null, at: now, from: h.surface, reservedFor: req.surface, handoff: { at: now, from: h.surface, to: req.surface, requested: true }, request: null, pausedBy: null } };
      }
      return { lease: { ...cur, beat: now, request: req } };
    });
  }
  if (!held.size && timer) { clearInterval(timer); timer = null; }
}

function arm() {
  if (timer) return;
  timer = setInterval(() => { try { tick(); } catch { /* the next beat tries again */ } }, BEAT_MS);
  if (timer.unref) timer.unref();
}

/** On the way out: every lease this process holds is released (unfinished work becomes a pause). */
function releaseAll({ pausedByOf = () => null } = {}) {
  for (const [id, h] of [...held.entries()]) {
    try { release(id, { surface: h.surface, pausedBy: pausedByOf(id, h.surface) }); } catch { /* best effort */ }
  }
}

function heldIds() { return [...held.keys()]; }

/** TESTS ONLY: pretend the owner is another, dead process. */
function _setOwnerPid(id, pid) { mutate(id, (cur) => (cur.owner ? { lease: { ...cur, owner: { ...cur.owner, pid, nonce: 'gone' } } } : null)); held.delete(id); }
function _reset() { held.clear(); if (timer) { clearInterval(timer); timer = null; } }

/** Every session id that has a lease record (live or released). */
function ids() { try { return fs.readdirSync(dir()).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)); } catch { return []; } }

/** A deleted session takes its lease record with it — only when nobody live holds it. */
function forget(id) { const r = read(id); if (r && r.owner && ownerAlive(r)) return false; try { fs.unlinkSync(fileOf(id)); } catch { /* none */ } return true; }

module.exports = { acquire, release, reserve, request, requested, reap, note, read, view, tick, releaseAll, heldIds, ids, forget, ownerAlive, fileOf, NONCE, BEAT_MS, STALE_MS, _setOwnerPid, _reset };
