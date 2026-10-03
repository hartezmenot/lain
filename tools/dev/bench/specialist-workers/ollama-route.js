'use strict';

/**
 * OLLAMA CLOUD THROUGH LAINROUTER — route acceptance before any benchmark
 * (§57–61). Every request is counted and capped.
 *
 *   node bench/specialist-workers/ollama-route.js [--model ollama-cloud/gpt-oss:120b] [--base http://127.0.0.1:4570/v1]
 *
 *   text         one streamed answer through LAIN's own sender (provider.chat)
 *   streaming    chunks arrive over time; LAIN's liveness state follows them
 *   tools        the real binary (`lain -p`): tool schema → gpt-oss tool call →
 *                LAIN executes → result → continuation → final answer
 *   large args   a write_file whose content is ~9 KB, checked on disk
 *   structured   response_format json_schema, parsed
 *   effort       reasoning_effort low vs high (the same question)
 *   subagent     one isolated child through `delegate`, if policy permits
 *   telemetry    input / cached input / output / duration per request, as the
 *                provider reported them — "not reported" is never written as 0
 *
 * The API key is the one LAIN already holds for LainRouter
 * (`connections['lain:127.0.0.1']` in the person's config). It is passed to the
 * child runs in their isolated config and never printed.
 *
 * Writes out/ollama-route-<stamp>.json.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCli } = require('../../../../tests/helpers');
const { loadReqtrace } = require('../metrics');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const MODEL = arg('model', 'ollama-cloud/gpt-oss:120b');
const BASE = arg('base', 'http://127.0.0.1:4570/v1');
const CAP = Number(arg('cap', '40'));
const userCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.lain-v2', 'config.json'), 'utf8'));
const KEY = ((userCfg.connections || {})['lain:127.0.0.1'] || {}).apiKey;
if (!KEY) { console.error('no LainRouter key in connections["lain:127.0.0.1"]'); process.exit(2); }

let spent = 0;
const spend = (n = 1) => { spent += n; if (spent > CAP) throw new Error(`request cap ${CAP} reached`); };

function connection() {
  return { lainrouter: { provider: 'lainrouter', via: 'native', auth: 'api_key', protocol: 'chat', baseUrl: BASE, apiKey: KEY, models: [MODEL] } };
}

async function direct(body) {
  spend();
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, ...body }), signal: AbortSignal.timeout(180000),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ms: Date.now() - t0, j };
}

async function text() {
  const provider = require('../../../../src/provider');
  const sp = require('../../../../src/streamprogress');
  const pc = provider.resolve({ model: MODEL, connection: 'lainrouter', connections: connection() });
  const live = sp.begin();
  const t0 = Date.now();
  const events = [];
  const states = [];
  spend();
  for await (const ev of provider.chat(pc, [{ role: 'user', content: 'Count from 1 to 40, one number per line, then write DONE.' }], { live, cfg: {} })) {
    const at = Date.now() - t0;
    if (ev.type === 'text' || ev.type === 'reasoning') {
      events.push({ at, type: ev.type, n: String(ev.chunk || '').length });
      if (ev.type === 'text') sp.text(live, ev.chunk); else sp.reasoning(live, String(ev.chunk || '').length);
    } else events.push({ at, type: ev.type, ...(ev.type === 'usage' ? { usage: { ...ev } } : ev.type === 'finish' ? { reason: ev.reason } : {}) });
    const s = sp.state(live);
    const label = typeof s === 'string' ? s : (s && (s.state || s.label || s.kind)) || JSON.stringify(s).slice(0, 40);
    if (!states.length || states[states.length - 1].state !== label) states.push({ at, state: label });
  }
  const textEv = events.filter((e) => e.type === 'text');
  const reasonEv = events.filter((e) => e.type === 'reasoning');
  const content = events.filter((e) => e.type === 'text' || e.type === 'reasoning');
  return {
    route: { protocol: pc.protocol, model: pc.model, baseUrl: pc.baseUrl, ctx: pc.ctx, maxTokens: pc.maxTokens },
    streamed: content.length >= 2 && content[content.length - 1].at - content[0].at > 50,
    textChunks: textEv.length, reasoningChunks: reasonEv.length,
    firstChunkMs: content.length ? content[0].at : null, lastChunkMs: content.length ? content[content.length - 1].at : null, totalMs: Date.now() - t0,
    livenessStates: states,
    finish: (events.find((e) => e.type === 'finish') || {}).reason,
    usage: (events.find((e) => e.type === 'usage') || {}).usage,
  };
}

async function lainRun(name, prompt, files = {}, { expectFile = null } = {}) {
  const root = path.join(os.tmpdir(), 'lain-ollama-route', `${Date.now()}-${name}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(root, f), c);
  const configDir = path.join(root, '.config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    model: MODEL, connection: 'lainrouter', maxSteps: 8,
    trustedPaths: [{ path: root, level: 'TRUSTED', at: new Date().toISOString() }],
    connections: connection(),
  }, null, 2));
  const trace = path.join(configDir, 'reqtrace.jsonl');
  const t0 = Date.now();
  const r = await runCli(['-p', prompt], { cwd: root, configDir, env: { LAIN_REQTRACE: trace }, timeoutMs: 8 * 60 * 1000 });
  const rows = loadReqtrace(trace);
  spend(rows.length);
  const session = require('../metrics').loadSession(configDir, r.stdout);
  const calls = session ? require('../metrics').callsOf(session) : [];
  const turn = session && session.turns ? session.turns[session.turns.length - 1] : null;
  return {
    exit: r.code, wallMs: Date.now() - t0, stopReason: turn && turn.stopReason, requests: rows.length,
    routes: [...new Set(rows.map((x) => `${x.connection}|${x.model}`))],
    perRequest: rows.map((x) => ({ ok: x.ok, status: x.status, ms: x.ms, receipt: x.receipt })),
    toolCalls: calls.map((c) => ({ name: c.name, argBytes: JSON.stringify(c.input || {}).length, error: Boolean(c.result && c.result.isError) })),
    finalText: String((turn && turn.text) || '').slice(-400),
    file: expectFile ? (() => { try { return fs.readFileSync(path.join(root, expectFile), 'utf8'); } catch { return null; } })() : undefined,
    stderrTail: r.stderr.slice(-400),
  };
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = { stamp, model: MODEL, base: BASE, transport: 'OpenAI-compatible /v1/chat/completions via LainRouter → ollama.com/v1', cap: CAP };
  const file = path.join(__dirname, 'out', `ollama-route-${stamp}.json`);
  const write = () => fs.writeFileSync(file, JSON.stringify({ ...out, requestsSpent: spent }, null, 2));
  const step = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = { error: String(e && e.message || e) }; } write(); console.log(`${k}: ${JSON.stringify(out[k]).slice(0, 300)}`); };

  await step('text', text);
  await step('tools', () => lainRun('tools', 'Read notes.txt and tell me the code word written in it. Answer with the code word only.',
    { 'notes.txt': 'Shopping list\n- milk\nThe code word is HELIOTROPE-42.\n' }));
  const lines = Array.from({ length: 150 }, (_, i) => `line ${String(i + 1).padStart(3, '0')}: the quick brown fox jumps over the lazy dog`);
  await step('largeArgs', async () => {
    const r = await lainRun('large', `Create a file named big.txt containing exactly these ${lines.length} lines and nothing else, using one write:\n${lines.join('\n')}`, {}, { expectFile: 'big.txt' });
    const got = String(r.file || '').replace(/\r\n/g, '\n').trim().split('\n');
    return { ...r, file: undefined, fileLines: got.length, exact: got.join('\n') === lines.join('\n'), expectedBytes: lines.join('\n').length };
  });
  await step('structured', async () => {
    const r = await direct({ stream: false, messages: [{ role: 'user', content: 'Give the capital and population (millions, integer) of France.' }],
      response_format: { type: 'json_schema', json_schema: { name: 'city', strict: true, schema: { type: 'object', properties: { capital: { type: 'string' }, population_millions: { type: 'integer' } }, required: ['capital', 'population_millions'], additionalProperties: false } } } });
    const c = r.j.choices && r.j.choices[0] && r.j.choices[0].message && r.j.choices[0].message.content;
    let parsed = null; try { parsed = JSON.parse(c); } catch { /* not json */ }
    return { status: r.status, ms: r.ms, content: String(c || '').slice(0, 200), parsed, usage: r.j.usage, error: r.j.error || null };
  });
  await step('effort', async () => {
    const q = [{ role: 'user', content: 'Is 391 a prime number? Answer yes or no.' }];
    const lo = await direct({ stream: false, messages: q, reasoning_effort: 'low' });
    const hi = await direct({ stream: false, messages: q, reasoning_effort: 'high' });
    const v = (r) => ({ status: r.status, ms: r.ms, usage: r.j.usage, reasoningChars: String((r.j.choices && r.j.choices[0] && r.j.choices[0].message && r.j.choices[0].message.reasoning) || '').length, answer: String((r.j.choices && r.j.choices[0] && r.j.choices[0].message && r.j.choices[0].message.content) || '').slice(0, 80), error: r.j.error || null });
    return { low: v(lo), high: v(hi) };
  });
  await step('subagent', () => lainRun('subagent', 'Use the delegate tool to give ONE subagent this job: read data.txt and report how many lines it has. Then tell me the number the subagent reported.',
    { 'data.txt': 'a\nb\nc\nd\ne\nf\ng\n' }));
  write();
  console.log(`requests spent: ${spent} · wrote ${path.relative(process.cwd(), file)}`);
})().catch((e) => { console.error(e); process.exit(1); });
