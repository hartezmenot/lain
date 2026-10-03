'use strict';

/** NON-PROGRESS — the same discovery repeated under the same state. */

const crypto = require('crypto');

const receipts = require('./readreceipts');

const VERDICT = Object.freeze({
  DISCOVERY: 'DISCOVERY',
  REDUNDANT: 'REDUNDANT',
  RECHECK: 'RECHECK',
  NON_PROGRESS: 'NON_PROGRESS',
});

const MAX_SEEN = 300;
const MAX_EVENTS = 40;
const VALIDATORS = new Set(['run_tests', 'verify_task', 'service_check', 'observe_stop']);

function stateOf(session) {
  if (!session.progress || typeof session.progress !== 'object') {
    session.progress = { mutations: 0, validations: 0, seen: {}, events: [] };
  }
  const p = session.progress;
  if (!p.seen || typeof p.seen !== 'object') p.seen = {};
  if (!Array.isArray(p.events)) p.events = [];
  return p;
}

/** THE CURRENT STEP OF THE LIVE PLAN, or none. */
function planStepOf(session) {
  const plan = session && session.plan;
  const live = plan && plan.isLive !== false && !plan.retiredAt;
  const steps = live && Array.isArray(plan.steps) ? plan.steps : [];
  const open = (s) => s && s.status !== 'done' && s.status !== 'dropped' && !s.done;
  const active = steps.findIndex((s) => s && s.status === 'active');
  const i = active >= 0 ? active : steps.findIndex(open);
  return i < 0 ? { index: null, text: '' } : { index: i + 1, text: String(steps[i].text || steps[i].title || '') };
}

/** The identity of "where the work stands". Two equal keys are the same state. */
function stateKey(session) {
  const p = stateOf(session);
  let goalId = '';
  try { goalId = require('./goal').id(session); } catch { goalId = ''; }
  const step = planStepOf(session);
  const observed = session.evidence ? new Set(receipts.all(session.evidence).map((r) => r.abs)).size : 0;
  return crypto.createHash('sha256').update(JSON.stringify({
    goalId,
    taskId: (session.task && session.task.id) || '',
    step: step.index,
    stepText: step.text,
    mutations: p.mutations,
    validations: p.validations,
    observed,
  })).digest('hex').slice(0, 16);
}

/** Is the output of this tool call still whole in the conversation? */
function stillInContext(session, toolCallId) {
  if (!toolCallId || !Array.isArray(session.messages)) return false;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m && m.role === 'tool' && String(m.tool_call_id) === String(toolCallId)) return !m.elided;
  }
  return false;
}

