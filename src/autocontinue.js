'use strict';

/**
 * THE TASK CARRIES ON ACROSS MODEL BOUNDARIES — bounded, classified, recorded.
 *
 * ------------------------------------------------------------------------
 * WHAT CHANGED (2026-09-29). A person asked for a task; the Coding Agent
 * worked a phase, the model ended its turn at a checkpoint, and LAIN stopped —
 * "Normal strategy — each request is its own run" — and waited for someone to
 * type `continue`. It did the same after a stale evidence id, a delegate role
 * in the wrong case, a missing temp file, a provider that dropped the stream,
 * and a process that died. Every one of those is a MODEL boundary, not a TASK
 * boundary, and LAIN already holds everything needed to go on: the approved
 * plan, what landed, what remains, what failed, the handover.
 *
 * So after a Coding turn this answers ONE question — does another turn start
 * by itself? — from the ending's classification (turnoutcome.js), the run
 * strategy, the checkpoint's problems and a small continuation BUDGET:
 *
 *   consecutive continuations that moved nothing     2 → the person is asked
 *   provider failures after the turn's own retries   3 restarts, waiting 20 s · 60 s · 180 s
 *   host crashes resumed without progress between    2 → the person is asked
 *
 * Progress (a plan step done, a file changed, a tool that succeeded) resets the
 * budget; so does anything a person types. Exhausting it never FAILS the task:
 * it pauses it with the reason, and ▶ Continue carries on from the same state.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT CARRY-ON. `carryon` (removed) decided that a model which
 * stopped did not mean to, whenever a step counter ran out, and sent "continue
 * from where you stopped" up to four times. Here:
 *   - the trigger is a CLASSIFIED ending with durable continuation state behind
 *     it — an approved plan with steps left, or a turn the host or provider cut;
 *   - the instruction is composed from that state (runstrategy.nextPhasePrompt,
 *     continueactions.instruction), naming the step — never the bare word;
 *   - a natural end with nothing left, a question to the person, a blocking
 *     finding, a scope change, failed verification, a refusal, a person's stop
 *     or pause, a step cap they configured, and a quota measured in hours all
 *     STOP, exactly as before;
 *   - every automatic continuation is logged with its cause (`continuation.log`).
 *
 * Nothing here calls a model. It returns a decision; submitclose.js and the
 * recovery path start the turn through the one door (app.submit).
 */

const wb = require('./workbench');
const T = require('./turnoutcome');

const BUDGET = Object.freeze({ noProgress: 2, providerRestarts: 3, crashResumes: 2, goalTurns: 6 });
const RESTART_DELAYS_MS = Object.freeze([20000, 60000, 180000]);
/** Submissions LAIN makes on its own. Anything else came from a person and resets the budget. */
const AUTOMATIC = new Set(['phase-continue', 'goal-continue', 'auto-resume', 'provider-restart', 'account-fallback', 'rate-limit-resume', 'handover']);
const LOG_MAX = 20;

function blank() { return { noProgress: 0, providerRestarts: 0, crashResumes: 0, goalTurns: 0, log: [], last: null }; }

/** The session's continuation state (persisted with the workbench). */
function state(session) {
  const w = wb.of(session);
  if (!w.autoRun || typeof w.autoRun !== 'object') w.autoRun = blank();
  const b = blank();
  for (const k of Object.keys(b)) if (w.autoRun[k] === undefined) w.autoRun[k] = b[k];
  return w.autoRun;
}

function log(session, entry) {
  const c = state(session);
  const e = { at: Date.now(), ...entry };
  c.log.push(e);
  if (c.log.length > LOG_MAX) c.log.splice(0, c.log.length - LOG_MAX);
  c.last = e;
  return e;
}

/** A person spoke (or pressed Continue): the budget starts again. */
function reset(session, why = 'person') {
  const c = state(session);
  c.noProgress = 0; c.providerRestarts = 0; c.crashResumes = 0; c.goalTurns = 0;
  c.resetAt = Date.now(); c.resetWhy = why;
  return c;
}

function planOf(session) {
  const rs = require('./runstrategy');
  return rs.planShape(session);
}

