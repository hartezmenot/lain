'use strict';

/**
 * PHASE 7 — the update in LAIN's words, one canonical view for the CLI and the Harness, and the active task never
 * killed: LAIN never restarts itself for an update; "now" is refused while a turn, a background job or a background
 * agent is working.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

function fakeUpdater(state) {
  const real = require('../../src/update/updater');
  const saved = { status: real.status, build: real.build, installRoot: real.installRoot, check: real.check, stage: real.stage, settings: real.settings };
  let st = state;
  Object.assign(real, {
    status: () => st, build: () => ({ version: '1.0.0', channel: 'stable' }), installRoot: () => 'C:\\fake\\LAIN',
    check: async () => st, stage: async () => { st = { state: 'staged', staged: { version: st.available.version } }; return { ok: true, staged: st.staged }; },
    settings: () => ({ auto: false }),
  });
  return { restore: () => Object.assign(real, saved), set: (s) => { st = s; } };
}

module.exports = async function () {
  const ux = require('../../src/update/ux');
  const lc = require('../../src/update/lifecycle');

  await test('WORDS: "↑ LAIN x.y.z ready to update", "Update ready ●", "✓ Update installed · Restart to activate"', () => {
    const f = fakeUpdater({ state: 'available', available: { version: '1.2.3' } });
    try {
      const app = { session: { id: 's' } };
      const a = ux.view(app, { fresh: true });
      assert.strictEqual(a.label, '↑ LAIN 1.2.3 ready to update');
      assert.strictEqual(a.button, 'Update ready ●');
      f.set({ state: 'staged', staged: { version: '1.2.3' } });
      const s = ux.view(app, { fresh: true });
      assert.strictEqual(s.label, '✓ Update installed · Restart to activate');
      assert.deepStrictEqual(s.restartChoices, ['now'], 'nothing is working: now is offered');
      f.set({ state: 'current' });
      assert.strictEqual(ux.view(app, { fresh: true }).label, '');
    } finally { f.restore(); }
  });

  await test('ONE VIEW: the Harness reads exactly what the CLI reads', async () => {
    const f = fakeUpdater({ state: 'staged', staged: { version: '2.0.0' } });
    try {
      const app = { session: { id: 's' } };
      const { ROUTES } = require('../../src/harnessapp/routes');
      const viaState = require('../../src/harnessapp/updateroutes').view(app);
      assert.deepStrictEqual(viaState, ux.view(app, { fresh: true }));
      void ROUTES;
    } finally { f.restore(); }
  });

  await test('AUTOMATIC UPDATES OFF: a staged update is said once and restarts nothing — even when idle', async () => {
    const f = fakeUpdater({ state: 'staged', staged: { version: '3.0.0' } });
    const realPerform = lc.perform;
    let performed = 0;
    lc.perform = async () => { performed += 1; return { ok: true }; };
    try {
      const said = [];
      const app = { session: { id: 's' }, cfg: {}, render: { notice: (lvl, t) => said.push(t) }, _lastInputAt: 0 };
      await require('../../src/update/cli').tick(app);
      await require('../../src/update/cli').tick(app);
      assert.strictEqual(performed, 0, 'no restart because an update exists');
      assert.strictEqual(said.length, 1, 'said once per version');
      assert.match(said[0], /^✓ Update installed · Restart to activate — \/update now/);
      assert.strictEqual(lc.pending(app, 'update'), null, 'and nothing was armed behind the person\'s back');
    } finally { lc.perform = realPerform; f.restore(); }
  });

  await test('THE ACTIVE TASK IS NEVER KILLED: a background job or agent makes LAIN busy; /update now is refused', async () => {
    const f = fakeUpdater({ state: 'staged', staged: { version: '3.1.0' } });
    try {
      const job = { id: 'j1' };
      const app = { session: { id: 's' }, cfg: {}, _jobs: { running: () => [job] }, render: { notice() {} } };
      assert.strictEqual(lc.busy(app), true, 'an in-process background job counts');
      const agentApp = { session: { id: 's' }, jobs: { running: () => [{ primary: false, kind: 'subagent' }] } };
      assert.strictEqual(lc.busy(agentApp), true, 'a background agent counts');
      assert.deepStrictEqual(ux.view(app, { fresh: true }).restartChoices, ['checkpoint', 'task'], '"now" is not offered');
      const r = await require('../../src/update/cli').command(app, 'now');
      assert.match(r, /never stopped for an update/);
      const inst = await require('../../src/update/cli').command(app, 'install');
      assert.match(inst, /^✓ Update installed · Restart to activate/);
      const { ROUTES } = require('../../src/harnessapp/routes');
      const h = await ROUTES['POST /api/update/restart'](app, { when: 'now' });
      assert.strictEqual(h.code, 409, 'the Harness refuses too');
      void tmpdir;
    } finally { f.restore(); }
  });
};
