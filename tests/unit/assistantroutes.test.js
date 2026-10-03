'use strict';

/**
 * THE ASSISTANT'S ROUTES AND THE RUNTIME CAPABILITY MATRIX.
 *
 *   - /api/assistant/* is a projection of Core's store (no second state)
 *   - a model-backed recurring task is refused until its policy is confirmed
 *   - settings and Telegram scopes validate; edit code / computer stay off
 *   - the capability matrix never says Operational for what was not proven,
 *     and names the boundary for what is unsupported
 */

const assert = require('assert');
const fs = require('fs');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const store = require('../../src/assistant/store');
  const { ROUTES } = require('../../src/harnessapp/routes');
  const { App } = require('../../src/app');
  fs.rmSync(store.dir(), { recursive: true, force: true });
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('ar-') });
  const call = (k, body) => ROUTES[`POST /api/assistant/${k}`](app, body);

  await test('ROUTES: registered, and state is grouped Upcoming / Recurring / Watches / Completed', async () => {
    for (const k of ['state', 'task', 'task/act', 'settings', 'scopes', 'interpret']) assert.ok(ROUTES[`POST /api/assistant/${k}`], k);
    const r = await call('interpret', { text: 'remind me in 10 minutes to check the oven' });
    assert.strictEqual(r.code, 200, r.body.why);
    const s = (await call('state', {})).body;
    assert.strictEqual(s.upcoming.length, 1);
    assert.deepStrictEqual([s.recurring.length, s.watches.length], [0, 0]);
    assert.strictEqual((await call('interpret', { text: 'write me a poem' })).code, 400, 'not understood without a model');
  });

  await test('COST SAFEGUARD: a model-backed recurring task needs its policy confirmed', async () => {
    const task = { type: 'recurring', title: 'brief', instruction: 'brief me', action: { kind: 'bot_prompt' }, modelPolicy: 'BOT_MODEL', schedule: { every: 'day', at: '08:00' }, delivery: { targets: ['desktop'] } };
    const first = await call('task', { task });
    assert.strictEqual(first.code, 409);
    assert.strictEqual(first.body.needsConfirm, true);
    const n = store.list().length;
    const second = await call('task', { task, confirmPolicy: 'BOT_MODEL' });
    assert.strictEqual(second.code, 200, second.body.why);
    assert.strictEqual(store.list().length, n + 1);
    const act = await call('task/act', { id: second.body.task.id, action: 'pause' });
    assert.strictEqual(act.body.recurring.find((t) => t.id === second.body.task.id).state, 'paused');
  });

  await test('SETTINGS validate; Telegram scopes save; edit code and computer are not grantable from the page', async () => {
    assert.strictEqual((await call('settings', { settings: { quietHours: { enabled: true, start: '25:00', end: '07:00' } } })).code, 400);
    const ok = await call('settings', { settings: { quietHours: { enabled: true, start: '22:30', end: '06:45' }, missedPolicy: 'skip', background: false } });
    assert.strictEqual(ok.code, 200);
    assert.deepStrictEqual(app.cfg.assistant.quietHours, { enabled: true, start: '22:30', end: '06:45' });
    assert.strictEqual(app.cfg.assistant.background, false);
    const sc = await call('scopes', { scopes: { runTests: true } });
    assert.strictEqual(sc.body.scopes.runTests, true);
    assert.strictEqual(sc.body.scopes.editCode, false);
    delete app.cfg.assistant; delete app.cfg.bot;
  });

  await test('CAPABILITY MATRIX: eleven cells; nothing Operational without proof; the ZCode boundary named', () => {
    const caps = require('../../src/runtimecaps');
    const exec = { chat: { ok: true, how: 'x' }, agent: { ok: true, how: 'y' } };
    const oc = caps.matrix({ id: 'opencode', kind: 'runtime' }, { installed: true, version: '1' }, { ok: true, models: [] }, exec);
    assert.deepStrictEqual(Object.keys(oc).sort(), [...caps.KEYS].sort());
    assert.strictEqual(oc.execution.level, 'Available', 'a path, not yet proven');
    assert.strictEqual(oc.agent.level, 'Available');
    const proven = caps.matrix({ id: 'opencode', kind: 'runtime' }, { installed: true }, { ok: true, lastRun: { ok: true }, verified: { m: { chat: true, agent: true } } }, exec);
    assert.strictEqual(proven.agent.level, 'Operational');
    assert.strictEqual(proven.limits.level, 'Not reported');
    const z = caps.matrix({ id: 'zcode', kind: 'runtime' }, { installed: true }, { ok: true }, { chat: { ok: false, why: 'none' }, agent: { ok: false, why: 'none' } });
    assert.strictEqual(z.limits.why, 'Balance not reported by ZCode');
    assert.strictEqual(z.execution.level, 'Telemetry');
    const gone = caps.matrix({ id: 'opencode', kind: 'runtime' }, { installed: false, why: 'not on PATH' }, null, exec);
    assert.ok(Object.values(gone).every((c) => c.level === 'Unavailable'));
  });

  await test('USAGE ORIGIN: explicit from the request, derived from the role otherwise, filterable', () => {
    const u = require('../../src/usage');
    assert.ok(u.DIMS.includes('origin'));
    assert.strictEqual(u.fromRecord({ id: 'a', origin: 'recurring', role: 'bot' }).origin, 'Recurring');
    assert.strictEqual(u.fromRecord({ id: 'b', origin: 'telegram', role: 'bot' }).origin, 'Telegram');
    assert.strictEqual(u.fromRecord({ id: 'c', role: 'bot' }).origin, 'BOT');
    assert.strictEqual(u.fromRecord({ id: 'd', transport: 'website' }).origin, 'Interactive Chat');
    assert.strictEqual(u.fromRecord({ id: 'e' }).origin, 'Agent');
    assert.strictEqual(u.keyOf({ role: 'bot' }, 'origin'), 'BOT', 'a receipt written before Origin existed');
    assert.strictEqual(u.filter([{ origin: 'Scheduled' }, { origin: 'BOT' }], { origin: 'Scheduled' }).length, 1);
  });

  fs.rmSync(store.dir(), { recursive: true, force: true });
};
