'use strict';

/** CHECK STATE — what LAIN has actually observed, as named, comparable checks (Execution Discipline §22–§25). */

const REALISM = Object.freeze(['CLAIMED', 'INFERRED', 'STATIC', 'FIXTURE', 'INTEGRATION', 'RUNTIME', 'USER_CONFIRMED']);
const DISCRIMINATION = Object.freeze(['NIL', 'LOW', 'MODERATE', 'HIGH']);
const MAX_CHECKS = 60;
const MAX_HISTORY = 6;

const TRANSIENT_RE = /\b(ETIMEDOUT|ECONNRESET|socket hang up|timed? ?out|429|503|502|rate.?limit|temporarily unavailable|try again)\b/i;
const ENV_RE = /\b(ENOENT|EADDRINUSE|ECONNREFUSED|EACCES|EPERM|ENOTFOUND|command not found|is not recognized as|not installed|cannot find module|no such file or directory)\b/i;
const INVOCATION_RE = /\b(unknown (?:option|flag|command|argument)|usage:|invalid (?:option|argument)|unrecognized|no test files? found|no tests? (?:found|ran|matched))\b/i;

function rankOf(list, v) { const i = list.indexOf(v); return i < 0 ? 0 : i; }
function keyOf(command) { return String(command || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 300); }
function stateOf(ok) { return ok === true ? 'PASS' : ok === false ? 'FAIL' : 'UNVERIFIED'; }

/** How close to ground truth a command's result is — verifycontract's evidence scale, mapped onto realism. */
function realismOfCommand(command) {
  const e = require('../verifycontract').evidenceForCommand(command);
  if (e === 'STATIC_VERIFIED') return 'STATIC';
  if (e === 'FIXTURE_VERIFIED') return 'FIXTURE';
  if (e === 'LOCAL_INTEGRATION_VERIFIED') return 'INTEGRATION';
  return 'RUNTIME';   // REAL_TTY / REAL_APP / LIVE
}

/** Why did it fail? The classification decides what the failure is allowed to mean. */
function classifyFailure(output, { baseline = 'UNKNOWN', exitCode = null } = {}) {
  const t = String(output || '').slice(-4000);
  if (TRANSIENT_RE.test(t)) return 'TRANSIENT';
  if (ENV_RE.test(t)) return 'ENVIRONMENT';
  if (INVOCATION_RE.test(t) || exitCode === 2 && /usage/i.test(t)) return 'INVOCATION';
  if (baseline === 'FAIL') return 'PREEXISTING';
  if (baseline === 'PASS') return 'TASK_CAUSED';
  return 'UNKNOWN';
}

class CheckLedger {
  constructor() { this.byId = new Map(); this.byKey = new Map(); this.seq = { K: 0, P: 0 }; }

  _new(prefix, key, fields) {
    this.seq[prefix] = (this.seq[prefix] || 0) + 1;
    const c = { id: `${prefix}${this.seq[prefix]}`, key, history: [], baseline: 'UNKNOWN', latest: null, criterionId: null, ...fields };
    this.byId.set(c.id, c); this.byKey.set(key, c.id);
    if (this.byId.size > MAX_CHECKS) { const first = this.byId.keys().next().value; const old = this.byId.get(first); this.byId.delete(first); if (old) this.byKey.delete(old.key); }
    return c;
  }

  /** A COMMAND RAN. `gen` is the task's mutation count at the time: generation 0 is "nothing changed yet", which is what makes a result a BASELINE. */
  command({ command, ok, exitCode = null, output = '', gen = 0, changed = [] }) {
    const key = `cmd:${keyOf(command)}`;
    const c = this.byKey.has(key) ? this.byId.get(this.byKey.get(key)) : this._new('K', key, { kind: 'COMMAND', command: String(command || '').slice(0, 200), realism: realismOfCommand(command) });
    const state = stateOf(ok);
    const first = !c.history.length;
    if (first && gen === 0 && state !== 'UNVERIFIED') c.baseline = state;
    const row = { state, gen, exitCode: exitCode == null ? null : Number(exitCode), at: Date.now() };
    // THE FIRST OBSERVATION IS THE BASELINE ITSELF: it can be environmental, transient or an invocation error, but it
    // is not "pre-existing" relative to anything — that label needs a later observation of the same check.
    if (state === 'FAIL') row.classification = classifyFailure(output, { baseline: first ? 'UNKNOWN' : c.baseline, exitCode });
    c.history.push(row); while (c.history.length > MAX_HISTORY) c.history.shift();
    c.latest = row;
    c.targeted = c.targeted || touches(command, changed);
    return c;
  }