/** The recoverable tool failures of the last turn, as one sentence the next instruction carries. */
function failureNote(record) {
  const errs = T.toolErrors(record);
  if (!errs.length) return '';
  const seen = [];
  for (const e of errs) { const t = String(e.message || '').slice(0, 160); if (t && !seen.includes(t)) seen.push(t); }
  return `The last turn's failed tool calls (already reported to you): ${seen.slice(0, 4).join(' | ')}. `
    + 'Do not repeat a call that failed the same way — use the allowed values it named, a different tool, or a different approach.';
}

/**
 * THE INSTRUCTION a continuation sends — composed from durable state, never the bare word "continue".
 * Plan work names its phase (runstrategy.nextPhasePrompt); a turn cut off without a plan resumes the objective.
 */
const LEAD = Object.freeze({
  'provider-restart': 'The provider connection failed and has been re-established; nothing in the project was lost. ',
  'auto-resume': 'The process that was running this task stopped mid-turn and Noema recovered the session (its tool results were repaired from what actually happened on disk). ',
  'host-closed': 'The execution host that was running this task closed; the session and the project are exactly as it left them. ',
});

function instruction(session, { cause, record = null }) {
  const rs = require('./runstrategy');
  const lead = LEAD[cause] || '';
  const next = rs.nextPhasePrompt(session);
  if (next) return `${lead}${next}${record ? ` ${failureNote(record)}` : ''}`.trim();
  const ca = require('./continueactions');
  const goalText = (session.task && session.task.objective) || '';
  const body = ca.instruction ? ca.instruction({ goalText, step: null, plan: null }) : 'Continue the work in hand.';
  return `${lead}${body}${record ? ` ${failureNote(record)}` : ''} If the work was in fact finished, say so and state what you concluded.`.trim();
}

/**
 * AFTER A CODING TURN: does the task carry on by itself?
 *
 * @param {object} session
 * @param {object} record          the finished turn
 * @param {object} cls             turnoutcome.classify(...)
 * @param {object} o
 *   problems       supervision.problems — reasons a person must look (blocking finding, delta, verification …)
 *   strategy       'NORMAL' | 'PHASED' | 'LONG_CONTEXT'
 *   planDoneBefore the plan's done count when the turn started (for progress)
 * @returns {{ continue: boolean, why: string, cause?: string, delayMs?: number, prompt?: string, needsUser?: boolean }}
 */
