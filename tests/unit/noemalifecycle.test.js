'use strict';

/**
 * RESTART AND EXIT WHILE WORK IS IN HAND (packaging pass §I3, §K) — Noema never stops mid-step on its own.
 *
 *   - "after the current checkpoint" waits for the next COMMITTED checkpoint, then stops the turn and saves
 *   - "after the task" waits for the Agent to stop working; "Later" cancels either
 *   - the CLI checks for updates on an unref'd timer — it never keeps Noema alive, and never runs in a checkout
 *   - the Harness routes refuse "restart now" / "exit now" while the Agent works, and say why
 */

const assert = require('assert');
const { test } = require('../helpers');

function fakeApp() {
  const app = { saves: 0, aborted: false, notices: [] };
  app.abort = { abort() { app.aborted = true; app.abort = null; } };
  app.session = { id: 's-life', plan: { steps: [{ id: 'p1', text: 'one', status: 'active' }], completed: [] }, save() { app.saves += 1; } };
  app.render = { notice: (tone, text) => app.notices.push(text) };
  return app;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function () {
  const LC = require('../../src/update/lifecycle');
  const cp = require('../../src/taskcheckpoint');

  await test('LIFECYCLE: "restart after the current checkpoint" waits for the commit, then stops the turn and saves', async () => {
    const saved = process.env.NOEMA_INSTALL_ROOT; delete process.env.NOEMA_INSTALL_ROOT;
    try {
      const app = fakeApp();
      assert.ok(LC.busy(app), 'a running turn is busy');
      const r = LC.arm(app, 'update', 'checkpoint');
      assert.deepStrictEqual(r, { ok: true, when: 'checkpoint' });
      assert.strictEqual(LC.pending(app, 'update'), 'checkpoint');
      await wait(50);
      assert.strictEqual(app.aborted, false, 'nothing happens mid-step');
      cp.commit({ id: 'another', plan: null }, 'someone else', { save: false });
      await wait(50);
      assert.strictEqual(app.aborted, false, 'another session\'s checkpoint is not ours');
      cp.commit(app.session, 'step done', { save: false });
      await wait(600);
      assert.strictEqual(app.aborted, true, 'the turn is stopped at the checkpoint, before the next step');
      assert.ok(app.saves >= 1, 'and the session is saved');
      assert.strictEqual(LC.pending(app, 'update'), null);
    } finally { if (saved) process.env.NOEMA_INSTALL_ROOT = saved; }
  });

  await test('LIFECYCLE: "after the task" is pending while the Agent works; Later cancels; a newer choice replaces an older one', () => {
    const app = fakeApp();
    assert.strictEqual(LC.arm(app, 'update', 'task').when, 'task');
    assert.strictEqual(LC.pending(app, 'update'), 'task');
    LC.arm(app, 'update', 'checkpoint');
    assert.strictEqual(LC.pending(app, 'update'), 'checkpoint', 'replaced');
    LC.cancel(app, 'update');
    assert.strictEqual(LC.pending(app, 'update'), null);
    cp.commit(app.session, 'after cancel', { save: false });
    assert.strictEqual(app.aborted, false, 'a cancelled restart never fires');
    assert.ok(!LC.arm(app, 'update', 'whenever').ok);
  });

  await test('LIFECYCLE: the CLI\'s update timer never runs in a checkout and never keeps the process alive', () => {
    const cli = require('../../src/update/cli');
    const saved = process.env.NOEMA_INSTALL_ROOT; delete process.env.NOEMA_INSTALL_ROOT;
    try { assert.strictEqual(cli.start({}), null, 'a development checkout starts no timer'); } finally { if (saved) process.env.NOEMA_INSTALL_ROOT = saved; }
    const src = require('fs').readFileSync(require.resolve('../../src/update/cli'), 'utf8');
    assert.match(src, /for \(const t of \[first, every\]\) if \(typeof t\.unref === 'function'\) t\.unref\(\);/);
  });

  await test('LIFECYCLE: the Harness refuses "restart now" and "exit now" while the Agent works — the person chooses', async () => {
    const R = require('../../src/harnessapp/updateroutes').ROUTES;
    const app = fakeApp();
    const ex = await R['POST /api/app/exit'](app, { mode: 'now' });
    assert.strictEqual(ex.code, 409);
    assert.strictEqual(ex.body.busy, true);
    assert.match(ex.body.why, /choose how to exit/);
    const up = await R['POST /api/update/restart'](app, { when: 'now' });
    assert.strictEqual(up.code, 409, 'nothing is staged, or the Agent is working — never a silent restart');
    const later = await R['POST /api/update/later'](app, {});
    assert.strictEqual(later.code, 200);
    assert.strictEqual(later.body.update.pendingRestart, null);
  });
};
