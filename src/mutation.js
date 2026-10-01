'use strict';

/**
 * THE MUTATION TRANSACTION — one lifecycle for every LAIN-controlled source write.
 *
 * ------------------------------------------------------------------------
 * WHAT IT REPLACES. Audited before this was written, the lifecycle of a write
 * was spread over three places that did not know about each other:
 *
 *     turn.js         captured a checkpoint — only when the input had `path`, so
 *                     `move_file`, `rename_symbol` and `migration_activate`
 *                     wrote with no way back
 *     tools/index.js  ran the parse and lint checks, appended notes, decided nothing
 *     tools/edit.js   the per-file stale checks (staleness, foreignWrite, noInspection)
 *
 * There was no baseline, no verdict, no revert and no receipt, and no place a
 * work order could be checked. The edit tools themselves are good and are not
 * rewritten; their stale checks stay where they are. What is new is the ONE
 * lifecycle around them:
 *
 *     CHANGE REQUEST → AUTHORITY / WORK ORDER → BASELINE → STALE → CHECKPOINT
 *       → APPLY → STRUCTURAL VERIFY (parse · lint · scope) → PROJECT REFRESH
 *       → VERIFY CONTRACT → KEEP | REVERT → RECEIPT
 *
 * Every source mutator reaches it through `tools/index.js:execute`, and a
 * worker proposal reaches it through proposal.js. Shell commands are NOT source
 * mutations in this sense — nothing can know their targets in advance — and are
 * covered by the dirty tracker (freshness.js) instead.
 *
 * ------------------------------------------------------------------------
 * KEEP IS THE MAIN EXECUTOR'S DEFAULT, AND THAT IS DELIBERATE. A multi-step
 * refactor passes through states that do not parse; reverting each one would
 * make the refactor impossible. The structural result is still recorded and
 * still told to the model, exactly as before. REVERT is the verdict when the
 * authority says the change may not stand: a bounded worker whose write broke
 * the file, left its scope, or failed the verification it was committed under;
 * or any caller that supplied a verification which failed.
 *
 * REVERT NEVER DESTROYS A CONCURRENT CHANGE. A file still holding exactly what
 * the transaction wrote is restored whole. A file somebody changed since has
 * only the transaction's own hunk reversed, located by its context; when that
 * cannot be done unambiguously the file is left alone and the verdict says
 * REVERT_CONFLICT rather than guessing.
 */

const fs = require('fs');
const path = require('path');

const guard = require('./workorderguard');

const VERDICT = Object.freeze({
  KEEP: 'KEEP',
  REVERT: 'REVERT',
  REVERT_CONFLICT: 'REVERT_CONFLICT',
  DENIED: 'DENIED',
  STALE: 'STALE',
  NOT_APPLIED: 'NOT_APPLIED',
});

const MAX_RECEIPTS = 60;

/**
 * WHO MADE THE CHANGE. One transaction lifecycle for every actor; the actor
 * decides attribution, never the path the bytes took.
 *
 *   USER    the person — an editor save, a create / rename / delete / replace
 *           in the IDE, a rename the person asked the language server for
 *   MODEL   a model's tool call (the Coding Agent, a worker)
 *   CORE    Core itself, on the person's request, with no model (the
 *           deterministic geometry and selection jobs)
 *   TOOL    an attached tool acting for the person: an extension's edit, a
 *           git operation that rewrote the working tree
 *
 * `ctx.origin` refines provenance where the ledger has a sharper word:
 * 'FORMATTER', 'extension:<id>', 'language-server', 'git'.
 */
const ACTOR = Object.freeze({ USER: 'USER', MODEL: 'MODEL', CORE: 'CORE', TOOL: 'TOOL' });

function provenanceSource(actor, origin) {
  const o = String(origin || '');
  if (o === 'FORMATTER') return 'FORMATTER';
  if (o.startsWith('extension:')) return 'EXTENSION';
  if (actor === ACTOR.USER) return 'USER';
  if (actor === ACTOR.CORE) return 'CORE';
  if (actor === ACTOR.TOOL) return 'TOOL';
  return 'AGENT';
}