function decide(session, record, cls, { problems = [], strategy = 'NORMAL', planDoneBefore = null } = {}) {
  const c = state(session);
  if (!record || !AUTOMATIC.has(record.from || '')) reset(session, record && record.from ? record.from : 'person');
  const shape = planOf(session);
  const moved = T.progressed(record, { planDoneBefore, planDoneAfter: shape.done });
  if (moved) { c.noProgress = 0; c.crashResumes = 0; }
  if (cls.outcome !== T.OUTCOME.PROVIDER_CRASH) c.providerRestarts = 0;
  const stop = (why, extra = {}) => ({ continue: false, why, outcome: cls.outcome, ...extra });

  if (!cls.continuable) return stop(cls.why);
  if (problems.length) return stop(problems[0]);

  if (cls.outcome === T.OUTCOME.HOST_CRASH) {
    if (c.crashResumes >= BUDGET.crashResumes) return stop(`the execution host stopped ${c.crashResumes + 1} times without progress in between — continue when ready`, { needsUser: true });
    c.crashResumes += 1;
    log(session, { cause: 'auto-resume', outcome: cls.outcome, attempt: c.crashResumes, why: cls.why });
    return { continue: true, cause: 'auto-resume', delayMs: 0, why: cls.why, prompt: instruction(session, { cause: 'auto-resume', record }) };
  }

  if (cls.outcome === T.OUTCOME.PROVIDER_CRASH) {
    // ENOUGH STATE TO RESUME FROM is an approved plan with work left; a plain request that died is the person's to retry.
    if (!shape.remaining.length) return stop(cls.why);
    if (c.providerRestarts >= BUDGET.providerRestarts) return stop(`the provider kept failing (${cls.why}) — continue when it is back, or choose another model`, { needsUser: true });
    const delayMs = RESTART_DELAYS_MS[Math.min(c.providerRestarts, RESTART_DELAYS_MS.length - 1)];
    c.providerRestarts += 1;
    log(session, { cause: 'provider-restart', outcome: cls.outcome, attempt: c.providerRestarts, why: cls.why, delayMs });
    return { continue: true, cause: 'provider-restart', delayMs, why: cls.why, prompt: instruction(session, { cause: 'provider-restart', record }) };
  }

  // COMPLETED or TOOL_RECOVERABLE: the model ended its turn. With a plan, the TASK carries on while the plan does.
  // WITHOUT ONE — THE GOAL LOOP (2026-10-01): a model turn that ended while its own closing words name the next
  // piece of the work is a MODEL boundary, not the goal's end. It used to stop here and wait for `continue`.
  if (!shape.remaining.length) {
    const cue = goalCue(session, record);
    if (!cue) return stop(shape.total ? 'the plan is complete' : 'the request is answered', { complete: shape.total > 0 });
    if (c.goalTurns >= BUDGET.goalTurns) return stop(`${BUDGET.goalTurns} automatic turns toward this goal — continue when ready`, { needsUser: true });
    if (!moved) {
      c.noProgress += 1;
      if (c.noProgress > BUDGET.noProgress) return stop(`no progress after ${BUDGET.noProgress} automatic turns — the Agent needs your direction`, { needsUser: true });
    }
    c.goalTurns += 1;
    log(session, { cause: 'goal-continue', outcome: cls.outcome, attempt: c.goalTurns, why: cue.next.slice(0, 160) });
    return { continue: true, cause: 'goal-continue', delayMs: 0, why: 'the model named unfinished work', prompt: goalInstruction(session, record, cue) };
  }
  if (strategy === 'PHASED') return stop('Phased — review each phase');
  if (!moved) {
    c.noProgress += 1;
    if (c.noProgress > BUDGET.noProgress) {
      return stop(`no progress on step ${shape.remaining[0].n} after ${BUDGET.noProgress} automatic attempts — the Agent needs your direction`, { needsUser: true });
    }
  }
  log(session, { cause: 'phase-continue', outcome: cls.outcome, attempt: c.noProgress, why: cls.why, step: shape.remaining[0].n });
  return { continue: true, cause: 'phase-continue', delayMs: 0, why: cls.why, prompt: instruction(session, { cause: 'phase-continue', record: cls.outcome === T.OUTCOME.TOOL_RECOVERABLE ? record : null }) };
}

/**
 * AFTER A CRASH: a session loaded with a turn its process never finished (inflight.recover →
 * session.recovered). Resumes by itself when the turn was the Coding Agent's and the budget allows.
 * Returns the decision; the caller submits.
 */
function onRecovered(session) {
  const rec = session && session.recovered;
  if (!rec || rec.autoResumeDecided) return { continue: false, why: 'nothing recovered' };
  rec.autoResumeDecided = true;
  if (rec.from === 'messaging' || session.cowork || session.thread === 'chat') return { continue: false, why: 'not a Coding Agent turn' };
  const turns = session.turns || [];
  const record = turns.find((t) => t && t.turnId === rec.turnId) || { stopReason: 'crashed', from: rec.from || null, toolCalls: rec.calls || 0 };
  const cls = T.classify(record, { session, recovered: true });
  return decide(session, { ...record, from: 'auto-resume' }, cls, { problems: [], strategy: (wb.of(session).strategy || {}).kind || 'NORMAL' });
}

/** A crash younger than this resumes by itself; an older one waits for ▶ Continue. */
const FRESH_MS = 30 * 60 * 1000;
/** Let the host finish settling (the REPL, the window's first poll) before the resumed turn starts. */
const RECOVERY_DELAY_MS = 1500;

/**
 * A SESSION ADOPTED WITH A TURN ITS PROCESS NEVER FINISHED (App.adopt; the
 * session loaded through inflight.recover). A recent Coding crash resumes by
 * itself — the same task, session and phase, from the repaired transcript,
 * carrying the handover packet the Guardian's recovery uses (`app._handover`)
 * — once the host has settled and only if nothing else started meanwhile. An
 * old crash, or one the budget refuses, is marked paused (`host-crashed`) and
 * ▶ Continue resumes it.
 */
