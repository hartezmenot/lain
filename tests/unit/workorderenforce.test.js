'use strict';

/**
 * WORK ORDER ENFORCEMENT and the PROPOSAL → LAIN COMMIT boundary.
 *
 * No worker model is involved: a bounded worker is simulated by the tool calls
 * and proposals it would issue. What is proved is that the runtime — not the
 * worker's compliance — decides what may land.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const authority = require('../../src/authority');
const guard = require('../../src/workorderguard');
const proposal = require('../../src/proposal');
const tools = require('../../src/tools');
const { Session } = require('../../src/session');
const { Task } = require('../../src/task');

const AUTH = [
  'function validateSession(token) {',
  '  return Boolean(token);',
  '}',
  '',
  'function refresh(token) {',
  '  return token;',
  '}',
  '',
  'module.exports = { validateSession, refresh };',
  '',
].join('\n');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-wo-'));
  fs.mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'auth', 'session.js'), AUTH);
  fs.writeFileSync(path.join(root, 'src', 'settings.js'), 'module.exports = { debug: false };\n');
  const s = new Session({ cwd: root });
  s.task = new Task('harden session validation');
  return { root, session: s };
}

module.exports = async function () {
  await test('WO G: a proposal computed against baseline A is refused when disk is now B — nothing is overwritten', async () => {
    const { root, session } = project();
    const order = authority.issue(session, { id: 'W52', objective: 'reject empty tokens', writeScope: ['src/auth/session.js'], bounded: true });
    const a = order.baselineFingerprints['src/auth/session.js'];
    assert.ok(a, 'the baseline is measured at issue');

    // Someone else changes the file after the order was issued.
    const B = AUTH.replace('return token;', 'return token.trim();');
    fs.writeFileSync(path.join(root, 'src/auth/session.js'), B);

    const staged = await proposal.stage(order, [{ name: 'apply_patch', input: { path: 'src/auth/session.js', expect: '  return Boolean(token);', replace: '  return typeof token === "string" && token.length > 0;' } }], { cwd: root });
    // The worker staged against the file as IT saw it, which is B. Force the
    // proposal to carry the ORDER's baseline, as a worker holding A would.
    staged.proposal.changes[0].baseFingerprint = a;
    const r = await proposal.commit(order, { ...staged.proposal, claim: 'implemented and tested' }, { cwd: root, session });
    assert.strictEqual(r.verdict, proposal.VERDICT.STALE_WORK_ORDER, r.output);
    assert.strictEqual(fs.readFileSync(path.join(root, 'src/auth/session.js'), 'utf8'), B, 'B was not overwritten');
    assert.strictEqual(order.state, authority.WO_STATE.STALE, 'the ORDER is stale — it needs rebasing');
    assert.strictEqual(session.task.state, 'ACTIVE', 'the parent task is not aborted');
  });

  await test('WO G: the same stale check guards a worker\'s direct write through the tool door', async () => {
    const { root, session } = project();
    const order = authority.issue(session, { id: 'W53', writeScope: ['src/auth/session.js'], bounded: true });
    fs.appendFileSync(path.join(root, 'src/auth/session.js'), '// changed underneath\n');
    const r = await tools.execute('write_file', { path: 'src/auth/session.js', content: 'module.exports = {};\n' }, { cwd: root, session: null, workOrder: order });
    assert.ok(r.isError && /STALE_WORK_ORDER/.test(r.output), r.output);
    assert.ok(fs.readFileSync(path.join(root, 'src/auth/session.js'), 'utf8').includes('changed underneath'));
  });

  await test('WO H: a worker assigned validateSession cannot modify settings.js', async () => {
    const { root, session } = project();
    const order = authority.issue(session, { id: 'W54', writeScope: ['src/auth/session.js::validateSession'], bounded: true });
    const r = await tools.execute('write_file', { path: 'src/settings.js', content: 'module.exports = { debug: true };\n' }, { cwd: root, workOrder: order });
    assert.ok(r.isError && r.denied, r.output);
    assert.match(r.output, /OUTSIDE_WORK_ORDER/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'src/settings.js'), 'utf8'), 'module.exports = { debug: false };\n');
  });

  await test('WO H: inside the right FILE but outside the granted SYMBOL is denied and reverted', async () => {
    const { root, session } = project();
    const order = authority.issue(session, { id: 'W55', writeScope: ['src/auth/session.js::validateSession'], bounded: true });
    const file = path.join(root, 'src/auth/session.js');
    const outside = await tools.execute('apply_patch', { path: 'src/auth/session.js', expect: '  return token;', replace: '  return token + "!";' }, { cwd: root, workOrder: order });
    assert.ok(outside.isError, outside.output);
    assert.match(outside.output, /OUTSIDE_WORK_ORDER/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), AUTH, 'the edit to refresh() did not stand');

    const inside = await tools.execute('apply_patch', { path: 'src/auth/session.js', expect: '  return Boolean(token);', replace: '  return Boolean(token && token.length);' }, { cwd: root, workOrder: order });
    assert.ok(!inside.isError, inside.output);
    assert.ok(fs.readFileSync(file, 'utf8').includes('token && token.length'));
  });

  await test('WO H: a symbol tool naming another symbol is denied before anything runs', async () => {
    const { root, session } = project();
    const order = authority.issue(session, { id: 'W56', writeScope: ['src/auth/session.js::validateSession'], bounded: true });
    const r = await tools.execute('remove_symbol', { path: 'src/auth/session.js', name: 'refresh' }, { cwd: root, workOrder: order });
    assert.ok(r.denied, r.output);
  });

  await test('WO: expansion is requested by the worker and granted only by the user or Noema', () => {
    const { session } = project();
    const order = authority.issue(session, { id: 'W57', writeScope: ['src/auth/session.js'], bounded: true });
    assert.throws(() => order.writeScope.push('src/settings.js'), 'the scope array is frozen');
    const req = guard.requestExpansion(order, { paths: ['src/settings.js'], why: 'the flag lives there' });
    assert.ok(!guard.writeAllowed(order, [path.resolve(session.cwd, 'src/settings.js')], { cwd: session.cwd }).ok, 'a request grants nothing');
    assert.strictEqual(guard.grantExpansion(order, req.id, { by: 'worker' }).ok, false);
    assert.strictEqual(guard.grantExpansion(order, req.id, { by: 'user' }).ok, true);
    assert.ok(guard.writeAllowed(order, [path.resolve(session.cwd, 'src/settings.js')], { cwd: session.cwd }).ok);
  });

  await test('WO: a bounded worker cannot read outside its read scope, nor run shell commands', async () => {
    const { root, session } = project();
    const order = authority.issue(session, { id: 'W58', readScope: ['src/auth/**'], writeScope: ['src/auth/session.js'], bounded: true });
    const read = await tools.execute('read_file', { path: 'src/settings.js' }, { cwd: root, workOrder: order });
    assert.ok(read.denied, read.output);
    const ok = await tools.execute('read_file', { path: 'src/auth/session.js' }, { cwd: root, workOrder: order });
    assert.ok(!ok.isError, ok.output);
    const sh = await tools.execute('run_bash', { command: 'echo hi' }, { cwd: root, workOrder: order });
    assert.ok(sh.denied, sh.output);
  });

  await test('WO: the MAIN executor is not narrowed — an unbounded order, or none, writes anywhere', async () => {
    const { root, session } = project();
    const order = authority.issue(session, { id: 'W59', writeScope: ['src/auth/session.js'] });
    assert.strictEqual(order.bounded, false);
    const r = await tools.execute('write_file', { path: 'src/brand-new.js', content: 'module.exports = 1;\n' }, { cwd: root, workOrder: order });
    assert.ok(!r.isError, r.output);
  });

  await test('PROPOSAL: a staged worker edit is committed by Noema, verified, and only then VERIFIED', async () => {
    const { root, session } = project();
    const order = authority.issue(session, { id: 'W60', writeScope: ['src/auth/session.js::validateSession'], bounded: true });
    const staged = await proposal.stage(order, [{ name: 'replace_symbol', input: { path: 'src/auth/session.js', name: 'validateSession', replacement: 'function validateSession(token) {\n  return typeof token === "string" && token.length > 0;\n}' } }], { cwd: root });
    assert.ok(staged.ok, JSON.stringify(staged));
    assert.strictEqual(fs.readFileSync(path.join(root, 'src/auth/session.js'), 'utf8'), AUTH, 'staging wrote nothing to the project');

    const claimOnly = authority.issue(session, { id: 'W60b', writeScope: ['src/auth/session.js'], bounded: true });
    claimOnly.claim('done, all tests pass');
    assert.notStrictEqual(claimOnly.state, authority.WO_STATE.VERIFIED, 'prose is a claim');

    const r = await proposal.commit(order, { ...staged.proposal, claim: 'validateSession rejects empty tokens' }, {
      cwd: root, session,
      verify: async () => {
        delete require.cache[path.join(root, 'src/auth/session.js')];
        const m = require(path.join(root, 'src/auth/session.js'));
        return { ok: m.validateSession('') === false && m.validateSession('x') === true, evidence: 'FIXTURE_VERIFIED' };
      },
    });
    assert.strictEqual(r.verdict, proposal.VERDICT.COMMITTED, r.output);
    assert.strictEqual(order.state, authority.WO_STATE.VERIFIED);
    assert.ok(order.evidenceReceipts.some((x) => x.kind === 'verified'));
  });

  await test('PROPOSAL: a commit whose verification fails is REVERTED and the order is REJECTED, still open', async () => {
    const { root, session } = project();
    const order = authority.issue(session, { id: 'W61', writeScope: ['src/auth/session.js'], bounded: true });
    const staged = await proposal.stage(order, [{ name: 'apply_patch', input: { path: 'src/auth/session.js', expect: '  return Boolean(token);', replace: '  return true;' } }], { cwd: root });
    const r = await proposal.commit(order, staged.proposal, { cwd: root, session, verify: async () => ({ ok: false, why: 'empty token accepted' }) });
    assert.strictEqual(r.verdict, proposal.VERDICT.REJECTED, r.output);
    assert.strictEqual(fs.readFileSync(path.join(root, 'src/auth/session.js'), 'utf8'), AUTH);
    assert.strictEqual(order.state, authority.WO_STATE.REJECTED);
  });

  await test('PROPOSAL: staging an edit outside scope is denied before a copy is even made', async () => {
    const { root, session } = project();
    const order = authority.issue(session, { id: 'W62', writeScope: ['src/auth/session.js'], bounded: true });
    const staged = await proposal.stage(order, [{ name: 'write_file', input: { path: 'src/settings.js', content: 'x' } }], { cwd: root });
    assert.strictEqual(staged.ok, false);
    assert.match(staged.denied.join(' '), /OUTSIDE_WORK_ORDER/);
  });

  await test('SETTLE: a /bg worker that says "done, tested" with no recorded run stays CLAIMED; a run after its write VERIFIES', async () => {
    const { root, session } = project();
    const order = authority.issue(session, { id: '9', objective: 'tighten validation' });
    const fork = new Session({ cwd: root });
    fork.task = Task.from(session.task.toJSON());
    fork.evidence.observe('read_file', { path: 'src/auth/session.js' }, await tools.execute('read_file', { path: 'src/auth/session.js' }, { cwd: root }));
    await tools.execute('apply_patch', { path: 'src/auth/session.js', expect: '  return Boolean(token);', replace: '  return Boolean(token && token.length);' }, { cwd: root, session: fork });
    const vc = require('../../src/verifycontract');
    const early = proposal.settle(order, fork, { claim: 'Implemented and all tests pass.' });
    assert.strictEqual(early.state, authority.WO_STATE.CLAIMED, 'prose alone is a claim');
    assert.strictEqual(early.kept, 1, 'the kept transaction is receipted');
    vc.record(fork, { command: 'node tests/run.js unit session', ok: true, level: 'TARGETED', persist: false });
    const late = proposal.settle(order, fork);
    assert.strictEqual(late.verified, true);
    assert.strictEqual(order.state, authority.WO_STATE.VERIFIED);
  });

  await test('WO: reassignment to another executor keeps identity, baseline and scope (Opus → generic executor B, simulated)', () => {
    const { session } = project();
    session.task.assignExecutor({ provider: 'anthropic', model: 'claude-opus-5' });
    const order = authority.issue(session, { id: 'W63', writeScope: ['src/auth/session.js'], bounded: true });
    const before = JSON.stringify({ id: order.id, taskId: order.taskId, base: order.baselineFingerprints, scope: order.writeScope });
    order.reassign({ provider: 'fixture', model: 'executor-b' });
    assert.strictEqual(JSON.stringify({ id: order.id, taskId: order.taskId, base: order.baselineFingerprints, scope: order.writeScope }), before);
    const back = authority.WorkOrder.from(order.toJSON());
    assert.strictEqual(back.bounded, true, 'boundedness survives serialisation');
  });
};
