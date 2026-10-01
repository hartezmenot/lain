'use strict';

/**
 * TEMPORARY WORKSPACE LIFECYCLE (tempworkspaces.js, 2026-09-23) — with real git.
 *
 * Pins the negative truths: no workspace is deleted before its candidate is
 * resolved, before canonical integration with a receipt, before a targeted
 * verification AND the final smoke after the last change; a failed, blocked or
 * conflicted one is RETAINED; a directory a process is using is not removed; a
 * crash between the smoke and the removal is finished once on restart with no
 * second integration; and the path guard refuses anything that is not the
 * registered directory directly under the LAIN temp root — the canonical
 * project above all.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { test, tmpdir } = require('../helpers');
const leases = require('../../src/leases');
const subagents = require('../../src/subagents');
const cands = require('../../src/candidates');
const tw = require('../../src/tempworkspaces');
const { Session } = require('../../src/session');
const { AgentJobs } = require('../../src/agentjob');

const hasGit = spawnSync('git', ['--version']).status === 0;

function repo() {
  const root = tmpdir('tw-canon-');
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(root, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend', 'api.js'), 'module.exports = 1;\n');
  // A test script, so the project HAS a final suite and the smoke is required.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e 0' } }));
  g('add', '.'); g('commit', '-qm', 'base');
  return { root, g };
}

function appFor(root) {
  const session = new Session({ cwd: root });
  session.save = () => {};
  return { session, cfg: { trustedPaths: [{ path: root, level: 'TRUSTED' }] }, jobs: new AgentJobs(), ui: { enabled: false } };
}

const impl = { role: 'IMPLEMENTER', objective: 'build it', readScope: ['**'], writeScope: ['backend/**'], expectedOutput: 'x', verification: 'node -e 0', completion: 'done' };

async function child(app, write = (cwd) => fs.writeFileSync(path.join(cwd, 'backend', 'api.js'), 'module.exports = 42;\n'), stopReason = 'end') {
  const out = await subagents.run(app, [impl], { mode: 'pipeline', runner: async ({ session }) => { write(session.cwd); return { text: 'done', stopReason, mutations: [] }; } });
  const r = out.results[0];
  const rec = tw.all().filter((x) => x.sessionId === app.session.id).sort((a, b) => a.createdAt < b.createdAt ? 1 : -1)[0];
  return { r, rec, cand: r.candidate };
}

const ctxOf = (app, root) => ({ app, session: app.session, cwd: root, checkpoints: null, turnId: 't' });

module.exports = async function () {
  process.env.LAIN_TEMP_ROOT = tmpdir('lain-tw-root-');

  await test('TEMP SUCCESS: kept until resolved, integrated, verified and smoked — then removed, git clean, receipt kept', async () => {
    if (!hasGit) return;
    leases._reset();
    const { root, g } = repo();
    const app = appFor(root);
    const { rec, cand } = await child(app);
    assert.strictEqual(tw.read(rec.id).state, 'CANDIDATE_READY');
    assert.ok(fs.existsSync(rec.dir), 'the workspace outlives the delegate call now');
    assert.match(tw.attempt(rec.id, app).why.join(), /candidate is not resolved/);
    const r = await cands.integrate(ctxOf(app, root), cand.id);
    assert.ok(r.ok, JSON.stringify(r));
    const after = tw.read(rec.id);
    assert.strictEqual(after.state, 'INTEGRATED');
    assert.deepStrictEqual(after.integration.integrated, ['backend/api.js']);
    assert.match(after.integration.canonical['backend/api.js'], /^[0-9a-f]{40}$/, 'canonical hash in the receipt');
    assert.match(tw.attempt(rec.id, app).why.join(), /no targeted verification/);
    tw.noteRun(app.session, { test: true, ok: true, command: 'node --test backend' });
    assert.match(tw.attempt(rec.id, app).why.join(), /final smoke has not passed/);
    tw.noteRun(app.session, { final: true, ok: true, command: 'npm test' });
    assert.strictEqual(tw.read(rec.id).state, 'FINAL_SMOKE_PASSED');
    // A CANONICAL CHANGE AFTER THE SMOKE voids it.
    tw.noteRun(app.session, { mutated: true });
    assert.strictEqual(tw.read(rec.id).state, 'TARGETED_VERIFIED');
    assert.match(tw.attempt(rec.id, app).why.join(), /final smoke/);
    tw.noteRun(app.session, { final: true, ok: true, command: 'npm test' });
    assert.deepStrictEqual(tw.sweep(app, app.session.id), [rec.id]);
    assert.strictEqual(tw.read(rec.id).state, 'DELETED');
    assert.ok(!fs.existsSync(rec.dir), 'removed');
    assert.ok(!g('worktree', 'list', '--porcelain').stdout.includes(path.basename(rec.dir)), 'git worktree registry clean');
    assert.ok(!fs.existsSync(path.join(root, '.git', 'worktrees', path.basename(rec.dir))), 'no stale .git/worktrees entry');
    const receipt = tw.receiptOf(rec.id);
    for (const k of ['temp', 'session', 'base', 'candidate', 'integrated', 'rejected', 'integration', 'targeted', 'smoke', 'cleanedAt']) assert.ok(k in receipt, `receipt has ${k}`);
    assert.deepStrictEqual(receipt.integrated, ['backend/api.js']);
    assert.ok(cands.load(app, cand.id), 'the candidate record is preserved');
    assert.strictEqual(fs.readFileSync(path.join(root, 'backend', 'api.js'), 'utf8'), 'module.exports = 42;\n', 'the canonical change stands');
  });

  await test('TEMP FAILURE: a child that did not finish is RETAINED as evidence; only the person removes it', async () => {
    if (!hasGit) return;
    leases._reset();
    const { root } = repo();
    const app = appFor(root);
    const { rec } = await child(app, undefined, 'provider');
    assert.strictEqual(tw.read(rec.id).state, 'FAILED');
    assert.ok(fs.existsSync(path.join(rec.dir, 'backend', 'api.js')), 'the failed work is inspectable');
    assert.match(tw.attempt(rec.id, app).why.join(), /retained as evidence/);
    assert.deepStrictEqual(tw.sweep(app, app.session.id), [], 'no sweep removes it');
    assert.ok(tw.purge(rec.id, app).ok, 'the person can remove it explicitly');
    assert.ok(!fs.existsSync(rec.dir));
    assert.strictEqual(tw.receiptOf(rec.id).outcome, 'FAILED');
  });

  await test('TEMP CONFLICT: the canonical file moved — not integrated, CONFLICTED, retained', async () => {
    if (!hasGit) return;
    leases._reset();
    const { root } = repo();
    const app = appFor(root);
    const { rec, cand } = await child(app);
    fs.writeFileSync(path.join(root, 'backend', 'api.js'), 'module.exports = "main moved";\n');
    const r = await cands.integrate(ctxOf(app, root), cand.id);
    assert.ok(!r.ok && r.conflicts.length);
    assert.strictEqual(fs.readFileSync(path.join(root, 'backend', 'api.js'), 'utf8'), 'module.exports = "main moved";\n', 'not integrated');
    assert.strictEqual(tw.read(rec.id).state, 'CONFLICTED');
    assert.ok(!tw.attempt(rec.id, app).ok);
    assert.ok(fs.existsSync(rec.dir), 'retained');
    tw.purge(rec.id, app);
  });

  await test('TEMP BUSY: a running job or process in the workspace blocks removal until it settles', async () => {
    if (!hasGit) return;
    leases._reset();
    const { root } = repo();
    const app = appFor(root);
    const { rec, cand } = await child(app);
    await cands.integrate(ctxOf(app, root), cand.id);
    tw.noteRun(app.session, { test: true, ok: true, command: 'npm test' });
    tw.noteRun(app.session, { final: true, ok: true, command: 'npm test' });
    // A LAIN job still working there.
    const fakeJob = { id: 9, session: { cwd: rec.dir } };
    const appBusy = { ...app, jobs: { running: () => [fakeJob] } };
    assert.match(tw.attempt(rec.id, appBusy).why.join(), /job 9 is running in it/);
    // An OS process whose working directory is the workspace (Windows holds it).
    if (process.platform === 'win32') {
      const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: rec.dir, stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 400));
      assert.match(tw.attempt(rec.id, app).why.join(), /a process holds it open/);
      assert.ok(fs.existsSync(rec.dir), 'not removed while in use');
      p.kill();
      await new Promise((r) => p.once('exit', r));
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(tw.attempt(rec.id, app).ok, 'removed once nothing uses it');
  });

  await test('TEMP CRASH: a crash after the smoke, before the removal, is finished ONCE on restart — no second integration', async () => {
    if (!hasGit) return;
    leases._reset();
    const { root, g } = repo();
    const app = appFor(root);
    const { rec, cand } = await child(app);
    await cands.integrate(ctxOf(app, root), cand.id);
    tw.noteRun(app.session, { test: true, ok: true, command: 'npm test' });
    tw.noteRun(app.session, { final: true, ok: true, command: 'npm test' });
    process.env.LAIN_TEMP_CRASH_AT = 'DELETING';
    assert.throws(() => tw.attempt(rec.id, app), /simulated crash/);
    delete process.env.LAIN_TEMP_CRASH_AT;
    assert.strictEqual(tw.read(rec.id).state, 'DELETING', 'the intent was recorded before the removal');
    assert.ok(fs.existsSync(rec.dir) && tw.receiptOf(rec.id), 'receipt written, directory still there');
    const first = tw.reconcile(app);
    assert.ok(first.cleaned.includes(rec.id));
    assert.ok(!fs.existsSync(rec.dir));
    const second = tw.reconcile(app);
    assert.ok(!second.cleaned.includes(rec.id), 'cleaned once');
    assert.strictEqual(tw.read(rec.id).state, 'DELETED');
    const again = await cands.integrate(ctxOf(app, root), cand.id);
    assert.match(again.why, /already integrated/, 'no duplicate integration');
    assert.ok(!g('worktree', 'list', '--porcelain').stdout.includes(path.basename(rec.dir)));
  });

  await test('TEMP CRASH (after the removal): DELETING with the directory gone becomes DELETED, git metadata pruned', async () => {
    if (!hasGit) return;
    leases._reset();
    const { root, g } = repo();
    const app = appFor(root);
    const { rec } = await child(app);
    const r = tw.read(rec.id);
    r.state = 'DELETING';
    fs.writeFileSync(path.join(require('../../src/config').configDir(), 'workspaces', `${rec.id}.json`), JSON.stringify(r));
    fs.rmSync(rec.dir, { recursive: true, force: true });   // the crash happened after rmSync, before git prune
    tw.reconcile(app);
    assert.strictEqual(tw.read(rec.id).state, 'DELETED');
    assert.ok(!g('worktree', 'list', '--porcelain').stdout.includes(path.basename(rec.dir)), 'pruned');
  });

  await test('TEMP REJECTED / NOTHING PROPOSED: archived first, then removed with a receipt', async () => {
    if (!hasGit) return;
    leases._reset();
    const { root } = repo();
    const app = appFor(root);
    const { rec, cand } = await child(app);
    const j = cands.reject(app, cand.id, 'the other approach is simpler');
    assert.ok(j.ok && j.workspace === 'DELETED', JSON.stringify(j));
    assert.strictEqual(cands.load(app, cand.id).state, 'REJECTED', 'the candidate record is archived');
    assert.match((await cands.integrate(ctxOf(app, root), cand.id)).why, /rejected/);
    assert.strictEqual(tw.receiptOf(rec.id).rejection.reason, 'the other approach is simpler');
    const none = await child(app, () => {});
    assert.strictEqual(tw.read(none.rec.id).state, 'DELETED', 'a child that proposed nothing leaves nothing behind');
  });

  await test('TEMP ORPHAN / UNKNOWN: a dead owner is ORPHANED and retained; an unregistered directory is never touched', async () => {
    if (!hasGit) return;
    const { root } = repo();
    const d = fs.mkdtempSync(path.join(tw.tempRoot(), 'lain-sub-orphan-'));
    const rec = tw.register({ kind: 'snapshot', dir: d, root }, { sessionId: 'gone' });
    const r = tw.read(rec.id); r.pid = 2147483000; fs.writeFileSync(path.join(require('../../src/config').configDir(), 'workspaces', `${rec.id}.json`), JSON.stringify(r));
    const stray = fs.mkdtempSync(path.join(tw.tempRoot(), 'lain-stray-'));
    const rep = tw.reconcile(null);
    assert.ok(rep.ORPHANED.includes(rec.id));
    assert.strictEqual(tw.read(rec.id).state, 'ORPHANED');
    assert.ok(fs.existsSync(d), 'orphan retained');
    assert.ok(rep.UNKNOWN.some((p) => path.basename(p) === path.basename(stray)), 'unknown reported');
    assert.ok(fs.existsSync(stray), 'unknown untouched');
  });

  await test('TEMP PATH GUARD: canonical, this repo, home, parents and unregistered paths are DENIED', async () => {
    const { root } = repo();
    const d = fs.mkdtempSync(path.join(tw.tempRoot(), 'lain-sub-guard-'));
    const rec = tw.register({ kind: 'snapshot', dir: d, root }, { sessionId: 'g' });
    assert.ok(tw.guard(rec, d).ok, 'the registered workspace passes');
    for (const bad of [root, path.join(__dirname, '..', '..'), os.homedir(), path.dirname(root), tw.tempRoot(), path.join(d, '..', '..')]) {
      assert.ok(!tw.guard(rec, bad).ok, `denied: ${bad}`);
      assert.ok(!tw.guard({ ...rec, dir: bad }, bad).ok, `denied even when registered: ${bad}`);
    }
    const notOurs = fs.mkdtempSync(path.join(tw.tempRoot(), 'project-'));
    assert.ok(!tw.guard({ ...rec, dir: notOurs }, notOurs).ok, 'a non-Noema name under the temp root is denied');
    // A FORGED record pointing at the canonical project, marked eligible: refused, project intact.
    const forged = { ...tw.read(rec.id), id: 'twforged', dir: root, state: 'NOTHING_PROPOSED' };
    fs.writeFileSync(path.join(require('../../src/config').configDir(), 'workspaces', 'twforged.json'), JSON.stringify(forged));
    const res = tw.attempt('twforged', null);
    assert.ok(!res.ok && /DENIED/.test(res.why.join()), JSON.stringify(res));
    assert.ok(fs.existsSync(path.join(root, 'backend', 'api.js')), 'the canonical project is intact');
    fs.rmSync(path.join(require('../../src/config').configDir(), 'workspaces', 'twforged.json'));
  });

  await test('TEMP A/B: the loser is archived and removed, the winner waits for the final smoke', async () => {
    if (!hasGit) return;
    leases._reset();
    const { root, g } = repo();
    const app = appFor(root);
    const ab = require('../../src/abtest');
    const r = await ab.run(app, {
      problem: 'make it 7', verifyCommand: 'node -e 0', candidates: ['a', 'b'],
      runCandidate: async (c) => { fs.writeFileSync(path.join(c.dir, 'backend', 'api.js'), `module.exports = ${c.label === 'A' ? 7 : '3 + 4'};\n`); return { ok: true }; },
      decide: async () => 'A',
    });
    assert.ok(r.ok && r.integrated, JSON.stringify(r.why));
    const recs = tw.all().filter((x) => x.sessionId === app.session.id);
    const win = recs.find((x) => x.label === 'ab-A');
    const lose = recs.find((x) => x.label === 'ab-B');
    assert.strictEqual(lose.state, 'DELETED');
    assert.ok(fs.readFileSync(tw.read(lose.id).candidate.patch, 'utf8').includes('3 + 4'), 'the loser\'s patch is archived');
    assert.strictEqual(win.state, 'TARGETED_VERIFIED', 'integrated and verified on the canonical tree');
    assert.ok(fs.existsSync(win.dir), 'the winner waits for the final smoke');
    tw.noteRun(app.session, { final: true, ok: true, command: 'npm test' });
    tw.sweep(app, app.session.id);
    assert.strictEqual(tw.read(win.id).state, 'DELETED');
    assert.ok(!/lain-ab-/.test(g('worktree', 'list').stdout), 'no worktree left registered');
  });
};
