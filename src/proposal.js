'use strict';

/**
 * PROPOSAL → LAIN COMMIT — the boundary a bounded worker's result crosses.
 *
 * ------------------------------------------------------------------------
 * THE RULE. A worker reasons, inspects and PROPOSES. LAIN checks, applies,
 * verifies and settles:
 *
 *     WORKER                         LAIN
 *       reason                         check the work order's state
 *       inspect                        check scope      (workorderguard.js)
 *       propose changes + claim  ──►   check baseline   (STALE_WORK_ORDER)
 *                                      apply            (mutation.js, one transaction)
 *                                      verify           (the order's verification)
 *                                      settle           KEEP → VERIFIED only with receipts
 *                                                        REVERT → REJECTED, still open
 *
 * Worker prose is a CLAIM (authority.WorkOrder.claim) and never completion. A
 * worker's own write is not settlement either: `stage` runs the worker's edit
 * tools against a COPY of its targets, so what reaches the project is the
 * resulting content, applied by LAIN, against the baseline the order recorded.
 *
 * ------------------------------------------------------------------------
 * NOT A SCHEDULER. Nothing here starts a worker, chooses a model or runs two
 * things at once. It is the seam a future parallel worker will commit through,
 * exercised today by tests and by nothing else.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require('./workorderguard');
const mutation = require('./mutation');

const VERDICT = Object.freeze({
  COMMITTED: 'COMMITTED',
  COMMITTED_UNVERIFIED: 'COMMITTED_UNVERIFIED',
  STALE_WORK_ORDER: 'STALE_WORK_ORDER',
  DENIED: 'DENIED',
  REJECTED: 'REJECTED',
  NOT_OPEN: 'NOT_OPEN',
  EMPTY: 'EMPTY',
});

const OPEN = new Set(['ISSUED', 'ACTIVE', 'CLAIMED', 'REJECTED']);

function norm(p) { return String(p || '').replace(/\\/g, '/'); }

/**
 * RUN A WORKER'S EDIT CALLS AGAINST A COPY, and return the proposal they make.
 *
 * @param {WorkOrder} order
 * @param {Array<{name, input}>} calls  source-mutation tool calls, as a worker issues them
 * @param {object} o  { cwd }
 * @returns {Promise<{ok, proposal?, denied?, errors?}>}
 */