function scheduleRecovery(app) {
  const s = app && app.session;
  const rec = s && s.recovered;
  if (!rec || rec.autoResumeDecided || rec.autoResumeScheduled) return null;
  const w = wb.of(s);
  const pause = (why) => {
    try { require('./surfacehandoff').notePause(app, 'host-crashed'); } catch { /* the lease is advisory here */ }
    if (why) w.strategy.pausedForReview = why;
    try { s.save(); } catch { /* in memory */ }
  };
  const fresh = rec.lastActiveAt && Date.now() - rec.lastActiveAt < FRESH_MS;
  if (!fresh) { rec.autoResumeDecided = true; pause('the execution host stopped mid-turn'); return { scheduled: false, why: 'not a recent crash — ▶ Continue resumes it' }; }
  rec.autoResumeScheduled = true;
  const t = setTimeout(async () => {
    // THE PERSON (or another surface) MOVED ON: nothing is resumed behind their back.
    if (app.session !== s || app.abort || app.wantExit) return;
    const d = onRecovered(s);
    if (!d.continue) { pause(d.why); return; }
    try { require('./surfacehandoff').notePause(app, null); } catch { /* the lease is advisory here */ }
    app._handover = { reason: `TURN_LOST: the process running this task stopped at step ${rec.step}${rec.during ? ` (during ${rec.during})` : ''}; Noema repaired the transcript from what happened on disk`, kind: 'TURN_LOST', state: null, input: [] };
    try { require('./ui/operation').say(app, 'Resuming the interrupted task'); } catch { /* no screen */ }
    try { await app.submit(d.prompt, { sameTask: true, from: 'auto-resume' }); } catch { pause('the resumed turn could not start'); } finally { app._handover = null; }
  }, RECOVERY_DELAY_MS);
  if (t.unref) t.unref();
  return { scheduled: true };
}

/**
 * A RESTART WAITED OUT, CANCELLABLY. The session says what it is waiting for
 * (the window draws "Restarting · …"), and it holds a fresh abort controller so
 * Stop — the window's, Ctrl+C, Telegram's — ends the wait and nothing restarts.
 * Resolves true when the wait ran out, false when a person ended it.
 */
async function wait(app, ms, cause = 'provider-restart') {
  const s = app.session;
  const c = state(s);
  const scaled = process.env.LAIN_RESTART_DELAY_MS != null ? Math.max(0, Number(process.env.LAIN_RESTART_DELAY_MS) || 0) : ms;
  c.waiting = { until: Date.now() + scaled, cause, why: cause === 'provider-restart' ? 'the provider failed — retrying' : cause };
  try { s.save(); } catch { /* in memory */ }
  app.abort = new AbortController();
  const signal = app.abort.signal;
  try {
    if (app.ui && app.ui.enabled && typeof app.ui.waitForReset === 'function') {
      return Boolean(await app.ui.waitForReset(Date.now() + scaled, { label: 'restarting after a provider failure' }));
    }
    return await new Promise((resolve) => {
      if (signal.aborted) { resolve(false); return; }
      const t = setTimeout(() => resolve(true), scaled);
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(false); }, { once: true });
    });
  } finally {
    app.abort = null;
    c.waiting = null;
  }
}

/**
 * LONG CONTEXT PHASING'S BOUNDARY: the next phase starts from a compacted
 * context, through the one authority that may compact (session.contextAuthority).
 * The plan, landed / remaining and the findings ride every prompt already.
 */
function compactBoundary(app) {
  try {
    const pc = require('./provider').resolve(app.cfg);
    return app.session.contextAuthority.compact(pc, app.cfg, { reason: 'phase-boundary' });
  } catch { return null; }
}

/** For the window and the CLI: the last automatic continuation and the budget left. */
function view(session) {
  const c = state(session);
  return {
    last: c.last, log: c.log.slice(-6),
    budget: { noProgress: BUDGET.noProgress - c.noProgress, providerRestarts: BUDGET.providerRestarts - c.providerRestarts, crashResumes: BUDGET.crashResumes - c.crashResumes },
  };
}

/**
 * DOES THE GOAL CONTINUE PAST THIS MODEL TURN? A cue, or null.
 *
 * Read from the model's OWN closing words, never guessed: the last few sentences announce a next action ("Next I'll
 * update the tests", "Now I need to wire the route", "Remaining: …") and the reply is neither a question to the person
 * nor a stated blocker, and the task's outcome is not already satisfied by evidence (discipline arbiter). A closing
 * that claims the work is finished is an ending; the completion checks decide whether that claim holds.
 */
