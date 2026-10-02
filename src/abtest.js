'use strict';

/**
 * A/B IMPLEMENTATION (§67–70).
 *
 *   problem → candidate A (isolated) + candidate B (isolated)
 *           → the SAME verification contract in each
 *           → compare evidence → select → integrate the winner
 *           → verify the canonical tree → delete every temporary artefact
 *
 * ISOLATION: each candidate is a DETACHED git worktree seeded from the exact
 * current working state (tracked + untracked, .gitignore respected) — a commit
 * object built through a private index, so no ref, branch or stash is created
 * and the user's index is never touched. Candidates never write the canonical
 * tree; the canonical scope is leased for the duration so nothing else does.
 *
 * SELECTION is deterministic when the evidence decides it: a passing candidate
 * beats a failing one; between two passes a materially smaller change wins,
 * then a materially faster verification. Otherwise it is genuinely a judgement
 * and the person is asked. Nobody available → nothing is integrated.
 *
 * CLEANUP always runs: worktrees removed and pruned, temp dirs deleted, the
 * candidate sessions discarded. What survives is one small decision record:
 * `Selected B — passes; 12 vs 40 changed lines`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function git(cwd, args, { input = null, env = null } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, env: env ? { ...process.env, ...env } : process.env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: String(r.stdout || ''), err: String(r.stderr || '').trim(), code: r.status };
}

/** A commit object for the current working state, made without touching refs or the real index. */
function baseCommit(root) {
  const idx = path.join(os.tmpdir(), `lain-ab-idx-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    const head = git(root, ['rev-parse', 'HEAD']);
    if (!head.ok) return { ok: false, why: 'not a git repository with a commit — A/B needs git to isolate candidates' };
    if (!git(root, ['read-tree', 'HEAD'], { env }).ok) return { ok: false, why: 'could not read HEAD' };
    if (!git(root, ['add', '-A'], { env }).ok) return { ok: false, why: 'could not stage the working state privately' };
    const tree = git(root, ['write-tree'], { env });
    if (!tree.ok) return { ok: false, why: 'could not write the working tree' };
    const commit = git(root, ['commit-tree', tree.out.trim(), '-p', head.out.trim(), '-m', 'lain a/b base'], {
      env: { GIT_AUTHOR_NAME: 'LAIN', GIT_AUTHOR_EMAIL: 'lain@localhost', GIT_COMMITTER_NAME: 'LAIN', GIT_COMMITTER_EMAIL: 'lain@localhost' },
    });
    if (!commit.ok) return { ok: false, why: `could not record the base: ${commit.err}` };
    return { ok: true, base: commit.out.trim() };
  } finally {
    try { fs.unlinkSync(idx); } catch { /* never created */ }
  }
}

function addWorktree(root, base, label) {
  // UNDER THE LAIN TEMP ROOT, where the workspace lifecycle (tempworkspaces.js) owns it.
  const dir = fs.mkdtempSync(path.join(require('./tempworkspaces').tempRoot(), `lain-ab-${label}-`));
  fs.rmdirSync(dir);
  const r = git(root, ['worktree', 'add', '--detach', dir, base]);
  return r.ok ? { ok: true, dir } : { ok: false, why: r.err };
}

/** The candidate's change against the base, as a binary patch and a size. */
function changeOf(dir, base) {
  git(dir, ['add', '-A']);
  const patch = git(dir, ['diff', '--cached', '--binary', base]);
  const stat = git(dir, ['diff', '--cached', '--numstat', base]);
  let lines = 0;
  const files = [];
  for (const row of stat.out.split('\n').filter(Boolean)) {
    const [a, d, f] = row.split('\t');
    lines += (Number(a) || 0) + (Number(d) || 0);
    files.push(f);
  }
  return { patch: patch.out, lines, files };
}

function verify(cwd, command, timeoutMs) {
  const started = Date.now();
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  const r = spawnSync(shell, args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-12).join('\n');
  return { ok: r.status === 0, code: r.status, ms: Date.now() - started, tail };
}

/**
 * The deterministic part of the choice. Returns a winner label with a reason,
 * or `{ subjective: true }` when the evidence genuinely does not decide.
 */
function select(a, b) {
  const pass = (c) => c.ran && c.verify.ok && c.change.lines > 0;
  if (pass(a) && !pass(b)) return { winner: 'A', reason: `A passes ${a.command}; B ${b.verify.ok ? 'changed nothing' : `fails (exit ${b.verify.code})`}` };
  if (pass(b) && !pass(a)) return { winner: 'B', reason: `B passes ${b.command}; A ${a.verify.ok ? 'changed nothing' : `fails (exit ${a.verify.code})`}` };
  if (!pass(a) && !pass(b)) return { winner: null, reason: 'neither candidate passes the verification contract' };
  const [x, y] = [a.change.lines, b.change.lines];
  if (Math.min(x, y) > 0 && Math.max(x, y) >= Math.min(x, y) * 1.25 && Math.abs(x - y) >= 3) {
    const w = x < y ? 'A' : 'B';
    return { winner: w, reason: `both pass; ${w} is the smaller change (${Math.min(x, y)} vs ${Math.max(x, y)} changed lines)` };
  }
  const [s, t] = [a.verify.ms, b.verify.ms];
  if (Math.max(s, t) >= Math.min(s, t) * 1.5 && Math.abs(s - t) >= 500) {
    const w = s < t ? 'A' : 'B';
    return { winner: w, reason: `both pass at similar size; ${w} verifies materially faster (${Math.min(s, t)}ms vs ${Math.max(s, t)}ms)` };
  }
  return { winner: null, subjective: true, reason: 'both pass with comparable size and speed' };
}

function cleanup(root, dirs) {
  for (const d of dirs) {
    if (!d) continue;
    git(root, ['worktree', 'remove', '--force', d]);
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* removed above */ }
  }
  git(root, ['worktree', 'prune']);
}

/**
 * Run the whole workflow. `runCandidate({label, dir, approach, contract})` does
 * the implementation in `dir`; production uses a bounded IMPLEMENTER subagent.
 */
async function run(app, { problem, verifyCommand, candidates = [], scope = [], timeoutMs = 10 * 60 * 1000, runCandidate = null, decide = null } = {}) {
  const top = git(app.session.cwd, ['rev-parse', '--show-toplevel']);
  const root = top.ok && top.out.trim() ? path.resolve(top.out.trim()) : app.session.cwd;
  if (!problem || !verifyCommand) return { ok: false, why: 'A/B needs a problem and one verification command both candidates must pass' };
  if (candidates.length !== 2) return { ok: false, why: 'A/B needs exactly two candidate approaches' };
  const writeScope = scope.length ? scope : null;
  const base = baseCommit(root);
  if (!base.ok) return { ok: false, why: base.why };
  const leases = require('./leases');
  const holder = `ab#${base.base.slice(0, 8)}`;
  if (writeScope) {
    const l = leases.acquire(holder, writeScope, 'A/B comparison');
    if (!l.ok) return { ok: false, why: `scope is busy: ${l.why}` };
  }
  const dirs = [];
  const trusted = app.cfg.trustedPaths;
  // EACH WORKTREE IS REGISTERED WITH ITS LIFECYCLE (tempworkspaces.js), which
  // decides its removal: the loser once its patch is archived, the winner once
  // integrated, verified and past the final smoke, a failure never at once.
  const tw = require('./tempworkspaces');
  const out = [];
  try {
    for (const [i, cand] of candidates.entries()) {
      const label = i === 0 ? 'A' : 'B';
      const wt = addWorktree(root, base.base, label);
      if (!wt.ok) return { ok: false, why: `could not isolate candidate ${label}: ${wt.why}` };
      dirs.push(wt.dir);
      let temp = null;
      try { temp = tw.register({ kind: 'worktree', dir: wt.dir, root, base: base.base }, { sessionId: app.session.id, holder, label: `ab-${label}` }).id; } catch { temp = null; }
      out.push({ label, dir: wt.dir, approach: String(cand.approach || cand || ''), temp, cid: `ab${base.base.slice(0, 8)}${label}${Date.now().toString(36)}` });
    }
    app.cfg.trustedPaths = [...(Array.isArray(trusted) ? trusted : []), ...dirs.map((d) => ({ path: d, level: 'TRUSTED' }))];
    const impl = runCandidate || ((c) => require('./subagents').runOne(app, {
      role: 'IMPLEMENTER', objective: `${problem}\nApproach ${c.label}: ${c.approach}`,
      readScope: ['**'], writeScope: writeScope || ['**'], isolated: true,
      ownedFiles: writeScope || [], expectedOutput: 'the implemented change and why it satisfies the problem',
      verification: verifyCommand, completion: `${verifyCommand} passes in this worktree`, parentTask: problem, cwd: c.dir,
    }, { stage: c.label === 'A' ? 0 : 1, of: 2 }));
    for (const c of out) {
      let ran = null;
      try { ran = await impl(c); } catch (e) { ran = { ok: false, why: (e && e.message) || String(e) }; }
      c.ran = Boolean(ran && ran.ok !== false);
      c.change = changeOf(c.dir, base.base);
      c.command = verifyCommand;
      c.verify = verify(c.dir, verifyCommand, timeoutMs);
      if (c.temp) {
        // THE PATCH IS ARCHIVED FIRST — it is the only record of this candidate.
        tw.archive(c.temp, c.change.patch);
        tw.candidateReady(c.temp, { id: c.cid, role: `A/B ${c.label}`, files: c.change.files.map((p) => ({ path: p, status: 'M' })), verdict: { ok: true }, stored: false },
          { failed: !c.ran || !c.verify.ok, why: !c.ran ? 'the candidate did not finish' : `its verification failed (exit ${c.verify.code})` });
      }
    }
    const [a, b] = out;
    let pick = select(a, b);
    if (pick.subjective) {
      const answer = decide ? await decide(a, b) : await require('./decisions').ask(app, {
        type: 'ASK_USER', title: 'A/B · both candidates pass — which approach?',
        question: `A: ${a.approach}\n   ${a.change.lines} lines · ${a.verify.ms}ms\nB: ${b.approach}\n   ${b.change.lines} lines · ${b.verify.ms}ms`,
        options: ['A', 'B', 'Neither'],
      });
      pick = answer === 'A' || answer === 'B' ? { winner: answer, reason: `both pass; the person chose ${answer}` } : { winner: null, reason: 'both pass; no choice was made, so nothing was integrated' };
    }
    const record = { kind: 'ab', at: new Date().toISOString(), problem: String(problem).slice(0, 200), selected: pick.winner, reason: pick.reason,
      candidates: out.map((c) => ({ label: c.label, approach: c.approach.slice(0, 120), pass: c.verify.ok, lines: c.change.lines, ms: c.verify.ms })) };
    if (!pick.winner) {
      for (const c of out) if (c.verify.ok) tw.rejected(c.cid, pick.reason);
      remember(app, record);
      return { ok: false, integrated: false, record, why: pick.reason, candidates: out.map(strip) };
    }
    const win = pick.winner === 'A' ? a : b;
    const lose = win === a ? b : a;
    if (lose.verify.ok) tw.rejected(lose.cid, `not selected: ${pick.reason}`);
    tw.integrating(win.cid);
    const applied = git(root, ['apply', '--whitespace=nowarn', '-'], { input: win.change.patch });
    if (!applied.ok) {
      tw.integrated(win.cid, { conflicts: [`the patch did not apply: ${applied.err.slice(0, 160)}`], proposed: win.change.files });
      record.reason += `; integration failed: ${applied.err.slice(0, 200)}`;
      remember(app, record);
      return { ok: false, integrated: false, record, why: `the winning patch did not apply to the canonical tree: ${applied.err}`, candidates: out.map(strip) };
    }
    const canonical = verify(root, verifyCommand, timeoutMs);
    if (!canonical.ok) {
      git(root, ['apply', '-R', '--whitespace=nowarn', '-'], { input: win.change.patch });
      tw.integrated(win.cid, { failed: [`canonical verification failed (exit ${canonical.code}); reverted`], proposed: win.change.files });
      record.reason += `; canonical verification failed (exit ${canonical.code}) and the change was reverted`;
      remember(app, record);
      return { ok: false, integrated: false, record, why: 'the winner did not verify on the canonical tree; it was reverted', canonical, candidates: out.map(strip) };
    }
    record.files = win.change.files;
    // THE RECEIPT, and the canonical run that just passed is its TARGETED verification.
    tw.integrated(win.cid, { done: win.change.files, proposed: win.change.files });
    tw.noteRun(app.session, { test: true, ok: true, command: verifyCommand });
    remember(app, record);
    return { ok: true, integrated: true, record, canonical, candidates: out.map(strip) };
  } finally {
    app.cfg.trustedPaths = trusted;
    if (writeScope) leases.release(holder);
    for (const c of out) {
      if (!c.temp) { cleanup(root, [c.dir]); continue; }
      const rec = tw.read(c.temp);
      if (rec && rec.state === tw.STATE.ACTIVE) tw.candidateReady(c.temp, null, { failed: true, why: 'the A/B run did not complete' });
      tw.attempt(c.temp, app);   // removed only where its lifecycle allows; otherwise retained
    }
    for (const d of dirs) if (!out.some((c) => c.dir === d)) cleanup(root, [d]);
  }
}

function strip(c) { return { label: c.label, approach: c.approach, pass: c.verify && c.verify.ok, lines: c.change && c.change.lines, ms: c.verify && c.verify.ms, tail: c.verify && c.verify.tail }; }

function remember(app, record) {
  const s = app.session;
  s.decisions = Array.isArray(s.decisions) ? s.decisions : [];
  s.decisions.push(record);
  if (s.decisions.length > 20) s.decisions.shift();
}

module.exports = { run, select, baseCommit, changeOf, verify, cleanup, git, addWorktree };
