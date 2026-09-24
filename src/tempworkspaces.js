'use strict';

/**
 * TEMPORARY WORKSPACES — WHO MAY DELETE ONE, AND WHEN (2026-09-23).
 *
 * ------------------------------------------------------------------------
 * THE OWNER. This module, and nothing else. A subagent's worktree, an A/B
 * candidate's worktree, a snapshot copy: each is REGISTERED here when it is
 * made, and each is removed only by `attempt()` after every condition below is
 * proven from recorded facts. Laya, Violetto, the flagship and the subagent
 * itself hold no path to deletion: no tool calls `attempt` with a directory,
 * no model input names one, and the directory removed is always the exact one
 * this registry recorded at creation — never one built from text.
 *
 * ------------------------------------------------------------------------
 * THE LIFECYCLE (durable, one JSON record per workspace under the LAIN home):
 *
 *   ACTIVE ─▶ CANDIDATE_READY ─▶ INTEGRATING ─▶ INTEGRATED ─▶ TARGETED_VERIFIED
 *        │           │                 │                            │
 *        │           │                 └▶ CONFLICTED / FAILED       ▼
 *        │           └▶ REJECTED (archived)                FINAL_SMOKE_PASSED
 *        ├▶ FAILED / BLOCKED (retained: the failure is the evidence)  │
 *        ├▶ NOTHING_PROPOSED ─────────────────────────┐              ▼
 *        └▶ ORPHANED (owner died; retained)            └─▶ CLEANUP_ELIGIBLE ─▶ DELETING ─▶ DELETED
 *
 * A SUCCESSFUL workspace is deleted only when ALL hold: the child is no longer
 * active; no process uses the directory; the candidate is resolved; accepted
 * changes were integrated with a receipt of the canonical hashes; a targeted
 * verification passed AFTER the integration; the final smoke passed after the
 * last canonical change (where the project has one); no conflict references
 * it; the candidate record is on disk. Then a compact RECEIPT is written, and
 * only then the directory goes. A REJECTED candidate is archived first, then
 * eligible. FAILED / BLOCKED / CONFLICTED / ORPHANED are RETAINED — kept for
 * inspection, removed later only by the person (`/workspaces clean <id>`) or
 * after the retention period, never at once.
 *
 * ------------------------------------------------------------------------
 * CRASH-SAFE BY ORDER: the state is written before each step (receipt, then
 * DELETING, then the removal, then DELETED). A restart finds DELETING or
 * CLEANUP_ELIGIBLE and finishes it once (`reconcile`). Integration is never
 * repeated: the candidate record says INTEGRATED and `integrate` refuses it.
 *
 * PATH SAFETY is a hard guard, not a convention (`guard`): the target must be
 * the registered directory, a direct child of the LAIN temp root, and must not
 * be, contain or sit inside the canonical project, this repository, the
 * Harness, the user's home, the model store or the LAIN home.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STATE = Object.freeze({
  ACTIVE: 'ACTIVE', CANDIDATE_READY: 'CANDIDATE_READY', INTEGRATING: 'INTEGRATING', INTEGRATED: 'INTEGRATED',
  TARGETED_VERIFIED: 'TARGETED_VERIFIED', FINAL_SMOKE_PASSED: 'FINAL_SMOKE_PASSED', NOTHING_PROPOSED: 'NOTHING_PROPOSED',
  CLEANUP_ELIGIBLE: 'CLEANUP_ELIGIBLE', DELETING: 'DELETING', DELETED: 'DELETED',
  REJECTED: 'REJECTED', FAILED: 'FAILED', BLOCKED: 'BLOCKED', CONFLICTED: 'CONFLICTED', ORPHANED: 'ORPHANED',
});
/** Kept for inspection; never removed automatically before the retention period. */
const RETAINED = new Set([STATE.FAILED, STATE.BLOCKED, STATE.CONFLICTED, STATE.ORPHANED]);
const RETENTION_DAYS = 7;
const LINKED = ['node_modules', '.venv', 'venv'];

function sha(x) { return crypto.createHash('sha1').update(x).digest('hex'); }
function real(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }
function now() { return new Date().toISOString(); }

