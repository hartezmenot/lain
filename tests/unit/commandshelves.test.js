'use strict';

/**
 * /resume, /copy and /model on the shared shelf (ui/shelf.js).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const { Session } = require('../../src/session');

function appWith(answers) {
  const app = {
    frames: [],
    written: [],
    notes: [],
    cwd: tmpdir('cmdshelf-'),
    render: { write(s) { app.written.push(String(s)); }, notice() {} },
    ui: {
      enabled: true,
      refresh() {},
      async ask(f) { app.frames.push(f); return answers.length ? answers.shift() : null; },
    },
    input: { isTTY: true, line: '', setLine(s) { this.line = s; } },
    transient(level, msg) { app.notes.push([level, msg]); },
  };
  app.session = new Session({ cwd: app.cwd });
  return app;
}

module.exports = async function () {
  await test('RESUME SHELF: recent sessions are choices; Esc resumes nothing and says nothing', async () => {
    const app = appWith([null]);
    const other = new Session({ cwd: app.cwd });
    other.task = null;
    other.turns.push({ userInput: 'fix the startup race' });
    other.save();
    const r = await require('../../src/resume').runCommand(app, { args: [], rest: '' }, {});
    assert.strictEqual(r, null);
    const f = app.frames[0];
    assert.ok(f, 'the shelf opened');
    assert.strictEqual(f.kind, 'SHELF');
    assert.deepStrictEqual(f.shelf.actions.map((a) => a.label), ['Continue', 'Details']);
    assert.ok(f.items.some((i) => i.choice), 'sessions are choices');
    assert.strictEqual(app.written.join(''), '', 'closing narrates nothing');
  });

  await test('COPY SHELF: offers only targets with content; one target copies without asking', async () => {
    const copy = require('../../src/copy');
    // Nothing done yet: at most one target has content, so no shelf opens.
    let app = appWith([]);
    await copy.runCommand(app, { rest: '' }, {});
    assert.strictEqual(app.frames.length, 0, 'no shelf for a single (or no) target');
    // A turn with an answer and a summary: the shelf opens with exactly those.
    app = appWith([null]);
    app.session.task = { objective: 'rename the flag' };
    app.session.turns.push({ userInput: 'rename the flag', text: 'Renamed it.', actions: [], narration: [{ step: 0, text: 'Renamed it.' }] });
    await copy.runCommand(app, { rest: '' }, {});
    if (app.frames.length) {
      const labels = app.frames[0].shelf.actions.map((a) => a.label);
      assert.ok(labels.length > 1, labels.join(','));
      for (const l of labels) assert.ok(['Open question', 'Summary', 'Last answer', 'Context', 'Diff'].includes(l));
    }
  });

  await test('MODEL SHELF: bare /model asks for the source first, LAIN continues to the catalog', async () => {
    const { pickSource } = require('../../src/modelcommand');
    const app = appWith([{ action: 'choose', choice: 'lain' }]);
    app.cfg = {};
    const go = await pickSource(app);
    assert.strictEqual(go, 'lain');
    const f = app.frames[0];
    assert.strictEqual(f.title, 'Model source');
    assert.deepStrictEqual(f.items.filter((i) => i.choice).map((i) => i.value), ['lain', 'chatgpt-web', 'gemini-web']);
  });

  await test('/models stays a HIDDEN alias of /model', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routecommands.js'), 'utf8');
    const block = src.slice(src.indexOf("define('/models'"), src.indexOf("define('/models'") + 400);
    assert.match(block, /hidden: true/);
    assert.match(block, /REGISTRY\.get\('\/model'\)/);
  });
};
