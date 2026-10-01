'use strict';

/**
 * SUBAGENTS — bounded specialists, never copies of the main agent (§58–64, §71–72).
 *
 * THE FAILURE THIS PREVENTS: main agent → subagent A reads the whole codebase →
 * subagent B reads the whole codebase → both edit the same files. That doubles
 * the context bill and manufactures conflicts. So a subagent is:
 *
 *   A FRESH SESSION. It is handed a brief — role, objective, scopes, expected
 *     output, verification, completion condition, and what earlier stages
 *     produced — never the parent conversation. (`/bg` forks a whole session;
 *     this deliberately does not. The two are different things, §71.)
 *   A BOUNDED WORK ORDER. readScope/writeScope are enforced at the tool door by
 *     workorderguard.js; a role that must not write gets an empty writeScope.
 *   A WRITE LEASE on its writeScope (leases.js), so the foreground and other
 *     subagents cannot write the same files while it runs.
 *
 * PARALLEL only when write ownership is genuinely separable (`partition`);
 * PIPELINE for the staircase — SCOUT maps, FOUNDATION lays interfaces,
 * IMPLEMENTER builds on them, VERIFIER tests the integrated result.
 *
 * THE MAIN AGENT STAYS THE INTEGRATOR: results come back to it as evidence; a
 * subagent cannot delegate further and does not redefine architecture.
 *
 * MODEL-NEUTRAL: `model`/`connection` on a contract select any catalog source
 * (OpenRouter included) through the ordinary resolver. There is no
 * provider-specific orchestration anywhere here.
 */

const ROLES = Object.freeze({
  SCOUT: { write: false, commands: false, does: 'map ownership, constraints and where the change belongs — read only' },
  FOUNDATION: { write: true, commands: true, does: 'establish the interfaces, contracts or migration the rest builds on' },
  IMPLEMENTER: { write: true, commands: true, does: 'build the change inside its write scope' },
  VERIFIER: { write: false, commands: true, does: 'test and observe the integrated result — never edits' },
  RESEARCHER: { write: false, commands: false, does: 'gather external evidence only' },
});

const WHOLE_PROJECT = /^(?:\*\*?|\.\/?|\*\*\/\*|\/)?$/;

/** What a role a model invented most likely meant — named in the refusal, never applied silently. */
const ROLE_READS_AS = Object.freeze({
  EXPLORER: 'SCOUT', INVESTIGATOR: 'SCOUT', ANALYST: 'SCOUT', MAPPER: 'SCOUT', READER: 'SCOUT',
  ARCHITECT: 'FOUNDATION', DESIGNER: 'FOUNDATION', PLANNER: 'FOUNDATION',
  CODER: 'IMPLEMENTER', DEVELOPER: 'IMPLEMENTER', BUILDER: 'IMPLEMENTER', ENGINEER: 'IMPLEMENTER', WORKER: 'IMPLEMENTER', FIXER: 'IMPLEMENTER',
  REVIEWER: 'VERIFIER', TESTER: 'VERIFIER', QA: 'VERIFIER', CHECKER: 'VERIFIER', VALIDATOR: 'VERIFIER',
  SEARCHER: 'RESEARCHER', WEB: 'RESEARCHER', RESEARCH: 'RESEARCHER',
});

/**
 * A contract is complete and bounded, or it is refused with the reason.
 * @returns {{ok:true, contract:object}|{ok:false, why:string}}
 */
