'use strict';

/**
 * THE WORKSPACE SHELL'S CORE HALF — usage readings, accounts, MCP, skills,
 * opening a project, project understanding, and the BOT describing LAIN.
 *
 * Mostly the same negative the rest of the harness tests assert: nothing here
 * may acquire an opinion. A usage percentage exists only because a provider
 * stated it; an account row exists only because a route is configured; a
 * project opens through the verbs that already attach and create sessions.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

function appAt(cwd) {
  const { App } = require('../../src/app');
  return new App({
    out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false },
    interactive: false,
    cwd: cwd || process.cwd(),
  });
}

module.exports = async function () {
  const uw = require('../../src/usagewindows');
  const routes = require('../../src/harnessapp/routes');

  // ------------------------------------------------------------- usage --

  await test('USAGE: a subscription window is read from the provider\'s own utilization header', () => {
    const w = uw.parse({
      'anthropic-ratelimit-unified-5h-utilization': '0.63',
      'anthropic-ratelimit-unified-5h-reset': '1790000000',
      'anthropic-ratelimit-unified-7d-utilization': '0.21',
    });
    const five = w.find((x) => x.name === '5h');
    assert.strictEqual(Math.round(five.percent), 63);
    assert.strictEqual(five.label, '5-hour');
    assert.strictEqual(five.resetAt, 1790000000 * 1000, 'epoch seconds become a time');
    assert.strictEqual(uw.headline(w).name, '5h', 'the headline is the most-used window');
  });

  await test('USAGE: limit and remaining become a percentage used; durations reset from now', () => {
    const now = 1_000_000;
    const w = uw.parse({
      'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '125', 'x-ratelimit-reset-requests': '6m0s',
      'x-ratelimit-limit-tokens': '30000', 'x-ratelimit-remaining-tokens': '29000',
    }, now);
    const req = w.find((x) => x.name === 'requests');
    assert.strictEqual(req.percent, 75);
    assert.strictEqual(req.resetAt, now + 6 * 60000);
    assert.strictEqual(uw.headline(w).name, 'requests', 'never an average of unrelated windows');
  });

  await test('USAGE: a response with no rate-limit headers is NO reading, never 0%', () => {
    uw._reset();
    assert.strictEqual(uw.observe({ connectionId: 'c1', model: 'm' }, { 'content-type': 'text/event-stream' }), null);
    assert.strictEqual(uw.forConnection('c1'), null);
    assert.deepStrictEqual(uw.last().connectionId, 'c1', 'but the route is still known as the one last used');
  });

  await test('USAGE: a role finds its reading by base route or by either model name', () => {
    uw._reset();
    uw.observe({ connectionId: 'lain:host', model: 'opus-5', canonicalModel: 'claude/opus-5' }, { 'anthropic-ratelimit-unified-5h-utilization': '0.5' });
    assert.ok(uw.forSelection('lain:host:Claude', null), 'a catalog route belongs to its base connection');
    assert.ok(uw.forSelection(null, 'claude/opus-5'), 'the canonical id matches');
    assert.ok(uw.forSelection(null, 'opus-5'), 'the wire id matches');
    assert.strictEqual(uw.forSelection('other', 'nope'), null);
    uw._reset();
  });

  await test('USAGE: provider.js reports every response to the one usage owner', () => {
    const src = fs.readFileSync(require.resolve('../../src/provider'), 'utf8');
    assert.ok(/require\('\.\/usagewindows'\)\.observe\(route, res\.headers\)/.test(src));
    assert.strictEqual((src.match(/opts\.signal, pc\)/g) || []).length, 2, 'both protocols pass their route');
  });

  // ------------------------------------------------------ the read model --

  await test('SHELL: /api/state carries usage and navigation without contacting anything', async () => {
    const app = appAt(tmpdir());
    const r = await routes.dispatch(app, 'GET', '/api/state');
    assert.strictEqual(r.code, 200);
    const s = r.body.state;
    assert.ok(s.usage && 'chat' in s.usage && 'coding' in s.usage, 'per-role usage is in the poll');
    assert.strictEqual(s.navigate, null, 'nothing asked the window to go anywhere');
    assert.ok(s.sessions.engineering.every((x) => 'at' in x), 'rows carry a time the Session view can group by');
  });

  await test('SHELL: accounts carry no credential', async () => {
    const app = appAt(tmpdir());
    const r = await routes.dispatch(app, 'POST', '/api/accounts', {});
    assert.strictEqual(r.code, 200);
    assert.ok(Array.isArray(r.body.providers) && r.body.roles && r.body.roles.bot && r.body.roles.coding);
    assert.ok(!/apiKey|authorization|x-api-key/i.test(JSON.stringify(r.body)), 'no secret field crosses to the window');
    assert.strictEqual(r.body.orchestration.mode, 'SINGLE_PER_ROLE', 'only the mode Core routes is claimed');
  });

  await test('SHELL: MCP lists the built-in Computer server and never starts it; skills are supported and none are installed', async () => {
    const app = appAt(tmpdir());
    const m = await routes.dispatch(app, 'POST', '/api/mcp/servers', {});
    const comp = m.body.servers.find((s) => s.id === 'computer');
    assert.ok(comp && comp.builtIn);
    assert.notStrictEqual(comp.state, 'CONNECTED', 'reading the list connected nothing');
    assert.strictEqual(require('../../src/computermcp').existing(app), null);
    const k = await routes.dispatch(app, 'POST', '/api/skills', {});
    assert.strictEqual(k.body.supported, true, 'a skill loader exists (integrations.js, Phase 8.1)');
    assert.deepStrictEqual(k.body.skills.map((x) => `${x.id} ${x.name}`), [], 'no skill is installed in this home');
  });

  // ------------------------------------------------------------ projects --

  await test('SHELL: opening a folder attaches it to an untouched session, and marks understanding as running', async () => {
    const app = appAt(tmpdir());
    const proj = tmpdir();
    fs.writeFileSync(path.join(proj, 'a.js'), 'function a() { return 1; }\nmodule.exports = { a };\n');
    const r = await routes.dispatch(app, 'POST', '/api/project/open', { path: proj });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const view = app.pool().view();
    assert.strictEqual(path.resolve(view.session.cwd).toLowerCase(), path.resolve(proj).toLowerCase());
    assert.ok(view._projectSync && view._projectSync.root === view.session.cwd, 'the walk is recorded against this root');
    for (let i = 0; i < 50 && view._projectSync.running; i++) await new Promise((res) => setTimeout(res, 20));
    assert.strictEqual(view._projectSync.running, false);
    assert.ok(view._projectSync.files >= 1, 'the counts are the index walk\'s own');
    const st = (await routes.dispatch(app, 'GET', '/api/state')).body.state;
    assert.ok(st.workspace.project.sync && st.workspace.project.sync.state, 'the window can show "Project ready"');
  });

  await test('SHELL: a session that already works on another project gets a NEW session, never a mixed one', async () => {
    const app = appAt(tmpdir());
    const one = tmpdir();
    const two = tmpdir();
    assert.strictEqual((await routes.dispatch(app, 'POST', '/api/project/open', { path: one })).code, 200);
    const first = app.pool().view();
    first.session.messages.push({ role: 'user', content: 'work happened here' });
    const r = await routes.dispatch(app, 'POST', '/api/project/open', { path: two });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.ok(r.body.created, 'a new session was made for the second folder');
    assert.notStrictEqual(app.pool().view().session.id, first.session.id);
    assert.strictEqual(path.resolve(first.session.cwd).toLowerCase(), path.resolve(one).toLowerCase(), 'the first keeps its project');
  });

  await test('SHELL: New Project creates only a fresh folder and refuses names that escape it', async () => {
    const app = appAt(tmpdir());
    const parent = tmpdir();
    const bad = await routes.dispatch(app, 'POST', '/api/project/create', { parent, name: '..\\escape' });
    assert.strictEqual(bad.code, 400);
    const ok = await routes.dispatch(app, 'POST', '/api/project/create', { parent, name: 'demo-app' });
    assert.strictEqual(ok.code, 200, JSON.stringify(ok.body));
    assert.ok(fs.statSync(path.join(parent, 'demo-app')).isDirectory());
    fs.writeFileSync(path.join(parent, 'demo-app', 'x.txt'), 'x');
    const again = await routes.dispatch(app, 'POST', '/api/project/create', { parent, name: 'demo-app' });
    assert.strictEqual(again.code, 409, 'an existing, non-empty folder is Open Project\'s job');
  });

  // ------------------------------------------------------- BOT about LAIN --

  await test('SELF: the BOT describes LAIN from the same projection, and never invents usage', async () => {
    uw._reset();
    const app = appAt(tmpdir());
    const tool = require('../../src/tools/lainself').tools.lain_workspace;
    assert.strictEqual(tool.mutates, false, 'reading LAIN changes nothing');
    const out = (await tool.run({ action: 'describe', topic: 'all' }, { app })).output;
    assert.match(out, /MODEL ROLES/);
    assert.match(out, /Settings › mcp|Settings › MCP/i);
    assert.ok(!/\d+% of the/.test(out), 'no percentage without a provider reading');
  });

};
