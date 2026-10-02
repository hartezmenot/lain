'use strict';

/** §9–14, §77 — AUTO/MANUAL/PLAN, FOCUS/FAST, and the gate that enforces them. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const execmode = require('../../src/execmode');
const { Session } = require('../../src/session');

function appFor(session, { answer = null } = {}) {
  return {
    session, cfg: { trustedPaths: [{ path: session.cwd, level: 'TRUSTED' }] }, ui: { enabled: false },
    interaction: answer === null ? null : { ask: async () => answer },
  };
}

module.exports = async function () {
  await test('MODE: Shift+Tab cycles Ask → Accept edits → Plan → Auto and the mode survives save/resume', () => {
    const s = new Session({ cwd: tmpdir('mode-') });
    assert.strictEqual(execmode.of(s), 'AUTO', 'Auto unless the settings say otherwise');
    assert.strictEqual(execmode.cycle(s), 'ASK');
    assert.strictEqual(execmode.cycle(s), 'ACCEPT_EDITS');
    assert.strictEqual(execmode.cycle(s), 'PLAN');
    assert.strictEqual(execmode.set(new Session({ cwd: tmpdir('mode-m-') }), 'MANUAL'), 'ASK', 'the old word still means Ask');
    s.focus = true;
    s.save();
    const back = Session.resume(s.id);
    assert.strictEqual(execmode.of(back), 'PLAN');
    assert.strictEqual(back.focus, true);
    assert.strictEqual(execmode.label(back), 'Plan · FOCUS');
    assert.strictEqual(execmode.cycle(back), 'AUTO');
  });

  await test('MODE: PLAN refuses a write and a command at the tool door, and changes nothing', () => require('../helpers').legacyOnly(async () => {   // LEGACY path only
    const root = tmpdir('plan-');
    const s = new Session({ cwd: root });
    execmode.set(s, 'PLAN');
    const tools = require('../../src/tools');
    const ctx = { cwd: root, session: s, app: appFor(s) };
    const w = await tools.execute('write_file', { path: 'a.txt', content: 'x' }, ctx);
    assert.ok(w.denied && /PLAN_MODE/.test(w.output), w.output);
    assert.ok(!fs.existsSync(path.join(root, 'a.txt')), 'nothing was written');
    const r = await tools.execute('run_bash', { command: 'echo hi' }, ctx);
    assert.ok(r.denied && /PLAN_MODE/.test(r.output));
    fs.writeFileSync(path.join(root, 'b.txt'), 'read me');
    const read = await tools.execute('read_file', { path: 'b.txt' }, ctx);
    assert.match(read.output, /read me/, 'reading is always allowed in PLAN');
  }));

  await test('MODE: a check refused by PLAN is not a failed check — no NOT VERIFIED, not under VERIFY', async () => {
    // Live, 2026-09-18: PLAN refused run_tests; the turn closed "NOT VERIFIED ·
    // npm test failed" with ✗ under VERIFY, for a test that never ran.
    const root = tmpdir('plan-deny-');
    const s = new Session({ cwd: root });
    execmode.set(s, 'PLAN');
    const tools = require('../../src/tools');
    const r = await tools.execute('run_tests', { which: 'project' }, { cwd: root, session: s, app: appFor(s) });
    assert.ok(r.denied, r.output);
    const { Lifecycle } = require('../../src/lifecycle');
    const life = new Lifecycle('fix');
    life.observeTool({ name: 'run_tests', input: {}, output: r.output, isError: true, denied: true });
    assert.strictEqual(life.lastCommand == null ? null : life.lastCommand.ok, null, 'no verdict was recorded');
    const action = require('../../src/describe').actionRecord({ name: 'run_tests', input: {} }, r);
    assert.strictEqual(action.denied, true);
    const sec = require('../../src/ui/turnsections').sections([action], new Set([action]));
    assert.strictEqual(sec.checks.length, 0, 'a refused check is not VERIFY evidence');
    assert.strictEqual(sec.other.length, 1, 'but it stays visible');
  });

  await test('MODE: MANUAL pauses a mutation for the person and honours Deny / Allow once', async () => {
    const root = tmpdir('manual-');
    const s = new Session({ cwd: root });
    execmode.set(s, 'MANUAL');
    const tools = require('../../src/tools');
    const denied = await tools.execute('write_file', { path: 'm.txt', content: 'x' }, { cwd: root, session: s, app: appFor(s, { answer: 'Deny' }) });
    assert.ok(denied.denied && /did not allow write_file/.test(denied.output), denied.output);
    assert.ok(!fs.existsSync(path.join(root, 'm.txt')));
    const ok = await tools.execute('write_file', { path: 'm.txt', content: 'x' }, { cwd: root, session: s, app: appFor(s, { answer: 'Allow once' }) });
    assert.ok(!ok.isError, ok.output);
    assert.ok(fs.existsSync(path.join(root, 'm.txt')));
  });

  await test('MODE: a bounded subagent is governed by its work order, not the session mode', async () => {
    const s = new Session({ cwd: tmpdir('mode-b-') });
    execmode.set(s, 'PLAN');
    const v = await execmode.gate({ session: s, workOrder: { bounded: true } }, 'write_file', { mutates: true }, {});
    assert.strictEqual(v.ok, true);
  });

  await test('MODE: guidance names the mode on the framed tail; FAST never says to skip verification', () => {
    const s = new Session({ cwd: tmpdir('mode-g-') });
    execmode.set(s, 'PLAN');
    s.fast = true;
    const g = execmode.guidance(s);
    assert.match(g, /PLAN/);
    assert.match(g, /no execution progress yet/i);
    assert.match(g, /Never skip required reads, verification or permissions/);
    execmode.set(s, 'AUTO'); s.fast = false;
    assert.strictEqual(execmode.guidance(s), '', 'AUTO with no preferences adds nothing to the request');
  });

  await test('MODE: /plan accept leaves PLAN and marks the plan accepted', async () => {
    const s = new Session({ cwd: tmpdir('mode-a-') });
    execmode.set(s, 'PLAN');
    const { Plan } = require('../../src/plan');
    s.plan = new Plan('x'); s.plan.addSteps(['one', 'two']);
    let submitted = null;
    const app = { session: s, interactive: false, ui: { enabled: false }, render: { write() {} }, submit: async (t, o) => { submitted = { t, o }; return null; } };
    await require('../../src/modecommands').acceptPlan(app, { C: { green: (x) => x, dim: (x) => x } });
    assert.strictEqual(execmode.of(s), 'AUTO');
    assert.ok(s.plan.acceptedAt);
    assert.strictEqual(submitted.o.from, 'plan', 'execution begins as a self-asked turn, captioned, not as the user');
  });
};
