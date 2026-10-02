'use strict';

/**
 * EVERY LINE AFTER A SETTLED TURN IS A NEW TURN — through the real `App.handle`.
 *
 * The reported failure: after DONE, a new prompt and Enter "did nothing" and
 * only a restart helped. The real-terminal half of the proof is
 * tests/smoke/sequentialturns.test.js. This half drives the same entry point a
 * keypress reaches (`App.handle`: composer, commands, input gate, submit) across
 * every kind of ending and every chat-source switch, and asserts after each one
 * that nothing the previous turn owned is still held:
 *
 *   a new turn record exists, the dispatch counter is back to zero, no abort
 *   controller is live, no steer is parked, and no composer is open.
 *
 * FIXTURE VERIFIED for ChatGPT.com and Gemini: the web sources are the
 * deterministic surface (src/modelsource/fixture.js) behind the real
 * orchestrator. Whether the live sites still parse is `/source check`'s question.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { test } = require('../helpers');

function script(steps) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lain-adm-')), 'script.json');
  fs.writeFileSync(p, JSON.stringify(steps));
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = p;
  require('../../src/mockprovider')._reset();
}

function newApp(cwd) {
  const { App } = require('../../src/app');
  return new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd });
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-adm-cwd-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = 1;\n');
  return dir;
}

/** Nothing the previous turn owned may still be holding the input path. */
function assertIdle(app, label) {
  assert.strictEqual(app.dispatching || 0, 0, `${label}: dispatch counter released`);
  assert.ok(!app.abort || app.abort.signal.aborted, `${label}: no live abort controller`);
  assert.strictEqual((app.steerQueue || []).length, 0, `${label}: no parked steer`);
  assert.ok(!app.composing, `${label}: no composer open`);
}

/** Send one line and prove it became exactly one new turn. */
async function send(app, text, label = text) {
  const before = app.session.turns.length;
  await app.handle(text);
  assert.strictEqual(app.session.turns.length, before + 1, `${label}: the line became a new turn (had ${before})`);
  assertIdle(app, label);
  return app.session.turns[app.session.turns.length - 1];
}

