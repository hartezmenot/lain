'use strict';

/**
 * ONE WRITER PER SESSION, HANDED BETWEEN SURFACES — Harness ⇄ CLI.
 *
 *   Harness ──Continue in CLI──► state saved (plan, phase, findings, handover
 *            facts are already the session) → writer = cli → `lain --resume <id>`
 *   CLI     ──/handback─────────► writer = harness → the Harness reloads the
 *            session from disk and carries on (it never replays a transcript)
 *
 * The same task, the same session file, the same Core state: nothing is copied
 * and no second task is created. While another surface holds the writer, a
 * sentence here is HELD (inputgate.js) with the reason and how to take it back
 * — never silently written by two processes at once.
 *
 * The lease lives in the session file (workbench.surface) because the two
 * surfaces are different processes; each reads it fresh from disk.
 *
 * CLOSING THE CLI PAUSES, IT NEVER ENDS THE TASK (Phase 8.1). The CLI is an
 * execution host, not the owner of the work:
 *   claim(app)    the CLI takes the writer (with its pid) when it starts a turn
 *   release(app)  on the CLI's way out: unfinished work is marked
 *                 { writer: null, pausedBy: 'cli-closed' } — plan, phase,
 *                 findings, evidence and the continuation stay in the session
 *   sync(app)     the Harness notices a CLI that died without releasing (its pid
 *                 is gone) and marks the same pause
 *   resumeHere()  ▶ Continue: take the writer, reload the session from disk,
 *                 and continue the SAME task — no second session, no replay.
 */

const fs = require('fs');
const path = require('path');
const wb = require('./workbench');

const SURFACES = Object.freeze(['harness', 'cli', 'telegram']);

function surfaceOf(app) { return (app && (app._surfaceName || (app._sibling && app._sibling._surfaceName))) || process.env.LAIN_SURFACE || 'cli'; }

function fileOf(id) { return path.join(require('./config').sessionsDir(), `${id}.json`); }
/** The lease as the session FILE has it — another process may have changed it. */
function persisted(id) {
  try { const d = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); return (d.workbench && d.workbench.surface) || null; } catch { return null; }
}

/** May THIS surface write to the session now? */
function check(app) {
  const s = app && app.session;
  if (!s || !s.id) return { ok: true };
  const lease = persisted(s.id) || (s.workbench && s.workbench.surface) || null;
  const me = surfaceOf(app);
  if (!lease || !lease.writer || lease.writer === me) return { ok: true, lease };
  const how = lease.writer === 'cli' ? 'Take it back in the Harness (Coding Agent › Take back from CLI)' : lease.writer === 'harness' ? 'hand it over from the Harness (Continue in CLI), or /resume a different session' : `release it from ${lease.writer}`;
  return { ok: false, lease, why: `This session continues in the ${lease.writer === 'cli' ? 'CLI' : lease.writer === 'harness' ? 'Harness' : lease.writer} now. ${how}.` };
}

function command(s) {
  const short = require('./session').Session.shortId ? require('./session').Session.shortId(s.id) : s.id;
  return `noema --resume ${short}`;
}

/** Hand the writer to another surface. Refused while a turn runs — at a checkpoint only. */
function handoff(app, to) {
  const s = app.session;
  const t = String(to || '').toLowerCase();
  if (!SURFACES.includes(t)) return { ok: false, why: `hand off to one of ${SURFACES.join(', ')}` };
  if (app.abort && !app.abort.signal.aborted) return { ok: false, why: 'the Agent is working — hand off at its next checkpoint' };
  const from = surfaceOf(app);
  if (t === from) return { ok: false, why: `this session is already on the ${t}` };
  const w = wb.of(s);
  w.surface = { writer: t, from, since: Date.now(), pid: null, handoff: { at: Date.now(), from, to: t, command: t === 'cli' ? command(s) : null, cwd: s.cwd } };
  s.save();
  return { ok: true, surface: w.surface, command: w.surface.handoff.command, cwd: s.cwd };
}

/** Take the writer back here, reloading the session the other surface wrote. */
function takeBack(app) {
  const s = app.session;
  const { Session } = require('./session');
  const fresh = Session.resume(s.id);
  if (!fresh) return { ok: false, why: 'the session file could not be read' };
  const me = surfaceOf(app);
  const w = wb.of(fresh);
  w.surface = { writer: me, from: (w.surface && w.surface.writer) || null, since: Date.now(), pid: process.pid, handoff: null };
  app.adopt(fresh, { resumedFrom: fresh.id });
  fresh.save();
  return { ok: true, surface: w.surface, reloaded: true };
}

