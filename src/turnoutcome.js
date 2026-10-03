'use strict';

/** HOW A MODEL TURN ENDED — and what that means for the TASK it belongs to. */

const fs = require('fs');

const OUTCOME = Object.freeze({
  COMPLETED: 'COMPLETED',
  NEEDS_USER_DECISION: 'NEEDS_USER_DECISION',
  EXPLICIT_PAUSE: 'EXPLICIT_PAUSE',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  PROVIDER_RATE_LIMIT: 'PROVIDER_RATE_LIMIT',
  PROVIDER_CRASH: 'PROVIDER_CRASH',
  TOOL_RECOVERABLE: 'TOOL_RECOVERABLE',
  TOOL_FATAL: 'TOOL_FATAL',
  HOST_CRASH: 'HOST_CRASH',
  CANCELLED: 'CANCELLED',
});

/** Outcomes after which the TASK may carry on by itself (subject to the budget and the run strategy). */
const CONTINUABLE = new Set([OUTCOME.COMPLETED, OUTCOME.TOOL_RECOVERABLE, OUTCOME.PROVIDER_CRASH, OUTCOME.HOST_CRASH]);

/** What each outcome is called where a person reads it. */
const LABEL = Object.freeze({
  COMPLETED: 'Completed',
  NEEDS_USER_DECISION: 'Needs your decision',
  EXPLICIT_PAUSE: 'Paused',
  QUOTA_EXHAUSTED: 'Quota exhausted',
  PROVIDER_RATE_LIMIT: 'Rate limited',
  PROVIDER_CRASH: 'Provider failed',
  TOOL_RECOVERABLE: 'Recovered from a tool error',
  TOOL_FATAL: 'Blocked by a tool',
  HOST_CRASH: 'Execution host stopped',
  CANCELLED: 'Stopped',
});

const NATURAL = new Set(['end', 'end_turn', 'stop', 'done']);

function projectMissing(session) {
  const cwd = session && session.cwd;
  if (!cwd) return false;
  try { return !fs.statSync(cwd).isDirectory(); } catch { return true; }
}

function waitingOnPerson(session) {
  const life = session && session.lifecycle;
  return Boolean(life && (life.state === 'NEEDS_USER' || life.state === 'WAITING_FOR_USER'));
}

/** The tool failures of a turn, as the loop recorded them (turn.js pushes `kind: 'TOOL'`). */
function toolErrors(record) {
  return ((record && record.errors) || []).filter((e) => e && e.kind === 'TOOL');
}

