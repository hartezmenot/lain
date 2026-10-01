'use strict';

/**
 * EVERY PROVIDER REQUEST, WITH AN ID AND A REASON.
 *
 * ------------------------------------------------------------------------
 * THE QUESTION THIS EXISTS TO ANSWER.
 *
 * "Why were seven provider requests made for this one turn?" was unanswerable.
 * `record.usage.requests` counted them, which tells you THAT it happened and
 * nothing about WHY — and a count with no attribution is exactly the shape of
 * evidence that invites the wrong fix: a longer retry delay, which hides a
 * duplicate trigger instead of finding it.
 *
 * So every request that actually reaches the wire is recorded with:
 *
 *   an ID          `r14`, unique within the process
 *   a TURN         the turn record it belongs to, or `-` for machinery
 *   a STEP         which model step inside that turn
 *   a REASON       one of a closed set — the CALLER says why it is asking
 *   an OUTCOME     ok / the failure kind, the status, and the latency
 *
 * A run can then be read back and every request accounted for. Seven requests
 * for one turn is fine if it is seven model steps of a tool loop; it is a
 * defect if it is the same step four times.
 *
 * ------------------------------------------------------------------------
 * IT MEASURES, IT DOES NOT DECIDE.
 *
 * Nothing here retries, blocks, throttles or changes a request. It is a ledger.
 * It is also the ONLY source of real provider latency in the program, which is
 * why the status strip reads it rather than timing anything of its own — a
 * second stopwatch is a second answer waiting to disagree.
 *
 * BOUNDED, like every other feed: a long session cannot grow it without limit.
 */

/** How many requests are remembered. Older ones fall off the front. */
const MAX = 400;

/**
 * WHY a request was made. A CLOSED SET, because the value of this ledger is
 * that an unexplained request is visible as one — an open-ended string would
 * let a new call site invent its own word and never be noticed.
 */
const REASON = Object.freeze({
  /** A step of the agent loop: the model was asked what to do next. */
  STEP: 'model-step',
  /** The same step, re-sent after the conversation was folded to fit. */
  REFIT: 'refit-after-fold',
  /**
   * The same step, sent again because the transport failed.
   *
   * NAMED SEPARATELY, and it is the distinction that makes this ledger worth
   * having. A step retried five times against a flaky gateway is SIX requests
   * for one step — which is a legitimate six and is also exactly what an
   * accidental duplicate trigger looks like in a bare count. Told apart, a run
   * that spent its quota on retries says so in one word instead of hiding
   * inside a total nobody can decompose.
   */
  RETRY: 'transport-retry',
  /** A second model reviewing this session's work. */
  EXTERNAL: 'external-review',
  /** Machinery: catalog discovery, a connection check, a diagnosis. */
  MACHINERY: 'machinery',
});

const ledger = [];
let seq = 0;

/**
 * THIS PROCESS, in every id: `r14.k3f9a2` — so a request recorded by the
 * Harness and one recorded by a CLI on the same session never share an id,
 * and either can be named from the other (see `forSession`).
 */
const PROC = `${process.pid.toString(36)}${require('crypto').randomBytes(2).toString('hex')}`;

/**
 * The trace context for one step of the agent loop.
 *
 * `refit` is the case worth telling apart: a step whose request was refused for
 * length, folded, and sent again. Counted as a plain step it reads as the model
 * having asked twice for one step — which is exactly the shape of the defect
 * this ledger exists to find, so the one legitimate instance of it must not
 * look like the bug.
 *
 * It lives here rather than at the call site because turn.js is at the
 * god-object guard and because this is a question about the LEDGER's
 * vocabulary, not about the turn loop.
 */
function forStep(turnId, step, { refit = false } = {}) {
  require('./perfmark').mark('request');   // the request is about to leave (perfmark.js)
  if (refit) return { turn: turnId, step, reason: REASON.REFIT };
  // A RETRY IS DERIVED, NOT DECLARED. turn.js's retry counter is turn-wide and
  // never resets, so asking it "is this a retry" answers yes for every step
  // after the first failure anywhere in the turn. The LEDGER knows exactly:
  // if the request immediately before this one was the same turn and the same
  // step, then this is another attempt at it. The step number is stable across
  // a retry by construction (`step -= 1; continue;`), which is what makes the
  // question answerable here at all.
  const prev = ledger[ledger.length - 1];
  const again = prev && prev.turn === turnId && prev.step === step;
  return { turn: turnId, step, reason: again ? REASON.RETRY : REASON.STEP };
}

/**
 * A request is going out. Returns the record — hold it and pass it to `end`.
 *
 * `turn` and `step` are whatever the caller genuinely knows. Machinery has no
 * turn, and says so with `null` rather than being given a plausible one.
 */
