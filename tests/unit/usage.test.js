'use strict';

/**
 * USAGE — receipts per request, aggregation by every dimension, runtime usage
 * without double counting, cost that is honest about where it came from, and
 * limits that stay per window with a reset that is expected, not confirmed.
 */

const assert = require('assert');
const fs = require('fs');
const { test } = require('../helpers');

module.exports = async function () {
  const usage = require('../../src/usage');
  const mr = require('../../src/modelrequest');
  fs.rmSync(usage.dir(), { recursive: true, force: true });

  const send = ({ model, provider, connection, project, session, task, role, receipt, ok = true, transport = 'api' }) => {
    const o = mr.open({ turn: 't', step: 1, reason: 'model-step', transport, model, connection, provider, project, role, sessionId: session, taskId: task });
    assert.ok(o.ok);
    o.env.rec.protocol = provider === 'anthropic' ? 'anthropic' : 'chat';
    o.env.rec.systemChars = 1000; o.env.rec.toolSchemaChars = 5000; o.env.rec.toolCount = 12;
    return mr.close(o.env, { ok, usage: receipt });
  };

  await test('USAGE RECEIPT: every request through the one envelope is kept — identity and accounting, no content', () => {
    send({ model: 'opus', provider: 'anthropic', connection: 'lain:anthropic', project: 'D:/p1', session: 'S1', task: 'T1', receipt: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 0, toolCalls: 2 } });
    send({ model: 'opus', provider: 'anthropic', connection: 'lain:anthropic', project: 'D:/p1', session: 'S1', task: 'T1', receipt: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 950, cacheCreationTokens: 0, toolCalls: 0 } });
    send({ model: 'gpt-5', provider: 'openai', connection: 'lain:openai', project: 'D:/p2', session: 'S2', task: 'T2', receipt: { inputTokens: 400, outputTokens: 40, reasoningTokens: 30, costUsd: 0.012 } });
    send({ model: 'chatgpt-web', provider: 'chatgpt-web', connection: 'chatgpt-web', project: 'D:/p2', session: 'S3', role: 'chat', transport: 'website', receipt: null });
    const rows = usage.read({});
    assert.strictEqual(rows.length, 4);
    const r = rows[0];
    assert.strictEqual(r.source, 'lain');
    assert.ok(/^P[0-9a-f]{12}$/.test(r.project), 'the project by its id, not its path');
    assert.strictEqual(r.account, 'lain:anthropic');
    assert.strictEqual(r.role, 'agent'); assert.strictEqual(r.roleDerived, true);
    for (const k of ['messages', 'content', 'prompt', 'text', 'apiKey']) assert.ok(!(k in r), k);
    const web = rows[3];
    assert.strictEqual(web.tokens, 'not reported');
    assert.strictEqual(web.input, null, 'not reported is null, never 0');
    assert.strictEqual(web.role, 'chat'); assert.strictEqual(web.roleDerived, false);
  });

  await test('USAGE: grouped by project, session, task, LLM, provider, account, role and time', () => {
    const rows = usage.read({});
    for (const dim of ['project', 'session', 'task', 'model', 'provider', 'account', 'role', 'day']) {
      const g = usage.aggregate(rows, dim, {});
      assert.strictEqual(g.reduce((a, x) => a + x.requests, 0), 4, dim);
    }
    const byModel = Object.fromEntries(usage.aggregate(rows, 'model', {}).map((g) => [g.key, g]));
    assert.strictEqual(byModel.opus.input, 150);
    assert.strictEqual(byModel.opus.cacheRead, 1850);
    assert.strictEqual(byModel.opus.cacheHits, 2);
    assert.strictEqual(byModel.opus.toolCalls, 2);
    assert.strictEqual(byModel['gpt-5'].reasoning, 30);
    assert.strictEqual(byModel['gpt-5'].reported.cache, 0, 'no cache field reported → not counted as a miss or a hit');
    assert.strictEqual(byModel['chatgpt-web'].reported.tokens, 0);
  });

  await test('USAGE: runtime-reported usage is its own rows — imported twice, counted once, never merged into LAIN\'s', () => {
    const a = usage.importRuntime('runtime:codex', [{ id: 'thr1:turn1', account: 'codex-aaa', model: 'gpt-5-codex', input: 1000, output: 100 }]);
    const b = usage.importRuntime('runtime:codex', [{ id: 'thr1:turn1', account: 'codex-aaa', model: 'gpt-5-codex', input: 1000, output: 100 }]);
    assert.deepStrictEqual([a.added, b.added], [1, 0]);
    const src = Object.fromEntries(usage.aggregate(usage.read({}), 'source', {}).map((g) => [g.key, g.requests]));
    assert.deepStrictEqual(src, { lain: 4, 'runtime:codex': 1 });
    assert.throws(() => usage.importRuntime('codex', []), /runtime:/);
  });

  await test('COST: the provider\'s figure is actual; an estimate exists only from configured prices and says so', () => {
    const rows = usage.read({}).filter((r) => r.source === 'lain');
    const none = usage.sum(rows, {});
    assert.strictEqual(none.cost.actualUsd, 0.012);
    assert.strictEqual(none.cost.estimatedRows, 0, 'no price configured, no estimate');
    assert.strictEqual(none.cost.unpriced, 2);
    const priced = usage.sum(rows, { usage: { prices: { 'opus*': { input: 15, output: 75, cacheRead: 1.5 } } } });
    assert.strictEqual(priced.cost.estimatedRows, 2);
    assert.ok(priced.cost.estimatedUsd > 0);
    assert.strictEqual(priced.cost.label, 'Estimated from configured prices');
  });

  await test('CONTEXT EFFICIENCY: provider cache (per protocol) and LAIN\'s own prefix, apart', () => {
    const e = usage.efficiency(usage.read({}));
    assert.strictEqual(e.provider.reportedRows, 2, 'anthropic rows reported cache; the openai row did not');
    assert.strictEqual(e.provider.cachedTokens, 1850);
    assert.strictEqual(e.provider.totalInput, 2000, 'anthropic: input excludes cache → total = input + read + write');
    assert.strictEqual(e.provider.notReportedRows, 1);
    assert.strictEqual(e.lain.avgSystemChars, 1000);
    assert.strictEqual(e.lain.avgToolSchemaChars, 5000);
  });

  await test('LIMITS: a window past its reset is expired and unconfirmed — never assumed replenished', () => {
    const ai = require('../../src/accountinstances');
    const now = Date.now();
    const l = ai.stampWindows({ windows: [{ id: 'primary', label: '5h', usedPercent: 100, resetsAt: now + 1000 }, { id: 'secondary', label: 'weekly', usedPercent: 40, resetsAt: now + 864e5 }] }, now);
    assert.deepStrictEqual(l.windows.map((w) => w.expired), [false, false]);
    const later = ai.stampWindows(l, now + 2000);   // the clock moved past the 5h reset
    assert.deepStrictEqual(later.windows.map((w) => [w.label, w.expired, w.resetConfirmed]), [['5h', true, false], ['weekly', false, false]]);
    assert.strictEqual(later.windows[0].usedPercent, 100, 'the old figure is kept as history — the view shows it as expired, not as 0%');
  });
};