const PATH_TOOLS = new Set([
  'write_file', 'edit_file', 'apply_patch', 'append_file', 'insert_at', 'delete_range', 'delete_file',
  'replace_symbol', 'insert_near_symbol', 'remove_symbol',
]);

function abs(cwd, p) {
  return path.isAbsolute(String(p)) ? String(p) : path.resolve(String(cwd || process.cwd()), String(p));
}

function isSourceMutation(name) {
  return PATH_TOOLS.has(name) || name === 'move_file' || name === 'rename_symbol' || name === 'migration_activate';
}

/**
 * WHAT A CALL WILL TOUCH, known BEFORE it runs.
 *
 * @returns {Promise<{paths:string[], delegated:boolean}|null>} null when the
 *   call is not a source mutation at all (a rename dry run, for instance).
 *   `delegated` marks a tool that owns its own checkpoint and rollback
 *   (`migration_activate`), whose targets are only known from its result.
 */
async function targetsOf(name, input, ctx) {
  const inp = input && typeof input === 'object' ? input : {};
  const cwd = (ctx && ctx.cwd) || process.cwd();
  if (PATH_TOOLS.has(name)) return inp.path ? { paths: [abs(cwd, inp.path)], delegated: false } : null;
  if (name === 'move_file') return inp.from && inp.to ? { paths: [abs(cwd, inp.from), abs(cwd, inp.to)], delegated: false } : null;
  if (name === 'rename_symbol') {
    if (inp.dry_run || !inp.from || !inp.to) return null;
    try {
      const r = await require('./rename').rename(cwd, String(inp.from), String(inp.to), {
        include: inp.include ? String(inp.include) : '', members: Boolean(inp.include_members), dryRun: true,
      });
      return { paths: r.changed.map((c) => c.abs), delegated: false };
    } catch { return { paths: [], delegated: true }; }
  }
  if (name === 'migration_activate') return { paths: [], delegated: true };
  return null;
}

/** The one snapshot primitive lives in checkpoint.js. */
const { snapshot } = require('./checkpoint');

/**
 * REVERSE ONLY THIS TRANSACTION'S HUNK in a file that has changed since.
 *
 * The change is `before → after` bounded by their common prefix and suffix. Its
 * `after` text, with as much surrounding context as still matches exactly once
 * in the current file, is replaced by the corresponding `before` text. Returns
 * the new text, or null when there is no unambiguous place to do it.
 */
function reverseHunk(before, after, now) {
  const B = String(before);
  const A = String(after);
  const N = String(now);
  let p = 0;
  while (p < B.length && p < A.length && B[p] === A[p]) p += 1;
  let s = 0;
  while (s < B.length - p && s < A.length - p && B[B.length - 1 - s] === A[A.length - 1 - s]) s += 1;
  for (const ctxLen of [400, 160, 60, 20, 0]) {
    const lead = Math.min(ctxLen, p);
    const tail = Math.min(ctxLen, s);
    const anchorA = A.slice(p - lead, A.length - s + tail);
    if (!anchorA) continue;
    const first = N.indexOf(anchorA);
    if (first < 0 || N.indexOf(anchorA, first + 1) >= 0) continue;
    const anchorB = B.slice(p - lead, B.length - s + tail);
    return N.slice(0, first) + anchorB + N.slice(first + anchorA.length);
  }
  return null;
}

