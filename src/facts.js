'use strict';

/** PROJECT FACTS — the conventions a model must not have to rediscover. */

const { CONFIDENCE } = require('./findings');

/** WHAT KIND OF CONVENTION THIS IS. */
const AREA = Object.freeze({
  EXECUTION: 'EXECUTION',
  SHELL: 'SHELL',
  PATH: 'PATH',
  CWD: 'CWD',
  CLI: 'CLI',
  MEMORY: 'MEMORY',
  SOURCE_LOCATION: 'SOURCE_LOCATION',
  DATA: 'DATA',
  CONFIGURATION: 'CONFIGURATION',
  ENVIRONMENT: 'ENVIRONMENT',
  ENCODING: 'ENCODING',
  TESTING: 'TESTING',
  BUILD: 'BUILD',
  PROTOCOL: 'PROTOCOL',
  TYPE: 'TYPE',
});

/** THE REPRESENTATIONS THAT GET CONFUSED, named so they cannot be. */
const REPR = Object.freeze({
  DECIMAL: 'decimal',
  HEXADECIMAL: 'hexadecimal',
  HEX_STRING: 'hexadecimal string (0x-prefixed)',
  BOOLEAN: 'boolean',
  STRING: 'string',
  INTEGER: 'integer',
  PATH: 'path',
  ZERO_BASED: '0-based',
  ONE_BASED: '1-based',
  INCLUSIVE: 'inclusive',
  EXCLUSIVE: 'exclusive',
  UTF8: 'UTF-8',
  /** The only honest answer when the repository does not settle it. */
  UNKNOWN: 'UNKNOWN',
});

/** HOW A FACT WAS ESTABLISHED. */
const VIA = Object.freeze({
  EXECUTED: 'executed against this build',
  SOURCE: 'source declaration',
  SCHEMA: 'declared schema',
  MANIFEST: 'project manifest',
  FILESYSTEM: 'filesystem',
  RUNTIME: 'live runtime',
  DOCUMENTATION: 'documentation',
});

/** Build one fact. */
function make(f = {}) {
  const unknown = f.value === REPR.UNKNOWN || f.value == null;
  const out = {
    area: f.area || AREA.ENVIRONMENT,
    name: String(f.name || '').trim(),
    value: unknown ? REPR.UNKNOWN : String(f.value),
    // UNKNOWN AND UNVERIFIED TRAVEL TOGETHER.
    confidence: unknown ? CONFIDENCE.UNVERIFIED : (f.confidence || CONFIDENCE.OBSERVED),
    examples: (f.examples || []).map(String).filter(Boolean),
    counterExample: f.counterExample ? String(f.counterExample) : null,
    scope: f.scope ? String(f.scope) : null,
    via: f.via || (unknown ? null : VIA.SOURCE),
    evidence: f.evidence ? String(f.evidence).trim() : null,
    at: f.at ? String(f.at) : null,
    notes: f.notes ? String(f.notes).trim() : null,
    /** Why nobody could establish it. Only meaningful when UNKNOWN. */
    why: unknown && f.why ? String(f.why).trim() : null,
  };
  out.key = `${out.area}|${out.name}`;
  return out;
}

/** A fact that could not be established. The shape exists so it is easy to do. */
function unknown({ area, name, why, scope = null }) {
  return make({ area, name, value: REPR.UNKNOWN, why, scope });
}

/** THE LEDGER — facts for a session, with stable ids. */
class FactLedger {
  constructor() {
    this.identity = new Map();
    this.seq = 0;
    this.last = null;
  }

  idFor(fact) {
    const seen = this.identity.get(fact.key);
    if (seen) return seen;
    this.seq += 1;
    const id = `CONTRACT #${String(this.seq).padStart(3, '0')}`;
    this.identity.set(fact.key, id);
    return id;
  }

  /** Record one sweep, and report any fact whose VALUE changed since the last. */
  record(facts) {
    const stamped = facts.map((f) => ({ ...f, id: this.idFor(f) }));
    const before = new Map((this.last || []).map((f) => [f.key, f]));
    const changed = [];
    for (const f of stamped) {
      const prev = before.get(f.key);
      if (prev && prev.value !== f.value) changed.push({ ...f, was: prev.value });
    }
    this.last = stamped;
    return { facts: stamped, changed };
  }
}

function forSession(session) {
  if (!session) return new FactLedger();
  if (!session.facts) session.facts = new FactLedger();
  return session.facts;
}

/** Group facts by area, preserving the order areas were first seen. */
function byArea(facts) {
  const out = new Map();
  for (const f of facts) {
    if (!out.has(f.area)) out.set(f.area, []);
    out.get(f.area).push(f);
  }
  return out;
}

/** One fact, rendered for the briefing. */
function line(f, { width = 28 } = {}) {
  // A name longer than the column gets ONE space rather than being welded to its value — `Target naming and authorization:UNKNOWN` is unreadable, and…
  const raw = `${f.name}:`;
  const label = raw.length >= width ? `${raw} ` : raw.padEnd(width);
  if (f.value === REPR.UNKNOWN) {
    return `  ${label}UNKNOWN — ${f.why || 'not established from this repository'}`;
  }
  const ex = f.examples.length ? `   e.g. ${f.examples.slice(0, 2).join(', ')}` : '';
  return `  ${label}${f.value}${ex}`;
}

module.exports = { AREA, REPR, VIA, make, unknown, FactLedger, forSession, byArea, line, CONFIDENCE };