async function stage(order, calls, { cwd = process.cwd() } = {}) {
  const tools = require('./tools').TOOLS;
  const root = path.resolve(String(cwd));
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-proposal-'));
  const base = {};
  const touched = new Set();
  const errors = [];
  const outputs = [];
  try {
    for (const call of calls || []) {
      const tool = tools[call.name];
      if (!tool || !mutation.isSourceMutation(call.name) || call.name === 'rename_symbol' || call.name === 'migration_activate') {
        errors.push(`${call.name}: not a stageable edit`);
        continue;
      }
      const t = await mutation.targetsOf(call.name, call.input, { cwd: root });
      if (!t) { errors.push(`${call.name}: no target`); continue; }
      const allowed = guard.writeAllowed(order, t.paths, { name: call.name, input: call.input, cwd: root });
      if (!allowed.ok) return { ok: false, denied: allowed.denied.map((d) => d.why) };
      const input = { ...call.input };
      for (const abs of t.paths) {
        const rel = norm(path.relative(root, abs));
        if (rel.startsWith('..')) return { ok: false, denied: [`${rel} is outside the project`] };
        if (!touched.has(rel)) {
          touched.add(rel);
          const f = require('./readreceipts').contentFingerprint(abs);
          base[rel] = f ? f.fp : null;
          const copy = path.join(stageDir, rel);
          fs.mkdirSync(path.dirname(copy), { recursive: true });
          if (f) fs.copyFileSync(abs, copy);
        }
      }
      for (const k of ['path', 'from', 'to']) {
        if (input[k] && path.isAbsolute(String(input[k]))) input[k] = path.relative(root, String(input[k]));
      }
      let r;
      try { r = await tool.run(input, { cwd: stageDir, session: null }); } catch (e) { r = { output: e.message, isError: true }; }
      outputs.push({ name: call.name, output: String((r && r.output) || '').slice(0, 400), isError: Boolean(r && r.isError) });
      if (r && r.isError) errors.push(`${call.name}: ${String(r.output).slice(0, 200)}`);
      for (const abs of (r && r.mutated) || []) touched.add(norm(path.relative(stageDir, abs)));
    }
    const changes = [];
    for (const rel of touched) {
      const copy = path.join(stageDir, rel);
      const content = fs.existsSync(copy) ? fs.readFileSync(copy) : null;
      if (!(rel in base)) {
        const f = require('./readreceipts').contentFingerprint(path.join(root, rel));
        base[rel] = f ? f.fp : null;
      }
      changes.push({ path: rel, content, baseFingerprint: base[rel] });
    }
    return { ok: errors.length === 0, proposal: { changes, outputs }, errors };
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

/**
 * COMMIT A PROPOSAL, OR REFUSE IT.
 *
 * @param {WorkOrder} order
 * @param {object} proposal  { changes: [{path, content: Buffer|string|null, baseFingerprint?}], claim?, observed? }
 * @param {object} o  { cwd, session, checkpoints, verify }
 *   `verify` async ({mutated}) => { ok, evidence?, why? } — the order's verification.
 *   Without one the commit is COMMITTED_UNVERIFIED and the order is not VERIFIED.
 */
async function commit(order, proposal, { cwd = process.cwd(), session = null, checkpoints = null, verify = null } = {}) {
  const root = path.resolve(String(cwd));
  if (!order || !OPEN.has(order.state)) return { verdict: VERDICT.NOT_OPEN, why: `work order is ${order ? order.state : 'missing'}` };
  const changes = (proposal && Array.isArray(proposal.changes)) ? proposal.changes : [];
  if (!changes.length) return { verdict: VERDICT.EMPTY, why: 'the proposal changes nothing' };
  if (proposal.claim) order.claim(proposal.claim, { observed: proposal.observed || [] });

  const targets = changes.map((c) => path.resolve(root, String(c.path)));
  const baselineExtra = {};
  for (const c of changes) if (c.baseFingerprint !== undefined) baselineExtra[norm(c.path)] = c.baseFingerprint;

  const bounded = order.bounded === true ? order : Object.assign(Object.create(Object.getPrototypeOf(order)), order, { bounded: true });
  const r = await mutation.transact({
    name: 'proposal_commit',
    input: { workOrder: order.id, files: changes.map((c) => c.path) },
    ctx: { cwd: root, session, checkpoints, workOrder: bounded, verify },
    targets,
    baselineExtra,
    apply: async () => {
      const mutated = [];
      for (let i = 0; i < changes.length; i++) {
        const abs = targets[i];
        const c = changes[i];
        if (c.content == null) { if (fs.existsSync(abs)) { fs.rmSync(abs, { force: true }); mutated.push(abs); } continue; }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, c.content);
        mutated.push(abs);
      }
      return { output: `applied ${mutated.length} change(s) from work order ${order.id}`, mutated };
    },
  });
  const tx = r.transaction || {};
  if (bounded !== order && bounded.state === 'STALE') order.stale(bounded.staleReason);

  if (tx.verdict === mutation.VERDICT.STALE) {
    return { verdict: VERDICT.STALE_WORK_ORDER, stale: tx.stale || [], transaction: tx, output: r.output };
  }
  if (tx.verdict === mutation.VERDICT.DENIED) {
    order.receipt('denied', tx.scope && tx.scope.denied ? tx.scope.denied.join('; ') : 'outside scope');
    return { verdict: VERDICT.DENIED, denied: (tx.scope && tx.scope.denied) || [], transaction: tx, output: r.output };
  }
  if (tx.verdict === mutation.VERDICT.REVERT || tx.verdict === mutation.VERDICT.REVERT_CONFLICT) {
    order.receipt('reverted', `${tx.id}: ${(tx.revert && tx.revert.why || []).join('; ')}`);
    order.state = 'REJECTED';
    return { verdict: VERDICT.REJECTED, transaction: tx, output: r.output };
  }
  order.receipt('committed', `${tx.id}: ${tx.targets.join(', ')}`);
  if (tx.verification && tx.verification.state === 'PASSED') {
    order.receipt('verified', `${tx.verification.level}${tx.verification.evidence ? ` ${tx.verification.evidence}` : ''}`);
    order.verified();
    return { verdict: VERDICT.COMMITTED, transaction: tx, output: r.output };
  }
  return { verdict: VERDICT.COMMITTED_UNVERIFIED, transaction: tx, output: r.output };
}

/**
 * SETTLE AN ORDER WHOSE WORKER WROTE THROUGH THE TOOL DOOR — a `/bg` job today.
 *
 * The worker's closing text is recorded as a CLAIM. What is RECEIPTED is only
 * what LAIN itself holds on the worker's session: the mutation transactions that
 * were KEPT (mutation.js) and the verification runs recorded against the
 * contract (verifycontract.js). The order is VERIFIED only when a passing run
 * was recorded AFTER the last kept write — a check before the change proves
 * nothing about it. A worker that says "done, tested" with no such run stays
 * CLAIMED.
 *
 * @returns {{state, kept, verified, reverted}}
 */
function settle(order, session, { claim = '' } = {}) {
  if (!order) return null;
  if (claim) order.claim(claim);
  const txs = (session && Array.isArray(session.mutationReceipts)) ? session.mutationReceipts : [];
  const kept = txs.filter((t) => t.verdict === mutation.VERDICT.KEEP);
  const reverted = txs.filter((t) => t.verdict === mutation.VERDICT.REVERT || t.verdict === mutation.VERDICT.REVERT_CONFLICT);
  for (const t of kept) order.receipt('committed', `${t.id}: ${t.targets.join(', ')}`);
  for (const t of reverted) order.receipt('reverted', `${t.id}: ${(t.revert && t.revert.why || []).join('; ')}`);
  const lastWrite = kept.reduce((n, t) => Math.max(n, Number(t.endedAt) || 0), 0);
  const runs = (session && session.verification && Array.isArray(session.verification.runs)) ? session.verification.runs : [];
  const proof = runs.filter((r) => r.ok && Date.parse(r.at) >= lastWrite);
  let verified = false;
  if (proof.length && (kept.length || lastWrite === 0)) {
    const best = proof[proof.length - 1];
    order.receipt('verified', `${best.level} ${best.evidence}: ${best.command}`);
    verified = order.verified();
  }
  return { state: order.state, kept: kept.length, reverted: reverted.length, verified };
}

module.exports = { VERDICT, stage, commit, settle };