/** Where every LAIN temporary workspace is created. LAIN_TEMP_ROOT overrides (tests). */
function tempRoot() {
  const r = process.env.LAIN_TEMP_ROOT || path.join(os.tmpdir(), 'lain-workspaces');
  try { fs.mkdirSync(r, { recursive: true }); } catch { /* the caller's mkdtemp reports it */ }
  return r;
}

function dir() { return path.join(require('./config').configDir(), 'workspaces'); }
function receiptsDir() { return path.join(dir(), 'receipts'); }
function file(id) { return path.join(dir(), `${id}.json`); }

function read(id) { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } }
function write(rec) {
  rec.updatedAt = now();
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${file(rec.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
  fs.renameSync(tmp, file(rec.id));
  return rec;
}
function all() {
  try { return fs.readdirSync(dir()).filter((f) => f.endsWith('.json')).map((f) => read(f.slice(0, -5))).filter(Boolean); } catch { return []; }
}
function note(rec, state, detail = '') {
  rec.state = state;
  rec.events = [...(rec.events || []), { at: now(), state, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }].slice(-40);
  return write(rec);
}

/**
 * REGISTER a workspace the moment it exists. `ws` is candidates.isolate's
 * result (or an A/B worktree); the directory recorded here is the ONLY one
 * `attempt` will ever remove for this record.
 */
function register(ws, { sessionId = null, holder = '', label = '', kind = null } = {}) {
  const id = `tw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const rec = {
    id, kind: kind || ws.kind, dir: real(ws.dir), root: real(ws.root), base: ws.base || null, label,
    sessionId, holder, pid: process.pid, createdAt: now(), state: STATE.ACTIVE, events: [],
    candidate: null, integration: null, targeted: null, smoke: null, lastMutationAt: null,
  };
  note(rec, STATE.ACTIVE, 'created');
  return rec;
}

// ---- facts that move a record ------------------------------------------------

/** The child finished and its changes were harvested (candidates.harvest). */
function candidateReady(id, cand, { failed = false, why = '' } = {}) {
  const rec = read(id);
  if (!rec) return null;
  const files = (cand && cand.files) || [];
  rec.candidate = cand ? {
    ...(rec.candidate && rec.candidate.patch ? { patch: rec.candidate.patch } : {}),
    id: cand.id, role: cand.role, files: files.map((f) => f.path), verdictOk: Boolean(cand.verdict && cand.verdict.ok),
    reasons: (cand.verdict && cand.verdict.reasons) || [],
    hash: sha(JSON.stringify(files.map((f) => [f.status, f.path, f.from || '', f.after == null ? null : sha(String(f.after))]))),
    stored: cand.stored != null ? Boolean(cand.stored) : Boolean(files.length),
  } : null;
  if (failed) return note(rec, STATE.FAILED, why || 'the child did not finish');
  if (cand && files.length && !(cand.verdict && cand.verdict.ok)) return note(rec, STATE.BLOCKED, `candidate refused: ${(cand.verdict.reasons || []).join('; ')}`);
  if (!files.length) return note(rec, STATE.NOTHING_PROPOSED, 'no change to integrate');
  return note(rec, STATE.CANDIDATE_READY, `${files.length} file(s) proposed`);
}

/**
 * ARCHIVE A PATCH that exists nowhere else (an A/B candidate is not a stored
 * candidates.js record): written before the workspace may become eligible.
 */
function archive(id, patchText) {
  const rec = read(id);
  if (!rec) return null;
  const d = path.join(dir(), 'archive');
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, `${id}.patch`);
  fs.writeFileSync(p, String(patchText || ''), 'utf8');
  rec.candidate = { ...(rec.candidate || {}), patch: p };
  return write(rec);
}

function byCandidate(candidateId) { return all().find((r) => r.candidate && r.candidate.id === candidateId) || null; }

/** integrate() is starting: written BEFORE any canonical write. */
function integrating(candidateId) {
  const rec = byCandidate(candidateId);
  return rec && ![STATE.DELETED, STATE.DELETING].includes(rec.state) ? note(rec, STATE.INTEGRATING) : rec;
}

/** integrate() finished: the receipt of what landed and the canonical bytes it left. */
function integrated(candidateId, { done = [], conflicts = [], failed = [], proposed = [] } = {}) {
  const rec = byCandidate(candidateId);
  if (!rec) return null;
  const canonical = {};
  for (const p of done) { try { canonical[p] = sha(fs.readFileSync(path.join(rec.root, p))); } catch { canonical[p] = 'absent'; } }
  const head = gitOut(rec.root, ['rev-parse', 'HEAD']);
  rec.integration = {
    at: now(), integrated: done, rejected: proposed.filter((p) => !done.includes(p)), conflicts, failed, canonical,
    revision: head || null, fingerprint: sha(JSON.stringify(canonical)),
  };
  if (conflicts.length) return note(rec, STATE.CONFLICTED, conflicts.join('; '));
  if (failed.length) return note(rec, STATE.FAILED, failed.join('; '));
  return note(rec, STATE.INTEGRATED, `${done.length} file(s)`);
}

/** The main agent rejected the candidate: archive it, then it may be cleaned. */
function rejected(candidateId, reason = '') {
  const rec = byCandidate(candidateId);
  if (!rec || [STATE.DELETED, STATE.DELETING].includes(rec.state)) return rec;
  rec.rejection = { at: now(), reason: String(reason || 'rejected by the main agent').slice(0, 300) };
  return note(rec, STATE.REJECTED, rec.rejection.reason);
}

/**
 * A RUN IN A SESSION (toolstep.finalStep): a canonical change resets the
 * verification a record has; a passing test run after its integration is the
 * TARGETED verification; a passing final smoke after the last change is the
 * FINAL SMOKE. Only records integrated into this session's tree are touched.
 */
function noteRun(session, { mutated = false, test = false, final = false, ok = false, command = '' } = {}) {
  if (!session) return [];
  const touched = [];
  for (const rec of all()) {
    if (rec.sessionId !== session.id || !rec.integration) continue;
    if (![STATE.INTEGRATED, STATE.TARGETED_VERIFIED, STATE.FINAL_SMOKE_PASSED].includes(rec.state)) continue;
    const at = now();
    if (mutated) { rec.lastMutationAt = at; if (rec.state === STATE.FINAL_SMOKE_PASSED) { rec.smoke = null; note(rec, STATE.TARGETED_VERIFIED, 'canonical changed after the smoke'); } else write(rec); touched.push(rec.id); continue; }
    if (!ok) continue;
    if ((test || final) && !rec.targeted) { rec.targeted = { at, command: String(command).slice(0, 200) }; note(rec, STATE.TARGETED_VERIFIED, rec.targeted.command); }
    if (final && rec.targeted) { rec.smoke = { at, command: String(command).slice(0, 200) }; note(rec, STATE.FINAL_SMOKE_PASSED, rec.smoke.command); }
    touched.push(rec.id);
  }
  return touched;
}

// ---- the decision ---------------------------------------------------------------

/** Is a process still using the directory? Deterministic evidence only. */
function busy(rec, app = null) {
  const reasons = [];
  if (!fs.existsSync(rec.dir)) return reasons;
  // A LIVE LAIN JOB WORKING THERE (a subagent session, a background run).
  try {
    for (const j of (app && app.jobs && typeof app.jobs.running === 'function' ? app.jobs.running() : [])) {
      const cwd = j.session && j.session.cwd;
      if (cwd && inside(real(cwd), rec.dir)) reasons.push(`job ${j.id} is running in it`);
    }
  } catch { /* no job registry */ }
  // WINDOWS HOLDS A DIRECTORY THAT IS A PROCESS'S CWD OR HAS AN OPEN HANDLE: a
  // rename to a sibling fails with EBUSY/EPERM. Renamed straight back.
  if (process.platform === 'win32') {
    const probe = `${rec.dir}.lain-probe`;
    try { fs.renameSync(rec.dir, probe); fs.renameSync(probe, rec.dir); } catch (e) {
      if (fs.existsSync(probe) && !fs.existsSync(rec.dir)) { try { fs.renameSync(probe, rec.dir); } catch { /* reported below */ } }
      reasons.push(`a process holds it open (${e.code || 'locked'})`);
    }
  }
  return reasons;
}

/** Every condition for a SUCCESSFUL workspace's removal, with the ones that fail. */
function eligibility(rec, app = null) {
  const why = [];
  if (!rec) return { ok: false, why: ['no such workspace'] };
  if ([STATE.DELETED].includes(rec.state)) return { ok: false, why: ['already deleted'] };
  if (RETAINED.has(rec.state)) return { ok: false, why: [`${rec.state}: retained as evidence`] };
  if (rec.state === STATE.ACTIVE) why.push('the child is still active');
  if (rec.state === STATE.CANDIDATE_READY || rec.state === STATE.INTEGRATING) why.push('the candidate is not resolved');
  const success = [STATE.INTEGRATED, STATE.TARGETED_VERIFIED, STATE.FINAL_SMOKE_PASSED, STATE.CLEANUP_ELIGIBLE, STATE.DELETING].includes(rec.state) && rec.integration;
  if (success) {
    const i = rec.integration;
    if (!i.canonical || Object.keys(i.canonical).length !== i.integrated.length) why.push('no integration receipt with canonical hashes');
    if (i.conflicts && i.conflicts.length) why.push('an unresolved conflict references it');
    if (i.integrated.length) {
      if (!rec.targeted || rec.targeted.at < i.at) why.push('no targeted verification after the integration');
      if (smokeRequired(rec) && (!rec.smoke || rec.smoke.at < i.at || (rec.lastMutationAt && rec.smoke.at < rec.lastMutationAt))) why.push('the final smoke has not passed since the last change');
    }
    if (rec.candidate && rec.candidate.stored && !candidateOnDisk(rec)) why.push('the candidate record is not on disk');
  } else if (rec.state === STATE.REJECTED) {
    if (rec.candidate && (rec.candidate.stored || rec.candidate.patch !== undefined) && !candidateOnDisk(rec)) why.push('the rejected candidate is not archived');
    if (rec.candidate && rec.candidate.files && rec.candidate.files.length && !rec.candidate.stored && !rec.candidate.patch) why.push('the rejected candidate has no archived patch');
  } else if (rec.state !== STATE.NOTHING_PROPOSED && rec.state !== STATE.CLEANUP_ELIGIBLE) {
    if (!why.length) why.push(`state ${rec.state} is not a resolved one`);
  }
  why.push(...busy(rec, app));
  const g = guard(rec, rec.dir);
  if (!g.ok) why.push(g.why);
  return { ok: why.length === 0, why };
}

function smokeRequired(rec) { try { return Boolean(require('./finalsmoke').suite(rec.root)); } catch { return false; } }
function candidateOnDisk(rec) {
  if (rec.candidate && rec.candidate.patch) return fs.existsSync(rec.candidate.patch);
  try {
    const d = path.join(require('./config').configDir(), 'candidates', String(rec.sessionId || 'no-session'));
    return fs.existsSync(path.join(d, `${rec.candidate.id}.json`));
  } catch { return false; }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * THE HARD GUARD. Returns { ok } only for the registered directory, as a
 * DIRECT child of the temp root, disjoint from every protected root.
 */
function guard(rec, target) {
  const t = real(target);
  const root = real(tempRoot());
  if (!rec || real(rec.dir) !== t) return { ok: false, why: 'DENIED: not the registered workspace directory' };
  const rel = path.relative(root, t);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(/[\\/]/).length !== 1) return { ok: false, why: `DENIED: ${t} is not directly inside the LAIN temp root ${root}` };
  // ONLY A NAME LAIN'S OWN mkdtemp PRODUCES — even a misconfigured temp root
  // cannot make a project folder beside it look like a workspace.
  if (!/^lain-/.test(path.basename(t))) return { ok: false, why: `DENIED: ${path.basename(t)} is not a LAIN workspace name` };
  const protectedRoots = [rec.root, path.join(__dirname, '..'), os.homedir(), require('./config').configDir(), path.dirname(rec.root || t)];
  try { protectedRoots.push(require('./harnesslocation').root && require('./harnesslocation').root()); } catch { /* no harness */ }
  try { for (const w of Object.values(require('./workerruntime').manifest())) if (w.defaultStore) protectedRoots.push(w.defaultStore); } catch { /* no manifest */ }
  // The target may not BE a protected root, CONTAIN one, or sit inside one —
  // except a root that also contains the temp root itself (the home folder that
  // holds %TEMP%), since everything under the temp root sits inside that.
  for (const p of protectedRoots.filter(Boolean).map(real)) {
    if (t === p || inside(p, t) || (inside(t, p) && !inside(root, p))) return { ok: false, why: `DENIED: ${t} overlaps the protected ${p}` };
  }
  return { ok: true };
}

// ---- the act ---------------------------------------------------------------------

function gitOut(cwd, args) {
  try {
    const r = require('child_process').spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return r.status === 0 ? String(r.stdout || '').trim() : null;
  } catch { return null; }
}

/** Remove exactly the registered directory, the git way for a worktree. */
function remove(rec) {
  // DEPENDENCY JUNCTIONS FIRST: a recursive removal that followed one would
  // delete the canonical node_modules.
  for (const d of LINKED) {
    const p = path.join(rec.dir, d);
    try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* not linked */ }
    try { if (fs.existsSync(p) && real(p) !== path.resolve(p)) fs.rmdirSync(p); } catch { /* a real directory is part of the workspace */ }
  }
  if (rec.kind === 'worktree') {
    gitOut(rec.root, ['worktree', 'remove', '--force', rec.dir]);
    if (fs.existsSync(rec.dir)) fs.rmSync(rec.dir, { recursive: true, force: true });
    gitOut(rec.root, ['worktree', 'prune']);
    const listed = gitOut(rec.root, ['worktree', 'list', '--porcelain']) || '';
    if (listed.split('\n').some((l) => l.startsWith('worktree ') && real(l.slice(9)) === rec.dir)) throw new Error('git still lists the worktree after removal');
  } else {
    fs.rmSync(rec.dir, { recursive: true, force: true });
  }
}

function receipt(rec) {
  return {
    temp: rec.id, kind: rec.kind, session: rec.sessionId, holder: rec.holder, label: rec.label,
    base: rec.base, candidate: rec.candidate ? { id: rec.candidate.id, hash: rec.candidate.hash, proposed: rec.candidate.files } : null,
    integrated: rec.integration ? rec.integration.integrated : [], rejected: rec.integration ? rec.integration.rejected : (rec.candidate ? rec.candidate.files : []),
    integration: rec.integration ? { revision: rec.integration.revision, fingerprint: rec.integration.fingerprint, canonical: rec.integration.canonical } : null,
    rejection: rec.rejection || null, targeted: rec.targeted, smoke: rec.smoke, outcome: rec.outcome || rec.state, cleanedAt: now(),
  };
}

/**
 * TRY TO REMOVE ONE WORKSPACE. Deterministic: eligibility from recorded facts,
 * the receipt first, DELETING before the removal, DELETED after. Returns
 * { ok, state, why[] }. Never throws into a turn.
 */
function attempt(id, app = null) {
  const rec = read(id);
  if (!rec) return { ok: false, why: ['no such workspace'] };
  if (rec.state === STATE.DELETED) return { ok: true, state: rec.state, why: [] };
  const e = eligibility(rec, app);
  if (!e.ok) return { ok: false, state: rec.state, why: e.why };
  try {
    if (rec.state !== STATE.DELETING) {
      rec.outcome = rec.state;
      note(rec, STATE.CLEANUP_ELIGIBLE);
      fs.mkdirSync(receiptsDir(), { recursive: true });
      fs.writeFileSync(path.join(receiptsDir(), `${rec.id}.json`), JSON.stringify(receipt(rec), null, 2), 'utf8');
      note(rec, STATE.DELETING);
    }
    if (process.env.LAIN_TEMP_CRASH_AT === 'DELETING') throw Object.assign(new Error('simulated crash'), { simulated: true });
    remove(rec);
    note(rec, STATE.DELETED);
    return { ok: true, state: STATE.DELETED, why: [] };
  } catch (err) {
    if (err && err.simulated) throw err;
    return { ok: false, state: read(id).state, why: [`removal failed: ${err && err.message}`] };
  }
}

/** Try every record of a session (after a verification, at turn close). */
function sweep(app, sessionId = null) {
  const out = [];
  for (const rec of all()) {
    if (sessionId && rec.sessionId !== sessionId) continue;
    if (rec.state === STATE.DELETED || RETAINED.has(rec.state) || rec.state === STATE.ACTIVE) continue;
    const r = attempt(rec.id, app);
    if (r.ok) out.push(rec.id);
  }
  return out;
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); } }

/**
 * AT STARTUP / RECOVERY: classify every registered workspace and every
 * directory under the temp root, finish interrupted cleanups once, expire old
 * retained ones, and NEVER touch what is not registered.
 */
function reconcile(app = null, { retentionDays = RETENTION_DAYS } = {}) {
  const report = { ACTIVE: [], RECOVERABLE: [], COMPLETED: [], STALE: [], ORPHANED: [], UNKNOWN: [], cleaned: [] };
  for (const rec of all()) {
    if (rec.state === STATE.DELETED) {
      // THE RECEIPT IS THE RECORD OF A DELETED WORKSPACE; its lifecycle file is
      // dropped after 30 days so the registry every mutation reads stays small.
      if ((Date.now() - Date.parse(rec.updatedAt || rec.createdAt)) / 86400000 > 30) { try { fs.unlinkSync(file(rec.id)); } catch { /* next start */ } }
      continue;
    }
    const exists = fs.existsSync(rec.dir);
    if (rec.state === STATE.ACTIVE) {
      if (rec.pid !== process.pid && alive(rec.pid)) { report.ACTIVE.push(rec.id); continue; }
      if (rec.pid === process.pid) { report.ACTIVE.push(rec.id); continue; }
      note(rec, STATE.ORPHANED, `owner ${rec.pid} is gone`);
      report.ORPHANED.push(rec.id);
      continue;
    }
    if ([STATE.DELETING, STATE.CLEANUP_ELIGIBLE].includes(rec.state) && !exists) {
      // THE CRASH LANDED AFTER THE REMOVAL: prune git's bookkeeping, record it.
      if (rec.kind === 'worktree') gitOut(rec.root, ['worktree', 'prune']);
      note(rec, STATE.DELETED, 'finished after a restart');
      report.COMPLETED.push(rec.id);
      continue;
    }
    if (RETAINED.has(rec.state)) {
      const age = (Date.now() - Date.parse(rec.updatedAt || rec.createdAt)) / 86400000;
      if (age > retentionDays) { report.STALE.push(rec.id); if (purge(rec.id, app, { reason: `retained ${Math.floor(age)} days` }).ok) report.cleaned.push(rec.id); }
      else report.ORPHANED.push(rec.id);
      continue;
    }
    const r = attempt(rec.id, app);
    if (r.ok) { report.COMPLETED.push(rec.id); report.cleaned.push(rec.id); } else report.RECOVERABLE.push(rec.id);
  }
  // WHAT IS IN THE TEMP ROOT WITHOUT A RECORD IS UNKNOWN, AND IS LEFT ALONE.
  const known = new Set(all().map((r) => r.dir));
  try {
    for (const e of fs.readdirSync(tempRoot(), { withFileTypes: true })) {
      const p = real(path.join(tempRoot(), e.name));
      if (e.isDirectory() && !known.has(p)) report.UNKNOWN.push(p);
    }
  } catch { /* no temp root yet */ }
  return report;
}

/**
 * THE PERSON'S EXPLICIT REMOVAL of a RETAINED workspace (or retention expiry).
 * Still guarded: the receipt is written, the path guard applies, a busy
 * directory is refused. It never applies to an unresolved success path.
 */
function purge(id, app = null, { reason = 'removed by the person' } = {}) {
  const rec = read(id);
  if (!rec) return { ok: false, why: ['no such workspace'] };
  if (!RETAINED.has(rec.state) && rec.state !== STATE.REJECTED) return { ok: false, why: [`${rec.state}: not a retained workspace — it is cleaned by its lifecycle`] };
  const why = [...busy(rec, app)];
  const g = guard(rec, rec.dir);
  if (!g.ok) why.push(g.why);
  if (why.length) return { ok: false, why };
  rec.outcome = rec.state;
  rec.purge = { at: now(), reason };
  fs.mkdirSync(receiptsDir(), { recursive: true });
  fs.writeFileSync(path.join(receiptsDir(), `${rec.id}.json`), JSON.stringify(receipt(rec), null, 2), 'utf8');
  note(rec, STATE.DELETING, reason);
  try { remove(rec); } catch (e) { return { ok: false, why: [`removal failed: ${e.message}`] }; }
  note(rec, STATE.DELETED, reason);
  return { ok: true, why: [] };
}

function receiptOf(id) { try { return JSON.parse(fs.readFileSync(path.join(receiptsDir(), `${id}.json`), 'utf8')); } catch { return null; } }

module.exports = {
  STATE, RETAINED, tempRoot, register, archive, candidateReady, integrating, integrated, rejected, noteRun,
  eligibility, attempt, sweep, reconcile, purge, guard, busy, read, all, receiptOf, byCandidate,
};
