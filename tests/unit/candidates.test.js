'use strict';

/**
 * SUBAGENTS NEVER WRITE MAIN (candidates.js, 2026-09-23).
 *
 * Every child that can write or run commands works in an isolated workspace
 * (git worktree, or a snapshot copy); its work comes back as a CANDIDATE,
 * checked for out-of-scope writes, undeclared deletions and size; only the main
 * agent's integrate_candidate writes the project, through the normal door.
 * Real git, real files — no mock of the thing being tested.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, tmpdir } = require('../helpers');
const leases = require('../../src/leases');
const subagents = require('../../src/subagents');
const cands = require('../../src/candidates');
const { Session } = require('../../src/session');
const { AgentJobs } = require('../../src/agentjob');

const hasGit = spawnSync('git', ['--version']).status === 0;

function repo() {
  const root = tmpdir('cand-');
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(root, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(root, 'frontend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend', 'api.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'frontend', 'ui.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# app\n');
  g('add', '.'); g('commit', '-qm', 'base');
  return { root, g };
}

function appFor(root) {
  const session = new Session({ cwd: root });
  session.save = () => {};
  return { session, cfg: { trustedPaths: [{ path: root, level: 'TRUSTED' }] }, jobs: new AgentJobs(), ui: { enabled: false } };
}

const impl = (over = {}) => ({
  role: 'IMPLEMENTER', objective: 'build it', readScope: ['**'], writeScope: ['backend/**'],
  expectedOutput: 'the change', verification: 'node -e 1', completion: 'done', ...over,
});

module.exports = async function () {
  await test('CANDIDATE: a writer runs in an isolated worktree — the canonical tree is untouched and no worktree survives', async () => {
    if (!hasGit) { process.stdout.write('    (git not available — UNSUPPORTED here)\n'); return; }
    leases._reset();
    const { root, g } = repo();
    fs.writeFileSync(path.join(root, 'backend', 'wip.js'), 'uncommitted\n');
    // An ignored dependency directory: linked into the worktree, never deleted through the link.
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
    fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep\n');
    const app = appFor(root);
    let seenCwd = null;
    const out = await subagents.run(app, [impl()], {
      mode: 'pipeline',
      runner: async ({ session }) => {
        seenCwd = session.cwd;
        assert.notStrictEqual(path.resolve(session.cwd), path.resolve(root), 'not the canonical project');
        assert.ok(fs.existsSync(path.join(session.cwd, 'backend', 'wip.js')), 'seeded from the exact working state');
        assert.ok(fs.existsSync(path.join(session.cwd, 'node_modules', 'dep', 'index.js')), 'dependencies are linked in');
        fs.writeFileSync(path.join(session.cwd, 'backend', 'api.js'), 'module.exports = 42;\n');
        return { text: 'done', stopReason: 'end', mutations: [] };
      },
    });
    assert.ok(out.ok, JSON.stringify(out.results.map((r) => r.why)));
    const c = out.results[0].candidate;
    assert.ok(c && c.verdict.ok, 'an in-scope change is ACCEPTABLE');
    assert.deepStrictEqual(c.files.map((f) => [f.status, f.path]), [['M', 'backend/api.js']]);
    assert.strictEqual(fs.readFileSync(path.join(root, 'backend', 'api.js'), 'utf8'), 'module.exports = 1;\n', 'main was not written');
    // THE WORKSPACE NOW WAITS FOR ITS CANDIDATE'S RESOLUTION (tempworkspaces.js):
    // kept while unresolved, removed by its lifecycle once rejected here.
    assert.ok(fs.existsSync(seenCwd), 'the workspace is kept while the candidate is unresolved');
    const tw = require('../../src/tempworkspaces');
    assert.strictEqual(tw.byCandidate(c.id).state, 'CANDIDATE_READY');
    assert.ok(cands.reject(app, c.id, 'test').ok);
    assert.ok(!fs.existsSync(seenCwd), 'the workspace was removed once the candidate was resolved');
    assert.ok(fs.existsSync(path.join(root, 'node_modules', 'dep', 'index.js')), 'the real node_modules survived the worktree removal');
    assert.ok(!/lain-ab-/.test(g('worktree', 'list').stdout), 'no worktree registered');
    assert.strictEqual(g('branch', '--list').stdout.trim().split('\n').length, 1, 'no branch created');
    assert.strictEqual(g('stash', 'list').stdout.trim(), '', 'no stash');
    assert.deepStrictEqual(out.results[0].mutations, [], 'nothing is reported as a canonical mutation');
    assert.match(subagents.report(out), /NOTHING WAS WRITTEN TO THE PROJECT[\s\S]*integrate_candidate/);
  });

  await test('CANDIDATE: destructive-patch protection — out-of-scope writes and undeclared deletions are REJECTED', async () => {
    if (!hasGit) return;
    leases._reset();
    const { root } = repo();
    const app = appFor(root);
    const out = await subagents.run(app, [impl()], {
      mode: 'pipeline',
      runner: async ({ session }) => {
        fs.writeFileSync(path.join(session.cwd, 'backend', 'api.js'), 'module.exports = 3;\n');   // 1 in-scope edit
        fs.writeFileSync(path.join(session.cwd, 'frontend', 'ui.js'), 'hijacked\n');             // out of scope
        fs.unlinkSync(path.join(session.cwd, 'README.md'));                                      // undeclared delete
        return { text: 'done', stopReason: 'end', mutations: [] };
      },
    });
    const c = out.results[0].candidate;
    assert.strictEqual(c.verdict.ok, false);
    assert.ok(c.verdict.reasons.some((r) => /frontend\/ui\.js: outside the declared writeScope/.test(r)));
    assert.ok(c.verdict.reasons.some((r) => /README\.md: deleted, and deletion was not declared/.test(r)));
    const ctx = { app, session: app.session, cwd: root, checkpoints: null, turnId: 't' };
    const r = await cands.integrate(ctx, c.id);
    assert.match(r.why, /REJECTED/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'frontend', 'ui.js'), 'utf8'), 'module.exports = 2;\n');
    assert.ok(fs.existsSync(path.join(root, 'README.md')), 'the project was not erased');
  });

  await test('CANDIDATE: check() — 2 expected edits plus 47 deletions is rejected; a declared deletion is allowed', () => {
    const contract = { writeScope: ['src/**'], ownedFiles: ['src/old.js'] };
    const files = [{ status: 'M', path: 'src/a.js', added: 1, removed: 1 }, { status: 'M', path: 'src/b.js', added: 1, removed: 1 }];
    for (let i = 0; i < 47; i++) files.push({ status: 'D', path: `src/gen/${i}.js`, added: 0, removed: 10 });
    const v = cands.check(contract, files);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reasons.filter((r) => /deleted/.test(r)).length, 47);
    assert.ok(cands.check(contract, [{ status: 'D', path: 'src/old.js' }]).ok, 'a deletion named in ownedFiles is the contract');
  });

  await test('CANDIDATE: integration is the main agent\'s — through the normal write door; a canonical change since the base is a CONFLICT', () => require('../helpers').legacyOnly(async () => {   // LEGACY path only
    if (!hasGit) return;
    leases._reset();
    const { root } = repo();
    const app = appFor(root);
    const out = await subagents.run(app, [impl({ writeScope: ['backend/**', 'frontend/**'] })], {
      mode: 'pipeline',
      runner: async ({ session }) => {
        fs.writeFileSync(path.join(session.cwd, 'backend', 'api.js'), 'module.exports = 10;\n');
        fs.writeFileSync(path.join(session.cwd, 'frontend', 'ui.js'), 'module.exports = 20;\n');
        fs.writeFileSync(path.join(session.cwd, 'backend', 'new.js'), 'exports.n = 1;\n');
        return { text: 'done', stopReason: 'end', mutations: [] };
      },
    });
    const c = out.results[0].candidate;
    assert.ok(c.verdict.ok);
    // The main agent edited frontend/ui.js meanwhile.
    fs.writeFileSync(path.join(root, 'frontend', 'ui.js'), 'module.exports = 99;\n');
    // A subagent can never integrate.
    const refused = await require('../../src/tools').execute('integrate_candidate', { id: c.id }, { cwd: root, workOrder: { bounded: true }, app });
    assert.ok(refused.denied);
    const ctx = { app, session: app.session, cwd: root, checkpoints: null, turnId: 't' };
    const r = await cands.integrate(ctx, c.id);
    assert.deepStrictEqual(r.done.sort(), ['backend/api.js', 'backend/new.js'], JSON.stringify(r));
    assert.strictEqual(r.conflicts.length, 1);
    assert.match(r.conflicts[0], /frontend\/ui\.js: changed in the canonical tree/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'backend', 'api.js'), 'utf8'), 'module.exports = 10;\n');
    assert.strictEqual(fs.readFileSync(path.join(root, 'frontend', 'ui.js'), 'utf8'), 'module.exports = 99;\n', 'the main agent\'s own work was not overwritten');
    assert.ok(r.mutated.length >= 2, 'recorded as ordinary mutations');
  }));

  await test('CANDIDATE: parallel children get separate workspaces from the SAME base; neither sees the other', async () => {
    if (!hasGit) return;
    leases._reset();
    const { root } = repo();
    const app = appFor(root);
    const dirs = [];
    const out = await subagents.run(app, [impl({ writeScope: ['backend/**'] }), impl({ writeScope: ['frontend/**'] })], {
      mode: 'parallel',
      runner: async ({ contract, session }) => {
        dirs.push(session.cwd);
        const f = contract.writeScope[0].startsWith('backend') ? ['backend', 'api.js'] : ['frontend', 'ui.js'];
        fs.writeFileSync(path.join(session.cwd, ...f), `// ${f[0]} done\n`);
        await new Promise((r) => setTimeout(r, 30));
        assert.ok(!fs.readFileSync(path.join(session.cwd, f[0] === 'backend' ? 'frontend' : 'backend', f[0] === 'backend' ? 'ui.js' : 'api.js'), 'utf8').startsWith('//'), 'isolated from the sibling');
        return { text: 'ok', stopReason: 'end', mutations: [] };
      },
    });
    assert.ok(out.ok);
    assert.strictEqual(new Set(dirs).size, 2);
    assert.deepStrictEqual(out.results.map((r) => r.candidate.files.map((f) => f.path)), [['backend/api.js'], ['frontend/ui.js']]);
    assert.strictEqual(fs.readFileSync(path.join(root, 'backend', 'api.js'), 'utf8'), 'module.exports = 1;\n');
    // Each kept for its own candidate's resolution; rejected here, then removed.
    for (const r of out.results) assert.ok(cands.reject(app, r.candidate.id, 'test').ok);
    for (const d of dirs) assert.ok(!fs.existsSync(d));
  });

  await test('CANDIDATE: the child\'s work order is baselined IN ITS WORKSPACE — a line-ending checkout is not "stale" (found live)', async () => {
    if (!hasGit) return;
    leases._reset();
    const { root, g } = repo();
    g('config', 'core.autocrlf', 'true');    // the worktree checks out CRLF; the canonical file is LF
    const app = appFor(root);
    let result = null;
    const out = await subagents.run(app, [impl({ writeScope: ['backend/api.js'] })], {
      mode: 'pipeline',
      runner: async ({ session, order }) => {
        // THE REAL DOOR the turn loop uses (toolstep.run): evidence, receipts, the work-order guard.
        const step = require('../../src/toolstep');
        const toolCtx = { cwd: session.cwd, session, workOrder: order, app };
        await step.run({ id: 'r1', name: 'read_file', input: { path: 'backend/api.js' } }, { session, evidence: session.evidence, toolCtx });
        ({ result } = await step.run({ id: 'w1', name: 'write_file', input: { path: 'backend/api.js', content: 'module.exports = 7;\n' } }, { session, evidence: session.evidence, toolCtx }));
        return { text: 'done', stopReason: 'end', mutations: [] };
      },
    });
    assert.ok(!result.isError, `the child's own write went through: ${result.output}`);
    assert.deepStrictEqual(out.results[0].candidate.files.map((f) => f.path), ['backend/api.js']);
    // AND INTEGRATION KEEPS THE CANONICAL LINE ENDINGS (the checkout was CRLF).
    const r = await cands.integrate({ app, session: app.session, cwd: root, checkpoints: null, turnId: 't' }, out.results[0].candidate.id);
    assert.deepStrictEqual(r.done, ['backend/api.js'], JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(path.join(root, 'backend', 'api.js'), 'utf8'), 'module.exports = 7;\n', 'LF stays LF');
  });

  await test('CANDIDATE: a pipeline PAUSES after a stage that built something — the next stage never runs on unmerged state', async () => {
    if (!hasGit) return;
    leases._reset();
    const { root } = repo();
    const app = appFor(root);
    const ran = [];
    const out = await subagents.run(app, [
      impl({ role: 'FOUNDATION', writeScope: ['backend/**'] }),
      impl({ writeScope: ['frontend/**'] }),
    ], {
      mode: 'pipeline',
      runner: async ({ contract, session }) => {
        ran.push(contract.role);
        fs.writeFileSync(path.join(session.cwd, 'backend', 'iface.js'), 'exports.api = 1;\n');
        return { text: 'interfaces laid', stopReason: 'end', mutations: [] };
      },
    });
    assert.deepStrictEqual(ran, ['FOUNDATION']);
    assert.strictEqual(out.paused, true);
    assert.ok(out.ok, 'paused is not a failure');
    assert.match(subagents.report(out), /PIPELINE PAUSED after stage 1[\s\S]*IMPLEMENTER — NOT RUN \(waiting for the candidate above to be integrated\)/);
  });

  await test('CANDIDATE: a non-git project is isolated by a snapshot copy; a VERIFIER\'s artefacts are discarded, never integrated', async () => {
    leases._reset();
    const root = tmpdir('cand-snap-');
    fs.writeFileSync(path.join(root, 'a.js'), 'x\n');
    fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep\n');
    const app = appFor(root);
    const out = await subagents.run(app, [
      { role: 'VERIFIER', objective: 'run tests', readScope: ['**'], writeScope: [], expectedOutput: 'pass/fail', verification: 'node -e 1', completion: 'ran' },
    ], {
      mode: 'pipeline',
      runner: async ({ session }) => {
        assert.notStrictEqual(path.resolve(session.cwd), path.resolve(root));
        assert.ok(fs.existsSync(path.join(session.cwd, 'node_modules', 'dep', 'index.js')), 'dependencies are linked in');
        fs.writeFileSync(path.join(session.cwd, 'coverage.json'), '{}');
        return { text: 'tests pass', stopReason: 'end', mutations: [] };
      },
    });
    const c = out.results[0].candidate;
    assert.deepStrictEqual(c.files, [], 'a read-only role builds nothing');
    assert.deepStrictEqual(c.discarded, ['coverage.json']);
    assert.ok(!fs.existsSync(path.join(root, 'coverage.json')));
    assert.ok(fs.existsSync(path.join(root, 'node_modules', 'dep', 'index.js')), 'removing the snapshot never followed the link into the real node_modules');
  });
};
