'use strict';

/**
 * THE RUN STRATEGY — how far the Coding Agent goes before a person looks.
 * A separate dimension from EFFORT (the model's reasoning depth) and from the
 * EXECUTION PROFILE (profile.js: Normal / Fast / Eco).
 *
 *   NORMAL         the task runs to completion: model turn after model turn,
 *                  through its plan, stopping only for a real pause (a decision
 *                  for the person, a problem, a person's stop, a quota). A model
 *                  turn ending is not the task ending (autocontinue.js).
 *   PHASED         the approved plan runs phase by phase; after each phase the
 *                  summary lands in Chat and LAIN waits for Continue
 *   LONG_CONTEXT   Long Context Phasing: phase after phase toward the whole
 *                  objective, and each phase starts from a COMPACTED context —
 *                  LAIN carries its compact phase state (landed / remaining /
 *                  failed / findings / plan), never one ever-growing raw
 *                  context. The model stays disposable; the continuation is LAIN's.
 *
 * LONG CONTEXT PHASING STOPS AND ASKS when there is a product decision, an
 * architectural ambiguity (a blocking finding), a scope expansion (a proposed
 * plan delta), a permission or dangerous operation (the Agent is waiting on a
 * person), a quota concern (paused), or failed verification that needs a new
 * strategy. The review policy can ask more often: every phase, every 3 phases,
 * or only on problems (the default, "Automatic").
 *
 * IT IS NOT CARRY-ON. The removed `carryon` had LAIN decide, unasked, that a
 * model which stopped did not mean to, whenever a step counter ran out. Here
 * LAIN continues only a task with durable continuation state (the approved
 * plan's next phase, a turn a host or provider cut), from observed state, with
 * a bounded budget and the cause recorded (autocontinue.js). Pausing stops it.
 *
 * THE WARNING IS HONEST. With enough history (two phases with usage, and a
 * provider window that reported a percentage) it states a range computed from
 * those numbers; otherwise it says "High usage expected" — never a made-up figure.
 */

const wb = require('./workbench');

const KINDS = Object.freeze(['NORMAL', 'PHASED', 'LONG_CONTEXT']);
const REVIEW = Object.freeze(['AUTOMATIC', 'EVERY_PHASE', 'EVERY_3', 'ONLY_PROBLEMS']);
const LABEL = Object.freeze({ NORMAL: 'Normal', PHASED: 'Phased', LONG_CONTEXT: 'Long Context Phasing' });

function norm(k) {
  const v = String(k || '').toUpperCase().replace(/[\s-]+/g, '_');
  if (v === 'LONG' || v === 'LCP' || v === 'LONG_CONTEXT_PHASING') return 'LONG_CONTEXT';
  return KINDS.includes(v) ? v : null;
}

function get(session) { return wb.of(session).strategy; }

/** Remaining phases of the plan the Agent is carrying, and the completed ones. */
function planShape(session) {
  const p = session && session.plan;
  const ST = require('./plan').STATUS;
  const steps = p && Array.isArray(p.steps) ? p.steps.filter((s) => s.status !== ST.DROPPED) : [];
  return { total: steps.length, done: steps.filter((s) => s.status === ST.DONE).length, remaining: steps.filter((s) => s.status !== ST.DONE) };
}

/**
 * THE USAGE ESTIMATE, or an honest "high" when LAIN cannot compute one.
 * Needs: ≥2 phases with observed tokens, and a provider window that reported a
 * used percentage together with LAIN-observed tokens inside that same window.
 */
