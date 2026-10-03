'use strict';

/** NARROW WORKERS — cheapest reliable owner first (2026-09-23). */

const crypto = require('crypto');

const CONTRACTS = Object.freeze({
  decision_intent: Object.freeze({
    id: 'decision_intent', worker: 'JEV', kind: 'decision',
    question: 'What kind of bounded request is this?',
    owns: ['intent classification', 'task-class tie-breaking'],
    forbidden: ['orchestration', 'permissions', 'plans', 'completion', 'profile/mode changes', 'calling another worker'],
    input: 'decision_packet { decision, facts[], candidates[] }  (≤ 600 chars)',
    output: 'decision_result { label | ABSTAIN }',
    labels: ['CHAT', 'EXPLAIN', 'AUDIT', 'FIX', 'CHANGE'],
    escalate_when: ['abstain', 'label outside the candidates', 'model error'],
    deterministic: 'mode.js',
  }),
  // HOW MUCH MACHINERY A CODE CHANGE GETS (changeclass.js). Escalation only: Core's deterministic class and its safety floor win.
  change_class: Object.freeze({
    id: 'change_class', worker: 'JEV', kind: 'decision',
    question: 'Is this code change DIRECT, NARROW, AGENT or PHASED?',
    owns: ['execution-class tie-breaking', 'escalation signal'],
    forbidden: ['lowering the deterministic class', 'crossing the safety floor', 'orchestration', 'permissions', 'plans', 'completion', 'calling another worker'],
    input: 'decision_packet { decision, facts[], candidates[] }  (≤ 600 chars)',
    output: 'decision_result { label | ABSTAIN }',
    labels: ['DIRECT', 'NARROW', 'AGENT', 'PHASED'],
    escalate_when: ['abstain', 'label outside the candidates', 'model error'],
    deterministic: 'changeclass.js',
  }),
  evidence_narrower: Object.freeze({
    id: 'evidence_narrower', worker: 'LAYA', kind: 'evidence',
    question: 'Where exactly is the relevant thing?',
    owns: ['relevance filtering', 'evidence correlation', 'screen-region selection', 'candidate ranking', 'scope reduction'],
    forbidden: ['final diagnosis', 'architecture', 'source changes', 'destructive actions', 'permissions', 'calling another worker'],
    input: 'ui_tree | observations + focus',
    output: 'evidence_slice (with receipts back to the raw source)',
    escalate_when: ['no node matches the focus', 'matches split across windows'],
    // THE DETERMINISTIC TIER IS IMPLEMENTED (evidenceslice.js); a model tier
    // would only re-rank when the deterministic score abstains.
    deterministic: 'evidenceslice.js',
  }),
  // THE HARNESS CONTEXT ROLES (layacontext.js).
  context_correlator: Object.freeze({
    id: 'context_correlator', worker: 'LAYA', kind: 'context',
    question: 'What is the person looking at, touching or referring to, and what small context should Core have ready?',
    owns: ['referent correlation', 'cross-surface correlation', 'Harness context compression'],
    forbidden: ['project truth', 'AST', 'FGM', 'GUG', 'wiring', 'permissions', 'task completion', 'choosing the flagship', 'dispatching', 'calling another worker'],
    input: 'Core-supplied candidate referents (ids + short texts) and a query',
    output: 'hypothesis { refs[] } — validated by Core at the current generation before any use',
    escalate_when: ['no candidates', 'validation fails', 'the context moved on (late)'],
    deterministic: 'harnesscontext.referent',
  }),
});

/** A recorded recruitment with a passing gate, or null. */
function binding(cfg, contractId) {
  const b = cfg && cfg.workers && cfg.workers[contractId];
  // A WORKER IS NEVER THE CHATGPT CHAT SOURCE (modelroles.js: CHAT ONLY).
  if (b && b.model && require('./modelroles').isChatOnly({ modelId: b.model, source: b.source })) return null;
  return b && b.model && b.gate && b.gate.pass ? b : null;
}

// ---- cache ---------------------------------------------------------------

const CACHE_MAX = 200;
const cache = new Map();
function hash(x) { return crypto.createHash('sha1').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, 16); }
function cacheKey(type, fingerprint, candidates) { return `${type}|${fingerprint}|${hash(candidates || [])}`; }

// ---- ledger (worker value, §29/§97) ----------------------------------------

