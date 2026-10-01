'use strict';

/**
 * RUNTIME ADAPTERS — discovery, telemetry and execution reported apart, and
 * each runtime driven through its own real surface (here: fakes of that
 * surface). No adapter forges an identity, reads a credential or calls a
 * service behind a runtime.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const { shim, FIX } = require('../fixtures/runtimes/shim');
  const { App } = require('../../src/app');
  const ra = require('../../src/runtimeadapters');
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('rtapp-') });
  const bins = tmpdir('rtbins-');
  const claude = shim(path.join(bins, 'claude'), 'claude', path.join(FIX, 'fakeclaude.js'));
  const opencode = shim(path.join(bins, 'opencode'), 'opencode', path.join(FIX, 'fakeopencode.js'));
  const zdir = tmpdir('zcodeapp-');
  fs.mkdirSync(path.join(zdir, 'resources', 'glm'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'fakezcode.cjs'), path.join(zdir, 'resources', 'glm', 'zcode.cjs'));
  fs.writeFileSync(path.join(zdir, 'ZCode.exe'), '');
  app.cfg.runtimes = { 'claude-code': { binary: claude }, opencode: { binary: opencode }, zcode: { appDir: zdir, exe: process.execPath } };
  const claudeArgs = path.join(tmpdir('cargs-'), 'args.jsonl');
  process.env.FAKE_CLAUDE_ARGS = claudeArgs;

  await test('ISOLATION: under test, no adapter finds a real runtime on PATH or in a real home', () => {
    const bare = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('bare-') });
    assert.strictEqual(require('../../src/drivers/claudecode').binary(bare), null);
    assert.strictEqual(require('../../src/drivers/opencoderun').binary(bare), null);
    assert.strictEqual(require('../../src/drivers/zcoderun').binary(bare), null);
    assert.strictEqual(require('../../src/local/llamacpp').binary(bare), null);
    assert.strictEqual(require('../../src/local/ollama').binary(), null);
    assert.strictEqual(process.env.LAIN_ISOLATED, '1');
  });

  await test('CLAUDE CODE: discovery and telemetry from its own documented commands — the address masked', async () => {
    const r = await ra.report(app, 'claude-code', { refresh: true });
    assert.strictEqual(r.discovery.ok, true); assert.strictEqual(r.discovery.version, '9.9.9 (Claude Code)');
    assert.strictEqual(r.telemetry.ok, true);
    assert.strictEqual(r.detail.identity.signedIn, true); assert.strictEqual(r.detail.identity.plan, 'pro');
    assert.ok(!JSON.stringify(r).includes('person@example.com'), 'the email is masked');
    assert.strictEqual(r.state, 'Ready', 'Ready — not Operational until a run through Noema succeeds');
    assert.ok(r.execution.chat.ok && r.execution.agent.ok);
    assert.deepStrictEqual(r.detail.models.map((m) => m.alias), ['opus', 'sonnet', 'haiku', 'fable']);
  });

  await test('CLAUDE CODE: the BOT path runs the real program with no tools; usage, windows and cost basis come back as reported', async () => {
    const provider = require('../../src/provider');
    const pc = provider.resolve({ connections: {}, model: 'claude-code/haiku', runtimes: app.cfg.runtimes });
    assert.strictEqual(pc.protocol, 'runtime'); assert.strictEqual(pc.runtime, 'claude-code');
    let text = ''; let usage = null;
    for await (const ev of provider.chat(pc, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'say hi' }], { role: 'bot', sessionId: 's-cc' })) {
      if (ev.type === 'text') text += ev.chunk; if (ev.type === 'usage') usage = ev;
    }
    assert.match(text, /Echo: say hi/);
    const argv = fs.readFileSync(claudeArgs, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a[0] === '-p').pop();
    assert.ok(argv.includes('--tools') && argv[argv.indexOf('--tools') + 1] === '', 'no tools for the BOT path');
    assert.ok(argv.includes('--strict-mcp-config') && argv.includes('--no-session-persistence'));
    assert.strictEqual(argv[argv.indexOf('--model') + 1], 'haiku');
    assert.strictEqual(argv[argv.indexOf('--system-prompt') + 1], 'Be brief.');
    assert.strictEqual(usage.inputTokens, 11); assert.strictEqual(usage.cacheReadTokens, 200); assert.strictEqual(usage.reasoningTokens, 5);
    assert.strictEqual(usage.costUsd, 0.0123); assert.match(usage.costBasis, /API-equivalent/);
    const row = require('../../src/usage').read({}).filter((x) => x.session === 's-cc').pop();
    assert.strictEqual(row.via, 'Runtime · Claude Code'); assert.strictEqual(row.costBasis !== null, true);
    const s = require('../../src/usage').sum([row], {});
    assert.strictEqual(s.cost.actualRows, 0, 'a runtime’s computed cost is never billed cost'); assert.strictEqual(s.cost.runtimeRows, 1);
    const t = ra.cachedTelemetry('claude-code');
    assert.deepStrictEqual(t.limits.windows.map((w) => [w.label, w.usedPercent]), [['5-hour', 25], ['7-day', 60]]);
    assert.strictEqual(t.resolved.haiku, 'claude-haiku-fake-1');
    assert.strictEqual((await ra.report(app, 'claude-code')).state, 'Operational', 'after a successful run through Noema');
  });

  await test('CLAUDE CODE: the Coding Agent delegates the turn — the runtime works with its own tools in the project', async () => {
    const si = require('../../src/sessionintel');
    const set = await si.set(app, app.session, { lane: 'coding', value: 'claude-code/sonnet', scope: 'session' });
    assert.ok(set.ok, set.why);
    const rd = require('../../src/runtimedispatch');
    assert.strictEqual(rd.routes(app, {}).yes, true);
    app.session.thread = 'chat';
    assert.strictEqual(rd.routes(app, {}).yes, false, 'the Chat view is the BOT’s');
    app.session.thread = 'coding';
    const evs = [];
    for await (const ev of rd.run(app, 'fix the thing', {}, {})) evs.push(ev);
    assert.ok(evs.some((e) => e.type === 'notice' && /Claude Code · Edit src\/a\.js/.test(e.message)), 'the runtime’s own tool use is shown');
    assert.ok(evs.some((e) => e.type === 'text' && /Echo: fix the thing/.test(e.chunk)));
    const done = evs.find((e) => e.type === 'done');
    assert.strictEqual(done.record.stopReason, 'end'); assert.strictEqual(done.record.runtime, 'claude-code');
    const argv = fs.readFileSync(claudeArgs, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a[0] === '-p').pop();
    assert.ok(argv.includes('--permission-mode') && !argv.includes('--tools'), 'agent mode keeps the runtime’s own tools');
  });

  await test('CLAUDE CODE: cancel stops the registered process; a failed run is a provider failure, never silence', async () => {
    const cc = require('../../src/drivers/claudecode');
    const ctl = new AbortController();
    let got = '';
    const t0 = Date.now();
    await assert.rejects(async () => {
      for await (const ev of cc.runStream({ cfg: app.cfg }, { prompt: 'SLOW please', mode: 'chat', signal: ctl.signal })) { if (ev.type === 'text') { got += ev.chunk; if (got.length > 10) ctl.abort(); } }
    }, (e) => e.cancelled === true);
    assert.ok(Date.now() - t0 < 3000, 'stopped promptly');
    await assert.rejects(async () => { for await (const ev of cc.runStream({ cfg: app.cfg }, { prompt: 'FAIL', mode: 'chat' })) void ev; }, /Claude Code: model overloaded/);
    assert.ok(!require('../../src/runtimeregistry').list().some((r) => r.purpose === 'runtime:claude-code' && r.alive), 'no runtime process left behind');
  });

  await test('OPENCODE: models and sessions from OpenCode’s own server (opencode serve) — runtime-bound free models told apart', async () => {
    const r = await ra.report(app, 'opencode', { refresh: true });
    assert.strictEqual(r.discovery.version, 'opencode v9.0.0');
    assert.match(r.detail.via, /opencode serve/);
    const byId = Object.fromEntries(r.detail.models.map((m) => [m.upstream, m.entitlement.kind]));
    assert.strictEqual(byId['opencode/big-pickle'], 'runtime-bound');
    assert.strictEqual(byId['opencode-go/space-bunny-free'], 'runtime-bound', 'a -free model under OpenCode Go is runtime-bound too');
    assert.strictEqual(byId['opencode-go/glm-5.3'], 'subscription');
    assert.deepStrictEqual(r.detail.providers.map((p) => p.name), ['OpenCode Go', 'mylocal']);
    assert.ok(!JSON.stringify(r).includes('SHOULD-NEVER-BE-READ'), 'the bridge never reads OpenCode’s provider settings');
    require('../../src/drivers/opencodeserver').stop();
  });

  await test('OPENCODE: a runtime-bound model runs INSIDE OpenCode — a real session on Noema’s own opencode serve; usage from the session', async () => {
    const provider = require('../../src/provider');
    const pc = provider.resolve({ connections: {}, model: 'opencode/opencode/big-pickle', runtimes: app.cfg.runtimes });
    assert.strictEqual(pc.runtime, 'opencode');
    let text = ''; let usage = null;
    for await (const ev of provider.chat(pc, [{ role: 'user', content: 'hello there' }], { role: 'bot', sessionId: 's-oc' })) { if (ev.type === 'text') text += ev.chunk; if (ev.type === 'usage') usage = ev; }
    assert.ok(text.includes('OpenCode (big-pickle) says: hello there'), text);
    assert.strictEqual(usage.inputTokens, 900); assert.strictEqual(usage.cacheReadTokens, 200); assert.match(usage.runtime.session, /^ses_/);
    assert.match(usage.costBasis, /OpenCode/); assert.strictEqual(usage.runtime.via, 'opencode serve');
    // THE SERVER THIS STARTED goes with it — left running, it held the unit runner open after its last test.
    require('../../src/drivers/opencodeserver').stop();
  });

  await test('ZCODE: the runtime stays DETECTABLE (protocol, usage, models, plan status) — but Noema shows no Start Plan: Z.ai is API-only (2026-09-29)', async () => {
    const zhome = tmpdir('zhome-');
    fs.mkdirSync(path.join(zhome, '.zcode', 'v2'), { recursive: true });
    fs.writeFileSync(path.join(zhome, '.zcode', 'v2', 'coding-plan-cache.json'), JSON.stringify({ version: 1, entryStatus: { updatedAt: 1789478471833, items: { 'builtin:zai-start-plan': { status: 'unavailable', reason: 'coding_plan_not_entitled' }, 'builtin:zai-coding-plan': { status: 'available' } } } }));
    const prev = process.env.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_DATA_BASE_DIR = zhome;
    try {
      const r = await ra.report(app, 'zcode', { refresh: true });
      assert.strictEqual(r.discovery.version, '9.1.0');
      assert.strictEqual(r.telemetry.ok, true);
      assert.strictEqual(r.detail.usage.summary.totalTokens, 1500); assert.match(r.detail.usage.basis, /ZCode runtime/);
      assert.deepStrictEqual(r.detail.models.map((m) => m.id), ['zcode/p-omni/glm-free']);
      assert.strictEqual(r.detail.plan.startPlan.status, 'unavailable');
      assert.strictEqual(require('../../src/drivers/zcoderun').reasonText(r.detail.plan.startPlan.reason), 'not claimed on this account');
      assert.strictEqual(r.execution.startPlan.ok, false); assert.match(r.execution.startPlan.why, /inside the ZCode app/);
      assert.strictEqual(r.execution.agent.ok, false);
      const g = require('../harness/../../src/harnessapp/usageroutes').grouped(app);
      assert.strictEqual(g.plans.find((p) => p.id === 'zcode:start-plan'), undefined, 'Noema does not present the ZCode Start Plan');
    } finally { if (prev === undefined) delete process.env.ZCODE_DATA_BASE_DIR; else process.env.ZCODE_DATA_BASE_DIR = prev; }
  });

  await test('ZCODE: its models are NOT a Noema route any more (Z.ai is API-only); the driver still refuses the Start Plan before ZCode starts', async () => {
    const provider = require('../../src/provider');
    const pc = provider.resolve({ connections: {}, model: 'zcode/p-omni/glm-free', runtimes: app.cfg.runtimes });
    assert.notStrictEqual(pc.runtime, 'zcode', 'no ZCode runtime route');
    const zc = require('../../src/drivers/zcoderun');
    await assert.rejects(async () => { for await (const ev of zc.chat({ model: 'zcode/account:zai-start-plan/GLM-5.3-Flash' }, [{ role: 'user', content: 'x' }], { app: { cfg: app.cfg } })) void ev; }, /only inside the ZCode app/);   // refused by LAIN before ZCode is started
  });

  await test('FREEBUFF IS GONE (8.3): no adapter, no account driver, no discovery home, no module', async () => {
    assert.strictEqual(ra.get('freebuff'), null, 'no runtime adapter');
    assert.ok(!ra.all().some((a) => a.id === 'freebuff'));
    assert.strictEqual(require('../../src/providerdrivers').get('freebuff'), null, 'no account driver');
    assert.ok(!fs.existsSync(path.join(__dirname, '..', '..', 'src', 'drivers', 'freebuffrun.js')), 'the driver module is deleted');
    const r = await ra.report(app, 'freebuff', { refresh: true }).catch(() => null);
    assert.ok(!r || !r.discovery || !r.discovery.installed, 'nothing is discovered');
  });

  await test('OLLAMA: a configured endpoint (never swapped for localhost); its own metadata and counters, nothing invented', async () => {
    const ol = require('../../src/local/ollama');
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => { b += d; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/version') return res.end('{"version":"0.12.0"}');
        if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3:4b', size: 2600000000, modified_at: '2026-09-01T10:00:00Z', digest: 'd1', details: { family: 'qwen3', parameter_size: '4.0B', quantization_level: 'Q4_K_M', format: 'gguf' } }, { name: 'nomic-embed', size: 1, details: {} }] }));
        if (req.url === '/api/show') { const n = JSON.parse(b).model; return res.end(JSON.stringify(n === 'qwen3:4b' ? { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 } } : { capabilities: ['embedding'], model_info: {} })); }
        if (req.url === '/api/ps') return res.end('{"models":[]}');
        if (req.url === '/api/chat') {
          const body = JSON.parse(b);
          res.setHeader('content-type', 'application/x-ndjson');
          if (body.tools) { res.write(`${JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'x' } } }] }, done: false })}\n`); }
          else res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'hi from ollama' }, done: false })}\n`);
          res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 6, prompt_eval_duration: 150e6, eval_duration: 60e6, load_duration: 5e6, total_duration: 220e6 })}\n`);
          return undefined;
        }
        res.statusCode = 404; return res.end('{}');
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const ep = `http://127.0.0.1:${srv.address().port}`;
    try {
      const oapp = { cfg: { local: { ollama: { endpoint: ep } } } };
      const info = await ol.refresh(oapp);
      assert.strictEqual(info.running, true); assert.strictEqual(info.endpoint, ep); assert.strictEqual(info.endpointConfigured, true);
      const q = info.models.find((m) => m.name === 'qwen3:4b');
      assert.strictEqual(q.contextLength, 40960); assert.strictEqual(q.parameterSize, '4.0B'); assert.strictEqual(q.tools, true); assert.strictEqual(q.vision, false);
      const e = info.models.find((m) => m.name === 'nomic-embed');
      assert.strictEqual(e.contextLength, null, 'unknown stays unknown'); assert.strictEqual(e.embedding, true);
      const conn = require('../../src/runtimeconnections').connections(null).find((c) => c.id === 'local:ollama');
      assert.ok(conn.models.find((m) => m.id === 'ollama/qwen3:4b').roles.includes('BOT'));
      assert.ok(!conn.models.find((m) => m.id === 'ollama/qwen3:4b').roles.includes('AGENT'), 'not AGENT until verified');
      assert.deepStrictEqual(conn.models.find((m) => m.id === 'ollama/nomic-embed').roles, ['EMBEDDING']);
      const evs = [];
      for await (const ev of ol.chat({ model: 'ollama/qwen3:4b' }, [{ role: 'user', content: 'hi' }], { app: oapp })) evs.push(ev);
      const u = evs.find((x) => x.type === 'usage');
      assert.strictEqual(evs.filter((x) => x.type === 'text').map((x) => x.chunk).join(''), 'hi from ollama');
      assert.strictEqual(u.local.runtime, 'Ollama runtime'); assert.strictEqual(u.local.tokPerSec, 100); assert.strictEqual(u.local.promptMs, 150); assert.strictEqual(u.cacheReported, false);
      const tevs = [];
      for await (const ev of ol.chat({ model: 'ollama/qwen3:4b' }, [{ role: 'user', content: 'x' }], { app: oapp, tools: [{ name: 'read_file', description: '', parameters: {} }] })) tevs.push(ev);
      assert.strictEqual(tevs.find((x) => x.type === 'tool_calls').calls[0].name, 'read_file');
    } finally { srv.close(); }
  });

  await test('STATES: installed ≠ usable — the three answers compose into one honest state', () => {
    const a = { id: 'x' };
    const no = { chat: { ok: false }, agent: { ok: false } };
    const yes = { chat: { ok: true }, agent: { ok: false } };
    assert.strictEqual(ra.stateOf(a, { installed: false }, null, no), 'Not installed');
    assert.strictEqual(ra.stateOf(a, { installed: true }, null, yes), 'Detected');
    assert.strictEqual(ra.stateOf(a, { installed: true }, { ok: true }, no), 'Telemetry only');
    assert.strictEqual(ra.stateOf(a, { installed: true }, { ok: true }, yes), 'Ready');
    assert.strictEqual(ra.stateOf(a, { installed: true }, { ok: true, lastRun: { ok: true } }, yes), 'Operational');
    assert.strictEqual(ra.stateOf(a, { installed: true }, { ok: true, lastRun: { ok: false } }, yes), 'Degraded');
  });

  await test('DISCONNECT FROM Noema: its models stop being offered; the runtime itself is untouched; reconnect restores them', async () => {
    const R = require('../../src/harnessapp/fabricroutes').ROUTES;
    const off = await R['POST /api/runtimes/disconnect'](app, { id: 'claude-code' });
    assert.ok(off.body.ok); assert.match(off.body.note, /still signed in/);
    assert.deepStrictEqual(ra.servableModels(app, 'claude-code'), []);
    assert.ok(!require('../../src/runtimeconnections').connections(app).some((c) => c.id === 'runtime:claude-code'));
    assert.strictEqual((await ra.report(app, 'claude-code')).state, 'Disconnected from Noema');
    const argsBefore = fs.readFileSync(claudeArgs, 'utf8');
    assert.ok(!/logout/.test(argsBefore), 'Noema never ran a sign-out');
    await R['POST /api/runtimes/disconnect'](app, { id: 'claude-code', reconnect: true });
    assert.ok(ra.servableModels(app, 'claude-code').length > 0);
  });

  await test('TRANSPORT: an API route without a key is still refused; only runtime routes need none', () => {
    const provider = require('../../src/provider');
    assert.match(provider.credentialHint({ protocol: 'chat', provider: 'openai', apiKey: '' }), /No credential for provider 'openai'/);
    assert.strictEqual(provider.credentialHint({ protocol: 'runtime', provider: 'llama.cpp', apiKey: '' }), null);
    delete process.env.FAKE_CLAUDE_ARGS;
  });
};
