'use strict';

/**
 * ONE WRITER PER SESSION, HANDED BETWEEN SURFACES — Harness ⇄ CLI.
 *
 * The lease itself is sessionlease.js (one file per session, compare-and-swap, heartbeat). This file is the SURFACE
 * vocabulary on top of it, unchanged for its callers:
 *
 *   Harness ──Continue in CLI──► the session is reserved for the CLI → `noema --resume <id>`
 *   CLI     ──/handback─────────► reserved for the Harness → the Harness reloads it from disk and carries on
 *   claim(app)    every executing surface takes the lease before a turn (App.submit / inputgate); a session another
 *                 process wrote meanwhile is reloaded from disk first — never a stale in-memory copy written over it
 *   release(app)  on the way out: unfinished work is a PAUSE (`cli-closed`, `host-closed`), not an ending
 *   sync(app)     the Harness notices a host that died (pid gone or heartbeat stale) and records the pause it left
 *   resumeHere()  ▶ Continue: take the lease, reload the session as the other host left it, continue the SAME task
 *   takeBack()    explicit: a free/reserved session is taken; a LIVE owner is only ASKED (it hands over when idle)
 *
 * The same task, the same session file, the same Core state: nothing is copied and no second task is created.
 */

const fs = require('fs');
const path = require('path');
const lease = require('./sessionlease');

const SURFACES = Object.freeze(['harness', 'cli', 'telegram']);

function surfaceOf(app) { return (app && (app._surfaceName || (app._sibling && app._sibling._surfaceName))) || process.env.LAIN_SURFACE || 'cli'; }

function fileOf(id) { return path.join(require('./config').sessionsDir(), `${id}.json`); }

/** The lease as surfaces draw it: { writer, pid, pausedBy, handoff, … } or null. */
function persisted(id) { return lease.view(id); }

function busyOf(app) { return () => Boolean(app && app.abort && !app.abort.signal.aborted); }

function nameOf(w) { return w === 'cli' ? 'the CLI' : w === 'harness' ? 'the Harness' : w; }

/** May THIS surface write to the session now? (Read-only: claim() is the act.) */
function check(app) {
  const s = app && app.session;
  if (!s || !s.id) return { ok: true };
  const me = surfaceOf(app);
  const v = lease.view(s.id, { surface: me });
  if (!v || !v.writer || v.mine || (v.writer === me && !v.pid)) return { ok: true, lease: v };
  const how = me === 'cli' ? (v.writer === 'harness' ? '/takeover asks the Harness to hand it over, or /resume a different session' : '/takeover asks for it')
    : v.writer === 'cli' ? (v.pid ? 'Take over asks the CLI to hand it over at its next checkpoint' : 'Take it back in the Harness (Coding Agent › Take back from CLI)')
      : `release it from ${v.writer}`;
  return { ok: false, lease: v, why: `This session continues in ${nameOf(v.writer)} now. ${how[0].toUpperCase()}${how.slice(1)}.` };
}

function command(s) {
  const short = require('./session').Session.shortId ? require('./session').Session.shortId(s.id) : s.id;
  return `noema --resume ${short}`;
}

/** Load the session another process (or surface) left on disk into this App — the same session, never a replay. */
function reload(app) {
  const { Session } = require('./session');
  const fresh = Session.resume(app.session.id);
  if (!fresh) return false;
  app.adopt(fresh, { resumedFrom: fresh.id });
  return true;
}

/**
 * THE SURFACE TAKES THE LEASE as it starts working. Returns the lease view, or null when another surface holds it
 * (check() says why). When the session was last written by someone else, it is reloaded from disk first.
 */
function claim(app) {
  const s = app && app.session;
  if (!s || !s.id) return null;
  const me = surfaceOf(app);
  const r = lease.acquire(s.id, { surface: me, busy: busyOf(app) });
  if (!r.ok) return null;
  const otherWrote = r.took && ((r.previous && !(r.previous.pid === process.pid && r.previous.surface === me)) || (r.lease.from && r.lease.from !== me));
  if (otherWrote && fs.existsSync(fileOf(s.id))) reload(app);
  return lease.view(s.id, { surface: me });
}

/** Is there work this session had not finished? (a turn in flight, a plan with steps left, a paused quota) */
function unfinished(s) {
  try {
    const turns = s.turns || [];
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && !lastTurn.endedAt && !lastTurn.outcome) return true;
    if (s.inflight) return true;
    const p = s.plan;
    if (p && Array.isArray(p.steps) && p.steps.some((x) => x.status === 'todo' || x.status === 'active')) return true;
    const w = s.workbench;
    return Boolean(w && w.quota && w.quota.state === 'QUOTA_PAUSED');
  } catch { return false; }
}

function pauseWord(surface) { return surface === 'cli' ? 'cli-closed' : 'host-closed'; }

/** ON THE WAY OUT: release the lease; unfinished work is a PAUSE, not an ending. */
function release(app) {
  const s = app && app.session;
  if (!s || !s.id) return null;
  const me = surfaceOf(app);
  const r = lease.release(s.id, { surface: me, pausedBy: unfinished(s) ? pauseWord(me) : null });
  return r ? { writer: null, pausedBy: r.pausedBy || null, at: r.at, from: me, handoff: null } : null;
}