function pendingAction(session) {
  const step = planStepOf(session);
  const life = session.lifecycle;
  const parts = [];
  if (step.text) parts.push(`plan step ${step.index}: ${step.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  if (life && life.lastCommand && life.lastCommand.ok === false) parts.push(`the last check is still failing: ${life.lastCommand.command}`);
  else if (life && life.lastCommand && life.lastCommand.ok === null) parts.push(`the last check was inconclusive: ${life.lastCommand.command}`);
  else if (life && life.evidence && life.evidence.filesChanged && life.evidence.filesChanged.size && !life.evidence.verifiedChecks) {
    parts.push(`${life.evidence.filesChanged.size} changed file(s) have not been checked`);
  }
  return parts.length ? parts.join('; ') : 'the next write or check the task needs';
}

/** WHICH EVIDENCE A READ ASKS FOR — the FILE, not the command that asked. */
function semanticKey(read) {
  return process.platform === 'win32' ? String(read.abs).toLowerCase() : String(read.abs);
}

function note(p, ev) {
  p.events.push({ ...ev, at: Date.now() });
  if (p.events.length > MAX_EVENTS) p.events.splice(0, p.events.length - MAX_EVENTS);
}

/** BEFORE A CALL RUNS. Returns `{ read, verdict, substitute }` for a source read, or null for anything else. `substitute` is a tool result to use… */
function before(session, name, input) {
  if (!session || !session.evidence) return null;
  const read = receipts.parse(name, input, session.cwd);
  if (!read) return null;
  const p = stateOf(session);
  const key = stateKey(session);
  const receipt = receipts.current(session.evidence, read);
  // WHAT ALREADY ANSWERS THIS, whatever command asked it. `current` is the
  // identical call (the only bytes safe to serve); `covering` is the question.
  const covered = receipt || receipts.covering(session.evidence, read);
  // THE SAME QUESTION, NOT THE SAME COMMAND
  const target = semanticKey(read);
  const seen = p.seen[target];
  const same = covered && seen && seen.state === key;
  const repeats = same ? seen.repeats + 1 : 0;
  p.seen[target] = { state: key, repeats };
  const keys = Object.keys(p.seen);
  if (keys.length > MAX_SEEN) for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete p.seen[k];

  const nonProgress = repeats >= 2;

  // ALREADY ANSWERED, BUT NOT BY THIS EXACT CALL.
  if (!receipt) {
    if (!nonProgress) return { read, verdict: VERDICT.DISCOVERY, substitute: null, repeats };
    const steer = `\nNON_PROGRESS: this is observation ${repeats + 1} of ${receipts.label(covered)} under unchanged state — `
      + 'same task, same plan step, same source fingerprint, nothing written and nothing checked since. '
      + `Asking it another way will not change what it says. Pending: ${pendingAction(session)}. `
      + 'Act on what you have, or say exactly what is still missing.';
    note(p, { verdict: VERDICT.NON_PROGRESS, target: receipts.label(covered), repeats, route: read.route });
    return { read, verdict: VERDICT.NON_PROGRESS, substitute: null, repeats, steer };
  }

  const steer = nonProgress
    ? `\nNON_PROGRESS: this is read ${repeats + 1} of ${receipts.label(receipt)} under unchanged state — same task, same plan step, `
      + 'same source fingerprint, nothing written and nothing checked since. Re-reading will not change what it says. '
      + `Pending: ${pendingAction(session)}. Act on what you have, or say exactly what is still missing.`
    : '';
  const verdict = nonProgress ? VERDICT.NON_PROGRESS
    : stillInContext(session, receipt.toolCallId) ? VERDICT.REDUNDANT : VERDICT.RECHECK;
  note(p, { verdict, target: receipts.label(receipt), repeats, route: read.route });

  // A WHOLE-FILE read_file BELONGS TO THE LEDGER (evidence.js `check`), whose
  // contract and wording are its own; the gate only records and steers it.
  const wholeFile = read.route === 'read_file' && read.from == null;
  // A READ IS ALWAYS SERVED — the ledger's promise, kept here.
  if (!wholeFile && receipt.output != null) {
    receipt.served += 1;
    return {
      read, verdict, repeats, receipt,
      substitute: {
        output: `[receipt ${receipt.id} · ${receipts.label(receipt)} · unchanged — served from the receipt, not re-run]\n`
          + receipt.output + steer,
        observedOutput: receipt.output,
        fromReceipt: true,
      },
    };
  }
  // No kept output (resumed session, or too large to keep): the call runs, and
  // the steer rides on its result.
  return { read, verdict, repeats, receipt, substitute: null, steer };
}

/** AFTER A CALL RAN (or was substituted). Records the receipt and the state movement. */
function after(session, name, input, result, gate, { toolCallId = '' } = {}) {
  if (!session) return result;
  const p = stateOf(session);
  if (result && Array.isArray(result.mutated) && result.mutated.length && !result.denied && !result.stale) p.mutations += 1;
  if (VALIDATORS.has(name) || (result && result.exitCode != null && !gate)) p.validations += 1;
  if (!gate || !session.evidence || !result || result.fromReceipt) return result;
  const step = planStepOf(session);
  receipts.record(session.evidence, gate.read, {
    output: result.output, isError: result.isError,
    taskId: (session.task && session.task.id) || '', planStep: step.index, toolCallId,
  });
  // The first observation of a file is itself a state change (a new dependency is known).
  const target = semanticKey(gate.read);
  if (p.seen[target]) p.seen[target].state = stateKey(session);
  if (gate.steer) return { ...result, output: `${String(result.output || '')}${gate.steer}`, observedOutput: result.output };
  return result;
}

function toJSON(session) {
  const p = session && session.progress;
  if (!p) return null;
  return { mutations: p.mutations || 0, validations: p.validations || 0, seen: p.seen || {}, events: (p.events || []).slice(-MAX_EVENTS) };
}

function restore(session, data) {
  if (!data || typeof data !== 'object') return session;
  session.progress = {
    mutations: Number(data.mutations) || 0,
    validations: Number(data.validations) || 0,
    seen: data.seen && typeof data.seen === 'object' ? data.seen : {},
    events: Array.isArray(data.events) ? data.events.slice(-MAX_EVENTS) : [],
  };
  return session;
}

module.exports = { VERDICT, before, after, stateKey, toJSON, restore, pendingAction };
