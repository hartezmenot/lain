'use strict';

/** SIMPLIFY S4 — the fact footer: what Core recorded during a turn, shown under the report, never sent to the model. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');

module.exports = async function () {
  const ff = require('../../src/factfooter');

  await test('FACTS: files with +/- counts, commands with exit code and duration, background jobs and agents — from the record only', () => {
    const cwd = tmpdir('ff-');
    const record = {
      actions: [
        { name: 'read_file', path: path.join(cwd, 'a.js'), ok: true, ms: 3 },
        { name: 'edit_file', path: path.join(cwd, 'a.js'), ok: true, ms: 5, added: 3, removed: 1 },
        { name: 'edit_file', path: path.join(cwd, 'a.js'), ok: true, ms: 5, added: 1, removed: 0 },
        { name: 'shell', target: 'npm test', ok: true, ms: 4200, exitCode: 0 },
        { name: 'shell', target: 'npm run dev', ok: true, ms: 40, exitCode: null, job: '3' },
        { name: 'shell', target: 'rm -rf /', ok: false, denied: true, ms: 0 },
        { name: 'Agent', target: 'explore · find the auth code', ok: true, ms: 12000 },
      ],
      mutations: [path.join(cwd, 'a.js'), path.join(cwd, 'gen', 'b.json')],
    };
    const f = ff.of(record, { session: { cwd } });
    assert.deepStrictEqual(f.files, [{ path: 'a.js', added: 4, removed: 1 }, { path: 'gen/b.json', added: null, removed: null }]);
    assert.strictEqual(f.commands.length, 2, 'a refused call is not a command that ran');
    const l = ff.lines(f).join('\n');
    assert.match(l, /Files changed: a\.js \+4 -1 · gen\/b\.json/);
    assert.match(l, /npm test \(exit 0, 4\.2s\)/);
    assert.match(l, /npm run dev \(background #3, 0\.0s\)/);
    assert.match(l, /Agents: explore · find the auth code \(returned, 12s\)/);
    assert.deepStrictEqual(ff.lines(ff.of({ actions: [{ name: 'read_file', path: 'x', ok: true }], mutations: [] }, null)), [], 'a read-only turn has no footer');
  });

  await test('A REAL TURN: the footer is printed under the report, kept on the turn and the message, and absent from the wire', async () => {
    const cwd = tmpdir('ff-turn-');
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\ntwo\n');
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('ff-script-'), [
      { text: 'Editing.', tool_calls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
      { text: '', tool_calls: [{ name: 'edit_file', input: { path: 'a.txt', old: 'two', new: 'TWO\nthree' } }] },
      { text: '', tool_calls: [{ name: 'shell', input: { command: 'echo ok' } }] },
      { text: 'DONE — changed a.txt; ran echo.' },
    ]);
    const provider = require('../../src/provider');
    const realFetch = global.fetch;
    let printed = '';
    try {
      const { App } = require('../../src/app');
      const app = new App({ out: { write(s) { printed += s; }, on() {}, columns: 120, rows: 30, isTTY: false }, interactive: false, cwd });
      await app.submit('change two');
      const kept = app.session.turns[app.session.turns.length - 1];
      assert.ok(kept.facts, 'kept on the turn');
      assert.deepStrictEqual(kept.facts.files, [{ path: 'a.txt', added: 2, removed: 1 }]);
      assert.strictEqual(kept.facts.commands[0].exitCode, 0);
      assert.match(printed, /Files changed: a\.txt \+2 -1/);
      assert.match(printed, /Commands: echo ok \(exit 0, /);
      const last = app.session.messages.filter((m) => m.role === 'assistant').pop();
      assert.ok(last.facts, 'on the report message, for the Harness');
      const conv = require('../../src/harnessapp/state').conversation(app.session);
      assert.ok(conv.some((m) => m.facts && /Files changed/.test(m.facts.join('\n'))), 'the Harness conversation carries the lines');
      // NEVER SENT TO THE MODEL: both wire serializers carry only role, content and tool calls.
      const msgs = app.session.messages;
      assert.ok(!/Files changed|"facts"/.test(JSON.stringify(provider.toAnthropic(msgs))), 'anthropic body');
      let body = '';
      global.fetch = async (url, init) => { body = init.body; throw new Error('captured'); };
      try { for await (const ev of provider.openaiChat({ baseUrl: 'http://127.0.0.1:9', apiKey: 'x', model: 'm' }, msgs, {})) void ev; } catch { /* captured */ }
      assert.ok(body.length > 0 && !/Files changed|"facts"/.test(body), 'openai body');
    } finally {
      global.fetch = realFetch;
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });
};
