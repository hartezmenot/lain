'use strict';

/**
 * THE BOT'S CONTEXT PROFILE — "2 + 2" must not carry the full BOT request.
 *
 *   - a self-contained BOT question gets BOT_SIMPLE: a short stable prompt, no
 *     tool schemas, no live workspace tail
 *   - anything that may need the workspace, a tool, or a conversation that has
 *     already used tools stays BOT_FULL
 *   - the Coding Agent is never touched; `cfg.bot.contextProfile: 'full'` opts out
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const bc = require('../../src/botcontext');
  const { App } = require('../../src/app');
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('botctx-') });
  const jr = require('../../src/jobrunner');

  await test('CLASSIFY: self-contained questions are SIMPLE; workspace, code, tools and plans are FULL', () => {
    const s = { thread: 'chat', messages: [] };
    for (const q of ['2 + 2', 'what is a mutex?', 'Translate "good morning" to French', 'Who wrote Dune?']) assert.strictEqual(bc.classify(s, q).profile, 'BOT_SIMPLE', q);
    for (const q of ['fix the failing test', 'open src/app.js', 'what does `run()` do', 'search the web for llama.cpp news', 'summarise this', 'look at the screenshot', 'x'.repeat(300), 'line one\nline two']) assert.strictEqual(bc.classify(s, q).profile, 'BOT_FULL', q);
    assert.strictEqual(bc.classify({ thread: 'chat', messages: [{ role: 'tool', content: 'x' }] }, '2 + 2').profile, 'BOT_FULL', 'history with tool calls keeps its tools');
    assert.strictEqual(bc.classify({ thread: 'coding', messages: [] }, '2 + 2').profile, null, 'the Coding Agent is never profiled');
    assert.strictEqual(bc.classify(s, '2 + 2', { bot: { contextProfile: 'full' } }).profile, 'BOT_FULL', 'opt-out');
  });

  await test('APPLY: BOT_SIMPLE sends a short prompt, no tools, no live tail — the full BOT request is ~100x larger', () => {
    app.session.thread = 'chat';
    app.session.messages = [];
    const simple = jr.turnOptions(app, { session: app.session, signal: null, text: '2 + 2' });
    assert.strictEqual(simple.tools, false);
    assert.strictEqual(simple.live, '');
    assert.ok(simple.systemPrompt.length < 1200, `short prompt (${simple.systemPrompt.length})`);
    assert.match(simple.systemPrompt, /Noema/);
    assert.strictEqual(app.session.contextProfile.profile, 'BOT_SIMPLE');
    const full = jr.turnOptions(app, { session: app.session, signal: null, text: 'fix the failing test in this project' });
    assert.notStrictEqual(full.tools, false);
    assert.ok(full.systemPrompt.length > simple.systemPrompt.length * 10, `full prompt ${full.systemPrompt.length} vs ${simple.systemPrompt.length}`);
    app.session.thread = 'coding';
    const agent = jr.turnOptions(app, { session: app.session, signal: null, text: '2 + 2' });
    assert.notStrictEqual(agent.tools, false, 'the Agent keeps its tools');
  });

  await test('THE BOT PROFILE still shapes a SIMPLE reply (style only)', () => {
    const p = bc.simplePrompt({ bot: { profile: { tone: 'dry', language: 'French' } } });
    assert.match(p, /Tone: dry/);
    assert.match(p, /French/);
  });
};
