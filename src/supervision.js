'use strict';

/**
 * CHAT SUPERVISES THE CODING AGENT — without racing it.
 *
 * Chat and the Coding Agent are the two threads of ONE session (sessionviews.js).
 * While the Agent works, Chat does not generate new coding prompts: it waits
 * for an AUTHORITATIVE checkpoint (a finished turn: the plan, the findings, the
 * verification, what landed) and only then helps the person decide what next.
 *
 *   WHILE THE AGENT RUNS, a Chat message is handled here, with no model call:
 *     status question   → the Agent's state, from Core ("Phase 2 · Implementing")
 *     urgent steer      → LAIN asks: [Steer now] (applied at the next safe step
 *                         boundary) or [Wait for checkpoint] — with the cost said
 *     anything else     → a PENDING STEER, compared with the next checkpoint
 *   AT A CHECKPOINT (checkpoint()):
 *     a PHASE SUMMARY — landed / found / remaining / failed / recommended next
 *     change — goes to Chat automatically, with the actions the person needs
 *     (Continue plan · Review problem · Discuss · Pause); pending steers are put
 *     to the person; the run strategy decides whether LAIN continues on its own.
 *   FINDINGS are structured Core state (report_finding): severity, summary,
 *     evidence, affected work, possible fix, blocking. Chat turns them into
 *     decisions; a blocking one stops Long Context Phasing.
 *   PLAN DELTAS: the APPROVED plan is never silently rewritten. A consequence
 *     the Agent had to do is recorded as added; a scope expansion is PROPOSED
 *     and waits for [Add to plan] / [Discuss] / [Leave for later].
 *   PLAN FIRST: a broad Coding request is offered [Plan in Chat first] /
 *     [Implement directly] — LAIN's workflow decision, not Agent chatter.
 *
 * Nothing here exposes model reasoning, and nothing is a second task owner:
 * the plan is session.plan, the handover is handover.js, the state is workbench.js.
 */

const wb = require('./workbench');

const CAP_TEXT = 600;
const clip = (s, n = CAP_TEXT) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

const SEVERITY = Object.freeze(['info', 'minor', 'major', 'critical']);

// ------------------------------------------------------------------- the Agent's state --

function agentRunning(app) {
  return Boolean(app && app.abort && !app.abort.signal.aborted && require('./sessionviews').current(app.session) === 'coding');
}

function phaseInfo(session) {
  const rs = require('./runstrategy');
  const shape = rs.planShape(session);
  const p = session && session.plan;
  const cur = p && typeof p.current === 'function' ? p.current() : null;
  return { total: shape.total, done: shape.done, current: cur ? { n: cur.n, text: cur.text } : null, remaining: shape.remaining.map((s) => ({ n: s.n, text: s.text })) };
}

/** Why a task can be paused for its host: a CLI closed, this Core closed mid-turn, or a host crashed (resumed by itself). */
const HOST_PAUSES = new Set(['cli-closed', 'host-closed', 'host-crashed']);

/** The session lease as surfaces draw it (sessionlease.js): { writer, pid, pausedBy, handoff, mine, request }. */
function surfaceOf(app) {
  const s = app && app.session;
  if (!s || !s.id) return null;
  try { return require('./sessionlease').view(s.id, { surface: require('./surfacehandoff').surfaceOf(app) }); } catch { return null; }
}