function estimate(app, session) {
  const w = wb.of(session);
  const withUsage = w.phases.filter((p) => p.usage && (p.usage.input + p.usage.output) > 0);
  const remaining = Math.max(1, planShape(session).remaining.length);
  let win = null;
  try { win = require('./resetwindows').currentForRoute(app); } catch { win = null; }
  if (withUsage.length >= 2 && win && win.usedPercent != null && win.observed && win.observed.tokens > 0 && win.usedPercent > 0) {
    const perToken = win.usedPercent / win.observed.tokens;             // % of the window per LAIN-observed token, in this window
    const tokens = withUsage.map((p) => p.usage.input + p.usage.output);
    const lo = Math.min(...tokens) * remaining * perToken;
    const hi = Math.max(...tokens) * remaining * perToken;
    const r = (x) => Math.max(1, Math.round(x));
    return { known: true, low: r(lo), high: r(Math.max(hi, lo)), window: win.label, basis: `${withUsage.length} observed phase(s) × ${remaining} remaining, against ${win.label} (${Math.round(win.usedPercent)}% used)`,
      text: `Estimated additional usage: ~${r(lo)}–${r(Math.max(hi, lo))}% of the current ${win.label} window` };
  }
  return { known: false, text: 'High usage expected.', basis: withUsage.length < 2 ? 'not enough phases observed yet to estimate' : 'the provider has not reported a usage window Noema can compare with' };
}

/**
 * ASK FOR A STRATEGY. Long Context Phasing needs the warning answered first
 * (confirm()); the others apply at once.
 */
function request(app, kind, { review = null } = {}) {
  const session = app.session;
  const k = norm(kind);
  if (!k) return { ok: false, why: `strategy is one of ${KINDS.map((x) => LABEL[x]).join(', ')}` };
  if (review && !REVIEW.includes(String(review).toUpperCase())) return { ok: false, why: `review is one of ${REVIEW.join(', ')}` };
  if (k === 'LONG_CONTEXT' && get(session).kind !== 'LONG_CONTEXT') {
    const est = estimate(app, session);
    const o = wb.offer(session, 'LONG_CONTEXT_WARNING', { review: review ? String(review).toUpperCase() : 'AUTOMATIC', estimate: est,
      text: 'Long Context Phasing may consume a substantial portion of your provider allowance.', choices: ['continue', 'eco', 'cancel'] });
    return { ok: true, needsConfirm: true, offer: o };
  }
  set(session, k, review);
  return { ok: true, strategy: get(session) };
}

/** Answer the warning: continue | eco (switch to Eco and continue) | cancel. */
function confirm(app, offerId, choice) {
  const session = app.session;
  const o = wb.of(session).offers.find((x) => x.id === offerId && x.kind === 'LONG_CONTEXT_WARNING' && x.state === 'OPEN');
  if (!o) return { ok: false, why: 'that question is no longer open' };
  const c = String(choice || '').toLowerCase();
  if (c === 'cancel') { wb.settleOffer(session, o.id, 'ANSWERED', 'cancel'); return { ok: true, strategy: get(session), cancelled: true }; }
  if (c === 'eco') queueProfile(app, 'ECO');
  set(session, 'LONG_CONTEXT', o.review);
  get(session).acknowledged = { at: Date.now(), estimate: o.estimate, choice: c };
  wb.settleOffer(session, o.id, 'ANSWERED', c);
  return { ok: true, strategy: get(session), profile: require('./profile').of(session, app.cfg), pendingProfile: wb.of(session).pendingProfile };
}

function set(session, kind, review = null) {
  const s = get(session);
  const k = norm(kind) || 'NORMAL';
  if (s.kind !== k) { s.kind = k; s.since = Date.now(); s.phasesRun = 0; s.pausedForReview = null; }
  if (review) s.review = String(review).toUpperCase();
  return s;
}

/** Is the Agent running right now in this session? */
function running(app) { return Boolean(app && app.abort && !app.abort.signal.aborted); }

/**
 * AN EXECUTION-PROFILE CHANGE while the Agent works waits for the next safe
 * boundary (a checkpoint) — it never changes a turn already in flight.
 */
function queueProfile(app, p) {
  const prof = require('./profile');
  const v = prof.normalize(p);
  if (!v) return { ok: false, why: 'profile is Normal, Fast or Eco' };
  if (running(app)) { wb.of(app.session).pendingProfile = v; return { ok: true, queued: true, pending: v }; }
  prof.set(app.session, v);
  wb.of(app.session).pendingProfile = null;
  return { ok: true, queued: false, profile: v };
}
function applyPendingProfile(app) {
  const w = wb.of(app.session);
  if (!w.pendingProfile) return null;
  const v = require('./profile').set(app.session, w.pendingProfile);
  w.pendingProfile = null;
  return v;
}

