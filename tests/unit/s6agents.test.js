'use strict';

/**
 * SIMPLIFY S6 — one Agent tool: markdown types, a fresh context, only the final message back, the transcript kept,
 * parallel calls run together, background results rejoin like a job's, no agent spawns another, no computer.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');

const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };

async function withMock(steps, fn) {
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('s6-script-'), steps);
  require('../../src/mockprovider')._reset();
  try { return await fn(); } finally { delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; }
}

module.exports = async function () {
  const types = require('../../src/agenttypes');

  await test('TYPES: built-in explore and general, plus markdown files; a type\'s tools are what it sees, never Agent or computer', () => {
    const cwd = tmpdir('s6-types-');
    fs.mkdirSync(path.join(cwd, '.lain', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.lain', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: reviews a diff\ntools: read_file, grep, shell\nmodel: glm-5.3\neffort: high\n---\nReview the change and list problems.\n');
    const all = types.all(cwd);
    assert.deepStrictEqual(Object.keys(all).sort(), ['explore', 'general', 'reviewer']);
    assert.deepStrictEqual(all.reviewer.tools, ['read_file', 'grep', 'shell']);
    assert.strictEqual(all.reviewer.model, 'glm-5.3');
    assert.match(all.reviewer.body, /Review the change/);
    assert.ok(types.allows(all.reviewer, 'shell') && !types.allows(all.reviewer, 'edit_file'));
    assert.ok(!types.allows(all.explore, 'edit_file') && types.allows(all.explore, 'grep'));
    for (const t of Object.values(all)) assert.ok(!types.allows(t, 'Agent') && !types.allows(t, 'computer'), t.name);
  });

  await test('RUN: a fresh context, only the final message back, the transcript saved and out of the parent\'s context', async () => {
    await withMock([
      { text: 'Looking.', tool_calls: [{ name: 'grep', input: { pattern: 'login', path: '.' } }] },
      { text: 'AGENT_FINAL the login is in auth.js:12' },
    ], async () => {
      const cwd = tmpdir('s6-run-');
      fs.writeFileSync(path.join(cwd, 'auth.js'), 'function login() {}\n');
      const { App } = require('../../src/app');
      const app = new App({ out, interactive: false, cwd });
      const r = await require('../../src/tools').execute('Agent', { description: 'find login', prompt: 'Where is login?', type: 'explore' }, { app, session: app.session, cwd });
      assert.ok(!r.isError, r.output);
      assert.strictEqual(r.output, 'AGENT_FINAL the login is in auth.js:12', 'only the final message');
      assert.ok(!app.session.messages.some((m) => /Looking\./.test(String(m.content || ''))), 'the agent\'s steps never enter the parent');
      const childId = r.meta && r.meta.session;
      assert.ok(childId, 'a transcript session');
      const { Session } = require('../../src/session');
      const child = Session.resume(childId);
      assert.ok(child.messages.some((m) => /Where is login\?/.test(String(m.content || ''))), 'the child saw only the prompt');
    });
  });

  await test('PARALLEL: several Agent calls in one response start together', async () => {
    const toolstep = require('../../src/toolstep');
    const tools = require('../../src/tools');
    const real = tools.execute;
    let inFlight = 0; let peak = 0;
    tools.execute = async (name) => { if (name === 'Agent') { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 80)); inFlight -= 1; } return { output: 'x' }; };
    try {
      const s = { id: 'p', cwd: tmpdir('s6-par-') };
      const calls = [1, 2, 3].map((i) => ({ id: `a${i}`, name: 'Agent', input: { description: `d${i}`, prompt: 'p' } }));
      const pre = toolstep.prefetch(calls, { session: s, evidence: null, toolCtx: { cwd: s.cwd, session: s } }, 2);
      assert.strictEqual(pre.size, 3, 'all three started early');
      await Promise.all([...pre.values()]);
      assert.strictEqual(peak, 3, 'and ran at once');
    } finally { tools.execute = real; }
  });

  await test('BACKGROUND: returns an id at once; the final message rejoins the session like a job result', async () => {
    await withMock([{ text: 'BG_FINAL done in the background' }], async () => {
      const { App } = require('../../src/app');
      const app = new App({ out, interactive: false, cwd: tmpdir('s6-bg-') });
      const r = await require('../../src/tools').execute('Agent', { description: 'bg job', prompt: 'do it', type: 'general', background: true }, { app, session: app.session, cwd: app.session.cwd });
      assert.match(r.output, /started in the background/);
      for (let i = 0; i < 100 && !(app.session._bgResults || []).length; i++) await new Promise((x) => setTimeout(x, 20));
      const got = (app.session._bgResults || [])[0];
      assert.ok(got && got.kind === 'agent' && /BG_FINAL/.test(got.summary), JSON.stringify(got));
      assert.match(require('../../src/bgdetach').takeContext(app.session), /BG_FINAL/);
    });
  });

  await test('NO NESTING, NO COMPUTER, AND A ROW PER RUNNING AGENT', async () => {
    const { App } = require('../../src/app');
    const app = new App({ out, interactive: false, cwd: tmpdir('s6-nest-') });
    const child = { id: 'c', cwd: app.session.cwd, _agentType: 'general', _agentSpec: types.BUILT_IN.general };
    const r = await require('../../src/tools').execute('Agent', { description: 'x', prompt: 'y' }, { app, session: child });
    assert.ok(r.isError && /cannot start/.test(r.output));
    const rows = require('../../src/ui/activitybox').summary({ busy: false, jobs: [{ kind: 'subagent', state: 'RUNNING', request: 'explore · auth owner', agentType: 'explore', agentLabel: 'auth owner', startedAt: Date.now() - 8000, chars: 4800 }] });
    assert.match(rows.agents[0], /^[◐◓◑◒] explore · auth owner · 8s · ↓~1\.2k$/);
  });
};
