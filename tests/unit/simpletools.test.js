'use strict';

/**
 * SIMPLIFY S2 — the fixed tool set: one list for the life of a session, everything else found with tool_search and
 * run with call_tool through the same door, ceremony tools gone, agents scoped by type.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const CORE = ['read_file', 'grep', 'glob', 'list_dir', 'edit_file', 'write_file', 'apply_patch', 'shell', 'job_status', 'job_stop', 'web_fetch', 'ask_user', 'todo_write', 'exit_plan', 'Agent', 'Skill', 'tool_search', 'call_tool'];

module.exports = async function () {
  const tools = require('../../src/tools');
  const { App } = require('../../src/app');
  const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };
  const mk = () => new App({ out, interactive: false, cwd: tmpdir('st-') });

  await test('FIXED SET: the session is described exactly the core tools, and the same list on every turn', () => {
    const app = mk();
    const a = tools.schemas(app, { turn: true }).map((s) => s.name);
    assert.deepStrictEqual(a, CORE);
    const b = tools.schemas(app, { turn: true, session: app.session }).map((s) => s.name);
    assert.deepStrictEqual(b, a, 'identical across turns');
    assert.deepStrictEqual(tools.names(app), CORE, 'what is described is what is dispatchable');
    for (const gone of ['request_completion', 'task_contract', 'plan_write', 'delegate', 'run_bash', 'job_wait']) assert.ok(!a.includes(gone), gone);
  });

  await test('TOOL SEARCH: a deferred tool is found, its schema selected, and run through call_tool (or its own name)', async () => {
    const app = mk();
    const ctx = { app, cwd: app.session.cwd, session: app.session };
    fs.writeFileSync(path.join(app.session.cwd, 'a.txt'), 'hello\n');
    const found = await tools.execute('tool_search', { query: 'file size line count' }, ctx);
    assert.match(found.output, /file_info/);
    const sel = await tools.execute('tool_search', { select: 'file_info' }, ctx);
    assert.match(sel.output, /input schema: \{/);
    const r = await tools.execute('call_tool', { name: 'file_info', arguments: { path: 'a.txt' } }, ctx);
    assert.ok(!r.isError, r.output);
    const direct = await tools.execute('file_info', { path: 'a.txt' }, ctx);
    assert.ok(!direct.isError, 'a found tool also runs by its own name');
    for (const retired of ['request_completion', 'task_contract', 'delegate']) {
      const v = await tools.execute('call_tool', { name: retired, arguments: {} }, ctx);
      assert.ok(v.isError && /no tool/.test(v.output), `${retired} is retired`);
      const d = await tools.execute(retired, {}, ctx);
      assert.ok(d.isError, `${retired} does not run by name either`);
    }
  });

  await test('TODO_WRITE: the whole list each time, shown as the plan — nothing reads it to gate anything', async () => {
    const app = mk();
    const ctx = { app, session: app.session };
    const r = await tools.execute('todo_write', { todos: [{ content: 'read', status: 'completed' }, { content: 'edit', status: 'in_progress' }, { content: 'test', status: 'pending' }] }, ctx);
    assert.match(r.output, /3 item\(s\), 1 completed/);
    assert.deepStrictEqual(app.session.plan.steps.map((s) => s.status), ['done', 'active', 'todo']);
    await tools.execute('todo_write', { todos: [{ content: 'only', status: 'pending' }] }, ctx);
    assert.strictEqual(app.session.plan.steps.length, 1, 'replaced, not merged');
  });

  await test('SHELL: one tool, this host\'s shell; background starts a job and returns at once', async () => {
    const app = mk();
    const ctx = { app, cwd: app.session.cwd, session: app.session };
    const r = await tools.execute('shell', { command: 'echo simple-shell' }, ctx);
    assert.ok(!r.isError && /simple-shell/.test(r.output), r.output);
    const t0 = Date.now();
    const bg = await tools.execute('shell', { command: process.platform === 'win32' ? 'Start-Sleep -Milliseconds 400; echo done' : 'sleep 0.4; echo done', background: true }, ctx);
    assert.ok(Date.now() - t0 < 2000 && /started/.test(bg.output), bg.output);
    await app._jobs.get(bg.meta.job).wait();
  });

  await test('AGENTS: an agent never gets Agent; an explore agent is described and allowed only reads', async () => {
    const app = mk();
    const { Session } = require('../../src/session');
    const child = new Session({ cwd: app.session.cwd }); child._agentType = 'explore';
    const shown = tools.schemas(app, { turn: true, session: child }).map((s) => s.name);
    assert.ok(!shown.includes('Agent') && !shown.includes('write_file') && !shown.includes('shell') && shown.includes('read_file'), shown.join(','));
    const w = await tools.execute('write_file', { path: 'x.txt', content: 'x' }, { app, cwd: app.session.cwd, session: child });
    assert.ok(w.denied && /only reads/.test(w.output), w.output);
    const g = new Session({ cwd: app.session.cwd }); g._agentType = 'general';
    assert.ok(!tools.schemas(app, { turn: true, session: g }).map((s) => s.name).includes('Agent'));
    const a = await tools.execute('Agent', { description: 'x', prompt: 'y' }, { app, session: g });
    assert.ok(a.denied && /cannot start agents/.test(a.output));
  });

  await test('DIALECT: GLM speaks `bash` for the one shell tool, and it resolves to `shell`', async () => {
    const dialect = require('../../src/discipline/dialect');
    const app = mk();
    const rendered = dialect.forTurn(app.session, tools.schemas(app, { turn: true }), 'glm-5.3', {}).map((s) => s.name);
    assert.ok(rendered.includes('bash') && !rendered.includes('shell'), rendered.join(','));
    const r = await tools.execute('bash', { command: 'echo via-glm' }, { app, cwd: app.session.cwd, session: app.session });
    assert.ok(!r.isError && /via-glm/.test(r.output), r.output);
  });
};