/** Restore each target to its baseline, preserving anything changed since the apply. */
function revert(tx) {
  const rows = [];
  let conflict = false;
  for (const t of tx._targets) {
    const now = snapshot(t.abs);
    const rel = t.rel;
    try {
      if (now.fp === t.afterFp) {
        if (!t.before.existed) { fs.rmSync(t.abs, { force: true }); rows.push({ rel, action: 'removed' }); }
        else if (t.before.bytes) {
          fs.mkdirSync(path.dirname(t.abs), { recursive: true });
          fs.writeFileSync(t.abs, t.before.bytes);
          rows.push({ rel, action: 'restored' });
        } else { rows.push({ rel, action: 'conflict: too large to snapshot' }); conflict = true; }
        continue;
      }
      if (t.before.bytes && t.afterBytes && now.bytes) {
        const merged = reverseHunk(t.before.bytes.toString('utf8'), t.afterBytes.toString('utf8'), now.bytes.toString('utf8'));
        if (merged != null) {
          fs.writeFileSync(t.abs, merged);
          rows.push({ rel, action: 'reversed own hunk, concurrent change preserved' });
          continue;
        }
      }
      rows.push({ rel, action: 'conflict: changed since the apply and the hunk could not be isolated — left as is' });
      conflict = true;
    } catch (e) {
      rows.push({ rel, action: `conflict: ${e.message}` });
      conflict = true;
    }
  }
  return { rows, conflict };
}

/** Parse check per file. The diagnostics module is the authority; this only asks. */
async function structural(paths, cwd) {
  const out = { ok: true, files: [], note: '', lint: '' };
  const diagnostics = require('./diagnostics');
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    let r;
    try { r = await diagnostics.checkFile(p); } catch { r = { ok: true, inconclusive: true }; }
    const row = { rel: path.relative(cwd, p).replace(/\\/g, '/'), ok: r.ok !== false, inconclusive: Boolean(r.inconclusive) };
    if (r.ok === false) { row.line = r.line || null; row.message = r.message || 'does not parse'; out.ok = false; }
    out.files.push(row);
  }
  try { out.note = await diagnostics.reportFor(paths.filter((p) => fs.existsSync(p)), cwd); } catch { out.note = ''; }
  try { out.lint = await require('./filecheck').reportFor(paths.filter((p) => fs.existsSync(p)), cwd); } catch { out.lint = ''; }
  return out;
}

function receiptsOf(session) {
  if (!session) return null;
  if (!Array.isArray(session.mutationReceipts)) session.mutationReceipts = [];
  return session.mutationReceipts;
}

/** What the receipt keeps: never bytes. */
function summary(tx) {
  const { _targets, ...rest } = tx;
  return rest;
}

function refused(tx, verdict, output, ctx) {
  tx.verdict = verdict;
  tx.endedAt = Date.now();
  const list = receiptsOf(ctx && ctx.session);
  if (list) { list.push(summary(tx)); while (list.length > MAX_RECEIPTS) list.shift(); }
  return { output, isError: true, mutated: [], transaction: summary(tx), [verdict === VERDICT.STALE ? 'stale' : 'denied']: true };
}

/**
 * RUN ONE CHANGE THROUGH THE WHOLE LIFECYCLE.
 *
 * @param {object} o
 *   `name`, `input`  the change request
 *   `ctx`            the tool context: cwd, session, checkpoints, turnId,
 *                    workOrder, verify, revertOnStructural
 *   `apply`          async () => tool result — the mutation itself
 *   `targets`        explicit absolute paths, for a caller that is not a tool
 *                    (a proposal commit); otherwise derived from the request
 *   `baselineExtra`  { rel: fingerprint } a proposal was computed against
 */