function begin({ turn = null, step = null, reason = REASON.MACHINERY, model = '', connection = '' } = {}) {
  seq += 1;
  const r = {
    id: `r${seq}.${PROC}`,
    turn: turn || null,
    step: Number.isFinite(step) ? step : null,
    reason: String(reason || REASON.MACHINERY),
    model: String(model || ''),
    connection: String(connection || ''),
    at: Date.now(),
    ms: 0,
    ok: null,          // null while in flight
    status: 0,
    failure: '',
  };
  ledger.push(r);
  while (ledger.length > MAX) ledger.shift();
  return r;
}

/**
 * The request finished, one way or the other.
 *
 * Tolerates a missing record so no call site has to guard: a tracer that can
 * throw is a tracer that can end a turn, which is the one thing a measurement
 * must never do.
 *
 * `receipt`, when the caller has one, is that attempt's own usage event — the
 * last `usage` the provider streamed. It rides the record (and the sink below)
 * because per-request receipts exist nowhere else that survives the process:
 * turn.js accumulates them into one total, and the difference between "ten
 * requests of 1k" and "one request of 10k" is exactly what a benchmark of
 * request behaviour needs and cannot reconstruct afterwards.
 */
function end(r, { ok = true, status = 0, failure = '', receipt = null } = {}) {
  if (!r || typeof r !== 'object') return null;
  r.ms = Math.max(0, Date.now() - r.at);
  r.ok = Boolean(ok);
  r.status = Number(status) || 0;
  r.failure = String(failure || '');
  if (receipt && typeof receipt === 'object') {
    r.receipt = {
      inputTokens: Number(receipt.inputTokens) || 0,
      outputTokens: Number(receipt.outputTokens) || 0,
      // Present only when the provider said one — null/undefined mean "nobody
      // mentioned a cache", which is a different fact from zero. See the same
      // distinction in guardian.js `noteUsage`.
      // A receipt that says `cacheReported: false` (provider.js: the usage
      // object carried no cache field at all) records neither figure.
      ...(receipt.cacheReported !== false && receipt.cacheReadTokens != null ? { cacheReadTokens: Number(receipt.cacheReadTokens) || 0 } : {}),
      ...(receipt.cacheReported !== false && receipt.cacheCreationTokens != null ? { cacheCreationTokens: Number(receipt.cacheCreationTokens) || 0 } : {}),
      // Reported or absent — never zero-filled (usage.js tells "not reported" apart).
      ...(receipt.reasoningTokens != null ? { reasoningTokens: Number(receipt.reasoningTokens) || 0 } : {}),
      ...(receipt.costUsd != null && Number.isFinite(Number(receipt.costUsd)) ? { costUsd: Number(receipt.costUsd) } : {}),
      ...(Number.isFinite(receipt.toolCalls) ? { toolCalls: receipt.toolCalls } : {}),
      ...(receipt.estimated ? { estimated: true } : {}),
      // A LOCAL RUNTIME'S OWN COUNTERS (llama.cpp timings, Ollama durations) and
      // what a runtime said about its own run — kept as reported, apart from tokens.
      ...(receipt.local && typeof receipt.local === 'object' ? { local: { ...receipt.local } } : {}),
      ...(receipt.runtime && typeof receipt.runtime === 'object' ? { runtime: { ...receipt.runtime } } : {}),
      ...(receipt.costBasis ? { costBasis: String(receipt.costBasis) } : {}),
      // WHAT LAIN OBSERVED of a website exchange (ChatGPT Chat): sizes, never billed tokens.
      ...(receipt.observed && typeof receipt.observed === 'object' ? { observed: { ...receipt.observed } } : {}),
    };
  } else {
    r.receipt = null;
  }
  sink(r);
  return r;
}

/**
 * AN OPTIONAL SINK, OFF UNLESS SOMEBODY ASKS FOR IT.
 *
 * `LAIN_REQTRACE=<path>` appends one JSON line per finished request. This is a
 * measurement seam in the exact shape of the mock provider's `LAIN_MOCK_WIRELOG`:
 * the ledger this module already keeps is process-global and dies with the
 * process, so a benchmark that spawns the real binary and reads its behaviour
 * back has no way to see per-request reason and latency without it. Nothing is
 * written unless the variable is set; a write that fails is ignored, because a
 * measurement must never end a turn.
 *
 * The in-memory ledger stays the only authority: the sink is a projection of
 * it, never a second count.
 */
/**
 * WHAT WAS SENT, by size — only when a benchmark asked for the trace
 * (LAIN_REQTRACE). The tool schemas are counted apart, because a tool that is
 * offered on every request but never called is pure input cost.
 */
function sized(r, messages, tools) {
  if (!r) return r;
  // SIZES ALWAYS (the /focus metrics compare what was sent); the tool NAMES
  // only when a benchmark asked for the trace. Never the content.
  try {
    r.messageChars = JSON.stringify(messages || []).length;
    // THE FIXED PART: the system prompt, sent again on every request.
    const sys = (messages || []).find((m) => m && m.role === 'system');
    r.systemChars = sys ? (typeof sys.content === 'string' ? sys.content.length : JSON.stringify(sys.content || '').length) : 0;
    r.toolSchemaChars = JSON.stringify(tools || []).length;
    r.toolCount = (tools || []).length;
    if (process.env.LAIN_REQTRACE) r.tools = (tools || []).map((t) => t && t.name).filter(Boolean);
  } catch { /* measurement only */ }
  return r;
}

