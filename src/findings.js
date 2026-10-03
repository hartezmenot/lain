'use strict';

/** ONE VOCABULARY FOR EVERY ENGINEERING FINDING, whatever produced it. */

/** What KIND of problem this is. Never collapsed into "error". */
const CATEGORY = Object.freeze({
  SYNTAX: 'SYNTAX',
  TYPE: 'TYPE',
  SYMBOL: 'SYMBOL',
  REFERENCE: 'REFERENCE',
  IMPORT: 'IMPORT',
  EXPORT: 'EXPORT',
  TYPO: 'TYPO',
  MIGRATION_RESIDUE: 'MIGRATION_RESIDUE',
  CONTRACT: 'CONTRACT',
  RUNTIME: 'RUNTIME',
  TEST: 'TEST',
  BUILD: 'BUILD',
  LINT: 'LINT',
  DEPRECATION: 'DEPRECATION',
  DEAD_CODE: 'DEAD_CODE',
  CONFIGURATION: 'CONFIGURATION',
  PATH: 'PATH',
  PERMISSION: 'PERMISSION',
  GIT: 'GIT',
  ENVIRONMENT: 'ENVIRONMENT',
  UNVERIFIED: 'UNVERIFIED',
});

/** Engineering impact, not tool volume. */
const SEVERITY = Object.freeze({
  CRITICAL: 'CRITICAL',
  ERROR: 'ERROR',
  WARNING: 'WARNING',
  SUSPICIOUS: 'SUSPICIOUS',
  INFO: 'INFO',
  UNVERIFIED: 'UNVERIFIED',
});

/** Ordering for display: the things that stop the project working come first. */
const SEVERITY_ORDER = [
  SEVERITY.CRITICAL, SEVERITY.ERROR, SEVERITY.WARNING,
  SEVERITY.SUSPICIOUS, SEVERITY.UNVERIFIED, SEVERITY.INFO,
];

/** HOW THIS IS KNOWN — the axis that keeps the report honest. */
const CONFIDENCE = Object.freeze({
  PROVEN: 'PROVEN',
  OBSERVED: 'OBSERVED',
  INFERRED: 'INFERRED',
  SUSPECTED: 'SUSPECTED',
  /** NOT ESTABLISHED — the answer is not known, and no guess is offered. */
  UNVERIFIED: 'UNVERIFIED',
});

/** What actually saw it. Deterministic evidence must be distinguishable. */
const SOURCE = Object.freeze({
  PARSER: 'JavaScript/JSON/Python parser',
  TYPE_CHECKER: 'Type checker',
  TOKENIZER: 'Tokenizer',
  SYMBOL_GRAPH: 'Symbol graph',
  GIT_DIFF: 'Git diff',
  RESIDUE_SCANNER: 'Migration residue scanner',
  RUNTIME: 'Runtime',
  TEST_RUNNER: 'Test runner',
  // (BROWSER_CONSOLE and DOM_MEASUREMENT — sources that read a running page —
  // were removed with the browser in 2026-09; nothing can produce them now.)
  STATIC_ANALYSIS: 'Static analysis',
  FILESYSTEM: 'Filesystem',
  EXECUTION_ENGINE: 'Execution engine',
  LINTER: 'Linter',
});

/** WHERE A FINDING IS IN ITS LIFE. */
const STATE = Object.freeze({
  OPEN: 'OPEN',
  INVESTIGATING: 'INVESTIGATING',
  CONFIRMED: 'CONFIRMED',
  FIXED: 'FIXED',
  VERIFIED: 'VERIFIED',
  DISMISSED: 'DISMISSED',
  UNVERIFIED: 'UNVERIFIED',
});

/** THE LABEL AN ID CARRIES — `ERROR #014`, `RESIDUE #031`, `UI #004`. */
const LABEL_BY_CATEGORY = Object.freeze({
  [CATEGORY.MIGRATION_RESIDUE]: 'RESIDUE',
  [CATEGORY.TYPE]: 'TYPE',
  [CATEGORY.TYPO]: 'TYPO',
  [CATEGORY.SYMBOL]: 'SYMBOL',
  [CATEGORY.RUNTIME]: 'RUNTIME',
  [CATEGORY.TEST]: 'TEST',
  [CATEGORY.GIT]: 'GIT',
  [CATEGORY.DEAD_CODE]: 'DEAD',
  [CATEGORY.LINT]: 'LINT',
  [CATEGORY.ENVIRONMENT]: 'ENV',
  [CATEGORY.UNVERIFIED]: 'UNVERIFIED',
});

