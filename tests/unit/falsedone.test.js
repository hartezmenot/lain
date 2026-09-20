'use strict';

/**
 * RESPONSE_ENDED != TURN_ENDED != TASK_COMPLETE — across the router boundary.
 *
 * A real SSE server (OpenAI-compatible and Anthropic shapes) stands in for a
 * router; the REAL provider parsers read it and the REAL turn loop runs on the
 * result. Before this pass the parsers ignored finish_reason/stop_reason, so a
 * length cut, a refusal and a natural stop were indistinguishable, and a tool
 * call whose JSON was cut or mistranslated silently ran with `{}`.
 */

const assert = require('assert');
const http = require('http');
const { test, tmpdir } = require('../helpers');
const provider = require('../../src/provider');
const { runTurn } = require('../../src/turn');
const { Session } = require('../../src/session');

function sseServer(frames) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const script = frames.shift();
        if (!script) { res.writeHead(500); res.end('no more'); return; }
        if (script.status) { res.writeHead(script.status, { 'content-type': 'application/json' }); res.end(script.body || ''); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const f of script.events) res.write(`data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`);
        if (script.cut) { setTimeout(() => res.destroy(), 40); return; }   // after the text has actually arrived
        res.end('data: [DONE]\n\n');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const chatText = (t) => ({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const chatEnd = (reason) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const chatCall = (name, args) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: args } }] }, finish_reason: null }] });

async function collect(pc) {
  const out = [];
  for await (const ev of provider.chat(pc, [{ role: 'user', content: 'hi' }], {})) out.push(ev);
  return out;
}

async function turnOn(frames, { cwd = null } = {}) {
  const srv = await sseServer(frames);
  const port = srv.address().port;
  const session = new Session({ cwd: cwd || tmpdir('falsedone-') });
  const cfg = { model: 'm', connection: 'x', connections: { x: { provider: 'x', via: 'native', auth: 'api_key', apiKey: 'k', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['m'] } } };
  const events = [];
  let record = null;
  try {
    process.env.LAIN_BACKOFF_MS = '1,1,1,1,1,1,1,1,1,1';
    for await (const ev of runTurn(session, 'fix the bug in a.js', { cfg, maxConnectionRetries: 1, steer: () => [], evidence: session.evidence, lifecycle: session.lifecycle })) {
      events.push(ev);
      if (ev.type === 'done') record = ev.record;
    }
  } finally { srv.close(); delete process.env.LAIN_BACKOFF_MS; }
  return { record, events, session };
}

module.exports = async function () {
  await test('FALSE DONE: the chat and Anthropic parsers name WHY a generation ended', async () => {
    const srv = await sseServer([
      { events: [chatText('partial'), chatEnd('length')] },
      { events: [chatText('no'), chatEnd('content_filter')] },
      { events: [chatText('fine'), chatEnd('stop')] },
      { events: [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'long' } },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } },
      ] },
    ]);
    const base = `http://127.0.0.1:${srv.address().port}/v1`;
    try {
      const chat = { protocol: 'chat', model: 'm', baseUrl: base, apiKey: 'k', headers: {}, maxTokens: 10 };
      const f = async (pc) => (await collect(pc)).find((e) => e.type === 'finish');
      assert.strictEqual((await f(chat)).reason, 'length');
      assert.strictEqual((await f(chat)).reason, 'refused');
      assert.strictEqual((await f(chat)).reason, 'stop');
      assert.strictEqual((await f({ ...chat, protocol: 'anthropic' })).reason, 'length', 'Anthropic max_tokens');
    } finally { srv.close(); }
  });

  await test('FALSE DONE A: a MAX_TOKENS cut is continued once, then ends CUT OFF — never a natural end', async () => {
    const { record, session } = await turnOn([
      { events: [chatText('The fix is to change line'), chatEnd('length')] },
      { events: [chatText(' 14 and then'), chatEnd('length')] },
    ]);
    assert.strictEqual(record.stopReason, 'length');
    assert.strictEqual(record.cutResumes, 1, 'exactly one bounded resume of the cut reply');
    assert.notStrictEqual(record.stopReason, 'end');
    void session;
  });

  await test('FALSE DONE B: a safety/refusal finish ends MODEL REFUSED, not DONE', async () => {
    const { record } = await turnOn([{ events: [chatText('I cannot help'), chatEnd('content_filter')] }]);
    assert.strictEqual(record.stopReason, 'refused');
    const w = require('../../src/ui/status').liveState({ lastTurn: { stopReason: 'refused', toolCalls: 0 } }, Date.now());
    assert.strictEqual(w.word, 'MODEL REFUSED');
  });

  await test('FALSE DONE C: a stream that keeps failing after partial text is resumed (bounded), then a provider failure — never DONE', async () => {
    // A mid-reply drop is RESUMED with what was said kept (finish.js `resumable`),
    // at most MAX_STALL_RESUMES times; a partial reply can never settle as DONE.
    const { record } = await turnOn([
      { events: [chatText('All fixed! The tests')], cut: true },
      { events: [chatText(' still')], cut: true },
      { events: [chatText(' running')], cut: true },
    ]);
    assert.strictEqual(record.stopReason, 'provider', JSON.stringify(record.errors));
    assert.strictEqual(record.stallResumes, require('../../src/finish').MAX_STALL_RESUMES, JSON.stringify(record.errors));
    assert.strictEqual(record.errors[0].resumed, 2, 'the failure says it was resumed and did not recover');
  });

  await test('FALSE DONE D: an empty 200 is not success', async () => {
    const { record } = await turnOn([{ events: [chatEnd('stop')] }, { events: [chatEnd('stop')] }]);
    assert.notStrictEqual(record.stopReason, 'end', 'an empty reply retried once then failed');
    assert.strictEqual(record.stopReason, 'provider');
  });

  await test('FALSE DONE E: a tool call whose JSON arrived cut/mistranslated is REPORTED, never run as {}', async () => {
    const cwd = tmpdir('falsedone-e-');
    const { record, session } = await turnOn([
      { events: [chatCall('write_file', '{"path": "a.txt", "content": "hel'), chatEnd('length')] },
      { events: [chatText('I could not complete the write.'), chatEnd('stop')] },
    ], { cwd });
    const tool = session.messages.find((m) => m.role === 'tool');
    assert.match(tool.content, /MALFORMED_TOOL_CALL/);
    assert.ok(!require('fs').existsSync(require('path').join(cwd, 'a.txt')), 'nothing was written');
    assert.deepStrictEqual(record.mutations, []);
  });

  await test('FALSE DONE F: a natural stop ends the TURN — and only that; the task is decided elsewhere', async () => {
    const { record } = await turnOn([{ events: [chatText('a.js exports 1.'), chatEnd('stop')] }]);
    assert.strictEqual(record.stopReason, 'end');
  });
};
