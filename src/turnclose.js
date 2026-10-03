'use strict';

/** CLOSING A TURN — the accounting, and what the session remembers of it. */

// Bounds on what a turn leaves behind in the saved session. A session is
// written to disk, so every field the UI reads is capped rather than trusted.
const MAX_KEPT_INPUT = 400;
const MAX_KEPT_TEXT = 1200;
const MAX_KEPT_ACTIONS = 40;

/** Hand the turn's totals to the lifecycle and record what came back. */
function accountTo(life, record) {
  if (!life) { record.lifecycle = null; return record; }
  const v = life.observeTurn({
    toolCalls: record.toolCalls,
    text: record.text,
    mutated: record.mutations.length,
  });
  record.productive = Boolean(v.productive);
  // COUNTED, AND NOTHING ELSE. `if (v.blocked) record.stopReason = 'blocked'`
  // stood here and is gone; see the header.
  record.narrations = Number(v.narrations) || 0;
  if (record.providerFailure && record.providerFailure.kind === 'AUTH') {
    life.noteAuthFailure(record.providerFailure.provider, record.providerFailure.message);
  } else if (record.usage && record.usage.requests > 0 && !record.providerFailure) {
    life.noteProviderAnswered();
  }
  record.lifecycle = life.summary();
  return record;
}

/** WHAT THE SESSION REMEMBERS ABOUT THIS TURN. */
function remember(session, record) {
  record.endedAt = new Date().toISOString();
  session.usage.inputTokens += record.usage.inputTokens;
  session.usage.outputTokens += record.usage.outputTokens;
  session.usage.cacheReadTokens += record.usage.cacheReadTokens || 0;
  session.usage.cacheCreationTokens += record.usage.cacheCreationTokens || 0;
  if (Number.isFinite(record.usage.reasoningTokens)) session.usage.reasoningTokens = (session.usage.reasoningTokens || 0) + record.usage.reasoningTokens;
  session.usage.requests += record.usage.requests;
  session.turns.push({
    turnId: record.turnId, startedAt: record.startedAt, endedAt: record.endedAt,
    userInput: String(record.userInput || '').slice(0, MAX_KEPT_INPUT),
    // Kept because the FEED needs it, and the feed is rebuilt from the saved session after a resume.
    from: record.from || null,
    // A PERSON TYPED IT, even when it arrived through a recovery or a steer.
    typed: Boolean(record.typed),
    // WHAT EACH REQUEST OF THIS TURN COST, AND OF WHAT.
    audits: record.audits || [],
    text: String(record.text || '').slice(0, MAX_KEPT_TEXT),
    // Two scalars the record already counts and the saved session was losing: how many model steps the turn took, and how many reads the evidence ledger…
    steps: record.steps || 0,
    evidenceReuse: record.evidenceReuse || 0,
    toolCalls: record.toolCalls, toolNames: record.toolNames,
    actions: record.actions.slice(-MAX_KEPT_ACTIONS),
    narration: record.narration.slice(-MAX_KEPT_ACTIONS),
    // WHAT THE USER SAID WHILE IT WAS WORKING.
    steerTexts: (record.steerTexts || []).slice(-MAX_KEPT_ACTIONS),
    // WHAT IT THOUGHT, kept only so that a turn which said nothing is not a blank pane once the live feed has gone.
    reasoning: String(record.reasoning || '').slice(0, MAX_KEPT_TEXT),
    // THE THINKING PHASES, for the folded `Thought for …` line (ui/thoughtrow.js) — display only.
    thinking: (record.thinking || []).slice(-20).map((t) => ({ ...t, text: String(t.text || '').slice(-2000) })),
    errors: record.errors.slice(0, 5),
    mutations: record.mutations, stopReason: record.stopReason,
    // How many hidden wake-ups this turn needed (wakeup.js) — 0 or 1.
    wakeups: record.wakeups || 0,
    usage: record.usage,
  });
  return record;
}

/** CLOSE A TURN — the only thing any ending needs to call. */
function close(session, life, record) {
  accountTo(life, record);
  remember(session, record);
  settleScratch(session, record);
  // (The model's writes advance the project generation inside the mutation
  // transaction itself — mutation.js `consequences` — once per kept change.)
  try { require('./tempworkspaces').sweep(null, session.id); } catch { /* retained; reconciled at the next start */ }
  try { profileTurn(life, record); } catch { /* a measurement, never a failure */ }
  require('./inflight').end(session);   // ended by a route LAIN saw — nothing to recover
  return record;
}

/** THE MODEL'S MEASURED BEHAVIOUR (discipline/profile.js) — folded in once per turn, so discretion follows what a model actually does rather than its… */
function profileTurn(life, record) {
  if (!record || !record.model || /mock/i.test(record.model)) return;
  const d = life && life.discipline;
  const errs = record.errors || [];
  const patchCalls = (record.actions || []).filter((a) => require('./mutation').isSourceMutation(a.name || ''));
  const repeats = life ? [...life.seen.values()].filter((n) => n > 1).length : 0;
  const gen = life ? life.mutationSeq || 0 : 0;
  const verified = Boolean(d && d.checks.all().some((c) => c.latest && c.latest.gen === gen && ['PASS', 'OBSERVED'].includes(c.latest.state)));
  require('./discipline/profile').record(record.model, {
    calls: record.toolCalls || 0,
    invalidCalls: errs.filter((e) => /unknown tool|invalid (?:arguments|json)|not offered/i.test(String(e.message || ''))).length,
    patches: patchCalls.length,
    patchFailures: patchCalls.filter((a) => a.ok === false).length,
    completionRequests: life ? life._completionRequests || 0 : 0,
    falseCompletions: life ? life._falseCompletions || 0 : 0,
    repeats: Math.max(0, repeats - (life ? life._repeatsReported || 0 : 0)),
    mutated: (record.mutations || []).length > 0,
    verified,
    onOutcome: Boolean(d && (d.contract.outcome || d.contract.criteria.length)),
  });
  if (life) { life._completionRequests = 0; life._falseCompletions = 0; life._repeatsReported = repeats; }
}

/** A COMPLETED TURN'S SCRATCH IS SPENT; every other ending keeps it. */
function settleScratch(session, record) {
  if (!session) return;
  if (record.stopReason !== 'end' && record.stopReason !== 'no-credential') return;
  try { require('./scratch').close(session.cwd, session.id); } catch { /* read-only project */ }
}

/** THE FAILURE RECORD FOR A TURN THAT NEVER SENT A REQUEST. */
function skipped(pc, connectionId, gate, limited) {
  return {
    provider: pc.provider,
    connectionId,
    kind: limited ? require('./errors').KIND.RATE_LIMITED : gate.status,
    message: gate.reason,
    skipped: true,
    retryAfterMs: gate.retryAfterMs || 0,
    resumeAt: gate.resumeAt || (gate.retryAfterMs ? Date.now() + gate.retryAfterMs : 0),
  };
}

module.exports = { accountTo, remember, close, skipped, MAX_KEPT_INPUT, MAX_KEPT_TEXT, MAX_KEPT_ACTIONS };
