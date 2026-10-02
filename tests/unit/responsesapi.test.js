'use strict';

/**
 * THE RESPONSES API ADAPTER (provider.js `responsesChat`, 2026-09-24).
 *
 * Against a local server speaking the Responses streaming protocol: the request
 * LAIN sends (instructions, input items, function_call / function_call_output,
 * reasoning effort, tools, store:false) and the events it yields — the SAME
 * events the Chat Completions path yields, so nothing above the provider
 * changes. Cache and reasoning figures are reported only when the provider
 * reported them.
 */

const assert = require('assert');
const http = require('http');
const { test } = require('../helpers');
const provider = require('../../src/provider');

function server(frames) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const f of frames) res.write(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);
      res.end();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ seen, url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => srv.close() })));
}

async function collect(pc, messages, opts = {}) {
  const out = [];
  for await (const ev of provider.chat(pc, messages, opts)) out.push(ev);
  return out;
}

module.exports = async () => {
  await test('RESPONSES: the request carries instructions, typed input items, tools, effort and store:false', async () => {
    const s = await server([{ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 1 } } }]);
    try {
      const pc = { protocol: 'responses', provider: 'x', connectionId: 'c', model: 'gpt-6-luna', baseUrl: s.url, apiKey: 'k', headers: {}, reasoningEffort: 'medium' };
      await collect(pc, [
        { role: 'system', content: 'You are LAIN.' },
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.js"}' }] },
        { role: 'tool', tool_call_id: 'call_1', content: '1\tx' },
        { role: 'user', content: '<lain-context>tail</lain-context>' },
      ], { tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } }] });
      const b = s.seen[0].body;
      assert.strictEqual(s.seen[0].url, '/v1/responses');
      assert.strictEqual(s.seen[0].auth, 'Bearer k');
      assert.strictEqual(b.instructions, 'You are LAIN.');
      assert.deepStrictEqual(b.reasoning, { effort: 'medium' });
      assert.strictEqual(b.store, false);
      assert.strictEqual(b.stream, true);
      assert.deepStrictEqual(b.input, [
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: 'Reading.' },
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.js"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '1\tx' },
        { role: 'user', content: '<lain-context>tail</lain-context>' },
      ]);
      assert.deepStrictEqual(b.tools, [{ type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} }, strict: false }]);
    } finally { s.close(); }
  });

  await test('RESPONSES: streamed text, a streamed tool call, finish and usage — the same events as Chat Completions', async () => {
    const s = await server([
      { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
      { type: 'response.output_text.delta', delta: 'Let me ' },
      { type: 'response.output_text.delta', delta: 'look.' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_9', name: 'grep', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"pattern":' },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"search"}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_9', name: 'grep', arguments: '{"pattern":"search"}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 30 } } } },
    ]);
    try {
      const evs = await collect({ protocol: 'responses', model: 'm', baseUrl: s.url, apiKey: 'k', headers: {} }, [{ role: 'user', content: 'hi' }]);
      assert.strictEqual(evs.filter((e) => e.type === 'text').map((e) => e.chunk).join(''), 'Let me look.');
      assert.ok(evs.some((e) => e.type === 'reasoning' && e.chunk === 'thinking'));
      const tc = evs.find((e) => e.type === 'tool_calls');
      assert.deepStrictEqual(tc.calls.map((c) => ({ id: c.id, name: c.name, input: c.input })), [{ id: 'call_9', name: 'grep', input: { pattern: 'search' } }]);
      assert.strictEqual(evs.find((e) => e.type === 'finish').reason, require('../../src/finish').normalize('tool_calls'));
      const u = evs.find((e) => e.type === 'usage');
      assert.deepStrictEqual({ i: u.inputTokens, o: u.outputTokens, c: u.cacheReadTokens, r: u.cacheReported, rt: u.reasoningTokens }, { i: 2000, o: 40, c: 1500, r: true, rt: 30 });
    } finally { s.close(); }
  });

  await test('RESPONSES: a cache figure the provider did not report stays UNREPORTED; an incomplete response is a length cut; a failed one throws', async () => {
    const s = await server([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 7 } } },
    ]);
    try {
      const evs = await collect({ protocol: 'responses', model: 'm', baseUrl: s.url, apiKey: 'k', headers: {} }, [{ role: 'user', content: 'hi' }]);
      const u = evs.find((e) => e.type === 'usage');
      assert.strictEqual(u.cacheReported, false);
      assert.strictEqual(evs.find((e) => e.type === 'finish').reason, require('../../src/finish').normalize('length'));
    } finally { s.close(); }
    const f = await server([{ type: 'response.failed', response: { status: 'failed', error: { message: 'upstream exploded' } } }]);
    try {
      await assert.rejects(collect({ protocol: 'responses', model: 'm', baseUrl: f.url, apiKey: 'k', headers: {} }, [{ role: 'user', content: 'hi' }]), /upstream exploded/);
    } finally { f.close(); }
  });

  await test('RESPONSES: a connection declares it, and the configured effort reaches the provider', () => {
    const pc = provider.resolve({ model: 'gpt-6-luna', connection: 'live', effort: 'medium', connections: { live: { provider: 'r', via: 'native', auth: 'api_key', protocol: 'responses', baseUrl: 'http://x/v1', apiKey: 'k', models: ['gpt-6-luna'] } } });
    assert.strictEqual(pc.protocol, 'responses');
    assert.strictEqual(pc.reasoningEffort, 'medium');
  });
};
