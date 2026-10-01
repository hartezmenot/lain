'use strict';

/**
 * ONE COMPLETION PER AGENT TURN.
 *
 * The final-smoke wake-up (wakeup.js / finalsmoke.js) makes one more model
 * request after an execution turn that changed files without running the
 * project's test. When that request only repeats the final reply, it used to be
 * stored again: two identical "done" messages in the Agent tab. A reply that
 * says something new is kept.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');
const isolation = require('../harness/isolation');

function project() {
  const root = isolation.tmp('agentdone-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"d","scripts":{"test":"node tests/a.test.js"}}\n');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const fixButton = 1;\nmodule.exports = fixButton;\n');
  fs.writeFileSync(path.join(root, 'tests', 'a.test.js'), "if (require('../src/a') !== 1) throw new Error('bad');\n");
  return root;
}

// A PROJECT-WIDE CHANGE (package.json): verifycontract then requires the suite, so the final-smoke wake-up is due —
// a targeted rename alone is proved proportionately and gets no wake-up (execution discipline, 2026-10-01).
const PROJECT_WIDE = { name: 'edit_file', input: { path: 'package.json', old: '"name":"d"', new: '"name":"d2"' } };

async function runAgent(script) {
  const root = project();
  const file = path.join(root, '..', `${path.basename(root)}-script.json`);
  fs.writeFileSync(file, JSON.stringify(script));
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = file;
  require('../../src/mockprovider')._reset();
  let requests = 0;
  const mp = require('../../src/mockprovider');
  const real = mp.chat;
  mp.chat = function () { requests++; return real.apply(this, arguments); };
  const { App } = require('../../src/app');
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: root });
  app.cfg.trustedPaths = [root];
  require('../../src/sessionviews').views(app.session).project = { attached: true, attachedAt: new Date().toISOString() };
  try {
    require('../../src/harnessapp/botroute').start(app, 'Rename fixButton to ButtonFix everywhere.', { role: 'agent', reason: 'test', via: 'ide', focus: false });
    const routes = require('../../src/harnessapp/routes');
    const end = Date.now() + 60000;
    await new Promise((r) => setTimeout(r, 200));
    while (Date.now() < end) {
      const q = require('../../src/harnessapp/sessionroutes').pendingAsk(app);
      if (q) await routes.dispatch(app, 'POST', '/api/ask/answer', { id: q.id, answer: q.options[0] });
      if (!app.session._role && !(app.abort && !app.abort.signal.aborted)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return { app, requests, finals: app.session.messages.filter((m) => m.role === 'assistant' && !m.tool_calls).map((m) => m.content) };
  } finally {
    mp.chat = real;
  }
}

module.exports = async function () {
  await test('AGENT COMPLETION: a wake-up answer that repeats the final reply is stored once', async () => {
    const r = await runAgent([
      { text: 'Renaming.', tool_calls: [{ name: 'rename_symbol', input: { from: 'fixButton', to: 'ButtonFix' } }, PROJECT_WIDE] },
      { text: 'Renamed fixButton to ButtonFix.' },
      { text: 'Renamed   fixButton to ButtonFix.' },
    ]);
    assert.strictEqual(r.requests, 3, 'the final-smoke wake-up still asks once more (intended)');
    assert.deepStrictEqual(r.finals, ['Renamed fixButton to ButtonFix.'], JSON.stringify(r.finals));
    const shown = require('../../src/harnessapp/state').conversation(r.app.session).filter((m) => m.role === 'assistant' && /Renamed fixButton/.test(m.text));
    assert.strictEqual(shown.length, 1, 'one completion in the Agent tab');
  });

  await test('AGENT COMPLETION: a wake-up answer that says something new is kept', async () => {
    const r = await runAgent([
      { text: 'Renaming.', tool_calls: [{ name: 'rename_symbol', input: { from: 'fixButton', to: 'ButtonFix' } }, PROJECT_WIDE] },
      { text: 'Renamed fixButton to ButtonFix.' },
      { text: 'Ran the test: it passes.' },
    ]);
    assert.deepStrictEqual(r.finals, ['Renamed fixButton to ButtonFix.', 'Ran the test: it passes.']);
  });
};
