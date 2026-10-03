'use strict';

/** SIMPLIFY S3 — one fixed system prompt, LAIN.md, the skills list; a live tail that is only the todo list. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const sp = require('../../src/simpleprompt');
  const { App } = require('../../src/app');
  const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };

  await test('BASE: at most ~1,200 tokens, carries the report template (S12c), and no mode guidance, task state or tool-order rules', () => {
    const b = sp.base({ shell: 'PowerShell' });
    assert.ok(b.length / 4 <= 1200, `${Math.round(b.length / 4)} tokens`);
    assert.match(b, /Your final message is the report/);
    assert.match(b, /^Done: <one line>\nChanged: <files or "nothing">\nChecked: <what ran and the result, or "not checked">\nOpen: <anything left, or "nothing">$/m, 'the template, verbatim');
    assert.match(b, /plain question stays free-form/);
    for (const banned of [/Task state/i, /How to run/i, /How to test/i, /request_completion/, /task_contract/, /REQUEST:/, /MODE:/, /You must call .* before/i]) assert.ok(!banned.test(b), String(banned));
  });

  await test('RULES: LAIN.md from the project root and from .lain/ are both read; the person\'s global rules first', () => {
    const proj = tmpdir('sp-');
    const home = tmpdir('sp-home-');
    fs.writeFileSync(path.join(proj, 'LAIN.md'), 'Root rule: use tabs.');
    fs.mkdirSync(path.join(proj, '.lain'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.lain', 'LAIN.md'), 'Meta rule: no semicolons.');
    fs.mkdirSync(path.join(home, '.lain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lain', 'LAIN.md'), 'Global rule: be brief.');
    const was = process.env.LAIN_AGENTS_HOME;
    process.env.LAIN_AGENTS_HOME = home;
    try {
      const r = sp.rules(proj);
      assert.ok(r.indexOf('Global rule') < r.indexOf('Root rule') && r.indexOf('Root rule') < r.indexOf('Meta rule'), r);
    } finally { if (was == null) delete process.env.LAIN_AGENTS_HOME; else process.env.LAIN_AGENTS_HOME = was; }
  });

  await test('LIVE: nothing but the todo list; the stable half does not move between requests of a session', async () => {
    const app = new App({ out, interactive: false, cwd: tmpdir('sp-app-') });
    const a = sp.of(app, {});
    assert.strictEqual(a.live, '', 'no live tail without todos');
    await require('../../src/tools').execute('todo_write', { todos: [{ content: 'one', status: 'in_progress' }] }, { app, session: app.session });
    const b = sp.of(app, {});
    assert.strictEqual(b.stable, a.stable, 'the stable half is byte-identical');
    assert.strictEqual(b.live, '# Todo\n[>] one');
  });
};
