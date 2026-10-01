'use strict';

/**
 * THE COMPLETION ARBITER (Execution Discipline §26–§27). Completion is decided by Noema; a model may REQUEST it and
 * never certify it.
 *
 *   DONE                    every explicit ask addressed or deferred · acceptance criteria evidenced · no known
 *                           relevant contradiction · scaffolding accounted for · test-integrity changes disclosed ·
 *                           nothing pending that would change the report · the verification contract satisfied
 *   DONE_UNVERIFIED(reason) the work is finished but the evidence the contract asks for is missing
 *   PARTIAL(remaining)      explicit asks still open
 *   BLOCKED(layer, reason)  the model reports a blocker it cannot pass
 *   NEEDS_DECISION(q)       a question only the person can answer
 *   ACTIVE                  not finished: a contradiction, an unchecked change, a pending suite, undisclosed test edits
 *
 * HOW MUCH PROOF is verifycontract.requirement()'s answer — the single verification authority. The final smoke runs
 * only where that contract asks for broad proof (PROJECT/RELEASE), never as a universal last step.
 *
 * THE SIGNAL THAT STOPS OVER-EXECUTION: `outcomeSatisfied` — every acceptance criterion the model set is evidenced
 * by a current observation and no ask is open. Further changes are then refused until the person asks for more.
 */

const { DISCRIMINATION, rankOf } = require('./checks');

const STATE = Object.freeze({ DONE: 'DONE', DONE_UNVERIFIED: 'DONE_UNVERIFIED', PARTIAL: 'PARTIAL', BLOCKED: 'BLOCKED', NEEDS_DECISION: 'NEEDS_DECISION', ACTIVE: 'ACTIVE' });

const rel = (cwd, p) => { try { return require('path').relative(cwd || process.cwd(), String(p)).replace(/\\/g, '/'); } catch { return String(p); } };

/** Is this evidence reference a current, sufficient observation? */
function evidenceHolds(ev, d, gen) {
  const c = ev && ev.check ? d.checks.get(ev.check) : null;
  if (!c || !c.latest || c.latest.gen !== gen) return false;
  if (!['PASS', 'OBSERVED'].includes(c.latest.state)) return false;
  if (ev.expect && c.kind === 'OBSERVATION' && !String(c.text || '').includes(String(ev.expect))) return false;
  return true;
}

function criterionHolds(c, d, gen) {
  if (c.status !== 'MET') return false;
  return (c.evidence || []).some((ev) => evidenceHolds(ev, d, gen));
}

/** Every acceptance criterion the model set is evidenced now, and no explicit ask is open. */
function outcomeSatisfied(life) {
  const d = life && life.discipline;
  if (!d) return false;
  const gen = life.mutationSeq || 0;
  const live = d.contract.liveCriteria();
  if (!live.length) return false;
  if (d.contract.asks.length > 1 && d.contract.openAsks().length) return false;
  if (d.checks.contradictions(gen).length) return false;
  return live.every((c) => criterionHolds(c, d, gen));
}

/**
 * EVALUATE. `life` is the task Lifecycle (its discipline, evidence, generation and smoke state).
 * @param {object} o  { cwd, requested: the model asked to complete, request: {state, layer, reason, question},
 *                      claims: typed claims, discretion: STRONG|MEDIUM|WEAK, objective }
 */