function validate(c = {}, { parentTask = '' } = {}) {
  const role = String(c.role || '').toUpperCase();
  const need = ['objective', 'expectedOutput', 'verification', 'completion'];
  const readScope = (Array.isArray(c.readScope) ? c.readScope : []).map(String).filter(Boolean);
  const writeScope = (Array.isArray(c.writeScope) ? c.writeScope : []).map(String).filter(Boolean);
  // EVERY MISSING FIELD IN ONE REFUSAL. Naming one at a time cost a live run
  // (gpt-oss via Ollama Cloud, 2026-09-23) six refused calls — six full
  // flagship requests — to learn a six-field contract field by field.
  const missing = need.filter((k) => !String(c[k] || '').trim());
  if (!readScope.length) missing.push('readScope (the files or globs it may read — "help with this project" is not a scope)');
  if (!ROLES[role]) {
    // A SCHEMA SLIP, answered with the enum and the likely intent (2026-09-29): the model retries in the same
    // turn; nothing was started, so nothing needs undoing. It is never a reason for the task to stop.
    const meant = ROLE_READS_AS[role] ? ` — "${c.role}" reads as ${ROLE_READS_AS[role]}` : '';
    return { ok: false, code: 'INVALID_ARGUMENT', why: `INVALID_ARGUMENT role "${String(c.role || '')}" is not a subagent role${meant}. Allowed: ${Object.keys(ROLES).join(' | ')}. `
      + `Retry delegate with one of these; nothing was started${missing.length ? `. The contract is also missing: ${missing.join(', ')}` : ''}` };
  }
  if (missing.length) return { ok: false, why: `${role} contract is missing: ${missing.join(', ')}` };
  if (!ROLES[role].write && writeScope.length) return { ok: false, why: `${role} is read-only and may not hold a writeScope` };
  if (ROLES[role].write && !writeScope.length) return { ok: false, why: `${role} needs a writeScope naming the files or globs it owns` };
  const unbounded = writeScope.find((e) => WHOLE_PROJECT.test(e.trim()));
  if (unbounded != null && !c.isolated) return { ok: false, why: `writeScope "${unbounded}" is the whole project — a subagent owns a part` };
  return {
    ok: true,
    contract: {
      role,
      objective: String(c.objective).trim(),
      readScope,
      writeScope,
      ownedFiles: (Array.isArray(c.ownedFiles) ? c.ownedFiles : writeScope).map(String),
      expectedOutput: String(c.expectedOutput).trim(),
      verification: String(c.verification).trim(),
      completion: String(c.completion).trim(),
      parentTask: String(c.parentTask || parentTask || '').trim(),
      model: c.model ? String(c.model) : null,
      connection: c.connection ? String(c.connection) : null,
      cwd: c.cwd ? String(c.cwd) : null,
      isolated: Boolean(c.isolated),
    },
  };
}

/** No two contracts that will run together may own an overlapping file. */
function partition(contracts = []) {
  const leases = require('./leases');
  for (let i = 0; i < contracts.length; i++) {
    for (let j = i + 1; j < contracts.length; j++) {
      const hit = leases.scopesOverlap(contracts[i].writeScope, contracts[j].writeScope);
      if (hit) return { ok: false, why: `${contracts[i].role} #${i + 1} (${hit.a}) and ${contracts[j].role} #${j + 1} (${hit.b}) would write the same files — run them as a pipeline, or split ownership` };
    }
  }
  return { ok: true };
}

/** The whole of what a subagent is told. Bounded: it rides every request it makes. */
function brief(c, { stage = 0, of = 1, inputs = [] } = {}) {
  const lines = [
    `You are a ${c.role} subagent (${ROLES[c.role].does}). Stage ${stage + 1} of ${of}.`,
    `Parent task: ${c.parentTask || '(the main agent\'s current task)'}`,
    `Objective: ${c.objective}`,
    `Read scope: ${c.readScope.join(', ')} — read nothing outside it; do not survey the whole codebase.`,
    c.writeScope.length ? `Write scope (yours alone while you run): ${c.writeScope.join(', ')}` : 'You may not modify any file.',
    `Expected output: ${c.expectedOutput}`,
    `Verification required: ${c.verification}`,
    `You are done when: ${c.completion}`,
    'You do not redefine the architecture and you cannot delegate. Report findings and decisions that need the main agent instead of making them.',
  ];
  for (const inp of inputs) lines.push('', `From ${inp.role} (stage ${inp.stage + 1}):`, String(inp.output || '').slice(0, 4000));
  lines.push('', 'Finish with the expected output, stated plainly, and the verification you actually ran.');
  return lines.join('\n');
}

/**
 * Run one contract as a bounded worker. `runner` is the test seam; production
 * runs a real turn through the ordinary loop, tools and gates.
 */