/** One line for the Agent's state: "Phase 2 · Implementing". */
function statusLine(app) {
  const s = app.session;
  const ph = phaseInfo(s);
  const w = wb.of(s);
  if (w.quota && w.quota.state === 'QUOTA_PAUSED') return `Paused · ${w.quota.provider || 'the provider'} limit reached`;
  // THE EXECUTION HOST (a CLI, or this window's own Core) closed while the task had work left — named for what closed
  // (spec §111: "Paused · CLI closed"); a Core that closed or a host that crashed mid-turn is the execution host.
  const lease = surfaceOf(app);
  if (lease && HOST_PAUSES.has(lease.pausedBy) && !agentRunning(app)) return lease.pausedBy === 'cli-closed' ? 'Paused · CLI closed' : 'Paused · execution host closed';
  const cont = w.autoRun && w.autoRun.waiting;
  if (cont && cont.until > Date.now()) return `Restarting · ${cont.why || 'the provider failed'}`;
  if (agentRunning(app)) return ph.current ? `Phase ${ph.current.n}${ph.total ? ` of ${ph.total}` : ''} · Implementing` : 'Implementing';
  if (ph.total && ph.done === ph.total) return 'Plan complete';
  if (w.strategy.pausedForReview) return `Paused · ${w.strategy.pausedForReview}`;
  return ph.total ? `Idle · ${ph.done} of ${ph.total} phases done` : 'Idle';
}

// ------------------------------------------------------------------- pending steers --

function addSteer(session, text, from = 'chat') {
  const w = wb.of(session);
  const s = { id: wb.id('st'), text: clip(text, 1000), from, at: Date.now(), state: 'PENDING' };
  w.steers.push(s);
  return s;
}
function pendingSteers(session) { return wb.of(session).steers.filter((s) => s.state === 'PENDING'); }
function settleSteers(session, ids, state) {
  const set = new Set(ids);
  for (const s of wb.of(session).steers) if (set.has(s.id) && s.state === 'PENDING') { s.state = state; s.settledAt = Date.now(); }
}