  /** A STATIC CHECK OF A CHANGED FILE — the parse the edit path runs after every write (diagnostics.js). */
  parse({ rel, ok, message = '', gen = 0 }) {
    const c = this.command({ command: `parse ${rel}`, ok, output: message, gen, changed: [rel] });
    c.static = true; c.realism = 'STATIC'; c.targeted = true;
    // A FILE THIS TASK JUST WROTE THAT DOES NOT PARSE is this task's failure — never "pre-existing".
    if (!ok && c.latest) c.latest.classification = 'TASK_CAUSED';
    return c;
  }

  /** A PREVIEW (or other runtime) OBSERVATION: what the model did there and what came back. */
  observation({ tool, target = null, actor = 'MODEL', ok = true, text = '', gen = 0 }) {
    const c = this._new('P', `obs:${Date.now()}:${Math.random()}`, { kind: 'OBSERVATION', tool, target, actor, realism: 'RUNTIME', text: String(text || '').slice(0, 2000) });
    const row = { state: ok ? 'OBSERVED' : 'FAIL', gen, at: Date.now() };
    c.history.push(row); c.latest = row;
    return c;
  }

  get(id) { return this.byId.get(String(id)) || null; }
  all() { return [...this.byId.values()]; }
  commands() { return this.all().filter((c) => c.kind === 'COMMAND'); }

  /** Would this evidence differ if the claim were false? Judged against the CURRENT generation. */
  discrimination(c, gen, { staticCounts = false } = {}) {
    if (!c || !c.latest) return 'NIL';
    if (c.latest.gen !== gen) return 'NIL';                       // stale: a change landed after it
    if (c.kind === 'OBSERVATION') return c.latest.state === 'OBSERVED' ? 'MODERATE' : 'NIL';
    if (c.latest.state !== 'PASS') return 'NIL';
    // A STATIC CHECK (the post-write parse of a changed file) proves a DIRECT change — a label, a colour — and
    // nothing about behaviour: it counts only where the arbiter says static proof is the proportional proof.
    if (c.static) return staticCounts && c.targeted ? 'MODERATE' : 'NIL';
    if (c.baseline === 'FAIL') return 'HIGH';                      // failed before, passes after
    if (c.targeted) return 'MODERATE';                             // exercises what changed
    return 'LOW';                                                  // passed, but would also have passed before
  }

  /** The failures at the current generation that are CONTRADICTIONS until explained. */
  contradictions(gen) {
    return this.commands().filter((c) => c.latest && c.latest.state === 'FAIL' && c.latest.gen === gen && !explained(c));
  }

  /** The model's judgment about a check: { relevance: RELEVANT | UNRELATED, note }. */
  judge(id, { relevance, note = '' } = {}) {
    const c = this.get(id);
    if (!c) return null;
    if (relevance) c.relevance = String(relevance).toUpperCase() === 'UNRELATED' ? 'UNRELATED' : 'RELEVANT';
    if (note) c.note = String(note).slice(0, 300);
    return c;
  }

  toJSON() { return { checks: this.all(), seq: this.seq }; }
  static from(d) {
    const l = new CheckLedger();
    if (d && Array.isArray(d.checks)) for (const c of d.checks) { l.byId.set(c.id, c); l.byKey.set(c.key, c.id); }
    if (d && d.seq) l.seq = { ...l.seq, ...d.seq };
    return l;
  }
}

/** A failure that is not a contradiction: caused by the environment or a transient fault, or declared unrelated. */
function explained(c) {
  if (!c || !c.latest) return false;
  return ['ENVIRONMENT', 'TRANSIENT'].includes(c.latest.classification) || c.relevance === 'UNRELATED';
}

/** Does this command name something that changed (a file, or a test named for a changed module)? */
function touches(command, changed) {
  const cmd = String(command || '').toLowerCase();
  return (changed || []).some((p) => {
    const base = String(p).replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
    return base.length > 2 && cmd.includes(base);
  });
}

module.exports = { CheckLedger, REALISM, DISCRIMINATION, rankOf, realismOfCommand, classifyFailure, explained, keyOf, stateOf };
