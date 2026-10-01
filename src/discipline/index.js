'use strict';

/**
 * EXECUTION DISCIPLINE — Noema owns it; the model owns judgment (packaging-pass consolidation, §1).
 *
 *     REQUEST → requested observable outcome → BELIEF / EVIDENCE STATE (facts, provenance, freshness, unknowns,
 *     hypotheses, explicit asks, acceptance criteria, check states) → choose a useful observation or action →
 *     act / inspect → observe → classify → update belief → … → stop when the outcome is evidenced, blocked,
 *     disproven, or genuinely needs a decision.
 *
 * One `Discipline` per task, held by the task's Lifecycle (so it is task-scoped and survives save/resume with it).
 * Its parts:  contract.js (outcome, asks, criteria, facts) · checks.js (CheckState) · integrity.js (test edits) ·
 * claims.js (typed claims) · arbiter.js (completion) · retry.js (no blind retries) · profile.js (capability →
 * discretion) · dialect.js (tool vocabulary per model family) · constitution.js (the short standing policy and
 * .noema/NOEMA.md) · digest.js (what survives compaction and handover).
 */

const { Contract } = require('./contract');
const { CheckLedger } = require('./checks');

class Discipline {
  constructor(request = '') {
    this.contract = new Contract(request);
    this.checks = new CheckLedger();
    this.integrity = [];
    this.claims = [];
    this.verdict = null;
  }

  /** One tool call finished (lifecycle.observeTool). */
  observe({ name, input, output, ok, exitCode, gen, changed, denied }) {
    if (denied) return null;
    if (/^run_/.test(String(name))) {
      const command = String((input && input.command) || name);
      return this.checks.command({ command, ok, exitCode, output, gen, changed });
    }
    if (/^preview_/.test(String(name))) {
      return this.checks.observation({ tool: name, target: (input && (input.target || input.key || input.keys || null)) || null, actor: 'MODEL', ok: ok !== false, text: output, gen });
    }
    // `observe` ON A LIVE GOAL (element, page, screen, errors, requests…) is a runtime observation too — a DOM
    // measurement is exactly the evidence a "move it 6px" criterion needs (a real GLM run was refused for lack of it,
    // 2026-10-01). Its file/code/changes goals are reads, not observations of the running thing.
    if (name === 'observe' && input && !input.receipt && !/^(file|code|changes)$/i.test(String(input.goal || ''))) {
      return this.checks.observation({ tool: 'observe', target: { goal: input.goal || null, selector: input.selector || null, url: input.url || null }, actor: 'MODEL', ok: ok !== false, text: output, gen });
    }
    return null;
  }

  /** A transacted write changed a file (mutation.js): what did it do to the measurements? */
  noteWrite(relPath, before, after) {
    const flags = require('./integrity').analyze(relPath, before, after);
    for (const f of flags) {
      if (this.integrity.some((x) => x.kind === f.kind && x.file === f.file && x.status === 'UNDISCLOSED')) continue;
      this.integrity.push({ id: `I${this.integrity.length + 1}`, ...f, status: 'UNDISCLOSED', at: Date.now() });
    }
    // A NEW FILE NAMED LIKE A PROBE is scaffolding until it is removed or deliberately kept.
    if (before == null && /(^|\/)(tmp|temp|scratch|debug|probe)[-_.]|[-_.](tmp|debug|probe)\.[a-z]+$/i.test(String(relPath))) this.contract.scaffold(relPath, 'ACTIVE');
    if (after == null) { const s = this.contract.scaffolding.find((x) => x.path === String(relPath).replace(/\\/g, '/')); if (s) s.status = 'REMOVED'; }
    return flags;
  }

  disclose(ids, note = '') {
    const want = new Set((ids || []).map(String));
    const out = [];
    for (const f of this.integrity) if (want.has(f.id) || want.has('all')) { f.status = 'DISCLOSED'; f.note = String(note).slice(0, 300); out.push(f); }
    return out;
  }

  toJSON() { return { contract: this.contract.toJSON(), checks: this.checks.toJSON(), integrity: this.integrity, claims: this.claims, verdict: this.verdict }; }

  static from(d) {
    const x = new Discipline('');
    if (!d || typeof d !== 'object') return x;
    x.contract = Contract.from(d.contract);
    x.checks = CheckLedger.from(d.checks);
    x.integrity = Array.isArray(d.integrity) ? d.integrity : [];
    x.claims = Array.isArray(d.claims) ? d.claims : [];
    x.verdict = d.verdict || null;
    return x;
  }
}

module.exports = { Discipline };
