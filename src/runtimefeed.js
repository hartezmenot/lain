'use strict';

/** THE ONE PLACE A CLIENT READS RUNTIME TRUTH FROM. */

/** WHAT EACH SESSION IS DOING, from the stores that own it (2026-10-02): the session lease (who runs it, alive or not) and the session journal */
function sessionRows({ limit = 50 } = {}) {
  const fs = require('fs');
  const path = require('path');
  const lease = require('./sessionlease');
  const journal = require('./sessionjournal');
  const rows = [];
  for (const id of lease.ids()) {
    const r = lease.read(id);
    if (!r) continue;
    const live = Boolean(r.owner && lease.ownerAlive(r));
    const j = journal.state(id);
    const last = journal.read(id, { limit: 60 }).filter((e) => e.type === 'turn.begin' || e.type === 'turn.end');
    const begin = [...last].reverse().find((e) => e.type === 'turn.begin');
    const end = [...last].reverse().find((e) => e.type === 'turn.end');
    const failed = end && end.outcome && !['completed', 'aborted', 'cancelled'].includes(end.outcome);
    const lost = j.running && !live;
    rows.push({
      session: id,
      state: j.running ? (live ? 'RUNNING' : 'LOST') : (end ? String(end.outcome || 'completed').toUpperCase() : 'IDLE'),
      effective_state: lost ? 'LOST' : (j.running ? 'RUNNING' : 'IDLE'),
      owner_pid: live ? r.owner.pid : 0,
      surface: live ? r.owner.surface : null,
      model: (begin && begin.model) || '',
      needs_handover: Boolean(failed || lost),
      handover_reason: lost ? 'TURN_LOST: the process running the last turn is gone' : failed ? `${String(end.outcome).toUpperCase()}: ${end.reason || 'the previous turn did not finish'}` : '',
      held_count: 0,
      usage: end && end.usage ? { input_tokens: end.usage.input, output_tokens: end.usage.output } : null,
      at: Math.max(r.at || 0, r.beat || 0, (end && end.at) || 0),
    });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, limit);
}

/** How many events one poll will carry. A batch, not a backlog dump. */
const MAX_EVENTS = 200;

/** WHICH EVENTS ARE WORTH WAKING SOMEBODY FOR. */
const NOTABLE = new Set([
  'JOB_COMPLETED',
  'JOB_ERROR',
  'JOB_DEADLINE_REACHED',
  'TURN_INTERRUPTED',
  'INPUT_HELD',
  'HANDOVER_CREATED',
  'MODEL_SWITCHED',
  'PROVIDER_RECOVERED',
  'RATE_LIMITED',
]);

/** ONE LINE A PERSON CAN READ, from one event. */
function headline(e) {
  if (!e || !e.kind) return '';
  const job = e.job_id ? ` ${e.job_id}` : '';
  switch (e.kind) {
    case 'JOB_COMPLETED':
      return `job${job} finished${e.exit_code === 0 ? '' : ` — exit ${e.exit_code}`}`;
    case 'JOB_ERROR':
      return `job${job} failed — exit ${e.exit_code === undefined ? 'unknown' : e.exit_code}`;
    case 'JOB_DEADLINE_REACHED':
      // THE DEADLINE IS NOT THE OUTCOME.
      return `job${job} reached its deadline — it may still be running; the log is on disk`;
    case 'TURN_INTERRUPTED':
      return `a turn did not finish${e.reason ? ` — ${e.reason}` : ''}`;
    case 'INPUT_HELD':
      return `LAIN is holding what you typed${e.reason ? ` — ${e.reason}` : ''}`;
    case 'HANDOVER_CREATED':
      return `a handover is needed${e.reason ? ` — ${e.reason}` : ''}`;
    case 'MODEL_SWITCHED':
      return `the model changed${e.from && e.to ? ` — ${e.from} to ${e.to}` : ''}`;
    case 'RATE_LIMITED':
      return `a route is rate limited${e.reason ? ` — ${e.reason}` : ''}`;
    case 'PROVIDER_RECOVERED':
      return 'a rate limit has lifted';
    default:
      return e.kind.toLowerCase().replace(/_/g, ' ');
  }
}

/** WHAT HAS HAPPENED SINCE `seq`. */
async function since(seq = 0, { limit = MAX_EVENTS } = {}) {
  const cursor = normalise(seq);
  // NO DURABLE JOBS (S7): background jobs live in the process and end with it; activity is in each session's journal.
  const runtime = [];
  const jobs = [];
  const rows = [];
  for (const e of runtime) rows.push({ ...e, stream: 'runtime' });
  for (const e of jobs) rows.push({ ...e, stream: 'jobs' });
  // BY TIME, THEN BY STREAM, so a merge is stable.
  rows.sort((a, b) => (a.at || 0) - (b.at || 0) || String(a.stream).localeCompare(String(b.stream)));
  const next = {
    runtime: runtime.reduce((m, e) => Math.max(m, e.seq || 0), cursor.runtime),
    jobs: jobs.reduce((m, e) => Math.max(m, e.seq || 0), cursor.jobs),
  };
  return {
    events: rows.slice(0, limit),
    seq: next,
    available: false,   // no durable job stream (S7)
    notable: rows.filter((e) => NOTABLE.has(e.kind)),
  };
}

/** A cursor a client handed back, in whatever shape it kept it. */
function normalise(seq) {
  if (typeof seq === 'number') return { runtime: Math.max(0, seq), jobs: Math.max(0, seq) };
  const s = seq || {};
  return {
    runtime: Math.max(0, Math.floor(Number(s.runtime) || 0)),
    jobs: Math.max(0, Math.floor(Number(s.jobs) || 0)),
  };
}

/** EVERYTHING THIS MACHINE'S RUNTIME CURRENTLY KNOWS. */
async function state() {
  const sessions = sessionRows();
  let providers = [];
  try { providers = require('./routehealth').list(); } catch { providers = []; }
  return { available: true, sessions, jobs: [], providers };
}

/** IS ANYTHING WAITING FOR A PERSON? */
function needsAttention(state) {
  const rows = (state && state.sessions) || [];
  return rows.filter((s) => s && (s.needs_handover || s.held_count > 0 || s.effective_state === 'LOST'));
}

module.exports = { since, state, sessionRows, headline, needsAttention, normalise, NOTABLE, MAX_EVENTS };
