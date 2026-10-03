'use strict';

/**
 * PHASE 8.1 — CLOSING THE CLI PAUSES THE TASK; ▶ CONTINUE IN THE HARNESS RESUMES IT.
 *
 *   - a CLI turn claims the writer with its pid; on the way out it releases it,
 *     and unfinished work is marked `pausedBy: cli-closed` (plan, phase and
 *     findings stay in the session)
 *   - a CLI that died holding the writer (no release ran) is noticed by the
 *     Harness: its pid is gone, so the same pause is recorded
 *   - the Harness status reads "Paused · CLI closed" (spec §111); ▶ Continue takes
 *     the writer, reloads the session from disk and continues the SAME session
 *     and plan — no second session, no transcript replay
 *   - a CLI that is still alive is never taken over by Continue
 *   - (2026-09-29) a CLI that died MID-TURN is `host-crashed`, not closed: the
 *     session loads through crash recovery and the task resumes by itself
 */

const assert = require('assert');
const { test, tmpdir, writeScript } = require('../helpers');

module.exports = async function () {
  const { App } = require('../../src/app');
  const { Session } = require('../../src/session');
  const sh = require('../../src/surfacehandoff');
  const sup = require('../../src/supervision');
  const { ROUTES } = require('../../src/harnessapp/routes');
  const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };
  const call = (app, k, body) => ROUTES[`POST ${k}`](app, body || {});

  const cliWithPlan = () => {
    const cli = new App({ out, interactive: false, cwd: tmpdir('clic-') });
    cli._surfaceName = 'cli';
    require('../../src/plan').seedFromCore(cli.session, { objective: 'fixture', remaining: ['Read the server', 'Wire autostart', 'Add the round-trip test'] });
    cli.session.plan.complete('read it');
    return cli;
  };
  const harnessFor = (id) => {
    const h = new App({ out, interactive: false, cwd: tmpdir('clih-') });
    h._surfaceName = 'harness';
    h.adopt(Session.resume(id), { resumedFrom: id });
    return h;
  };

  await test('CLI CLOSED: release marks unfinished work paused (plan kept); the Harness shows Paused · CLI closed', async () => {
    const cli = cliWithPlan();
    assert.strictEqual(sh.claim(cli).pid, process.pid, 'the CLI holds the writer with its pid');
    cli.session.save();
    const r = sh.release(cli);
    cli.session.save();
    assert.deepStrictEqual([r.writer, r.pausedBy], [null, 'cli-closed']);
    const h = harnessFor(cli.session.id);
    assert.strictEqual(sup.statusLine(h), 'Paused · CLI closed');
    assert.strictEqual(h.session.plan.steps.filter((x) => x.status === 'done').length, 1, 'the plan and its phase are intact');
    assert.ok(sh.check(h).ok, 'the Harness may write: the writer is free');
  });

  await test('CLI KILLED: a writer held by a pid that no longer exists is reaped as the same pause', async () => {
    const cli = cliWithPlan();
    sh.claim(cli);
    cli.session.save();
    require('../../src/sessionlease')._setOwnerPid(cli.session.id, 999999);   // a process that is gone
    const h = harnessFor(cli.session.id);
    const reaped = sh.reapDeadCli(h.session.id);
    assert.deepStrictEqual([reaped.writer, reaped.pausedBy], [null, 'cli-closed']);
    assert.strictEqual(sh.persisted(h.session.id).pausedBy, 'cli-closed');
  });

  await test('CLI DIED MID-TURN: reaped as host-crashed (its in-flight turn is still in the file), not as a closed CLI', async () => {
    const cli = cliWithPlan();
    sh.claim(cli);
    require('../../src/sessionlease')._setOwnerPid(cli.session.id, 999999);
    cli.session.inflight = { turnId: 'tx', pid: 999999, userInput: 'wire autostart', step: 2, tool: null, ledger: [], touchedAt: Date.now() };
    cli.session.save();
    const reaped = sh.reapDeadCli(cli.session.id);
    assert.deepStrictEqual([reaped.writer, reaped.pausedBy], [null, 'host-crashed']);
  });

  await test('▶ CONTINUE: the Harness takes the writer and continues the SAME session and plan; a live CLI is never taken over', async () => {
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('clic-script-'), [{ text: 'Continuing with Wire autostart.' }, { text: 'Done.' }]);
    try {
      const live = cliWithPlan();
      sh.claim(live); live.session.save();
      const hl = harnessFor(live.session.id);
      const refused = await call(hl, '/api/workbench/continue');
      assert.strictEqual(refused.code, 409, 'the CLI is alive: Continue does not steal it');
      assert.match(refused.body.why, /still running|Coding Agent/);

      const cli = cliWithPlan();
      sh.claim(cli); cli.session.save(); sh.release(cli); cli.session.save();
      const id = cli.session.id;
      const h = harnessFor(id);
      await call(h, '/api/project/attach', { path: h.session.cwd });
      const r = await call(h, '/api/workbench/continue');
      assert.strictEqual(r.code, 200, JSON.stringify(r.body).slice(0, 300));
      assert.strictEqual(r.body.resumedFrom, 'cli-closed');
      assert.strictEqual(h.session.id, id, 'the same session — not a new one');
      assert.strictEqual(h.session.plan.steps.length, 3, 'the same plan');
      const lease = sh.persisted(h.session.id);
      assert.strictEqual(lease.writer, 'harness', 'the Harness is now the execution host');
      assert.ok(!lease.pausedBy);
      for (let i = 0; i < 100 && h.abort; i++) await new Promise((x) => setTimeout(x, 30));
    } finally { delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; }
  });
};
