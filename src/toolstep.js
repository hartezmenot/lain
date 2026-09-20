'use strict';

/**
 * ONE TOOL CALL, FROM THE TURN'S SIDE.
 *
 * Split out of turn.js, which had reached the god-object guard. The seam is the
 * one the loop already had: turn.js decides WHICH calls run and what the model
 * is told; this runs one of them against LAIN's evidence.
 *
 *     read gate      progress.js — an unchanged read already in context, or kept
 *                    on its receipt, is not re-run; a repeated one under
 *                    unchanged state is NON_PROGRESS
 *     ledger check   evidence.js — the whole-file substitution
 *     execute        tools/index.js — the gate, and for a source write the
 *                    mutation transaction (mutation.js), which owns the checkpoint
 *     observe        the ledger, then the receipt and the state movement
 */

const toolRegistry = require('./tools');
const progress = require('./progress');

/**
 * IS THE WHOLE-FILE BODY ACTUALLY IN FRONT OF THE MODEL? (2026-09-18)
 *
 * The ledger's "unchanged since you read it — continue from what you have"
 * stub is only true if a read of that file is on the wire this request carries.
 * It was trusted on the ledger's `bodyPresent` flag alone, and two paths leave
 * that flag true after the body is gone: `/clear` (the messages are emptied,
 * the ledger is kept) and a read done in the other view's thread. Reported
 * live: a long session re-reading a large file got the stub every time, never
 * got the code, and re-read in a loop. So the stub is served only when the body
 * is verifiably present; otherwise the read runs.
 */
function bodyOnWire(session, relPath) {
  if (!session || !Array.isArray(session.messages)) return false;
  let wire = session.messages;
  try { wire = require('./sessionviews').wireMessages(session); } catch { /* terminal-only sessions */ }
  const want = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const calls = new Map();
  for (const m of wire) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.name !== 'read_file') continue;
        let args = {};
        try { args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments || tc.input || {}); } catch { args = {}; }
        if (args.offset || args.limit) continue;
        calls.set(String(tc.id), String(args.path || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase());
      }
    } else if (m && m.role === 'tool' && calls.get(String(m.tool_call_id)) === want && !m.elided && !m.isError) {
      return true;
    }
  }
  return false;
}

async function run(call, { session, evidence = null, toolCtx }) {
  // ARGUMENTS THAT DID NOT ARRIVE INTACT are reported, never run as {} (finish.js).
  if (call && call.malformed) return { result: require('./finish').malformedResult(call), substitute: null, checkpoint: null, gate: null };
  // A WHOLE READ THAT CANNOT FIT (or was elided last time) IS NARROWED, not
  // repeated — readcoverage.js. It never enters the whole-file ledger.
  const narrowed = require('./readcoverage').guard(session, call, toolCtx || {});
  if (narrowed) {
    if (evidence && typeof evidence.noteRange === 'function') evidence.noteRange(call.input.path, narrowed.meta.coverage.returned);
    return { result: narrowed, substitute: narrowed, checkpoint: null, gate: null };
  }
  const gate = progress.before(session, call.name, call.input);
  let ledger = evidence ? evidence.check(call.name, call.input) : null;
  if (ledger && !bodyOnWire(session, call.input && call.input.path)) {
    // THE LEDGER WAS WRONG ABOUT WHAT THE MODEL HOLDS: correct it, and read.
    try { evidence.elide(call.input.path); } catch { /* the read runs either way */ }
    ledger = null;
  }
  const substitute = (gate && gate.substitute) || ledger;
  let result = substitute || await toolRegistry.execute(call.name, call.input, toolCtx);
  // Flagged here, once, rather than re-derived by every caller that cares
  // whether an exit code proves anything — see evidencekind.js.
  if (result && /^run_/.test(call.name)) {
    result.searchLike = require('./tools/shell').searchLike((call.input && call.input.command) || '');
  }
  if (evidence) evidence.observe(call.name, call.input, result);
  if (!(result && result.fromEvidence)) {
    result = progress.after(session, call.name, call.input, result, gate, { toolCallId: call.id });
  }
  if (result && !substitute) finalStep(session, call, result, toolCtx);
  return { result, substitute, checkpoint: (result && result.checkpoint) || null, gate };
}

/**
 * THE FINAL-SMOKE SIDE OF A CALL (finalsmoke.js). A change is owned by the plan
 * step it was made in; a run of the final suite is flagged for the lifecycle;
 * a FAILED foreground final smoke reopens the owning step and says so on the
 * result the model reads; a PASSED one completes the smoke step.
 */
function finalStep(session, call, result, toolCtx) {
  const fsm = require('./finalsmoke');
  const plan = session && session.plan;
  const cwd = (toolCtx && toolCtx.cwd) || (session && session.cwd);
  if (Array.isArray(result.mutated) && result.mutated.length) fsm.noteMutation(plan, result.mutated);
  if (!/^run_/.test(call.name) || result.denied || !fsm.isFinal(cwd, call.name, call.input || {})) return;
  result.finalSmoke = true;
  const detached = Boolean(result.detached || (result.meta && result.meta.detached));
  result.detached = detached;
  if (detached || !plan) return;
  const smokeStep = plan.steps.find((s) => s.origin === fsm.ORIGIN && s.status !== 'dropped');
  if (!result.isError) {
    const rest = plan.steps.filter((s) => s !== smokeStep && s.status !== 'done' && s.status !== 'dropped');
    if (smokeStep && smokeStep.status !== 'done' && !rest.length) { smokeStep.status = 'done'; smokeStep.completedAt = new Date().toISOString(); smokeStep.note = 'final smoke passed'; }
  } else {
    const said = fsm.reopen(plan, result.output);
    if (said) result.output = `${String(result.output || '')}\n\n${said}`;
  }
}

/**
 * INDEPENDENT READS OF ONE STEP, STARTED TOGETHER (profile.js concurrency).
 *
 * Only pure reads, only distinct targets, at most `limit` at once; results are
 * still consumed in the model's order by the turn loop, so the transcript and
 * the tool-result order are unchanged. ECO's limit is 1: nothing is started
 * early and the flow stays serial. Returns id → promise of `run`'s answer.
 */
const PARALLEL_READS = new Set(['read_file', 'read_symbol', 'grep', 'glob', 'list_dir', 'locate', 'file_info', 'symbols', 'outline', 'dependents']);

function prefetch(calls, opts, limit) {
  const out = new Map();
  if (!(limit > 1) || !Array.isArray(calls)) return out;
  const seen = new Set();
  const eligible = [];
  // ONLY THE LEADING RUN OF READS: a read after a write in the same step must
  // see the write, so nothing past the first non-read call is started early.
  for (const c of calls) {
    if (!c || c.malformed || !PARALLEL_READS.has(c.name)) break;
    // IDENTICAL CALLS are deduplicated, nothing else: keying on `path` first made
    // four different greps of '.' one "target", so FAST started just one early.
    const target = `${c.name}:${JSON.stringify(c.input || {})}`;
    if (seen.has(target)) continue;
    seen.add(target);
    eligible.push(c);
  }
  if (eligible.length < 2) return out;
  let active = 0;
  const waiting = [];
  const slot = () => (active < limit ? (active += 1, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const free = () => { const next = waiting.shift(); if (next) next(); else active -= 1; };
  for (const c of eligible) {
    out.set(c.id, slot().then(() => run(c, opts)).finally(free));
  }
  return out;
}

module.exports = { run, bodyOnWire, prefetch, PARALLEL_READS };
