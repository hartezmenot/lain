'use strict';

/** SIMPLIFY S8 — memory (one fact per file, MEMORY.md loaded each session), compaction by summary, the Selection. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');

const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };
async function withMock(steps, fn) {
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('s8-script-'), steps);
  require('../../src/mockprovider')._reset();
  try { return await fn(); } finally { delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; }
}

module.exports = async function () {
  const mem = require('../../src/memdir');

  await test('MEMORY: one fact per file under ~/.lain/projects/<id>/memory/, MEMORY.md indexed and loaded into the prompt', async () => {
    const { App } = require('../../src/app');
    const app = new App({ out, interactive: false, cwd: tmpdir('s8-mem-') });
    const r = await require('../../src/tools').execute('memory', { action: 'save', name: 'Test Command', fact: 'Run the tests with `node tests/run.js unit`.' }, { app, session: app.session });
    assert.ok(!r.isError, r.output);
    const dir = mem.dir(app.session.cwd);
    assert.ok(dir.includes(path.join('projects', mem.projectId(app.session.cwd), 'memory')), dir);
    assert.ok(fs.existsSync(path.join(dir, 'test-command.md')));
    assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), /\[test-command\]\(test-command\.md\) — Run the tests/);
    assert.match(require('../../src/simpleprompt').stable(app, app.session), /# Memory \(this project\)[\s\S]*test-command/);
    await require('../../src/tools').execute('memory', { action: 'forget', name: 'test-command' }, { app, session: app.session });
    assert.strictEqual(mem.list(app.session.cwd).length, 0);
    assert.strictEqual(mem.section(app.session.cwd), '', 'an empty index adds nothing');
  });

  await test('COMPACTION: at the threshold a cheap model writes the structured summary; history is summary + the last exchanges', async () => {
    await withMock([{ text: '## Goal\nRename the label\n## Decisions\nKeep the API\n## Files changed\nsrc/a.js\n## Open items\ntests\n## Next step\nrun tests' }], async () => {
      const { App } = require('../../src/app');
      const app = new App({ out, interactive: false, cwd: tmpdir('s8-cmp-') });
      const s = app.session;
      const big = 'x'.repeat(4000);
      s.messages = [];
      for (let i = 0; i < 6; i++) {
        s.messages.push({ role: 'user', content: `ask ${i} ${big}` });
        s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, name: 'read_file', arguments: { path: 'a.js' } }] });
        s.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: big });
        s.messages.push({ role: 'assistant', content: `answer ${i}` });
      }
      const cfg = require('../../src/sessionviews').turnCfg(app, s);
      const cmp = require('../../src/compactor');
      assert.strictEqual(await cmp.maybe(s, cfg), null, 'not due under the threshold');
      const r = await cmp.maybe(s, cfg, { force: true });
      assert.ok(r && r.after < r.before, JSON.stringify(r));
      assert.match(String(s.messages[0].content), /<summary of the earlier conversation>[\s\S]*## Goal[\s\S]*## Next step/);
      assert.match(String(s.messages[0].content), /ask 4/, 'the kept tail starts at a user message');
      assert.ok(!s.messages.some((m) => m.role === 'tool' && !s.messages.some((x) => (x.tool_calls || []).some((c) => c.id === m.tool_call_id))), 'no orphaned tool result');
      assert.match(cmp.line(r), /^Compacted · \d+k → \d+k$/);
      assert.ok(cmp.due({ contextChars: () => 4 * 110000 }, { ctx: 128000 }, { executionProfile: 'ECO' }) && !cmp.due({ contextChars: () => 4 * 90000 }, { ctx: 128000 }, { executionProfile: 'NORMAL' }), 'ECO compacts earlier');
    });
  });

  await test('SELECTION: an IDE selection rides on the message as {file, range, text}', () => {
    const simple = require('../../src/simple');
    const s = { _ideTurn: true, _ide: { at: Date.now(), file: 'src/a.js', selection: { text: 'function a() {}', startLine: 3, endLine: 3 } } };
    assert.strictEqual(simple.withSelection({ session: s }, 'rename this'), 'rename this\n\n<selection file="src/a.js" lines="3-3">\nfunction a() {}\n</selection>');
    assert.strictEqual(simple.withSelection({ session: { ...s, _ideExclude: { selection: true } } }, 'x'), 'x', 'a removed chip removes it');
    assert.strictEqual(simple.withSelection({ session: { _ideTurn: false } }, 'x'), 'x');
  });
};