function takeBackPaused(app) {
  const s = app.session;
  const { Session } = require('./session');
  const fresh = Session.resume(s.id);
  if (!fresh) return null;
  // Reloaded, NOT claimed: the writer stays free until the person presses Continue (or types) —
  // unless the CLI died mid-turn, when the task resumes here by itself (App.adopt → autocontinue).
  app.adopt(fresh, { resumedFrom: fresh.id });
  const pausedBy = fresh.workbench && fresh.workbench.surface ? fresh.workbench.surface.pausedBy : null;
  return { ok: true, paused: pausedBy || 'cli-closed' };
}

/**
 * THE HARNESS FOLLOWS A HAND-BACK: when the file says the writer is this surface
 * again but the in-memory copy still thinks another surface has it, reload.
 */
function sync(app) {
  const s = app && app.session;
  if (!s || !s.id) return null;
  // A CLI THAT DIED HOLDING THE WRITER: record the pause and pick the session up as the CLI left it
  // (a mid-turn death arrives with `recovered`, and App.adopt schedules the task's own resumption).
  if (surfaceOf(app) !== 'cli' && reapDeadCli(s.id)) return takeBackPaused(app);
  const mem = s.workbench && s.workbench.surface;
  if (!mem || !mem.writer || mem.writer === surfaceOf(app)) return null;
  const disk = persisted(s.id);
  if (disk && disk.writer === surfaceOf(app)) return takeBack(app);
  return null;
}

// ---- the CLI as an execution host --------------------------------------------------

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Is there work this session had not finished? (a turn in flight, a plan with steps left, a paused quota) */
function unfinished(s) {
  try {
    const turns = s.turns || [];
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && !lastTurn.endedAt && !lastTurn.outcome) return true;
    const p = s.plan;
    if (p && Array.isArray(p.steps) && p.steps.some((x) => x.status === 'todo' || x.status === 'active')) return true;
    const w = s.workbench;
    return Boolean(w && w.quota && w.quota.state === 'QUOTA_PAUSED');
  } catch { return false; }
}

/** THE CLI TAKES THE WRITER as it starts working — recorded with its pid. */
function claim(app) {
  if (surfaceOf(app) !== 'cli') return null;
  const s = app && app.session;
  if (!s || !s.id) return null;
  const w = wb.of(s);
  const cur = w.surface;
  if (cur && cur.writer === 'cli' && cur.pid === process.pid) return cur;
  if (cur && cur.writer && cur.writer !== 'cli') return null;   // another surface holds it (check() already refused)
  w.surface = { writer: 'cli', from: cur ? cur.writer || null : null, since: Date.now(), pid: process.pid, handoff: cur ? cur.handoff || null : null };
  return w.surface;
}

/** ON THE CLI'S WAY OUT: release the writer; unfinished work is a PAUSE, not an ending. */
function release(app) {
  const s = app && app.session;
  if (!s || !s.id || surfaceOf(app) !== 'cli') return null;
  const w = wb.of(s);
  const cur = w.surface;
  if (!cur || cur.writer !== 'cli' || (cur.pid && cur.pid !== process.pid)) return null;
  w.surface = unfinished(s)
    ? { writer: null, pausedBy: 'cli-closed', at: Date.now(), from: 'cli', handoff: null }
    : { writer: null, at: Date.now(), from: 'cli', handoff: null };
  return w.surface;
}

/**
 * A CLI that died holding the writer, recorded by whoever notices. Died BETWEEN turns (closed, killed at the
 * prompt): `cli-closed`, a pause ▶ Continue resumes. Died MID-TURN (its in-flight record is still in the file):
 * `host-crashed` — the session loads through inflight.recover and the task resumes by itself (autocontinue.js).
 */
function reapDeadCli(id) {
  const lease = persisted(id);
  if (!lease || lease.writer !== 'cli' || !lease.pid || alive(lease.pid)) return null;
  try {
    const f = fileOf(id);
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    d.workbench = d.workbench || {};
    d.workbench.surface = { writer: null, pausedBy: d.inflight ? 'host-crashed' : 'cli-closed', at: Date.now(), from: 'cli', handoff: null, pid: lease.pid };
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(d));
    fs.renameSync(`${f}.tmp`, f);
    return d.workbench.surface;
  } catch { return null; }
}

/**
 * ▶ CONTINUE, HERE: take the writer, reload the session exactly as the CLI left
 * it, and hand back a prompt that continues the same task (the caller submits it).
 */
function resumeHere(app) {
  const s = app.session;
  const disk = persisted(s.id) || (s.workbench && s.workbench.surface) || null;
  if (disk && disk.writer === 'cli' && disk.pid && alive(disk.pid)) return { ok: false, why: 'the CLI is still running this session — take it back instead, or close the CLI' };
  const t = takeBack(app);
  if (!t.ok) return t;
  const w = wb.of(app.session);
  const was = disk && disk.pausedBy;
  w.surface = { ...w.surface, pausedBy: null };
  return { ok: true, resumedFrom: was || null, reloaded: true };
}

module.exports = { check, handoff, takeBack, sync, surfaceOf, persisted, claim, release, reapDeadCli, resumeHere, unfinished, SURFACES };
