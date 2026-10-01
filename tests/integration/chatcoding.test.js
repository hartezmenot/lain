'use strict';

/**
 * CHAT → PLAN → CODING, THROUGH THE REAL TURN LOOP.
 *
 * Real App, real sessions, real tools and gates; the model is the mock provider,
 * wrapped so every request records WHICH model it went to and WHAT was on the
 * wire. That is where the claims are true or false:
 *
 *   · Chat and Coding reach DIFFERENT models, chosen per view
 *   · a Chat turn's attempt to write a file is refused inside a real turn
 *   · the Coding request carries the accepted plan in its context and none of
 *     the Chat thread's messages
 *   · a session left running in the background stays RUNNING while another is
 *     viewed, and its ending arrives as a `session.status` event
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');
const { setTimeout: delay } = require('timers/promises');

async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await delay(40); }
  return false;
}

const PLAN = '## Plan: fix stalled downloads\n1. Add a stall timer to `DownloadQueue` in queue.js\n2. Retry the stalled item once\n3. Cover it with a test';

module.exports = async () => {
  await test('CHAT/CODING: different models per view, Chat cannot write, Coding gets the plan and not the chat', async () => {
    const proj = tmpdir('chatcoding-');
    fs.writeFileSync(path.join(proj, 'queue.js'), 'class DownloadQueue {}\nmodule.exports = DownloadQueue;\n');
    const prev = { p: process.env.LAIN_PROVIDER, s: process.env.LAIN_MOCK_SCRIPT };
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('ccscript-'), [
      { text: 'CHAT-INVESTIGATING first.', tool_calls: [{ name: 'write_file', input: { path: 'hack.txt', content: 'should never exist' } }] },
      { text: PLAN },
      { text: 'Implemented the stall timer.' },
    ]);
    const mock = require('../../src/mockprovider');
    mock._reset();
    const calls = [];
    const realChat = mock.chat;
    mock.chat = function (pc, messages, opts) { calls.push({ model: pc.model, messages: messages.map((m) => ({ role: m.role, content: String(m.content || '') })) }); return realChat(pc, messages, opts); };
    const routes = require('../../src/harnessapp/routes');
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: proj });
    const d = (m, p, b = {}) => routes.dispatch(app, m, p, b);
    try {
      app.session.sourceSelections = { lain: 'model-for-chat' };
      require('../../src/sessionviews').views(app.session).coding.model = 'model-for-coding';

      const chat = await d('POST', '/api/turn', { view: 'chat', text: 'Plan how to fix Toradb stalled downloads' });
      assert.strictEqual(chat.body.accepted, true, JSON.stringify(chat.body));
      assert.ok(await until(() => !app.abort && (app.session.planDocs || []).length), 'the chat turn ended with a plan');
      assert.strictEqual(fs.existsSync(path.join(proj, 'hack.txt')), false, 'Chat could not write a file');
      const chatCalls = calls.splice(0);
      assert.ok(chatCalls.length >= 2);
      assert.ok(chatCalls.every((c) => c.model === 'model-for-chat'), `chat went to its own model: ${chatCalls.map((c) => c.model)}`);
      const toolResult = app.session.messages.find((m) => m.role === 'tool' && /CHAT_VIEW_READ_ONLY/.test(String(m.content)));
      assert.ok(toolResult, 'the refusal is what the model was told');

      let st = (await d('GET', '/api/state')).body.state;
      assert.ok(st.plans.prompt, 'Plan ready — Continue to Coding?');
      const accepted = await d('POST', '/api/plan/accept', { id: st.plans.prompt.planId });
      assert.strictEqual(accepted.code, 200);
      assert.strictEqual(calls.length, 0, 'accepting ran nothing');

      st = (await d('GET', '/api/state')).body.state;
      const prefill = st.composer.coding.prefill.text;
      const edited = `${prefill}\n\nAlso keep the public API unchanged.`;
      const coding = await d('POST', '/api/turn', { view: 'coding', text: edited });
      assert.strictEqual(coding.body.accepted, true, JSON.stringify(coding.body));
      assert.ok(await until(() => !app.abort && calls.length), 'the coding turn ran');
      await until(() => !app.abort);
      const codingCall = calls[0];
      assert.strictEqual(codingCall.model, 'model-for-coding', 'coding went to a different model');
      const system = codingCall.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const convo = codingCall.messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');
      assert.match(system, /# Accepted plan p1/, 'the accepted plan is in the coding context');
      { const leak = /[^\n]{0,120}(?:CHAT-INVESTIGATING|Plan how to fix Toradb)[^\n]{0,80}/.exec(convo); assert.ok(!leak, `no chat thread message is on the coding wire: ${leak && leak[0]}`); }
      assert.match(convo, /Also keep the public API unchanged/, 'the person\'s edited instruction is what was sent');
      st = (await d('GET', '/api/state')).body.state;
      assert.strictEqual(st.plans.handoff.state, 'SUBMITTED');
      assert.deepStrictEqual([...new Set(st.conversation.map((m) => m.thread))].sort(), ['chat', 'coding']);
    } finally {
      mock.chat = realChat;
      process.env.LAIN_PROVIDER = prev.p; process.env.LAIN_MOCK_SCRIPT = prev.s;
      if (prev.p === undefined) delete process.env.LAIN_PROVIDER;
      if (prev.s === undefined) delete process.env.LAIN_MOCK_SCRIPT;
      mock._reset();
      await require('../../src/harnesslink').shutdown(app).catch(() => {});
    }
  });

  await test('BACKGROUND: A keeps RUNNING while B is viewed, and A\'s DONE arrives as an event', async () => {
    const proj = tmpdir('bgstatus-');
    const prev = { p: process.env.LAIN_PROVIDER, s: process.env.LAIN_MOCK_SCRIPT };
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('bgscript-'), [{ text: 'slow answer', delayMs: 2500 }]);
    const mock = require('../../src/mockprovider');
    mock._reset();
    const ipc = require('../../src/harnessapp/ipc');
    const realEmit = ipc.emit;
    const events = [];
    ipc.emit = (e) => { events.push(e); return { ok: true }; };
    const routes = require('../../src/harnessapp/routes');
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: proj });
    const d = (m, p, b = {}) => routes.dispatch(app, m, p, b);
    const made = [];
    try {
      const a = (await d('POST', '/api/session/new', { lane: 'engineering' })).body.id;
      made.push(a);
      const sent = await d('POST', '/api/turn', { view: 'coding', text: 'take your time', session: a });
      assert.strictEqual(sent.body.accepted, true, JSON.stringify(sent.body));
      const b = (await d('POST', '/api/session/new', { lane: 'engineering' })).body.id;
      made.push(b);
      assert.strictEqual(app.pool().viewId, b, 'B is being viewed');
      await delay(300);
      const st = (await d('GET', '/api/state')).body.state;
      const rowA = st.sessions.engineering.find((r) => r.id === a);
      assert.strictEqual(rowA.status, 'RUNNING', 'A is RUNNING in the rail while B is viewed');
      assert.ok(rowA.state.startedAt && rowA.state.elapsed >= 0, 'with its own clock');
      const turnId = rowA.state.activeTurnId;
      const back = await d('POST', '/api/session/select', { id: a });
      assert.strictEqual(back.body.running, true, 'returning to A: the same turn is still active');
      assert.strictEqual(require('../../src/sessionstatus').of(app.pool().live(a)).activeTurnId, turnId);
      await d('POST', '/api/session/select', { id: b });
      assert.ok(await until(() => events.some((e) => e.type === 'session.status' && e.session === a && e.status.state === 'DONE')), 'A\'s DONE was emitted while B was viewed');
      const after = (await d('GET', '/api/state')).body.state.sessions.engineering.find((r) => r.id === a);
      assert.strictEqual(after.status, 'DONE');
    } finally {
      ipc.emit = realEmit;
      process.env.LAIN_PROVIDER = prev.p; process.env.LAIN_MOCK_SCRIPT = prev.s;
      if (prev.p === undefined) delete process.env.LAIN_PROVIDER;
      if (prev.s === undefined) delete process.env.LAIN_MOCK_SCRIPT;
      mock._reset();
      for (const id of made) { try { app.pool().release(id); require('../../src/sessionstore').forget(id); } catch { /* kept */ } }
    }
  });
};
