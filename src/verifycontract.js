'use strict';

/**
 * THE VERIFY CONTRACT — what proves a change, how far to escalate, and what a
 * failure at a higher tier is allowed to mean.
 *
 * ------------------------------------------------------------------------
 * THE LADDER.
 *
 *     TARGETED    the exact requested behaviour           tests named for the changed files
 *     IMPACT      the direct dependency surface           tests of what imports them
 *     SUBSYSTEM   the subsystem the change sits in        the directory's tests
 *     PROJECT     broad repository regression             the whole suite
 *     RELEASE     package / distribution / live proof     install + real-app + live tiers
 *
 * SELECTION IS FROM THE CHANGE, NOT FROM HABIT. A one-file fix nothing imports
 * selects TARGETED and stops there; a change to the test runner or the package
 * manifest selects PROJECT; a change under distribution/ or bin/ selects RELEASE.
 * Escalation is evidence-driven: a tier runs only when the tier below it
 * passed and the selected level is above it.
 *
 * ------------------------------------------------------------------------
 * A FAILURE IS EVIDENCE, NOT AUTHORITY. A higher tier that fails is classified
 * before anyone repairs anything:
 *
 *     CAUSED_BY_CURRENT_TASK   touches what this task changed, and was not failing before
 *     RELEVANT_PREEXISTING     was failing before, and touches the changed surface
 *     UNRELATED_PREEXISTING    was failing before, and does not
 *     CONCURRENT_FOREIGN       touches a file another session is writing
 *     ENVIRONMENTAL            a missing tool, a port, a network, a permission
 *     UNKNOWN_CAUSALITY        none of the above can be established
 *
 * Only CAUSED_BY_CURRENT_TASK authorises repair within the task. Everything else
 * is recorded as a foreign failure on the task (task.js `noteForeignFailure`).
 *
 * THREE CLAIMS, NEVER ONE:  TASK PASSED  ≠  PROJECT CLEAN  ≠  RELEASE READY.
 *
 * ------------------------------------------------------------------------
 * EVIDENCE STATES. The Cowork/Bot certification already refused to call a
 * fixture a live proof; the same words apply to every verification:
 *
 *     CLAIMED                     a model said so            not evidence
 *     STATIC_VERIFIED             parse, lint, types
 *     FIXTURE_VERIFIED            unit tests over fakes
 *     LOCAL_INTEGRATION_VERIFIED  real modules wired together
 *     REAL_TTY_VERIFIED           the CLI in a real terminal
 *     REAL_APP_VERIFIED           the real application running
 *     LIVE_VERIFIED               a real external service
 */

const path = require('path');

const LEVEL = Object.freeze({
  UNSPECIFIED: 'UNSPECIFIED',
  TARGETED: 'TARGETED',
  IMPACT: 'IMPACT',
  SUBSYSTEM: 'SUBSYSTEM',
  PROJECT: 'PROJECT',
  RELEASE: 'RELEASE',
});
const LADDER = [LEVEL.TARGETED, LEVEL.IMPACT, LEVEL.SUBSYSTEM, LEVEL.PROJECT, LEVEL.RELEASE];

const EVIDENCE = Object.freeze({
  CLAIMED: 'CLAIMED',
  UNVERIFIED: 'UNVERIFIED',
  STATIC_VERIFIED: 'STATIC_VERIFIED',
  FIXTURE_VERIFIED: 'FIXTURE_VERIFIED',
  LOCAL_INTEGRATION_VERIFIED: 'LOCAL_INTEGRATION_VERIFIED',
  REAL_TTY_VERIFIED: 'REAL_TTY_VERIFIED',
  REAL_APP_VERIFIED: 'REAL_APP_VERIFIED',
  LIVE_VERIFIED: 'LIVE_VERIFIED',
});
const EVIDENCE_RANK = [EVIDENCE.CLAIMED, EVIDENCE.UNVERIFIED, EVIDENCE.STATIC_VERIFIED, EVIDENCE.FIXTURE_VERIFIED,
  EVIDENCE.LOCAL_INTEGRATION_VERIFIED, EVIDENCE.REAL_TTY_VERIFIED, EVIDENCE.REAL_APP_VERIFIED, EVIDENCE.LIVE_VERIFIED];