async function runOne(app, c, { stage = 0, of = 1, inputs = [], runner = null, signal = null } = {}) {
  const { Session } = require('./session');
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const holder = `subagent:${c.role.toLowerCase()}#${id}`;
  const leases = require('./leases');
  // An isolated candidate (A/B) writes only its own worktree; the canonical
  // scope is leased by the A/B run itself, so it takes no lease here.
  const lease = c.isolated ? { ok: true } : leases.acquire(holder, c.writeScope, `${c.role} subagent`);
  if (!lease.ok) return { ok: false, role: c.role, stage, why: `write lease refused: ${lease.why}` };
  // ISOLATED, ALWAYS, when it can write or run commands (candidates.js): the child
  // never touches the canonical tree; what it builds comes back as a CANDIDATE.
  // The canonical lease above stays held so the main agent does not edit the same
  // files underneath it. A/B (`isolated`) brings its own worktree.
  const cands = require('./candidates');
  const needsWs = !c.isolated && (ROLES[c.role].write || ROLES[c.role].commands);
  const ws = needsWs ? cands.isolate(app, c.role.toLowerCase(), c) : null;
  if (ws && !ws.ok) { leases.release(holder); return { ok: false, role: c.role, stage, why: `no isolated workspace, so the ${c.role} did not run: ${ws.why}` }; }
  const trust = ws ? { path: ws.dir, level: 'TRUSTED' } : null;
  if (trust && app.cfg) app.cfg.trustedPaths = [...(Array.isArray(app.cfg.trustedPaths) ? app.cfg.trustedPaths : []), trust];
  const session = new Session({ cwd: ws ? ws.cwd : (c.cwd || app.session.cwd) });
  // THE BASELINE IS MEASURED WHERE THE CHILD WORKS. Measured on the canonical
  // tree it disagreed with the worktree's own bytes (a checkout differs in line
  // endings), and every write was refused as STALE — found live, 2026-09-23.
  const concrete = c.writeScope.map((e) => String(e).split('::')[0]).filter((p) => p && !/[*?]/.test(p));
  const baseline = ws ? require('./workorderguard').baseline(ws.cwd, [...new Set(concrete)]) : null;
  const order = require('./authority').issue(app.session, { id: holder, objective: c.objective, readScope: c.readScope, writeScope: c.writeScope, bounded: true, baseline });
  order.leaseHolder = holder;
  order.allowCommands = ROLES[c.role].commands;
  session.workOrder = order;
  const job = app.jobs.create({ request: `${c.role} · ${c.objective}`, primary: false, session, kind: 'subagent' });
  job.parentSessionId = app.session.id;
  job.scope = c.writeScope.slice();
  job.planStep = currentStep(app);
  job.state = 'RUNNING';
  job.startedAt = Date.now();
  app.jobs.changed();
  const text = brief(c, { stage, of, inputs });
  let record = null;
  // WHAT BECOMES OF THE WORKSPACE is decided by its lifecycle from this (tempworkspaces.js).
  let fate = { failed: true, why: 'the child did not finish', candidate: null };
  try {
    if (runner) record = await runner({ contract: c, session, order, brief: text, stage });
    else {
      const { runTurn } = require('./turn');
      const opts = require('./jobrunner').turnOptions(app, { session, signal: signal || job.abort.signal, from: 'subagent' });
      if (c.model) opts.cfg = { ...opts.cfg, model: c.model, ...(c.connection ? { connection: c.connection } : {}) };
      opts.workOrder = order;
      opts.requiresExecution = false;
      opts.ask = (q) => require('./decisions').ask(app, { type: 'ASK_USER', title: `${c.role} subagent asks`, question: q && q.question, options: (q && q.options) || [] });
      for await (const ev of runTurn(session, text, opts)) {
        if (ev && ev.type === 'tool_start') { job.detail = `${ev.name}`.slice(0, 80); app.jobs.changed(); }
        if (ev && ev.type === 'done') record = ev.record;
      }
    }
    let settlement = null;
    try { settlement = require('./proposal').settle(order, session, { claim: record && record.text }); } catch { /* the result stands */ }
    const output = String((record && record.text) || '').trim();
    // HARVESTED BEFORE ANY VERDICT: even a failed child's changes are a candidate
    // the main agent can inspect — never something already applied.
    const candidate = ws ? cands.harvest(app, ws, c, { role: c.role, claim: output }) : null;
    fate = { failed: false, why: '', candidate };
    job.resultSummary = output.slice(0, 200);
    // A WORKER WHOSE TURN DID NOT END NATURALLY DID NOT FINISH. Any returned
    // record used to be DONE — a worker cut off by a provider failure, a stall,
    // a rate limit or a no-progress stop handed its partial text up as a result.
    const stop = record && record.stopReason;
    const unfinished = (stop && stop !== 'end') ? `its turn ended ${stop}${record.providerFailure && record.providerFailure.message ? ` (${String(record.providerFailure.message).slice(0, 120)})` : ''}`
      : require('./wakeup').statesBlocker(output) ? 'it stated a blocker' : null;
    if (unfinished) {
      fate = { failed: true, why: unfinished, candidate };
      job._finish('FAILED', { error: unfinished });
      return { ok: false, role: c.role, stage, why: `${unfinished}${output ? ` — what it said: ${output.slice(-400)}` : ''}`, mutations: ws ? [] : (record && record.mutations) || [], candidate, holder };
    }
    job._finish('SUCCEEDED', { result: record });
    return { ok: true, role: c.role, stage, output, mutations: ws ? [] : (record && record.mutations) || [], toolCalls: (record && record.toolCalls) || 0, settlement, candidate, holder };
  } catch (e) {
    fate = { failed: true, why: (e && e.message) || String(e), candidate: null };
    job._finish('FAILED', { error: (e && e.message) || String(e) });
    return { ok: false, role: c.role, stage, why: (e && e.message) || String(e), holder };
  } finally {
    leases.release(holder);
    // THE WORKSPACE BELONGS TO ITS LIFECYCLE NOW, not to this call. A child that
    // proposed nothing is cleaned at once; a candidate waits for its resolution
    // (integration + verification, or rejection); a failure is RETAINED as
    // evidence. The temporary trust goes with the call either way.
    if (ws && ws.temp) {
      const tw = require('./tempworkspaces');
      try { tw.candidateReady(ws.temp, fate.candidate, { failed: fate.failed, why: fate.why }); tw.attempt(ws.temp, app); } catch { /* retained: the lifecycle reconciles it at the next start */ }
    } else if (ws) cands.dispose(ws);
    if (trust && app.cfg && Array.isArray(app.cfg.trustedPaths)) app.cfg.trustedPaths = app.cfg.trustedPaths.filter((t) => t !== trust);
    app.jobs.changed();
    // AGENT COMPLETE · Role · result — a transient operation note, then gone:
    // the result lives in the parent's evidence, not as worker chatter.
    try {
      const said = job.state === 'SUCCEEDED' ? String(job.resultSummary || 'done').replace(/\s+/g, ' ').slice(0, 40) : 'failed';
      require('./ui/operation').say(app, `AGENT ${job.state === 'SUCCEEDED' ? 'COMPLETE' : 'FAILED'} · ${c.role} · ${said}`);
    } catch { /* nothing drawn */ }
  }
}

