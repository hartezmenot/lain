'use strict';

/** THE TASK CARRIES ON ACROSS MODEL BOUNDARIES — bounded, classified, recorded. */

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

/** THE INSTRUCTION a continuation sends — composed from durable state, never the bare word "continue". */
const LEAD = Object.freeze({
  'provider-restart': 'The provider connection failed and has been re-established; nothing in the project was lost. ',
  'auto-resume': 'The process that was running this task stopped mid-turn and LAIN recovered the session (its tool results were repaired from what actually happened on disk). ',
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

/** AFTER A CODING TURN: does the task carry on by itself? */
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

  // COMPLETED or TOOL_RECOVERABLE: the model ended its turn.
  if (!shape.remaining.length) {
    // DURABLE UNFINISHED WORK, NOT WORDS (2026-10-02).
    const unfinished = durableUnfinished(session);
    // Open asks / unmet criteria continue on their own; a standing /goal (long-lived, spans tasks) continues only
    // when the model ALSO named the next piece of work toward it.
    const cue = unfinished && unfinished.kind === 'contract' ? (goalCue(session, record) || { next: unfinished.next })
      : unfinished && unfinished.kind === 'goal' ? goalCue(session, record) : null;
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

/** AFTER A CRASH: a session loaded with a turn its process never finished (inflight.recover → session.recovered). */
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

/** A SESSION ADOPTED WITH A TURN ITS PROCESS NEVER FINISHED (App.adopt; the session loaded through inflight.recover). */
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
  // A crash reopens the session; nothing sends a turn — ▶ Continue (the person) resumes it.
  rec.autoResumeDecided = true; pause('the execution host stopped mid-turn');
  return { scheduled: false, why: 'not a recent crash — ▶ Continue resumes it' };
}

/** A RESTART WAITED OUT, CANCELLABLY. */
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

/** LONG CONTEXT PHASING'S BOUNDARY: the next phase starts from a compacted context, through the one authority that may compact… */
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

/** DOES THE GOAL CONTINUE PAST THIS MODEL TURN? */
const INTENT = /\b(?:next,?\s+i(?:'ll| will)|i(?:'ll| will)\s+(?:now\s+|next\s+|then\s+)?(?:update|add|run|fix|check|verify|write|implement|create|move|change|look|continue|proceed|start|finish|handle|wire|test|refactor|remove|apply|patch|edit|try|re-?run|inspect|investigate|address|complete)|let me\s+(?:now\s+|next\s+)?(?:update|add|run|fix|check|verify|write|implement|create|continue|proceed|wire|test|finish|look|inspect)|(?:now|next)\s+(?:i\s+)?(?:need|have)\s+to|still\s+(?:need|needs|to\s+do|remaining|left)|not\s+(?:yet\s+)?(?:done|finished|complete))\b|\bremaining\s*(?:work|steps?)?\s*:/i;
const FINISHED = /^\W*(?:fixed|done|completed?|finished|verified|resolved)\b|\b(?:(?:fixed|done|completed?) and (?:verified|tested)|all (?:done|set|tests pass(?:ing)?)|(?:task|work|change|fix|implementation) (?:is )?(?:now )?(?:complete|done|finished)|that(?:'s| is) (?:it|everything)|nothing (?:else|more|further) (?:to do|remains))\b/i;
function lastSentences(text, n = 3) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z0-9*_`-])/);
  return parts.slice(-n).join(' ');
}
/** WHAT DURABLE STATE SAYS IS STILL OPEN — or null. */
function durableUnfinished(session) {
  const life = session && session.lifecycle;
  const d = life && life.discipline;
  if (life && life.state && life.state !== 'ACTIVE') return null;
  const verdict = d && d.verdict && d.verdict.state;
  if (verdict && ['DONE', 'DONE_UNVERIFIED', 'BLOCKED', 'NEEDS_DECISION'].includes(verdict)) return null;
  try {
    if (d && d.contract.asks.length > 1) { const open = d.contract.openAsks(); if (open.length) return { kind: 'contract', next: `address the open ask ${open[0].id}: ${String(open[0].text).slice(0, 120)}` }; }
    if (d) {
      const gen = life.mutationSeq || 0;
      const unmet = d.contract.liveCriteria().filter((c) => !require('./discipline/arbiter').criterionHolds(c, d, gen));
      if (unmet.length) return { kind: 'contract', next: `evidence the acceptance criterion ${unmet[0].id}` };
    }
  } catch { /* no contract: fall through to the goal */ }
  const g = session && session.goal;
  if (g && g.text) return { kind: 'goal', next: `continue toward the goal: ${String(g.text).slice(0, 160)}` };
  return null;
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

/** THE CONTINUATION, FROM THE GOAL — not from the last sentence. */
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
