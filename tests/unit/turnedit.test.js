'use strict';

/**
 * EDIT & RESEND / RETRY THE LATEST MESSAGE (turnedit.js, 2026-10-02) — a new branch, never a rewritten history.
 *
 *   - the latest user message and its replies leave the live history and are KEPT as a branch
 *   - the live turn records no longer claim the old request; a task the old wording started goes with it
 *   - Coding lane: turns that changed files ask first (needsChoice) — nothing has moved until the person answers;
 *     Undo restores the files through checkpoints; Keep leaves them
 *   - the other thread's messages are untouched
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const mock = require('../../src/mockprovider');
function scripted(steps) {
  const dir = tmpdir('turnedit-');
  const file = path.join(dir, 'script.json');
  fs.writeFileSync(file, JSON.stringify(steps), 'utf8');
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = file;
  mock._reset();
  return dir;
}
function unscript() { delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; mock._reset(); }

function quiet(a) { a.render.write = () => {}; a.render.notice = () => {}; a.render.turnSummary = () => {}; a.render.nl = () => {}; return a; }

module.exports = async function () {
  const te = require('../../src/turnedit');
  const { App } = require('../../src/app');

  await test('EDIT (Chat): the latest message and its answer become a kept branch; the other thread is untouched', async () => {
    const dir = scripted([{ text: 'Red it is.' }]);
    try {
      const a = quiet(new App({ interactive: false, cwd: dir }));
      a.session.messages.push({ role: 'user', content: 'coding note', thread: 'coding' });
      a.session.thread = 'chat';
      await a.handle('Change button to red');
      for (const m of a.session.messages) if (!m.thread && m.role !== 'system') m.thread = 'chat';
      a.session.messages.find((m) => m.content === 'coding note').thread = 'coding';
      const r = te.branch(a, { view: 'chat' });
      assert.strictEqual(r.ok, true, r.why);
      assert.strictEqual(r.replaced, 'Change button to red');
      assert.ok(!a.session.messages.some((m) => /Change button to red|Red it is/.test(String(m.content))), 'gone from the live history');
      assert.ok(a.session.messages.some((m) => m.content === 'coding note'), 'the other thread is untouched');
      assert.ok(!(a.session.turns || []).some((t) => t.userInput === 'Change button to red'), 'no live turn claims the old request');
      const b = require('../../src/workbench').of(a.session).branches;
      assert.ok(b && b[b.length - 1].replaced === 'Change button to red' && b[b.length - 1].messages.length >= 2, 'kept as a branch');
    } finally { unscript(); }
  });

  await test('EDIT (Coding): turns that changed files ask first; Undo restores them; Keep leaves them', async () => {
    const dir = scripted([
      { text: 'Making it red.', tool_calls: [{ name: 'write_file', input: { path: 'button.css', content: '.b{color:red}' } }] },
      { text: 'Done — red.' },
    ]);
    try {
      const a = quiet(new App({ interactive: false, cwd: dir }));
      a.session.thread = 'coding';
      await a.handle('Change button to red');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'button.css'), 'utf8'), '.b{color:red}', 'precondition: the turn wrote the file');
      const before = a.session.messages.length;
      const ask = te.branch(a, { view: 'coding' });
      assert.strictEqual(ask.ok, false);
      assert.strictEqual(ask.needsChoice, true);
      assert.deepStrictEqual(ask.files, ['button.css']);
      assert.strictEqual(a.session.messages.length, before, 'nothing moved before the person answered');
      const r = te.branch(a, { view: 'coding', files: 'undo' });
      assert.strictEqual(r.ok, true, r.why);
      assert.deepStrictEqual(r.undone, ['button.css']);
      assert.strictEqual(fs.existsSync(path.join(dir, 'button.css')), false, 'the file the old request created is gone again');
    } finally { unscript(); }
    const dir2 = scripted([
      { text: 'Making it red.', tool_calls: [{ name: 'write_file', input: { path: 'button.css', content: '.b{color:red}' } }] },
      { text: 'Done — red.' },
    ]);
    try {
      const a = quiet(new App({ interactive: false, cwd: dir2 }));
      a.session.thread = 'coding';
      await a.handle('Change button to red');
      const r = te.branch(a, { view: 'coding', files: 'keep' });
      assert.strictEqual(r.ok, true, r.why);
      assert.deepStrictEqual(r.kept, ['button.css']);
      assert.strictEqual(fs.readFileSync(path.join(dir2, 'button.css'), 'utf8'), '.b{color:red}', 'kept as it is');
    } finally { unscript(); }
  });

  await test('EDIT: refused while a turn runs — the person stops it or waits', async () => {
    const a = quiet(new App({ interactive: false, cwd: tmpdir('turnedit-run-') }));
    a.session.messages.push({ role: 'user', content: 'x', thread: 'chat' });
    a.abort = new AbortController();
    const r = te.branch(a, { view: 'chat' });
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /turn is running/);
    a.abort = null;
  });
};