async function transact({ name, input = {}, ctx = {}, apply, targets = null, baselineExtra = null }) {
  const cwd = ctx.cwd || process.cwd();
  const session = ctx.session || null;
  const order = ctx.workOrder || null;
  const plan = session && session.plan;
  const openStep = plan && Array.isArray(plan.steps) ? plan.steps.findIndex((s) => s && !require('./plan').stepDone(s)) : -1;

  const t = targets ? { paths: targets, delegated: false } : await targetsOf(name, input, ctx);
  if (!t) return apply();

  const seq = session ? (session._txSeq = (session._txSeq || 0) + 1) : Date.now();
  const actor = ACTOR[ctx.actor] ? ctx.actor : ACTOR.MODEL;
  const tx = {
    actor,
    origin: ctx.origin ? String(ctx.origin).slice(0, 80) : null,
    id: `T${seq}`,
    tool: name,
    startedAt: Date.now(),
    taskId: (session && session.task && session.task.id) || '',
    planStep: openStep >= 0 ? openStep + 1 : null,
    // THE STEP'S IDENTITY (plan.js ids): a receipt still belongs to its step after the plan is revised and renumbered.
    planStepId: openStep >= 0 ? plan.steps[openStep].id || null : null,
    workOrderId: order ? order.id : '',
    bounded: guard.isBounded(order),
    targets: t.paths.map((p) => path.relative(cwd, p).replace(/\\/g, '/')),
    delegated: t.delegated,
    stages: [],
    baseline: {},
    after: {},
    structural: null,
    scope: null,
    verification: null,
    verdict: null,
    revert: null,
    _targets: [],
  };
  const stage = (n, detail = '') => tx.stages.push(detail ? `${n}: ${detail}` : n);

  // ---- AUTHORITY / WORK ORDER ---------------------------------------------
  const allowed = guard.writeAllowed(order, t.paths, { name, input, cwd });
  tx.scope = { ok: allowed.ok, denied: allowed.denied.map((d) => d.why), spans: allowed.spans.map((s) => `${s.rel}::${s.symbols.join('|')}`) };
  stage('AUTHORITY', allowed.ok ? 'allowed' : 'denied');
  if (!allowed.ok) {
    return refused(tx, VERDICT.DENIED, `DENIED ${allowed.denied.map((d) => d.why).join('; ')}. Nothing was written. `
      + 'Request a scope expansion if the assignment needs this.', ctx);
  }

  // ---- BASELINE -------------------------------------------------------------
  for (const p of t.paths) {
    const before = snapshot(p);
    const rel = path.relative(cwd, p).replace(/\\/g, '/');
    tx.baseline[rel] = before.fp;
    tx._targets.push({ abs: p, rel, before, afterFp: null, afterBytes: null });
  }
  stage('BASELINE', `${t.paths.length} target(s)`);

  // ---- STALE ------------------------------------------------------------------
  if (order) {
    const moved = guard.stale(order, cwd, { onlyRels: tx.targets, extra: baselineExtra || {} });
    if (moved.length) {
      stage('STALE', moved.map((m) => m.rel).join(', '));
      if (typeof order.stale === 'function') {
        order.stale(`baseline moved: ${moved.map((m) => `${m.rel} ${String(m.expected).slice(0, 8)}→${String(m.actual).slice(0, 8)}`).join(', ')}`);
      }
      tx.stale = moved;
      return refused(tx, VERDICT.STALE, `${guard.VERDICT.STALE_WORK_ORDER}: ${moved.map((m) => `${m.rel} was ${String(m.expected).slice(0, 8)} when the order was issued and is ${String(m.actual).slice(0, 8)} now`).join('; ')}. `
        + 'Nothing was overwritten — refresh the assignment against the current file.', ctx);
    }
  }
  stage('STALE', 'clear');

  // The project's first LAIN-controlled write is measured against a baseline.
  try { require('./freshness').ensureBaseline(cwd); } catch { /* intelligence is a convenience; the write is not */ }
  // A FILE THAT MOVED UNDER LAIN since its provenance was last recorded is an
  // EXTERNAL change, recorded before this one is attributed (editledger.js).
  for (const x of tx._targets) {
    if (!x.before || !x.before.bytes) continue;
    try {
      if (require('./editledger').observe(cwd, x.abs, x.before.bytes.toString('utf8'), { sessionId: session ? session.id : null })) {
        require('./harnesscontext').noteSourceEdit(ctx.app || null, session, { file: x.rel, by: 'external' });
      }
    } catch { /* provenance never costs a write */ }
  }

  // ---- CHECKPOINT -------------------------------------------------------------
  let checkpoint = null;
  // A PERSON'S OWN SAVE IS NOT A TURN: /undo reverts LAIN's work, never theirs.
  if (ctx.checkpoints && t.paths.length && actor !== ACTOR.USER) {
    try { checkpoint = ctx.checkpoints.capture(ctx.turnId || null, t.paths); } catch { checkpoint = null; }
  }
  stage('CHECKPOINT', checkpoint ? checkpoint.id : 'in-memory');

  // ---- APPLY --------------------------------------------------------------------
  let r;
  try { r = await apply(); } catch (e) { r = { output: `${name} failed: ${(e && e.message) || e}`, isError: true }; }
  r = r && typeof r === 'object' ? r : { output: String(r == null ? '' : r) };
  if (checkpoint) { try { ctx.checkpoints.settle(checkpoint); } catch { /* the edit stands */ } }
  const mutated = (r.mutated || []).slice();
  // A delegated tool names its targets only now.
  for (const p of mutated) {
    if (!tx._targets.some((x) => x.abs === p)) {
      const rel = path.relative(cwd, p).replace(/\\/g, '/');
      tx._targets.push({ abs: p, rel, before: { existed: null, bytes: null, fp: null }, afterFp: null, afterBytes: null });
      tx.targets.push(rel);
    }
  }
  for (const x of tx._targets) {
    const now = snapshot(x.abs);
    x.afterFp = now.fp;
    x.afterBytes = now.bytes;
    tx.after[x.rel] = now.fp;
  }
  const changed = tx._targets.filter((x) => x.before.fp !== x.afterFp);
  stage('APPLY', r.isError ? `error; ${changed.length} file(s) changed` : `${changed.length} file(s) changed`);
  if (changed.length) require('./writeclock').mark();   // a page loaded before this is stale (browserharness.js)
  // TEST INTEGRITY (discipline/integrity.js): what this write did to the measurements, read from the real bytes.
  const owner = session || (ctx.app && ctx.app.session) || null;
  const discipline = owner && owner.lifecycle && owner.lifecycle.discipline;
  if (discipline && actor !== ACTOR.USER) {
    for (const x of changed) {
      const text = (b) => (b ? b.toString('utf8') : null);
      try { discipline.noteWrite(x.rel, x.before.existed ? text(x.before.bytes) : null, x.afterFp ? text(x.afterBytes) : null); } catch { /* bookkeeping never costs a write */ }
    }
  }
  if (!changed.length) {
    tx.verdict = VERDICT.NOT_APPLIED;
    tx.endedAt = Date.now();
    const list = receiptsOf(session);
    if (list) { list.push(summary(tx)); while (list.length > MAX_RECEIPTS) list.shift(); }
    return { ...r, transaction: summary(tx), checkpoint };
  }

  // ---- STRUCTURAL VERIFY ------------------------------------------------------
  const st = await structural(changed.map((x) => x.abs), cwd);
  let scopeViolation = '';
  for (const s of allowed.spans) {
    const x = tx._targets.find((y) => y.abs === s.abs);
    if (!x || !x.before.bytes || !x.afterBytes) continue;
    const v = guard.spanAllowed(x.before.bytes.toString('utf8'), x.afterBytes.toString('utf8'), s.abs, s.symbols);
    if (!v.ok) scopeViolation = `${guard.VERDICT.OUTSIDE_WORK_ORDER}: ${s.rel} ${v.why}`;
  }
  // A write the call did not declare is outside what was asked, for a bounded worker.
  if (guard.isBounded(order)) {
    for (const x of changed) {
      if (!guard.writeAllowed(order, [x.abs], { name, input, cwd }).ok) scopeViolation = `${guard.VERDICT.OUTSIDE_WORK_ORDER}: ${x.rel} was changed but is not in the order's write scope`;
    }
  }
  tx.structural = { parse: st.ok, files: st.files, lint: Boolean(st.lint) };
  if (scopeViolation) tx.scope.violation = scopeViolation;
  stage('STRUCTURAL', `${st.ok ? 'parses' : 'DOES NOT PARSE'}${scopeViolation ? '; scope violated' : ''}`);

  // ---- PROJECT REFRESH --------------------------------------------------------
  try { require('./freshness').markChanged(cwd, changed.map((x) => x.abs)); } catch { /* lazy refresh will find it */ }
  if (session && session.evidence) {
    for (const x of changed) {
      try { session.evidence.invalidate(x.abs); require('./readreceipts').invalidate(session.evidence, x.abs); } catch { /* already gone */ }
    }
  }
  stage('REFRESH', `${changed.length} file(s) marked changed`);

  // ---- VERIFY CONTRACT ----------------------------------------------------------
  const contract = require('./verifycontract');
  let verification = { level: contract.selectFor(cwd, changed.map((x) => x.rel)).level, state: 'NOT_RUN' };
  if (typeof ctx.verify === 'function') {
    try {
      const v = await ctx.verify({ mutated: changed.map((x) => x.abs), transaction: summary(tx) });
      verification = { ...verification, ...(v || {}), state: v && v.ok === false ? 'FAILED' : (v && v.ok ? 'PASSED' : 'NOT_RUN') };
    } catch (e) {
      verification = { ...verification, ok: false, state: 'FAILED', why: String((e && e.message) || e) };
    }
  }
  tx.verification = verification;
  stage('VERIFY', `${verification.level} ${verification.state}`);

  // ---- KEEP / REVERT ------------------------------------------------------------
  const bounded = guard.isBounded(order);
  const why = [];
  if (scopeViolation) why.push(scopeViolation);
  if (bounded && !st.ok) why.push('the change does not parse');
  if (ctx.revertOnStructural && !st.ok) why.push('the change does not parse');
  if (verification.state === 'FAILED') why.push(`verification failed${verification.why ? `: ${verification.why}` : ''}`);
  let output = String(r.output || '');
  if (why.length) {
    const back = revert(tx);
    tx.revert = { why, rows: back.rows };
    tx.verdict = back.conflict ? VERDICT.REVERT_CONFLICT : VERDICT.REVERT;
    stage('SETTLE', tx.verdict);
    output += `\n\n${tx.verdict}: ${why.join('; ')}. ${back.rows.map((x) => `${x.rel} ${x.action}`).join('; ')}.`;
    for (const x of tx._targets) tx.after[x.rel] = snapshot(x.abs).fp;
    try { require('./freshness').markChanged(cwd, tx._targets.map((x) => x.abs)); } catch { /* lazy */ }
  } else {
    tx.verdict = VERDICT.KEEP;
    stage('SETTLE', VERDICT.KEEP);
    consequences(ctx, tx, changed, { cwd, session, name, order, input });
    if (st.note) output += st.note;
    if (st.lint) output += st.lint;
  }
  tx.endedAt = Date.now();

  // ---- RECEIPT ------------------------------------------------------------------
  const list = receiptsOf(session);
  if (list) { list.push(summary(tx)); while (list.length > MAX_RECEIPTS) list.shift(); }

  const reverted = tx.verdict !== VERDICT.KEEP;
  return {
    ...r,
    output,
    isError: Boolean(r.isError) || reverted,
    mutated: reverted ? tx._targets.map((x) => x.abs) : mutated,
    ...(st.ok ? {} : { syntaxError: !reverted }),
    ...(st.lint && !reverted ? { diagnostics: true } : {}),
    transaction: summary(tx),
    checkpoint,
  };
}

