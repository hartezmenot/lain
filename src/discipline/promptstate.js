'use strict';

/**
 * WHAT THE MODEL SEES OF THE TASK EACH TURN (prompt.js `# Task state`) — the continuity digest, the verification the
 * contract asks for, and how the work is shaped for this model's measured discretion. Conclusions only; rebuilt
 * every turn from Core state, so it can never drift into a second, stale copy.
 */

function lines(session, model) {
  const life = session && session.lifecycle;
  if (!life || !life.discipline || life.isTerminal) return '';
  const out = [];
  // THE REQUEST TEXT STAYS IN ITS THREAD: a task begun in Chat and continued in Coding (an accepted plan) must not
  // carry the Chat message onto the Coding wire — the accepted plan is what Coding is given.
  const sameThread = !life.thread || life.thread === (session.thread || null);
  const digest = require('./digest').digest(life, { cwd: session.cwd, request: sameThread });
  if (digest) out.push(digest);
  const changed = [...life.evidence.filesChanged];
  if (changed.length) {
    const prof = require('./profile').discretion(model);
    const req = require('../verifycontract').requirement(session.cwd || process.cwd(), changed.map((p) => require('path').relative(session.cwd || process.cwd(), p).replace(/\\/g, '/')), { objective: life.objective, discretion: prof.level });
    let v = `VERIFICATION: ${req.level} — ${req.reasons[req.reasons.length - 1] || ''}`;
    if (req.needsSuite) {
      const fs = require('../finalsmoke');
      const st = fs.state(life, session.cwd);
      const s = fs.suite(session.cwd);
      if (s && st !== 'PASSED') v += `; broad proof needed: the project suite (${s.command}) after the last change`;
    }
    if (req.needsPackaging) v += '; this task is about a release/package: packaging evidence is part of done';
    out.push(v);
    if (prof.level === 'WEAK') out.push('DISCRETION: narrow — change only what the task names, verify each change with a check that exercises it, and request completion only with that evidence. Escalate early if stuck.');
  }
  if (require('./arbiter').outcomeSatisfied(life)) out.push('OUTCOME SATISFIED — report and request_completion; do not keep changing things.');
  return out.join('\n');
}

module.exports = { lines };
