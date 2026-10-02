'use strict';

/**
 * THE PERSONAL ASSISTANT — one Core task store, a scheduler with no model,
 * deterministic intents, delivery receipts.
 *
 *   - "remind me …" notifies; "run the tests tomorrow" executes (REMIND ≠ RUN)
 *   - recurring schedules are timezone-aware and computed by Core
 *   - watches fire on deterministic STATE; ZCode's unreported expiry is refused
 *   - quiet hours DEFER (never drop); missed runs follow the task's policy
 *   - one scheduler per LAIN home (lease); tasks survive a restart
 *   - a Telegram message creates the SAME task as the desktop; channel scopes
 *   - self-knowledge questions are answered without a model
 * Fakes only: delivery functions are injected; no network, no model.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const store = require('../../src/assistant/store');
  const schedule = require('../../src/assistant/schedule');
  const intent = require('../../src/assistant/intent');
  const scheduler = require('../../src/assistant/scheduler');
  const delivery = require('../../src/assistant/delivery');
  const { App } = require('../../src/app');
  fs.rmSync(store.dir(), { recursive: true, force: true });
  const cwd = tmpdir('asst-');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node t.js' } }));
  fs.writeFileSync(path.join(cwd, 't.js'), "console.log('not ok 1 - adds'); console.log('1 passed, 1 failed'); process.exit(1);");
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd });
  const sent = [];
  const fakeDeliver = (a, t, text) => delivery.deliver(a, t, text, {
    toDesktopFn: async (_a, task, x) => { sent.push({ target: 'desktop', task: task.id, text: x }); return { state: 'DELIVERED' }; },
    toTelegramFn: async (_a, task, x) => { sent.push({ target: 'telegram', task: task.id, text: x }); return { state: 'FAILED', why: 'Telegram messaging is not running' }; },
  });
  const NOW = new Date(2026, 8, 26, 10, 0, 0).getTime();   // Sat 26 Sep 2026 10:00 local

  await test('PARSING: relative, clock and "tomorrow" times; recurring cadences', () => {
    assert.strictEqual(intent.when('remind me in 2 minutes', NOW), NOW + 120000);
    assert.strictEqual(intent.when('in an hour', NOW), NOW + 3600000);
    const t7 = new Date(intent.when('at 7 pm', NOW)); assert.deepStrictEqual([t7.getDate(), t7.getHours()], [26, 19]);
    const t9 = new Date(intent.when('at 9', NOW)); assert.deepStrictEqual([t9.getDate(), t9.getHours()], [27, 9], 'a passed clock time means tomorrow');
    const tm = new Date(intent.when('tomorrow at 8:30', NOW)); assert.deepStrictEqual([tm.getDate(), tm.getHours(), tm.getMinutes()], [27, 8, 30]);
    assert.deepStrictEqual(intent.cadence('every day at 8'), { every: 'day', at: '08:00' });
    assert.deepStrictEqual(intent.cadence('every friday at 5pm'), { every: 'week', weekday: 5, at: '17:00' });
    assert.deepStrictEqual(intent.cadence('every morning'), { every: 'day', at: '08:00' });
    assert.strictEqual(intent.when('sometime', NOW), null);
  });

  await test('REMIND ≠ RUN: "remind me to run the tests" is a notification; "tomorrow run the tests" executes', async () => {
    const r = await intent.interpret(app, 'Remind me to run the tests in 2 minutes', { now: NOW });
    assert.ok(r && r.task, r && r.text);
    assert.strictEqual(r.task.type, 'reminder');
    assert.strictEqual(r.task.action.kind, 'notify');
    assert.strictEqual(r.task.modelPolicy, 'NO_MODEL');
    assert.strictEqual(r.task.nextRun, NOW + 120000);
    assert.match(r.text, /no model/);
    const s = await intent.interpret(app, 'Tomorrow at 9 run this project’s tests and send failures to Telegram', { now: NOW });
    assert.ok(s && s.task, s && s.text);
    assert.strictEqual(s.task.type, 'scheduled');
    assert.strictEqual(s.task.action.kind, 'run_tests');
    assert.strictEqual(s.task.projectRoot, cwd);
    assert.ok(s.task.delivery.targets.includes('telegram'));
    assert.strictEqual(new Date(s.task.nextRun).getHours(), 9);
    assert.strictEqual(store.normalize({ type: 'reminder', title: 'x', action: { kind: 'run_tests' }, schedule: { at: NOW + 1 } }).ok, false, 'a reminder can never execute');
  });

  await test('RECURRING: "every day at 8 show my model limits" is a NO_MODEL Core summary, next run computed', async () => {
    const r = await intent.interpret(app, 'Every day at 8 show my model limits', { now: NOW });
    assert.strictEqual(r.task.type, 'recurring');
    assert.strictEqual(r.task.action.kind, 'limits_summary');
    assert.strictEqual(r.task.modelPolicy, 'NO_MODEL');
    const n = new Date(r.task.nextRun); assert.deepStrictEqual([n.getDate(), n.getHours()], [27, 8]);
    const after = schedule.next({ ...r.task, runs: 1 }, r.task.nextRun + 1000);
    assert.strictEqual(new Date(after).getDate(), 28);
  });

  await test('WATCHES: a Claude window watch is state-driven; ZCode expiry is refused honestly; no "expected reset" guesses exist (8.3)', async () => {
    const c = await intent.interpret(app, 'Tell me when Claude resets', { now: NOW });
    assert.strictEqual(c.task.watch.kind, 'window_reset');
    const z = await intent.interpret(app, 'Tell me when the ZCode Start Plan expires', { now: NOW });
    assert.ok(!z.task);
    assert.match(z.text, /does not report/);
    const w = require('../../src/assistant/watches');
    assert.ok(!w.KINDS.includes('expected_reset'), 'the Freebuff-only "expected reset" watch is gone');
  });

  await test('SCHEDULER: a due reminder is delivered with receipts; PARTIAL when one target fails; activity is the history', async () => {
    const t = store.create({ type: 'reminder', title: 'stretch', instruction: 'Reminder: stretch', action: { kind: 'notify' }, schedule: { at: NOW + 60000 }, delivery: { targets: ['desktop', 'telegram'] } }, NOW).task;
    sent.length = 0;
    const ran = await scheduler.tick(app, { now: NOW + 60000, deliverFn: fakeDeliver });
    const row = ran.find((x) => x.taskId === t.id);
    assert.ok(row, 'it ran');
    assert.strictEqual(row.deliveryState, 'PARTIAL');
    assert.deepStrictEqual(row.deliveries.map((d) => `${d.target}:${d.state}`), ['desktop:DELIVERED', 'telegram:FAILED']);
    assert.strictEqual(store.get(t.id).state, 'done');
    assert.ok(store.activity({ taskId: t.id }).length >= 1);
    const again = await scheduler.tick(app, { now: NOW + 120000, deliverFn: fakeDeliver });
    assert.ok(!again.some((x) => x.taskId === t.id), 'a reminder fires once');
  });

  await test('RUN TESTS: the project’s own command, as an owned process; failures extracted without a model', async () => {
    const t = store.create({ type: 'scheduled', title: 'tests', action: { kind: 'run_tests' }, projectRoot: cwd, schedule: { at: NOW + 1000 }, delivery: { targets: ['chat'] } }, NOW).task;
    const r = await require('../../src/assistant/actions').run(app, t);
    assert.strictEqual(r.ok, false);
    assert.match(r.text, /FAILED \(exit 1\)/);
    assert.match(r.text, /not ok 1 - adds/);
  });

  await test('QUIET HOURS defer (never drop); an exact reminder still goes through by default', async () => {
    app.cfg.assistant = { quietHours: { enabled: true, start: '22:00', end: '07:00' } };
    const night = new Date(2026, 8, 26, 23, 0, 0).getTime();
    const rec = store.create({ type: 'recurring', title: 'nightly usage', action: { kind: 'usage_summary' }, schedule: { every: 'day', at: '23:00' }, delivery: { targets: ['desktop'] } }, night - 60000).task;
    const rem = store.create({ type: 'reminder', title: 'pills', action: { kind: 'notify' }, schedule: { at: night }, delivery: { targets: ['desktop'] } }, night - 60000).task;
    const ran = await scheduler.tick(app, { now: night, deliverFn: fakeDeliver });
    assert.ok(ran.some((x) => x.taskId === rem.id), 'exact reminder delivered');
    assert.ok(!ran.some((x) => x.taskId === rec.id), 'recurring summary deferred');
    const d = store.get(rec.id).deferredUntil;
    assert.strictEqual(new Date(d).getHours(), 7);
    const later = await scheduler.tick(app, { now: d, deliverFn: fakeDeliver });
    assert.ok(later.some((x) => x.taskId === rec.id), 'delivered when quiet hours end');
    app.cfg.assistant = {};
  });

  await test('MISSED RUNS follow the task’s policy: deliver_late says so; skip records the miss', async () => {
    const a = store.create({ type: 'reminder', title: 'late one', action: { kind: 'notify' }, schedule: { at: NOW + 1000 }, missedPolicy: 'deliver_late', delivery: { targets: ['desktop'] } }, NOW).task;
    const b = store.create({ type: 'recurring', title: 'skip me', action: { kind: 'notify' }, schedule: { every: 'day', at: '10:05' }, missedPolicy: 'skip', delivery: { targets: ['desktop'] } }, NOW).task;
    sent.length = 0;
    await scheduler.tick(app, { now: NOW + 3 * 3600e3, startup: true, deliverFn: fakeDeliver });
    assert.ok(sent.some((x) => x.task === a.id && /^Missed at/.test(x.text)));
    assert.ok(!sent.some((x) => x.task === b.id));
    assert.ok(store.activity({ taskId: b.id }).some((x) => x.outcome === 'missed'));
    assert.ok(store.get(b.id).nextRun > NOW + 3 * 3600e3);
  });

  await test('ONE SCHEDULER per LAIN home: a live lease holder keeps the clock; a dead one is taken over', () => {
    fs.writeFileSync(path.join(store.dir(), 'scheduler.lease'), JSON.stringify({ pid: process.ppid || 1, start: null }));
    const reg = require('../../src/runtimeregistry');
    const sameWas = reg.same;
    reg.same = () => true;
    try { assert.strictEqual(scheduler.acquire().ok, false); } finally { reg.same = sameWas; }
    reg.same = () => false;
    try { assert.strictEqual(scheduler.acquire().ok, true); } finally { reg.same = sameWas; scheduler.release(); }
  });

  await test('RESTART DURABILITY: tasks live in Core’s file, not in a process', () => {
    const n = store.list().length;
    delete require.cache[require.resolve('../../src/assistant/store')];
    assert.strictEqual(require('../../src/assistant/store').list().length, n);
    assert.ok(fs.existsSync(path.join(store.dir(), 'tasks.json')));
  });

  await test('TELEGRAM: "remind me in 1 minute" from the channel is the SAME Core task; scopes gate what a channel may do', async () => {
    const before = store.list().length;
    const r = await intent.interpret(app, 'remind me in 1 minute to call Sam', { from: 'messaging', now: NOW });
    assert.ok(r.task);
    assert.strictEqual(r.task.origin, 'telegram');
    assert.deepStrictEqual(r.task.delivery.targets, ['telegram']);
    assert.strictEqual(store.list().length, before + 1, 'one store');
    const x = await intent.interpret(app, 'tomorrow at 9 run the tests', { from: 'messaging', now: NOW });
    assert.match(x.text, /not allowed from Telegram/);
    app.cfg.bot = { platforms: { telegram: { scopes: { runTests: true } } } };
    const y = await intent.interpret(app, 'tomorrow at 9 run the tests', { from: 'messaging', now: NOW });
    assert.ok(y.task, y.text);
    delete app.cfg.bot;
  });

  await test('DEFAULT DELIVERY and NAMED PROJECTS: "Desktop + Telegram" applies to desktop sentences; an unknown project is said, never guessed', async () => {
    app.cfg.assistant = { defaultTargets: ['desktop', 'telegram'] };
    const r = await intent.interpret(app, 'Remind me at 7 pm to continue LAIN', { now: NOW });
    assert.deepStrictEqual(r.task.delivery.targets.sort(), ['desktop', 'telegram']);
    app.cfg.assistant = {};
    const r2 = await intent.interpret(app, 'Remind me at 7 pm to call home', { now: NOW });
    assert.deepStrictEqual(r2.task.delivery.targets, ['desktop'], 'the default is the desktop');
    const u = await intent.interpret(app, 'Tomorrow run the zzqnope tests and send me failures', { now: NOW });
    assert.ok(!u.task);
    assert.match(u.text, /don't know a project called "zzqnope"/);
  });

  await test('SELF-KNOWLEDGE without a model: listing, ZCode expiry (not reported), local model', async () => {
    const l = await intent.interpret(app, 'what reminders do I have', { now: NOW });
    assert.match(l.text, /call Sam/);
    const z = await intent.interpret(app, 'When does the ZCode Start Plan expire?', { now: NOW });
    assert.match(z.text, /does not report/);
    const m = await intent.interpret(app, 'which local model is loaded', { now: NOW });
    assert.match(m.text, /No local model/);
    assert.strictEqual(intent.match(app, 'what is 2 + 2', { now: NOW }), null, 'everything else goes to the model');
    assert.strictEqual(intent.match(app, 'refactor the reminder module', { now: NOW }), null);
  });

  await test('CORE ROUTE: app.submit answers an assistant sentence as a deterministic Core turn (no provider call)', () => require('../helpers').legacyOnly(async () => {   // LEGACY path only
    const provider = require('../../src/provider');
    const was = provider.chat;
    let called = 0;
    provider.chat = async function* () { called += 1; yield { type: 'text', chunk: 'model' }; };
    try {
      await app.submit('Remind me in 2 minutes to drink water');
    } finally { provider.chat = was; }
    assert.strictEqual(called, 0);
    const last = app.session.turns[app.session.turns.length - 1];
    assert.match(last.text, /Scheduled: drink water/);
    assert.strictEqual(last.steps || 0, 0, 'no model step');
    assert.ok(store.list().some((t) => t.title === 'drink water'));
  }));

  fs.rmSync(store.dir(), { recursive: true, force: true });
};