/** One row per worker invocation, per session, in memory and on the session (bounded): what went in, what came out, how long, and what it saved the… */
const LEDGER_MAX = 200;
function note(session, row) {
  if (!session) return row;
  const r = { at: Date.now(), cacheHit: false, abstain: false, escalated: false, reread: 0, ...row };
  const l = session.workerLedger = Array.isArray(session.workerLedger) ? session.workerLedger : [];
  l.push(r);
  if (l.length > LEDGER_MAX) l.splice(0, l.length - LEDGER_MAX);
  return r;
}

/** Totals for `/workers` and the token report. Chars/4 ≈ tokens, stated as such. */
function summary(session) {
  const l = (session && session.workerLedger) || [];
  const by = {};
  for (const r of l) {
    const k = r.contract || r.worker || 'unknown';
    const s = by[k] = by[k] || { calls: 0, rawChars: 0, inChars: 0, outChars: 0, ms: 0, abstain: 0, escalated: 0, cacheHits: 0, rereadChars: 0 };
    s.calls += 1; s.rawChars += r.rawChars || 0; s.inChars += r.inChars || 0; s.outChars += r.outChars || 0;
    s.ms += r.ms || 0; s.abstain += r.abstain ? 1 : 0; s.escalated += r.escalated ? 1 : 0; s.cacheHits += r.cacheHit ? 1 : 0;
    s.rereadChars += r.reread || 0;
    s.missed = (s.missed || 0) + (Array.isArray(r.missed) ? r.missed.length : 0); s.touched = (s.touched || 0) + (r.touched || 0);
  }
  for (const s of Object.values(by)) {
    // WHAT THE FLAGSHIP DID NOT HAVE TO READ, minus what false narrowing made it read anyway.
    s.avoidedTokens = Math.round(Math.max(0, s.rawChars - s.outChars - s.rereadChars) / 4);
    s.compression = s.outChars ? +(s.rawChars / s.outChars).toFixed(1) : null;
  }
  return by;
}

// ---- the decision cascade ---------------------------------------------------

/** The whole of what a decision worker sees. Bounded — never context, never files. */
function packet({ decision, facts = [], candidates = [] }) {
  const lines = [`DECISION: ${decision}`, 'FACTS:', ...facts.map((f) => `- ${String(f).slice(0, 200)}`), `CANDIDATES: ${candidates.join(' | ')}`,
    'Answer with exactly one candidate, or ABSTAIN if the facts do not decide it.'];
  return lines.join('\n').slice(0, 900);
}

/** One label out of a model reply, or null. A reply that is not exactly a candidate is not an answer. */
function parseLabel(text, candidates) {
  const t = String(text || '').trim().replace(/^["'`*\s]+|["'`*.\s]+$/g, '').toUpperCase();
  if (t === 'ABSTAIN') return 'ABSTAIN';
  return candidates.find((c) => c.toUpperCase() === t) || null;
}

/** RUN ONE BOUNDED DECISION. */
async function decide({ contract, fingerprint = '', packet: pk, deterministic, infer = null, session = null }) {
  const key = cacheKey(contract, fingerprint, pk.candidates);
  if (cache.has(key)) {
    const hit = cache.get(key);
    note(session, { contract, worker: CONTRACTS[contract].worker, cacheHit: true, ms: 0, inChars: 0, outChars: 0 });
    return { ...hit, cached: true };
  }
  const det = deterministic();
  let out;
  if (det.certain || !infer) out = { label: det.label, by: 'deterministic', certain: Boolean(det.certain), escalated: false };
  else {
    const text = packet(pk);
    const t0 = Date.now();
    let reply = '';
    let failed = false;
    try { reply = await infer(text); } catch { failed = true; }
    const label = failed ? null : parseLabel(reply, pk.candidates);
    const abstain = label === 'ABSTAIN' || label == null;
    out = abstain
      ? { label: det.label, by: 'deterministic', certain: false, escalated: true }
      : { label, by: CONTRACTS[contract].worker, certain: false, escalated: false };
    note(session, { contract, worker: CONTRACTS[contract].worker, ms: Date.now() - t0, inChars: text.length, outChars: String(reply).length, abstain, escalated: abstain });
  }
  cache.set(key, out);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return { ...out, cached: false };
}

function _resetCache() { cache.clear(); }

module.exports = { CONTRACTS, binding, decide, packet, parseLabel, note, summary, cacheKey, _resetCache };