const CAUSE = Object.freeze({
  CAUSED_BY_CURRENT_TASK: 'CAUSED_BY_CURRENT_TASK',
  RELEVANT_PREEXISTING: 'RELEVANT_PREEXISTING',
  UNRELATED_PREEXISTING: 'UNRELATED_PREEXISTING',
  CONCURRENT_FOREIGN: 'CONCURRENT_FOREIGN',
  ENVIRONMENTAL: 'ENVIRONMENTAL',
  UNKNOWN_CAUSALITY: 'UNKNOWN_CAUSALITY',
});

/** Files whose change can break anything — the runner, the manifest, the build. */
const PROJECT_WIDE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|\.eslintrc[^/]*|pyproject\.toml|setup\.py|requirements[^/]*\.txt|Cargo\.toml|go\.mod|Makefile|tests\/run\.js|tests\/helpers\.js|jest\.config[^/]*|vitest\.config[^/]*|pytest\.ini)$/i;
/** Files whose change needs packaging or live proof. */
const RELEASE_WIDE = /(^|\/)(distribution\/|bin\/|installer\/|release\/|\.github\/workflows\/|Dockerfile$|electron-builder[^/]*$)/i;
const MANY_FILES = 12;
const WIDE_FAN_IN = 8;

function norm(rel) { return String(rel || '').replace(/\\/g, '/').replace(/^\.\//, ''); }

function rank(level) { const i = LADDER.indexOf(level); return i < 0 ? -1 : i; }
function max(a, b) { return rank(a) >= rank(b) ? a : b; }

/**
 * THE INDEX AS IT WAS LAST WRITTEN, never refreshed here. Selection runs on
 * every write and must not become a tree walk; dependents from a slightly old
 * index are an input to a LEVEL, and the tests that run at that level are the
 * check. Absent index → no dependents known, which never lowers RELEASE/PROJECT.
 */
function indexOf(cwd) {
  try { return require('./projectindex').load(cwd); } catch { return { files: {} }; }
}

/** Test files whose name names a changed module. */
function testsNaming(index, changed) {
  const names = new Set(changed.map((r) => path.posix.basename(norm(r)).replace(/\.[^.]+$/, '').toLowerCase()));
  return Object.keys(index.files || {}).filter((rel) => {
    if (!/(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.[a-z]+$/i.test(rel)) return false;
    const base = path.posix.basename(rel).replace(/\.(test|spec)?\.?[a-z]+$/i, '').replace(/\.(test|spec)$/i, '').toLowerCase();
    return names.has(base);
  });
}

/**
 * WHICH LEVEL THIS CHANGE CALLS FOR, and why.
 *
 * @param {string}   cwd
 * @param {string[]} changedRels
 * @param {object}   [o]  { objective } — a task that says "release" asks for release proof
 */
function selectFor(cwd, changedRels, { objective = '' } = {}) {
  const changed = (changedRels || []).map(norm).filter(Boolean);
  const reasons = [];
  if (!changed.length && !/\b(release|publish|package|ship|distribut)/i.test(objective)) {
    return { level: LEVEL.UNSPECIFIED, reasons: ['nothing has changed, so there is nothing to select a level for'], targets: {} };
  }
  let level = LEVEL.TARGETED;
  reasons.push('every change is proved at its own behaviour first');
  const index = indexOf(cwd);
  const ix = require('./projectindex');
  const dependents = {};
  for (const rel of changed) dependents[rel] = ix.importersOf(index, rel);
  const fanIn = Object.values(dependents).reduce((n, d) => n + d.length, 0);
  if (fanIn > 0) { level = max(level, LEVEL.IMPACT); reasons.push(`${fanIn} file(s) import what changed`); }
  const dirs = new Set(changed.map((r) => r.split('/').slice(0, 2).join('/')));
  if (changed.length > 3 || Object.values(dependents).some((d) => d.length >= WIDE_FAN_IN)) {
    level = max(level, LEVEL.SUBSYSTEM);
    reasons.push(changed.length > 3 ? `${changed.length} files changed` : `a changed file has ${WIDE_FAN_IN}+ dependents`);
  }
  if (changed.length > MANY_FILES || changed.some((r) => PROJECT_WIDE.test(r))) {
    level = max(level, LEVEL.PROJECT);
    reasons.push(changed.length > MANY_FILES ? `${changed.length} files changed` : 'a project-wide file changed (manifest, runner or config)');
  }
  if (changed.some((r) => RELEASE_WIDE.test(r)) || /\b(release|publish|ship)\b/i.test(objective)) {
    level = LEVEL.RELEASE;
    reasons.push('packaging, distribution or a release was named');
  }
  return {
    level,
    reasons,
    targets: {
      targeted: testsNaming(index, changed),
      impact: [...new Set(Object.values(dependents).flat())],
      subsystem: [...dirs],
    },
  };
}

/**
 * THE TIERS TO RUN, in order, up to the selected level. Each carries the
 * evidence state its passing would earn.
 */
function planFor(selection) {
  const top = rank(selection.level);
  if (top < 0) return [];
  const t = selection.targets || {};
  return LADDER.slice(0, top + 1).map((level) => ({
    level,
    targets: level === LEVEL.TARGETED ? (t.targeted || []) : level === LEVEL.IMPACT ? (t.impact || [])
      : level === LEVEL.SUBSYSTEM ? (t.subsystem || []) : [],
    evidence: level === LEVEL.RELEASE ? EVIDENCE.REAL_APP_VERIFIED
      : level === LEVEL.PROJECT ? EVIDENCE.LOCAL_INTEGRATION_VERIFIED : EVIDENCE.FIXTURE_VERIFIED,
  }));
}

/**
 * RUN THE PLAN, ESCALATING ONLY ON EVIDENCE.
 *
 * `runTier(tier)` → { ok, failures:[{id, files, message}], evidence }. A tier
 * that fails stops the ladder: a narrow failure is what to look at, and running
 * the whole suite on top of it would bury it.
 */
async function escalate(plan, runTier) {
  const runs = [];
  for (const tier of plan) {
    const r = await runTier(tier);
    runs.push({ level: tier.level, ok: Boolean(r && r.ok), failures: (r && r.failures) || [], evidence: (r && r.evidence) || tier.evidence });
    if (!r || !r.ok) break;
  }
  return runs;
}

const ENV_RE = /\b(ENOENT|EADDRINUSE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EACCES|EPERM|ENOTFOUND|command not found|is not recognized as|not installed|no such (?:device|host)|network|rate.?limit|429|503|sandbox|permission denied)\b/i;

/**
 * WHOSE FAILURE IS THIS?
 *
 * @param {object} failure  { id, files:[rel], message }
 * @param {object} ctx
 *   `changed`     files this task changed
 *   `dependents`  files that import them (the impact surface)
 *   `baseline`    failure ids already failing before this task (a Set or array)
 *   `concurrent`  files another session has written meanwhile
 */
function classifyFailure(failure, { changed = [], dependents = [], baseline = [], concurrent = [] } = {}) {
  const f = failure || {};
  const files = (f.files || []).map(norm);
  const id = String(f.id || files[0] || '');
  const was = new Set(Array.isArray(baseline) ? baseline : [...(baseline || [])]);
  const surface = new Set([...changed.map(norm), ...dependents.map(norm)]);
  const touches = files.some((x) => surface.has(x));
  if (ENV_RE.test(String(f.message || ''))) return CAUSE.ENVIRONMENTAL;
  if (files.some((x) => concurrent.map(norm).includes(x) && !changed.map(norm).includes(x))) return CAUSE.CONCURRENT_FOREIGN;
  if (was.has(id)) return touches ? CAUSE.RELEVANT_PREEXISTING : CAUSE.UNRELATED_PREEXISTING;
  if (touches) return CAUSE.CAUSED_BY_CURRENT_TASK;
  return CAUSE.UNKNOWN_CAUSALITY;
}

/**
 * SETTLE A VERIFICATION INTO ITS THREE CLAIMS.
 *
 * @param {object} o
 *   `runs`     escalate()'s output
 *   `selected` the selected level
 *   `classify` (failure) => CAUSE
 */
function settle({ runs = [], selected = LEVEL.UNSPECIFIED, classify = () => CAUSE.UNKNOWN_CAUSALITY } = {}) {
  const targeted = runs.find((r) => r.level === LEVEL.TARGETED);
  const failures = [];
  for (const r of runs) for (const f of r.failures) failures.push({ ...f, level: r.level, cause: classify(f) });
  const ours = failures.filter((f) => f.cause === CAUSE.CAUSED_BY_CURRENT_TASK);
  const taskPassed = Boolean(targeted && targeted.ok) && ours.length === 0;
  const reachedTop = runs.length > 0 && runs[runs.length - 1].level === selected && runs[runs.length - 1].ok;
  const projectClean = failures.length === 0 && runs.some((r) => rank(r.level) >= rank(LEVEL.PROJECT) && r.ok);
  const strongest = strongestEvidence(runs.filter((r) => r.ok).map((r) => r.evidence));
  const releaseReady = projectClean && runs.some((r) => r.level === LEVEL.RELEASE && r.ok)
    && EVIDENCE_RANK.indexOf(strongest) >= EVIDENCE_RANK.indexOf(EVIDENCE.REAL_APP_VERIFIED);
  return {
    selected,
    taskPassed,
    projectClean,
    releaseReady,
    reachedSelected: reachedTop,
    evidence: strongest,
    repairAuthorized: ours,
    foreign: failures.filter((f) => f.cause !== CAUSE.CAUSED_BY_CURRENT_TASK),
  };
}

function strongestEvidence(states) {
  let best = EVIDENCE.UNVERIFIED;
  for (const s of states || []) if (EVIDENCE_RANK.indexOf(s) > EVIDENCE_RANK.indexOf(best)) best = s;
  return best;
}

/** What a command's run earns, by what it ran. Never stronger than the runner. */
function evidenceForCommand(command = '') {
  const c = String(command);
  if (/\blive\b/i.test(c)) return EVIDENCE.LIVE_VERIFIED;
  if (/\bsmoke\b|\bpty\b|\btty\b/i.test(c)) return EVIDENCE.REAL_TTY_VERIFIED;
  if (/\bdistribution\b|\binstall\b/i.test(c)) return EVIDENCE.REAL_APP_VERIFIED;
  if (/\bintegration\b/i.test(c)) return EVIDENCE.LOCAL_INTEGRATION_VERIFIED;
  if (/\b(lint|tsc|eslint|ruff|mypy|check)\b/i.test(c)) return EVIDENCE.STATIC_VERIFIED;
  return EVIDENCE.FIXTURE_VERIFIED;
}

const MAX_RUNS = 20;

/** Record one verification run against the session. Bounded. */
function record(session, { command = '', ok = false, level = '', failures = [], evidence = '', persist = true } = {}) {
  if (!session) return null;
  const v = session.verification && typeof session.verification === 'object' ? session.verification : { runs: [] };
  const row = {
    command: String(command).slice(0, 160),
    ok: Boolean(ok),
    level: level || LEVEL.UNSPECIFIED,
    evidence: evidence || evidenceForCommand(command),
    failures: (failures || []).slice(0, 20),
    at: new Date().toISOString(),
  };
  v.runs = [...(v.runs || []), row].slice(-MAX_RUNS);
  session.verification = v;
  // DURABLE, WITH PROOF: the check is recorded in `.lain/validation` against the
  // fingerprints of the files the task had changed, so it goes STALE when they move.
  if (persist && session.cwd) {
    try {
      const lainstore = require('./lainstore');
      const life = session.lifecycle;
      const changed = life && life.evidence && life.evidence.filesChanged
        ? [...life.evidence.filesChanged].map((f) => norm(path.isAbsolute(f) ? path.relative(session.cwd, f) : f)) : [];
      const body = lainstore.read(session.cwd, 'validation', null) || { checks: [] };
      const checks = Array.isArray(body.checks) ? body.checks : [];
      checks.push({ ...row, failures: row.failures.length, proof: require('./freshness').stamp(session.cwd, changed).evidence });
      lainstore.write(session.cwd, 'validation', { checks: checks.slice(-50) });
    } catch { /* the in-session record stands */ }
  }
  return row;
}

/**
 * THE CONTRACT FOR A SESSION, as the authority projection reports it.
 *
 * `level` is selected from what the task has changed; UNSPECIFIED only when it
 * has changed nothing. `taskComplete` and `projectClean` stay the two separate
 * claims authority.js always kept.
 */
function contractFor(session) {
  const t = session && session.task;
  const life = session && session.lifecycle;
  const cwd = (session && session.cwd) || process.cwd();
  const changed = life && life.evidence && life.evidence.filesChanged
    ? [...life.evidence.filesChanged].map((f) => norm(path.isAbsolute(f) ? path.relative(cwd, f) : f)) : [];
  const selection = selectFor(cwd, changed, { objective: (t && t.objective) || '' });
  const runs = (session && session.verification && session.verification.runs) || [];
  const foreign = t && Array.isArray(t.foreignFailures) ? t.foreignFailures : [];
  const passing = runs.filter((r) => r.ok);
  return {
    level: selection.level,
    reasons: selection.reasons,
    plan: planFor(selection).map((p) => p.level),
    runs: runs.slice(-5),
    evidence: strongestEvidence(passing.map((r) => r.evidence)),
    taskPassed: runs.length > 0 && runs[runs.length - 1].ok,
    projectClean: foreign.length === 0 && passing.some((r) => r.level === LEVEL.PROJECT),
    releaseReady: false,
  };
}

/**
 * WHAT COMPLETION REQUIRES — THE verification authority (Execution Discipline §19–§20). The completion arbiter asks
 * this; nothing else decides how much proof a change needs.
 *
 *   TARGETED / IMPACT / SUBSYSTEM   current evidence that exercises the change (a check, or a Preview observation)
 *   PROJECT                         … and the project's broad suite, passing after the last change (finalsmoke.js
 *                                   is the EXECUTOR of that one requirement — not a ritual every task performs)
 *   RELEASE                         … and, when the task is about shipping/packaging, packaging evidence
 *
 * @returns {{ level, reasons, needsSuite, needsPackaging, minDiscrimination }}
 */
function requirement(cwd, changedRels, { objective = '', discretion = 'STRONG' } = {}) {
  const sel = selectFor(cwd, changedRels, { objective });
  const r = rank(sel.level);
  return {
    level: sel.level,
    reasons: sel.reasons,
    needsSuite: r >= rank(LEVEL.PROJECT),
    needsPackaging: /\b(release|publish|packag\w*|ship|installer|distribut\w*|production (?:build|package))\b/i.test(objective),
    // LESS DISCRETION, NOT LOWER STANDARDS: a weaker model must show evidence that exercises the change itself.
    minDiscrimination: discretion === 'WEAK' ? 'MODERATE' : 'LOW',
  };
}

module.exports = {
  LEVEL, LADDER, EVIDENCE, EVIDENCE_RANK, CAUSE,
  selectFor, planFor, escalate, classifyFailure, settle, strongestEvidence, evidenceForCommand,
  record, contractFor, requirement,
};
