'use strict';

/**
 * §19/§20 — RUNTIME PROVENANCE, FOR A PERSON TO INSPECT.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS NOT: the model's chain of thought. Nothing here is a token the
 * model produced. Every field is state LAIN's own runtime already owns —
 * which task is active, where the current turn's context came from, what
 * tools are exposed versus what actually ran. `/provenance` reads it; the
 * model is never shown it as such (see contextprovenance.js for what the
 * model IS shown, which is a different, narrower thing).
 *
 * WHY IT EXISTS. §8's defect — Computer MCP ran successfully while LAIN's own
 * governance said "No implementation target was specified" — was invisible
 * because nothing surfaced the classification a turn had actually made. A
 * wrong verdict with no window into it looks identical to a right one until
 * someone happens to hit the wrong case.
 */

const taskclass = require('./taskclass');
const toolRegistry = require('./tools');

function lastTurnOf(session) {
  const turns = Array.isArray(session.turns) ? session.turns : [];
  return turns[turns.length - 1] || null;
}

function goalSection(session) {
  const t = session.task;
  if (!t) return null;
  return {
    id: t.id, objective: t.objective, state: t.state,
    steers: (t.steers || []).length,
    executor: t.executor ? `${t.executor.provider || ''}/${t.executor.model || ''}` : null,
  };
}

function planSection(session) {
  const p = session.plan;
  if (!p) return null;
  return {
    objective: p.objective,
    total: p.steps.length,
    done: p.completed.length,
    isFinished: p.isFinished,
    currentStep: (p.remaining[0] && p.remaining[0].text) || null,
  };
}

/**
 * The chain a turn's context was actually assembled from, most-authoritative
 * first — the same ordering contextprovenance.js's AUTHORITY enum encodes,
 * reported here as PRESENT/ABSENT rather than serialized to the wire.
 */
function contextChain(app) {
  const session = app.session;
  const last = lastTurnOf(session);
  const clarify = app._clarify && typeof app._clarify.exhausted === 'boolean' ? app._clarify : null;
  return [
    { source: 'ACTUAL_USER', authority: 'ACTUAL_USER', present: true },
    { source: 'GOAL', authority: 'DURABLE_TASK', present: Boolean(session.task) },
    { source: 'PLAN', authority: 'DURABLE_TASK', present: Boolean(session.plan) },
    { source: 'HANDOVER', authority: 'CONTEXT', present: Boolean(last) },
    { source: 'PROJECT_INTELLIGENCE', authority: 'CONTEXT', present: Boolean(session.evidence && session.evidence.size() > 0) },
    { source: 'CLARIFY_BUDGET', authority: 'CONTEXT', present: Boolean(clarify && clarify.exhausted) },
    { source: 'RETIRED_TASKS', authority: 'RECOVERY', present: Boolean(Array.isArray(app._retiredTasks) && app._retiredTasks.length) },
  ];
}

/**
 * Tool exposure vs. what the last turn actually did with it.
 *
 * EXPOSED/REQUESTED/ADMITTED/REFUSED/BLOCKED is the full ladder §20 asks for;
 * only EXPOSED, EXECUTED and FAILED are things the runtime currently
 * distinguishes on the record it keeps — REQUESTED/ADMITTED/REFUSED/BLOCKED
 * would require a per-call admission log this runtime does not keep yet, so
 * this reports that honestly as a gap rather than inventing the missing
 * states from data that cannot support them.
 */
function toolDispatch(app) {
  const exposed = toolRegistry.names(app);
  const last = lastTurnOf(app.session);
  const actions = (last && last.actions) || [];
  const errors = (last && last.errors) || [];
  return {
    exposedCount: exposed.length,
    exposed,
    lastTurn: {
      executed: actions.map((a) => ({ name: a.name, target: a.target || null })),
      failed: errors.filter((e) => e.kind === 'TOOL').map((e) => e.message),
    },
    notTracked: ['REQUESTED', 'ADMITTED', 'REFUSED', 'BLOCKED'],
  };
}

/**
 * The full report. Never thrown — a diagnostic that can crash the thing it is
 * diagnosing is worse than one that says less.
 */
function report(app) {
  try {
    const session = app.session;
    const last = lastTurnOf(session);
    return {
      session: { id: session.id || null, cwd: session.cwd || null },
      turn: {
        lastTurnId: last && last.turnId || null,
        stopReason: last && last.stopReason || null,
        steps: last && last.steps || 0,
        taskClass: session.taskClassVerdict ? taskclass.statusLine(session.taskClassVerdict) : null,
      },
      intent: { source: 'ACTUAL_USER', turnId: last && last.turnId || null },
      goal: goalSection(session),
      plan: planSection(session),
      contextProvenance: contextChain(app),
      toolDispatch: toolDispatch(app),
      retiredTasks: Array.isArray(app._retiredTasks) ? app._retiredTasks.slice(-5) : [],
    };
  } catch (e) {
    return { error: `provenance report failed: ${e.message}` };
  }
}

/** Terminal rows, in the shape /status already uses. */
function rows(app) {
  const r = report(app);
  if (r.error) return [['error', r.error]];
  const out = [];
  out.push(['session', `${r.session.id || '(none)'}  ${r.session.cwd || ''}`]);
  out.push(['task class', r.turn.taskClass || '(not classified this turn)']);
  out.push(['last turn', `${r.turn.lastTurnId || '(none)'} — ${r.turn.stopReason || 'n/a'} — ${r.turn.steps} step(s)`]);
  out.push(['goal', r.goal ? `${r.goal.objective} [${r.goal.state}]` : '(none)']);
  out.push(['plan', r.plan ? `${r.plan.done}/${r.plan.total} done${r.plan.currentStep ? ` — next: ${r.plan.currentStep}` : ''}` : '(none)']);
  out.push(['context', r.contextProvenance.filter((c) => c.present).map((c) => c.source).join(', ') || '(user only)']);
  out.push(['tools exposed', String(r.toolDispatch.exposedCount)]);
  out.push(['tools executed (last turn)', r.toolDispatch.lastTurn.executed.map((a) => a.name).join(', ') || '(none)']);
  if (r.toolDispatch.lastTurn.failed.length) out.push(['tool failures (last turn)', r.toolDispatch.lastTurn.failed.join(' | ')]);
  if (r.retiredTasks.length) out.push(['retired tasks', r.retiredTasks.map((t) => t.objective).join(' | ')]);
  return out;
}

module.exports = { report, rows };