function labelFor(finding) {
  const byCat = LABEL_BY_CATEGORY[finding.category];
  if (byCat) return byCat;
  if (finding.severity === SEVERITY.WARNING) return 'WARNING';
  if (finding.severity === SEVERITY.SUSPICIOUS) return 'SUSPICIOUS';
  if (finding.severity === SEVERITY.INFO) return 'INFO';
  if (finding.severity === SEVERITY.UNVERIFIED) return 'UNVERIFIED';
  return 'ERROR';
}

/** THE FINGERPRINT AN ID IS KEYED ON. */
function fingerprint(f) {
  const shape = String(f.message || '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return [f.category || '', f.file || '', f.symbol || '', shape].join('|');
}

/** Build one finding, filling in everything the renderer is allowed to assume. */
function make(f = {}) {
  const out = {
    category: f.category || CATEGORY.UNVERIFIED,
    severity: f.severity || SEVERITY.INFO,
    confidence: f.confidence || CONFIDENCE.OBSERVED,
    source: f.source || SOURCE.STATIC_ANALYSIS,
    state: f.state || STATE.OPEN,
    file: f.file || null,
    line: Number.isFinite(f.line) ? f.line : null,
    column: Number.isFinite(f.column) ? f.column : null,
    symbol: f.symbol || null,
    container: f.container || null,
    message: String(f.message || '').trim(),
    explanation: f.explanation ? String(f.explanation).trim() : null,
    risk: f.risk ? String(f.risk).trim() : null,
    actual: f.actual == null ? null : String(f.actual),
    expected: f.expected == null ? null : String(f.expected),
    evidence: f.evidence ? String(f.evidence).trim() : null,
    related: {
      files: [...new Set(((f.related && f.related.files) || []).filter(Boolean))],
      symbols: [...new Set(((f.related && f.related.symbols) || []).filter(Boolean))],
      tests: [...new Set(((f.related && f.related.tests) || []).filter(Boolean))],
    },
    references: Number.isFinite(f.references) ? f.references : null,
  };
  out.key = fingerprint(out);
  out.label = labelFor(out);
  return out;
}

/** THE LEDGER — findings across repeated runs, with ids that survive. */
class FindingLedger {
  constructor() {
    /** @type {Map<string, {id, seq, label}>} fingerprint → assigned identity */
    this.identity = new Map();
    /** Per label, the last number handed out. */
    this.counters = new Map();
    /** The most recent completed run. */
    this.last = null;
    this.runs = 0;
  }

  /** Assign — or recall — the stable id for one finding. */
  idFor(finding) {
    const existing = this.identity.get(finding.key);
    if (existing) return existing.id;
    const label = finding.label;
    const next = (this.counters.get(label) || 0) + 1;
    this.counters.set(label, next);
    const id = `${label} #${String(next).padStart(3, '0')}`;
    this.identity.set(finding.key, { id, seq: next, label });
    return id;
  }

  /** Record one run, and work out what changed since the previous one. */
  record(findings, ranSources = new Set()) {
    const stamped = findings.map((f) => ({ ...f, id: this.idFor(f) }));
    const nowKeys = new Set(stamped.map((f) => f.key));
    const before = this.last ? this.last.findings : [];
    const beforeKeys = new Set(before.map((f) => f.key));

    const fixed = [];
    const unobserved = [];
    for (const f of before) {
      if (nowKeys.has(f.key)) continue;
      // GONE, BUT WAS ANYONE LOOKING?
      if (ranSources.has(f.source)) fixed.push({ ...f, state: STATE.FIXED });
      else unobserved.push({ ...f, state: STATE.UNVERIFIED });
    }
    const appeared = stamped.filter((f) => this.runs > 0 && !beforeKeys.has(f.key));

    this.runs += 1;
    this.last = { findings: stamped, at: Date.now(), ranSources: [...ranSources] };
    return { findings: stamped, fixed, unobserved, appeared };
  }
}

/** The ledger for a session, created on first use. */
function forSession(session) {
  if (!session) return new FindingLedger();
  if (!session.findings) session.findings = new FindingLedger();
  return session.findings;
}

/** Sort for display: worst first, then by file so one file reads together. */
function bySeverityThenFile(a, b) {
  const d = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  if (d !== 0) return d;
  const f = String(a.file || '').localeCompare(String(b.file || ''));
  if (f !== 0) return f;
  return (a.line || 0) - (b.line || 0);
}

module.exports = {
  CATEGORY, SEVERITY, SEVERITY_ORDER, CONFIDENCE, SOURCE, STATE,
  FindingLedger, forSession, make, fingerprint, labelFor, bySeverityThenFile,
};
