'use strict';

/** THE FINAL SMOKE — ONE EXECUTOR of the verification contract, for the tiers that ask for broad proof. */

const path = require('path');

/** Plan steps that ARE the final smoke carry this origin. */
const ORIGIN = 'final-smoke';
const SMOKE_WORD = /\bsmoke\b/i;

const cache = new Map();   // cwd -> { at, suite }
const TTL_MS = 5000;

/** The suite that plays the final-smoke role here: { command, kind } or null. */
function suite(cwd) {
  if (!cwd) return null;
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.suite;
  let s = null;
  try {
    const testing = require('./testing');
    const report = testing.discover(cwd);
    const smoke = report.suites.find((x) => x.kind === testing.KIND.SMOKE);
    const primary = smoke || testing.primary(report);
    if (primary && primary.command) s = { command: primary.command, kind: smoke ? 'SMOKE' : 'SUITE' };
  } catch { s = null; }
  cache.set(cwd, { at: Date.now(), suite: s });
  return s;
}

const flat = (c) => String(c || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Is this command (or run_tests call) the final suite? */
function isFinal(cwd, name, input = {}) {
  const s = suite(cwd);
  if (!s) return false;
  if (name === 'run_tests') {
    const cmd = flat(input.command);
    if (!cmd) return String(input.which || 'project').toLowerCase() === (s.kind === 'SMOKE' ? 'smoke' : 'project');
    return cmd === flat(s.command);
  }
  if (/^run_/.test(name)) return flat(input.command) === flat(s.command);
  return false;
}

/** The task's final-smoke state from the lifecycle's record. */
function state(life, cwd) {
  if (!life || !life.evidence || !life.evidence.filesChanged || !life.evidence.filesChanged.size) return 'NOT_REQUIRED';
  if (!suite(cwd)) return 'NOT_REQUIRED';
  if (!required(life, cwd)) return 'NOT_REQUIRED';
  const sm = life.smoke;
  if (!sm || sm.seq !== (life.mutationSeq || 0)) return 'MISSING';
  if (sm.running) return 'RUNNING';
  return sm.ok ? 'PASSED' : 'FAILED';
}

/** Does the verification contract ask for the broad suite for what this task changed? */
function required(life, cwd) {
  const rels = [...life.evidence.filesChanged].map((p) => path.relative(cwd || process.cwd(), String(p)).replace(/\\/g, '/'));
  try { return require('./verifycontract').requirement(cwd || process.cwd(), rels, { objective: life.objective || '' }).needsSuite; } catch { return false; }
}

/** The sentence a refusal to call the task done carries. */
function why(st, cwd) {
  const s = suite(cwd);
  const cmd = s ? s.command : 'the final suite';
  if (st === 'MISSING') return `final smoke has not run since the last change: ${cmd}`;
  if (st === 'RUNNING') return `final smoke is still running in the background: ${cmd}`;
  if (st === 'FAILED') return `final smoke failed: ${cmd}`;
  return '';
}

/** A write happened while a plan step was current: that step owns the file. */
function noteMutation(plan, files) {
  if (!plan || !Array.isArray(plan.steps) || !files || !files.length) return;
  // A change after the smoke passed makes the smoke pending again.
  const smoke = plan.steps.find((x) => x.origin === ORIGIN && x.status !== 'dropped');
  if (smoke && smoke.status === 'done') { smoke.status = 'todo'; smoke.completedAt = null; plan.retiredAt = null; }
  const cur = typeof plan.current === 'function' ? plan.current() : null;
  if (!cur || cur.origin === ORIGIN) return;
  cur.files = [...new Set([...(cur.files || []), ...files.map(String)])];
}

/** Keep (or add) the final-smoke step as the plan's LAST step. */
function ensureTerminal(plan, cwd) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return false;
  const s = suite(cwd);
  if (!s) return false;
  let step = plan.steps.find((x) => x.origin === ORIGIN && x.status !== 'dropped')
    || [...plan.steps].reverse().find((x) => SMOKE_WORD.test(x.text) && x.status !== 'done');
  if (!step) {
    step = { n: plan.steps.length + 1, text: `Final smoke — ${s.command}`, status: 'todo', note: '', completedAt: null, origin: ORIGIN };
    plan.steps.push(step);
  } else {
    step.origin = ORIGIN;
    const i = plan.steps.indexOf(step);
    if (i !== plan.steps.length - 1) { plan.steps.splice(i, 1); plan.steps.push(step); }
  }
  plan.steps.forEach((x, i) => { x.n = i + 1; });
  return true;
}

