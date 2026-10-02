'use strict';

/**
 * THE COMPLETION ARBITER (Execution Discipline §26–§27). Completion is decided by LAIN; a model may REQUEST it and
 * never certify it.
 *
 *   DONE                    an answer (nothing changed), or a change whose required proof is on record · every
 *                           explicit ask addressed · nothing to disclose
 *   DONE_UNVERIFIED(reason) finished, with something DISCLOSED: proof the contract asks for is missing, a failure not
 *                           caused by this change (pre-existing / unknown), a test change that affects verification
 *   PARTIAL(remaining)      explicit asks still open
 *   BLOCKED(layer, reason)  the model reports a blocker it cannot pass
 *   NEEDS_DECISION(q)       a question only the person can answer
 *   ACTIVE                  not finished: a failure CAUSED BY THIS CHANGE, scaffolding left in place, a required suite
 *                           not yet run or still running
 *
 * ORDER (2026-10-02): verifycontract.requirement() is asked FIRST — it is the single verification authority — and
 * everything after is evidence measured against it. Activity alone ("a command ran") is never what finishes or
 * blocks a task. The final smoke runs only where the contract asks for broad proof (PROJECT/RELEASE).
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
function evaluate(life, { cwd = null, requested = false, request = null, claims = null, discretion = 'STRONG', objective = '', changeClass = null, readOnly = false } = {}) {
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

  // ---- 1. HOW MUCH PROOF THIS TASK NEEDS — asked FIRST (2026-10-02) -------------------------------------------
  //
  // Universal activity gates used to run ahead of this ("nothing ran", "the last command failed", "changed but
  // unchecked"), so proportionality never got a vote: a read-only answer had to invent a command, and an unrelated
  // red suite forced a model to repair code nobody asked about just to finish. The contract decides; every check
  // below is evidence measured against it, and only a failure CAUSED BY THIS CHANGE keeps the task open.
  const objectiveText = objective || (d && d.contract.request) || '';
  const vc = require('../verifycontract');
  const req = vc.requirement(cwd || process.cwd(), changed.map((p) => rel(cwd, p)), { objective: objectiveText, discretion });
  const disclose = [];   // what the report must say — never a reason to keep working
  let unverified = false; // no check exercises what changed — the status strip says NOT VERIFIED
  const last = life.lastCommand;
  const passingNow = d ? d.checks.all().filter((c) => c.latest && c.latest.gen === gen && ['PASS', 'OBSERVED'].includes(c.latest.state)) : [];
  const failing = d ? d.checks.commands().filter((c) => c.latest && c.latest.state === 'FAIL' && c.latest.gen === gen && !require('./checks').explained(c)) : [];
  const unrelatedNote = (c) => `${c.command} fails (${String(c.latest.classification || 'UNKNOWN').toLowerCase()}${c.latest.classification === 'PREEXISTING' ? ', already failing before this task' : ', not shown to be caused by this change'})`;

  // PENDING WORK that would change the report.
  if (life.smoke && life.smoke.running) return out(STATE.ACTIVE, require('../finalsmoke').why('RUNNING', cwd), { smoke: 'RUNNING', level: req.level, claims: cl });

  // ---- 2. NOTHING CHANGED: an answer, a report, an investigation ----------------------------------------------
  //
  // The observation IS the evidence: "what is the package name" is finished when the model has read it and says so.
  // No mutation, command or smoke is owed. A request that asked for a CHANGE and changed nothing finishes honestly
  // as DONE_UNVERIFIED — the model may know none was needed; the report says nothing was changed.
  if (!changed.length) {
    // TICKING BOXES IS NOT DOING WORK: on the PLAN path (the model never asked to finish), a plan marked done with
    // nothing observed at all — no change, no command, no observation — is not an answer either.
    const observedAny = e.commandsRun > 0 || e.verifiedChecks > 0 || (d && d.checks.all().some((c) => c.latest));
    if (!requested && !observedAny) return out(STATE.ACTIVE, 'no completion evidence: nothing changed, no command ran, nothing verified', { level: req.level, claims: cl });
    // …and LAIN does not PASSIVELY call a plan finished over a red check (this costs no model turn — the task simply
    // stays open). When the model ASKS, the failure is reported instead (below).
    if (!requested && failing.length) return out(STATE.ACTIVE, unrelatedNote(failing[failing.length - 1]), { failedCheck: failing[failing.length - 1], level: req.level, claims: cl });
    for (const c of failing) disclose.push(unrelatedNote(c));
    const wantsChange = require('../wakeup').asksForChange(objectiveText) && !readOnly;
    // A PASSING OBSERVATION proves no change was needed ("confirm the port is free" → checked, it is) — a ledger check
    // or a verification the caller recorded.
    const nothingNeeded = passingNow.length > 0 || e.verifiedChecks > 0;
    if (wantsChange && !nothingNeeded) {
      return out(STATE.DONE_UNVERIFIED, ['the request asked for a change and nothing was changed', ...disclose].join('; '), { level: req.level, claims: cl, nothingChanged: true });
    }
    const said = disclose.length ? ` — reported: ${disclose.join('; ')}` : '';
    return out(STATE.DONE, `answered — nothing changed${said}`, { level: req.level, claims: cl });
  }

  // ---- 3. THE TASK'S OWN UNFINISHED WORK -----------------------------------------------------------------------
  const scaffold = d ? d.contract.scaffolding.filter((s) => s.status === 'ACTIVE') : [];
  if (scaffold.length) return out(STATE.ACTIVE, `temporary scaffolding is still in place: ${scaffold.map((s) => s.path).join(', ')}`, { level: req.level, claims: cl });
  if (d && d.contract.asks.length > 1) {
    const open = d.contract.openAsks();
    if (open.length) return out(STATE.PARTIAL, `explicit asks not yet addressed: ${open.map((a) => `${a.id} ${a.text.slice(0, 60)}`).join('; ')}`, { remaining: open.map((a) => a.id), level: req.level, claims: cl });
  }

  // ---- 4. A FAILURE CAUSED BY THIS CHANGE keeps it open; any other failure is DISCLOSED -----------------------
  //
  // Caused-by-this-change: it passed before and fails now (TASK_CAUSED), or it is a check that exercises a changed
  // file and was not already failing. Everything else — pre-existing, unknown causality on an unrelated check — is
  // information the report carries. It never authorises repairing code outside the task.
  const ours = failing.filter((c) => c.latest.classification === 'TASK_CAUSED' || (c.targeted && c.latest.classification !== 'PREEXISTING'));
  if (ours.length) {
    const k = ours[ours.length - 1];
    return out(STATE.ACTIVE, `a check that exercises this change fails: ${k.command}${k.static ? '' : ` (${k.latest.classification || 'UNKNOWN'})`}`, { failedCheck: k, level: req.level, claims: cl });
  }
  for (const c of failing) disclose.push(unrelatedNote(c));

  // ---- 5. WHAT THE CONTRACT ASKS FOR ----------------------------------------------------------------------------
  if (req.needsSuite && cwd) {
    const fsm = require('../finalsmoke');
    const st = fsm.state(life, cwd);
    if (st === 'MISSING') return out(STATE.ACTIVE, fsm.why(st, cwd), { smoke: st, level: req.level, claims: cl });
    if (st === 'FAILED') disclose.push(fsm.why(st, cwd));
  }
  const unmet = d ? d.contract.liveCriteria().filter((c) => !criterionHolds(c, d, gen)) : [];
  if (unmet.length) disclose.push(`acceptance criteria without current evidence: ${unmet.map((c) => c.id).join(', ')}`);
  if (d) {
    // A DIRECT change (a label, a colour, one element) is proved by a clean parse of what it touched; anything else
    // needs a check that exercises the change. The standard is the same for every model; a weaker one has less latitude.
    const staticCounts = changeClass === 'DIRECT';
    const best = passingNow.reduce((m, c) => Math.max(m, rankOf(DISCRIMINATION, d.checks.discrimination(c, gen, { staticCounts }))), 0);
    if (best < rankOf(DISCRIMINATION, req.minDiscrimination)) {
      unverified = true;
      // THE RELEVANT EVIDENCE SET, not `lastCommand`: an inconclusive result (a masked command — `… & echo DONE`, a
      // no-match grep) is named for what it is when it was the only supposed proof. It is never called a failure,
      // and it never satisfies the contract. When real evidence exists, an inconclusive last command is irrelevant.
      const inconclusive = d.checks.commands().filter((c) => c.latest && c.latest.gen === gen && c.latest.state === 'UNVERIFIED');
      if (inconclusive.length) {
        const k = inconclusive[inconclusive.length - 1];
        const { keyOf } = require('./checks');
        const why = k.note || (last && last.ok === null && last.note && keyOf(k.command).startsWith(keyOf(last.command)) ? last.note : '');
        disclose.push(`the last check does not verify this: ${k.command}${why ? ` — ${why}` : ' (inconclusive)'}`);
      } else {
        disclose.push(discretion === 'WEAK' ? 'this model needs an independent check that exercises the change itself (none of the current checks does)' : 'no current check exercises what changed');
      }
    }
  }
  if (req.needsPackaging && d) {
    const packaged = passingNow.some((c) => c.kind === 'COMMAND' && require('./claims').DOMAINS[0].evidence.test(c.command || ''));
    if (!packaged) disclose.push('the task is about a release/package and no packaging run is on record for the current state');
  }

  // ---- 6. TEST INTEGRITY — LAIN discloses it; the outcome cannot be plain DONE while it stands ---------------
  const flags = d ? d.integrity.filter((f) => f.status === 'UNDISCLOSED') : [];
  for (const f of flags) disclose.push(`test change affects verification: ${f.id} ${f.kind} in ${f.file} (${f.detail})`);

  const note = downgraded.length ? ` — ${downgraded.length} claim(s) not verified: ${downgraded.map((c) => `"${c.text.slice(0, 60)}" (${c.why})`).join('; ')}` : '';
  if (disclose.length) {
    return out(STATE.DONE_UNVERIFIED, `${changed.length} file(s) changed · ${disclose.join('; ')}${note}`, { level: req.level, claims: cl, integrity: flags.length ? flags : undefined, remaining: unmet.map((c) => c.id), foreign: failing.map((c) => c.id), ...(unverified ? { unverified: true } : {}), ...(failing.length ? { failedCheck: failing[failing.length - 1] } : {}) });
  }
  return out(STATE.DONE, `${changed.length} file(s) changed, ${e.commandsRun} command(s) run${last && last.ok ? `, last check passed: ${last.command}` : ''}${note}`, { level: req.level, claims: cl });
}

module.exports = { evaluate, outcomeSatisfied, criterionHolds, STATE };
