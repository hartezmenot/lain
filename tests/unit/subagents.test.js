'use strict';

/** §58–64, §67–72 — bounded subagents, write leases, partition, pipelines, A/B. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, tmpdir } = require('../helpers');
const leases = require('../../src/leases');
const subagents = require('../../src/subagents');
const { Session } = require('../../src/session');
const { AgentJobs } = require('../../src/agentjob');

function fakeApp(root) {
  const session = new Session({ cwd: root });
  return { session, cfg: {}, jobs: new AgentJobs(), ui: { enabled: false } };
}

const good = (over = {}) => ({
  role: 'IMPLEMENTER', objective: 'wire the retry owner', readScope: ['src/retry/**'], writeScope: ['src/retry/**'],
  expectedOutput: 'the change', verification: 'npm test -- retry', completion: 'retry tests pass', ...over,
});

module.exports = async function () {
  await test('LEASE: overlapping write ownership is refused; independent files are not', () => {
    leases._reset();
    assert.ok(leases.acquire('bg#1', ['src/a.js', 'src/b.js'], 'bg #1').ok);
    const clash = leases.acquire('sub#2', ['src/**'], 'sub #2');
    assert.strictEqual(clash.ok, false);
    assert.ok(leases.acquire('sub#3', ['src/c.js', 'lib/**'], 'sub #3').ok);
    assert.strictEqual(leases.check(null, 'src/a.js').ok, false, 'the foreground cannot write a leased file');
    assert.strictEqual(leases.check(null, 'src/d.js').ok, true, 'an independent file is free');
    assert.strictEqual(leases.check('bg#1', 'src/a.js').ok, true, 'the holder writes its own lease');
    leases.release('bg#1');
    assert.strictEqual(leases.check(null, 'src/a.js').ok, true);
    leases._reset();
  });

  await test('LEASE: the tool door refuses a foreground write into a leased file', async () => {
    leases._reset();
    const root = tmpdir('lease-door-');
    fs.writeFileSync(path.join(root, 'owned.js'), 'x');
    leases.acquire('bg#9', ['owned.js'], 'background #9');
    const r = await require('../../src/tools').execute('write_file', { path: 'owned.js', content: 'y' }, { cwd: root, session: new Session({ cwd: root }) });
    assert.ok(r.denied && /LEASED/.test(r.output), r.output);
    assert.strictEqual(fs.readFileSync(path.join(root, 'owned.js'), 'utf8'), 'x');
    leases._reset();
  });

  await test('SUBAGENT: a contract must be complete and bounded', () => {
    assert.ok(subagents.validate(good()).ok);
    assert.match(subagents.validate(good({ readScope: [] })).why, /readScope/);
    assert.match(subagents.validate(good({ writeScope: ['**'] })).why, /whole project/);
    assert.match(subagents.validate(good({ role: 'SCOUT' })).why, /read-only/);
    assert.ok(subagents.validate(good({ role: 'SCOUT', writeScope: [] })).ok);
    assert.match(subagents.validate(good({ verification: '' })).why, /verification/);
    assert.match(subagents.validate(good({ role: 'WIZARD' })).why, /role/);
  });

  await test('SUBAGENT: parallel runs need disjoint write ownership', () => {
    const a = subagents.validate(good({ writeScope: ['backend/auth/**'] })).contract;
    const b = subagents.validate(good({ writeScope: ['frontend/auth/**'] })).contract;
    const c = subagents.validate(good({ writeScope: ['backend/**'] })).contract;
    assert.ok(subagents.partition([a, b]).ok);
    assert.strictEqual(subagents.partition([a, c]).ok, false);
  });

  await test('SUBAGENT: each runs in a FRESH session with only its brief — never the parent conversation', async () => {
    const root = tmpdir('sub-fresh-');
    const app = fakeApp(root);
    app.session.messages.push({ role: 'user', content: 'SECRET PARENT CONTEXT' });
    const seen = [];
    const out = await subagents.run(app, [
      { ...good({ role: 'SCOUT', writeScope: [] }), objective: 'map retry ownership' },
      good(),
      { ...good({ role: 'VERIFIER', writeScope: [] }), objective: 'run retry tests' },
    ], {
      mode: 'pipeline',
      runner: async ({ contract, session, order, brief }) => {
        seen.push({ role: contract.role, messages: session.messages.length, brief, bounded: order.bounded, holder: order.leaseHolder, writeScope: [...order.writeScope] });
        return { text: `${contract.role} OUTPUT`, toolCalls: 1, mutations: [] };
      },
    });
    assert.ok(out.ok);
    assert.deepStrictEqual(seen.map((s) => s.role), ['SCOUT', 'IMPLEMENTER', 'VERIFIER']);
    for (const s of seen) {
      assert.strictEqual(s.messages, 0, 'no parent messages copied');
      assert.ok(!/SECRET PARENT CONTEXT/.test(s.brief));
      assert.strictEqual(s.bounded, true);
    }
    assert.match(seen[1].brief, /From SCOUT \(stage 1\):\nSCOUT OUTPUT/, 'the staircase: stage 2 gets stage 1\'s output');
    assert.match(seen[2].brief, /IMPLEMENTER OUTPUT/);
    assert.deepStrictEqual(seen[0].writeScope, [], 'a SCOUT holds no write scope');
    assert.deepStrictEqual(leases.all(), [], 'every lease released');
    assert.ok(app.jobs.all().every((j) => j.kind === 'subagent' && j.state === 'SUCCEEDED'));
  });

  await test('SUBAGENT: a subagent cannot delegate further', async () => {
    const r = await require('../../src/tools').execute('delegate', { agents: [good()] }, { cwd: '.', workOrder: { bounded: true }, app: {} });
    assert.ok(r.denied);
  });

  const hasGit = spawnSync('git', ['--version']).status === 0;
  await test('A/B: isolated worktrees, one verification contract, the passing candidate wins, integrated, verified, cleaned up', async () => {
    if (!hasGit) { process.stdout.write('    (git not available — UNSUPPORTED here)\n'); return; }
    const root = tmpdir('ab-');
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    fs.writeFileSync(path.join(root, 'retry.js'), 'module.exports = (n) => n * 100;\n');
    fs.writeFileSync(path.join(root, 'check.js'), "if (require('./retry')(2) !== 400) { console.error('FAIL'); process.exit(1); } console.log('PASS');\n");
    g('add', '.'); g('commit', '-qm', 'base');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'uncommitted work is carried into both candidates\n');
    const app = fakeApp(root);
    const worktrees = [];
    const out = await require('../../src/abtest').run(app, {
      problem: 'retry delay must double', verifyCommand: 'node check.js',
      candidates: [{ approach: 'wrong: add' }, { approach: 'right: power of two' }],
      runCandidate: async (c) => {
        worktrees.push(c.dir);
        assert.ok(fs.existsSync(path.join(c.dir, 'notes.txt')), 'the candidate starts from the exact working state');
        fs.writeFileSync(path.join(c.dir, 'retry.js'), c.label === 'A' ? 'module.exports = (n) => n + 100;\n' : 'module.exports = (n) => 100 * 2 ** n;\n');
        return { ok: true };
      },
    });
    assert.ok(out.ok, out.why);
    assert.strictEqual(out.record.selected, 'B');
    assert.match(out.record.reason, /B passes/);
    assert.match(fs.readFileSync(path.join(root, 'retry.js'), 'utf8'), /2 \*\* n/, 'the winner is in the canonical tree');
    assert.ok(out.canonical.ok, 'and verified there');
    for (const w of worktrees) assert.ok(!fs.existsSync(w), `worktree ${w} deleted`);
    assert.ok(!/lain-ab-/.test(g('worktree', 'list').stdout), 'no worktree registered');
    assert.strictEqual(g('branch', '--list').stdout.trim().split('\n').length, 1, 'no temporary branch');
    assert.strictEqual(app.session.decisions.slice(-1)[0].selected, 'B', 'one small decision record survives');
  });

  await test('A/B: when both pass and nothing decides it, the person chooses; with no choice nothing is integrated', async () => {
    const abtest = require('../../src/abtest');
    const a = { ran: true, verify: { ok: true, ms: 100 }, change: { lines: 4 }, command: 'x' };
    const b = { ran: true, verify: { ok: true, ms: 110 }, change: { lines: 5 }, command: 'x' };
    assert.strictEqual(abtest.select(a, b).subjective, true);
    assert.strictEqual(abtest.select(a, { ...b, change: { lines: 40 } }).winner, 'A');
    assert.strictEqual(abtest.select({ ...a, verify: { ok: false, code: 1 } }, b).winner, 'B');
  });

  await test('SUBAGENT HANDOFF: a worker whose turn did not END is FAILED, and the report names what never ran', async () => {
    // Two defects closed together: (1) any returned record was DONE — a worker cut off by a stalled
    // stream handed its partial text up as a result; (2) a pipeline stopped at stage 2 of 3 reported
    // "1/2 completed" and never mentioned the VERIFIER that did not run.
    leases._reset();
    const app = fakeApp(tmpdir('sub-handoff-'));
    const out = await subagents.run(app, [
      { ...good({ role: 'SCOUT', writeScope: [] }), objective: 'map the failures' },
      good(),
      { ...good({ role: 'VERIFIER', writeScope: [] }), objective: 'run the suite' },
    ], {
      mode: 'pipeline',
      runner: async ({ contract }) => (contract.role === 'IMPLEMENTER'
        ? { text: 'Writing the fix now', stopReason: 'provider', providerFailure: { message: 'stream inactive for 180s' }, mutations: ['src/retry/a.js'] }
        : { text: `${contract.role} OUTPUT`, stopReason: 'end', mutations: [] }),
    });
    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(out.results.map((r) => r.ok), [true, false]);
    assert.deepStrictEqual(out.remaining.map((c) => c.role), ['VERIFIER']);
    const r = subagents.report(out);
    assert.match(r, /1\/3 completed · 1 failed · 1 not run/);
    assert.match(r, /IMPLEMENTER — FAILED · changed src\/retry\/a\.js/, 'what it changed before failing is still reported');
    assert.match(r, /its turn ended provider \(stream inactive for 180s\)/);
    assert.match(r, /VERIFIER — NOT RUN/);
    assert.match(r, /HANDOFF/);
    assert.ok(app.jobs.all().some((j) => j.state === 'FAILED'), 'the job registry agrees');
    // A worker that ends naturally but states a blocker did not finish either.
    const blocked = await subagents.run(fakeApp(tmpdir('sub-blocked-')), [good()], {
      mode: 'pipeline', runner: async () => ({ text: 'Blocked: I cannot access src/retry — permission denied.', stopReason: 'end', mutations: [] }),
    });
    assert.strictEqual(blocked.ok, false);
    assert.match(blocked.results[0].why, /stated a blocker/);
  });
};
