'use strict';

/** THE WORKBENCH ROUTES — Chat supervising the Coding Agent, the run strategy, the execution profile, quota Continue, and "Send to Coding Agent". */

const wb = require('../workbench');
const sup = require('../supervision');
const rs = require('../runstrategy');
const sv = require('../sessionviews');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400, extra = {}) { return { code, body: { ok: false, why: String(why || 'refused'), ...extra } }; }
function save(app) { try { app.session.save(); } catch { /* in memory */ } }
function running(app) { return Boolean(app.abort && !app.abort.signal.aborted); }

function startCoding(app, text, from = null, { sameTask = false } = {}) {
  return require('./viewroutes').submit(app, { view: 'coding', text, direct: true, sameTask, ...(from ? { fromLabel: from } : {}) });
}
function startChat(app, text) { return require('./viewroutes').submit(app, { view: 'chat', text }); }

/** Steer the Agent: a running turn takes it at the next step boundary; an idle Agent starts a turn on the same task. */
function steerAgent(app, text) {
  if (running(app) && sv.current(app.session) === 'coding') { app.queueSteer(text, 'NOW'); return ok({ steered: true, when: 'NOW' }); }
  return startCoding(app, text);
}

async function answer(app, body = {}) {
  const s = app.session;
  const o = wb.of(s).offers.find((x) => x.id === String(body.id || ''));
  if (!o || o.state !== 'OPEN') return bad('that question is no longer open', 409);
  const c = String(body.choice || '').toLowerCase();
  if (o.choices && !o.choices.includes(c)) return bad(`choose one of ${o.choices.join(', ')}`);
  if (o.kind === 'LONG_CONTEXT_WARNING') { const r = rs.confirm(app, o.id, c); save(app); return r.ok ? ok({ ...r, workbench: sup.state(app) }) : bad(r.why); }
  wb.settleOffer(s, o.id, 'ANSWERED', c);
  let r = ok({});
  if (o.kind === 'PLAN_FIRST') {
    if (c === 'plan') { sv.views(s).active = 'chat'; r = startChat(app, `Plan this before it is implemented — a numbered implementation plan I can review:\n\n${o.request}`); }
    else r = startCoding(app, o.request);
  } else if (o.kind === 'URGENT_STEER') {
    if (c === 'now') { if (running(app)) app.queueSteer(o.steer, 'NOW'); else r = startCoding(app, o.steer); }
    else sup.addSteer(s, o.steer, 'chat');
  } else if (o.kind === 'PENDING_STEERS') {
    const ids = (o.steers || []).map((x) => x.id);
    if (c === 'send') { sup.settleSteers(s, ids, 'SENT'); r = steerAgent(app, (o.steers || []).map((x) => x.text).join('\n')); }
    else if (c === 'drop') sup.settleSteers(s, ids, 'DROPPED');
    else sv.views(s).active = 'chat';
  } else if (o.kind === 'PLAN_DELTA') {
    const d = wb.of(s).deltas.find((x) => x.id === o.deltaId);
    if (d) {
      if (c === 'add') { d.state = 'ADDED'; if (s.plan && typeof s.plan.steer === 'function') s.plan.steer(`approved addition: ${d.text}`, { append: [d.text] }); }
      else if (c === 'later') d.state = 'DEFERRED';
      else { d.state = 'DISCUSSING'; wb.of(s).discussing = d.findingId || null; sv.views(s).active = 'chat'; }
    }
  } else if (o.kind === 'PHASE_REVIEW') {
    if (c === 'continue') {
      wb.of(s).strategy.pausedForReview = null;
      require('../autocontinue').reset(s, 'continue');
      const next = rs.nextPhasePrompt(s) || require('../autocontinue').instruction(s, { cause: 'continue' });
      r = startCoding(app, next, null, { sameTask: true });   // the next phase of THIS plan, never a new task
    }
    else if (c === 'pause') wb.of(s).strategy.pausedForReview = 'paused by you';
    else if (c === 'discuss') sv.views(s).active = 'chat';
    else { const f = sup.openFindings(s).find((x) => x.blocking) || sup.openFindings(s)[0]; r = ok({ focusFinding: f ? f.id : null }); }
  } else if (o.kind === 'FAST_OFFER') {
    if (c === 'fast') r = ok(rs.queueProfile(app, 'FAST'));
  }
  save(app);
  const b = r.body || {};
  return { code: r.code, body: { ...b, answered: o.kind, choice: c, workbench: sup.state(app) } };
}

