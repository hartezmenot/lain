'use strict';

/**
 * SESSION INTELLIGENCE — global → project → session, the nearest wins, and the
 * gear can say which layer a choice came from. A turn runs with exactly that.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const si = require('../../src/sessionintel');
  const sv = require('../../src/sessionviews');
  const { App } = require('../../src/app');
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('intel-') });
  app.cfg.model = 'global-model';
  app.cfg.effort = 'medium';
  sv.views(app.session).project = { attached: true, attachedAt: new Date().toISOString() };
  const pid = require('../../src/journey').projectId(app.session.cwd);

  await test('INTEL: with nothing chosen, everything is the global default', () => {
    const r = si.resolve(app, app.session);
    assert.strictEqual(r.coding.model, 'global-model'); assert.strictEqual(r.coding.scope, 'global');
    assert.strictEqual(r.reasoning.value, 'medium'); assert.strictEqual(r.reasoning.scope, 'global');
    assert.deepStrictEqual(r.overrides, []);
  });

  await test('INTEL: a project default overrides global; a session choice overrides the project', async () => {
    app.cfg.projects = { [pid]: { coding: { model: 'project-model', connection: 'lain:p' }, effort: 'high' } };
    let r = si.resolve(app, app.session);
    assert.strictEqual(r.coding.model, 'project-model'); assert.strictEqual(r.coding.scope, 'project');
    assert.strictEqual(r.coding.account, 'lain:p');
    assert.strictEqual(r.reasoning.value, 'high'); assert.strictEqual(r.reasoning.scope, 'project');
    const cfg = sv.turnCfg(app, app.session);
    assert.strictEqual(cfg.model, 'project-model', 'the turn runs with the project default');
    assert.strictEqual(cfg.effort, 'high');
    const set = await si.set(app, app.session, { lane: 'reasoning', value: 'low', scope: 'session' });
    assert.ok(set.ok, set.why);
    r = si.resolve(app, app.session);
    assert.strictEqual(r.reasoning.value, 'low'); assert.strictEqual(r.reasoning.scope, 'session');
    assert.ok(r.overrides.includes('Reasoning: session'));
    assert.strictEqual(sv.turnCfg(app, app.session).effort, 'low');
    assert.strictEqual(app.cfg.effort, 'medium', 'the shared process config is not written by a session choice');
    assert.strictEqual(sv.toJSON(app.session).views.effort, 'low', 'kept with the session');
  });

  await test('INTEL: clearing the session override hands back to the project; invalid reasoning is refused', async () => {
    await si.set(app, app.session, { lane: 'reasoning', value: null, scope: 'session' });
    assert.strictEqual(si.resolve(app, app.session).reasoning.scope, 'project');
    assert.strictEqual((await si.set(app, app.session, { lane: 'reasoning', value: 'turbo', scope: 'session' })).ok, false);
  });

  await test('INTEL: a Codex account that is not signed in is listed with its reason and cannot be chosen as a route', async () => {
    const fs = require('fs');
    const ai = require('../../src/accountinstances');
    try { fs.unlinkSync(ai.file()); } catch { /* fresh */ }
    const added = ai.add(app, { driver_id: 'codex', display_name: 'Codex X', config: { home_mode: 'direct' } });
    assert.ok(added.ok);
    const list = si.accountsFor(app, 'project-model');
    const cx = list.find((a) => a.id === added.instance.id);
    assert.ok(cx && cx.usable === false && /not signed in/.test(cx.why), cx && cx.why);
    const r = await si.set(app, app.session, { lane: 'coding', field: 'account', value: added.instance.id, scope: 'session' });
    assert.strictEqual(r.ok, false);
    await ai.disconnect(app, added.instance.id, { logout: false });
  });
};