function currentStep(app) {
  const plan = app && app.session && app.session.plan;
  const st = plan && plan.steps ? plan.steps.find((s) => s.status === 'active') || plan.steps.find((s) => s.status !== 'done' && s.status !== 'dropped') : null;
  return st ? st.text : null;
}

/**
 * Run a set of contracts. `pipeline` runs them in order, each stage handed the
 * earlier stages' outputs; `parallel` requires disjoint write ownership.
 */
async function run(app, raw = [], { mode = 'pipeline', runner = null, signal = null } = {}) {
  const parentTask = (app.session.task && app.session.task.objective) || '';
  const contracts = [];
  for (const r of raw) {
    const v = validate(r, { parentTask });
    if (!v.ok) return { ok: false, why: v.why, results: [] };
    contracts.push(v.contract);
  }
  if (!contracts.length) return { ok: false, why: 'no subagents were described', results: [] };
  if (mode === 'parallel') {
    const p = partition(contracts);
    if (!p.ok) return { ok: false, why: p.why, results: [] };
    // AT MOST maxConcurrent AT ONCE (`/subagents max N`), in waves, results in order.
    const { maxConcurrent } = settings(app);
    const results = new Array(contracts.length);
    for (let from = 0; from < contracts.length; from += maxConcurrent) {
      const wave = contracts.slice(from, from + maxConcurrent);
      const done = await Promise.all(wave.map((c, k) => runOne(app, c, { stage: from + k, of: contracts.length, runner, signal })));
      done.forEach((r, k) => { results[from + k] = r; });
    }
    return { ok: results.every((r) => r.ok), mode, results };
  }
  const results = [];
  for (let i = 0; i < contracts.length; i++) {
    const r = await runOne(app, contracts[i], { stage: i, of: contracts.length, inputs: results.filter((x) => x.ok), runner, signal });
    results.push(r);
    if (!r.ok) break;
    // A LATER STAGE NEVER BUILDS ON UNMERGED STATE: once a stage produced a
    // candidate, the main agent integrates it before the rest runs.
    if (r.candidate && r.candidate.files.length && i < contracts.length - 1) { r.awaitsIntegration = true; break; }
  }
  // WHAT NEVER RAN is part of the handoff: a stage-2 failure used to report "1/2 completed" of a 4-stage pipeline.
  const paused = results.some((r) => r.awaitsIntegration);
  return { ok: (results.length === contracts.length || paused) && results.every((r) => r.ok), mode, results, remaining: contracts.slice(results.length), paused };
}