/** THE CLASSIFICATION. Pure over its inputs. */
function classify(record, { session = null, hostClosing = false, recovered = false } = {}) {
  const out = (outcome, why) => ({
    outcome, why: String(why || '').slice(0, 300), label: LABEL[outcome],
    continuable: CONTINUABLE.has(outcome), toolErrors: toolErrors(record).length,
  });
  if (!record) return out(hostClosing ? OUTCOME.HOST_CRASH : OUTCOME.CANCELLED, hostClosing ? 'the execution host closed during the turn' : 'stopped before the turn finished');
  const stop = String(record.stopReason || 'end');
  const pf = record.providerFailure || {};

  if (stop === 'crashed' || recovered) return out(OUTCOME.HOST_CRASH, 'the process running the turn stopped mid-turn');
  if (stop === 'aborted') return hostClosing ? out(OUTCOME.HOST_CRASH, 'the execution host closed during the turn') : out(OUTCOME.CANCELLED, 'stopped by you');
  if (stop === 'rate-limited') {
    return pf.kind === 'QUOTA'
      ? out(OUTCOME.QUOTA_EXHAUSTED, pf.message || 'the account has no quota left in this window')
      : out(OUTCOME.PROVIDER_RATE_LIMIT, pf.message || 'the provider is rate limiting this route');
  }
  if (stop === 'no-credential') return out(OUTCOME.NEEDS_USER_DECISION, (record.errors || []).map((e) => e && e.message).filter(Boolean)[0] || 'this route has no credential');
  if (stop === 'provider') {
    // A REFUSAL THAT WAITING CANNOT FIX is a decision for the person: a credential, a model this route does not serve, a request it will not take.
    if (pf.kind === 'AUTH') return out(OUTCOME.NEEDS_USER_DECISION, pf.message || 'the provider refused the credential');
    if (pf.kind === 'MODEL_UNAVAILABLE' || pf.kind === 'BAD_REQUEST') return out(OUTCOME.NEEDS_USER_DECISION, pf.message || 'the provider refused this request');
    if (pf.kind === 'QUOTA') return out(OUTCOME.QUOTA_EXHAUSTED, pf.message || 'the account has no quota left');
    if (pf.layer === 'runtime' || /^RUNTIME_/.test(String(pf.kind || ''))) return out(OUTCOME.NEEDS_USER_DECISION, pf.message || 'the runtime refused the request');
    return out(OUTCOME.PROVIDER_CRASH, pf.message || 'the provider did not answer');
  }
  // A STEP CAP IS A PERSON CAPPING THEIR OWN SPEND (turn.js DEFAULT_MAX_STEPS): honoured as a pause, never overridden.
  if (stop === 'max-steps') return out(OUTCOME.EXPLICIT_PAUSE, 'the step limit you configured was reached');
  // WENT IDLE after the hidden wake-up (wakeup.js): the task may carry on from its plan; the budget decides how often.
  if (stop === 'no-progress') return out(OUTCOME.TOOL_RECOVERABLE, 'the model stopped before doing the work it described');
  // THE MODEL DECLINED the request (finish.js `refused`): a person decides what happens next.
  if (stop === 'refused') return out(OUTCOME.NEEDS_USER_DECISION, 'the model declined this request');
  // `length` — the reply reached the output limit after its own resumes (finish.js): a model boundary, read as a natural end.
  if (!NATURAL.has(stop) && stop !== 'length') return out(OUTCOME.PROVIDER_CRASH, `the turn ended: ${stop}`);

  // ---- A NATURAL END: whether the TASK can carry on is about the session, not the reply ----
  if (projectMissing(session)) return out(OUTCOME.TOOL_FATAL, 'the project folder is missing');
  if (waitingOnPerson(session)) return out(OUTCOME.NEEDS_USER_DECISION, 'the Agent asked you something and is waiting');
  const errs = toolErrors(record);
  const fatal = errs.find((e) => e.fatal);
  if (fatal) return out(OUTCOME.TOOL_FATAL, fatal.message || 'a required tool cannot run');
  // A REFUSAL THE PERSON GAVE, as the LAST call the turn made, is theirs to follow up (one the model worked past is not).
  const acts = record.actions || [];
  const lastAct = acts[acts.length - 1];
  const lastDenied = lastAct ? Boolean(lastAct.denied) : Boolean(errs.length && errs[errs.length - 1].denied);
  if (lastDenied) return out(OUTCOME.NEEDS_USER_DECISION, (errs.filter((e) => e.denied).pop() || {}).message || 'you refused a permission the Agent asked for');
  if (errs.length) return out(OUTCOME.TOOL_RECOVERABLE, `${errs.length} tool call(s) failed and were reported to the model`);
  return out(OUTCOME.COMPLETED, 'the model ended its turn');
}

/** DID THE TURN MOVE THE TASK? */
function progressed(record, { planDoneBefore = null, planDoneAfter = null } = {}) {
  if (!record) return false;
  if (planDoneBefore != null && planDoneAfter != null && planDoneAfter > planDoneBefore) return true;
  if ((record.mutations || []).length) return true;
  const failed = toolErrors(record).length;
  return Math.max(0, (Number(record.toolCalls) || 0) - failed) > 0;
}

module.exports = { OUTCOME, LABEL, CONTINUABLE, classify, progressed, toolErrors };