module.exports = () => require('../helpers').legacyOnly(async () => {   // LEGACY path only (Simplify S10 deletes)
  const registry = require('../../src/modelsource/registry');
  const { SOURCE } = require('../../src/modelsource/contract');

  await test('ADMISSION: A → B → C after DONE, each a new turn, nothing held', async () => {
    script([{ text: 'first' }, { text: 'second' }, { text: 'third' }]);
    const app = newApp(sandbox());
    assert.match(String((await send(app, 'reply with first')).text), /first/);
    assert.match(String((await send(app, 'reply with second')).text), /second/);
    assert.match(String((await send(app, 'reply with third')).text), /third/);
  });

  await test('ADMISSION: a line after every kind of ending is admitted', async () => {
    const cwd = sandbox();
    script([
      { text: '' }, { text: '' },                                   // empty twice: provider failure
      { text: 'after empty' },
      { error: { status: 400, message: 'bad request' } },           // terminal refusal
      { text: 'after refusal' },
      { error: { status: 429, message: 'limited', retryAfter: 0 } }, { text: 'recovered' },
      { text: 'after recovery' },
      { text: 'writing', tool_calls: [{ name: 'write_file', input: { path: 'b.js', content: 'module.exports = 2;\n' } }] },
      { text: 'wrote it' },
      { text: 'after coding' },
    ]);
    const app = newApp(cwd);
    const empty = await send(app, 'say something', 'empty provider reply');
    assert.strictEqual(empty.stopReason, 'provider', 'an empty reply is a provider failure, not DONE');
    await send(app, 'try again please', 'after provider failure');
    const refused = await send(app, 'this one is refused', 'provider refusal');
    assert.strictEqual(refused.stopReason, 'provider');
    await send(app, 'and now a normal one', 'after refusal');
    assert.match(String((await send(app, 'hit the limit', 'rate limit recovery')).text), /recovered/);
    await send(app, 'after the limit', 'after rate-limit recovery');
    const coding = await send(app, 'create b.js exporting 2', 'coding turn');
    assert.ok(fs.existsSync(path.join(cwd, 'b.js')), 'the coding turn really wrote');
    assert.ok(coding);
    await send(app, 'what did you change', 'after coding');
  });

  await test('ADMISSION: a line after an interrupted turn is admitted', async () => {
    script([{ text: 'never', delayMs: 5000 }, { text: 'after interrupt' }]);
    const app = newApp(sandbox());
    const running = app.handle('a slow one');
    // Inside the provider's delay, so the abort lands on a turn in flight.
    const reached = () => Boolean(app.abort && !app.abort.signal.aborted && app.session.turns.length === 0);
    for (let i = 0; i < 200 && !reached(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(reached(), 'the slow turn started');
    await new Promise((r) => setTimeout(r, 800));
    app.abort.abort();
    await running;
    assertIdle(app, 'after interrupt');
    assert.match(String((await send(app, 'next one')).text), /after interrupt/);
  });

  await test('ADMISSION: a line after /verify FAILED and after /goal is admitted', async () => {
    const cwd = sandbox();
    fs.writeFileSync(path.join(cwd, 'suite.js'), 'console.log("1 passed, 1 failed"); process.exit(1);\n');
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'v', scripts: { test: 'node suite.js' } }));
    // A fix request CHANGES something before claiming it: reads or prose alone
    // followed by "All fixed!" (correctly) get the hidden wake-up (wakeup.js).
    // …and runs the project's final suite as its last step (finalsmoke.js); it
    // fails here, and the turn says so rather than claiming a fix.
    script([
      { text: '', tool_calls: [{ name: 'write_file', input: { path: 'change1.txt', content: 'x' } }] },
      { text: '', tool_calls: [{ name: 'run_tests', input: { which: 'project' } }] },
      { text: 'I cannot proceed: the suite still fails in suite.js.' },
      // `/goal <text>` EXECUTES the goal (2026-09-23): it has a turn of its own.
      // (prose-only on an execution request: the one hidden wake-up takes a second reply)
      { text: 'after verify' }, { text: 'working on the goal' }, { text: 'still on the goal' }, { text: 'after goal' },
    ]);
    const app = newApp(cwd);
    await send(app, 'fix it');
    await app.handle('/verify tests');
    assertIdle(app, 'after /verify');
    const tasks = path.join(cwd, '.lain', 'tasks');
    const record = JSON.parse(fs.readFileSync(path.join(tasks, fs.readdirSync(tasks)[0], 'task.json'), 'utf8'));
    assert.strictEqual(record.state, 'FAILED', 'the verification really failed first');
    assert.match(String((await send(app, 'why did it fail')).text), /after verify/);
    await app.handle('/goal ship the fix');
    assertIdle(app, 'after /goal');
    assert.match(String(app.session.turns[app.session.turns.length - 1].text), /working on the goal/, 'the goal ran as its own turn');
    assert.match(String((await send(app, 'carry on with it')).text), /after goal/);
  });

  await test('ADMISSION: a line after /bg work settles is admitted', async () => {
    script([{ text: 'background answer' }, { text: 'foreground after bg' }]);
    const app = newApp(sandbox());
    await app.handle('/bg summarise a.js');
    const bg = app.jobs.all().find((j) => !j.primary);
    assert.ok(bg, 'the background job exists');
    await bg.wait();
    assert.ok(bg.done, 'and it settled');
    assertIdle(app, 'after /bg settlement');
    assert.match(String((await send(app, 'and now in the foreground')).text), /foreground after bg/);
  });

  // (Phase 8.1: the ChatGPT.com / Gemini website sources were retired — admission is proven
  // across LAIN's own routes, a local model among them, and a retired source cannot be chosen.)
  await test('ADMISSION: Chat/Coding across LAIN and a local model; a retired website source is refused', async () => {
    const cwd = sandbox();
    script([
      { text: 'lain explains' },
      // Coding turns make their change before they speak — see wakeup.js.
      { text: '', tool_calls: [{ name: 'write_file', input: { path: 'change2.txt', content: 'x' } }] }, { text: 'lain codes' },
      { text: 'local explains' },
      { text: 'lain explains again' },
      { text: '', tool_calls: [{ name: 'write_file', input: { path: 'change4.txt', content: 'x' } }] }, { text: 'lain codes again' },
    ]);
    const app = newApp(cwd);
    const said = async (line, re, label) => assert.match(String((await send(app, line, label)).text), re, label);

    await said('explain what a.js does', /lain explains/, 'LAIN chat');
    await said('fix a.js so it exports 3 and run the tests', /lain codes/, 'LAIN coding');
    assert.strictEqual(registry.selectSource(app, SOURCE.CHATGPT_WEB).ok, false, 'a retired website source is refused');
    app.cfg.model = 'local-model';
    await said('explain what a.js exports', /local explains/, 'local model chat');
    await said('explain it once more', /lain explains again/, 'still LAIN chat');
    await said('fix a.js to export 4', /lain codes again/, 'back to LAIN coding');
  });

});
