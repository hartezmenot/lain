'use strict';

/**
 * PHASE Q (2026-10-02) — models, priority and enable/disable as Core state.
 *
 *   MODEL RELEASE   the provider lists A, B → A, B, C: Refresh models (no restart) shows C as NEW; the default and the
 *                   session's model do not move; a later listing without B keeps B as "no longer reported", unroutable
 *   PRIORITY        ordering C, A, B is the fallback order — the resolver chooses C — and it is still C, A, B after the
 *                   process state is rebuilt from disk
 *   DISABLE         C disabled keeps its place (C, A, B) but routing sees A, B; re-enabled, C first again; disabling an
 *                   account a request is using says it applies after that request
 *   CLI             `/model refresh` is the same Core refresh and prints the generation
 *
 * Fakes only (tests/fixtures/codex/fakeappserver.js): no real account, no quota.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const { App } = require('../../src/app');
  const fx = require('../harness/fabricfixtures');
  const ai = require('../../src/accountinstances');
  const F = require('../../src/fabric/index');
  const store = require('../../src/fabric/store');
  const policy = require('../../src/fabric/policy');
  const { ROUTES } = require('../../src/harnessapp/routes');
  const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };
  const call = (app, k, body) => ROUTES[`POST ${k}`](app, body || {});
  const fresh = (app) => { require('../../src/appcatalog').invalidate(); app._acctMemo = null; app._catMemo = null; app._fabricMemo = null; };
  const row = (id, label, efforts = ['low', 'high']) => ({ id, model: id, displayName: label, hidden: false, isDefault: id === 'model-a', supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e, description: '' })) });

  store.reset(); await fx.reset();
  try { fs.unlinkSync(require('../../src/modelcatalog').file()); } catch { /* none */ }
  require('../../src/modelcatalog')._reset();
  const app = new App({ out, interactive: false, cwd: tmpdir('phq-') });
  const [A, B, C] = await fx.codexAccounts(app, [
    { name: 'Personal', email: 'a@example.com', models: [row('model-a', 'Model A'), row('model-b', 'Model B')] },
    { name: 'Work', email: 'b@example.com', models: [row('model-a', 'Model A'), row('model-b', 'Model B')] },
    { name: 'Backup', email: 'c@example.com', models: [row('model-a', 'Model A'), row('model-b', 'Model B')] },
  ]);
  const homeOf = (id) => ai.handle(app, id).layout.home;
  const setModels = (rows) => { for (const x of [A, B, C]) fs.writeFileSync(path.join(homeOf(x.id), 'fake-models.json'), JSON.stringify(rows)); };
  const view = () => { fresh(app); return F.familyView(F.family(app, 'codex'), { models: true }); };

  await test('MODEL RELEASE: A, B → A, B, C — Refresh models (no restart) shows C as NEW; nothing is selected for anyone', async () => {
    fresh(app);
    const before = view();
    assert.deepStrictEqual(before.models.filter((m) => m.isNew).map((m) => m.id), [], 'a first listing is never "everything is new"');
    const defaultBefore = app.cfg.model;
    const laneBefore = JSON.stringify(require('../../src/sessionintel').lane(app, app.session, 'coding'));
    setModels([row('model-a', 'Model A'), row('model-b', 'Model B'), row('model-c', 'Model C', ['low', 'medium', 'high'])]);
    const r = await call(app, '/api/models/refresh', { family: 'codex' });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.ok(r.body.summaries.some((s) => /Codex models updated/.test(s) && /\+ Model C/.test(s)), JSON.stringify(r.body.summaries));
    const v = view();
    const c = v.models.find((m) => /model-c/.test(m.id));
    assert.ok(c && c.isNew === true, JSON.stringify(v.models));
    assert.ok(v.models.filter((m) => !/model-c/.test(m.id)).every((m) => !m.isNew), 'only C is new');
    assert.strictEqual(v.newModels, 1);
    assert.strictEqual(app.cfg.model, defaultBefore, 'the default did not move');
    assert.strictEqual(JSON.stringify(require('../../src/sessionintel').lane(app, app.session, 'coding')), laneBefore, 'the session did not move');
  });

  await test('MODEL REMOVAL: a model the provider stops listing is kept as "no longer reported" — listed, never routed', async () => {
    setModels([row('model-a', 'Model A'), row('model-c', 'Model C', ['low', 'medium', 'high'])]);
    const r = await call(app, '/api/models/refresh', { family: 'codex' });
    assert.ok(r.body.summaries.some((s) => /- Model B/.test(s)), JSON.stringify(r.body.summaries));
    const v = view();
    assert.ok(v.unavailable.some((m) => m.id === 'model-b' && m.status === 'no-longer-reported'), JSON.stringify(v.unavailable));
    assert.ok(!F.family(app, 'codex').byModel.has('model-b'), 'never routable');
    setModels([row('model-a', 'Model A'), row('model-b', 'Model B'), row('model-c', 'Model C', ['low', 'medium', 'high'])]);
    await call(app, '/api/models/refresh', { family: 'codex' });
  });

  const modelId = () => { fresh(app); return F.family(app, 'codex').models.find((m) => /model-a/.test(m.id)).id; };
  const chosen = () => { fresh(app); const r = policy.resolve(app, { family: 'codex', model: modelId() }); return r.account && r.account.id; };

  await test('PRIORITY: C dragged above A ⇒ the order is C, A, B — and automatic fallback chooses C', async () => {
    const r = await call(app, '/api/intel/order', { family: 'codex', order: [C.id, A.id, B.id] });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(view().accounts.map((a) => a.id), [C.id, A.id, B.id]);
    assert.deepStrictEqual(view().accounts.map((a) => a.priority), [1, 2, 3]);
    assert.strictEqual(chosen(), C.id);
  });

  await test('PRIORITY: the order survives a restart (rebuilt from disk)', async () => {
    store.reset();
    const again = new App({ out, interactive: false, cwd: tmpdir('phq2-') });
    again.cfg.accounts = app.cfg.accounts;
    fresh(again);
    assert.deepStrictEqual(F.familyView(F.family(again, 'codex')).accounts.map((a) => a.id), [C.id, A.id, B.id]);
  });

  await test('DISABLE: C keeps its place (C, A, B) but routing sees A, B; re-enabled, C is first again', async () => {
    const r = await call(app, '/api/intel/enable', { id: C.id, enabled: false });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const v = view();
    assert.deepStrictEqual(v.accounts.map((a) => a.id), [C.id, A.id, B.id], 'visual order unchanged');
    assert.deepStrictEqual([v.accounts[0].enabled, v.accounts[0].stateLabel], [false, 'Disabled']);
    assert.deepStrictEqual([v.enabledCount, v.disabledCount], [2, 1]);
    assert.deepStrictEqual(F.eligible(app, 'codex', modelId()).map((x) => x.account.id), [A.id, B.id]);
    assert.strictEqual(chosen(), A.id);
    await call(app, '/api/intel/enable', { id: C.id, enabled: true });
    assert.deepStrictEqual(F.eligible(app, 'codex', modelId()).map((x) => x.account.id), [C.id, A.id, B.id]);
    assert.strictEqual(chosen(), C.id);
  });

  await test('DISABLE: an account a request is working through is disabled AFTER that request — nothing is interrupted', async () => {
    const aw = require('../../src/accountwork');
    const h = aw.begin('codex', A.id, { kind: 'agent' });
    try {
      const r = await call(app, '/api/intel/enable', { id: A.id, enabled: false });
      assert.deepStrictEqual([r.body.afterCurrent, r.body.usedBy], [true, 'Coding Agent']);
    } finally { aw.end(h); await call(app, '/api/intel/enable', { id: A.id, enabled: true }); }
  });

  await test('DISABLE: a disabled account is not polled by Refresh account', async () => {
    await call(app, '/api/intel/enable', { id: B.id, enabled: false });
    const r = await call(app, '/api/intel/refresh', { family: 'codex' });
    assert.ok(r.body.refreshed.some((n) => /disabled — not refreshed/.test(n)), JSON.stringify(r.body.refreshed));
    await call(app, '/api/intel/enable', { id: B.id, enabled: true });
  });

  await test('CLI: /model refresh is the same Core refresh, and says so', async () => {
    const lines = [];
    const r = await require('../../src/modelcommand').refreshModels(app, { family: 'codex', write: (s) => lines.push(s) });
    assert.ok(r && r.ok);
    assert.ok(lines.join('').match(/Up to date|models updated/), lines.join(''));
    assert.ok(/Nothing was selected for you/.test(lines.join('')));
  });

  await fx.reset();
};