/** THE FINAL SMOKE FAILED: which earlier step owns it? */
function owner(plan, failureText) {
  if (!plan || !Array.isArray(plan.steps)) return null;
  const text = String(failureText || '');
  const scored = [];
  for (const s of plan.steps) {
    if (s.origin === ORIGIN || !Array.isArray(s.files) || !s.files.length) continue;
    let score = 0;
    for (const f of s.files) {
      const rel = String(f).replace(/\\/g, '/');
      const base = path.basename(rel);
      const stem = base.replace(/\.[^.]+$/, '');
      if (text.includes(rel)) score += 3;
      else if (text.includes(base)) score += 2;
      else if (stem.length > 3 && new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) score += 1;
    }
    if (score) scored.push({ step: s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].step;
}

/** Reopen the owning step: it becomes ACTIVE again, the smoke step waits, every other completed step keeps its DONE. */
function reopen(plan, failureText) {
  if (!plan || !Array.isArray(plan.steps)) return '';
  const step = owner(plan, failureText);
  const smoke = plan.steps.find((x) => x.origin === ORIGIN && x.status !== 'dropped');
  if (!step) {
    return 'FINAL SMOKE FAILED — its owner is not clear from the evidence. Investigate within the files this task changed (bounded; do not re-read the project), '
      + 'fix, run the targeted test, then run the final smoke again as the last step.';
  }
  for (const s of plan.steps) if (s.status === 'active' && s !== step) s.status = 'todo';
  step.status = 'active';
  step.completedAt = null;
  step.reopened = (step.reopened || 0) + 1;
  if (smoke && smoke.status !== 'todo') smoke.status = 'todo';
  plan.retiredAt = null;
  return `FINAL SMOKE FAILED — reopened step ${step.n} "${String(step.text).slice(0, 80)}" (its change ${step.files.join(', ')} appears in the failure). `
    + 'Other completed steps stand. Repair that step, run its targeted test, then run the final smoke again as the last step.';
}

/** The framed-context line an implementation turn carries about the final step. */
function guidance(life, cwd) {
  const s = suite(cwd);
  if (!s) return '';
  const st = state(life, cwd);
  const head = `Final smoke: ${s.command} — run it as the LAST execution step, after targeted tests and integration; `
    + 'change nothing after it passes (anything optional is a follow-up, or done before it).';
  if (st === 'MISSING') return `${head} Status: pending — the tree changed since it last passed.`;
  if (st === 'FAILED') return `${head} Status: FAILED — repair the reopened step and run it again.`;
  if (st === 'RUNNING') return `${head} Status: running in the background.`;
  return head;
}

/** A /bg-DETACHED FINAL SMOKE CAME BACK. */
function settleBackground(app, session, r) {
  const life = session && session.lifecycle;
  if (!life || !life.smoke || !life.smoke.running || !r || r.kind !== 'process') return null;
  const s = suite(session.cwd);
  const label = flat(r.label);
  if (!(s && label === flat(s.command)) && label !== flat(life.smoke.command)) return null;
  const current = life.settleSmoke(r.ok, { command: r.label, exitCode: r.ok ? 0 : null });
  const plan = session.plan;
  const smokeStep = plan && plan.steps.find((x) => x.origin === ORIGIN && x.status !== 'dropped');
  if (r.ok && current) {
    const rest = plan ? plan.steps.filter((x) => x !== smokeStep && x.status !== 'done' && x.status !== 'dropped') : [];
    if (smokeStep && !rest.length) { smokeStep.status = 'done'; smokeStep.completedAt = new Date().toISOString(); smokeStep.note = 'final smoke passed (background)'; }
    // (the completion screen is gone, S10: the strip reads the state)
    return { passed: true };
  }
  if (!current) return { stale: true };
  const said = reopen(plan, r.tail || r.summary);
  const text = `The final smoke that ran in the background FAILED (${r.summary}).\n${said}\n\nEvidence:\n${String(r.tail || '').slice(-1200)}`;
  // A RUNNING TURN already sees it (rejoined-results context, job_wait) and the
  // smoke-failed wake-up covers it if that turn stops; queueing would duplicate it.
  if (!app.abort) Promise.resolve().then(() => app.submit(text, { sameTask: true, from: 'smoke-failed' })).catch(() => { /* reported by the turn itself */ });
  return { failed: true, reopened: said };
}

module.exports = { ORIGIN, suite, isFinal, state, required, why, noteMutation, ensureTerminal, owner, reopen, guidance, settleBackground, _cache: cache };