function report(out) {
  if (!out.ok && !out.results.length) return `DELEGATION REFUSED: ${out.why}`;
  const rest = out.remaining || [];
  const done = out.results.filter((r) => r.ok).length;
  const failed = out.results.length - done;
  const total = out.results.length + rest.length;
  const lines = [`SUBAGENTS · ${out.mode} · ${done}/${total} completed${failed ? ` · ${failed} failed` : ''}${rest.length ? ` · ${rest.length} not run` : ''}`];
  for (const r of out.results) {
    lines.push('', `[${r.stage + 1}] ${r.role} — ${r.ok ? 'DONE' : 'FAILED'}${r.mutations && r.mutations.length ? ` · changed ${r.mutations.join(', ')}` : ''}`);
    lines.push(r.ok ? (r.output || '(no output)').slice(0, 3000) : `why: ${r.why}`);
    if (r.candidate && (r.candidate.files.length || r.candidate.discarded.length)) lines.push(require('./candidates').describe(r.candidate));
  }
  const cands = out.results.filter((r) => r.candidate && r.candidate.files.length);
  if (cands.length) {
    lines.push('', 'NOTHING WAS WRITTEN TO THE PROJECT. Each change above is a CANDIDATE built in an isolated workspace (kept until the candidate is integrated and verified, or rejected). '
      + 'Inspect it, then integrate_candidate {id} (optionally only some files) — you are the integrator: wire the parts together, '
      + 'remove duplicate concepts, then run the integration test and the final smoke. A subagent pass is not a project pass.');
  }
  const waiting = out.results.find((r) => r.awaitsIntegration);
  if (waiting) lines.push('', `PIPELINE PAUSED after stage ${waiting.stage + 1}: integrate candidate ${waiting.candidate.id} first, then delegate the remaining stage(s) so they start from the integrated tree.`);
  const paused = out.results.some((r) => r.awaitsIntegration);
  rest.forEach((c, k) => lines.push('', `[${out.results.length + k + 1}] ${c.role} — NOT RUN (${paused ? 'waiting for the candidate above to be integrated' : 'the pipeline stopped at the failure above'}) · ${String(c.objective || '').slice(0, 160)}`));
  if (failed || (rest.length && !paused)) lines.push('', 'HANDOFF: the failed stage and every stage after it are yours — do that work here, or delegate again with a corrected contract. Completed stages stand.');
  lines.push('', 'You are the integrator: check these results against the task before relying on them.');
  return lines.join('\n');
}

/**
 * THE PERSON'S SETTING (`/subagents`): AUTO (the model delegates when the work
 * genuinely partitions — the recommended default) or OFF; and how many workers
 * may run at once. Persisted in config; the execution profile still applies on
 * top (ECO refuses unless asked — profile.js).
 */
const DEFAULT_MAX = 3;
function settings(app) {
  const s = (app && app.cfg && app.cfg.subagents) || {};
  const mode = String(s.mode || 'auto').toLowerCase() === 'off' ? 'off' : 'auto';
  const max = Math.max(1, Math.min(8, Number(s.maxConcurrent) || DEFAULT_MAX));
  return { mode, maxConcurrent: max };
}

/** Running subagent jobs right now — what the AGENTS counter shows. */
function running(app) {
  return app && app.jobs && typeof app.jobs.running === 'function' ? app.jobs.running().filter((j) => j.kind === 'subagent') : [];
}

module.exports = { ROLES, validate, partition, brief, runOne, run, report, settings, running, DEFAULT_MAX };