const ROUTES = {
  'POST /api/workbench/answer': (app, body = {}) => answer(app, body),

  'POST /api/workbench/finding': async (app, body = {}) => {
    const s = app.session;
    const f = wb.of(s).findings.find((x) => x.id === String(body.id || ''));
    if (!f) return bad('no such finding', 404);
    const a = String(body.action || '');
    let r = ok({});
    if (a === 'discuss') { wb.of(s).discussing = f.id; sv.views(s).active = 'chat'; }
    else if (a === 'use-fix') {
      const fix = String(body.text || f.possibleFix || '').trim();
      if (!fix) return bad('there is no fix to send — discuss it first');
      f.state = 'ACCEPTED'; f.acceptedFix = fix; wb.of(s).discussing = null;
      r = steerAgent(app, `Approved fix for the finding "${f.summary}": ${fix}`);
    } else if (a === 'dismiss') f.state = 'DISMISSED';
    else if (a === 'resolve') f.state = 'RESOLVED';
    else return bad('action is discuss, use-fix, dismiss or resolve');
    save(app);
    return { code: r.code, body: { ...(r.body || {}), workbench: sup.state(app) } };
  },


  'POST /api/workbench/strategy': async (app, body = {}) => {
    const r = rs.request(app, body.kind, { review: body.review || null });
    if (!r.ok) return bad(r.why);
    save(app);
    return ok({ ...r, workbench: sup.state(app) });
  },

  /** THE PERMISSION MODE — Ask · Accept edits · Plan · Auto (execmode.js), the Harness's twin of Shift+Tab. */
  'POST /api/workbench/mode': async (app, body = {}) => {
    const want = require('../permrules').modeName(body.mode);
    if (!want) return bad('mode is one of ask, accept-edits, plan, auto');
    require('../execmode').set(app.session, want);
    save(app);
    return ok({ mode: want, workbench: sup.state(app) });
  },

  'POST /api/workbench/profile': async (app, body = {}) => {
    const r = rs.queueProfile(app, body.profile);
    if (!r.ok) return bad(r.why);
    save(app);
    return ok({ ...r, workbench: sup.state(app) });
  },

  /** ▶ CONTINUE PLAN — one button, whatever the state: a quota pause re-checks now and resumes; otherwise the next phase of the APPROVED plan starts… */
  'POST /api/workbench/continue': async (app) => {
    // THE PERSON PRESSED CONTINUE: the continuation budget starts again (autocontinue.js).
    require('../autocontinue').reset(app.session, 'continue');
    // PAUSED BECAUSE THE EXECUTION HOST CLOSED (a CLI, or this Core mid-turn): take the writer, reload what it left, continue the SAME task.
    const HOST = new Set(['cli-closed', 'host-closed', 'host-crashed']);
    const lease = require('../surfacehandoff').persisted(app.session.id) || (app.session.workbench && app.session.workbench.surface) || null;
    if (lease && (HOST.has(lease.pausedBy) || (lease.writer === 'cli' && require('../surfacehandoff').reapDeadCli(app.session.id)))) {
      const was = lease.pausedBy || 'cli-closed';
      const h = require('../surfacehandoff').resumeHere(app);
      if (!h.ok) return bad(h.why, 409);
      const s2 = app.session;
      if (s2.recovered) s2.recovered.autoResumeDecided = true;   // this press IS the resumption
      const text = require('../autocontinue').instruction(s2, { cause: was === 'host-crashed' ? 'auto-resume' : 'host-closed' });
      require('../sessionviews').views(s2).active = 'coding'; s2.thread = 'coding';
      wb.of(s2).strategy.pausedForReview = null;
      // ▶ CONTINUE IS THE SAME TASK by construction — never a new one that would discard the plan it continues.
      const r2 = startCoding(app, text, null, { sameTask: true });
      save(app);
      return { code: r2.code, body: { ...(r2.body || {}), resumedFrom: was, sessionId: s2.id, workbench: sup.state(app) } };
    }
    // ANOTHER SURFACE STILL HOLDS THE WRITER (a CLI that is running this session): never taken over silently.
    if (lease && lease.writer && lease.writer !== require('../surfacehandoff').surfaceOf(app)) return bad(lease.writer === 'cli' ? 'the CLI is still running this session — take it back (Continue in CLI › Take back), or close the CLI' : 'another surface holds this session', 409);
    const s = app.session;
    const w = wb.of(s);
    if (w.quota && w.quota.state === 'QUOTA_PAUSED') {
      const r = await require('../quotapause').resume(app);
      return r.ok ? ok({ ...r, workbench: sup.state(app) }) : bad(r.why, 409);
    }
    if (running(app)) return bad('the Coding Agent is working — its checkpoint comes first', 409);
    // A PAUSED TASK WITHOUT A PLAN (a provider that kept failing, a decision answered) resumes its objective.
    const paused = Boolean(w.strategy.pausedForReview) || wb.openOffers(s).some((o) => o.kind === 'PHASE_REVIEW');
    const next = rs.nextPhasePrompt(s) || (paused ? require('../autocontinue').instruction(s, { cause: 'continue' }) : null);
    if (!next) return bad('the plan has no remaining phase', 409);
    for (const o of wb.openOffers(s)) if (o.kind === 'PHASE_REVIEW') wb.settleOffer(s, o.id, 'ANSWERED', 'continue');
    w.strategy.pausedForReview = null;
    const r = startCoding(app, next, null, { sameTask: true });   // the plan's next phase: the same task
    save(app);
    return { code: r.code, body: { ...(r.body || {}), workbench: sup.state(app) } };
  },


  /** SEND TO CODING AGENT: the approved plan goes into the SAME session's Coding Agent lane and starts — no copy, no second task. */
  'POST /api/plan/send': async (app, body = {}) => {
    const s = app.session;
    const plans = require('../planhandoff');
    const p = plans.find(s, body.id) || plans.latest(s, plans.STATE.DRAFT);
    if (!p) return bad('there is no plan to send', 404);
    if (body.text && p.state === plans.STATE.DRAFT) { const e = plans.edit(s, p.id, body.text); if (!e.ok) return bad(e.why); }
    const proj = sv.project(s);
    if (!proj.attached || proj.missing) return bad('A project is required.', 409, { projectRequired: true, planId: p.id });
    if (running(app)) return bad('the Coding Agent is working — its checkpoint comes first', 409);
    const cur = plans.find(s, p.id) || p;
    const acc = cur.state === plans.STATE.DRAFT ? plans.accept(app, cur.id) : { ok: cur.state === plans.STATE.ACCEPTED, plan: cur, handoff: plans.handoff(s) };
    if (!acc.ok) return bad(acc.why || `plan is ${cur.state}`, 409);
    // THE APPROVED PLAN IS THE AGENT'S PLAN: its steps are the phases LAIN tracks.
    require('../plan').seedFromCore(s, { objective: acc.plan.title || 'Approved plan', remaining: acc.plan.steps || [] });
    wb.of(s).strategy.pausedForReview = null;
    const prompt = (acc.handoff && acc.handoff.prompt) || acc.plan.text;
    // THE SEEDED PLAN IS THE TASK: asserted by LAIN's own control, so classification never discards it as "new".
    const started = startCoding(app, prompt, null, { sameTask: true });
    save(app);
    return { code: started.code, body: { ...(started.body || {}), plan: acc.plan, workbench: sup.state(app) } };
  },
};

module.exports = { ROUTES, answer };
