'use strict';

/** WHAT THE LOG SAID AGAINST WHAT THE SCREEN SHOWED. */

const { SOURCE } = require('./observe');

const VERDICT = Object.freeze({
  CORROBORATED: 'CORROBORATED',
  CONTRADICTED: 'CONTRADICTED',
  UNRESOLVED: 'UNRESOLVED',
  UNEXPLAINED: 'UNEXPLAINED',
});

/** How close in time two records must be to be about the same moment. */
const WINDOW_MS = 3000;

/** Does this visual record support, or contradict, what the log claimed? */
function mentions(text, terms) {
  const hay = String(text || '').toLowerCase();
  return terms.filter((t) => t && hay.includes(String(t).toLowerCase()));
}

/** ONE CLAIM, CHECKED. */
function checkClaim(claim, visuals, expect = {}) {
  const present = Array.isArray(expect.present) ? expect.present : [];
  const absent = Array.isArray(expect.absent) ? expect.absent : [];

  const near = visuals.filter((v) => Math.abs(v.at - claim.at) <= WINDOW_MS);
  if (!near.length) {
    return {
      verdict: VERDICT.UNRESOLVED,
      claim,
      visual: null,
      why: 'nothing looked at the screen near this moment, so the claim is neither confirmed nor denied',
    };
  }
  // The one with text is worth more than the one without: a screenshot nobody
  // read says only that a picture exists.
  const seen = near.find((v) => v.ok && v.text) || near.find((v) => v.ok) || near[0];
  if (!seen.ok) {
    return {
      verdict: VERDICT.UNRESOLVED,
      claim,
      visual: seen,
      why: `the screen could not be captured here — ${seen.why || 'no reason recorded'}`,
    };
  }
  if (!seen.text) {
    return {
      verdict: VERDICT.UNRESOLVED,
      claim,
      visual: seen,
      why: 'a screenshot exists but nothing has read it — NOT SEEN until something does',
    };
  }

  const found = mentions(seen.text, present);
  const shouldBeGone = mentions(seen.text, absent);

  if (shouldBeGone.length) {
    return {
      verdict: VERDICT.CONTRADICTED,
      claim,
      visual: seen,
      why: `the log says ${claim.kind}, and the screen still shows ${shouldBeGone.join(', ')}`,
    };
  }
  if (present.length && !found.length) {
    return {
      verdict: VERDICT.CONTRADICTED,
      claim,
      visual: seen,
      why: `the log says ${claim.kind}, and the screen does not show ${present.join(' or ')}`,
    };
  }
  if (found.length) {
    return {
      verdict: VERDICT.CORROBORATED,
      claim,
      visual: seen,
      why: `the log says ${claim.kind} and the screen shows ${found.join(', ')}`,
    };
  }
  return {
    verdict: VERDICT.UNRESOLVED,
    claim,
    visual: seen,
    why: 'the screen was read and says nothing either way about this claim',
  };
}

/** VISUAL EVIDENCE THAT NO LOG LINE ACCOUNTS FOR. */
function unexplained(visuals, logs, watchFor = []) {
  const out = [];
  for (const v of visuals) {
    if (!v.ok || !v.text) continue;
    const hits = mentions(v.text, watchFor);
    if (!hits.length) continue;
    const near = logs.filter((l) => Math.abs(l.at - v.at) <= WINDOW_MS);
    if (near.length) continue;
    out.push({
      verdict: VERDICT.UNEXPLAINED,
      claim: null,
      visual: v,
      why: `the screen showed ${hits.join(', ')} and no log line was written near that moment`,
    });
  }
  return out;
}

/** THE WHOLE COMPARISON, for one finished observation. */
function compare(obs, { claims = [], expect = {}, watchFor = [] } = {}) {
  const logs = obs.from(SOURCE.LOG);
  const visuals = obs.captures.slice();
  const wanted = new Set(claims);

  const findings = [];
  for (const l of logs) {
    if (wanted.size && !wanted.has(l.kind)) continue;
    findings.push(checkClaim(l, visuals, expect[l.kind] || {}));
  }
  findings.push(...unexplained(visuals, logs, watchFor));

  const count = (v) => findings.filter((f) => f.verdict === v).length;
  return {
    findings,
    counts: {
      CORROBORATED: count(VERDICT.CORROBORATED),
      CONTRADICTED: count(VERDICT.CONTRADICTED),
      UNRESOLVED: count(VERDICT.UNRESOLVED),
      UNEXPLAINED: count(VERDICT.UNEXPLAINED),
    },
    /** WHAT TO DO NEXT — a question when the evidence disagrees with itself. */
    question: findings.find((f) => f.verdict === VERDICT.CONTRADICTED) || null,
  };
}

/** The comparison as lines a person reads, sources kept apart. */
function lines(result) {
  const out = [];
  for (const f of result.findings) {
    out.push(`${f.verdict}  ${f.why}`);
    if (f.claim) out.push(`    LOG    ${f.claim.detail || f.claim.kind}`);
    if (f.visual && f.visual.ok) {
      out.push(`    SCREEN ${f.visual.path || 'captured'}${f.visual.text ? ` — ${f.visual.text.slice(0, 120)}` : ' — NOT SEEN (nothing read it)'}`);
    } else if (f.visual) {
      out.push(`    SCREEN NOT CAPTURED — ${f.visual.why}`);
    } else {
      out.push('    SCREEN NOT SEEN');
    }
  }
  return out;
}

module.exports = { compare, checkClaim, unexplained, lines, VERDICT, WINDOW_MS };
