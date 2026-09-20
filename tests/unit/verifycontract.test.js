'use strict';

/**
 * THE VERIFY CONTRACT — selection from impact, escalation on evidence, and a
 * higher-tier failure classified before anybody repairs anything.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const vc = require('../../src/verifycontract');
const authority = require('../../src/authority');
const projectindex = require('../../src/projectindex');
const { Session } = require('../../src/session');
const { Task } = require('../../src/task');
const { Lifecycle } = require('../../src/lifecycle');

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-vc-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  projectindex.refresh(root);
  return root;
}

module.exports = async function () {
  await test('VC: a one-file change nothing imports selects TARGETED — not the global suite', () => {
    const root = repo({ 'src/leaf.js': 'module.exports = 1;\n', 'tests/leaf.test.js': 'require("../src/leaf");\n' });
    const s = vc.selectFor(root, ['src/leaf.js']);
    assert.ok([vc.LEVEL.TARGETED, vc.LEVEL.IMPACT].includes(s.level), s.level);
    assert.ok(s.targets.targeted.includes('tests/leaf.test.js'), 'the test named for the module is the targeted tier');
    assert.deepStrictEqual(vc.planFor(vc.selectFor(root, ['src/lonely.js'])).map((p) => p.level), [vc.LEVEL.TARGETED]);
  });

  await test('VC: a change that other modules import escalates to IMPACT; the runner or manifest to PROJECT; bin/ to RELEASE', () => {
    const root = repo({ 'src/core.js': 'module.exports = 1;\n', 'src/a.js': 'require("./core");\n', 'package.json': '{}' });
    assert.strictEqual(vc.selectFor(root, ['src/core.js']).level, vc.LEVEL.IMPACT);
    assert.strictEqual(vc.selectFor(root, ['package.json']).level, vc.LEVEL.PROJECT);
    assert.strictEqual(vc.selectFor(root, ['bin/lain.js']).level, vc.LEVEL.RELEASE);
    assert.strictEqual(vc.selectFor(root, []).level, vc.LEVEL.UNSPECIFIED, 'nothing changed, nothing selected');
  });

  await test('VC: escalation stops at the first failing tier', async () => {
    const plan = vc.planFor({ level: vc.LEVEL.PROJECT, targets: {} });
    const ran = [];
    const runs = await vc.escalate(plan, async (tier) => { ran.push(tier.level); return { ok: tier.level !== vc.LEVEL.IMPACT }; });
    assert.deepStrictEqual(ran, [vc.LEVEL.TARGETED, vc.LEVEL.IMPACT]);
    assert.strictEqual(runs.length, 2);
  });

  await test('VC I: narrow task passes its focused tests while a foreign broad failure exists → TASK PASS, PROJECT NOT CLEAN, no repair', async () => {
    const changed = ['src/timer.js'];
    const runs = [
      { level: vc.LEVEL.TARGETED, ok: true, failures: [], evidence: vc.EVIDENCE.FIXTURE_VERIFIED },
      { level: vc.LEVEL.PROJECT, ok: false, evidence: vc.EVIDENCE.LOCAL_INTEGRATION_VERIFIED,
        failures: [{ id: 'unit/bot-check.test.js', files: ['tests/unit/bot-check.test.js', 'src/bot/check.js'], message: 'assertion failed' }] },
    ];
    const classify = (f) => vc.classifyFailure(f, { changed, dependents: [], baseline: ['unit/bot-check.test.js'] });
    const settled = vc.settle({ runs, selected: vc.LEVEL.PROJECT, classify });
    assert.strictEqual(settled.taskPassed, true, 'TASK PASSED');
    assert.strictEqual(settled.projectClean, false, 'PROJECT NOT CLEAN');
    assert.strictEqual(settled.releaseReady, false, 'RELEASE NOT READY');
    assert.strictEqual(settled.repairAuthorized.length, 0, 'the foreign failure authorises no repair');
    assert.strictEqual(settled.foreign[0].cause, vc.CAUSE.UNRELATED_PREEXISTING);
  });

  await test('VC: failure classes are decided from evidence, not guessed', () => {
    const ctx = { changed: ['src/a.js'], dependents: ['src/b.js'], baseline: ['old'], concurrent: ['src/c.js'] };
    assert.strictEqual(vc.classifyFailure({ id: 'new', files: ['src/b.js'] }, ctx), vc.CAUSE.CAUSED_BY_CURRENT_TASK);
    assert.strictEqual(vc.classifyFailure({ id: 'old', files: ['src/a.js'] }, ctx), vc.CAUSE.RELEVANT_PREEXISTING);
    assert.strictEqual(vc.classifyFailure({ id: 'old', files: ['src/z.js'] }, ctx), vc.CAUSE.UNRELATED_PREEXISTING);
    assert.strictEqual(vc.classifyFailure({ id: 'x', files: ['src/c.js'] }, ctx), vc.CAUSE.CONCURRENT_FOREIGN);
    assert.strictEqual(vc.classifyFailure({ id: 'y', files: ['src/z.js'], message: 'Error: listen EADDRINUSE :::8080' }, ctx), vc.CAUSE.ENVIRONMENTAL);
    assert.strictEqual(vc.classifyFailure({ id: 'z', files: ['src/q.js'] }, ctx), vc.CAUSE.UNKNOWN_CAUSALITY);
  });

  await test('VC: evidence states never promote a fixture to live, and prose is only CLAIMED', () => {
    assert.strictEqual(vc.evidenceForCommand('node tests/run.js unit'), vc.EVIDENCE.FIXTURE_VERIFIED);
    assert.strictEqual(vc.evidenceForCommand('node tests/run.js integration'), vc.EVIDENCE.LOCAL_INTEGRATION_VERIFIED);
    assert.strictEqual(vc.evidenceForCommand('node tests/run.js smoke'), vc.EVIDENCE.REAL_TTY_VERIFIED);
    assert.strictEqual(vc.evidenceForCommand('node tests/run.js live'), vc.EVIDENCE.LIVE_VERIFIED);
    assert.strictEqual(vc.strongestEvidence([vc.EVIDENCE.CLAIMED]), vc.EVIDENCE.UNVERIFIED, 'a claim does not verify');
    const releaseOnFixtures = vc.settle({
      runs: [vc.LEVEL.TARGETED, vc.LEVEL.IMPACT, vc.LEVEL.SUBSYSTEM, vc.LEVEL.PROJECT, vc.LEVEL.RELEASE]
        .map((level) => ({ level, ok: true, failures: [], evidence: vc.EVIDENCE.FIXTURE_VERIFIED })),
      selected: vc.LEVEL.RELEASE,
    });
    assert.strictEqual(releaseOnFixtures.releaseReady, false, 'fixtures alone never make a release ready');
  });

  await test('VC: the authority projection selects a level from what the task changed', () => {
    const root = repo({ 'src/core.js': 'module.exports = 1;\n', 'src/a.js': 'require("./core");\n' });
    const s = new Session({ cwd: root });
    s.task = new Task('make core faster');
    s.lifecycle = new Lifecycle('make core faster');
    s.lifecycle.evidence.filesChanged.add(path.join(root, 'src/core.js'));
    const v = authority.verifyContract(s);
    assert.strictEqual(v.level, vc.LEVEL.IMPACT);
    assert.strictEqual(v.projectClean, false, 'nothing broad has run, so clean is not claimed');
    vc.record(s, { command: 'node tests/run.js unit core', ok: true, level: v.level });
    assert.strictEqual(authority.verifyContract(s).taskPassed, true);
    assert.strictEqual(authority.verifyContract(s).evidence, vc.EVIDENCE.FIXTURE_VERIFIED);
    const lainstore = require('../../src/lainstore');
    const checks = lainstore.read(root, 'validation', null).checks;
    assert.strictEqual(checks.length, 1, 'the check is durable in .lain/validation');
    assert.strictEqual(require('../../src/freshness').ofRecord(root, checks[0]), 'FRESH');
    fs.appendFileSync(path.join(root, 'src/core.js'), '// edited\n');
    assert.strictEqual(require('../../src/freshness').ofRecord(root, checks[0]), 'STALE', 'the check goes stale when its files move');
  });
};
