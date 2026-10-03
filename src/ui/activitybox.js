'use strict';

/** THE TRANSIENT ACTIVITY BOX (§5–6). */

const T = require('./text');
const { P } = require('./paint');

const READ = new Set(['read_file', 'read_symbol', 'list_dir', 'file_info', 'grep', 'glob', 'web_fetch', 'check_symbols']);
const LOCATE = new Set(['locate', 'symbols', 'dependents', 'understand', 'engineering_brief', 'concept', 'architecture', 'wiring', 'find_residue']);
const WRITE = new Set(['write_file', 'edit_file', 'apply_patch', 'integrate_candidate', 'append_file', 'insert_at', 'delete_range', 'move_file', 'delete_file',
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

/** The box's content for this frame, or null when it should not be open. */
/** RUNNING SUBAGENTS, from the job registry — never counted from narration. */
function agentsOf(state) {
  return (Array.isArray(state && state.jobs) ? state.jobs : []).filter((j) => j && j.kind === 'subagent' && j.state === 'RUNNING');
}

/** One row per running agent (S6): `◐ explore · auth owner · 8s · ↓~1.2k`. */
function agentRows(state, now = Date.now()) {
  const spin = ['◐', '◓', '◑', '◒'][Math.floor(now / 250) % 4];
  return agentsOf(state).map((j) => {
    const [type, ...rest] = String(j.request || '').split(' · ');
    const secs = require('./thoughtrow').dur(j.startedAt ? now - j.startedAt : j.elapsedMs || 0);
    const tok = j.chars ? ` · ↓~${require('./activityline').tok(Math.ceil(j.chars / 4))}` : '';
    return `${spin} ${j.agentType || type} · ${j.agentLabel || rest.join(' · ')} · ${secs}${tok}`;
  });
}
const agentsLine = (state) => agentRows(state).join('\n');

function summary(state, now = Date.now()) {
  const rows = agentRows(state, now);
  const s = summaryOf(state, now) || (rows.length ? { kind: 'AGENTS', line: '', detail: [] } : null);
  if (s) s.agents = rows;
  return s;
}

function summaryOf(state, now = Date.now()) {
  if (!state || !state.busy) return null;
  const phase = state.phase || null;
  const recent = Array.isArray(state.recent) ? state.recent : [];
  const detail = recent.slice(-DETAIL_MAX).map((a) => `${a.ok === false ? '✗' : '✓'} ${a.name.replace(/_/g, ' ')} ${a.target || ''}`.trim());
  if (phase && phase.phase === 'RETRYING') {
    const secs = phase.resumeAt ? Math.max(0, Math.ceil((phase.resumeAt - now) / 1000)) : null;
    return { kind: phase.rateLimited ? 'RATE LIMITED' : 'WAITING', line: `${phase.rateLimited ? 'provider limit' : 'provider'}${secs != null ? ` · retry in ${secs}s` : ''}`, detail };
  }
  // A REQUEST IS OPEN: say what the WIRE says (streamprogress.js) WAITING (no data yet) · THINKING (reasoning arriving) · STREAMING (the answer) ·…
  if (phase && (phase.phase === 'WAITING_MODEL' || phase.phase === 'RECEIVING') && phase.live) {
    const progress = require('../streamprogress');
    const st = progress.state(phase.live, now);
    if (st.word === 'WAITING' && !recent.length && now - phase.live.startedAt < 1500) return null;   // nothing worth a box yet
    // THE THINKING BOX (S5.1): while reasoning streams visibly, its last lines — display only, gone at the first text or call.
    const thought = st.word === 'THINKING' ? progress.thoughtLines(phase.live, THOUGHT_WIDTH, THOUGHT_ROWS) : [];
    return { kind: st.word, line: st.detail, clock: st.elapsed, commentary: thought.length ? '' : progress.commentaryLine(phase.live), thought, detail, model: true };
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
    return { model: true, kind: 'THINKING', line: recent.length ? `after ${recent.length} step${recent.length === 1 ? '' : 's'}` : 'working out the first step', detail };
  }
  if (phase && phase.phase === 'RECEIVING') return recent.length ? { kind: 'WRITING', line: 'the answer', detail } : null;
  return null;
}

/** THE RECTANGLE IS FOR THE MODEL; EVERYTHING ELSE IS ONE LINE. */
const COMMENTARY_ROWS = 2;
const THOUGHT_ROWS = 4;
const THOUGHT_WIDTH = 68;

/** ONLY WHAT THE LIVE ROW CANNOT SAY (2026-10-01). */
function rows(state, room = 99, now = Date.now(), { minimal = false } = {}) {
  const s = summary(state, now);
  if (!s || room < 1) return 0;
  const expanded = Boolean(state.activityExpanded);
  const want = (s.commentary && !minimal ? COMMENTARY_ROWS : 0) + (s.thought && s.thought.length && !minimal ? s.thought.length : 0) + (s.agents ? s.agents.length : 0) + (expanded ? s.detail.length : 0);
  return Math.min(want, room);
}

const TONE = { BLOCKED: 'bad', STALLED: 'warn', 'RATE LIMITED': 'warn', WAITING: 'warn', TESTING: 'cmd', VERIFYING: 'cmd' };

/** Word-wrap the commentary into at most `n` rows of `w` cells (ellipsis on the last). */
function wrapCommentary(text, w, n) {
  const words = String(text || '').split(' ');
  const out = [];
  let cur = '';
  for (const word of words) {
    if (!cur) cur = word;
    else if (T.width(cur + ' ' + word) <= w) cur += ' ' + word;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  if (out.length <= n) return out;
  const kept = out.slice(out.length - n);   // the NEWEST words — what it is saying now
  kept[0] = '…' + kept[0];
  return kept;
}

function draw(state, width = 80, height = 0, now = Date.now()) {
  if (height <= 0) return [];
  const s = summary(state, now);
  if (!s) return new Array(height).fill(T.fit('', width));
  // An open request that has not answered yet is not a warning — only STALLED is.
  const paint = P[TONE[s.kind] && !(s.model && s.kind === 'WAITING') ? TONE[s.kind] : s.model ? 'violet' : 'cmd'] || P.plain;
  if (height < 2) {
    const only = (s.agents && s.agents[0]) || (s.commentary ? require('../streamprogress').commentaryLine({ commentary: s.commentary }) : '') || '';
    return [T.fit(' ' + P.meta(T.clip(only, Math.max(10, width - 2))), width)];
  }
  // ONE DARK-GREY GROUND, no border — the same quiet surface the composer and
  // the diff sit on, so the three read as one visual language.
  const box = Math.max(12, Math.min(width, 72));
  const ground = (text) => P.surface(' ' + T.fit(T.clip(text, box - 2), box - 2) + ' ');
  // THE MODEL'S OWN WORDS, from the paragraph it is writing now — never its
  // reasoning. Temporary: they leave with the box and never enter the feed.
  const said = s.commentary ? wrapCommentary(s.commentary, box - 2, COMMENTARY_ROWS) : [];
  void paint;
  const thinking = (s.thought || []).map((t) => P.meta(T.clip(t, box - 2)));
  const body = [...thinking, ...said.map((t) => P.meta(t)), ...(s.agents || []).map((a) => P.meta(a)), ...(state.activityExpanded ? s.detail.map((t) => P.meta(t)) : [])];
  const out = body.slice(0, height).map((t) => ground(t));
  while (out.length < height) out.push('');
  return out.map((l) => T.fit(l, width));
}

module.exports = { summary, rows, draw, kindOf, commonDir, agentsOf, agentsLine };