const INTENT = /\b(?:next,?\s+i(?:'ll| will)|i(?:'ll| will)\s+(?:now\s+|next\s+|then\s+)?(?:update|add|run|fix|check|verify|write|implement|create|move|change|look|continue|proceed|start|finish|handle|wire|test|refactor|remove|apply|patch|edit|try|re-?run|inspect|investigate|address|complete)|let me\s+(?:now\s+|next\s+)?(?:update|add|run|fix|check|verify|write|implement|create|continue|proceed|wire|test|finish|look|inspect)|(?:now|next)\s+(?:i\s+)?(?:need|have)\s+to|still\s+(?:need|needs|to\s+do|remaining|left)|not\s+(?:yet\s+)?(?:done|finished|complete))\b|\bremaining\s*(?:work|steps?)?\s*:/i;
const FINISHED = /^\W*(?:fixed|done|completed?|finished|verified|resolved)\b|\b(?:(?:fixed|done|completed?) and (?:verified|tested)|all (?:done|set|tests pass(?:ing)?)|(?:task|work|change|fix|implementation) (?:is )?(?:now )?(?:complete|done|finished)|that(?:'s| is) (?:it|everything)|nothing (?:else|more|further) (?:to do|remains))\b/i;
function lastSentences(text, n = 3) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z0-9*_`-])/);
  return parts.slice(-n).join(' ');
}
function goalCue(session, record) {
  // THE CLOSING WORDS ARE THE LAST STEP'S: record.text joins every step's prose, and an early "I will look into it"
  // followed by "Fixed and verified." is a finished turn, not an announcement.
  const narr = (record && Array.isArray(record.narration)) ? record.narration : [];
  const text = String((narr.length ? narr[narr.length - 1].text : record && record.text) || '').trim();
  if (!text) return null;
  const tail = lastSentences(text, 3);
  const wk = require('./wakeup');
  if (/\?\s*[`*_)\]"'»]*\s*$/.test(tail) || wk.statesBlocker(text)) return null;
  const m = INTENT.exec(tail);
  if (!m) return null;
  if (FINISHED.test(lastSentences(text, 1)) && !INTENT.test(lastSentences(text, 1))) return null;
  try { if (require('./discipline/arbiter').outcomeSatisfied(session.lifecycle)) return null; } catch { /* no discipline state: the words decide */ }
  const at = tail.lastIndexOf(m[0]);
  const next = tail.slice(Math.max(0, tail.lastIndexOf('.', at) + 1)).trim().slice(0, 300);
  return { next: next || m[0] };
}

/**
 * THE CONTINUATION, FROM THE GOAL — not from the last sentence. The continuity digest (discipline/digest.js) carries
 * OUTCOME · ASKS · CRITERIA · FACTS · CHANGES · CHECKS · OPEN QUESTIONS · BLOCKERS; the model's own named next step is
 * ORIENTATION, which evidence may overrule. Noema owns continuity and honesty; the model owns the tactics.
 */
function goalInstruction(session, record, cue) {
  let state = '';
  try { state = require('./discipline/digest').digest(session.lifecycle, { cwd: session.cwd }); } catch { state = ''; }
  const objective = (session.task && session.task.objective) || '';
  const lines = ['CONTINUE THE SAME GOAL — this is the next model turn of the task in hand, not a new request.'];
  if (!state && objective) lines.push(`GOAL: ${String(objective).slice(0, 600)}`);
  if (state) lines.push(state);
  lines.push(`You last named this as the next useful step (orientation, not an order): "${cue.next}"`);
  lines.push('Decide from the evidence what actually remains. If a step no longer makes sense, change course. '
    + 'Do not redo settled work or re-read files to re-establish it. If the goal is already met, verify proportionately, say so plainly, and stop.');
  const note = record ? failureNote(record) : '';
  if (note) lines.push(note);
  return lines.join('\n');
}

module.exports = { goalCue, goalInstruction, decide, onRecovered, scheduleRecovery, reset, state, view, instruction, wait, compactBoundary, BUDGET, RESTART_DELAYS_MS, AUTOMATIC, FRESH_MS };