/** Hand the session to another surface. Refused while a turn runs — at a checkpoint only. */
function handoff(app, to) {
  const s = app.session;
  const t = String(to || '').toLowerCase();
  if (!SURFACES.includes(t)) return { ok: false, why: `hand off to one of ${SURFACES.join(', ')}` };
  if (app.abort && !app.abort.signal.aborted) return { ok: false, why: 'the Agent is working — hand off at its next checkpoint' };
  const from = surfaceOf(app);
  if (t === from) return { ok: false, why: `this session is already on the ${t}` };
  s.save();
  const h = { at: Date.now(), from, to: t, command: t === 'cli' ? command(s) : null, cwd: s.cwd };
  const r = lease.reserve(s.id, { surface: from, to: t, handoff: h });
  if (!r.ok) return { ok: false, why: r.why };
  return { ok: true, surface: lease.view(s.id), command: h.command, cwd: s.cwd };
}

/**
 * TAKE IT BACK HERE. A free or reserved session is taken and reloaded from disk. A session a LIVE process holds is
 * never taken: that process is asked, and hands it over at its next idle moment (sessionlease.tick).
 */
function takeBack(app) {
  const s = app.session;
  const me = surfaceOf(app);
  const v = lease.view(s.id, { surface: me });
  if (v && v.pid && !v.mine) {
    lease.request(s.id, { surface: me });
    return { ok: false, pending: true, why: `asked ${nameOf(v.writer)} to hand this session over at its next checkpoint` };
  }
  const r = lease.acquire(s.id, { surface: me, force: true, busy: busyOf(app) });
  if (!r.ok) return { ok: false, why: r.why };
  if (!reload(app)) return { ok: false, why: 'the session file could not be read' };
  return { ok: true, surface: lease.view(s.id, { surface: me }), reloaded: true };
}

function takeBackPaused(app) {
  // Reloaded, NOT claimed: the lease stays free until the person presses Continue (or types) —
  // unless the host died mid-turn, when the task resumes here by itself (App.adopt → autocontinue).
  if (!reload(app)) return null;
  const v = lease.view(app.session.id);
  return { ok: true, paused: (v && v.pausedBy) || 'cli-closed' };
}

/** A HOST THAT DIED HOLDING THE LEASE (pid gone, or heartbeat stale), recorded as the pause it left. */
function reapDeadCli(id) {
  const r0 = lease.read(id);
  if (!r0 || !r0.owner || lease.ownerAlive(r0)) return null;
  let inflight = false;
  try { inflight = Boolean(JSON.parse(fs.readFileSync(fileOf(id), 'utf8')).inflight); } catch { inflight = false; }
  const r = lease.reap(id, { inflight });
  return r ? { writer: null, pausedBy: r.pausedBy, at: r.at, from: r.from, handoff: null, pid: r.deadPid } : null;
}

/**
 * THE HARNESS FOLLOWS THE LEASE: a host that died is recorded and its session reloaded; a session handed back to this
 * surface is taken and reloaded.
 */
function sync(app) {
  const s = app && app.session;
  if (!s || !s.id) return null;
  const me = surfaceOf(app);
  if (me !== 'cli' && reapDeadCli(s.id)) return takeBackPaused(app);
  const v = lease.view(s.id, { surface: me });
  if (v && v.writer === me && !v.pid && v.handoff && v.handoff.to === me) return takeBack(app);
  return null;
}

/** ▶ CONTINUE, HERE: take the lease, reload the session exactly as the other host left it. */
function resumeHere(app) {
  const s = app.session;
  const me = surfaceOf(app);
  const v = lease.view(s.id, { surface: me });
  if (v && v.pid && !v.mine) return { ok: false, why: `${v.writer === 'cli' ? 'the CLI is still running this session' : 'another surface is running this session'} — take it over instead, or close it` };
  const was = v && v.pausedBy;
  const t = takeBack(app);
  if (!t.ok) return t;
  lease.note(app.session.id, { pausedBy: null }, { surface: me });
  return { ok: true, resumedFrom: was || null, reloaded: true };
}

/** Record or clear a pause on this session's lease (autocontinue's host-crashed, its resumption). */
function notePause(app, pausedBy) {
  const s = app && app.session;
  if (!s || !s.id) return null;
  return lease.note(s.id, { pausedBy: pausedBy || null, at: Date.now() }, { surface: surfaceOf(app) });
}

/** Every lease this process holds, released on exit; unfinished sessions are paused. */
function releaseAll(app) {
  const pool = (() => { try { return app && app.pool ? app.pool() : null; } catch { return null; } })();
  lease.releaseAll({
    pausedByOf: (id, surface) => {
      const a = pool ? pool.live(id) : (app && app.session && app.session.id === id ? app : null);
      return a && unfinished(a.session) ? pauseWord(surface) : null;
    },
  });
}

module.exports = { check, handoff, takeBack, sync, surfaceOf, persisted, claim, release, releaseAll, reapDeadCli, resumeHere, unfinished, notePause, SURFACES };