function evaluate(life, { cwd = null, requested = false, request = null, claims = null, discretion = 'STRONG', objective = '' } = {}) {
  const d = life.discipline;
  const e = life.evidence;
  const gen = life.mutationSeq || 0;
  const changed = [...e.filesChanged];
  const out = (state, why, extra = {}) => ({ state, ok: state === STATE.DONE, why, gen, ...extra });
  const cl = d && claims ? require('./claims').crossCheck(claims, { ledger: d.checks, gen, changed }) : [];
  const downgraded = cl.filter((c) => !c.accepted);

  // THE MODEL'S OWN TERMINAL REQUESTS that do not need evidence: a blocker it cannot pass, a decision that is not its.
  if (requested && request && request.state === STATE.NEEDS_DECISION && request.question) return out(STATE.NEEDS_DECISION, String(request.question).slice(0, 300), { claims: cl });
  if (requested && request && request.state === STATE.BLOCKED) return out(STATE.BLOCKED, `${request.layer || 'unknown layer'}: ${String(request.reason || 'blocked').slice(0, 300)}`, { layer: request.layer || null, claims: cl });
  if (e.userConfirmed) return out(STATE.DONE, 'confirmed by the person', { claims: cl });

  const observed = d ? d.checks.all().filter((c) => c.kind === 'OBSERVATION' && c.latest && c.latest.gen === gen) : [];
  const has = changed.length > 0 || e.commandsRun > 0 || e.verifiedChecks > 0 || observed.length > 0;
  if (!has) return out(STATE.ACTIVE, 'no completion evidence: nothing changed, no command ran, nothing verified', { claims: cl });

  // A RELEVANT CONTRADICTION: a check failing at the current generation that is not explained away.
  const contra = d ? d.checks.contradictions(gen) : [];
  const last = life.lastCommand;
  // RED IS NOT AUTOMATICALLY "THE IMPLEMENTATION IS WRONG": a failure classified as the environment, a transient
  // fault or something that was already failing before the task is information, not a verdict on the change.
  const lastCheck = d ? d.checks.commands().filter((c) => c.latest).sort((a, b) => a.latest.at - b.latest.at).pop() : null;
  const explained = Boolean(lastCheck && lastCheck.latest.state === 'FAIL' && require('./checks').explained(lastCheck));
  if (last && last.ok === false && !explained) {
    return out(STATE.ACTIVE, `the last command failed${last.exitCode != null ? ` (exit ${last.exitCode})` : ''}: ${last.command}`, { failedCheck: last, claims: cl });
  }
  if (contra.length) {
    const k = contra[contra.length - 1];
    return out(STATE.ACTIVE, `a check is failing: ${k.command} (${k.latest.classification || 'UNKNOWN'})`, { failedCheck: k, claims: cl });
  }
  const passingNow = d ? d.checks.all().filter((c) => c.latest && c.latest.gen === gen && ['PASS', 'OBSERVED'].includes(c.latest.state)) : [];
  if (last && last.ok === null && !passingNow.length) {
    return out(STATE.ACTIVE, `the last command does not verify this: ${last.command}${last.note ? ` — ${last.note}` : ''}`, { failedCheck: last, claims: cl });
  }
  if (changed.length && e.verifiedChecks === 0 && !observed.length) {
    return out(STATE.ACTIVE, `${changed.length} file(s) changed but nothing has been run to check them`, { unverified: true, claims: cl });
  }

  // PENDING WORK that would change the report.
  if (life.smoke && life.smoke.running) return out(STATE.ACTIVE, require('../finalsmoke').why('RUNNING', cwd), { smoke: 'RUNNING', claims: cl });

  // TEST INTEGRITY — disclosed, or the task is not finished.
  const flags = d ? d.integrity.filter((f) => f.status === 'UNDISCLOSED') : [];
  if (flags.length) {
    const f = flags[0];
    return out(STATE.ACTIVE, `test changes must be disclosed before this counts as verified: ${f.id} ${f.kind} in ${f.file} (${f.detail})`, { integrity: flags, claims: cl });
  }

  // SCAFFOLDING the task added and has not removed or chosen to keep.
  const scaffold = d ? d.contract.scaffolding.filter((s) => s.status === 'ACTIVE') : [];
  if (scaffold.length) return out(STATE.ACTIVE, `temporary scaffolding is still in place: ${scaffold.map((s) => s.path).join(', ')}`, { claims: cl });

  // THE VERIFICATION CONTRACT — the one authority on how much proof this change needs.
  const vc = require('../verifycontract');
  const req = vc.requirement(cwd || process.cwd(), changed.map((p) => rel(cwd, p)), { objective: objective || (d && d.contract.request) || '', discretion });
  if (changed.length && req.needsSuite && cwd) {
    const fs = require('../finalsmoke');
    const st = fs.state(life, cwd);
    if (st !== 'NOT_REQUIRED' && st !== 'PASSED') return out(STATE.ACTIVE, fs.why(st, cwd), { smoke: st, level: req.level, claims: cl });
  }

  // EXPLICIT ASKS — tracked separately, so a long task cannot quietly drop one.
  if (d && d.contract.asks.length > 1) {
    const open = d.contract.openAsks();
    if (open.length) return out(STATE.PARTIAL, `explicit asks not yet addressed: ${open.map((a) => `${a.id} ${a.text.slice(0, 60)}`).join('; ')}`, { remaining: open.map((a) => a.id), level: req.level, claims: cl });
  }

  // ACCEPTANCE CRITERIA the model set — each needs current evidence.
  const unmet = d ? d.contract.liveCriteria().filter((c) => !criterionHolds(c, d, gen)) : [];
  if (unmet.length) return out(STATE.DONE_UNVERIFIED, `acceptance criteria without current evidence: ${unmet.map((c) => c.id).join(', ')}`, { remaining: unmet.map((c) => c.id), level: req.level, claims: cl });

  // EVIDENCE QUALITY for what changed — the same standard for every model; a weaker one has less latitude in meeting it.
  if (changed.length && d) {
    const best = passingNow.reduce((m, c) => Math.max(m, rankOf(DISCRIMINATION, d.checks.discrimination(c, gen))), 0);
    if (best < rankOf(DISCRIMINATION, req.minDiscrimination)) {
      return out(STATE.DONE_UNVERIFIED, discretion === 'WEAK'
        ? 'this model needs an independent check that exercises the change itself (none of the current checks does)'
        : 'no current check exercises what changed', { level: req.level, claims: cl });
    }
  }
  if (req.needsPackaging && d) {
    const packaged = passingNow.some((c) => c.kind === 'COMMAND' && require('./claims').DOMAINS[0].evidence.test(c.command || ''));
    if (!packaged) return out(STATE.DONE_UNVERIFIED, 'the task is about a release/package and no packaging run is on record for the current state', { level: req.level, claims: cl });
  }

  const note = downgraded.length ? ` — ${downgraded.length} claim(s) not verified: ${downgraded.map((c) => `"${c.text.slice(0, 60)}" (${c.why})`).join('; ')}` : '';
  return out(STATE.DONE, `${changed.length} file(s) changed, ${e.commandsRun} command(s) run${last && last.ok ? `, last check passed: ${last.command}` : ''}${note}`, { level: req.level, claims: cl });
}

module.exports = { evaluate, outcomeSatisfied, criterionHolds, STATE };
