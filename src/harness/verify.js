'use strict';

/** THE VERIFICATION ENGINE — the only thing in LAIN that may say a task passed. */

const checks = require('./checks');
const { VERDICT } = checks;

/** A contract with more than this is a task that should have been two tasks. */
const MAX_REQUIREMENTS = 24;
const MAX_CHECKS_PER_REQUIREMENT = 12;

/** Normalise whatever the caller wrote into a contract. */
function contract(spec = {}) {
  const raw = Array.isArray(spec) ? spec : (spec.requirements || []);
  const requirements = [];
  for (const r of raw.slice(0, MAX_REQUIREMENTS)) {
    if (!r) continue;
    const checkList = (Array.isArray(r.checks) ? r.checks : (r.check ? [r.check] : []))
      .slice(0, MAX_CHECKS_PER_REQUIREMENT)
      .filter(Boolean);
    requirements.push({
      id: String(r.id || `r${requirements.length + 1}`),
      description: String(r.description || r.requirement || r.id || 'requirement').slice(0, 300),
      required: r.required !== false,
      checks: checkList,
    });
  }
  return {
    name: String(spec.name || 'verification').slice(0, 120),
    taskId: spec.taskId ? String(spec.taskId) : null,
    requirements,
  };
}

/** ROLL UP THE CHECKS OF ONE REQUIREMENT. */
function rollUpRequirement(results) {
  if (!results.length) {
    return { verdict: VERDICT.INCONCLUSIVE, why: 'no evidence was named for this requirement' };
  }
  const failed = results.filter((r) => r.verdict === VERDICT.FAILED);
  if (failed.length) {
    return { verdict: VERDICT.FAILED, why: failed.map((r) => `${r.label}: ${r.why}`).join('; ') };
  }
  const missing = results.filter((r) => r.verdict !== VERDICT.PASSED);
  if (missing.length) {
    return { verdict: VERDICT.INCONCLUSIVE, why: missing.map((r) => `${r.label}: ${r.why}`).join('; ') };
  }
  return { verdict: VERDICT.PASSED, why: results.map((r) => r.label).join(', ') };
}

/** The contract verdict. See the header — the order of these three tests is the design. */
function rollUpContract(requirements) {
  const required = requirements.filter((r) => r.required);
  const failed = required.filter((r) => r.verdict === VERDICT.FAILED);
  if (failed.length) {
    return {
      verdict: VERDICT.FAILED,
      why: `${failed.length} required requirement${failed.length === 1 ? '' : 's'} failed: ${failed.map((r) => r.description).join('; ')}`,
    };
  }
  if (!required.length) {
    return { verdict: VERDICT.INCONCLUSIVE, why: 'the contract required nothing, so nothing was proved' };
  }
  const missing = required.filter((r) => r.verdict !== VERDICT.PASSED);
  if (missing.length) {
    return {
      verdict: VERDICT.INCONCLUSIVE,
      why: `required evidence is missing for: ${missing.map((r) => r.description).join('; ')}`,
    };
  }
  return { verdict: VERDICT.PASSED, why: `all ${required.length} required requirements passed` };
}

/** RUN A CONTRACT. */
const reports = new WeakSet();
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function isResult(value, taskId) {
  return reports.has(value) && value.taskId === taskId;
}

async function run(spec, ctx = {}) {
  const c = contract(spec);
  const began = Date.now();
  const out = [];
  for (const req of c.requirements) {
    const results = [];
    for (const check of req.checks) {
      // eslint-disable-next-line no-await-in-loop -- checks are deliberately
      // sequential: two test suites running at once contend for the same ports
      // and the same build directory, which manufactures failures.
      results.push(await checks.run(check, { ...ctx, taskId: ctx.taskId || c.taskId }));
    }
    const rolled = rollUpRequirement(results);
    out.push({ ...req, ...rolled, checks: results });
  }
  const rolled = rollUpContract(out);
  const count = (v) => out.filter((r) => r.verdict === v).length;
  const report = {
    name: c.name,
    contract: c.name,
    taskId: ctx.taskId || c.taskId,
    verdict: rolled.verdict,
    why: rolled.why,
    passed: count(VERDICT.PASSED),
    failed: count(VERDICT.FAILED),
    inconclusive: count(VERDICT.INCONCLUSIVE),
    requirements: out,
    at: began,
    ms: Date.now() - began,
  };
  reports.add(report);
  return freeze(report);
}

/** THE REPORT A PERSON READS, and the one kept as an artifact. */
function render(report) {
  const mark = (v) => (v === VERDICT.PASSED ? 'PASS' : v === VERDICT.FAILED ? 'FAIL' : 'INCONCLUSIVE');
  const lines = [];
  lines.push(`VERIFICATION ${report.verdict} — ${report.name}`);
  lines.push(report.why);
  lines.push('');
  for (const r of report.requirements) {
    lines.push(`[${mark(r.verdict)}] ${r.description}${r.required ? '' : '  (optional)'}`);
    for (const c of r.checks) {
      lines.push(`    ${mark(c.verdict).padEnd(12)} ${c.label} — ${c.why}`);
    }
  }
  lines.push('');
  lines.push(`${report.passed} passed · ${report.failed} failed · ${report.inconclusive} inconclusive · ${report.ms}ms`);
  return lines.join('\n');
}

module.exports = {
  run, contract, render, rollUpRequirement, rollUpContract, isResult,
  VERDICT, MAX_REQUIREMENTS, MAX_CHECKS_PER_REQUIREMENT,
};
