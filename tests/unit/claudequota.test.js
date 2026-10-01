'use strict';

/**
 * CLAUDE QUOTA (§20, §55 — 2026-09-29).
 *
 * THE AUDIT, pinned: Claude Code has no non-interactive quota command (`claude auth
 * status` is identity and plan; `/usage` needs an interactive session). Anthropic's
 * management endpoint answers it with the account's OAuth token (fabric/quotaread.js,
 * the contract the person's own router verified live). So:
 *
 *   - a LAIN-OWNED account reads its windows LIVE, before any response, and on every
 *     Refresh — no Claude process runs, nothing is spent
 *   - two isolated accounts show INDEPENDENT 5-hour and weekly windows with resets
 *   - a Refresh while one of them is running a long request leaves that run alone
 *   - the person's OWN profile is never read: its windows come with the first
 *     response through LAIN, and it says so
 *   - a window past its reset time is marked expired, never shown as still used
 *
 * Anthropic is a local fake: nothing leaves this machine, and no real token exists.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const { App } = require('../../src/app');
  const fx = require('../harness/fabricfixtures');
  const ai = require('../../src/accountinstances');
  const ca = require('../../src/drivers/claudeaccount');
  const cc = require('../../src/drivers/claudecode');
  const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };

  // ANTHROPIC, FAKED: each token has its own windows; every call is counted.
  const usageOf = { 'tok-personal': { five_hour: 26, seven_day: 48 }, 'tok-work': { five_hour: 9, seven_day: 33 } };
  const calls = [];
  const server = http.createServer((req, res) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    calls.push({ path: req.url, token, beta: req.headers['anthropic-beta'] });
    const u = usageOf[token];
    if (!u) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"invalid token"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/oauth/usage') res.end(JSON.stringify({ five_hour: { utilization: u.five_hour, resets_at: new Date(Date.now() + 2 * 3600e3).toISOString() }, seven_day: { utilization: u.seven_day, resets_at: new Date(Date.now() + 4 * 86400e3).toISOString() }, seven_day_opus: null }));
    else res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = process.env.LAIN_ANTHROPIC_MANAGEMENT_BASE;
  process.env.LAIN_ANTHROPIC_MANAGEMENT_BASE = `http://127.0.0.1:${server.address().port}`;

  const dir = tmpdir('claudeq-');
  const app = new App({ out, interactive: false, cwd: dir });
  await fx.claudeRuntime(app, dir);
  /** A LAIN-owned Claude account whose profile holds Claude Code's own sign-in shape. */
  const account = async (email, token) => {
    const id = `claude-${email.split('@')[0]}${Date.now().toString(36).slice(-4)}`;
    const r = ai.add(app, { driver_id: ca.ID, id, config: { home: ca.homeFor(id), ownership: 'lain' } });
    assert.ok(r.ok, r.why);
    fs.mkdirSync(ca.homeFor(id), { recursive: true });
    fs.writeFileSync(path.join(ca.homeFor(id), '.credentials.json'), JSON.stringify({ email, subscriptionType: 'max', claudeAiOauth: token ? { accessToken: token, refreshToken: `r-${token}`, expiresAt: Date.now() + 3600e3 } : undefined }));
    await ai.refresh(app, id);
    return id;
  };
  const runs = (id) => { try { return fs.readFileSync(path.join(ca.homeFor(id), 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  const pick = (q) => Object.fromEntries(q.limits.windows.map((w) => [w.id, w.usedPercent]));

  try {
    const A = await account('personal@example.com', 'tok-personal');
    const B = await account('work@example.com', 'tok-work');

    await test('CLAUDE QUOTA §55: two isolated accounts read INDEPENDENT 5-hour and weekly windows live — before any response, with no Claude run', async () => {
      const qa = await ai.refreshQuota(app, A);
      const qb = await ai.refreshQuota(app, B);
      assert.strictEqual(qa.live, true);
      assert.deepStrictEqual(pick(qa), { five_hour: 26, seven_day: 48 });
      assert.deepStrictEqual(pick(qb), { five_hour: 9, seven_day: 33 });
      for (const q of [qa, qb]) for (const w of q.limits.windows) assert.ok(w.resetsAt > Date.now() && w.expired === false, 'each window carries its reset');
      assert.deepStrictEqual([runs(A), runs(B)], [0, 0], 'no dummy generation: Claude never ran');
      assert.ok(calls.every((c) => c.path === '/api/oauth/usage' && c.beta === 'oauth-2025-04-20'), 'a management read, nothing else');
      // THE FABRIC SHOWS WHAT REMAINS, per account.
      require('../../src/appcatalog').invalidate(); app._acctMemo = null; app._catMemo = null; app._fabricMemo = null;
      const claude = require('../../src/fabric/index').family(app, 'claude');
      const rem = (id) => Object.fromEntries(claude.accounts.find((a) => a.id === id || a.instanceId === id).quota.map((w) => [w.label, w.remainingPercent]));
      assert.deepStrictEqual(rem(A), { '5-hour': 74, weekly: 52 });
      assert.deepStrictEqual(rem(B), { '5-hour': 91, weekly: 67 });
    });

    await test('CLAUDE QUOTA: a Refresh while account A runs a long request leaves that run alone — it finishes, as A', async () => {
      const release = path.join(ca.homeFor(A), 'release');
      try { fs.unlinkSync(release); } catch { /* none */ }
      const seen = [];
      const run = (async () => { for await (const ev of cc.agent(app, { prompt: 'HOLD then answer', cwd: dir, instanceId: A })) seen.push(ev); })();
      await new Promise((r) => setTimeout(r, 300));
      const cp = require('child_process');
      const orig = cp.spawn; const spawned = [];
      cp.spawn = function spy(...x) { spawned.push(String(x[0])); return orig.apply(this, x); };
      let q;
      try { q = await ai.refreshQuota(app, A); } finally { cp.spawn = orig; }
      assert.deepStrictEqual(spawned, [], 'the refresh started nothing');
      assert.deepStrictEqual(pick(q), { five_hour: 26, seven_day: 48 });
      fs.writeFileSync(release, '');
      await run;
      const text = seen.filter((e) => e.type === 'text').map((e) => e.chunk).join('');
      assert.match(text, /personal@example\.com/, 'the run finished under its own account');
      assert.ok(!seen.some((e) => e.type === 'error'), 'and was never interrupted');
    });

    await test('CLAUDE QUOTA: the person\'s OWN profile is never read — its windows come with the first response through Noema', async () => {
      const own = path.join(dir, 'own-claude');
      fs.mkdirSync(own, { recursive: true });
      fs.writeFileSync(path.join(own, '.credentials.json'), JSON.stringify({ email: 'me@example.com', claudeAiOauth: { accessToken: 'tok-personal', expiresAt: Date.now() + 3600e3 } }));
      const r = ai.add(app, { driver_id: ca.ID, config: { home: own, ownership: 'external_native' } });
      assert.ok(r.ok, r.why);
      const before = calls.length;
      const q = await ai.refreshQuota(app, r.instance.id);
      assert.strictEqual(q.limits, null);
      assert.match(q.note, /your own Claude profile, whose sign-in Noema does not read/);
      assert.strictEqual(calls.length, before, 'its token was never used');
      for await (const ev of cc.agent(app, { prompt: 'hello', cwd: dir, instanceId: r.instance.id })) void ev;
      const after = await ai.refreshQuota(app, r.instance.id);
      assert.ok(after.limits && after.limits.windows.length === 2, 'the receipt of that response carries its windows');
    });

    await test('CLAUDE QUOTA: a refused or missing token falls back to the last receipt, saying why — never an empty bar', async () => {
      const C = await account('nokey@example.com', null);
      const q = await ai.refreshQuota(app, C);
      assert.strictEqual(q.limits, null);
      assert.match(q.note, /^Quota appears after the first Claude response through this account \(this profile holds no Claude sign-in token\)/);
      const D = await account('refused@example.com', 'tok-unknown');
      const qd = await ai.refreshQuota(app, D);
      assert.match(qd.note, /Anthropic refused this sign-in for usage/);
    });

    await test('CLAUDE QUOTA: a window whose reset time has passed is marked expired — not shown as still used', async () => {
      const tid = `${ca.ID}--${A}`;
      const ra = require('../../src/runtimeadapters');
      const t = ra.cachedTelemetry(tid);
      usageOf['tok-personal'] = null;   // the endpoint is unavailable now: the last reading is what is left
      ra.saveTelemetry(tid, { ...t, limits: { ...t.limits, windows: t.limits.windows.map((w) => ({ ...w, resetsAt: Date.now() - 1000 })) } });
      const q = await ai.refreshQuota(app, A);
      assert.ok(q.limits.windows.every((w) => w.expired === true));
    });
  } finally {
    server.close();
    if (saved === undefined) delete process.env.LAIN_ANTHROPIC_MANAGEMENT_BASE; else process.env.LAIN_ANTHROPIC_MANAGEMENT_BASE = saved;
  }
};