/**
 * AFTER A CODING TURN (a checkpoint): does the TASK carry on by itself, or stop for a person?
 *
 * A model turn ending is not the task ending (2026-09-29). NORMAL used to stop
 * here unconditionally — "each request is its own run" — so an eight-step plan
 * needed eight `continue`s. Every strategy now asks the same continuation
 * policy (autocontinue.js) with the ending's classification (turnoutcome.js):
 *
 *   NORMAL         the task runs until its plan is done, stopping only for a
 *                  real pause (a decision, a problem, a person, a quota)
 *   PHASED         stops after each phase for review
 *   LONG_CONTEXT   as NORMAL, and each phase starts from a COMPACTED context
 *                  (the boundary is marked `compact`); the review policy applies
 *
 * `ctx`: { record, cls, planDoneBefore } — without them (older callers, tests)
 * the turn is read as a natural end that moved the task.
 */
function afterPhase(session, problems = [], ctx = {}) {
  const s = get(session);
  const shape = planShape(session);
  const T = require('./turnoutcome');
  const record = ctx.record || { stopReason: 'end', from: 'phase-continue', toolCalls: 1 };
  const cls = ctx.cls || T.classify(record, { session });
  const d = require('./autocontinue').decide(session, record, cls, { problems, strategy: s.kind, planDoneBefore: ctx.planDoneBefore == null ? null : ctx.planDoneBefore });
  if (!d.continue) {
    return { continue: false, why: d.why, complete: Boolean(d.complete), needsUser: Boolean(d.needsUser), outcome: cls.outcome, ...(problems.length ? { problems } : {}) };
  }
  if (s.kind === 'LONG_CONTEXT' && d.cause === 'phase-continue') {
    s.phasesRun += 1;
    if (s.review === 'EVERY_PHASE') return { continue: false, why: 'review policy: every phase', outcome: cls.outcome };
    if (s.review === 'EVERY_3' && s.phasesRun % 3 === 0) return { continue: false, why: 'review policy: every 3 phases', outcome: cls.outcome };
  }
  return { continue: true, next: shape.remaining[0] || null, prompt: d.prompt, cause: d.cause, delayMs: d.delayMs || 0, outcome: cls.outcome,
    compact: s.kind === 'LONG_CONTEXT' && d.cause === 'phase-continue', why: d.why };
}

/**
 * THE NEXT PHASE'S INSTRUCTION — composed from observed state, short, and only
 * ever for a plan the person approved. The plan, findings and handover facts
 * already ride the Agent's context; this names the phase and the carried state.
 */
function nextPhasePrompt(session) {
  const shape = planShape(session);
  const next = shape.remaining[0];
  if (!next) return null;
  const w = wb.of(session);
  const last = w.phases[w.phases.length - 1];
  // ADVISORY, NOT CHOREOGRAPHY (2026-10-01): the plan is memory and orientation. The model owns tactics; evidence may
  // reorder, merge, replace or drop steps (plan_write) — Noema owns continuity, truth and completion honesty.
  const bits = [`Continue the task. Next in your plan: phase ${next.n} — ${next.text} (orientation: change the plan if the evidence says so).`];
  if (last && last.landed && last.landed.length) bits.push(`Landed so far: ${last.landed.slice(0, 6).join('; ')}.`);
  const later = shape.remaining.slice(1, 4).map((s) => `${s.n}. ${s.text}`);
  if (later.length) bits.push(`After this: ${later.join(' · ')}.`);
  bits.push('Mark steps done when they are (plan_step_done), with the evidence that shows it. A finding that changes the goal itself goes to the person (report_finding); a better route to the same goal is yours to take.');
  return bits.join(' ');
}

module.exports = { KINDS, REVIEW, LABEL, norm, get, set, request, confirm, estimate, afterPhase, nextPhasePrompt, queueProfile, applyPendingProfile, planShape, running };