function sink(r) {
  const p = process.env.LAIN_REQTRACE;
  if (p) { try { require('fs').appendFileSync(p, JSON.stringify(r) + '\n'); } catch { /* never fatal */ } }
  if (r && r.session) sessionSink(r);
}

/**
 * THE SESSION'S REQUESTS, ACROSS PROCESSES. A request that belongs to a session
 * (the envelope says which) is also appended to that session's own small trace
 * file, so a CLI resuming the session can account for requests the Harness
 * made, and the other way round. Identity and accounting only — id, turn, step,
 * reason, transport, model, connection, outcome, the usage receipt — never a
 * prompt, a reply or a key. Bounded: past 256 KB the older half is dropped.
 */
const SESSION_TRACE_BYTES = 256 * 1024;
const SAFE = ['id', 'turn', 'step', 'reason', 'transport', 'model', 'connection', 'provider', 'protocol', 'project', 'role', 'session', 'task', 'at', 'ms', 'ok', 'status', 'failure', 'receipt', 'messageChars', 'systemChars', 'toolSchemaChars', 'toolCount'];
function sessionFile(id) {
  const safe = String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  return require('path').join(require('./config').configDir(), 'reqtrace', `${safe}.jsonl`);
}
function sessionSink(r) {
  try {
    const fs = require('fs');
    const f = sessionFile(r.session);
    fs.mkdirSync(require('path').dirname(f), { recursive: true });
    try {
      if (fs.statSync(f).size > SESSION_TRACE_BYTES) {
        const keep = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(f, `${keep.slice(Math.floor(keep.length / 2)).join('\n')}\n`);
      }
    } catch { /* first request of this session */ }
    const row = {};
    for (const k of SAFE) if (r[k] !== undefined) row[k] = r[k];
    fs.appendFileSync(f, `${JSON.stringify(row)}\n`);
  } catch { /* never fatal */ }
}

/**
 * EVERY REQUEST OF A SESSION, whichever process made it: the session's trace
 * file, plus this process's requests still in flight. Oldest first, once per id.
 */
function forSession(sessionId) {
  if (!sessionId) return [];
  const byId = new Map();
  try {
    for (const ln of require('fs').readFileSync(sessionFile(sessionId), 'utf8').split('\n')) {
      if (!ln) continue;
      try { const r = JSON.parse(ln); if (r && r.id) byId.set(r.id, r); } catch { /* a torn line */ }
    }
  } catch { /* none yet */ }
  for (const r of ledger) if (r.session === sessionId && !byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
}

/** Everything recorded, oldest first. */
function all() { return ledger.slice(); }

/** The requests belonging to one turn, in order. */
function forTurn(turnId) {
  return ledger.filter((r) => r.turn && r.turn === turnId);
}

/** The most recent finished request — what the status strip reads latency from. */
function last() {
  for (let i = ledger.length - 1; i >= 0; i--) if (ledger[i].ok !== null) return ledger[i];
  return null;
}

/**
 * A one-line account of a turn's requests, for `/status` and the summary.
 *
 * `4 requests · 4 model steps · 1.2s slowest` reads as normal. Anything with
 * two requests for one step in it reads as a defect, which is the entire point.
 */
function explain(turnId) {
  const rows = forTurn(turnId);
  if (!rows.length) return null;
  const byReason = new Map();
  for (const r of rows) byReason.set(r.reason, (byReason.get(r.reason) || 0) + 1);
  const steps = new Set(rows.filter((r) => r.reason === REASON.STEP).map((r) => r.step));
  const slowest = rows.reduce((a, b) => (b.ms > (a ? a.ms : -1) ? b : a), null);
  const failed = rows.filter((r) => r.ok === false).length;
  return {
    turn: turnId,
    requests: rows.length,
    steps: steps.size,
    /** More requests than distinct steps means something asked twice. */
    // A DUPLICATE IS A PLAIN STEP ASKED TWICE. Retries and refits are counted
    // as themselves — they are one step legitimately sent again, and folding
    // them in here would report every flaky gateway as a LAIN defect.
    duplicated: Math.max(0, rows.filter((r) => r.reason === REASON.STEP).length - steps.size),
    retries: rows.filter((r) => r.reason === REASON.RETRY).length,
    failed,
    slowestMs: slowest ? slowest.ms : 0,
    byReason: [...byReason.entries()].map(([k, n]) => `${k} ×${n}`).join(' · '),
    rows,
  };
}

/** Forget everything. For the tests only. */
// THE LEDGER EMPTIES; IDS NEVER REPEAT in a process — a usage receipt is deduplicated by
// id (usage.js), so reusing r1 after a reset silently merged a new request into an old one.
function reset() { ledger.length = 0; }

module.exports = { REASON, begin, end, sized, forStep, all, forTurn, forSession, last, explain, reset, MAX, PROC };