/**
 * WHAT EVERY KEPT CHANGE MEANS FOR THE REST OF CORE — once, here, whoever made
 * it. Before this lived in five places (the editor save route, turnclose, the
 * geometry and selection jobs, and each writer's own ledger call), and a path
 * that forgot one left the project generation, the GUG or the provenance
 * ledger describing a project that no longer existed.
 *
 *   provenance       editledger.record — who wrote which lines
 *   generation       harnesscontext.noteSourceEdit — the ONE project
 *                    generation, the GUG nodes the file sizes marked stale,
 *                    the recent-actions ledger, the journey
 *   PROJECT_DELTA    one event per transaction with the files and the actor
 *
 * (freshness, evidence invalidation and the receipt are done above, in the
 * lifecycle itself.)
 */
function consequences(ctx, tx, changed, { cwd, session, name, order, input }) {
  const source = provenanceSource(tx.actor, tx.origin);
  const by = { USER: 'user', MODEL: 'agent', CORE: 'core', TOOL: 'tool' }[tx.actor] || 'agent';
  const files = [];
  for (const x of changed) {
    files.push(x.rel);
    // Too large to hold in memory is too large to diff; that write is not described.
    if ((x.before.existed && !x.before.bytes) || (x.afterFp && !x.afterBytes)) continue;
    try {
      require('./editledger').record(cwd, {
        source, path: x.abs,
        before: x.before.bytes ? x.before.bytes.toString('utf8') : null,
        after: x.afterBytes ? x.afterBytes.toString('utf8') : null,
        sessionId: session ? session.id : null,
        taskId: tx.actor === ACTOR.MODEL && session && session.task ? session.task.id : null,
        actor: tx.origin || (guard.isBounded(order) ? 'worker' : (session && session._pluginGrant ? `plugin:${session._pluginGrant.id || ''}` : { USER: 'editor', MODEL: 'coding-agent', CORE: 'core', TOOL: 'tool' }[tx.actor])),
        tool: name,
      });
    } catch { /* provenance never costs a write */ }
  }
  let generation = null;
  for (const rel of files) {
    try {
      const r = require('./harnesscontext').noteSourceEdit(ctx.app || null, session, { file: rel, by, what: ctx.what || '' });
      if (r) generation = r.generation;
    } catch { /* the generation is Core's; a missing session only means no Harness context */ }
  }
  const app = ctx.app || null;
  if (app && app.events && typeof app.events.emit === 'function') {
    try { app.events.emit('project.delta', { actor: tx.actor, origin: tx.origin, files, generation, transaction: tx.id, tool: name }); } catch { /* observers never cost a write */ }
  }
  tx.generation = generation;
}

