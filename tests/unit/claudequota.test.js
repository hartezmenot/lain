'use strict';

/**
 * CLAUDE QUOTA AND MODELS (2026-10-02) — asked of Claude Code itself, never generated, never read from a token.
 *
 *   claudecontrol.js runs ONE short Claude Code session in the account's own directory with only SDK control requests:
 *   `initialize` (identity + the live model catalog) and `get_usage` (the plan's 5-hour / 7-day windows).
 *
 *   - two isolated accounts read INDEPENDENT windows; no prompt ran (runs.jsonl stays empty; controls.jsonl shows
 *     only control requests); Noema never opened a `.credentials.json`
 *   - the person's OWN profile works the same way — Claude Code reads its own sign-in
 *   - a reading younger than the TTL is served from the cache with no process; Refresh (force) asks again
 *   - a refresh while the account runs a long request leaves that run alone
 *   - a window past its reset is marked expired; a single-window traffic event merges, never replaces
 *   - the account's model list is the one Claude Code reported, with its effort levels
 *
 * Every Claude here is the fake (tests/fixtures/runtimes/fakeclaude.js): nothing leaves this machine.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const { App } = require('../../src/app');
  const fx = require('../harness/fabricfixtures');
  const ai = require('../../src/accountinstances');
  const ca = require('../../src/drivers/claudeaccount');
  const cc = require('../../src/drivers/claudecode');
  const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };

  const dir = tmpdir('claudeq-');
  const app = new App({ out, interactive: false, cwd: dir });
  await fx.claudeRuntime(app, dir);
  const account = async (email, { limits = null, models = null, signedIn = true } = {}) => {
    const id = `claude-${email.split('@')[0]}${Date.now().toString(36).slice(-4)}`;
    const r = ai.add(app, { driver_id: ca.ID, id, config: { home: ca.homeFor(id), ownership: 'lain' } });
    assert.ok(r.ok, r.why);
    const home = ca.homeFor(id);
    fs.mkdirSync(home, { recursive: true });
    if (signedIn) fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ email, subscriptionType: 'max' }));
    if (limits) fs.writeFileSync(path.join(home, 'fake-limits.json'), JSON.stringify(limits));
    if (models) fs.writeFileSync(path.join(home, 'fake-models.json'), JSON.stringify(models));
    await ai.refresh(app, id);
    return id;
  };
  const lines = (id, f) => { try { return fs.readFileSync(path.join(ca.homeFor(id), f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const pick = (q) => Object.fromEntries(q.limits.windows.map((w) => [w.id, w.usedPercent]));
  /** Every path this process read while fn ran. */
  const readsDuring = async (fn) => {
    const seen = []; const orig = fs.readFileSync;
    fs.readFileSync = function spy(p, ...rest) { seen.push(String(p)); return orig.call(this, p, ...rest); };
    try { return { value: await fn(), seen }; } finally { fs.readFileSync = orig; }
  };

  const A = await account('personal@example.com', { limits: { fiveHour: 0.26, sevenDay: 0.48 }, models: [{ value: 'opus', displayName: 'Opus 9', supportedEffortLevels: ['low', 'high', 'max'] }, { value: 'claude-new-1', displayName: 'New One', supportedEffortLevels: ['low'] }] });
  const B = await account('work@example.com', { limits: { fiveHour: 0.09, sevenDay: 0.33 } });

  await test('CLAUDE QUOTA: two isolated accounts read INDEPENDENT 5-hour and 7-day windows — no prompt ran, no token read by Noema', async () => {
    const { value: [qa, qb], seen } = await readsDuring(async () => [await ai.refreshQuota(app, A, { force: true }), await ai.refreshQuota(app, B, { force: true })]);
    assert.strictEqual(qa.live, true);
    assert.deepStrictEqual(pick(qa), { five_hour: 26, seven_day: 48 });
    assert.deepStrictEqual(pick(qb), { five_hour: 9, seven_day: 33 });
    for (const q of [qa, qb]) for (const w of q.limits.windows) assert.ok(w.resetsAt > Date.now() && w.expired === false, 'each window carries its reset');
    assert.deepStrictEqual([lines(A, 'runs.jsonl').length, lines(B, 'runs.jsonl').length], [0, 0], 'no generation: no prompt ever ran');
    assert.ok(lines(A, 'controls.jsonl').every((c) => c.subtypes.every((s) => ['initialize', 'get_usage'].includes(s))), 'only control requests');
    assert.ok(!seen.some((p) => /\.credentials\.json$/i.test(p)), 'Noema never opened a sign-in file');
    // THE ONE STORE: the fabric shows what remains, per account.
    require('../../src/appcatalog').invalidate(); app._acctMemo = null; app._catMemo = null; app._fabricMemo = null;
    const claude = require('../../src/fabric/index').family(app, 'claude');
    const rem = (id) => Object.fromEntries(claude.accounts.find((a) => a.id === id || a.instanceId === id).quota.map((w) => [w.label, w.remainingPercent]));
    assert.deepStrictEqual(rem(A), { '5-hour': 74, '7-day': 52 });
    assert.deepStrictEqual(rem(B), { '5-hour': 91, '7-day': 67 });
  });

  await test('CLAUDE QUOTA: within the TTL a read is served from the cache with no process; Refresh (force) asks Claude Code again', async () => {
    const before = lines(A, 'controls.jsonl').length;
    const cached = await ai.refreshQuota(app, A);
    assert.strictEqual(cached.cached, true);
    assert.strictEqual(lines(A, 'controls.jsonl').length, before, 'nothing was started');
    fs.writeFileSync(path.join(ca.homeFor(A), 'fake-limits.json'), JSON.stringify({ fiveHour: 0.5, sevenDay: 0.5 }));
    const fresh = await ai.refreshQuota(app, A, { force: true });
    assert.deepStrictEqual(pick(fresh), { five_hour: 50, seven_day: 50 });
    assert.strictEqual(lines(A, 'controls.jsonl').length, before + 1);
  });

  await test('CLAUDE MODELS: the account lists the models ITS Claude Code reported, with their effort levels — nothing from a name', async () => {
    const inst = ai.get(app, A);
    const ids = (inst.models || []).map((m) => m.id);
    assert.ok(ids.includes('claude-code/opus') && ids.includes('claude-code/claude-new-1'), ids.join(','));
    const opus = inst.models.find((m) => m.id === 'claude-code/opus');
    assert.deepStrictEqual(opus.efforts, ['low', 'high', 'max']);
  });

  await test('CLAUDE QUOTA: a refresh while account A runs a long request leaves that run alone — it finishes, as A', async () => {
    const release = path.join(ca.homeFor(A), 'release');
    try { fs.unlinkSync(release); } catch { /* none */ }
    const seen = [];
    const run = (async () => { for await (const ev of cc.agent(app, { prompt: 'HOLD then answer', cwd: dir, instanceId: A })) seen.push(ev); })();
    await new Promise((r) => setTimeout(r, 300));
    const q = await ai.refreshQuota(app, A, { force: true });
    assert.ok(q.ok && q.limits && q.limits.windows.length >= 2);
    fs.writeFileSync(release, '');
    await run;
    const text = seen.filter((e) => e.type === 'text').map((e) => e.chunk).join('');
    assert.match(text, /personal@example\.com/, 'the run finished under its own account');
    assert.ok(!seen.some((e) => e.type === 'error'), 'and was never interrupted');
  });

  await test('CLAUDE QUOTA: the person\'s OWN profile reads its windows the same way — Claude Code reads its own sign-in', async () => {
    const own = path.join(dir, 'own-claude');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, '.credentials.json'), JSON.stringify({ email: 'me@example.com' }));
    fs.writeFileSync(path.join(own, 'fake-limits.json'), JSON.stringify({ fiveHour: 0.1, sevenDay: 0.2 }));
    const r = ai.add(app, { driver_id: ca.ID, config: { home: own, ownership: 'external_native' } });
    assert.ok(r.ok, r.why);
    const { value: q, seen } = await readsDuring(() => ai.refreshQuota(app, r.instance.id, { force: true }));
    assert.deepStrictEqual(pick(q), { five_hour: 10, seven_day: 20 });
    assert.ok(!seen.some((p) => /\.credentials\.json$/i.test(p)), 'its sign-in file was never opened by Noema');
  });

  await test('CLAUDE QUOTA: a profile with no sign-in says why — never an empty bar', async () => {
    const C = await account('nokey@example.com', { signedIn: false });
    const q = await ai.refreshQuota(app, C, { force: true });
    assert.strictEqual(q.limits, null);
    assert.match(q.note, /Not logged in|Quota appears after/);
  });

  await test('CLAUDE QUOTA: a cached window whose reset time has passed is marked expired — not shown as still used', async () => {
    const tid = `${ca.ID}--${A}`;
    const ra = require('../../src/runtimeadapters');
    const t = ra.cachedTelemetry(tid);
    ra.saveTelemetry(tid, { ...t, quotaAskedAt: Date.now(), limits: { ...t.limits, windows: t.limits.windows.map((w) => ({ ...w, resetsAt: Date.now() - 1000 })) } });
    const q = await ai.refreshQuota(app, A);
    assert.ok(q.limits.windows.every((w) => w.expired === true));
  });

  await test('CLAUDE TRAFFIC: a single-window rate_limit_event updates that window and keeps the others', async () => {
    const one = cc.limitsFrom({ rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 600 } });
    assert.deepStrictEqual(one.windows.map((w) => [w.id, w.usedPercent]), [['five_hour', 42]]);
    const merged = cc.mergeLimits({ windows: [{ id: 'five_hour', usedPercent: 10 }, { id: 'seven_day', usedPercent: 80 }] }, one);
    assert.deepStrictEqual(merged.windows.map((w) => [w.id, w.usedPercent]), [['five_hour', 42], ['seven_day', 80]]);
  });
};
