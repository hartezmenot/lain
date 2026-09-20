'use strict';

/**
 * THE TRANSIENT ACTIVITY BOX (§5–6).
 *
 *     ┌ ACTIVITY ────────────────────────────────┐
 *     │ READING · src/auth · 5 files             │
 *     └──────────────────────────────────────────┘
 *
 * WHAT IT SAYS is derived ONLY from runtime state — the loop's phase, the tool
 * in flight, the targets this turn touched. It never shows the model's
 * reasoning, hidden or otherwise: a summary built from facts cannot leak a
 * chain of thought because it never reads one.
 *
 *   READING   LOCATING   THINKING   WRITING   EXECUTING   TESTING
 *   VERIFYING   WAITING   BACKGROUND   BLOCKED
 *
 * WHEN IT IS THERE: only while a turn is working and there is something worth
 * a line; it closes the instant the turn ends (no minimum lifetime, nothing
 * waits on it) and it never enters the transcript. Ctrl+O expands it to the
 * last few operations and collapses it again.
 */

const T = require('./text');
const { P } = require('./paint');

const READ = new Set(['read_file', 'read_symbol', 'list_dir', 'file_info', 'grep', 'glob', 'web_fetch', 'check_symbols']);
const LOCATE = new Set(['locate', 'symbols', 'dependents', 'understand', 'engineering_brief', 'concept', 'architecture', 'wiring', 'find_residue']);
const WRITE = new Set(['write_file', 'edit_file', 'apply_patch', 'append_file', 'insert_at', 'delete_range', 'move_file', 'delete_file',
  'replace_symbol', 'insert_near_symbol', 'remove_symbol', 'rename_symbol', 'download_file']);
const TEST = new Set(['run_tests', 'discover_tests']);
const VERIFY = new Set(['verify_task', 'review_changes', 'migration_verify', 'observe', 'observe_stop', 'service_check', 'request_browser', 'request_computer']);
const WAITS = new Set(['job_wait', 'ask_user']);
const DETAIL_MAX = 4;

function kindOf(name, command = '') {
  if (READ.has(name)) return 'READING';
  if (LOCATE.has(name)) return 'LOCATING';
  if (WRITE.has(name)) return 'WRITING';
  if (TEST.has(name)) return 'TESTING';
  if (VERIFY.has(name)) return 'VERIFYING';
  if (WAITS.has(name)) return 'WAITING';
  if (name === 'delegate' || name === 'ab_compare') return 'BACKGROUND';
  if (/^run_|^process_run$|^python_run$/.test(name)) return /\b(test|jest|pytest|vitest|mocha|cargo test|go test|npm (run )?test)\b/i.test(command) ? 'TESTING' : 'EXECUTING';
  return 'EXECUTING';
}

/** The directory most of these targets share, for "READING · src/auth". */
function commonDir(targets) {
  const dirs = targets.map((t) => String(t || '').replace(/\\/g, '/').split('/').slice(0, -1)).filter((d) => d.length);
  if (!dirs.length) return '';
  let prefix = dirs[0];
  for (const d of dirs.slice(1)) { let i = 0; while (i < prefix.length && prefix[i] === d[i]) i += 1; prefix = prefix.slice(0, i); }
  return prefix.join('/');
}

/**
 * The box's content for this frame, or null when it should not be open.
 * @returns {{kind:string, line:string, detail:string[]}|null}
 */
/** RUNNING SUBAGENTS, from the job registry — never counted from narration. */
function agentsOf(state) {
  return (Array.isArray(state && state.jobs) ? state.jobs : []).filter((j) => j && j.kind === 'subagent' && j.state === 'RUNNING');
}

/** 'AGENTS 2 · SCOUT · VERIFIER' — the one line workers get; empty when none run. */
function agentsLine(state) {
  const a = agentsOf(state);
  if (!a.length) return '';
  return `AGENTS ${a.length} · ${a.map((j) => String(j.request || '').split(' · ')[0]).join(' · ')}`;
}

function summary(state, now = Date.now()) {
  const s = summaryOf(state, now);
  if (s) s.agents = agentsLine(state);
  return s;
}

