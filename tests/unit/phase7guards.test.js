'use strict';

/**
 * PHASE 7 ARCHITECTURE GUARDS (spec §63) — each one a property that must keep
 * holding however the code around it changes.
 *
 *   1  OpenCode runtime-bound models cannot use direct HTTP provider transport
 *   2  ZCode Start Plan cannot bypass the ZCode runtime
 *   3  provider credentials cannot enter LAIN model context (assistant path)
 *   4  assistant tasks live in Core, not in the BOT UI
 *   5  Telegram and desktop use the same AssistantTask
 *   6  simple reminders invoke no model
 *   7  condition watches use deterministic state, never a model
 *   8  a simple (local) BOT chat does not receive project-heavy context
 *   9  scheduler processes are runtime-owned
 *  10  one AssistantTask produces one canonical execution/delivery history
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { test, tmpdir } = require('../helpers');

const SRC = path.join(__dirname, '..', '..', 'src');
function code(file) { return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1'); }
function walk(dir) { const out = []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(p)); else if (e.name.endsWith('.js')) out.push(p); } return out; }

module.exports = async function () {
  const store = require('../../src/assistant/store');
  const intent = require('../../src/assistant/intent');
  const scheduler = require('../../src/assistant/scheduler');
  const provider = require('../../src/provider');
  const { App } = require('../../src/app');
  fs.rmSync(store.dir(), { recursive: true, force: true });
  const cwd = tmpdir('g7-');
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd });
  const NOW = new Date(2026, 8, 26, 10, 0, 0).getTime();
  const quietDeliver = (a, t) => ({ deliveries: t.delivery.targets.map((target) => ({ target, state: 'DELIVERED' })), state: 'DELIVERED' });
  const countModel = async (fn) => {
    const was = provider.chat;
    let n = 0;
    provider.chat = async function* () { n += 1; yield { type: 'text', chunk: 'x' }; };
    try { await fn(); } finally { provider.chat = was; }
    return n;
  };

  await test('1 · OpenCode runtime-bound models cannot use direct HTTP: resolve refuses, and says why', () => {
    const cfg = { connections: { 'lain:opencode.ai': { id: 'lain:opencode.ai', provider: 'opencode', protocol: 'chat', baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'k', models: ['big-pickle'] } }, model: 'big-pickle', connection: 'lain:opencode.ai' };
    const pc = provider.resolve(cfg);
    assert.strictEqual(pc.protocol, null, 'no HTTP protocol for a runtime-bound model');
    assert.match(provider.credentialHint(pc, cfg) || '', /runtime-bound|only inside OpenCode/);
  });

  await test('2 · ZCode Start Plan cannot bypass the ZCode runtime: refused before ZCode starts; no ZCode sign-in material is ever handled', async () => {
    const z = require('../../src/drivers/zcoderun');
    let err = null;
    try { for await (const ev of z.chat({ model: 'zcode/account:zai-start-plan/GLM-5.3-Flash' }, [{ role: 'user', content: 'hi' }], {})) void ev; } catch (e) { err = e; }
    assert.ok(err && /only inside the ZCode app/.test(err.message), err && err.message);
    for (const f of walk(SRC)) {
      const c = code(f);
      assert.ok(!/requestProviderRuntimeHeaders|provider\/updateAccountConfig/.test(c), `${path.relative(SRC, f)} must not play ZCode's desktop host`);
      assert.ok(!/\.zcode[\\/'"][^\n]*(oauth|auth\.json|token)/i.test(c), `${path.relative(SRC, f)} must not read ZCode sign-in files`);
    }
  });

  await test('3 · provider credentials cannot enter the assistant’s model context', async () => {
    const SECRET = 'sk-LAINGUARDSECRET-1234567890abcdef';
    app.cfg.connections = { 'lain:x': { id: 'lain:x', provider: 'x', protocol: 'chat', baseUrl: 'https://x.invalid/v1', apiKey: SECRET, models: ['m'] } };
    const modelWas = app.cfg.model; app.cfg.model = 'm';
    const was = { resolve: provider.resolve, hint: provider.credentialHint, chat: provider.chat };
    let seen = null;
    provider.resolve = () => ({ protocol: 'chat', provider: 'x', connectionId: 'lain:x', model: 'm', apiKey: SECRET });
    provider.credentialHint = () => null;
    provider.chat = async function* (pc, messages) { seen = messages; yield { type: 'text', chunk: 'ok' }; };
    try {
      const t = store.create({ type: 'scheduled', title: 'daily brief', instruction: 'brief me', action: { kind: 'bot_prompt', args: { include: ['limits', 'usage'] } }, modelPolicy: 'BOT_MODEL', schedule: { at: NOW + 1000 }, delivery: { targets: ['chat'] } }, NOW).task;
      const r = await require('../../src/assistant/actions').run(app, t);
      assert.strictEqual(r.ok, true, r.text);
    } finally { Object.assign(provider, { resolve: was.resolve, credentialHint: was.hint, chat: was.chat }); delete app.cfg.connections; app.cfg.model = modelWas; }
    assert.ok(seen, 'the model was asked');
    assert.ok(!JSON.stringify(seen).includes(SECRET), 'no credential in the messages');
    assert.ok(JSON.stringify(seen).length < 6000, 'and the context is minimal, not the full BOT prompt');
  });

  await test('4 · assistant tasks live in Core: the page keeps no schedule state of its own', () => {
    const h = require('../../src/harnesslocation').load();
    if (!h.ok) return;
    // (the page modules moved into folders in the 2026-09-29 rewrite: settings/assistant.js)
    const page = fs.readFileSync(path.join(h.root, 'page', 'settings', 'assistant.js'), 'utf8');
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(page), 'no browser-side store');
    assert.ok(/\/api\/assistant\/state/.test(page), 'it reads Core');
    assert.ok(!/setTimeout\([^)]*nextRun/.test(page), 'the page never decides when a task runs');
    assert.strictEqual(path.dirname(store.dir()), require('../../src/config').configDir());
  });

  await test('5 · Telegram and desktop create the SAME AssistantTask shape in the SAME store', async () => {
    const a = await intent.interpret(app, 'remind me in 5 minutes to stand up', { now: NOW });
    const b = await intent.interpret(app, 'remind me in 5 minutes to stand up', { from: 'messaging', now: NOW });
    assert.deepStrictEqual(Object.keys(a.task).sort(), Object.keys(b.task).sort());
    const ids = store.list().map((t) => t.id);
    assert.ok(ids.includes(a.task.id) && ids.includes(b.task.id));
    assert.deepStrictEqual([a.task.origin, b.task.origin], ['desktop', 'telegram']);
  });

  await test('6 · a simple reminder invokes no model — created, fired and delivered', async () => {
    const n = await countModel(async () => {
      const r = await intent.interpret(app, 'remind me in 2 minutes to drink water', { now: NOW });
      await scheduler.runTask(app, store.get(r.task.id), { now: NOW + 120000, deliverFn: quietDeliver });
    });
    assert.strictEqual(n, 0);
  });

  await test('7 · condition watches evaluate deterministic state, never a model', async () => {
    const w = require('../../src/assistant/watches');
    assert.ok(!/require\(['"]\.\.\/provider['"]\)|modelrequest/.test(code(path.join(SRC, 'assistant', 'watches.js'))));
    const n = await countModel(async () => {
      let m = {};
      for (const kind of ['channel_state']) { const e = await w.evaluate(app, { kind, platform: 'telegram' }, m, NOW); m = e.memo; }
      await w.evaluate(app, { kind: 'window_reset', source: 'claude-code' }, {}, NOW);
    });
    assert.strictEqual(n, 0);
  });

  await test('8 · a simple BOT chat (local model or not) carries no project/focus/tool context', () => require('../helpers').legacyOnly(async () => {   // LEGACY path only
    app.session.thread = 'chat';
    app.session.messages = [];
    const o = require('../../src/jobrunner').turnOptions(app, { session: app.session, signal: null, text: 'what is 2 + 2' });
    assert.strictEqual(o.tools, false);
    assert.strictEqual(o.live, '');
    assert.ok(!/focus|project|workspace/i.test(o.systemPrompt.replace(/files or projects/, '')), 'no project context');
    app.session.thread = 'coding';
  }));

  await test('9 · scheduler processes are runtime-owned: test runs go through the runtime registry; no bare spawn in the assistant', async () => {
    for (const f of fs.readdirSync(path.join(SRC, 'assistant'))) assert.ok(!/child_process/.test(code(path.join(SRC, 'assistant', f))), `${f} spawns nothing directly`);
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    const reg = require('../../src/runtimeregistry');
    const was = reg.spawnRegistered;
    let meta = null;
    reg.spawnRegistered = (cmd, args, opts, m) => { meta = m; const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; setImmediate(() => { c.stdout.emit('data', '3 passed, 0 failed'); c.emit('close', 0); }); return c; };
    try {
      const t = store.create({ type: 'scheduled', title: 't', action: { kind: 'run_tests' }, projectRoot: cwd, schedule: { at: NOW + 1000 }, delivery: { targets: ['chat'] } }, NOW).task;
      const r = await require('../../src/assistant/actions').run(app, t);
      assert.strictEqual(r.ok, true);
    } finally { reg.spawnRegistered = was; }
    assert.strictEqual(meta.purpose, 'assistant:run_tests');
    assert.strictEqual(meta.policy.onOwnerExit, 'stop');
  });

  await test('10 · one task, one canonical history: every run is one activity row; nothing else is written', async () => {
    const t = store.create({ type: 'recurring', title: 'hist', action: { kind: 'notify' }, schedule: { every: 'day', at: '10:30' }, delivery: { targets: ['desktop', 'chat'] } }, NOW).task;
    await scheduler.runTask(app, store.get(t.id), { now: NOW + 1, deliverFn: quietDeliver });
    await scheduler.runTask(app, store.get(t.id), { now: NOW + 2, deliverFn: quietDeliver });
    const rows = store.activity({ taskId: t.id });
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every((r) => r.runId && r.deliveryState === 'DELIVERED' && r.deliveries.length === 2));
    assert.strictEqual(new Set(rows.map((r) => r.runId)).size, 2);
    assert.strictEqual(store.get(t.id).runs, 2);
    const files = fs.readdirSync(store.dir()).filter((f) => !/\.tmp$/.test(f));
    assert.deepStrictEqual(files.filter((f) => !['tasks.json', 'activity.jsonl', 'scheduler.lease'].includes(f)), []);
  });

  fs.rmSync(store.dir(), { recursive: true, force: true });
};
