'use strict';

/** A TURN IN FLIGHT IS DURABLE — force-closing LAIN no longer loses it. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Reads are re-runnable; their saves are throttled to this. */
const THROTTLE_MS = 1500;
const LEDGER_MAX = 60;

const COMMAND = /^(run_bash|run_powershell|run_cmd|python_run|process_run|run_background|job_stop|observe_start|service_start|download_file|delegate|ab_compare|migration_activate|request_browser|request_computer|computer)$/;
const CHECK = /^(run_tests|verify_task)$/;

/** What kind of effect a call has, for saving and for recovery. */
function kindOf(name, input = {}) {
  const tools = require('./tools');
  if (CHECK.test(name)) return 'CHECK';
  if (COMMAND.test(name)) return 'COMMAND';
  let mut = false;
  try { mut = tools.isMutating(name); } catch { mut = false; }
  if (mut && input && (input.path || input.from || input.file)) return 'FILE';
  if (mut) return 'COMMAND';
  return 'READ';
}

function hashOf(abs) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'); } catch (e) { return e && e.code === 'ENOENT' ? 'absent' : 'unreadable'; }
}

/** The files a FILE call can touch, absolute. */
function targets(session, input = {}) {
  const out = [];
  for (const k of ['path', 'from', 'to', 'file']) {
    if (input && typeof input[k] === 'string' && input[k]) out.push(path.resolve(session.cwd || process.cwd(), input[k]));
  }
  return [...new Set(out)];
}

function persist(session, { force = false } = {}) {
  if (!session || typeof session.save !== 'function') return false;
  // A BOUNDED WORKER'S session is disposable (its cwd is a workspace that is
  // removed at harvest); the parent's `delegate` call is what is durable.
  if (session.workOrder && session.workOrder.bounded) return false;
  const now = Date.now();
  if (!force && session._inflightSavedAt && now - session._inflightSavedAt < THROTTLE_MS) return false;
  try {
    session.save();
    Object.defineProperty(session, '_inflightSavedAt', { value: now, writable: true, configurable: true, enumerable: false });
    return true;
  } catch { return false; }
}

function begin(session, record, { from = null } = {}) {
  if (!session) return null;
  session.inflight = {
    turnId: record.turnId, pid: process.pid, from,
    userInput: String(record.userInput || '').slice(0, 4000),
    startedAt: record.startedAt || new Date().toISOString(), step: 0, tool: null, ledger: [],
  };
  persist(session, { force: true });
  return session.inflight;
}

function step(session, n) {
  if (!session || !session.inflight) return;
  session.inflight.step = n;
  session.inflight.touchedAt = Date.now();   // how recently the turn was alive — recovery resumes only a fresh crash
  persist(session);
}

/** BEFORE a call runs. A FILE call records each target's hash first, so a crash mid-write can be told apart from a crash before it; anything with an… */
function beforeTool(session, call, target = '') {
  const f = session && session.inflight;
  if (!f) return null;
  const kind = kindOf(call.name, call.input);
  const pre = kind === 'FILE' ? Object.fromEntries(targets(session, call.input).map((t) => [t, hashOf(t)])) : null;
  f.tool = { id: call.id, name: call.name, target: String(target || '').slice(0, 200), kind, state: 'STARTED', at: Date.now(), pre };
  f.touchedAt = Date.now();
  persist(session, { force: kind !== 'READ' });
  return f.tool;
}

function afterTool(session, call, result = {}) {
  const f = session && session.inflight;
  if (!f) return null;
  const t = f.tool && f.tool.id === call.id ? f.tool : { id: call.id, name: call.name, kind: kindOf(call.name, call.input) };
  const done = { id: t.id, name: t.name, target: t.target || '', kind: t.kind, state: result.isError ? 'FAILED' : 'COMPLETED' };
  f.ledger.push(done);
  if (f.ledger.length > LEDGER_MAX) f.ledger.splice(0, f.ledger.length - LEDGER_MAX);
  f.tool = null;
  f.touchedAt = Date.now();
  persist(session, { force: done.kind !== 'READ' || Boolean(result.mutated && result.mutated.length) });
  return done;
}

/** The turn ended by any route that reaches turnclose. */
function end(session) {
  if (session && session.inflight) session.inflight = null;
}

function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); }
}

/** The one sentence a lost call's result says, by inspecting reality. */
function classify(session, t) {
  if (!t) return { state: 'NOT_STARTED', text: 'LAIN was closed before this call started. It did not run.' };
  if (t.kind === 'FILE' && t.pre) {
    const changed = Object.entries(t.pre).filter(([abs, h]) => hashOf(abs) !== h).map(([abs]) => path.relative(session.cwd || '', abs) || abs);
    if (changed.length) return { state: 'COMPLETED', text: `LAIN was force-closed while this call ran. Inspected after restart: ${changed.join(', ')} CHANGED — the write landed. Re-read the file before editing it again.` };
    return { state: 'NOT_APPLIED', text: 'LAIN was force-closed while this call ran. Inspected after restart: the target is UNCHANGED — the write did not land. Safe to redo it.' };
  }
  if (t.kind === 'COMMAND') return { state: 'UNKNOWN', text: 'LAIN was force-closed while this command ran. It may have run partly or fully; its output was lost. It was NOT re-run — check its effect before running it again.' };
  if (t.kind === 'CHECK') return { state: 'UNKNOWN', text: 'LAIN was force-closed while this check ran; no result was recorded. Re-run it if the result is still needed.' };
  return { state: 'NOT_COMPLETED', text: 'LAIN was force-closed before this read returned. Nothing changed; repeat it if still needed.' };
}

