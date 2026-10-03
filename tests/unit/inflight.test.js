'use strict';

/**
 * A TURN IN FLIGHT IS DURABLE (inflight.js, 2026-09-23).
 *
 * Force-closing LAIN mid-turn used to return the person to the previous
 * completed prompt: the session was written only when a turn ended. These pin
 * (1) the save happening BEFORE a side effect, with the turn's messages in it,
 * and (2) recovery classifying a lost call by inspecting reality — never by
 * replaying it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const { Session } = require('../../src/session');
const inflight = require('../../src/inflight');
const mock = require('../../src/mockprovider');

function scripted(steps) {
  const dir = tmpdir('inflight-');
  const file = path.join(dir, 'script.json');
  fs.writeFileSync(file, JSON.stringify(steps), 'utf8');
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = file;
  mock._reset();
  return dir;
}
function unscript() { delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; mock._reset(); }

function crashedSession(cwd, { tool, calls }) {
  const s = new Session({ cwd });
  s.messages.push({ role: 'user', content: 'fix the bug' });
  s.messages.push({ role: 'assistant', content: '', tool_calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.input || {}) })) });
  s.inflight = { turnId: 't9-x', pid: 999999, userInput: 'fix the bug', startedAt: new Date().toISOString(), step: 2, tool, ledger: [{ id: 'r0', name: 'read_file', target: 'a.js', kind: 'READ', state: 'COMPLETED' }] };
  return s;
}

module.exports = async function () {
  await test('INFLIGHT: kinds — a write is FILE, a shell is COMMAND, a test is CHECK, a read is READ', () => {
    assert.strictEqual(inflight.kindOf('write_file', { path: 'a.js' }), 'FILE');
    assert.strictEqual(inflight.kindOf('edit_file', { path: 'a.js' }), 'FILE');
    assert.strictEqual(inflight.kindOf('run_bash', { command: 'rm -rf x' }), 'COMMAND');
    assert.strictEqual(inflight.kindOf('run_tests', {}), 'CHECK');
    assert.strictEqual(inflight.kindOf('read_file', { path: 'a.js' }), 'READ');
    assert.strictEqual(inflight.kindOf('grep', { pattern: 'x' }), 'READ');
  });

  await test('INFLIGHT RECOVER: a write that LANDED is reported COMPLETED — inspected, not assumed', () => {
    const cwd = tmpdir('inflight-w-');
    const file = path.join(cwd, 'a.js');
    fs.writeFileSync(file, 'old');
    const s = new Session({ cwd });
    s.inflight = { turnId: 't', pid: 999999, userInput: 'x', step: 0, tool: null, ledger: [] };
    const t = inflight.beforeTool(s, { id: 'w1', name: 'write_file', input: { path: 'a.js' } }, 'a.js');
    assert.ok(t.pre[file], 'the pre-call hash is recorded before the write');
    fs.writeFileSync(file, 'new');   // the write happened, then LAIN died
    const s2 = crashedSession(cwd, { tool: s.inflight.tool, calls: [{ id: 'w1', name: 'write_file', input: { path: 'a.js' } }] });
    const r = inflight.recover(s2);
    assert.strictEqual(r.lost[0].state, 'COMPLETED');
    const msg = s2.messages[s2.messages.length - 1];
    assert.strictEqual(msg.role, 'tool');
    assert.strictEqual(msg.tool_call_id, 'w1', 'the dangling call is answered — no 400 on the next request');
    assert.match(msg.content, /CHANGED — the write landed/);
  });

  await test('INFLIGHT RECOVER: a write that did NOT land is NOT_APPLIED; a command is UNKNOWN and never re-run; later calls NOT_STARTED', () => {
    const cwd = tmpdir('inflight-n-');
    fs.writeFileSync(path.join(cwd, 'b.js'), 'same');
    const s = new Session({ cwd });
    s.inflight = { turnId: 't', pid: 999999, userInput: 'x', step: 0, tool: null, ledger: [] };
    inflight.beforeTool(s, { id: 'w2', name: 'edit_file', input: { path: 'b.js' } }, 'b.js');
    const s2 = crashedSession(cwd, { tool: s.inflight.tool, calls: [{ id: 'w2', name: 'edit_file', input: { path: 'b.js' } }, { id: 'c3', name: 'run_bash', input: { command: 'npm test' } }] });
    const r = inflight.recover(s2);
    assert.deepStrictEqual(r.lost.map((v) => v.state), ['NOT_APPLIED', 'NOT_STARTED']);

    const s3 = crashedSession(cwd, { tool: { id: 'c9', name: 'run_bash', kind: 'COMMAND', state: 'STARTED', target: 'npm run migrate' }, calls: [{ id: 'c9', name: 'run_bash', input: { command: 'npm run migrate' } }] });
    const r3 = inflight.recover(s3);
    assert.strictEqual(r3.lost[0].state, 'UNKNOWN');
    assert.match(s3.messages[s3.messages.length - 1].content, /NOT re-run/);
  });

  await test('INFLIGHT RECOVER: the turn is kept as a record ending `crashed`; inflight cleared; a LIVE owner is left alone', () => {
    const cwd = tmpdir('inflight-r-');
    const s = crashedSession(cwd, { tool: null, calls: [{ id: 'q1', name: 'read_file', input: { path: 'a.js' } }] });
    const r = inflight.recover(s);
    const last = s.turns[s.turns.length - 1];
    assert.strictEqual(last.stopReason, 'crashed');
    assert.strictEqual(last.userInput, 'fix the bug');
    assert.strictEqual(last.actions.length, 1, 'what it did is kept');
    assert.strictEqual(s.inflight, null);
    assert.match(r.line, /RECOVERED · cut off at step 3/);
    // THE TASK RESUMES BY ITSELF NOW (autocontinue.scheduleRecovery) — the line no longer asks the person to type `continue`.
    assert.doesNotMatch(r.line, /type continue/);
    assert.ok(r.lastActiveAt == null || Number.isFinite(r.lastActiveAt), 'how fresh the crash is travels with it');
    // An owner that is still running is NOT a crash.
    const live = crashedSession(cwd, { tool: null, calls: [] });
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
    try {
      live.inflight.pid = child.pid;
      assert.deepStrictEqual(inflight.recover(live), { live: true, pid: child.pid });
      assert.ok(live.inflight, 'untouched');
    } finally { child.kill(); }
  });
  await test('INFLIGHT DURABILITY: the saved file holds the turn BEFORE the command runs — then resume recovers it', async () => {
    const dir = scripted([
      { text: 'Writing it.', tool_calls: [{ name: 'write_file', input: { path: 'out.txt', content: 'hello' } }] },
      { text: 'Now the migration.', tool_calls: [{ name: 'run_bash', input: { command: 'echo hi' } }] },
      { text: 'Done.' },
    ]);
    try {
      const { App } = require('../../src/app');
      const a = new App({ interactive: false, cwd: dir });
      a.render.write = () => {}; a.render.notice = () => {}; a.render.turnSummary = () => {}; a.render.nl = () => {};
      // THE CRASH POINT: the moment run_bash is about to execute, copy what is on disk.
      let snapshot = null;
      const tools = require('../../src/tools');
      const orig = tools.execute;
      tools.execute = async (name, input, ctx) => {
        if (name === 'run_bash' && !snapshot) snapshot = fs.readFileSync(a.session.file(), 'utf8');
        return orig(name, input, ctx);
      };
      try { await a.handle('write out.txt then migrate'); } finally { tools.execute = orig; }
      assert.ok(snapshot, 'the session file existed before the command ran');
      const data = JSON.parse(snapshot);
      assert.ok(data.inflight, 'an in-flight record was on disk');
      assert.strictEqual(data.inflight.tool.name, 'run_bash');
      assert.strictEqual(data.inflight.tool.state, 'STARTED');
      assert.ok(data.messages.some((m) => m.role === 'user' && /migrate/.test(m.content)), 'the user message was durable');
      assert.ok(data.messages.some((m) => m.role === 'tool' && /out\.txt|wrote|Wrote|created/i.test(m.content)), 'the completed write result was durable');
      // PLAY THE CRASH: that file is what a restart would find.
      data.inflight.pid = 999999;
      fs.writeFileSync(a.session.file(), JSON.stringify(data), 'utf8');
      const back = Session.resume(a.session.id);
      assert.ok(back.recovered, 'recovered on load');
      assert.strictEqual(back.recovered.lost[0].state, 'UNKNOWN', 'the command is UNKNOWN — not replayed');
      assert.strictEqual(back.turns[back.turns.length - 1].stopReason, 'crashed');
      assert.strictEqual(JSON.parse(fs.readFileSync(a.session.file(), 'utf8')).inflight, null, 'the repair was saved');
      // And a turn that ENDS normally leaves nothing to recover.
      assert.strictEqual(a.session.inflight, null);
      try { require('../../src/sessionstore').forget(a.session.id); } catch { /* best effort */ }
    } finally { unscript(); }
  });
};
