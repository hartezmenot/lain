'use strict';

/**
 * THE TASK CONTRACT — what was asked, what would show it is done, and what is known (Execution Discipline §17–§18,
 * §40–§41, §52). Stored by LAIN, revised by the model; never only in transient model prose.
 *
 *   outcome     the requested OBSERVABLE outcome ("after changing X and pressing Save, X survives a reload")
 *   asks        every explicit ask, tracked separately (A1, A2 …) — completion cannot quietly forget one
 *   criteria    acceptance criteria (C1 …): provisional, revisable, each tied to asks and to evidence
 *   facts       established facts with provenance and FRESHNESS: STRUCTURAL facts hold until their owner changes;
 *               EXECUTION facts ("the server is running") expire within minutes
 *   hypotheses, questions, blockers, scaffolding (temporary files the task must account for)
 */

const EXECUTION_TTL_MS = 3 * 60 * 1000;
const MAX = { asks: 24, criteria: 24, facts: 40, hypotheses: 12, questions: 12, blockers: 12, scaffolding: 24 };
const ASK_STATUS = Object.freeze(['OPEN', 'ADDRESSED', 'DEFERRED']);
const CRITERION_STATUS = Object.freeze(['PROVISIONAL', 'MET', 'UNMET', 'DROPPED']);

const clip = (s, n = 400) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * THE EXPLICIT ASKS IN A REQUEST. Only an enumeration the person wrote — a numbered or bulleted list of two or more
 * items, or "1)", "A1", "(a)" markers — becomes separate asks; anything else is ONE ask, the request itself. A
 * guessed split would make LAIN hold a task open for asks nobody made.
 */
function extractAsks(request) {
  const text = String(request || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const ITEM = /^(?:[-*•]\s+|\d{1,2}[.)]\s+|\(?[a-z]\)\s+|[A-Z]\d{1,2}[.):]?\s+)(.+)$/;
  const items = [];
  for (const l of lines) { const m = ITEM.exec(l); if (m && m[1].length > 2) items.push(m[1]); }
  const asks = items.length >= 2 ? items : (text.trim() ? [text] : []);
  return asks.slice(0, MAX.asks).map((t, i) => ({ id: `A${i + 1}`, text: clip(t, 300), status: 'OPEN', note: '', by: 'core' }));
}

class Contract {
  constructor(request = '') {
    this.request = clip(request, 4000);
    this.outcome = null;
    this.asks = extractAsks(request);
    this.criteria = [];
    this.facts = [];
    this.hypotheses = [];
    this.questions = [];
    this.blockers = [];
    this.scaffolding = [];
  }

  setOutcome(text, by = 'model') { this.outcome = { text: clip(text, 600), by, at: Date.now() }; return this.outcome; }

  ask(id, { status, note, text } = {}) {
    let a = this.asks.find((x) => x.id === id);
    if (!a && text) { if (this.asks.length >= MAX.asks) return null; a = { id: id || `A${this.asks.length + 1}`, text: clip(text, 300), status: 'OPEN', note: '', by: 'model' }; this.asks.push(a); }
    if (!a) return null;
    if (status && ASK_STATUS.includes(status)) a.status = status;
    if (note != null) a.note = clip(note, 300);
    return a;
  }

  criterion(id, { text, askIds, status, evidence } = {}) {
    let c = this.criteria.find((x) => x.id === id);
    if (!c) {
      if (!text || this.criteria.length >= MAX.criteria) return null;
      c = { id: id || `C${this.criteria.length + 1}`, text: clip(text, 400), askIds: [], status: 'PROVISIONAL', evidence: [] };
      this.criteria.push(c);
    }
    if (text) c.text = clip(text, 400);
    if (Array.isArray(askIds)) c.askIds = askIds.map(String).slice(0, 8);
    if (status && CRITERION_STATUS.includes(status)) c.status = status;
    if (evidence) { c.evidence.push({ ...evidence, at: Date.now() }); while (c.evidence.length > 6) c.evidence.shift(); }
    return c;
  }

  fact(text, { kind = 'STRUCTURAL', provenance = 'model', owner = null, gen = 0 } = {}) {
    const f = { id: `F${this.facts.length + 1}`, text: clip(text, 300), kind: kind === 'EXECUTION' ? 'EXECUTION' : 'STRUCTURAL', provenance: clip(provenance, 120), owner: owner ? String(owner) : null, gen, at: Date.now() };
    this.facts.push(f); while (this.facts.length > MAX.facts) this.facts.shift();
    return f;
  }

  /** Is this fact still usable? Execution facts age out; a structural fact goes stale when its owner changes. */
  fresh(f, { now = Date.now(), changed = [] } = {}) {
    if (f.kind === 'EXECUTION') return now - f.at < EXECUTION_TTL_MS;
    if (f.owner) return !changed.some((p) => String(p).replace(/\\/g, '/').endsWith(String(f.owner).replace(/\\/g, '/')));
    return true;
  }

  note(list, text) {
    const arr = this[list];
    if (!Array.isArray(arr)) return null;
    const row = { id: `${list[0].toUpperCase()}${arr.length + 1}`, text: clip(text, 300), status: 'OPEN', at: Date.now() };
    arr.push(row); while (arr.length > (MAX[list] || 12)) arr.shift();
    return row;
  }

  scaffold(p, status = 'ACTIVE') {
    const rel = String(p || '').replace(/\\/g, '/');
    if (!rel) return null;
    let s = this.scaffolding.find((x) => x.path === rel);
    if (!s) { s = { path: rel, status }; this.scaffolding.push(s); while (this.scaffolding.length > MAX.scaffolding) this.scaffolding.shift(); }
    s.status = status;
    return s;
  }

  openAsks() { return this.asks.filter((a) => a.status === 'OPEN'); }
  liveCriteria() { return this.criteria.filter((c) => c.status !== 'DROPPED'); }

  toJSON() {
    const { request, outcome, asks, criteria, facts, hypotheses, questions, blockers, scaffolding } = this;
    return { request, outcome, asks, criteria, facts, hypotheses, questions, blockers, scaffolding };
  }

  static from(d) {
    const c = new Contract('');
    if (!d || typeof d !== 'object') return c;
    c.request = d.request || '';
    for (const k of ['asks', 'criteria', 'facts', 'hypotheses', 'questions', 'blockers', 'scaffolding']) c[k] = Array.isArray(d[k]) ? d[k] : [];
    c.outcome = d.outcome || null;
    return c;
  }
}

module.exports = { Contract, extractAsks, EXECUTION_TTL_MS, ASK_STATUS, CRITERION_STATUS };
