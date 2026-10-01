'use strict';

/**
 * PHASE 8 — CHAT SUPERVISES THE CODING AGENT (supervision.js, runstrategy.js,
 * quotapause.js, workbenchroutes.js).
 *
 *   - Coding requires a project folder; Chat does not; attach / move / remove
 *   - a broad Coding request is offered "Plan in Chat first" / "Implement directly"
 *   - Chat never races a running Agent: status, urgent steer, pending steer
 *   - checkpoints summarise phases; Phased waits; Long Context Phasing continues
 *     unless a blocking finding / proposed delta / failure / quota stops it
 *   - the Long Context warning is honest (a range only from real numbers)
 *   - a profile change mid-run applies at the next checkpoint
 *   - ▶ Continue re-checks now — never waits for the stale predicted reset
 *   - Send to Coding Agent uses the SAME session, seeds the approved plan
 *   - the state persists with the session
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');

module.exports = async function () {
  const { App } = require('../../src/app');
  const sup = require('../../src/supervision');
  const rs = require('../../src/runstrategy');
  const wb = require('../../src/workbench');
  const { ROUTES } = require('../../src/harnessapp/routes');
  const mk = () => new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('wb-') });
  const call = (app, k, body) => ROUTES[`POST ${k}`](app, body || {});
  const seedPlan = (app, steps) => require('../../src/plan').seedFromCore(app.session, { objective: 'fixture', remaining: steps });
  const done = (app, note = 'ok') => { const p = app.session.plan; p.complete(note); p.steps.filter((x) => x.status === 'DONE').forEach((x) => { x.completedAt = x.completedAt || Date.now(); }); };
  const record = (extra = {}) => ({ turnId: 't1', stopReason: 'end', usage: { inputTokens: 1200, outputTokens: 300 }, errors: [], mutations: [], ...extra });

  await test('PROJECT BINDING: Chat needs none; Coding Agent requires a folder; attach enables it; Remove makes the session Unassigned again', async () => {
    const app = mk();
    const det = await call(app, '/api/project/detach');
    assert.strictEqual(det.code, 200, det.body.why);
    assert.strictEqual(det.body.project.attached, false);
    const r = require('../../src/harnessapp/viewroutes').submit(app, { view: 'coding', text: 'rename foo to bar' });
    assert.strictEqual(r.code, 409);
    assert.strictEqual(r.body.projectRequired, true);
    assert.match(r.body.why, /Coding requires a project folder/);
    const dir = tmpdir('wb-proj-');
    const at = await call(app, '/api/project/attach', { path: dir });
    assert.strictEqual(at.code, 200, at.body.why);
    assert.strictEqual(at.body.project.attached, true);
    const other = tmpdir('wb-proj2-');
    const mv = await call(app, '/api/project/attach', { path: other });
    assert.strictEqual(mv.code, 200, `move allowed before any code change: ${mv.body.why}`);
    assert.strictEqual(require('path').resolve(app.session.cwd), require('path').resolve(other));
  });

  await test('PLAN FIRST: a broad Coding request is offered Plan in Chat first / Implement directly — no model call; a small one is not', async () => {
    const app = mk();
    assert.strictEqual(sup.isBroad('Rewrite the MODEL architecture and replace provider routing across all modules'), true);
    assert.strictEqual(sup.isBroad('rename this function'), false);
    assert.strictEqual(sup.isBroad('Run the tests.'), false);
    const r = require('../../src/harnessapp/viewroutes').submit(app, { view: 'coding', text: 'Rewrite the session ownership across all modules' });
    assert.strictEqual(r.body.accepted, false);
    assert.strictEqual(r.body.offer.kind, 'PLAN_FIRST');
    assert.deepStrictEqual(r.body.offer.choices, ['plan', 'direct']);
    assert.ok(!app.abort, 'nothing started');
  });

  await test('SUPERVISION: while the Agent runs, Chat answers status, records pending steers, and asks before an urgent steer', async () => {
    const app = mk();
    seedPlan(app, ['scaffold', 'engine', 'summary']);
    app.session.thread = 'coding';
    app.abort = new AbortController();
    const steers = [];
    app.queueSteer = (t, when) => steers.push([t, when]);
    const vr = require('../../src/harnessapp/viewroutes');
    const st = vr.submit(app, { view: 'chat', text: 'status' });
    assert.strictEqual(st.body.supervised.kind, 'status');
    assert.match(st.body.supervised.text, /Phase 1 of 3 · Implementing/);
    assert.match(st.body.supervised.text, /Waiting for the Agent's next checkpoint/);
    const p = vr.submit(app, { view: 'chat', text: 'also use a shared model cache' });
    assert.strictEqual(p.body.supervised.kind, 'pending');
    assert.strictEqual(sup.pendingSteers(app.session).length, 1);
    assert.strictEqual(steers.length, 0, 'not injected into the running work');
    const u = vr.submit(app, { view: 'chat', text: 'stop changing the loader and use the session owner instead' });
    assert.strictEqual(u.body.supervised.kind, 'urgent');
    const o = u.body.supervised.offer;
    assert.match(o.text, /may consume significantly more usage/);
    const a = await call(app, '/api/workbench/answer', { id: o.id, choice: 'now' });
    assert.strictEqual(a.code, 200, a.body.why);
    assert.deepStrictEqual(steers, [['stop changing the loader and use the session owner instead', 'NOW']], 'applied at the next safe step boundary');
    assert.ok(/do not write new implementation instructions/.test(sup.chatContext(app)), 'Chat is told not to race');
    app.abort = null;
  });

  await test('CHECKPOINT (Phased): a phase summary lands with landed / remaining; pending steers are put to the person; Noema waits', async () => {
    const app = mk();
    seedPlan(app, ['scaffold CLI', 'test discovery', 'summary output']);
    rs.set(app.session, 'PHASED');
    sup.addSteer(app.session, 'use a shared model cache');
    done(app, 'CLI scaffolded');
    const cp = sup.checkpoint(app, record({ mutations: [{ path: 'src/cli.js' }] }));
    assert.ok(!cp.next, 'Phased never continues on its own');
    assert.ok(cp.phase.landed.some((l) => /scaffold CLI/.test(l)));
    assert.deepStrictEqual(cp.phase.remaining, ['2. test discovery', '3. summary output']);
    const kinds = wb.openOffers(app.session).map((o) => o.kind);
    assert.ok(kinds.includes('PENDING_STEERS'));
    assert.ok(kinds.includes('PHASE_REVIEW'));
    assert.ok(kinds.includes('FAST_OFFER'), 'Noema offers Fast at a safe checkpoint (not the model)');
  });

  await test('LONG CONTEXT PHASING: warned first (honest estimate); then continues phase after phase; a blocking finding or proposed delta stops it', async () => {
    const app = mk();
    seedPlan(app, ['one', 'two', 'three', 'four']);
    const req = await call(app, '/api/workbench/strategy', { kind: 'long context phasing' });
    assert.strictEqual(req.body.needsConfirm, true);
    assert.strictEqual(req.body.offer.estimate.known, false);
    assert.strictEqual(req.body.offer.estimate.text, 'High usage expected.', 'no invented percentage without data');
    const c = await call(app, '/api/workbench/answer', { id: req.body.offer.id, choice: 'continue' });
    assert.strictEqual(c.body.strategy.kind, 'LONG_CONTEXT');
    done(app, 'one done');
    const cp1 = sup.checkpoint(app, record());
    assert.ok(cp1.next && /phase 2 — two/.test(cp1.next), cp1.next);
    assert.ok(!wb.openOffers(app.session).some((o) => o.kind === 'PHASE_REVIEW'), 'no question after a trivial phase');
    sup.reportFinding(app.session, { severity: 'major', summary: 'CLI still writes model state through the old path', blocking: true, possible_fix: 'migrate the CLI to sessionintel' });
    done(app, 'two done');
    const cp2 = sup.checkpoint(app, record());
    assert.ok(!cp2.next, 'paused on the blocking finding');
    assert.match(cp2.phase.decision.why, /blocking finding/);
    assert.ok(wb.openOffers(app.session).some((o) => o.kind === 'PHASE_REVIEW'));
    sup.openFindings(app.session).forEach((f) => { f.state = 'RESOLVED'; });
    sup.reportFinding(app.session, { summary: 'another CLI state owner must be migrated', adds_work: 'migrate the CLI state owner' });
    const cp3 = sup.checkpoint(app, record());
    assert.ok(!cp3.next);
    const delta = wb.openOffers(app.session).find((o) => o.kind === 'PLAN_DELTA');
    assert.ok(delta, 'scope expansion goes to the person');
    const stepsBefore = app.session.plan.steps.length;
    await call(app, '/api/workbench/answer', { id: delta.id, choice: 'add' });
    assert.strictEqual(app.session.plan.steps.length, stepsBefore + 1, 'added only on approval');
  });

  await test('ESTIMATE: a range only from observed phases and a provider window; review policy every 3 phases', async () => {
    const app = mk();
    seedPlan(app, ['a', 'b', 'c', 'd', 'e']);
    const w = wb.of(app.session);
    w.phases.push({ usage: { input: 800, output: 200 } }, { usage: { input: 1500, output: 500 } });
    const rw = require('../../src/resetwindows');
    const was = rw.currentForRoute;
    rw.currentForRoute = () => ({ label: '5-hour', usedPercent: 20, observed: { tokens: 10000 } });
    try {
      const e = rs.estimate(app, app.session);
      assert.strictEqual(e.known, true);
      assert.strictEqual(e.text, 'Estimated additional usage: ~10–20% of the current 5-hour window');
    } finally { rw.currentForRoute = was; }
    rs.set(app.session, 'LONG_CONTEXT', 'EVERY_3');
    const r = [1, 2, 3].map(() => rs.afterPhase(app.session, []));
    assert.deepStrictEqual(r.map((x) => x.continue), [true, true, false]);
  });

  await test('PROFILE MID-RUN: Fast is queued while the Agent works and applies at the checkpoint', async () => {
    const app = mk();
    seedPlan(app, ['x', 'y']);
    app.session.thread = 'coding';
    app.abort = new AbortController();
    const q = await call(app, '/api/workbench/profile', { profile: 'fast' });
    assert.strictEqual(q.body.queued, true);
    assert.strictEqual(require('../../src/profile').of(app.session), 'NORMAL', 'the running turn is untouched');
    app.abort = null;
    sup.checkpoint(app, record());
    assert.strictEqual(require('../../src/profile').of(app.session), 'FAST');
    assert.strictEqual(wb.of(app.session).pendingProfile, null);
  });

  await test('QUOTA: a limit pauses the task resumably; ▶ Continue re-checks NOW (ignores the stale 4h prediction) and resumes the same task', async () => {
    const app = mk();
    seedPlan(app, ['p1', 'p2']);
    app.session.thread = 'coding';
    const later = Date.now() + 4 * 3600e3;
    await require('../../src/submitclose').after(app, record({ stopReason: 'rate-limited', providerFailure: { kind: 'RATE_LIMITED', provider: 'anthropic', connectionId: 'lain:x', resumeAt: later } }), 'go');
    assert.strictEqual(wb.of(app.session).quota.state, 'QUOTA_PAUSED');
    assert.strictEqual(app.session.plan.steps.length, 2, 'the plan is kept');
    const cleared = [];
    app.availability = { retry: (id) => cleared.push(id) };
    const sent = [];
    const r = await require('../../src/quotapause').resume(app, { submitFn: async (t) => { sent.push(t); } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.ignoredPrediction, true);
    assert.deepStrictEqual(cleared, ['lain:x']);
    assert.strictEqual(sent.length, 1, 'resumed immediately');
    await new Promise((x) => setImmediate(x));
    assert.strictEqual(wb.of(app.session).quota, null, 'running again');
  });

  await test('SEND TO CODING AGENT: needs a project; then the SAME session runs the approved plan, seeded as its phases', async () => {
    const app = mk();
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('wb-script-'), [{ text: 'Working on step 1.' }]);
    try {
      const plans = require('../../src/planhandoff');
      const d = plans.draft(app.session, { text: 'Implementation plan\n1. Create CLI scaffold\n2. Discover tests\n3. Produce summary', origin: { view: 'chat' } });
      assert.ok(d.ok, d.why);
      await call(app, '/api/project/detach');
      const no = await call(app, '/api/plan/send', { id: d.plan.id });
      assert.strictEqual(no.code, 409);
      assert.strictEqual(no.body.projectRequired, true);
      assert.strictEqual(plans.find(app.session, d.plan.id).state, 'DRAFT', 'nothing accepted without a project');
      await call(app, '/api/project/attach', { path: tmpdir('wb-send-') });
      const id = app.session.id;
      const r = await call(app, '/api/plan/send', { id: d.plan.id });
      assert.strictEqual(r.code, 200, r.body.why);
      assert.strictEqual(app.session.id, id, 'same session');
      assert.strictEqual(plans.find(app.session, d.plan.id).state, 'ACCEPTED');
      assert.deepStrictEqual(app.session.plan.steps.map((x) => x.text), ['Create CLI scaffold', 'Discover tests', 'Produce summary']);
      for (let i = 0; i < 100 && app.abort; i++) await new Promise((x) => setTimeout(x, 30));
    } finally { delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; }
  });

  await test('FINDINGS: report_finding is structured Core state; Discuss switches to Chat with it; Use this fix steers the Agent', async () => {
    const app = mk();
    const tools = require('../../src/tools');
    const out = await tools.execute('report_finding', { severity: 'major', summary: 'Two owners write the model selection', evidence: ['src/cli.js:120'], affected: ['phase 3'], possible_fix: 'keep the project value only as a default', blocking: true }, { session: app.session, cwd: app.session.cwd });
    assert.ok(!out.isError, out.output);
    const f = sup.openFindings(app.session)[0];
    assert.deepStrictEqual([f.severity, f.blocking, f.evidence[0]], ['major', true, 'src/cli.js:120']);
    await call(app, '/api/workbench/finding', { id: f.id, action: 'discuss' });
    assert.strictEqual(require('../../src/sessionviews').views(app.session).active, 'chat');
    assert.match(sup.chatContext(app), /DISCUSS this finding/);
    let steered = null;
    app.session.thread = 'coding'; app.abort = new AbortController();
    app.queueSteer = (t) => { steered = t; };
    const use = await call(app, '/api/workbench/finding', { id: f.id, action: 'use-fix' });
    assert.strictEqual(use.code, 200);
    assert.match(steered, /keep the project value only as a default/);
    app.abort = null;
  });

  await test('PERSISTENCE: strategy, steers, findings and phases survive save and resume', async () => {
    const app = mk();
    rs.set(app.session, 'PHASED', 'EVERY_3');
    sup.addSteer(app.session, 'remember me');
    sup.reportFinding(app.session, { summary: 'kept' });
    app.session.save();
    const { Session } = require('../../src/session');
    const back = Session.resume(app.session.id);
    assert.strictEqual(back.workbench.strategy.kind, 'PHASED');
    assert.strictEqual(back.workbench.steers[0].text, 'remember me');
    assert.strictEqual(back.workbench.findings[0].summary, 'kept');
  });
};