/** AFTER A CRASH — called when a session is loaded. */
function recover(session) {
  const f = session && session.inflight;
  if (!f) return null;
  if (pidAlive(f.pid)) return { live: true, pid: f.pid };
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  // The newest assistant message with calls, and which of them have no result.
  let at = -1;
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i] && msgs[i].role === 'assistant' && Array.isArray(msgs[i].tool_calls) && msgs[i].tool_calls.length) { at = i; break; } }
  const answered = new Set(msgs.slice(at + 1).filter((m) => m && m.role === 'tool').map((m) => m.tool_call_id));
  const lost = at >= 0 ? msgs[at].tool_calls.filter((c) => !answered.has(c.id)) : [];
  const verdicts = [];
  for (const c of lost) {
    const v = classify(session, f.tool && f.tool.id === c.id ? f.tool : null);
    msgs.push({ role: 'tool', tool_call_id: c.id, content: `[RECOVERED · ${v.state}] ${v.text}`, isError: v.state !== 'COMPLETED', ts: new Date().toISOString(), _recovered: true });
    verdicts.push({ id: c.id, name: c.name, state: v.state });
  }
  // THE TURN IS KEPT, as a record that ended because LAIN died — drawn in the
  // transcript like any other, with what it did.
  const record = require('./turnrecord').newRecord(session.id, f.userInput, null);
  record.turnId = f.turnId || record.turnId;
  record.startedAt = f.startedAt || record.startedAt;
  record.from = f.from || null;
  record.steps = f.step + 1;
  record.actions = f.ledger.map((l) => ({ name: l.name, target: l.target, ok: l.state === 'COMPLETED' }));
  record.toolCalls = f.ledger.length;
  record.stopReason = 'crashed';
  record.recovered = { at: new Date().toISOString(), lost: verdicts };
  session.turns = Array.isArray(session.turns) ? session.turns : [];
  if (!session.turns.some((t) => t && t.turnId === record.turnId)) session.turns.push(record);
  const inTool = f.tool ? `${f.tool.name.replace(/_/g, ' ')}${f.tool.target ? ' ' + f.tool.target : ''}` : '';
  const lostState = f.tool ? (verdicts.find((v) => v.id === f.tool.id) || {}).state || 'UNKNOWN' : '';
  // ONE ROW, the actionable part first — it is drawn as an operation note and clipped at the terminal's width (seen in a real ConPTY, 2026-09-23).
  const summary = {
    turnId: record.turnId, step: f.step + 1, calls: f.ledger.length, lost: verdicts,
    during: inTool, userInput: f.userInput, from: f.from || null,
    lastActiveAt: f.touchedAt || Date.parse(f.startedAt || '') || null,
    line: `RECOVERED · cut off at step ${f.step + 1}`
      + (f.tool ? ` · ${f.tool.name} ${lostState === 'UNKNOWN' ? 'UNKNOWN, not re-run' : lostState}` : ''),
  };
  session.inflight = null;
  session.recovered = summary;
  return summary;
}

// BACKGROUND JOBS THAT OUTLIVE THEIR LAIN

const JOBS_MAX = 20;

function noteJob(session, job, command) {
  if (!session || !job) return null;
  const list = session.bgJobs = Array.isArray(session.bgJobs) ? session.bgJobs : [];
  const rec = {
    id: job.id, pid: (job.child && job.child.pid) || null, owner: process.pid,
    command: String(command || job.command || '').slice(0, 200), cwd: job.cwd || session.cwd,
    turnId: (session.inflight && session.inflight.turnId) || null, startedAt: new Date().toISOString(), state: 'RUNNING',
  };
  list.push(rec);
  if (list.length > JOBS_MAX) list.splice(0, list.length - JOBS_MAX);
  persist(session, { force: true });
  return rec;
}

function jobEnded(session, job, settled = {}) {
  const list = session && Array.isArray(session.bgJobs) ? session.bgJobs : [];
  const rec = list.find((j) => j.id === job.id && j.owner === process.pid && j.state === 'RUNNING');
  if (!rec) return null;
  rec.state = settled.state || 'DONE';
  rec.exitCode = settled.exitCode == null ? null : settled.exitCode;
  rec.endedAt = new Date().toISOString();
  persist(session);
  return rec;
}

/** On load: RUNNING jobs whose LAIN died are ORPHANED or LOST. Returns the changed ones. */
function recoverJobs(session) {
  const list = session && Array.isArray(session.bgJobs) ? session.bgJobs : [];
  const out = [];
  for (const j of list) {
    if (j.state !== 'RUNNING' || j.owner === process.pid || pidAlive(j.owner)) continue;
    j.state = pidAlive(j.pid) ? 'ORPHANED' : 'LOST';
    out.push(j);
  }
  return out;
}

/** The handover rows for jobs the previous LAIN left behind. */
function jobRows(session) {
  const list = session && Array.isArray(session.bgJobs) ? session.bgJobs : [];
  return list.filter((j) => j.state === 'ORPHANED' || j.state === 'LOST').map((j) => (j.state === 'ORPHANED'
    ? `- ${j.command} — STILL RUNNING as pid ${j.pid} from the closed LAIN (not adopted; output not captured). Do not start it again; stop it or reuse what it serves.`
    : `- ${j.command} — ended while LAIN was closed; its result was not captured. Re-run it only if the result is needed.`));
}

module.exports = {
  THROTTLE_MS, kindOf, begin, step, beforeTool, afterTool, end, recover, classify, pidAlive, persist,
  noteJob, jobEnded, recoverJobs, jobRows,
};
