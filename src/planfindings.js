'use strict';

/** WHAT A PLAN STEP HAS ALREADY ESTABLISHED — kept, compactly, across everything. */

/** Lines per field. Enough to hold a step's real state, too few to narrate in. */
const MAX_ENTRIES = 12;
/** One finding. A sentence, not a paragraph. */
const MAX_CHARS = 200;

const FIELDS = Object.freeze(['settled', 'landed', 'remaining', 'evidence']);

function clean(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const line = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (!line) continue;
    if (out.includes(line)) continue;      // the same fact twice is one fact
    out.push(line);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/** An empty record. Shape is fixed so every reader can rely on it. */
function empty() {
  return { settled: [], landed: [], remaining: [], evidence: [] };
}

/** Whatever was persisted, made safe to read. */
function from(data) {
  const out = empty();
  if (!data || typeof data !== 'object') return out;
  for (const f of FIELDS) out[f] = clean(data[f]);
  return out;
}

/** ADD TO A STEP'S RECORD. */
function record(step, given = {}) {
  if (!step || typeof step !== 'object') return empty();
  const now = from(step.findings);
  for (const f of FIELDS) {
    if (given[f] === undefined) continue;
    now[f] = f === 'remaining' ? clean(given[f]) : clean([...now[f], ...(Array.isArray(given[f]) ? given[f] : [given[f]])]);
  }
  step.findings = now;
  return now;
}

/** Is there anything worth showing? An empty record is drawn as nothing. */
function any(rec) {
  const r = from(rec);
  return FIELDS.some((f) => r[f].length > 0);
}

/** WHAT CORE ALREADY KNOWS, WITHOUT THE MODEL SAYING IT. */
function derive(session, step) {
  if (!session || !step) return empty();
  const n = Number(step.n);
  const landed = [];
  const evidence = [];
  const receipts = Array.isArray(session.mutationReceipts) ? session.mutationReceipts : [];
  for (const r of receipts) {
    if (!r || r.verdict !== 'KEEP') continue;            // a reverted change did not land
    // AND IT BELONGS TO THIS STEP — by the step's id when the receipt has one (numbers move when a plan is revised).
    if (r.planStepId && step.id ? r.planStepId !== step.id : Number(r.planStep) !== n) continue;
    for (const t of (r.targets || [])) {
      if (t) landed.push(String(t));
    }
  }
  // WHAT WAS READ FOR THIS STEP, as pointers. The ledger already knows; a model
  // re-listing it is the re-derivation this whole record exists to avoid.
  try {
    const rows = require('./readreceipts').toJSON(session.evidence) || [];
    for (const row of rows.slice(-MAX_ENTRIES)) {
      const label = row && (row.rel || row.path || row.label);
      if (label) evidence.push(String(label));
    }
  } catch { /* a session with no ledger simply contributes nothing */ }

  return record(step, { landed, evidence });
}

/** THE RECORD, AS THE MODEL READS IT in the system prompt. */
function lines(step, { maxChars = 600 } = {}) {
  if (!step || !any(step.findings)) return '';
  const r = from(step.findings);
  const out = [`Step ${step.n} — already established (do not re-derive):`];
  const label = { settled: 'SETTLED', landed: 'LANDED', remaining: 'REMAINING', evidence: 'EVIDENCE' };
  for (const f of FIELDS) {
    if (!r[f].length) continue;
    out.push(`  ${label[f]}`);
    for (const line of r[f]) out.push(`    - ${line}`);
  }
  const text = out.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

module.exports = { record, derive, from, empty, any, lines, FIELDS, MAX_ENTRIES, MAX_CHARS };
