'use strict';

/**
 * A FAKE ZCode bundled CLI for tests: `version`, and `app-server` speaking the
 * ZCode Protocol shape LAIN uses — newline JSON {id, method, params}, no
 * "jsonrpc" key; session/create first asks the HOST for runtime preferences
 * (a server→client request LAIN answers "not supported").
 */

const argv = process.argv.slice(2);
if (argv[0] === 'version') { process.stdout.write('zcode 9.1.0\n'); process.exit(0); }
if (argv[0] !== 'app-server') process.exit(2);

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let buf = '';
const waiting = new Map();
let sid = 0;
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.jsonrpc) { out({ id: 'invalid-message', error: { code: -32600, message: 'Unrecognized key: "jsonrpc"' } }); continue; }
    if (m.id != null && !m.method && waiting.has(m.id)) { const f = waiting.get(m.id); waiting.delete(m.id); f(m); continue; }
    handle(m);
  }
});

function handle(m) {
  const reply = (result) => out({ id: m.id, result });
  switch (m.method) {
    case 'usage/stats': return reply({ range: m.params.range, summary: { totalTokens: 1500, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 800 }, models: [{ modelId: 'GLM-5.3-Flash', totalTokens: 1500, inputTokens: 1000, outputTokens: 500, requestCount: 9 }] });
    case 'session/list': return reply({ sessions: [{ id: 'sess_a' }, { id: 'sess_b' }] });
    case 'session/create': {
      const ask = `server-${++sid}`;
      waiting.set(ask, () => reply({ session: { sessionId: 'sess_new' }, settings: { model: { available: [{ ref: { providerId: 'p-omni', modelId: 'glm-free' }, label: 'glm-free', providerLabel: 'omniroute', contextWindow: 200000, properties: { inputFormat: { supportsImage: false } } }] } } }));
      return out({ id: ask, method: 'session/requestRuntimePreferences', params: { sessionId: 'sess_new', scope: 'runtime-materialization' } });
    }
    case 'session/close': return reply({ closed: true });
    case 'workspace/generateText': {
      const p = m.params;
      if (p.selection.providerId === 'account:zai-start-plan') return out({ id: m.id, error: { code: -32603, message: 'Provider Registry has no Provider: account:zai-start-plan' } });
      const last = p.messages[p.messages.length - 1];
      if (p.tools && p.tools.length && /read_file/.test(last.content)) return reply({ text: '', selection: p.selection, toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'notes.txt' } }], finishReason: 'tool-calls', usage: { inputTokens: 30, outputTokens: 5 } });
      return reply({ text: `zcode: ${String(last.content).slice(0, 30)}`, selection: p.selection, finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 3 } });
    }
    default: return out({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}
