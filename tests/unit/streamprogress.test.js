'use strict';

/**
 * MODEL LIVENESS FROM THE WIRE (streamprogress.js, 2026-09-23).
 *
 * The clock moved and nothing said whether the model was alive: every open
 * request read THINKING, a 10 KB `edit_file` argument streaming for 40 s was
 * indistinguishable from a dead socket. These pin the words to wire facts, and
 * drive the REAL provider parsers with a real SSE body.
 */

const assert = require('assert');
const { test } = require('../helpers');
const progress = require('../../src/streamprogress');
const box = require('../../src/ui/activitybox');
const status = require('../../src/ui/status');

/** A fetch Response whose body streams these SSE frames, one chunk each. */
function sseResponse(frames) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true, status: 200, headers: new Map(),
    body: { getReader() { return { async read() { return i < frames.length ? { done: false, value: enc.encode(frames[i++]) } : { done: true }; }, async cancel() {} }; } },
  };
}

module.exports = async function () {
  await test('STREAM PROGRESS: the word follows the wire — WAITING, THINKING, STREAMING, PREPARING TOOL', () => {
    const t0 = 1_000_000;
    const live = progress.begin(t0);
    assert.strictEqual(progress.state(live, t0 + 5000).word, 'WAITING', 'no data yet is WAITING, not THINKING');
    progress.reasoning(live, 2100, t0 + 6000);
    assert.strictEqual(progress.state(live, t0 + 7000).word, 'THINKING');
    // TOKENS, NOT KB (2026-10-01), and marked as an ESTIMATE: 2100 chars ≈ 525 tokens. Never quoted.
    assert.match(progress.state(live, t0 + 7000).detail, /^~525 tok$/, 'reasoning is shown as an estimated token count, never quoted');
    progress.text(live, 'Checking the recovery state. ', t0 + 8000);
    assert.strictEqual(progress.state(live, t0 + 8500).word, 'WRITING');
    progress.toolDelta(live, { name: 'edit_file', bytes: 9830, index: 0, calls: 1 }, t0 + 9000);
    const st = progress.state(live, t0 + 9500);
    assert.strictEqual(st.word, 'PREPARING TOOL');
    assert.strictEqual(st.detail, 'edit_file · 9.6 KB');
  });

  await test('STREAM PROGRESS: STALLED only after the threshold with no DATA — keepalive bytes are not progress', () => {
    const t0 = 2_000_000;
    const live = progress.begin(t0);
    progress.toolDelta(live, { name: 'edit_file', bytes: 400 }, t0 + 1000);
    // A large argument still arriving 40 s later is NOT a stall.
    progress.toolDelta(live, { name: 'edit_file', bytes: 40_000 }, t0 + 41_000);
    assert.notStrictEqual(progress.state(live, t0 + 42_000).word, 'STALLED');
    // Only keepalive bytes after that: the connection is alive, the model is not producing.
    progress.bytes(live, 12, t0 + 80_000);
    const st = progress.state(live, t0 + 41_000 + progress.STALL_MS + 1);
    assert.strictEqual(st.word, 'STALLED');
    assert.match(st.detail, /connection alive/);
    // Before the first byte the threshold is longer: slow first tokens are normal.
    const fresh = progress.begin(t0);
    assert.strictEqual(progress.state(fresh, t0 + 60_000).word, 'WAITING');
    assert.strictEqual(progress.state(fresh, t0 + progress.FIRST_STALL_MS + 1).word, 'STALLED');
  });

  await test('STREAM PROGRESS: commentary is the paragraph being written, never reasoning', () => {
    const live = progress.begin(0);
    progress.reasoning(live, 50, 1);
    assert.strictEqual(progress.commentaryLine(live), '', 'reasoning never becomes commentary');
    progress.text(live, 'First paragraph, done.\n\n', 2);
    progress.text(live, 'Now tracing session recovery', 3);
    assert.strictEqual(progress.commentaryLine(live), 'Now tracing session recovery');
    const long = 'word '.repeat(200);
    progress.text(live, long, 4);
    assert.ok(progress.commentaryLine(live, 80).length <= 81, 'clipped to a glimpse');
  });

  await test('STREAM PROGRESS: the OpenAI-shaped parser reports tool-argument bytes as they stream', async () => {
    const provider = require('../../src/provider');
    const args = JSON.stringify({ path: 'src/a.js', content: 'x'.repeat(3000) });
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'edit_file', arguments: '' } }] } }] })}\n\n`,
      ...args.match(/.{1,500}/g).map((a) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: a } }] } }] })}\n\n`),
      ': keepalive\n\n',
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const live = progress.begin();
    const seen = [];
    const origFetch = global.fetch;
    global.fetch = async () => sseResponse(frames);
    try {
      const pc = { protocol: 'chat', provider: 'x', model: 'm', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' };
      for await (const ev of provider.chat(pc, [{ role: 'user', content: 'hi' }], { live, tools: [] })) {
        if (live.tool) seen.push(live.tool.bytes);
        if (ev.type === 'tool_calls') assert.strictEqual(ev.calls[0].name, 'edit_file');
      }
    } finally { global.fetch = origFetch; }
    assert.strictEqual(live.tool.name, 'edit_file');
    assert.strictEqual(live.tool.bytes, args.length, 'every argument byte was counted');
    assert.ok(live.bytes > args.length, 'socket bytes counted, frames included');
    assert.strictEqual(progress.state(live).word, 'PREPARING TOOL');
  });

  await test('STREAM PROGRESS: the Anthropic parser counts input_json deltas; thinking is reasoning, a signature is hidden reasoning', async () => {
    const provider = require('../../src/provider');
    const frames = [
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret plan' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'write_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.js",' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"content":"hi"}' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })}\n\n`,
    ];
    const live = progress.begin();
    const origFetch = global.fetch;
    global.fetch = async () => sseResponse(frames);
    const texts = [];
    const thoughts = [];
    try {
      const pc = { protocol: 'anthropic', provider: 'anthropic', model: 'm', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' };
      for await (const ev of provider.chat(pc, [{ role: 'user', content: 'hi' }], { live, tools: [] })) {
        if (ev.type === 'text') texts.push(ev.chunk);
        if (ev.type === 'reasoning') thoughts.push(ev);
      }
    } finally { global.fetch = origFetch; }
    assert.deepStrictEqual(thoughts.map((t) => [t.chunk, Boolean(t.hidden)]), [['secret plan', false], ['', true]], 'visible thinking is shown while it streams; a signature is hidden');
    assert.ok(!texts.join('').includes('secret plan'), 'and thinking is never the answer');
    assert.strictEqual(live.tool.name, 'write_file');
    assert.strictEqual(live.tool.bytes, '{"path":"a.js","content":"hi"}'.length);
  });

  await test('ACTIVITY BOX + STATUS ROW: one record, one live line; the box carries only commentary', () => {
    const t0 = Date.now() - 21_000;
    const live = progress.begin(t0);
    progress.text(live, 'Checking whether recovery state matches the latest completed tool receipt', Date.now() - 100);
    const state = { busy: true, phase: { phase: 'RECEIVING', live }, phaseSince: t0, recent: [] };
    const s = box.summary(state);
    assert.strictEqual(s.kind, 'WRITING');
    assert.strictEqual(s.clock, '00:21');
    assert.match(s.commentary, /recovery state matches/);
    // THE BOX NO LONGER REPEATS THE LIVE ROW: only the model's own words take rows.
    assert.strictEqual(box.rows(state, 99), 2, 'commentary only — the state word and clock live on the one activity line');
    assert.strictEqual(box.rows(state, 99, Date.now(), { minimal: true }), 0, 'a diff/tool primary leaves no box at all');
    const row = status.liveState({ phase: state.phase, phaseSince: t0 });
    assert.strictEqual(row.word, 'Writing', 'the status strip says the same state, in the live row\'s words');
    progress.toolDelta(live, { name: 'edit_file', bytes: 9830 });
    assert.strictEqual(box.summary(state).kind, 'PREPARING TOOL');
    assert.strictEqual(status.liveState({ phase: state.phase, phaseSince: t0 }).word, 'Writing', 'the row: writing a tool call');
    const lines = box.draw(state, 80, box.rows(state, 99)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    assert.ok(!lines.some((l) => /PREPARING TOOL/.test(l)), 'the box never repeats the state word');
    assert.match(lines.join(' '), /recovery state matches/);
    const strip = status.statusStrip({ phase: state.phase, phaseSince: t0 }, 80, 1).join('').replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(strip, /Writing · edit_file call · 9\.6 KB/, 'the one activity line carries it');
  });

  await test('ACTIVITY BOX: a rate limit is RATE LIMITED, not generic WAITING', () => {
    const s = box.summary({ busy: true, phase: { phase: 'RETRYING', rateLimited: true, resumeAt: Date.now() + 9000 }, recent: [] });
    assert.strictEqual(s.kind, 'RATE LIMITED');
  });

  await test('TURN LOOP: every provider request gets a progress record, passed to the wire and the status', async () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/turn'), 'utf8');
    assert.match(src, /const live = progress\.begin\(\);[^\n]*\n\s*status\(opts, PHASE\.WAITING_MODEL, \{ step: step \+ 1, live \}\)/);
    assert.match(src, /provider\.chat\(pc, wire, \{[^}]*\blive\b/);
  });
};