const STATUS_RE = /^(?:what(?:'s| is)\s+(?:it|the agent|the coding agent)\s+doing|status|progress|how(?:'s| is)\s+it\s+going|how far|where are we)\b/i;
const URGENT_RE = /^(?:stop|halt|quit|don'?t|do not|never)\b|\bstop (?:doing|changing|touching|editing|using)\b|\binstead\b|\bright now\b|\bimmediately\b/i;

/**
 * A CHAT MESSAGE WHILE THE AGENT RUNS. Deterministic; returns what Chat shows.
 * { kind: 'status'|'urgent'|'pending', text, offer?, steer? }
 */
function chatWhileRunning(app, text) {
  const r = classifyWhileRunning(app, text);
  const w = wb.of(app.session);
  w.notes.push({ id: wb.id('nt'), at: Date.now(), kind: r.kind, you: clip(text, 1000), lain: r.text, offerId: r.offer ? r.offer.id : null });
  if (w.notes.length > wb.MAX.notes) w.notes = w.notes.slice(-wb.MAX.notes);
  return r;
}

function classifyWhileRunning(app, text) {
  const s = app.session;
  const t = String(text || '').trim();
  if (STATUS_RE.test(t)) return { kind: 'status', text: `${statusLine(app)}. Waiting for the Agent's next checkpoint before preparing a steer.`, state: state(app) };
  if (URGENT_RE.test(t)) {
    const o = wb.offer(s, 'URGENT_STEER', {
      steer: clip(t, 1000), choices: ['now', 'wait'],
      text: 'This will interrupt or widen the current task and may consume significantly more usage.',
    });
    return { kind: 'urgent', text: `${o.text} Steer now (applied at the next safe step boundary) or wait for the checkpoint?`, offer: o };
  }
  const st = addSteer(s, t, 'chat');
  const ph = phaseInfo(s);
  return { kind: 'pending', steer: st, text: `Pending steer: ${st.text}\n${ph.current ? `Phase ${ph.current.n} · Implementing. ` : ''}I'll compare it with the Agent's next checkpoint before suggesting a change.` };
}

// ------------------------------------------------------------------- findings & deltas --

/**
 * A FINDING FROM THE AGENT (the report_finding tool, or LAIN's own verification).
 * `addsWork` is work beyond the approved plan: a small consequence is recorded
 * as added; anything else is a PROPOSED delta awaiting the person.
 */
function reportFinding(session, f = {}, source = 'agent') {
  const w = wb.of(session);
  const sev = SEVERITY.includes(String(f.severity || '').toLowerCase()) ? String(f.severity).toLowerCase() : 'minor';
  const ph = phaseInfo(session);
  const finding = {
    id: wb.id('fd'), severity: sev, summary: clip(f.summary, 300), blocking: f.blocking === true,
    evidence: (Array.isArray(f.evidence) ? f.evidence : f.evidence ? [f.evidence] : []).map((x) => clip(x, 240)).slice(0, 8),
    affected: (Array.isArray(f.affected) ? f.affected : f.affected ? [f.affected] : []).map((x) => clip(x, 200)).slice(0, 8),
    possibleFix: f.possibleFix || f.possible_fix ? clip(f.possibleFix || f.possible_fix, 600) : null,
    phase: ph.current ? ph.current.n : null, at: Date.now(), state: 'OPEN', source,
  };
  if (!finding.summary) return { ok: false, why: 'a finding needs a summary' };
  w.findings.push(finding);
  let delta = null;
  const adds = f.addsWork || f.adds_work;
  if (adds) delta = addDelta(session, { text: adds, kind: f.consequence === true ? 'CONSEQUENCE' : 'SCOPE', findingId: finding.id });
  return { ok: true, finding, delta };
}
function addDelta(session, { text, kind = 'SCOPE', findingId = null }) {
  const w = wb.of(session);
  const d = { id: wb.id('dl'), text: clip(text, 400), kind, findingId, at: Date.now(), state: kind === 'CONSEQUENCE' ? 'AUTO_ADDED' : 'PROPOSED' };
  w.deltas.push(d);
  if (kind === 'CONSEQUENCE' && session.plan && typeof session.plan.steer === 'function') {
    try { session.plan.steer(`consequence of the approved plan: ${d.text}`, { append: [d.text] }); } catch { /* the delta is still recorded */ }
  }
  return d;
}
function openFindings(session) { return wb.of(session).findings.filter((f) => f.state === 'OPEN'); }

// ------------------------------------------------------------------- checkpoint --

/** The last verification run, when it failed (verifycontract.js keeps `runs`). */
function failedVerification(session) {
  const runs = (session && session.verification && Array.isArray(session.verification.runs)) ? session.verification.runs : [];
  const last = runs[runs.length - 1];
  return last && last.ok === false ? last : null;
}

/** Reasons a person must look before LAIN continues on its own. */
function problems(app, record) {
  const s = app.session;
  const out = [];
  for (const f of openFindings(s)) if (f.blocking) out.push(`blocking finding: ${f.summary}`);
  for (const d of wb.of(s).deltas) if (d.state === 'PROPOSED') out.push(`scope expansion to review: ${d.text}`);
  const life = s.lifecycle;
  if (life && (life.state === 'NEEDS_USER' || life.state === 'WAITING_FOR_USER')) out.push('the Agent is waiting for you');
  if (failedVerification(s)) out.push('verification failed — the strategy may need to change');
  if (wb.of(s).quota && wb.of(s).quota.state === 'QUOTA_PAUSED') out.push('the provider limit was reached');
  // HOW THE TURN ENDED is not listed here any more: `the turn ended: aborted` paused every recoverable
  // ending. The ending is classified (turnoutcome.js) and the continuation policy weighs it (autocontinue.js).
  return out;
}

/** Endings after which the window shows no "Continue?" card: the person stopped it, or the quota pause says it all. */
const QUIET_STOPS = new Set(['CANCELLED', 'QUOTA_EXHAUSTED', 'PROVIDER_RATE_LIMIT']);

/**
 * A CODING TURN ENDED: summarise the phase for Chat, put pending steers and
 * deltas to the person, apply a queued profile change, classify the ending and
 * decide — by the run strategy and the continuation policy — whether the TASK
 * carries on. Returns { phase, next?, cause?, delayMs?, compact? } where `next`
 * is the instruction for the next model turn when it does.
 */
function checkpoint(app, record) {
  const s = app.session;
  if (!s || !record) return null;
  const w = wb.of(s);
  const prev = w.phases[w.phases.length - 1];
  const since = prev ? prev.at : 0;
  const ph = phaseInfo(s);
  const steps = (s.plan && s.plan.steps) || [];
  const at = (x) => (typeof x.completedAt === 'number' ? x.completedAt : Date.parse(x.completedAt || '') || 0);
  const landed = steps.filter((x) => x.status === require('./plan').STATUS.DONE && at(x) > since).map((x) => clip(`${x.n}. ${x.text}${x.note ? ` — ${x.note}` : ''}`, 200));
  const files = [...new Set((record.mutations || []).map((m) => m && (m.path || m.file)).filter(Boolean))];
  if (!landed.length && files.length) landed.push(`${files.length} file(s) changed: ${files.slice(0, 5).join(', ')}`);
  const found = w.findings.filter((f) => f.at > since).map((f) => ({ id: f.id, severity: f.severity, summary: f.summary, blocking: f.blocking, possibleFix: f.possibleFix }));
  const failed = [];
  const recovered = [];
  const fv = failedVerification(s);
  if (fv) failed.push(clip(`${fv.command || 'verification'} failed${(fv.failures || []).length ? `: ${fv.failures.slice(0, 3).map((x) => (typeof x === 'string' ? x : x.name || x.message || '')).join('; ')}` : ''}`, 240));
  // A TOOL ERROR THE MODEL SAW AND WORKED PAST is not a failure of the phase: it is listed as recovered.
  for (const e of record.errors || []) (e && e.kind === 'TOOL' && !e.fatal ? recovered : failed).push(clip(e.message || e.kind, 200));
  const open = openFindings(s);
  const recommended = (open.find((f) => f.blocking && f.possibleFix) || open.find((f) => f.possibleFix) || null);
  const probs = problems(app, record);
  // HOW THE TURN ENDED, once (turnoutcome.js) — the phase record carries it, and the continuation policy weighs it.
  const cls = require('./turnoutcome').classify(record, { session: s, hostClosing: Boolean(app.wantExit) });
  const doneSince = steps.filter((x) => x.status === require('./plan').STATUS.DONE && at(x) > since).length;
  const usage = record.usage ? { input: record.usage.inputTokens || 0, output: record.usage.outputTokens || 0, cacheRead: record.usage.cacheReadTokens || 0 } : null;
  const phase = {
    id: wb.id('ph'), at: Date.now(), turnId: record.turnId || null,
    n: ph.done + (ph.current ? 0 : 0), title: ph.done && ph.total ? `Phase ${ph.done} of ${ph.total}` : 'Checkpoint',
    complete: ph.total > 0 && ph.done === ph.total,
    landed, found, failed: failed.slice(0, 6), recovered: recovered.slice(0, 6),
    remaining: ph.remaining.map((x) => `${x.n}. ${x.text}`).slice(0, 8),
    recommended: recommended ? { findingId: recommended.id, text: recommended.possibleFix } : (ph.remaining[0] ? { text: `Continue with ${ph.remaining[0].n}. ${ph.remaining[0].text}` } : null),
    problems: probs, usage, outcome: { kind: cls.outcome, label: cls.label, why: cls.why }, doneCount: ph.done,
  };
  w.phases.push(phase);
  // THE PHASE IS COMMITTED (taskcheckpoint.js): the position it closed at is durable before anything continues.
  try { phase.checkpoint = require('./taskcheckpoint').commit(s, phase.title, { phaseId: phase.id }).generation; } catch { /* the phase record stands */ }
  // A PROFILE CHANGE ASKED FOR MID-RUN applies here — the safe boundary.
  const applied = require('./runstrategy').applyPendingProfile(app);
  if (applied) phase.profileApplied = applied;
  // PENDING STEERS: compared with this checkpoint by the person, not injected.
  const pend = pendingSteers(s);
  if (pend.length) wb.offer(s, 'PENDING_STEERS', { steers: pend.map((x) => ({ id: x.id, text: x.text })), choices: ['send', 'discuss', 'drop'], phaseId: phase.id });
  for (const d of w.deltas.filter((x) => x.state === 'PROPOSED' && !x.offered)) {
    d.offered = true;
    wb.offer(s, 'PLAN_DELTA', { deltaId: d.id, text: `The Agent found work beyond the approved plan: ${d.text}`, choices: ['add', 'discuss', 'later'] });
  }
  const decision = require('./runstrategy').afterPhase(s, probs, { record, cls, planDoneBefore: ph.done - doneSince });
  phase.decision = { continue: decision.continue, why: decision.why || null, cause: decision.cause || null };
  const strat = w.strategy.kind;
  // A REAL PAUSE says why and offers Continue; a plain answer (no plan) and a person's own Stop say nothing more.
  const pauses = !decision.continue && !QUIET_STOPS.has(cls.outcome) && (ph.total > 0 || probs.length || decision.needsUser || !cls.continuable);
  if (pauses) {
    if (!phase.complete) w.strategy.pausedForReview = decision.why;
    wb.offer(s, 'PHASE_REVIEW', { phaseId: phase.id, outcome: cls.outcome, choices: phase.complete ? ['discuss'] : ['continue', 'review', 'discuss', 'pause'], text: phase.complete ? 'The plan is complete.' : decision.why });
  }
  // THE MID-JOURNEY FAST OFFER — LAIN's, at a safe checkpoint, once per strategy run.
  const prof = require('./profile').of(s, app.cfg);
  if (decision.continue === false && strat !== 'NORMAL' && ph.remaining.length >= 2 && prof === 'NORMAL' && !w.offers.some((o) => o.kind === 'FAST_OFFER' && o.at > (w.strategy.since || 0))) {
    wb.offer(s, 'FAST_OFFER', { choices: ['fast', 'keep'], text: 'Want to finish this more quickly? Fast reduces planning and narration and uses narrower execution paths while keeping required verification.' });
  }
  if (decision.continue) {
    w.strategy.pausedForReview = null;
    // A CONTINUATION SUPERSEDES the last checkpoint's open question — the task is moving again.
    for (const o of wb.openOffers(s)) if (o.kind === 'PHASE_REVIEW') wb.settleOffer(s, o.id, 'SUPERSEDED');
    return { phase, next: decision.prompt || require('./runstrategy').nextPhasePrompt(s), cause: decision.cause || 'phase-continue', delayMs: decision.delayMs || 0, compact: Boolean(decision.compact) };
  }
  // A HOST THAT CLOSED MID-TURN is recorded by the lease release on its way out (sessionlease.js), not here.
  return { phase };
}

// ------------------------------------------------------------------- plan first --

const BROAD_RE = /\b(rewrite|redesign|re-?architect\w*|overhaul|migrate|replace (?:the )?(?:\w+ )?(?:routing|architecture|system|owner|provider|framework|storage)|(?:session|state|data) ownership|across (?:the |all |every )?(?:\w+ )?(?:modules?|files?|surfaces?|projects?|systems?)|cross[- ]project|whole (?:app|codebase|system)|entire (?:app|codebase|system|\w+ tab)|every (?:module|surface|file))\b/i;
const SMALL_RE = /^(?:rename|fix (?:the |a )?(?:typo|test|bug in)|run (?:the )?tests?|add (?:a )?test|explain|why|what|format|lint|update (?:the )?version)\b/i;
const SYSTEMS = ['model', 'provider', 'session', 'cli', 'harness', 'ui', 'api', 'database', 'auth', 'routing', 'scheduler', 'usage', 'settings', 'ide', 'chat', 'agent', 'storage', 'telegram'];

/** Is this Coding request broad enough to suggest planning first? */
function isBroad(text) {
  const t = String(text || '').trim();
  if (!t || SMALL_RE.test(t)) return false;
  if (BROAD_RE.test(t)) return true;
  const low = t.toLowerCase();
  const touched = SYSTEMS.filter((w) => new RegExp(`\\b${w}s?\\b`).test(low));
  return touched.length >= 3 && t.length > 60;
}

function planFirstOffer(session, text) {
  return wb.offer(session, 'PLAN_FIRST', { request: clip(text, 4000), choices: ['plan', 'direct'], text: 'This touches several systems.' });
}

// ------------------------------------------------------------------- Chat's view --

/**
 * WHAT CHAT KNOWS OF THE AGENT — compact, authoritative, never the transcript.
 * Rides the Chat thread's live context (promptparts).
 */
function chatContext(app) {
  const s = app.session;
  const w = wb.of(s);
  const ph = phaseInfo(s);
  if (!ph.total && !w.findings.length && !w.steers.length && !w.phases.length) return '';
  const lines = ['# The Coding Agent (Core state — not its transcript)', `Status: ${statusLine(app)}.`];
  if (ph.total) lines.push(`Plan: ${ph.done}/${ph.total} phases done.${ph.remaining.length ? ` Remaining: ${ph.remaining.slice(0, 5).map((x) => `${x.n}. ${x.text}`).join(' · ')}` : ''}`);
  const last = w.phases[w.phases.length - 1];
  if (last) lines.push(`Last checkpoint: landed ${last.landed.slice(0, 4).join('; ') || 'nothing new'}${last.failed.length ? `; failed ${last.failed.slice(0, 2).join('; ')}` : ''}.`);
  const open = openFindings(s);
  for (const f of open.slice(0, 5)) lines.push(`Finding (${f.severity}${f.blocking ? ', blocking' : ''}): ${f.summary}${f.evidence.length ? ` [evidence: ${f.evidence.slice(0, 3).join('; ')}]` : ''}${f.possibleFix ? ` — possible fix: ${f.possibleFix}` : ''}`);
  if (w.discussing) { const f = w.findings.find((x) => x.id === w.discussing); if (f) lines.push(`The person wants to DISCUSS this finding now: ${f.summary}. Affected: ${f.affected.join('; ') || 'not stated'}. Recommend a fix and explain it; the person decides before anything is sent to the Agent.`); }
  const pend = pendingSteers(s);
  if (pend.length) lines.push(`Pending steers (not yet sent): ${pend.map((x) => x.text).join(' · ')}`);
  const deltas = w.deltas.filter((d) => d.state === 'PROPOSED');
  if (deltas.length) lines.push(`Proposed scope additions awaiting the person: ${deltas.map((d) => d.text).join(' · ')}`);
  if (agentRunning(app)) lines.push('The Agent is still working: do not write new implementation instructions; wait for its checkpoint.');
  return lines.join('\n');
}

/** The state the window draws (S.workbench). */
function state(app) {
  const s = app.session;
  const w = wb.of(s);
  const prof = require('./profile');
  return {
    status: statusLine(app), running: agentRunning(app), phase: phaseInfo(s),
    strategy: { ...w.strategy, label: require('./runstrategy').LABEL[w.strategy.kind] },
    profile: prof.of(s, app.cfg), pendingProfile: w.pendingProfile,
    mode: require('./execmode').of(s), modeApplies: require('./execmode').effective(app, s),   // permission mode (S5)
    steers: w.steers.slice(-20), findings: w.findings.slice(-20), phases: w.phases.slice(-10), deltas: w.deltas.slice(-20),
    offers: wb.openOffers(s), quota: w.quota, discussing: w.discussing || null, surface: surfaceOf(app), notes: (w.notes || []).slice(-20),
    // THE LAST AUTOMATIC CONTINUATION (and a restart being waited out), with its cause — autocontinue.js.
    autoRun: { ...require('./autocontinue').view(s), waiting: (w.autoRun && w.autoRun.waiting && w.autoRun.waiting.until > Date.now()) ? w.autoRun.waiting : null },
    hostPaused: (() => { const l = surfaceOf(app); return Boolean(l && HOST_PAUSES.has(l.pausedBy)); })(),
  };
}

module.exports = { failedVerification, chatWhileRunning, reportFinding, addDelta, addSteer, pendingSteers, settleSteers, openFindings, checkpoint, problems, isBroad, planFirstOffer, chatContext, state, statusLine, agentRunning, phaseInfo, SEVERITY };
