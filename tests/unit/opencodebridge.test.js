'use strict';

/**
 * THE OPENCODE RUNTIME BRIDGE — runtime-bound models run only inside OpenCode.
 *
 *   - every direct HTTP route to an OpenCode free model is refused before a byte
 *     is sent (Zen's endpoint, a router's OpenCode namespace, a model prefix)
 *   - the bridge is OpenCode's own `opencode serve`: loopback, ephemeral port,
 *     a per-start password, owned by the runtime registry, stopped with LAIN
 *   - BOT answers in a session with side effects denied; the Agent works in the
 *     project; cancel interrupts the OpenCode session; sessions are read
 *     through OpenCode's API (never its storage)
 * Fakes only (tests/fixtures/runtimes/fakeopencode.js serve).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const { shim, FIX } = require('../fixtures/runtimes/shim');
  const { App } = require('../../src/app');
  const provider = require('../../src/provider');
  const oc = require('../../src/drivers/opencodeserver');
  const rb = require('../../src/runtimebound');
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('ocb-') });
  app.cfg.runtimes = { opencode: { binary: shim(tmpdir('ocbin-'), 'opencode', path.join(FIX, 'fakeopencode.js')) } };
  const sessLog = path.join(tmpdir('ocsess-'), 's.jsonl');
  process.env.FAKE_OPENCODE_SESSIONS = sessLog;
  const sessionsSeen = () => fs.readFileSync(sessLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  await test('GUARD: a runtime-bound OpenCode model is refused on every direct HTTP route — before any request', () => {
    assert.ok(rb.check({ conn: { baseUrl: 'https://opencode.ai/zen/v1', protocol: 'chat', id: 'lain:opencode.ai' }, connectionId: 'lain:opencode.ai', model: 'big-pickle' }), 'Zen endpoint + big-pickle');
    assert.ok(rb.check({ conn: { baseUrl: 'https://opencode.ai/zen/go/v1', protocol: 'chat' }, connectionId: 'lain:opencode', model: 'space-bunny-free' }), 'Go endpoint + a -free model');
    assert.ok(rb.check({ conn: { baseUrl: 'http://localhost:20128/v1', protocol: 'chat' }, connectionId: 'lain:localhost:oczen', model: 'space-bunny-free' }), 'a local router forwarding OpenCode’s free tier');
    assert.ok(rb.check({ conn: { baseUrl: 'http://localhost:20128/v1', protocol: 'chat' }, connectionId: 'lain:localhost', model: 'opencode/big-pickle', upstreamId: 'opencode/big-pickle' }), 'a prefixed model id');
    assert.strictEqual(rb.check({ conn: { baseUrl: 'https://opencode.ai/zen/v1', protocol: 'chat' }, connectionId: 'lain:opencode.ai', model: 'gpt-6-luna' }), null, 'a paid Zen model on the API is not runtime-bound');
    assert.strictEqual(rb.check({ conn: { baseUrl: 'https://api.b.ai/v1', protocol: 'chat' }, connectionId: 'lain:bai', model: 'mimo-v2.6-flash-free' }), null, 'another provider’s own "-free" model is its business');
    assert.strictEqual(rb.check({ conn: { protocol: 'runtime', id: 'runtime:opencode' }, connectionId: 'runtime:opencode', model: 'opencode/opencode/big-pickle' }), null, 'the runtime route is the right one');
    const pc = provider.resolve({ connections: { 'lain:opencode.ai': { provider: 'opencode.ai', baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'sk-test-0123456789abcdef0123', models: ['big-pickle', 'gpt-6-luna'] } }, model: 'big-pickle', connection: 'lain:opencode.ai' });
    assert.strictEqual(pc.protocol, null, 'no protocol: nothing can be sent');
    assert.strictEqual(pc.unavailable.kind, 'runtime-bound');
    assert.match(provider.credentialHint(pc), /runtime-bound: OpenCode serves it only inside OpenCode/);
    const paid = provider.resolve({ connections: { 'lain:opencode.ai': { provider: 'opencode.ai', baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'sk-test-0123456789abcdef0123', models: ['big-pickle', 'gpt-6-luna'] } }, model: 'gpt-6-luna', connection: 'lain:opencode.ai' });
    assert.strictEqual(paid.protocol, 'chat', 'the paid API route still works');
  });

  await test('GUARD: the picker lists an HTTP-routed free model as runtime-bound — never choosable there', async () => {
    const inv = require('../../src/modelinventory');
    const a = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('ocinv-') });
    a.cfg.connections = { 'lain:opencode.ai': { provider: 'opencode.ai', baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'sk-test-0123456789abcdef0123', models: ['big-pickle'] } };
    const rows = (await inv.search(a, { lane: 'coding', query: '' })).rows.filter((r) => r.modelId === 'big-pickle');
    assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].availability, 'RUNTIME_BOUND'); assert.deepStrictEqual(rows[0].roles, []);
    const sel = await inv.select(a, { lane: 'coding', source: 'lain', modelId: 'big-pickle' });
    assert.strictEqual(sel.ok, false, 'refused for the Agent');
  });

  await test('BRIDGE: LAIN’s own opencode serve — loopback, ephemeral port, per-start password, registered, reused', async () => {
    const bin = app.cfg.runtimes.opencode.binary;
    const s = await oc.ensure(bin);
    assert.ok(s.port > 0); assert.ok(s.password.length >= 24);
    const rec = require('../../src/runtimeregistry').list().find((r) => r.pid === s.child.pid);
    assert.ok(rec && rec.purpose === 'runtime:opencode-server', 'registered with LAIN ownership');
    assert.ok(/--hostname 127\.0\.0\.1/.test(rec.command), 'bound to loopback');
    const r = await fetch(`http://127.0.0.1:${s.port}/api/info`);
    assert.strictEqual(r.status, 401, 'the server refuses anyone without LAIN’s password');
    const again = await oc.ensure(bin);
    assert.strictEqual(again.child.pid, s.child.pid, 'one server, reused');
    const models = await oc.models(s, tmpdir('ocm-'));
    assert.deepStrictEqual(models.map((m) => `${m.providerID}/${m.id}`), ['opencode/big-pickle', 'opencode-go/space-bunny-free', 'opencode-go/glm-5.3'], 'models, after the server finished loading');
  });

  await test('TELEMETRY FIRST: the bridge lists what the runtime serves', async () => { const r = await require('../../src/runtimeadapters').report(app, 'opencode', { refresh: true }); assert.ok(r.execution.chat.ok, JSON.stringify(r.execution)); });

  await test('BRIDGE: BOT mode denies side effects (not everything — the free tier requires an OpenCode agent request)', async () => {
    const pc = provider.resolve({ connections: {}, model: 'opencode/opencode-go/space-bunny-free', runtimes: app.cfg.runtimes });
    let text = '';
    for await (const ev of provider.chat(pc, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'two plus two' }], { role: 'bot' })) if (ev.type === 'text') text += ev.chunk;
    assert.match(text, /space-bunny-free\) says: two plus two/);
    const last = sessionsSeen().pop();
    assert.strictEqual(last.agent, 'build');
    const denied = last.permissions.filter((p) => p.effect === 'deny').map((p) => p.action).sort();
    assert.deepStrictEqual(denied, ['bash', 'edit', 'patch', 'task', 'webfetch', 'write']);
    assert.ok(!last.permissions.some((p) => p.action === '*'), 'never deny-all (OpenCode would refuse the free model)');
    assert.deepStrictEqual(last.model, { providerID: 'opencode-go', id: 'space-bunny-free' });
  });

  await test('BRIDGE: the Agent works in the project folder with OpenCode’s own tools; cancel interrupts the session', async () => {
    const proj = tmpdir('ocproj-');
    const ocrun = require('../../src/drivers/opencoderun');
    const evs = [];
    for await (const ev of ocrun.agent(app, { prompt: 'fix it', model: 'opencode/opencode/big-pickle', cwd: proj })) evs.push(ev);
    assert.ok(evs.some((e) => e.type === 'runtime_tool' && e.name === 'edit'), 'OpenCode’s own tool use is surfaced');
    const s = sessionsSeen().pop();
    assert.strictEqual(path.resolve(s.dir), path.resolve(proj));
    assert.ok(!s.permissions.some((p) => p.action === 'edit'), 'the Agent may edit');
    const ctl = new AbortController();
    let got = '';
    await assert.rejects(async () => {
      for await (const ev of ocrun.runStream(app, { prompt: 'SLOW please', model: 'opencode/opencode/big-pickle', mode: 'chat', signal: ctl.signal })) { if (ev.type === 'text') { got += ev.chunk; if (got.length > 8) ctl.abort(); } }
    }, (e) => e.cancelled === true);
  });

  await test('BRIDGE: a failed OpenCode session is an error with OpenCode’s own reason — never an empty answer', async () => {
    const s = await oc.ensure(app.cfg.runtimes.opencode.binary);
    // Simulate what OpenCode does to a free model when EVERYTHING is denied (the fake models the rule).
    const created = await oc.call(s, 'POST', '/api/session', { directory: oc.scratchDir(), body: { agent: 'build', model: { providerID: 'opencode', id: 'big-pickle' }, permissions: [{ action: '*', resource: '*', effect: 'deny' }], location: { directory: oc.scratchDir() } } });
    assert.ok(created.data.id);
    await oc.call(s, 'POST', `/api/session/${created.data.id}/prompt`, { directory: oc.scratchDir(), body: { text: 'hi' } });
    await new Promise((r) => setTimeout(r, 200));
    const msgs = await oc.call(s, 'GET', `/api/session/${created.data.id}/message`, { directory: oc.scratchDir() });
    assert.match(msgs.data.find((m) => m.error).error.message, /only be used from within OpenCode/);
  });

  await test('VERIFY: each runtime model is tested through the real runtime — AGENT only after it did real work', async () => {
    const rv = require('../../src/runtimeverify');
    const ra = require('../../src/runtimeadapters');
    const before = ra.servableModels(app, 'opencode').find((m) => m.id === 'opencode/opencode/big-pickle');
    assert.ok(!before.roles.includes('AGENT'), 'not an Agent before it was verified');
    assert.ok(before.roles.includes('BOT'));
    const r = await rv.verify(app, 'opencode', 'opencode/opencode/big-pickle');
    assert.strictEqual(r.chat, true, JSON.stringify(r.detail)); assert.strictEqual(r.agent, true, JSON.stringify(r.detail));
    const after = ra.servableModels(app, 'opencode').find((m) => m.id === 'opencode/opencode/big-pickle');
    assert.ok(after.roles.includes('AGENT'), 'AGENT after a verified piece of work');
    const other = ra.servableModels(app, 'opencode').find((m) => m.id === 'opencode/opencode-go/glm-5.3');
    assert.ok(!other.roles.includes('AGENT'), 'another model is not assumed to be an Agent');
  });

  await test('SESSIONS: OpenCode’s sessions are read through its API — Resume in OpenCode / Continue in LAIN, never its storage', async () => {
    const ocrun = require('../../src/drivers/opencoderun');
    const list = await ocrun.listSessions(app);
    assert.ok(list.length >= 1 && list.every((x) => /^ses_/.test(x.id)));
    const msgs = await ocrun.readSession(app, list[0].id);
    assert.ok(Array.isArray(msgs));
    // AS EXTERNAL SESSIONS (Session › Native): the open project's OpenCode sessions, resumable in OpenCode.
    const ext = require('../../src/externalsessions');
    const seen = await ext.list(app);
    const mine = seen.sessions.filter((x) => x.runtime === 'opencode');
    assert.ok(mine.length >= 1, JSON.stringify(seen.errors));
    assert.strictEqual(seen.adapters.opencode.level, 'SUPPORTED');
    const res = ext.resumeOriginal(app, { origin: mine[0].origin, cwd: mine[0].cwd });
    assert.strictEqual(res.command, `opencode --session ${mine[0].id}`);
    const cont = await ext.continueInLain(app, { origin: mine[0].origin, cwd: mine[0].cwd });
    if (cont.ok) assert.match(cont.origin, /^external:opencode:/);
    else assert.match(cont.why, /no messages|did not return/);
  });

  await test('OWNERSHIP: stopping the bridge stops exactly LAIN’s server; nothing is left running', async () => {
    const s = oc._server();
    const pid = s.child.pid;
    oc.stop();
    await new Promise((r) => setTimeout(r, 400));
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    assert.strictEqual(alive, false);
    assert.strictEqual(oc.status().running, false);
    delete process.env.FAKE_OPENCODE_SESSIONS;
  });
};
