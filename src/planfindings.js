'use strict';

/**
 * WHAT A PLAN STEP HAS ALREADY ESTABLISHED — kept, compactly, across everything.
 *
 * ------------------------------------------------------------------------
 * THE LOOP THIS EXISTS TO END, and it is a real one.
 *
 * A long step settles a handful of facts early — "tracked stall means cancel",
 * "the 409 is what stops a paused retry" — and then keeps working. Those facts
 * live in the CONVERSATION, so compaction elides them, a rate-limit resume
 * re-sends a shorter history, and a continuation after a context boundary
 * arrives without them. The model then rediscovers the same four facts by
 * reading the same four files, and the step makes no progress while looking
 * extremely busy. That is the Step-740 shape.
 *
 * So the findings are moved OUT of the conversation and onto the step, where
 * they are persisted with the plan and survive everything that shortens a
 * transcript:
 *
 *     compaction            the plan is not in `messages`
 *     rate-limit resume     same
 *     continuation          same
 *     /resume               Plan.from restores it with the session
 *
 * ------------------------------------------------------------------------
 * FOUR FIELDS, AND THE DIVISION IS THE POINT.
 *
 *   SETTLED    decisions that no longer need re-deriving. The expensive ones.
 *   LANDED     what is already on disk. Prevents rewriting a finished edit.
 *   REMAINING  what this step still owes. The reason it is not done.
 *   EVIDENCE   pointers — a file, a symbol, a command — never the content.
 *
 * ------------------------------------------------------------------------
 * COMPACT BY CONSTRUCTION, because the failure mode of a scratchpad is that it
 * becomes the transcript again. Every entry is one short line, the lists are
 * capped, and nothing here stores prose, a diff, or a file body. A finding that
 * does not fit on a line was not a finding.
 */

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

/**
 * ADD TO A STEP'S RECORD.
 *
 * MERGED, NOT REPLACED — except for `remaining`, which is a statement about
 * what is LEFT and is therefore the one field that must be allowed to shrink.
 * Merging it would make a step that finished its last obligation still claim to
 * owe it, which is the opposite of the point.
 *
 * @returns {object} the step's record after the update.
 */
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

/**
 * WHAT CORE ALREADY KNOWS, WITHOUT THE MODEL SAYING IT.
 *
 * ------------------------------------------------------------------------
 * THE LIMITATION THIS CLOSES.
 *
 * `plan_findings` was model-written, and a model that forgets to call it loses
 * the record — including the part nobody has to be told: WHAT ACTUALLY CHANGED
 * ON DISK. A turn that patched three files and then hit a context boundary
 * would come back with no memory of having patched them, which is the precise
 * shape of the loop the record exists to stop.
 *
 * So the halves Core can answer deterministically are DERIVED:
 *
 *   LANDED    from the mutation receipts (src/mutation.js) — a transaction that
 *             was KEPT, for this plan step. Not "the model said it wrote"; the
 *             transaction ledger that says it did.
 *   EVIDENCE  from the same receipts and from what has been read — pointers,
 *             never content.
 *
 * SETTLED AND REMAINING STAY THE MODEL'S. A decision and an obligation are
 * judgements; nothing in a receipt can say "tracked stall means cancel", and
 * inventing one would be a machine guessing at intent.
 *
 * MERGED, NEVER OVERWRITING. What the model recorded is kept — this adds what
 * it did not have to say, and `record`'s de-duplication makes a fact stated
 * twice one fact.
 *
 * @returns {object} the step's record after deriving into it.
 */
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

/**
 * THE RECORD, AS THE MODEL READS IT in the system prompt.
 *
 * Only for the step being worked on. Every other step's findings are history,
 * and history in a prompt is the cost this was built to avoid.
 */
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
