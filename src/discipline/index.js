'use strict';

/** EXECUTION DISCIPLINE — LAIN owns it; the model owns judgment (packaging-pass consolidation, §1). */

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
    if (/^preview(_|$)/.test(String(name))) {   // the one preview tool (S9): its action names the observation
      return this.checks.observation({ tool: name === 'preview' ? `preview_${(input && input.action) || 'read'}` : name, target: (input && (input.target || input.key || input.keys || null)) || null, actor: 'MODEL', ok: ok !== false, text: output, gen });
    }
    // `observe` ON A LIVE GOAL (element, page, screen, errors, requests…) is a runtime observation too — a DOM measurement is exactly the evidence a "move…
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
