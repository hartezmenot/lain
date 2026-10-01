'use strict';

/**
 * ONE ACTIVITY LINE (2026-10-01).
 *
 * The CLI said one state in three places (activity box, status strip, header) and showed implementation words
 * (`job_wait`), a reasoning SIZE in KB, and nothing about background shells. These pin the replacement: one live
 * row, background work in the person's words, estimates marked as estimates, and a receipt with only stated fields.
 */

const assert = require('assert');
const { test } = require('../helpers');
const line = require('../../src/ui/activityline');
const status = require('../../src/ui/status');
const box = require('../../src/ui/activitybox');
const progress = require('../../src/streamprogress');
const phrasing = require('../../src/ui/phrasing');

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

module.exports = async function () {
  await test('ACTIVITY: background work is counted by kind, in the person\'s words', () => {
    const app = {
      _jobs: { running: () => [{ kind: undefined }, { kind: 'monitor' }] },
      jobs: { running: () => [{ kind: 'subagent' }, { kind: 'subagent' }, { kind: 'process' }, { kind: 'subagent', primary: true }] },
    };
    const n = line.backgroundOf(app);
    assert.deepStrictEqual({ shell: n.shell, monitor: n.monitor, agent: n.agent }, { shell: 2, monitor: 1, agent: 2 });
    assert.strictEqual(line.backgroundLabel(n), '2 shells · 1 monitor · 2 agents');
    assert.strictEqual(line.backgroundLabel(line.backgroundOf(null)), '', 'nothing running says nothing');
  });

  await test('ACTIVITY: the live row carries the background, and never `job_wait`', () => {
    const live = progress.begin(Date.now() - 500);
    const row = plain(status.statusStrip({ phase: { phase: 'WAITING_MODEL', live }, background: { shell: 1, monitor: 1, agent: 0, preview: 0, check: 0 } }, 100, 1).join(''));
    assert.match(row, /Working · waiting for model · 1 shell · 1 monitor/);
    const waiting = plain(status.statusStrip({ phase: { phase: 'RUNNING_TOOL', tool: 'job_wait', target: '#j1' } }, 100, 1).join(''));
    assert.match(waiting, /Waiting for shell · #j1/);
    assert.ok(!/job[_ ]wait/i.test(waiting), waiting);
    assert.ok(!/job[_ ]wait/i.test(phrasing.phrase('job_wait', '#j1')), 'the feed row says it in words too');
    assert.ok(!/run[_ ]background/i.test(phrasing.phrase('run_background', 'npm test')));
  });

  await test('ACTIVITY: a long silence gets a factual heartbeat — never fake progress', () => {
    const t0 = 1_000_000;
    const live = progress.begin(t0);
    assert.strictEqual(progress.state(live, t0 + 1000).detail, 'waiting for model');
    assert.strictEqual(progress.state(live, t0 + 3000).detail, 'waiting for model · 3s');
    assert.strictEqual(progress.state(live, t0 + 9000).detail, 'provider response pending · 9s');
  });

  await test('ACTIVITY: the box never repeats the live row — no box when it has nothing of its own', () => {
    const live = progress.begin(Date.now() - 4000);
    const state = { busy: true, phase: { phase: 'WAITING_MODEL', live }, phaseSince: Date.now() - 4000, recent: [] };
    assert.strictEqual(box.rows(state, 99), 0, 'waiting is said once, on the activity line');
    const drawn = box.draw(state, 80, 2).map(plain).join('\n');
    assert.ok(!/WAITING|Waiting/.test(drawn), drawn);
  });

  await test('TOKENS: reasoning is an ESTIMATE while streaming and the provider\'s COUNT in the receipt', () => {
    assert.strictEqual(line.estTokens(8400 * 4), '~8.4k tok', 'an estimate is always marked ~');
    assert.strictEqual(line.estTokens(0), '');
    assert.strictEqual(line.receipt({ inputTokens: 18200, reasoningTokens: 7400, outputTokens: 1100, cacheReadTokens: 12800 }),
      'in 18k · reasoning 7.4k · out 1.1k · cache 13k');
    assert.strictEqual(line.receipt({ inputTokens: 900, outputTokens: 20, cacheReadTokens: null }), 'in 900 · out 20',
      'a field nobody stated is left out, never drawn as 0');
    assert.ok(!/reasoning/.test(line.receipt({ inputTokens: 10, outputTokens: 5 })), 'no reasoning count without a provider count');
  });

  await test('TOKENS: the OpenAI-shaped parser keeps the provider\'s reasoning_tokens', async () => {
    const provider = require('../../src/provider');
    const enc = new TextEncoder();
    const body = [
      { choices: [{ index: 0, delta: { content: 'ok' } }] },
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 22 } } },
    ].map((j) => `data: ${JSON.stringify(j)}\n\n`).join('') + 'data: [DONE]\n\n';
    const orig = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, body: new ReadableStream({ start(c) { c.enqueue(enc.encode(body)); c.close(); } }) });
    let usage = null;
    try {
      for await (const ev of provider.chat({ protocol: 'chat', model: 'm', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' }, [{ role: 'user', content: 'hi' }], {})) if (ev.type === 'usage') usage = ev;
    } finally { global.fetch = orig; }
    assert.strictEqual(usage.reasoningTokens, 22);
    assert.strictEqual(usage.outputTokens, 30);
  });

  await test('DONE: the finished turn shows its receipt on the one line', () => {
    const row = plain(status.statusStrip({ lastTurn: { toolCalls: 3, filesChanged: 2, stopReason: 'end', usage: { inputTokens: 14800, outputTokens: 620, cacheReadTokens: 9100 } } }, 120, 1).join(''));
    assert.match(row, /DONE · 2 files changed · 3 tool calls · in 15k · out 620 · cache 9.1k/);
  });
};
