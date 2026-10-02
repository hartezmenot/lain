'use strict';

/**
 * THE FABRIC'S ACCOUNTING AND PRESENTATION — legacy keys moved and verified,
 * the BOT profile in the prompt, usage by source with local metrics and runtime
 * cost kept apart, filters and facets, LAIN's context efficiency, limits
 * grouped by what sources report, and the MODEL projection's honesty.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const { App } = require('../../src/app');
  const mk = () => new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('fab-') });

  await test('KEYS: legacy plaintext keys are counted masked, moved into the secret store, verified, then replaced by a reference', () => {
    const creds = require('../../src/credentials');
    creds.useBackend(creds.memoryBackend());
    const km = require('../../src/keymigration');
    const app = mk();
    const KEY = 'sk-legacy-0123456789abcdef0123';
    app.cfg.connections = { 'lain:one': { provider: 'openai', apiKey: KEY, baseUrl: 'https://x' }, 'lain:two': { provider: 'zai', credentialRef: 'cred:x:api_key' } };
    const l = km.legacy(app.cfg);
    assert.deepStrictEqual(l.map((x) => x.id), ['lain:one']);
    assert.ok(!JSON.stringify(l).includes(KEY), 'the count shows the shape only');
    const r = km.migrate(app);
    assert.ok(r.ok); assert.strictEqual(r.migrated, 1); assert.strictEqual(r.remaining, 0);
    assert.ok(!JSON.stringify(r).includes(KEY), 'the result never carries a key');
    const entry = app.cfg.connections['lain:one'];
    assert.ok(creds.isRef(entry.credentialRef)); assert.strictEqual(entry.apiKey, undefined);
    assert.strictEqual(creds.resolve(entry.credentialRef), KEY, 'the transport still gets it');
    const onDisk = fs.readFileSync(require('../../src/config').configFile(), 'utf8');
    assert.ok(!onDisk.includes(KEY), 'config.json no longer holds it');
    // A STORE THAT REFUSES leaves the key where it was.
    app.cfg.connections['lain:three'] = { provider: 'x', apiKey: 'sk-another-0123456789abcdef' };
    creds.useBackend({ put: () => ({ ok: false, why: 'store unavailable' }), get: () => null, remove: () => {} });
    const f = km.migrate(app);
    assert.strictEqual(f.ok, false); assert.strictEqual(app.cfg.connections['lain:three'].apiKey, 'sk-another-0123456789abcdef');
    creds.useBackend(null);
  });

  await test('BOT PROFILE: validated, stored in config, and rendered into the stable half of BOT turns only', () => {
    const bp = require('../../src/botprofile');
    const app = mk();
    assert.strictEqual(bp.set(app, { behavior: 'x'.repeat(900) }).ok, false);
    const r = bp.set(app, { name: 'Iwakura', tone: 'concise and direct', language: 'English', behavior: 'Ask before large refactors.' });
    assert.ok(r.ok);
    const prompt = require('../../src/prompt');
    app.session.thread = 'chat';
    const bot = prompt.build({ cwd: app.session.cwd, session: app.session, app, separate: true });
    const text = typeof bot === 'string' ? bot : bot.stable;
    assert.match(text, /# BOT profile/); assert.match(text, /Your name here is Iwakura/); assert.match(text, /concise and direct/);
    app.session.thread = 'coding';
    const agent = prompt.build({ cwd: app.session.cwd, session: app.session, app, separate: true });
    assert.ok(!(typeof agent === 'string' ? agent : agent.stable).includes('BOT profile'), 'the Coding Agent’s prompt is unchanged');
    assert.match(bp.promptBlock(app.cfg), /grant no permission/);
  });

  await test('USAGE: every source on its own row — local speed, runtime cost apart from billed cost, filters and facets', () => {
    const usage = require('../../src/usage');
    const now = Date.now();
    const rows = [
      usage.fromRecord({ id: 'l1', at: now, transport: 'local', runtime: 'llamacpp', connection: 'local:llamacpp', provider: 'llama.cpp', model: 'llamacpp/q', ok: true, ms: 900, project: null, role: 'bot', receipt: { inputTokens: 40, outputTokens: 20, local: { runtime: 'llama.cpp', genTokens: 20, genMs: 200, promptTokens: 40, promptMs: 100, loadMs: 3000 } } }),
      usage.fromRecord({ id: 'c1', at: now, transport: 'runtime', runtime: 'claude-code', connection: 'runtime:claude-code', provider: 'claude-code', model: 'claude-code/opus', ok: true, ms: 4000, role: 'agent', receipt: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheCreationTokens: 10, costUsd: 0.5, costBasis: 'computed by Claude Code' } }),
      usage.fromRecord({ id: 'a1', at: now, transport: 'api', connection: 'lain:ds', provider: 'deepseek', model: 'ds', ok: true, ms: 700, role: 'agent', receipt: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01 } }),
    ];
    const s = usage.sum(rows, {});
    assert.strictEqual(s.local.tokPerSec, 100); assert.strictEqual(s.local.promptTokPerSec, 400); assert.strictEqual(s.local.avgLoadMs, 3000);
    assert.strictEqual(s.cost.actualUsd, 0.01); assert.strictEqual(s.cost.runtimeUsd, 0.5, 'runtime-computed cost kept apart');
    assert.strictEqual(s.cacheRead, 300); assert.strictEqual(s.cacheHits, 1); assert.strictEqual(s.cacheMisses, 1, 'the local row reported no cache and is not counted as a miss');
    const byVia = usage.aggregate(rows, 'via', {}).map((g) => g.key).sort();
    assert.deepStrictEqual(byVia, ['API', 'Local · llama.cpp', 'Runtime · Claude Code']);
    assert.strictEqual(usage.filter(rows, { via: 'Local · llama.cpp' }).length, 1);
    assert.strictEqual(usage.filter(rows, { role: 'agent', provider: 'deepseek' }).length, 1);
    const facets = require('../../src/harnessapp/usageroutes').facets(rows);
    assert.deepStrictEqual(facets.role.map((f) => f.key).sort(), ['agent', 'bot']);
  });

  await test('CONTEXT: LAIN’s own reuse from its FocusPacket records — apart from provider cache; what is not recorded says so', () => {
    const cm = require('../../src/contextmetrics');
    fs.mkdirSync(path.dirname(cm.file()), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(cm.file(), [
      { at: now, chars: 4000, selection: { served: 'hit' }, artifact: { state: 'hit' }, gug: { hit: true }, lsp: { requests: 2, cached: 3 }, projectGraph: { reused: true, scanned: 0 }, fullReadsAvoided: 40 },
      { at: now, chars: 2000, selection: { served: 'miss' }, artifact: { state: 'built' }, lsp: { requests: 4, cached: 0 }, projectGraph: { reused: false, scanned: 12 }, fullReadsAvoided: 10 },
      { at: now - 40 * 864e5, chars: 99999 },
    ].map((x) => JSON.stringify(x)).join('\n'));
    const s = cm.summary({ from: now - 864e5 });
    assert.strictEqual(s.packets, 2); assert.strictEqual(s.avgChars, 3000);
    assert.deepStrictEqual(s.selection, { packets: 2, reused: 1 });
    assert.deepStrictEqual(s.evidence, { packets: 2, reused: 1 });
    assert.deepStrictEqual(s.gug, { lookups: 1, hits: 1 });
    assert.strictEqual(s.lsp.cached, 3); assert.strictEqual(s.fullReadsAvoided, 50);
    assert.strictEqual(s.wholeFileRereads, null, 'not measured — never shown as 0');
  });

  await test('LIMITS: grouped by what sources report — local models have no provider quota, nothing invented', () => {
    const md = require('../../src/local/modeldirs');
    const G = require('../fixtures/runtimes/ggufwrite');
    const dir = tmpdir('lim-models-');
    G.textModel(path.join(dir, 'm-Q4_K_M.gguf'), { arch: 'llama', name: 'Limit Test Model' });
    try { fs.unlinkSync(md.file()); } catch { /* fresh */ }
    md.add(dir);
    const app = mk();
    const g = require('../../src/harnessapp/usageroutes').grouped(app);
    assert.ok(g.local.some((x) => x.name === 'Limit Test Model' && x.via === 'llama.cpp'));
    assert.ok(!require('../../src/accountinstances').list(app).some((v) => /^(local|runtime):/.test(v.id)), 'a local or runtime route is not listed as an API account');
    assert.ok(Array.isArray(g.active) && Array.isArray(g.plans) && Array.isArray(g.none));
    for (const p of g.plans) { assert.ok(p.balance == null && p.expiresAt == null, 'no plan figure is invented'); }
  });

  await test('MODEL: the projection says what each source is — CHAT ONLY, no provider quota, plans without invented balances', async () => {
    const app = mk();
    const f = await require('../../src/harnessapp/fabricroutes').fabric(app);
    assert.deepStrictEqual(f.groups.map((g) => g.id), ['local', 'runtime', 'cloud'], 'no website chat group (retired in Phase 8.1)');
    const local = f.groups[0].rows.find((r) => r.label === 'Limit Test Model');
    assert.ok(local, 'the local model is listed');
    assert.strictEqual(local.usage.text, 'No provider quota'); assert.ok(!local.roles.includes('AGENT'));
    assert.match(local.agent, /not verified/);
    assert.ok(!f.groups.some((g) => g.rows.some((r) => r.source === 'chatgpt-web' || r.source === 'gemini-web')), 'no website source anywhere');
    assert.strictEqual(f.current.bot.via !== 'chatgpt.com', true);
    assert.ok(f.runtimes.every((r) => r.discovery && r.telemetry && r.execution), 'three answers, per runtime');
  });
};
