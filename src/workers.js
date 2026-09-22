'use strict';

/**
 * NARROW WORKERS — cheapest reliable owner first (2026-09-23).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS NOT. Not an agent framework, not a planner, not a second
 * orchestrator, not an authority. LAIN already owns orchestration (turn.js),
 * routing (mode.js / taskclass.js), context (promptparts.js / contextfit.js),
 * evidence (evidence.js / readreceipts.js) and permission (capability.js /
 * permissions). A worker performs ONE narrow job on a SMALL packet and
 * returns ONE structured result. It cannot grant, write, spawn, plan, mark
 * done, verify, retry a provider, change a profile or a mode, touch the goal,
 * call another worker or call itself — there is no code path here that could.
 *
 * ------------------------------------------------------------------------
 * THE CASCADE, for a bounded decision:
 *
 *     deterministic ──certain──▶ result
 *          │ uncertain
 *          ▼
 *     recruited model?  no ──▶ deterministic default (flagship decides later)
 *          │ yes
 *          ▼
 *     ONE inference ──label──▶ result
 *          │ ABSTAIN / junk / error
 *          ▼
 *     escalate: the deterministic default, marked escalated
 *
 * No second ask, no request for more context, no debate. A result is cached
 * by (decision type, state fingerprint, candidate hash) so the same question
 * about the same state is never asked twice.
 *
 * ------------------------------------------------------------------------
 * RECRUITMENT IS A GATE, NOT A PREFERENCE. A model binds to a contract only
 * when an evaluation of THAT role (bench/workergate) passed and the person
 * recorded it in cfg.workers (no model has passed yet, so nothing writes it —
 * see docs/WORKERS.md). Until then `binding` is null and the
 * deterministic owner answers alone. HIGH CONFIDENCE ≠ AUTHORITY ≠ VERIFIED ≠
 * DONE: a worker's output is never a user message, a steer, a plan step or a
 * project fact.
 */

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
  geometry_solver: Object.freeze({
    id: 'geometry_solver', worker: 'VIOLETTO', kind: 'geometry',
    question: 'What are the numeric consequences of this geometric change?',
    owns: ['dimensions', 'ratios', 'alignment', 'constraints', 'interpolation'],
    forbidden: ['UX semantics', 'colour', 'typography', 'accessibility policy', 'component existence', 'architecture', 'source ownership', 'user intent'],
    input: 'geometry_slice (GUG nodes + constraints)',
    output: 'geometry_patch',
    escalate_when: ['conflicting constraints', 'semantic change required', 'low confidence'],
    // NOT BUILT: no geometry model on this machine and no GUG to feed it — see docs/WORKERS.md.
  }),
});

/** A recorded recruitment with a passing gate, or null. */
function binding(cfg, contractId) {
  const b = cfg && cfg.workers && cfg.workers[contractId];
  return b && b.model && b.gate && b.gate.pass ? b : null;
}

// ---- cache ---------------------------------------------------------------

const CACHE_MAX = 200;
const cache = new Map();
function hash(x) { return crypto.createHash('sha1').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, 16); }
function cacheKey(type, fingerprint, candidates) { return `${type}|${fingerprint}|${hash(candidates || [])}`; }

// ---- ledger (worker value, §29/§97) ----------------------------------------

/**
 * One row per worker invocation, per session, in memory and on the session
 * (bounded): what went in, what came out, how long, and what it saved the
 * flagship. `rawChars` is the evidence that would have gone to the flagship;
 * `outChars` what went instead; `reread` is set when the flagship later had to
 * expand the raw source (false narrowing).
 */
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

/**
 * RUN ONE BOUNDED DECISION.
 *
 * @param {object} o
 *   contract       a CONTRACTS id
 *   fingerprint    what the state is (for the cache) — the caller's, never guessed here
 *   packet         { decision, facts, candidates }
 *   deterministic  () => { label, certain }   the cheapest owner, always asked first
 *   infer          async (text) => string      the recruited model's one inference, or null
 * @returns {Promise<{label, by, certain, escalated, cached}>}
 */
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