/**
 * A CHANGE THAT IS NOT A MODEL'S TOOL CALL — the person's save in the editor,
 * a create / rename / delete / replace in the IDE, a rename the person asked
 * the language server for, an extension's edit, a git operation that rewrote
 * the working tree. The SAME lifecycle as a tool write (baseline, checkpoint
 * when it is a model's, apply, structural check, freshness, evidence
 * invalidation, receipt, and `consequences`: provenance, the one project
 * generation, the GUG, PROJECT_DELTA) — only the actor differs.
 *
 * `targets` are absolute file paths known before the write; `write` performs
 * it and returns the caller's own result object (kept on the reply). A write
 * that turns out to touch other files names them in `mutated`.
 */
async function change(app, { actor = ACTOR.USER, origin = null, name, targets, write, what = '' }) {
  const session = app && app.session;
  const ctx = {
    app, session, cwd: (session && session.cwd) || process.cwd(), actor, origin, what,
    checkpoints: actor === ACTOR.MODEL && app ? app.checkpoints : null,
  };
  return transact({
    name, input: {}, ctx, targets: (targets || []).map((p) => path.resolve(String(p))),
    apply: async () => {
      const r = await write();
      const out = r && typeof r === 'object' ? r : {};
      return { output: out.output || (out.ok === false ? String(out.why || 'refused') : 'done'), ...out, isError: out.ok === false };
    },
  });
}

/** Every file under a folder (bounded) — what a folder rename or delete changes. */
function filesUnder(dir, max = 5000) {
  const out = [];
  const walk = (d) => {
    if (out.length >= max) return;
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(p);
      if (out.length >= max) return;
    }
  };
  walk(dir);
  return out;
}

module.exports = {
  change, filesUnder,
  ACTOR, provenanceSource, VERDICT, transact, targetsOf, isSourceMutation, snapshot, reverseHunk, revert, MAX_RECEIPTS,
};
