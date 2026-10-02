'use strict';

/**
 * PHASE 8.1 CORE — fixtures only, no real provider, no real 9Router account, no quota.
 *
 *   LAIN SERVER     loopback by default; a LAIN access token is required; /v1/models
 *                   lists lain/ aliases; one chat completion goes through the canonical
 *                   request path (a usage receipt with origin "serve"); the upstream key
 *                   never appears; a remote bind is refused without allowRemote; stop is clean
 *   9ROUTER         status + providers from its PUBLIC catalog only (the dashboard API is
 *                   never called); adopt reuses the existing connection; detach leaves 9Router alone
 *   SOURCES         each source lists only the actions that apply; remove-credential keeps
 *                   the route; remove-source needs confirmation
 *   MCP & SKILLS    a fixture MCP server connects and lists capabilities; its tools reach the
 *                   model vocabulary (read-only vs asking); disable / enable / remove; a
 *                   secret env value is stored in the secret store, not the config; a skill
 *                   is validated, added disabled, enabled, announced to the model, removed
 *   USAGE INDEX     rows equal a full re-read; only appended bytes are parsed; the hourly
 *                   buckets agree with the rows and survive a new process
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { test, tmpdir, writeScript } = require('../helpers');

module.exports = async function () {
  const { App } = require('../../src/app');
  const { ROUTES } = require('../../src/harnessapp/routes');
  const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };
  const mk = () => new App({ out, interactive: false, cwd: tmpdir('p81-') });
  const call = (app, k, body) => ROUTES[`POST ${k}`](app, body || {});
  const req = (port, method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });

  await test('LAIN SERVER: loopback, token required, lain/ aliases, one request through the canonical path, no upstream key, clean stop', async () => {
    const serve = require('../../src/serve');
    const app = mk();
    const UPSTREAM = 'sk-upstream-NEVER-LEAVES-9f8e7d6c5b4a';
    app.cfg.connections = { 'lain:fixture': { baseUrl: 'https://fixture.invalid/v1', auth: 'api_key', apiKey: UPSTREAM, models: ['fixture-model'] } };
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('p81-mock-'), [{ text: 'Hello from LAIN.' }]);
    try {
      const remote = await serve.start(app, { host: '0.0.0.0', port: 0 });
      assert.strictEqual(remote.ok, false, 'a non-loopback bind needs allowRemote');
      const r = await serve.start(app, { port: 0 });
      assert.ok(r.ok, r.why);
      assert.strictEqual(r.host, '127.0.0.1', 'loopback by default');
      const port = r.port;
      assert.strictEqual((await req(port, 'GET', '/v1/models')).status, 401, 'no token, no models');
      const tok = serve.token({ create: false });
      assert.match(tok, /^lain_/);
      const auth = { authorization: `Bearer ${tok}` };
      const models = await req(port, 'GET', '/v1/models', null, auth);
      assert.strictEqual(models.status, 200);
      assert.ok(models.json.data.some((m) => m.id === 'lain/fixture-model'), models.text.slice(0, 300));
      const before = require('../../src/usage').read({}).length;
      const c = await req(port, 'POST', '/v1/chat/completions', { model: 'lain/fixture-model', messages: [{ role: 'user', content: 'hi' }] }, auth);
      assert.strictEqual(c.status, 200, c.text);
      assert.strictEqual(c.json.choices[0].message.content, 'Hello from LAIN.');
      const rows = require('../../src/usage').read({});
      assert.strictEqual(rows.length, before + 1, 'one model request, recorded by the one envelope');
      assert.match(rows[rows.length - 1].origin, /LAIN Server/, 'the receipt says it came from the LAIN server');
      assert.ok(!c.text.includes(UPSTREAM) && !models.text.includes(UPSTREAM), 'the upstream key never leaves LAIN');
      const unknown = await req(port, 'POST', '/v1/chat/completions', { model: 'lain/nope', messages: [] }, auth);
      assert.strictEqual(unknown.status, 404);
      const st = (await call(app, '/api/server/status')).body.server;
      assert.deepStrictEqual([st.running, st.requests >= 3, st.token.present, Boolean(st.token.masked) && !String(st.token.masked).includes(tok)], [true, true, true, true]);
      await serve.stop();
      assert.strictEqual(serve.status(app).running, false);
      await assert.rejects(() => req(port, 'GET', '/health'), 'nothing listens after stop');
    } finally { await serve.stop(); delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; }
  });

  await test('9ROUTER: providers from the public catalog only; adopt reuses the connection; detach leaves 9Router alone', async () => {
    const hits = [];
    const fake = http.createServer((q, s) => {
      hits.push(q.url);
      if (q.url === '/api/health') { s.end('{"ok":true}'); return; }
      if (q.url === '/v1/models') { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ object: 'list', data: [{ id: 'ag/gemini-3-flash', capabilities: { tools: true } }, { id: 'ag/gemini-3-pro' }, { id: 'cx/gpt-5.5' }, { id: 'agcc/claude-opus-4-8' }, { id: 'openrouter/x' }] })); return; }
      s.statusCode = 401; s.end('{"error":"unauthorized"}');
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const port = fake.address().port;
    try {
      const app = mk();
      // NO 9ROUTER CONNECTION YET (what this test is about) — whatever an earlier test saved to the shared test home.
      app.cfg.connections = {}; app.cfg.ninerouter = { adopted: {} };
      // A 9Router connection on its usual port is recognised; here the fixture's port stands in via the URL.
      process.env.LAIN_NINEROUTER_URL = `http://127.0.0.1:${port}/v1`;
      const p = await call(app, '/api/ninerouter/providers');
      assert.strictEqual(p.code, 200, JSON.stringify(p.body));
      const labels = p.body.providers.map((x) => `${x.prefix}:${x.label}:${x.count}`);
      assert.ok(labels.includes('ag:Antigravity:2') && labels.includes('cx:Codex:1') && labels.includes('agcc:Claude (Antigravity):1'), labels.join(' '));
      assert.ok(hits.every((u) => u === '/api/health' || u === '/v1/models'), `only the public endpoints: ${hits.join(', ')}`);
      const a = await call(app, '/api/sources/action', { kind: 'adopt-9router', id: '9router:ag' });
      assert.strictEqual(a.code, 200, JSON.stringify(a.body));
      assert.ok(app.cfg.connections['lain:9router'], 'a connection to 9Router is created when there is none');
      assert.ok(!JSON.stringify(app.cfg).match(/access_token|refresh_token/), 'no 9Router credential was copied');
      const list = await call(app, '/api/sources/list');
      const row = list.body.connected.find((x) => x.id === '9router:ag');
      assert.deepStrictEqual(row.actions.map((x) => x.kind), ['detach-9router']);
      const d = await call(app, '/api/sources/action', { kind: 'detach-9router', id: '9router:ag' });
      assert.match(d.body.note, /stays connected in 9Router/);
      assert.ok(!require('../../src/ninerouter').adopted(app).length);
      assert.ok(!hits.some((u) => /^\/api\/(providers|oauth|keys|settings)/.test(u)), '9Router\'s dashboard API is never called');
    } finally { delete process.env.LAIN_NINEROUTER_URL; await new Promise((r) => fake.close(r)); }
  });

  await test('SOURCES: only the actions that apply; removing a credential keeps the route; removing a source needs confirmation and never revokes the account', async () => {
    const app = mk();
    const creds = require('../../src/credentials');
    const ref = creds.ref('lain-fixture', 'api_key');
    creds.store(ref, 'sk-fixture-000000000000000');
    app.cfg.connections = { 'lain:fixture': { baseUrl: 'https://api.example.invalid/v1', auth: 'api_key', credentialRef: ref }, 'lain:env': { baseUrl: 'https://env.example.invalid/v1', auth: 'api_key', envKey: 'FIXTURE_KEY' } };
    const list = (await call(app, '/api/sources/list')).body.connected;
    assert.deepStrictEqual(list.find((x) => x.id === 'lain:fixture').actions.map((a) => a.kind), ['remove-credential', 'remove-source']);
    assert.deepStrictEqual(list.find((x) => x.id === 'lain:env').actions.map((a) => a.kind), ['remove-source'], 'no stored credential, no "remove credential"');
    assert.ok(list.every((x) => x.actions.every((a) => a.explains)), 'every action says what it does');
    assert.strictEqual((await call(app, '/api/sources/action', { kind: 'remove-credential', id: 'lain:fixture' })).code, 428, 'asks first');
    const rc = await call(app, '/api/sources/action', { kind: 'remove-credential', id: 'lain:fixture', confirm: true });
    assert.strictEqual(rc.code, 200);
    assert.ok(app.cfg.connections['lain:fixture'], 'the route stays');
    assert.strictEqual(creds.resolve(ref), '', 'the key is gone');
    assert.strictEqual((await call(app, '/api/sources/action', { kind: 'remove-source', id: 'lain:env' })).code, 428);
    const rs = await call(app, '/api/sources/action', { kind: 'remove-source', id: 'lain:env', confirm: true });
    assert.strictEqual(rs.code, 200, JSON.stringify(rs.body));
    assert.match(rs.body.note, /not revoked/);
    assert.ok(!app.cfg.connections['lain:env']);
  });

  await test('MCP: a fixture server connects, lists capabilities, its tools reach the model (read-only vs asking), disable / enable / remove; a secret env value is kept out of the config', () => require('../helpers').legacyOnly(async () => {   // LEGACY path only
    const app = mk();
    const connsBefore = JSON.stringify(app.cfg.connections || {});
    const log = path.join(tmpdir('mcp-log-'), 'log.txt');
    const server = path.join(__dirname, '..', 'fixtures', 'mcp', 'fakemcp.js');
    const add = await call(app, '/api/integrations/mcp/add', { name: 'Godot MCP', transport: 'stdio', command: [process.execPath, server], env: { FAKE_MCP_LOG: log, FAKE_TOKEN: 'godot-secret-123456' }, secretEnv: ['FAKE_TOKEN'] });
    assert.strictEqual(add.code, 200, JSON.stringify(add.body));
    const id = add.body.id;
    const cfgText = JSON.stringify(app.cfg.integrations);
    assert.ok(!cfgText.includes('godot-secret-123456'), 'the secret is not in the config');
    assert.strictEqual(add.body.server.env.FAKE_TOKEN.secret, true);
    const c = await call(app, '/api/integrations/mcp/connect', { id });
    assert.strictEqual(c.code, 200, JSON.stringify(c.body));
    assert.deepStrictEqual(c.body.server.capabilities.tools.map((t) => [t.name, t.readOnly]), [['echo', true], ['scene_add', false]]);
    assert.strictEqual(c.body.server.capabilities.resources[0].uri, 'godot://project');
    const tools = require('../../src/tools');
    const names = tools.names(app);
    const echo = names.find((n) => /__echo$/.test(n)); const add2 = names.find((n) => /__scene_add$/.test(n));
    assert.ok(echo && add2, names.filter((n) => n.startsWith('mcp__')).join(','));
    assert.strictEqual(tools.effect(echo, app), null, 'a read-only tool runs without asking');
    assert.strictEqual(tools.effect(add2, app), 'EXTERNAL', 'a tool that changes things asks first');
    const ran = await require('../../src/integrations').toolDefs(app)[echo].run({ text: 'hi' });
    assert.match(ran.output, /echo: \{"text":"hi"\} env=token-present/, 'the secret reached the server process, not the model');
    const dis = await call(app, '/api/integrations/mcp/enable', { id, enabled: false });
    assert.strictEqual(dis.body.server.state, 'DISABLED');
    assert.ok(!tools.names(app).some((n) => n.startsWith('mcp__')), 'a disabled server offers nothing');
    await call(app, '/api/integrations/mcp/enable', { id, enabled: true });
    const again = await call(app, '/api/integrations/mcp/connect', { id });
    assert.strictEqual(again.body.server.state, 'CONNECTED');
    const rm = await call(app, '/api/integrations/mcp/remove', { id });
    assert.strictEqual(rm.code, 200);
    assert.deepStrictEqual((await call(app, '/api/integrations/state')).body.mcp, []);
    assert.ok(!tools.names(app).some((n) => n.startsWith('mcp__')));
    assert.ok(fs.readFileSync(log, 'utf8').includes('tools/list'));
    assert.strictEqual(JSON.stringify(app.cfg.connections || {}), connsBefore, 'no model/provider state was touched');
  }));

  await test('SKILLS: validated before use, added disabled, enabled explicitly, announced to the model by name and path, removed', async () => {
    const app = mk();
    const dir = tmpdir('skill-');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: godot-scenes\ndescription: How to build Godot scenes with the Godot MCP\n---\n# Godot scenes\nSteps…\n');
    fs.writeFileSync(path.join(dir, 'helper.py'), 'print(1)\n');
    const bad = await call(app, '/api/integrations/skill/add', { path: tmpdir('empty-skill-') });
    assert.strictEqual(bad.code, 409);
    assert.match(bad.body.why, /SKILL\.md/);
    const a = await call(app, '/api/integrations/skill/add', { path: dir });
    assert.strictEqual(a.code, 200, JSON.stringify(a.body));
    assert.strictEqual(a.body.skill.enabled, false, 'added disabled');
    assert.ok(a.body.validation.warnings.some((w) => /never runs them on its own/.test(w)), 'scripts are named, not run');
    assert.ok(!/godot-scenes/.test(require('../../src/integrations').skillsPrompt(app)), 'a disabled skill is not announced');
    // PHASE 8.3: a skill carrying a script is enabled only with a confirm, after its files were shown.
    const unconfirmed = await call(app, '/api/integrations/skill/enable', { id: a.body.id, enabled: true });
    assert.strictEqual(unconfirmed.code, 409); assert.strictEqual(unconfirmed.body.needsConfirm, true);
    assert.deepStrictEqual(unconfirmed.body.scripts, ['helper.py'], 'the script is named before it is enabled');
    assert.ok(!/godot-scenes/.test(require('../../src/integrations').skillsPrompt(app)), 'still not announced');
    await call(app, '/api/integrations/skill/enable', { id: a.body.id, enabled: true, confirm: true });
    const p = require('../../src/integrations').skillsPrompt(app);
    assert.match(p, /godot-scenes: How to build Godot scenes/);
    // PHASE CAP (2026-10-02): the prompt names the skill; its body is read on demand (use_skill), so no path is sent.
    assert.match(p, /use_skill\(name\)|the Skill tool/);
    assert.ok(['use_skill', 'Skill'].some((n) => require('../../src/tools').names(app).includes(n)), 'the skill tool exists once a skill is enabled');
    assert.match(require('../../src/promptparts').durable(app, app.session).agents, /# Skills/);
    await call(app, '/api/integrations/skill/remove', { id: a.body.id });
    assert.deepStrictEqual((await call(app, '/api/skills')).body.skills, []);
    assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')), 'a local folder is never deleted');
  });

  await test('GITHUB SYNC: fast-forwards a clean clone; never overwrites local changes; leaves a conflict for the person (Abort restores); never resets', async () => {
    const { spawnSync } = require('child_process');
    const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
    Object.assign(process.env, { GIT_AUTHOR_NAME: 'LAIN Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'LAIN Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
    const gh = require('../../src/github');
    const base = tmpdir('sync-');
    const bare = path.join(base, 'remote.git');
    sh(base, 'init', '--bare', '-b', 'main', bare);
    const seed = path.join(base, 'seed'); sh(base, 'clone', bare, seed);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n'); sh(seed, 'add', '-A'); sh(seed, 'commit', '-m', 'first'); sh(seed, 'push', '-u', 'origin', 'HEAD:main');
    const mine = path.join(base, 'mine'); sh(base, 'clone', bare, mine);
    const other = path.join(base, 'other'); sh(base, 'clone', bare, other);
    const app = mk();
    // 1) the remote advances; my clone is clean -> Sync fast-forwards.
    fs.writeFileSync(path.join(other, 'b.txt'), 'from other\n'); sh(other, 'add', '-A'); sh(other, 'commit', '-m', 'other adds b'); sh(other, 'push');
    assert.strictEqual((await gh.action(app, mine, 'sync', {})).needsConfirm, true, 'Sync is an explicit action');
    let r = await gh.action(app, mine, 'sync', {}, { confirm: true });
    assert.ok(r.ok, r.why);
    assert.strictEqual(r.synced, 'fast-forward');
    assert.ok(fs.existsSync(path.join(mine, 'b.txt')));
    assert.strictEqual(gh.projectStatus(mine).state, 'UP_TO_DATE');
    // 2) an uncommitted edit to a file the remote also changed -> nothing is overwritten.
    fs.writeFileSync(path.join(other, 'a.txt'), 'remote edit\n'); sh(other, 'commit', '-am', 'remote edits a'); sh(other, 'push');
    fs.writeFileSync(path.join(mine, 'a.txt'), 'my local edit\n');
    r = await gh.action(app, mine, 'sync', {}, { confirm: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.localChanges, true, r.why);
    assert.strictEqual(fs.readFileSync(path.join(mine, 'a.txt'), 'utf8'), 'my local edit\n', 'the local change is untouched');
    // 3) committed, the histories diverge on the same line -> a conflict is LEFT for the person; Abort restores the commit.
    sh(mine, 'commit', '-am', 'my edit');
    const myHead = sh(mine, 'rev-parse', 'HEAD');
    r = await gh.action(app, mine, 'sync', {}, { confirm: true });
    assert.strictEqual(r.conflict, true, r.why);
    assert.strictEqual(r.state.state, 'CONFLICT');
    assert.deepStrictEqual(r.state.conflicts, ['a.txt']);
    const again = await gh.action(app, mine, 'sync', {}, { confirm: true });
    assert.match(again.why, /resolve/, 'Sync never resolves a conflict for you');
    const ab = await gh.action(app, mine, 'merge-abort', {}, { confirm: true });
    assert.ok(ab.ok, ab.why);
    assert.strictEqual(sh(mine, 'rev-parse', 'HEAD'), myHead, 'back to my commit - nothing reset away');
    assert.strictEqual(fs.readFileSync(path.join(mine, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'my local edit\n', 'my content is back (line endings aside)');
    assert.strictEqual(gh.projectStatus(mine).state, 'DIVERGED');
  });

  await test('BOTS: Connect keeps the bot where it is; status is the bot\'s own report — a live PID alone is never "working"; Migrate only when declared', async () => {
    let manifest = { state: 'working', task: 'triaging the support inbox', since: 1 };
    const fake = http.createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify(manifest)); });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${fake.address().port}/status`;
    try {
      const app = mk();
      const c = await call(app, '/api/bots/connect', { name: 'Support Bot', statusUrl: url, permissions: { schedules: true, delegate: false } });
      assert.strictEqual(c.code, 200, JSON.stringify(c.body));
      const id = c.body.id;
      assert.deepStrictEqual([c.body.bot.mode, c.body.bot.permissions.schedules, c.body.bot.permissions.delegate], ['connected', true, false]);
      assert.ok(require('../../src/connectedbots').may(app, id, 'schedules') && !require('../../src/connectedbots').may(app, id, 'delegate'));
      let st = (await call(app, '/api/bots/status', { id })).body.status;
      assert.deepStrictEqual([st.state, st.task, st.basis], ['WORKING', 'triaging the support inbox', 'reported by the bot']);
      const pidOnly = await call(app, '/api/bots/connect', { name: 'Local Bot', pid: process.pid });
      st = (await call(app, '/api/bots/status', { id: pidOnly.body.id })).body.status;
      assert.strictEqual(st.state, 'RUNNING', 'alive, but not claimed to be working');
      assert.match(st.basis, /not reported/);
      const refused = await call(app, '/api/bots/migrate', { id });
      assert.strictEqual(refused.code, 409);
      assert.match(refused.body.why, /does not declare a migration/);
      manifest = { state: 'idle', lainMigration: { name: 'Support Bot', instructions: 'Answer politely.', schedules: [{ when: 'weekdays 09:00', task: 'summarise the inbox' }] } };
      const m = await call(app, '/api/bots/migrate', { id });
      assert.strictEqual(m.code, 200, JSON.stringify(m.body));
      assert.strictEqual(app.cfg.bots.profiles['support-bot'].instructions, 'Answer politely.');
      assert.match(m.body.note, /not changed or stopped/);
      const rm = await call(app, '/api/bots/remove', { id });
      assert.match(rm.body.note, /keeps running/);
    } finally { await new Promise((r) => fake.close(r)); }
  });

  await test('PREVIEW SAY: a selected element targets its owning source; nothing selected targets the page shown now (Settings, not Home); one Coding request on the same session', async () => {
    const ws = require('../../src/workshop');
    const hc = require('../../src/harnesscontext');
    const was = { forApp: ws.forApp, selection: hc.selection };
    let url = 'http://127.0.0.1:5173/settings';
    ws.forApp = () => ({
      observations: () => ({ ok: true, url, viewport: 'desktop' }),
      element: async (cwd, sel) => ({ ok: true, element: { selector: sel, tag: 'input', id: 'search', name: 'Search', role: 'searchbox', rect: { w: 240, h: 36, x: 40, y: 88 } } }),
    });
    hc.selection = () => ({ kind: 'visual', visual: { sourceBinding: { component: { confidence: 'EXACT', candidates: [{ rel: 'src/SearchBar.tsx', hits: [{ line: 12 }] }] }, style: { file: 'src/search.css', line: 4, selector: '.search', confidence: 'LIKELY' } } } });
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('p81-prev-'), [{ text: 'Adjusting.' }, { text: 'Done.' }, { text: 'Done.' }]);
    try {
      const app = mk();
      await call(app, '/api/project/attach', { path: app.session.cwd });
      const id = app.session.id;
      const el = await call(app, '/api/preview/change', { text: 'move this down slightly and make it wider', selector: '#search' });
      assert.strictEqual(el.code, 200, JSON.stringify(el.body).slice(0, 300));
      assert.strictEqual(el.body.scope.kind, 'element');
      assert.match(el.body.sent, /selector {3}#search/);
      assert.match(el.body.sent, /component src\/SearchBar\.tsx:12/);
      assert.match(el.body.sent, /style {5}src\/search\.css:4/);
      assert.match(el.body.sent, /change only what owns this element/);
      for (let i = 0; i < 100 && app.abort; i++) await new Promise((x) => setTimeout(x, 30));
      const page = await call(app, '/api/preview/change', { text: 'make the heading larger' });
      assert.strictEqual(page.code, 200, JSON.stringify(page.body).slice(0, 300));
      assert.strictEqual(page.body.scope.kind, 'page');
      assert.match(page.body.sent, /page currently shown in the preview: \/settings/);
      assert.ok(!/\/home|Home/.test(page.body.sent.split('TARGET')[1].split('SCOPE')[0]), 'the request names Settings, not Home');
      assert.strictEqual(app.session.id, id, 'the same session');
      assert.strictEqual(app.session.thread, 'coding', 'a Coding Agent request');
      for (let i = 0; i < 100 && app.abort; i++) await new Promise((x) => setTimeout(x, 30));
      url = null;
      ws.forApp = () => ({ observations: () => ({ ok: false, why: 'closed' }) });
      assert.strictEqual((await call(app, '/api/preview/change', { text: 'x' })).code, 409, 'no preview, nothing sent');
    } finally { ws.forApp = was.forApp; hc.selection = was.selection; delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; }
  });

  await test('USAGE INDEX: rows equal a full re-read; only appended bytes are parsed; hourly buckets agree and survive a new process', async () => {
    const usage = require('../../src/usage');
    const idx = require('../../src/usageindex');
    idx._reset();
    const base = Date.now() - 3 * 3600 * 1000;
    for (let i = 0; i < 30; i++) usage.record({ id: `r${i}_${Math.random()}`, ok: true, startedAt: base + i * 60000, at: base + i * 60000, model: i % 2 ? 'm-a' : 'm-b', provider: 'p', connection: 'c', usage: { inputTokens: 100, outputTokens: 10 }, receipt: { type: 'usage', inputTokens: 100, outputTokens: 10 } });
    const a = usage.read({ from: 0 });
    assert.deepStrictEqual(a.map((r) => r.id), usage.readRaw({ from: 0 }).map((r) => r.id), 'the index reads what a full parse reads');
    const s1 = idx.stats();
    usage.read({ from: 0 });
    const s2 = idx.stats();
    assert.strictEqual(s2.bytesParsed, s1.bytesParsed, 'an unchanged file is not parsed again');
    usage.record({ id: `late_${Math.random()}`, ok: true, at: Date.now(), model: 'm-a', provider: 'p', connection: 'c', receipt: { type: 'usage', inputTokens: 5, outputTokens: 1 } });
    const b = usage.read({ from: 0 });
    const s3 = idx.stats();
    assert.strictEqual(b.length, a.length + 1);
    assert.ok(s3.bytesParsed - s2.bytesParsed < 2000, `only the appended line was parsed (${s3.bytesParsed - s2.bytesParsed} bytes)`);
    const agg = idx.aggregate({ from: 0, by: 'model' });
    assert.strictEqual(agg.total.requests, b.length);
    assert.strictEqual(agg.total.input, b.reduce((x, r) => x + (r.input || 0), 0));
    idx._reset();   // a new process: continues from the persisted index
    const agg2 = idx.aggregate({ from: 0, by: 'model' });
    assert.strictEqual(agg2.total.requests, b.length, 'the persisted buckets are reused, not double counted');
    assert.strictEqual(idx.stats().fullParses, 0, 'no historical rebuild in the new process');
  });
  await test('DEV SERVER PORT: a port another app serves on 0.0.0.0 is never handed out (Windows lets 127.0.0.1 bind beside it)', async () => {
    const net = require('net');
    const dev = require('../../src/workshop/devserver');
    const first = await dev.pickPort();
    assert.ok(first > 0);
    const other = net.createServer((s) => { s.on('error', () => {}); s.end('someone else'); });
    await new Promise((r, j) => { other.once('error', j); other.listen(first, '0.0.0.0', r); });
    try {
      const next = await dev.pickPort();
      assert.ok(next > 0);
      assert.notStrictEqual(next, first, 'the occupied port is skipped');
    } finally { await new Promise((r) => other.close(r)); }
  });
};