function summaryOf(state, now = Date.now()) {
  if (!state || !state.busy) return null;
  const phase = state.phase || null;
  const recent = Array.isArray(state.recent) ? state.recent : [];
  const detail = recent.slice(-DETAIL_MAX).map((a) => `${a.ok === false ? '✗' : '✓'} ${a.name.replace(/_/g, ' ')} ${a.target || ''}`.trim());
  if (phase && phase.phase === 'RETRYING') {
    const secs = phase.resumeAt ? Math.max(0, Math.ceil((phase.resumeAt - now) / 1000)) : null;
    return { kind: 'WAITING', line: `${phase.rateLimited ? 'rate limited' : 'provider'}${secs != null ? ` · retry in ${secs}s` : ''}`, detail };
  }
  if (phase && phase.phase === 'RUNNING_TOOL') {
    const name = String(phase.tool || '');
    const kind = kindOf(name, phase.target || '');
    const fileLike = (t) => /^[^/\s][^\s]*\.[A-Za-z0-9]+$/.test(String(t || ''));
    const same = recent.filter((a) => kindOf(a.name, a.target) === kind).map((a) => a.target).filter(fileLike);
    const targets = [...new Set([...same, phase.target].filter(fileLike))];
    const where = commonDir(targets);
    const subject = targets.length > 1
      ? `${where || 'project'} · ${targets.length} ${kind === 'READING' || kind === 'WRITING' ? 'files' : 'targets'}`
      : String(phase.target || name.replace(/_/g, ' '));
    return { kind, line: subject, detail };
  }
  const waited = state.phaseSince ? now - state.phaseSince : 0;
  if (phase && phase.phase === 'WAITING_MODEL') {
    if (!recent.length && waited < 1500) return null;       // nothing worth a box yet
    return { kind: 'THINKING', line: recent.length ? `after ${recent.length} step${recent.length === 1 ? '' : 's'}` : 'working out the first step', detail };
  }
  if (phase && phase.phase === 'RECEIVING') return recent.length ? { kind: 'WRITING', line: 'the answer', detail } : null;
  return null;
}

/**
 * THE RECTANGLE IS FOR THINKING; EVERYTHING ELSE IS ONE LINE.
 *
 * While the model is working out what to do, nothing else on screen says so,
 * and the box earns its rows:
 *
 *     ░ THINKING                          ░
 *     ░ after 3 steps                     ░
 *
 * The moment something else is PRIMARY — a tool acting, a diff arriving in the
 * feed, a check running — the box MINIMIZES to `READING · src/a.js`: the work
 * is still visibly alive and the rows go to the thing that is happening.
 * Ctrl+O still expands it to the last few operations, whatever the phase.
 */
function rows(state, room = 99, now = Date.now(), { minimal = false } = {}) {
  const s = summary(state, now);
  if (!s || room < 1) return 0;
  const expanded = Boolean(state.activityExpanded);
  if (!expanded && (minimal || s.kind !== 'THINKING')) return 1;
  if (room < 2) return 1;
  const want = 2 + (s.agents ? 1 : 0) + (expanded ? s.detail.length : 0);
  return Math.min(want, room);
}

const TONE = { BLOCKED: 'bad', WAITING: 'warn', TESTING: 'info', VERIFYING: 'info' };

function draw(state, width = 80, height = 0, now = Date.now()) {
  if (height <= 0) return [];
  const s = summary(state, now);
  if (!s) return new Array(height).fill(T.fit('', width));
  const paint = P[TONE[s.kind] || 'plain'] || P.plain;
  if (height < 2) {
    const one = T.fit(' ' + paint(T.clip(`${s.kind} · ${s.line}${s.agents ? '  ·  ' + s.agents : ''}`, Math.max(10, width - 2))), width);
    return [one];
  }
  // ONE DARK-GREY GROUND, no border — the same quiet surface the composer and
  // the diff sit on, so the three read as one visual language.
  const box = Math.max(12, Math.min(width, 72));
  const ground = (text) => P.surface(' ' + T.fit(T.clip(text, box - 2), box - 2) + ' ');
  const body = [paint(s.kind), s.line, ...(s.agents ? [s.agents] : []), ...(state.activityExpanded ? s.detail : [])];
  const out = body.slice(0, height).map((t, i) => ground(i === 0 ? t : (i === 1 ? t : P.meta(t))));
  while (out.length < height) out.push('');
  return out.map((l) => T.fit(l, width));
}

module.exports = { summary, rows, draw, kindOf, commonDir, agentsOf, agentsLine };
